//! Native menu bar mirroring TablePlus's menus. Custom items emit a `menu` event with the
//! command id to the focused window; the frontend runs the same handler as the shortcut.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, label, true, accel)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(
        app,
        "Querybird",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some("About Querybird"),
                Some(AboutMetadata {
                    name: Some("Querybird".into()),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                    comments: Some("Free, open-source database client".into()),
                    license: Some("MIT".into()),
                    ..Default::default()
                }),
            )?,
            &sep()?,
            &item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let import = Submenu::with_items(
        app,
        "Import",
        true,
        &[
            &item(app, "import_csv", "From CSV…", None)?,
            &item(app, "import_sql", "From SQL Dump…", None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(
                app,
                "new_connection",
                "New Connection…",
                Some("CmdOrCtrl+N"),
            )?,
            &item(app, "new_user", "New Database User…", None)?,
            &item(app, "open_sql", "Open SQL File…", Some("CmdOrCtrl+O"))?,
            &item(app, "new_query", "New SQL Query", Some("CmdOrCtrl+T"))?,
            &sep()?,
            &import,
            &item(app, "export", "Export…", None)?,
            &item(app, "backup", "Backup…", None)?,
            &item(app, "restore", "Restore…", None)?,
            &sep()?,
            &item(app, "close_tab", "Close Tab", Some("CmdOrCtrl+W"))?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &item(app, "undo", "Undo", Some("CmdOrCtrl+Z"))?,
            &item(app, "redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?,
            &sep()?,
            &item(app, "commit", "Commit", Some("CmdOrCtrl+S"))?,
            &item(app, "discard", "Discard", None)?,
            &item(app, "preview", "Preview", None)?,
            &sep()?,
            &item(app, "add_row", "Add Row", Some("CmdOrCtrl+I"))?,
            &item(app, "duplicate_rows", "Duplicate Rows", Some("CmdOrCtrl+D"))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &sep()?,
            &item(app, "find", "Find / Filter", Some("CmdOrCtrl+F"))?,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(
                app,
                "toggle_sidebar",
                "Toggle Left Sidebar",
                Some("CmdOrCtrl+0"),
            )?,
            &item(
                app,
                "toggle_console",
                "Toggle Console",
                Some("CmdOrCtrl+Shift+E"),
            )?,
            &item(
                app,
                "toggle_details",
                "Toggle Right Sidebar",
                Some("CmdOrCtrl+Shift+."),
            )?,
            &sep()?,
            &item(
                app,
                "font_bigger",
                "Increase Font Size",
                Some("CmdOrCtrl+="),
            )?,
            &item(
                app,
                "font_smaller",
                "Decrease Font Size",
                Some("CmdOrCtrl+-"),
            )?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let navigate = Submenu::with_items(
        app,
        "Navigate",
        true,
        &[
            &item(app, "open_anything", "Open Anything", Some("CmdOrCtrl+P"))?,
            &item(
                app,
                "open_database",
                "Open a Database…",
                Some("CmdOrCtrl+K"),
            )?,
            &sep()?,
            &item(app, "show_data", "Show Table Data", None)?,
            &item(app, "show_structure", "Show Table Structure", None)?,
            &sep()?,
            &item(app, "next_tab", "Select Next Tab", None)?,
            &item(app, "prev_tab", "Select Previous Tab", None)?,
        ],
    )?;

    let connection = Submenu::with_items(
        app,
        "Connection",
        true,
        &[
            &item(app, "run_current", "Run Current Query", None)?,
            &item(app, "run_all", "Run All Queries", None)?,
            &sep()?,
            &item(app, "reload", "Reload Current Tab", Some("CmdOrCtrl+R"))?,
            &item(
                app,
                "reload_workspace",
                "Reload Workspace",
                Some("CmdOrCtrl+Shift+R"),
            )?,
            &item(app, "reconnect", "Reconnect", None)?,
            &item(app, "disconnect", "Disconnect", None)?,
        ],
    )?;

    let tools = Submenu::with_items(
        app,
        "Tools",
        true,
        &[
            &item(app, "ask_ai", "Ask AI…", Some("CmdOrCtrl+J"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "overview", "Item Overview", None)?,
            &item(app, "users", "User Management…", None)?,
            &item(app, "processes", "Process List…", None)?,
            &item(app, "search_db", "Search in Database…", None)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &sep()?,
            &item(app, "connections", "Connections", Some("CmdOrCtrl+Shift+N"))?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file,
            &edit,
            &view,
            &navigate,
            &connection,
            &tools,
            &window,
        ],
    )
}

/// Routes a menu command to whichever Querybird window is focused.
pub fn dispatch<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == "connections" {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.set_focus();
        }
        return;
    }
    let focused = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));
    if let Some(w) = focused {
        let _ = w.emit_to(w.label(), "menu", id.to_string());
    }
}
