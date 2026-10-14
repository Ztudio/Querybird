pub mod ai;
mod chatgpt;
pub mod db;
mod menu;
mod secure;
mod store;
pub mod tools;

use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::RwLock;

use db::types::*;
use db::Session;
use store::Store;

pub struct AppState {
    store: Store,
    picked: secure::PickedPaths,
    dir: std::path::PathBuf,
    sessions: RwLock<HashMap<String, Arc<Session>>>,
}

type Res<T> = Result<T, String>;

async fn session(state: &State<'_, AppState>, id: &str) -> Res<Arc<Session>> {
    state
        .sessions
        .read()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| "connection is closed".to_string())
}

// ---------- saved connections ----------

#[tauri::command]
async fn list_connections(state: State<'_, AppState>) -> Res<Vec<ConnectionConfig>> {
    Ok(state.store.list())
}

#[tauri::command]
async fn save_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
) -> Res<ConnectionConfig> {
    state.store.save(config, password)
}

#[tauri::command]
async fn delete_connection(state: State<'_, AppState>, id: String) -> Res<()> {
    state.store.delete(&id)
}

#[tauri::command]
async fn has_saved_password(id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || store::get_password(&id).is_some())
        .await
        .unwrap_or(false)
}

#[tauri::command]
async fn rename_group(state: State<'_, AppState>, from: String, to: String) -> Res<()> {
    state.store.rename_group(&from, &to)
}

/// "Copy as URL": built and copied on the backend so the password never reaches the webview.
#[tauri::command]
async fn copy_connection_url(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    with_password: bool,
) -> Res<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let url = secure::connection_url(&state.store, &id, with_password)?;
    app.clipboard().write_text(url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
) -> Res<String> {
    let (config, pw) = secure::prepare(&state.store, config, password);
    let s = Session::open(String::new(), config, pw.as_deref()).await?;
    Ok(s.server_version.clone())
}

// ---------- sessions ----------

#[tauri::command]
async fn connect(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
) -> Res<SessionInfo> {
    let (config, pw) = secure::prepare(&state.store, config, password);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let s = Arc::new(Session::open(id.clone(), config, pw.as_deref()).await?);
    if let Some(t) = &s.tunnel {
        if !s.config.id.is_empty() {
            state.store.remember_host_key(&s.config.id, &t.fingerprint);
        }
    }
    keep_alive(Arc::downgrade(&s));
    let info = s.info().await;
    state.sessions.write().await.insert(id, s);
    Ok(info)
}

/// Pings idle sessions every 30s so servers, NATs and SSH tunnels don't drop them.
fn keep_alive(session: std::sync::Weak<Session>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let Some(s) = session.upgrade() else { break };
            // Skip the ping while the connection is busy with real work.
            let idle = s.conn.try_lock().is_ok();
            if idle {
                let _ = s.ping().await;
            }
        }
    });
}

#[tauri::command]
async fn open_workspace(app: AppHandle, session_id: String, title: String) -> Res<()> {
    let label = format!("ws-{session_id}");
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1360.0, 840.0)
        .min_inner_size(900.0, 560.0);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder.build().map_err(|e| e.to_string())?;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    Ok(())
}

#[tauri::command]
fn show_welcome(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

#[tauri::command]
async fn session_info(state: State<'_, AppState>, session_id: String) -> Res<SessionInfo> {
    Ok(session(&state, &session_id).await?.info().await)
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>, session_id: String) -> Res<()> {
    state.sessions.write().await.remove(&session_id);
    Ok(())
}

#[tauri::command]
async fn reconnect(state: State<'_, AppState>, session_id: String) -> Res<SessionInfo> {
    let old = session(&state, &session_id).await?;
    let (config, pw) = secure::prepare(&state.store, old.config.clone(), None);
    let schema = old.schema.lock().await.clone();
    let s = Arc::new(Session::open(session_id.clone(), config, pw.as_deref()).await?);
    keep_alive(Arc::downgrade(&s));
    if !schema.is_empty() {
        let _ = s.set_schema(&schema).await;
    }
    let info = s.info().await;
    state.sessions.write().await.insert(session_id, s);
    Ok(info)
}

#[tauri::command]
async fn list_schemas(state: State<'_, AppState>, session_id: String) -> Res<Vec<String>> {
    session(&state, &session_id).await?.list_schemas().await
}

#[tauri::command]
async fn set_schema(state: State<'_, AppState>, session_id: String, schema: String) -> Res<()> {
    session(&state, &session_id)
        .await?
        .set_schema(&schema)
        .await
}

#[tauri::command]
async fn list_objects(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
) -> Res<ObjectList> {
    session(&state, &session_id)
        .await?
        .list_objects(&schema)
        .await
}

#[tauri::command]
async fn fetch_table(
    state: State<'_, AppState>,
    session_id: String,
    query: TableQuery,
) -> Res<TablePage> {
    session(&state, &session_id)
        .await?
        .fetch_table(&query)
        .await
}

#[tauri::command]
async fn table_structure(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
) -> Res<TableStructure> {
    session(&state, &session_id)
        .await?
        .structure(&schema, &table)
        .await
}

#[tauri::command]
async fn table_info(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
) -> Res<Vec<(String, String)>> {
    session(&state, &session_id)
        .await?
        .table_info(&schema, &table)
        .await
}

#[tauri::command]
async fn table_ddl(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
) -> Res<String> {
    session(&state, &session_id)
        .await?
        .ddl(&schema, &table)
        .await
}

#[tauri::command]
async fn process_list_sql(state: State<'_, AppState>, session_id: String) -> Res<String> {
    Ok(session(&state, &session_id)
        .await?
        .process_list_sql()
        .to_string())
}

#[tauri::command]
async fn execute(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
) -> Res<Vec<QueryResult>> {
    session(&state, &session_id).await?.execute(&sql).await
}

#[tauri::command]
async fn preview_changes(
    state: State<'_, AppState>,
    session_id: String,
    changes: Vec<Change>,
) -> Res<Vec<String>> {
    session(&state, &session_id)
        .await?
        .preview_changes(&changes)
}

#[tauri::command]
async fn apply_changes(
    state: State<'_, AppState>,
    session_id: String,
    changes: Vec<Change>,
) -> Res<Vec<String>> {
    session(&state, &session_id)
        .await?
        .apply_changes(&changes)
        .await
}

#[tauri::command]
async fn run_statements(
    state: State<'_, AppState>,
    session_id: String,
    statements: Vec<String>,
    transaction: bool,
) -> Res<Vec<String>> {
    session(&state, &session_id)
        .await?
        .run_statements(&statements, transaction)
        .await
}

#[tauri::command]
async fn item_overview(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
) -> Res<QueryResult> {
    session(&state, &session_id).await?.overview(&schema).await
}

#[tauri::command]
async fn search_database(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    term: String,
) -> Res<Vec<SearchHit>> {
    session(&state, &session_id)
        .await?
        .search(&schema, &term)
        .await
}

#[tauri::command]
async fn kill_process(state: State<'_, AppState>, session_id: String, pid: String) -> Res<()> {
    session(&state, &session_id).await?.kill_process(&pid).await
}

#[tauri::command]
async fn backup_database(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
    database: String,
    path: String,
    custom_format: bool,
    tools_dir: Option<String>,
) -> Res<String> {
    let path = state.picked.check(&path)?;
    let (config, pw) = secure::prepare(&state.store, config, password);
    tools::backup(
        &config,
        pw.as_deref(),
        &database,
        &path.display().to_string(),
        custom_format,
        tools_dir.as_deref(),
    )
    .await
}

#[tauri::command]
async fn restore_database(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
    database: String,
    path: String,
    tools_dir: Option<String>,
) -> Res<String> {
    let path = state.picked.check(&path)?;
    let (config, pw) = secure::prepare(&state.store, config, password);
    tools::restore(
        &config,
        pw.as_deref(),
        &database,
        &path.display().to_string(),
        tools_dir.as_deref(),
    )
    .await
}

/// Native file dialogs run on the backend so it knows which paths the user actually chose.
#[tauri::command]
async fn pick_path(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
    default_name: Option<String>,
    filter_name: Option<String>,
    extensions: Vec<String>,
) -> Res<Option<String>> {
    secure::pick(
        app,
        &state.picked,
        mode,
        default_name,
        filter_name,
        extensions,
    )
    .await
}

#[tauri::command]
async fn ai_status() -> Res<ai::AiStatus> {
    tauri::async_runtime::spawn_blocking(ai::status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ai_set_key(provider: ai::Provider, key: String) -> Res<()> {
    ai::set_key(provider, &key)
}

#[tauri::command]
async fn ai_clear_key(provider: ai::Provider) -> Res<()> {
    ai::clear_key(provider);
    Ok(())
}

#[tauri::command]
async fn ai_ant_login() -> Res<String> {
    ai::ant_login().await
}

#[tauri::command]
async fn ai_ask(
    state: State<'_, AppState>,
    session_id: String,
    request: ai::AskRequest,
) -> Res<ai::AskResponse> {
    let s = session(&state, &session_id).await?;
    ai::ask(&s, &state.dir, request).await
}

/// Runs AI-generated SQL that is supposed to be read-only, with server-side enforcement.
#[tauri::command]
async fn execute_readonly(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
) -> Res<Vec<QueryResult>> {
    session(&state, &session_id)
        .await?
        .execute_readonly(&sql)
        .await
}

#[tauri::command]
async fn chatgpt_status(state: State<'_, AppState>) -> Res<chatgpt::ChatGptStatus> {
    Ok(chatgpt::status(&state.dir))
}

#[tauri::command]
async fn chatgpt_sign_in(state: State<'_, AppState>) -> Res<chatgpt::ChatGptStatus> {
    chatgpt::sign_in(&state.dir).await
}

#[tauri::command]
async fn chatgpt_sign_out(state: State<'_, AppState>) -> Res<String> {
    chatgpt::sign_out(&state.dir).await
}

#[tauri::command]
async fn chatgpt_models(state: State<'_, AppState>) -> Res<Vec<chatgpt::ModelOption>> {
    chatgpt::models(&state.dir).await
}

#[tauri::command]
async fn chatgpt_welcomed(state: State<'_, AppState>) -> Res<()> {
    chatgpt::mark_welcomed(&state.dir);
    Ok(())
}

/// Opens a small allow-list of help pages in the system browser.
#[tauri::command]
async fn open_help_url(url: String) -> Res<()> {
    const ALLOWED: &[&str] = &[
        "https://chatgpt.com/settings/usage",
        "https://help.openai.com/",
        "https://platform.openai.com/api-keys",
        "https://console.anthropic.com/",
        "https://platform.claude.com/",
    ];
    if !ALLOWED
        .iter()
        .any(|p| url == *p || url.starts_with(p) && p.ends_with('/'))
    {
        return Err("URL not allowed".into());
    }
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_text_file(state: State<'_, AppState>, path: String, contents: String) -> Res<()> {
    let path = state.picked.check(&path)?;
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_text_file(state: State<'_, AppState>, path: String) -> Res<String> {
    let path = state.picked.check(&path)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Copies saved connections and the ChatGPT registration from config folders used under earlier
/// app names (NQL, then Rowboat) the first time Querybird starts. Old folders are left untouched.
fn migrate_legacy_config(dir: &std::path::Path) {
    let Some(parent) = dir.parent() else { return };
    let _ = std::fs::create_dir_all(dir);
    for legacy in ["dev.nql.app", "dev.rowboat.app"].map(|n| parent.join(n)) {
        for name in ["connections.json", "chatgpt.json"] {
            let (from, to) = (legacy.join(name), dir.join(name));
            if from.is_file() && !to.exists() {
                let _ = std::fs::copy(&from, &to);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::dispatch(app, event.id().as_ref()))
        .setup(|app| {
            let dir = app.path().app_config_dir().expect("no config dir");
            migrate_legacy_config(&dir);
            app.manage(AppState {
                store: Store::new(dir.clone()),
                picked: Default::default(),
                dir,
                sessions: RwLock::new(HashMap::new()),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle().clone();
            let label = window.label().to_string();
            let workspaces_open = |app: &AppHandle, except: &str| {
                app.webview_windows()
                    .keys()
                    .any(|l| l.starts_with("ws-") && l != except)
            };
            match event {
                // Closing the welcome window while workspaces are open just hides it.
                WindowEvent::CloseRequested { api, .. }
                    if label == "main" && workspaces_open(&app, "") =>
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                WindowEvent::Destroyed if label.starts_with("ws-") => {
                    let sid = label.trim_start_matches("ws-").to_string();
                    let app2 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        app2.state::<AppState>().sessions.write().await.remove(&sid);
                    });
                    if !workspaces_open(&app, &label) {
                        if let Some(main) = app.get_webview_window("main") {
                            let _ = main.show();
                            let _ = main.set_focus();
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            save_connection,
            delete_connection,
            has_saved_password,
            rename_group,
            copy_connection_url,
            pick_path,
            test_connection,
            connect,
            open_workspace,
            show_welcome,
            session_info,
            disconnect,
            reconnect,
            list_schemas,
            set_schema,
            list_objects,
            fetch_table,
            table_structure,
            table_info,
            table_ddl,
            process_list_sql,
            execute,
            preview_changes,
            apply_changes,
            write_text_file,
            read_text_file,
            run_statements,
            item_overview,
            search_database,
            kill_process,
            backup_database,
            restore_database,
            ai_status,
            ai_set_key,
            ai_clear_key,
            ai_ant_login,
            ai_ask,
            execute_readonly,
            chatgpt_status,
            chatgpt_sign_in,
            chatgpt_sign_out,
            chatgpt_models,
            chatgpt_welcomed,
            open_help_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Querybird");
}
