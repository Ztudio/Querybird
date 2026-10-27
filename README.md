# Querybird

A free, open-source database client for **PostgreSQL**, **MySQL** and **SQLite**, built with Rust and Tauri.
Its interface follows the native, keyboard-first feel of TablePlus — but there is no license key,
no trial and no account. Ever.

Runs on macOS, Windows and Linux. Built-in **[Ask AI](#ask-ai)** turns plain-language questions into SQL
with Claude or OpenAI.

![The Querybird workspace with the Ask AI panel](docs/workspace.jpg)

<table>
  <tr>
    <td><img src="docs/welcome-screen.jpg" alt="Connection list and the welcome window"></td>
  </tr>
  <tr>
    <td align="center">Connection list</td>
  </tr>
</table>

## Download

The current version is **0.2.0**. Its macOS installer is on the [release page](https://github.com/Ztudio/Querybird/releases/tag/v0.2.0). The Windows and Ubuntu installers (0.1.0) are in [`downloads/`](downloads/) until the next release:

| Platform | File | SHA-256 |
| --- | --- | --- |
| macOS 0.2.0 (Apple Silicon + Intel) | [Querybird_0.2.0_universal.dmg](https://github.com/Ztudio/Querybird/releases/download/v0.2.0/Querybird_0.2.0_universal.dmg) | `d8a0f08938b6c238c294533c5b023133fc337ea552a16a60b19d97bbd4e0fdc2` |
| Windows 10/11 (x64) | [Querybird_0.1.0_x64-setup.exe](downloads/Querybird_0.1.0_x64-setup.exe) | `aeea394b81a0e5411928ddf536c128a6bd857781db1c6bef8259d1c38cab82da` |
| Ubuntu / Debian (x64) | [Querybird_0.1.0_amd64.deb](downloads/Querybird_0.1.0_amd64.deb) | `3f4185cdcd5017ea2793b2a04261a3c6a76478fe3c096e528257fdcf7ed65ba6` |

> macOS: the app isn't notarized yet, so the first launch says Apple could not verify it. Click **Done**, then open
> **System Settings → Privacy & Security**, scroll to **Security** and click **Open Anyway** (you only do this once).
> Or run `xattr -dr com.apple.quarantine /Applications/Querybird.app`.
>
> Ubuntu (22.04 or newer): install with `sudo apt install ./Querybird_0.1.0_amd64.deb`, which also pulls in the
> WebKitGTK and GTK libraries it needs. Then open Querybird from the app menu or run `querybird`.
>
> Windows: the installer isn't code-signed yet, so SmartScreen may warn on first run. Choose **More info → Run anyway**.

Releases are built by GitHub Actions on each `v*` tag (`.github/workflows/release.yml`).

## Features

**Connections**
- Connection list with search, driver badges, tags (local / development / testing / staging / production) and status colors
- Create, edit, duplicate, delete; import from a `postgresql://`, `mysql://` or `sqlite:///path` URL
- **SQLite**: open a database file (or create a new one) from the welcome window — no server needed
- Passwords stored in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux) — or asked every time
- SSL modes: disable / preferred / required
- **SSH tunnels** (password or private key, host key remembered on first connect)
- Bootstrap commands run after connecting; connection groups; copy connection as URL
- **Backup / restore** via pg_dump, pg_restore, psql, mysqldump and mysql
- One window per connection; the toolbar is tinted with the connection's status color

**Browsing & editing**
- Sidebar with tables, views and functions, search, schema/database switcher
- Virtualized data grid: sorting, column resizing (double-click edge to auto-fit), keyboard navigation, multi-row selection, copy as TSV / JSON / SQL INSERT
- Foreign-key arrows jump to the referenced row
- Filters (`=`, `<>`, `IN`, `BETWEEN`, `LIKE`, contains, begins/ends with, `IS NULL`, …) plus raw SQL `WHERE`
- Inline editing, insert / duplicate / delete rows — changes stay **pending** (highlighted) until you commit with ⌘S, and are applied in a single transaction
- Preview the generated SQL before committing; discard at any time
- Undo / redo of pending edits, paste rows from the clipboard, duplicate rows, set NULL / EMPTY / DEFAULT
- Quick Look editor for long values and JSON, quick filters, copy rows as CSV / JSON / Markdown / SQL
- Structure editor: rename, retype, nullability, defaults, comments, add/drop columns and indexes — review the ALTERs, then commit
- Import from CSV (with column mapping) or SQL dump; export tables to CSV / JSON / SQL
- Item overview, process list with kill, search across every table
- **User management** (PostgreSQL & MySQL): create, edit, rename and delete users/roles, generate passwords, give read-only / read & write / full access to a database or schema in one click, manage role membership, see current privileges — every statement is previewed first, with passwords masked
- Paging with stable ordering (primary key), hide/show columns
- Details panel shows the focused row as an editable form, or table info (size, rows, engine…)

**SQL editor**
- Syntax highlighting, autocompletion of keywords and table names
- Run current statement (⌘↵) or all (⌘⇧↵), automatic `LIMIT`, multiple result sets
- Beautify (⌘I), saved queries (⌘S), query history
- Export results to CSV, JSON or SQL

**Ask AI** — natural language → SQL with Claude or OpenAI; see [Ask AI](#ask-ai) below.

**Look**
- Six themes (Ember, Light, Monokai, Catppuccin Latte, Solarized Light, Vellum) or match the system; switch from the palette button in the sidebar or Settings
- Geist and Geist Mono fonts, Phosphor icons, and tooltips that show the shortcut

**Safety**
- Safe mode (lock icon): every write needs confirmation. On by default for connections tagged `production`
- Console log of every statement Querybird runs

## Ask AI

Ask your database a question in plain language and Querybird writes the SQL, shows it to you, runs it and
displays the result — all inside the same workspace window.

- The **Ask AI** panel sits on the right of the workspace. Open it from the sidebar or with ⌘J (Ctrl+J); the same
  shortcut hides it again. Type a question or pick one of the suggestions
- Every answer shows the model's reply, the generated SQL, the model used, timings and the result grid. Icon buttons
  under the answer run it again, open it in the editor, copy the SQL or show what was sent
- **Read rows** (off by default) sends up to 50 rows of a read-only result so the model can write a conclusion from them
- Follow-up questions in the same panel see the earlier questions, replies and SQL, so you can refine step by step
- "Fix with AI" retries with the database error when a statement fails
- Every generated statement is written to the console log and query history

**Providers**

| Provider | Sign in with | Notes |
| --- | --- | --- |
| Claude (Anthropic) | **Claude Code on this computer**, **Sign in with Anthropic** (browser, via the official `ant` CLI) or an Anthropic API key | Choose the Claude model in Settings → AI |
| OpenAI | **Codex CLI on this computer**, **Sign in with ChatGPT** (uses your ChatGPT plan) or an OpenAI API key | Follows OpenAI's documented open-source sign-in flow; manage usage from your ChatGPT settings |

If Claude Code (`claude`) or the Codex CLI (`codex`) is installed and nothing else is set up, Ask AI uses it
automatically with the account it's already signed in with. Each question runs one headless call with every
tool disabled (no shell, files, web, browser or MCP servers), no saved session, and an empty private working
folder; the prompt is passed through stdin and a private temp file, never the command line.

API keys and sign-in tokens are stored in the OS keychain. Querybird itself is free and never charges anything.

**Safety and privacy**

- Read-only SQL can run automatically (toggle **Auto-run**); it runs inside a server-side
  `READ ONLY` transaction, so the database itself refuses writes
- Anything that changes data or structure never runs without your confirmation. The dialog shows the impact
  first — for `DELETE`/`UPDATE` a read-only `COUNT(*)` of the rows it would touch, without running the statement —
  and `DROP`, `TRUNCATE`, destructive `ALTER`s, `DELETE`/`UPDATE` without `WHERE` or over 1,000 rows need an
  explicit "I understand" tick. Cancel has keyboard focus, so Enter never runs a write
- Only your question and the schema (table/column names, types, keys) are sent. Result rows go out only when **Read rows** is on
- **What was sent** shows the exact prompt, schema context and any rows sent to the model

![The exact context sent to the model](docs/ai-context.jpg)
![AI settings](docs/ai-settings.jpg)

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Open anything (tables, views, saved queries) | ⌘P | Ctrl+P |
| New SQL query tab | ⌘T | Ctrl+T |
| Close tab | ⌘W | Ctrl+W |
| Reload tab / sidebar items | ⌘R / ⌘⇧R | Ctrl+R / Ctrl+Shift+R |
| Commit pending changes (table) / save query (editor) | ⌘S | Ctrl+S |
| Toggle filters | ⌘F | Ctrl+F |
| Insert row | ⌘I | Ctrl+I |
| Delete selected rows | ⌘⌫ | Ctrl+Backspace / Delete |
| Run current / all statements | ⌘↵ / ⌘⇧↵ | Ctrl+Enter / Ctrl+Shift+Enter |
| Beautify SQL | ⌘I (in editor) | Ctrl+I |
| Toggle the Ask AI panel | ⌘J | Ctrl+J |
| Previous / next tab | ⌘⇧[ / ⌘⇧] | Ctrl+Shift+[ / ] |
| Toggle sidebar / console / details | ⌘0 / ⌘⇧E / ⌘⇧. | Ctrl+0 / Ctrl+Shift+E / Ctrl+Shift+. |

## Building

Requirements: [Rust](https://rustup.rs) (stable), Node.js 20+, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.
On Linux you also need `libdbus-1-dev` (keychain access) — e.g.
`sudo apt install libwebkit2gtk-4.1-dev libdbus-1-dev build-essential libssl-dev librsvg2-dev`.

```bash
npm install
npm run tauri dev      # run in development
npm run tauri build    # produce installers in src-tauri/target/release/bundle
```

## Testing

```bash
npm test                               # frontend unit tests (SQL splitting, edits, export)
cd src-tauri && cargo test             # SQL generation unit tests

# end-to-end against real databases (needs Docker)
scripts/test-dbs.sh
cd src-tauri && QUERYBIRD_LIVE_TESTS=1 cargo test --test live_db -- --test-threads=1
```

`scripts/test-dbs.sh` starts throwaway Postgres 16 (port 55432) and MySQL 8.4 (port 53306)
containers with a small `shop` sample database.

## Project layout

```
src-tauri/src/db/      Rust database layer: postgres (tokio-postgres), mysql (mysql_async), SQL generation
src-tauri/src/store.rs Saved connections + OS keychain
src-tauri/src/lib.rs   Tauri commands and window management
src/welcome/           Connection list, connection form, URL import
src/workspace/         Workspace window: toolbar, sidebar, tabs, data grid, SQL editor, details panel
src/lib/               Pure helpers (statement splitting, pending edits, export) with tests
```

See [PARITY.md](PARITY.md) for a feature-by-feature comparison with TablePlus.

## Roadmap

SQLite / Redis / other drivers, split panes, triggers editor, ER diagrams, passcode lock.

## Support

If Querybird saves you time, you can [buy the maintainer a coffee](https://buymeacoffee.com/ztudio).
Querybird stays free either way.

## License

MIT. Querybird is an independent project and is not affiliated with TablePlus.
