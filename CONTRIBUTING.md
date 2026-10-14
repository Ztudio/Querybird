# Contributing to Querybird

Thanks for helping! Bug reports, feature requests and pull requests are all welcome.

## Getting started

```bash
npm install
npm run tauri dev
```

Prerequisites: Rust (stable), Node.js 20+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
for your OS (on Linux also `libdbus-1-dev`).

## Tests

```bash
npm test                         # frontend unit tests
npx tsc --noEmit                 # type-check
cd src-tauri && cargo test       # Rust unit tests

# end-to-end against real Postgres + MySQL (needs Docker)
scripts/test-dbs.sh
cd src-tauri && QUERYBIRD_LIVE_TESTS=1 cargo test --test live_db -- --test-threads=1
```

Please add or update tests with your change. UI changes should include a screenshot in the PR.

## Guidelines

- Keep the native, keyboard-first feel: every action should be reachable from the keyboard and the menu bar.
- Never send row data to third parties. Anything that changes data must be previewable and confirmable.
- Secrets belong in the OS keychain (`src-tauri/src/store.rs`), never in config files, logs or the UI.
- **Clean-room rule:** Querybird is an independent implementation. Do not contribute code, assets or text
  copied or derived from decompiling, disassembling or otherwise reverse-engineering proprietary software
  (including TablePlus). Studying how an app *behaves* by using it, and its public documentation, is fine.
- Run `cargo fmt`, `npx tsc --noEmit` and the tests before opening a PR.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — please report privately, not in public issues.
