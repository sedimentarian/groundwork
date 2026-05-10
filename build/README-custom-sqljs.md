# Custom sql.js WASM Build (FTS5)

This project uses a custom sql.js WASM build with SQLite FTS5 enabled.
The stock sql.js build includes FTS3/FTS4 but not FTS5.

## When to Rebuild

Rebuild when upgrading sql.js to pick up SQLite security patches or new features.
Check the sql.js release notes at https://github.com/sql-js/sql.js/releases.

## Build Steps

1. Clone: `git clone https://github.com/sql-js/sql.js.git`
2. Open in VS Code devcontainer (recommended) or install emsdk manually
3. Edit `Makefile` — add `-DSQLITE_ENABLE_FTS5 \` to `SQLITE_COMPILATION_FLAGS`
4. Build: `npm install && make`
5. Copy `dist/sql-wasm.wasm` and `dist/sql-wasm.js` into this project's `node_modules/sql.js/dist/`
6. Run `npx vitest run` to verify FTS5 works

## What FTS5 Provides

- `bm25()` ranking — relevance-scored search results
- Column weighting — title matches ranked above body matches
- Prefix queries — `MATCH 'optim*'` finds "optimization", "optimize", etc.
- Phrase queries — `MATCH '"cloud spend"'` for exact phrase matching
