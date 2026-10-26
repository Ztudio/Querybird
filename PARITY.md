# TablePlus feature parity (PostgreSQL & MySQL)

Inventory taken by *using* TablePlus 6.8.0 — menus, context menus, dialogs, settings and keymap.
No reverse engineering of TablePlus was done.

Legend: ✅ built & verified (automated test and/or clicked through in the app) · 🔶 built, automated checks pass, hands-on UI check pending · ➖ out of scope (reason given)

## Connections & welcome window
| TablePlus feature | Querybird |
| --- | --- |
| Connection list, search, driver badge, tag, status color | ✅ |
| Create / edit / duplicate / delete connection | ✅ |
| Import connection from URL | ✅ |
| Copy connection as URL (with / without password) | 🔶 |
| Connection groups (New Group, move, rename, delete, collapse) | 🔶 |
| Password in keychain / ask every time | ✅ |
| SSL modes | ✅ |
| Connect over SSH — password or private key, host-key pinning | ✅ live-tested (tunnel to PG & MySQL, bad password, changed host key) · 🔶 form UI |
| Bootstrap commands (SQL run after connect) | ✅ live-tested · 🔶 form UI |
| Backup database / Restore database (pg_dump, pg_restore, psql, mysqldump, mysql) | ✅ live round-trip on both DBs · 🔶 dialog UI |
| SQLite | ✅ unit + session tests · 🔶 UI click-through pending |
| User management (create / alter / drop, access presets, role membership) | ✅ live-tested on PG 17 & MySQL 9.7 · 🔶 UI click-through pending |
| Other drivers (Redis, Mongo, …) | ➖ scope is Postgres + MySQL + SQLite |

## Workspace & navigation
| TablePlus feature | Querybird |
| --- | --- |
| Toolbar breadcrumb, tag color, status-color tint, loading bar | ✅ |
| Items / Queries / History sidebar, search, schema switcher | ✅ |
| Preview (italic) tabs, back / forward | ✅ |
| Open anything ⌘P | ✅ |
| Open database/schema ⌘K | 🔶 |
| Next / previous tab ⌘] ⌘[ | 🔶 |
| Show table data / structure ⌃⌘[ ⌃⌘] | 🔶 |
| Toggle sidebars, console, details | ✅ |
| Reconnect / Disconnect / Reload workspace | 🔶 |
| Keep connection alive (30 s ping) | 🔶 |
| Reopen tabs when connecting again | 🔶 |
| Open .sql file ⌘O | 🔶 |
| Native menu bar (File, Edit, View, Navigate, Connection, Tools, Window) | 🔶 menus present; shortcut routing check pending |
| Settings window ⌘, (theme, fonts, uppercase keywords, brackets, stripes, CSV delimiter, ⌘T behaviour, page size, tools folder) | 🔶 |
| Split pane right | ➖ later |

## Sidebar item context menu
| TablePlus feature | Querybird |
| --- | --- |
| Open in new tab, Open structure, Copy name | ✅ |
| Item overview (rows / sizes for all tables) | ✅ live-tested · 🔶 tab UI |
| Pin to top | 🔶 |
| Export ▸ / Import ▸ | 🔶 |
| New ▸ Table / View / Function / Materialized view | 🔶 (opens a ready-to-run template) |
| Copy Script As ▸ Creation / Drop / Truncate / Select top 100 | 🔶 |
| Clone table (structure ± data) | ✅ unit-tested SQL · 🔶 dialog |
| Truncate / Delete (with confirmation) | ✅ |

## Data grid
| TablePlus feature | Querybird |
| --- | --- |
| Paging, sort by header, column resize, hide columns | ✅ |
| FK arrow navigation | ✅ |
| Filters (operators, raw SQL, multiple, apply all) | ✅ |
| Inline edit, pending highlight, ⌘S commit, discard, preview SQL | ✅ |
| Add row ⌘I, delete rows ⌘⌫ | ✅ |
| Duplicate rows ⌘D | 🔶 |
| Undo / redo pending edits ⌘Z ⇧⌘Z | 🔶 |
| Paste rows / cells from clipboard ⌘V | 🔶 |
| Set value ▸ EMPTY / NULL / DEFAULT | ✅ DEFAULT live-tested · 🔶 menu |
| Copy, copy cell value ⇧⌘C, copy all column values | 🔶 |
| Copy rows as ▸ CSV / TSV / JSON / Markdown / SQL INSERT / SQL UPDATE | ✅ unit-tested · 🔶 menu |
| Quick filter ▸ (=, ≠, >, <, contains, IS NULL, IS NOT NULL) | 🔶 |
| Quick Look editor ⌘↵ (large value, pretty JSON) | 🔶 |
| Export current page | 🔶 |
| Header menu: copy name, filter with column, hide, sort asc/desc, multi-sort, remove sort, reset widths | 🔶 |
| Sort by multiple columns (⇧-click header) | ✅ live-tested · 🔶 UI |
| Estimated count on huge tables (> 500k rows) | 🔶 |
| Details panel (edit focused row) | ✅ |

## Structure
| TablePlus feature | Querybird |
| --- | --- |
| Columns, indexes, DDL view | ✅ |
| Edit columns inline (name, type, nullable, default, comment), review & commit | ✅ unit-tested ALTER generation · 🔶 UI |
| Add / drop column, add / drop / change index | ✅ unit-tested · 🔶 UI |
| Triggers list | ➖ later |

## SQL editor
| TablePlus feature | Querybird |
| --- | --- |
| Highlighting, autocomplete, run current / all, LIMIT, multiple results | ✅ |
| Beautify ⌘I, saved queries, history | ✅ |
| Toggle line / block comment ⌘/ ⌥⌘/ | 🔶 |
| Increase / decrease font size ⌘= ⌘- | 🔶 |
| Find ⌘F | 🔶 |
| Export results CSV / JSON / SQL | ✅ |

## Import / export
| TablePlus feature | Querybird |
| --- | --- |
| Export dialog: pick tables; CSV (NULL→EMPTY, line breaks, header, delimiter) / JSON / SQL (structure, data) | ✅ unit-tested writers · 🔶 dialog |
| Import from CSV with column mapping (one transaction) | ✅ unit-tested parser · 🔶 dialog |
| Import (run) SQL dump file | 🔶 |

## Tools
| TablePlus feature | Querybird |
| --- | --- |
| Process list with Kill | ✅ kill live path · 🔶 tab UI |
| Search in database (text across all tables) | ✅ live-tested · 🔶 dialog |
| User management (read-only list of roles / users) | 🔶 |

## Safety & app
| TablePlus feature | Querybird |
| --- | --- |
| Safe mode (confirm writes) | ✅ |
| Passcode / Touch ID lock | ➖ macOS-only; later |
| AI assistant, plugins | ➖ later |
| License key, auto-update | ➖ intentionally none — Querybird is free |

## Found in TablePlus's public documentation (docs.tableplus.com) — not yet in Querybird
| TablePlus feature | Querybird |
| --- | --- |
| Metrics board (charts / tables / inputs driven by queries, timed or event refresh) | ⬜ |
| Chart from a query via comment (`-- TablePlus BarChart x: a, y: b`) | ⬜ |
| Query parameters (`:name`, `%name%`, `?`, `${name}`) — opt-in | ⬜ |
| Favorites with keyword binding (type keyword + Enter to insert), folders, run / insert / edit | 🟡 saved queries only |
| Edit query results inline (single-table results) | ⬜ |
| Split editor panes (⌘⇧D), navigate panes ⇧⌘[ ⇧⌘] | ⬜ |
| Split results into tabs (one tab per statement, max 100) | ✅ |
| Streaming results / async loading | ⬜ (results arrive when the query finishes) |
| Multiple carets (⌘-click, ⌃⇧↑/↓, ⌘D next match, ⌃⌘G all matches) | 🟡 CodeMirror has most; keymap differs |
| Uglify / minify SQL (⇧⌘I), Save selection as (⇧⌘S) | ⬜ |
| Shortcut differences: ⌘⇧P preview, ⌘⇧⌫ discard, ⌘⇧C console, ⌘E new SQL query, ⌘⇧K switch connection, ⌘R reloads workspace | ⬜ (Querybird uses other keys for some) |
| Table data: Space toggles row detail, middle-click Quick Look, ⌥-click quick edit, ⌘⌥F column filter | ⬜ |
| Header click cycles descending → ascending → unsorted | 🟡 Querybird cycles ascending → descending → off |
| Copy rows as HTML; CSV with or without header | 🟡 no HTML; CSV always has header |
| Constraints in Structure: add/remove primary key, create foreign key via popup | ⬜ (NOT NULL & default ✅) |
| Triggers: list, create, edit, delete from Structure | ⬜ |
| Export / import connections to a password-protected file (optionally with passwords) | ⬜ |
| Open connection from terminal / deep-link URL (name, color, env, schema, table, filters, safe mode) | ⬜ |
| SSH: reuse `~/.ssh/config` hosts | ⬜ |
| New SQL Viewer window (⌘⇧O) | ⬜ |
| LLM plugin / AI assistant, custom scripts (⌘.), plugin manager | ➖ later |
| iOS app, DBngin | ➖ out of scope |
