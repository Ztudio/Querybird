# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Security" tab → "Report a vulnerability") on this repository. We aim to acknowledge reports within
5 working days and to ship a fix or mitigation for confirmed high-severity issues as quickly as possible.

## How Querybird handles your data

- **Credentials** — database passwords, SSH passwords/passphrases, AI API keys and AI sign-in tokens are
  stored in the operating system's credential store (macOS Keychain, Windows Credential Manager,
  Secret Service on Linux). They are never written to Querybird's config files and are never sent to the UI.
- **Connections** — saved connection settings (host, port, user, database, SSH host, host-key fingerprint)
  live in a JSON file in the app's config directory.
- **SSH** — host keys are pinned on first connect; a changed key is refused.
- **TLS** — `VERIFY-FULL` checks the server certificate and hostname. `PREFERRED` and `REQUIRED` encrypt
  but do not verify the certificate (the trade-off most GUI database clients make), so prefer `VERIFY-FULL`
  or an SSH tunnel on untrusted networks.
- **Ask AI** — only your question, earlier questions/SQL in the same tab, and the database *schema*
  (table/column names, types, keys) are sent to the AI provider you chose. Row data is never sent.
  Generated SQL is always shown; anything that may change data asks for confirmation before it runs.
- **Ask AI execution** — SQL the AI writes runs automatically only if it is a single read-only statement,
  and then inside a server-enforced `READ ONLY` transaction (always rolled back) with statement/lock
  timeouts and a deny-list of side-effecting functions. Anything else needs explicit confirmation.
  Database error text sent back to the model is redacted (no quoted values, no DETAIL lines).
- **Files** — the UI can only read or write files you picked in a native file dialog.
- **Content Security Policy** — the UI runs under a strict CSP with no network access of its own; all
  network traffic is made by the Rust backend.
- **Telemetry** — none. Querybird makes no network requests except to the databases, SSH servers and AI
  providers you configure.

## Known limitations

- SSH host keys are trusted on first use (TOFU) without an interactive fingerprint prompt; later changes
  are refused. Verify the fingerprint shown in the connection form if that matters for your environment.
- MySQL `PREFERRED` mode falls back to an unencrypted connection when the TLS handshake fails.
- Restoring a `.sql` dump runs it with `psql`/`mysql`; dump files can contain client commands, so only
  restore dumps you trust (`--skip-system-command` is used when the mysql client supports it).
- Query history and saved queries are stored unencrypted in the app's local storage (statements that
  contain passwords are not recorded in history).
- All custom backend commands are available to every Querybird window; per-window command scoping is planned.

## Dependency advisories

CI runs `cargo audit`, `npm audit` and a secret scan on every push. Advisories that have no fix and do
not affect Querybird are listed, with reasons, in [`src-tauri/.cargo/audit.toml`](src-tauri/.cargo/audit.toml).
