# Custom sql.js WASM Build (FTS5)

This project uses a custom sql.js WASM build with SQLite FTS5 enabled.
The stock sql.js build includes FTS3/FTS4 but not FTS5.

Both `sql-wasm.js` and `sql-wasm.wasm` are vendored in `lib/` and committed
to the repo. The extension loads them from `lib/` at runtime — not from
`node_modules`. This ensures `npm install` never silently reverts to stock
sql.js, and guarantees the JS glue matches the WASM binary.

## When to Rebuild

Rebuild when upgrading SQLite to pick up security patches or new features.
Check the sql.js release notes at https://github.com/sql-js/sql.js/releases.

## Build Steps

1. Clone: `git clone https://github.com/sql-js/sql.js.git`
2. Open in VS Code devcontainer (recommended) or install emsdk manually
3. Edit `Makefile` — add `-DSQLITE_ENABLE_FTS5 \` to `SQLITE_COMPILATION_FLAGS`
4. Build: `npm install && make`
5. Copy both files into this project's `lib/` directory:
   ```bash
   cp dist/sql-wasm.js  <groundwork>/lib/sql-wasm.js
   cp dist/sql-wasm.wasm <groundwork>/lib/sql-wasm.wasm
   ```
6. Commit them: `git add lib/sql-wasm.js lib/sql-wasm.wasm`
7. Run `npx vitest run` to verify FTS5 works

Both files must come from the same build. Never mix the JS glue from one
build with the WASM binary from another.

## What FTS5 Provides

- `bm25()` ranking — relevance-scored search results
- Column weighting — title matches ranked above body matches
- Prefix queries — `MATCH 'optim*'` finds "optimization", "optimize", etc.
- Phrase queries — `MATCH '"cloud spend"'` for exact phrase matching
