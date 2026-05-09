# RAG Context Retrieval — Design Spec

**Date:** 2026-05-09
**Status:** Draft — pending implementation decision
**Author:** schuhe

---

## Problem

The current `compile_context` MCP tool and `generateClaudeMd` command return all active/next tasks plus selected reference docs. At 22 files this is fine. At 2000 files it produces bloated, unfocused context — the AI gets everything rather than what's relevant.

**Goal:** When compiling AI context, semantically retrieve the most relevant vault notes given both the user's current query and their active tasks, rather than dumping everything.

---

## Non-Goals

- In-vault search UI (this is about AI context compilation only)
- Real-time streaming retrieval
- Multi-vault cross-project search
- GPU acceleration (CPU-only is sufficient at target scale)

---

## Architecture

Five new modules under `src/embeddings/`, minimal changes to existing surfaces:

```
src/embeddings/
├── service.ts      # Transformers.js pipeline, lazy model load, platform config
├── chunker.ts      # Paragraph chunking with overlap + heading context
├── store.ts        # In-memory vector cache + sql.js persistence
├── queue.ts        # Background incremental indexing, non-blocking
└── retriever.ts    # Dual-retrieval + RRF merge, top-K ranking
```

**Integration points (minimal changes):**
- `src/db/sync.ts` — triggers queue when notes change
- `src/mcp/server.ts` — `compile_context` tool gets optional `query?: string` param
- `src/extension.ts` — `generateClaudeMd` command passes active task context as implicit query

**When `groundwork.embeddings.enabled` is false:** none of this runs. Both surfaces fall back to today's exact behavior.

---

## Embedding Model

**Recommended:** `bge-small-en-v1.5` (384-dim, ~25MB ONNX)

**Why not `all-MiniLM-L6-v2`:** That model is from 2021. BGE/E5 generation models consistently outperform it on MTEB benchmarks and support query/passage prefix asymmetry (`"query: "` / `"passage: "`) that materially improves retrieval precision.

**Alternative:** `nomic-embed-text-v1.5` (Matryoshka, can truncate to 256-dim to trade quality for speed if needed).

**Model storage:** `~/.groundwork/.models/` — downloaded once, loaded from filesystem at runtime. Never bundled into the VSIX.

**Dependency:** `@huggingface/transformers` marked as external in any future bundler config. In current unbundled (plain tsc) setup, loaded naturally from `node_modules`.

---

## Data Model

New table in the existing sql.js DB:

```sql
CREATE TABLE IF NOT EXISTS embeddings (
  path         TEXT    NOT NULL,
  chunk_index  INTEGER NOT NULL DEFAULT 0,
  chunk_text   TEXT,               -- stored for debugging/inspection
  vector       BLOB    NOT NULL,   -- Float32Array, little-endian
  model        TEXT    NOT NULL,   -- e.g. "bge-small-en-v1.5"
  indexed_at   TEXT    NOT NULL,
  PRIMARY KEY (path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_emb_path ON embeddings(path);
```

**In-memory cache:** `Map<path, Array<{ chunkIndex: number; vector: Float32Array }>>` — loaded once at extension startup, updated incrementally on note changes.

**Scale estimate at 2000 notes:** avg 3 chunks/note × 384 floats × 4 bytes = ~9MB in memory. Acceptable.

---

## Chunking Strategy

| Note length | Strategy |
|-------------|----------|
| < 300 words | Single chunk (whole body) |
| ≥ 300 words | Split on double newline (paragraphs), max 200 words/chunk |

**Three fixes from validation:**
1. **~20% overlap** between adjacent chunks — prevents concept-straddling paragraphs from losing context
2. **Prepend heading chain** — each chunk prefixed with the markdown heading hierarchy above it (e.g. `## Project > ### Auth`)
3. **Embed frontmatter fields** — prepend `title`, `tags`, `status`, `project` as plain text into each chunk before embedding

**Prefix for retrieval quality:**
- Document chunks prefixed with `"passage: "` (BGE convention)
- Query vectors prefixed with `"query: "`

---

## Query Composition

**Problem with naive approach:** Concatenating active tasks + user query into one vector dilutes the user query with unrelated task titles — a known retrieval anti-pattern.

**Approach: dual retrieval + Reciprocal Rank Fusion (RRF)**

1. **Query vector** — embed `"query: " + userQuery` alone
2. **Task context vector** — embed `"query: " + activeTaskTitles + firstParagraphs` alone
3. Run cosine similarity independently for each against all chunk vectors
4. Merge ranked lists with RRF: `score(d) = Σ 1 / (k + rank_i(d))` where k=60
5. Return top-K unique note paths by merged score

**Hybrid retrieval (FTS4 + dense via RRF):**
Since FTS4 is already available, add a third retrieval leg:
1. FTS4 keyword match on user query
2. Dense similarity (query vector)
3. Dense similarity (task context vector)
4. Merge all three with RRF

BM25 + dense hybrid almost always beats either alone, and the infrastructure already exists.

**Default K:** 10 notes. Configurable via `groundwork.embeddings.topK`.

---

## Indexing Pipeline

**Startup:**
1. Load all existing embeddings from sql.js into in-memory cache (one bulk read)
2. Diff against notes table — identify notes missing embeddings or with stale `indexed_at`
3. Queue stale notes for background reindexing

**Incremental (file change):**
1. `sync.ts` detects changed note (existing body_hash mechanism)
2. Enqueues note path to embedding queue
3. Queue worker processes in batches of 10, yields between batches (non-blocking)
4. On completion: updates sql.js + in-memory cache

**Model change / reindex:**
- Each row stores `model` name
- On activation, if stored model ≠ current model: clear `embeddings` table, rebuild from scratch in background
- Show VS Code progress notification during full rebuild

---

## Configuration

```jsonc
"groundwork.embeddings.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Enable semantic search for context compilation. Requires a ~25MB model download on first use. Disable if you experience performance issues or work in offline/restricted environments."
},
"groundwork.embeddings.topK": {
  "type": "number",
  "default": 10,
  "description": "Number of notes to retrieve per semantic search query."
}
```

---

## Platform Considerations

**Mac (Intel + Apple Silicon):** Works. Apple Silicon may use WebGPU acceleration in Transformers.js v4.

**Windows:** Works, but: ONNX WASM SIMD has had silent scalar fallbacks in Node.js on some Windows configurations — 5-10× slower. Must be tested on a real Windows machine before shipping. Add telemetry or a visible warning if inference time exceeds a threshold.

**Corporate environments:** Model download (25MB) may fail silently behind proxies. Need: (a) explicit error messaging when download fails, (b) a `groundwork.embeddings.modelPath` override for users who pre-download the model.

**ESM interop:** `@huggingface/transformers` is ESM-first. Current tsc output is CommonJS. This requires dynamic `import()` at the call site in `service.ts` — not a blocker but needs explicit handling.

---

## sql.js Write Amplification Risk

sql.js holds the entire DB in memory and rewrites the whole file on every flush. At 2000 notes × ~3 chunks × 384-dim vectors = ~9MB of BLOB data, every bulk reindex flush rewrites the full DB file.

**Mitigations:**
- Batch writes: accumulate all chunk inserts for a note, commit once per note (not per chunk)
- Throttle flushes during bulk reindex: flush every N notes, not after each
- Consider `better-sqlite3` (native, synchronous, supports sqlite-vec) as a future migration path if write performance becomes a bottleneck — but this breaks the "no native deps" stance and requires prebuilt binaries

**This is the main open question for implementation** (see below).

---

## Privacy

All embeddings are computed locally using a local ONNX model. No note content, embeddings, or queries leave the machine. The model is downloaded from Hugging Face once (or from a user-specified local path). This should be documented in the README and surfaced in the extension description.

---

## Open Questions (Parking Lot)

These are unresolved decisions that need more thought before implementation:

1. **sql.js vs better-sqlite3 for embeddings storage** — sql.js write amplification at scale may be unacceptable. Migrating to better-sqlite3 solves it but adds native binaries and cross-platform build complexity. Worth evaluating before committing to sql.js for vector storage.

2. **Model selection final call** — `bge-small-en-v1.5` is the current recommendation. Worth running a quick local eval against a sample of vault notes before locking in.

3. **RRF weight tuning** — k=60 is the standard default. May need tuning against real vault content.

4. **Eval harness** — before shipping, build a small fixture set of vault notes + queries with expected relevant results. Measure recall@K. Without this, there's no way to know if changes improve or regress retrieval quality.

5. **`compile_context` API surface** — does the MCP `query` param come from the AI's current conversation turn, or must the AI explicitly pass it? Needs coordination with how Claude/Copilot calls the tool.

6. **Chunk overlap implementation** — sliding window with 20% overlap means chunk boundaries need careful handling for markdown (don't break mid-heading, mid-list). Parser needed, not just a word-count split.

---

## What's Not Changing

- FTS4 keyword search (still available, used as one RRF leg)
- Task status flow, frontmatter schema, vault structure
- MCP tool names and signatures (additive change only — `query` param is optional)
- Behavior when `embeddings.enabled = false`
