//! Google Drive login, backup/sync commands, LAN server and the migration
//! wizard bridge.

use std::path::PathBuf;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::{get_setting, now_ms, set_setting, setting_bool, setting_i64, Db};
use crate::error::{AppError, AppResult};
use crate::services::gdrive_backup::{self, GDriveClient};
use crate::services::gdrive_delta_sync;
use crate::services::legacy_import;

pub const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:1421/oauth2callback";

fn backups_dir(state: &crate::AppState) -> PathBuf {
    state.db_dir.join("backups")
}

fn require_setting(conn: &Connection, key: &str) -> AppResult<String> {
    match get_setting(conn, key)? {
        Some(value) if !value.trim().is_empty() => Ok(value),
        _ => Err(AppError::new(
            "AUTH",
            format!("Setting '{key}' is required. Open Setup -> Google Drive Sync."),
        )),
    }
}

/// Returns an authenticated Drive client, refreshing the access token when it
/// is close to expiry.
pub fn ensure_access_token(conn: &Connection) -> AppResult<GDriveClient> {
    let client_id = require_setting(conn, "gdrive_client_id")?;
    let access = get_setting(conn, "gdrive_access_token")?.unwrap_or_default();
    let expiry = setting_i64(conn, "gdrive_token_expiry", 0);
    if !access.is_empty() && expiry - now_ms() > 60_000 {
        return GDriveClient::new(access);
    }
    let refresh = require_setting(conn, "gdrive_refresh_token")?;
    let tokens = gdrive_backup::refresh_access_token(&client_id, &refresh)?;
    set_setting(conn, "gdrive_access_token", &tokens.access_token)?;
    set_setting(
        conn,
        "gdrive_token_expiry",
        &(now_ms() + tokens.expires_in.max(60) * 1000).to_string(),
    )?;
    if let Some(new_refresh) = tokens.refresh_token {
        set_setting(conn, "gdrive_refresh_token", &new_refresh)?;
    }
    GDriveClient::new(tokens.access_token)
}

fn optional_client(conn: &Connection) -> Option<GDriveClient> {
    if !setting_bool(conn, "gdrive_connected") {
        return None;
    }
    ensure_access_token(conn).ok()
}

#[tauri::command]
pub fn get_sync_status(state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let pending = crate::commands::scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM sync_outbox WHERE pushed_at IS NULL",
        [],
    )?;
    let applied = crate::commands::scalar_i64(&conn, "SELECT COUNT(*) FROM sync_applied_files", [])?;
    let dir = backups_dir(&state);
    let local_backups = gdrive_backup::list_local_backups(&dir);
    let connected = setting_bool(&conn, "gdrive_connected");
    let client_id = get_setting(&conn, "gdrive_client_id")?.unwrap_or_default();
    Ok(json!({
        "connected": connected,
        "device_id": get_setting(&conn, "device_id")?.unwrap_or_default(),
        "device_name": get_setting(&conn, "device_name")?.unwrap_or_default(),
        "client_id_configured": !client_id.trim().is_empty(),
        "redirect_uri": get_setting(&conn, "gdrive_redirect_uri")?.unwrap_or_else(|| DEFAULT_REDIRECT_URI.to_string()),
        "backup_folder": get_setting(&conn, "gdrive_backup_folder")?.unwrap_or_else(|| "Saltbook_Backups".into()),
        "sync_folder": get_setting(&conn, "gdrive_sync_folder")?.unwrap_or_else(|| "Saltbook_Sync".into()),
        "auto_backup": setting_bool(&conn, "auto_backup"),
        "auto_sync": setting_bool(&conn, "auto_sync"),
        "backup_interval_hours": setting_i64(&conn, "backup_interval_hours", 2),
        "sync_interval_secs": setting_i64(&conn, "sync_interval_secs", 60),
        "last_backup_at": setting_i64(&conn, "last_backup_at", 0),
        "last_sync_at": setting_i64(&conn, "last_sync_at", 0),
        "pending_outbox": pending,
        "applied_files": applied,
        "local_backups": local_backups.iter().take(12).cloned().collect::<Vec<_>>(),
        "backups_dir": dir.to_string_lossy(),
        "merchant_vpa": get_setting(&conn, "merchant_vpa")?.unwrap_or_default(),
        "printer_name": get_setting(&conn, "printer_name")?.unwrap_or_default(),
        "company_name": get_setting(&conn, "company_name")?.unwrap_or_default(),
        "company_address": get_setting(&conn, "company_address")?.unwrap_or_default(),
        "company_gst_no": get_setting(&conn, "company_gst_no")?.unwrap_or_default(),
        "company_dl_no": get_setting(&conn, "company_dl_no")?.unwrap_or_default(),
        "company_phone": get_setting(&conn, "company_phone")?.unwrap_or_default(),
        "company_state_code": get_setting(&conn, "company_state_code")?.unwrap_or_default(),
        "estimate_next_inv_no": crate::commands::scalar_i64(
            &conn,
            "SELECT COALESCE((SELECT next_inv_no FROM invoice_series WHERE series_code = 'E'), 0)",
            [],
        )?,
        "tax_next_inv_no": crate::commands::scalar_i64(
            &conn,
            "SELECT COALESCE((SELECT next_inv_no FROM invoice_series WHERE series_code = 'ABC'), 0)",
            [],
        )?,
    }))
}

#[derive(Debug, Default, Deserialize)]
pub struct SyncSettingsRequest {
    #[serde(default)]
    pub auto_backup: Option<bool>,
    #[serde(default)]
    pub auto_sync: Option<bool>,
    #[serde(default)]
    pub backup_interval_hours: Option<i64>,
    #[serde(default)]
    pub sync_interval_secs: Option<i64>,
    #[serde(default)]
    pub merchant_vpa: Option<String>,
    #[serde(default)]
    pub printer_name: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub gdrive_client_id: Option<String>,
    #[serde(default)]
    pub gdrive_redirect_uri: Option<String>,
    #[serde(default)]
    pub gdrive_backup_folder: Option<String>,
    #[serde(default)]
    pub gdrive_sync_folder: Option<String>,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub company_address: Option<String>,
    #[serde(default)]
    pub company_gst_no: Option<String>,
    #[serde(default)]
    pub company_dl_no: Option<String>,
    #[serde(default)]
    pub company_phone: Option<String>,
    #[serde(default)]
    pub company_state_code: Option<String>,
    #[serde(default)]
    pub estimate_next_inv_no: Option<i64>,
    #[serde(default)]
    pub tax_next_inv_no: Option<i64>,
}

#[tauri::command]
pub fn set_sync_settings(
    req: SyncSettingsRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    if let Some(value) = req.backup_interval_hours {
        if !(1..=168).contains(&value) {
            return Err(AppError::validation_field(
                "Backup interval must be 1-168 hours.",
                "backup_interval_hours",
            ));
        }
        set_setting(&conn, "backup_interval_hours", &value.to_string())?;
    }
    if let Some(value) = req.sync_interval_secs {
        if !(15..=3600).contains(&value) {
            return Err(AppError::validation_field(
                "Sync interval must be 15-3600 seconds.",
                "sync_interval_secs",
            ));
        }
        set_setting(&conn, "sync_interval_secs", &value.to_string())?;
    }
    if let Some(value) = req.auto_backup {
        set_setting(&conn, "auto_backup", if value { "1" } else { "0" })?;
    }
    if let Some(value) = req.auto_sync {
        set_setting(&conn, "auto_sync", if value { "1" } else { "0" })?;
    }
    if let Some(gst) = req.company_gst_no.as_deref() {
        crate::services::validation::validate_gstin(gst)?;
    }
    if let Some(code) = req.company_state_code.as_deref() {
        let code = code.trim();
        if !code.is_empty()
            && (code.len() != 2 || !code.chars().all(|c| c.is_ascii_digit()))
        {
            return Err(AppError::validation_field(
                "Company state code must be two digits, e.g. 10 for Bihar.",
                "company_state_code",
            ));
        }
    }
    if req.estimate_next_inv_no.is_some_and(|value| value < 1)
        || req.tax_next_inv_no.is_some_and(|value| value < 1)
    {
        return Err(AppError::validation_field(
            "Next invoice numbers must be at least 1.",
            "estimate_next_inv_no",
        ));
    }
    let now = now_ms();
    if let Some(value) = req.estimate_next_inv_no {
        conn.execute(
            "UPDATE invoice_series SET next_inv_no = ?1, updated_at = ?2 WHERE series_code = 'E'",
            params![value, now],
        )?;
    }
    if let Some(value) = req.tax_next_inv_no {
        conn.execute(
            "UPDATE invoice_series SET next_inv_no = ?1, updated_at = ?2 WHERE series_code = 'ABC'",
            params![value, now],
        )?;
    }
    for (key, value) in [
        ("merchant_vpa", req.merchant_vpa),
        ("printer_name", req.printer_name),
        ("device_name", req.device_name),
        ("gdrive_client_id", req.gdrive_client_id),
        ("gdrive_redirect_uri", req.gdrive_redirect_uri),
        ("gdrive_backup_folder", req.gdrive_backup_folder),
        ("gdrive_sync_folder", req.gdrive_sync_folder),
        ("company_name", req.company_name),
        ("company_address", req.company_address),
        ("company_gst_no", req.company_gst_no),
        ("company_dl_no", req.company_dl_no),
        ("company_phone", req.company_phone),
        ("company_state_code", req.company_state_code),
    ] {
        if let Some(value) = value {
            set_setting(&conn, key, value.trim())?;
        }
    }
    Ok(json!({ "ok": true }))
}

#[derive(Debug, Default, Deserialize)]
pub struct LoginStartRequest {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub redirect_uri: Option<String>,
}

#[tauri::command]
pub fn start_gdrive_login(
    req: LoginStartRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let client_id = req
        .client_id
        .filter(|c| !c.trim().is_empty())
        .or(get_setting(&conn, "gdrive_client_id")?)
        .unwrap_or_default();
    if client_id.trim().is_empty() {
        return Err(AppError::validation_field(
            "Enter your Google OAuth Client ID first (Desktop app type).",
            "gdrive_client_id",
        ));
    }
    let redirect_uri = req
        .redirect_uri
        .filter(|u| !u.trim().is_empty())
        .or(get_setting(&conn, "gdrive_redirect_uri")?)
        .unwrap_or_else(|| DEFAULT_REDIRECT_URI.to_string());
    let pkce = gdrive_backup::pkce_pair();
    let oauth_state = gdrive_backup::random_state();
    set_setting(&conn, "gdrive_client_id", client_id.trim())?;
    set_setting(&conn, "gdrive_redirect_uri", redirect_uri.trim())?;
    set_setting(&conn, "gdrive_pkce_verifier", &pkce.verifier)?;
    set_setting(&conn, "gdrive_oauth_state", &oauth_state)?;
    let url = gdrive_backup::auth_url(client_id.trim(), redirect_uri.trim(), &oauth_state, &pkce.challenge);
    Ok(json!({ "auth_url": url, "state": oauth_state, "redirect_uri": redirect_uri }))
}

#[derive(Debug, Deserialize)]
pub struct LoginCompleteRequest {
    pub code: String,
    #[serde(default)]
    pub state: Option<String>,
}

#[tauri::command]
pub fn complete_gdrive_login(
    req: LoginCompleteRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let expected_state = get_setting(&conn, "gdrive_oauth_state")?.unwrap_or_default();
    if let Some(received) = req.state.filter(|s| !s.trim().is_empty()) {
        if !expected_state.is_empty() && received.trim() != expected_state {
            return Err(AppError::new(
                "AUTH",
                "OAuth state mismatch. Start the Google login again.",
            ));
        }
    }
    let verifier = require_setting(&conn, "gdrive_pkce_verifier")?;
    let client_id = require_setting(&conn, "gdrive_client_id")?;
    let redirect_uri = get_setting(&conn, "gdrive_redirect_uri")?
        .unwrap_or_else(|| DEFAULT_REDIRECT_URI.to_string());
    if req.code.trim().is_empty() {
        return Err(AppError::validation_field("Paste the authorization code.", "code"));
    }
    let tokens = gdrive_backup::exchange_code(&client_id, &redirect_uri, &req.code, &verifier)?;
    set_setting(&conn, "gdrive_access_token", &tokens.access_token)?;
    if let Some(refresh) = &tokens.refresh_token {
        set_setting(&conn, "gdrive_refresh_token", refresh)?;
    }
    set_setting(
        &conn,
        "gdrive_token_expiry",
        &(now_ms() + tokens.expires_in.max(60) * 1000).to_string(),
    )?;
    set_setting(&conn, "gdrive_connected", "1")?;
    set_setting(&conn, "gdrive_pkce_verifier", "")?;
    set_setting(&conn, "gdrive_oauth_state", "")?;
    Ok(json!({
        "connected": true,
        "has_refresh_token": tokens.refresh_token.is_some() || !get_setting(&conn, "gdrive_refresh_token")?.unwrap_or_default().is_empty(),
    }))
}

#[tauri::command]
pub fn gdrive_disconnect(state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let conn = state.db.lock()?;
    for key in ["gdrive_access_token", "gdrive_refresh_token", "gdrive_pkce_verifier", "gdrive_oauth_state"] {
        set_setting(&conn, key, "")?;
    }
    set_setting(&conn, "gdrive_token_expiry", "0")?;
    set_setting(&conn, "gdrive_connected", "0")?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn run_backup_now(state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let dir = backups_dir(&state);
    let folder = get_setting(&conn, "gdrive_backup_folder")?.unwrap_or_else(|| "Saltbook_Backups".into());
    let client = optional_client(&conn);
    let outcome = gdrive_backup::create_atomic_backup(&conn, &dir, client.as_ref(), &folder)?;
    set_setting(&conn, "last_backup_at", &now_ms().to_string())?;
    Ok(json!({
        "filename": outcome.filename,
        "local_path": outcome.local_path,
        "bytes": outcome.bytes,
        "uploaded": outcome.uploaded,
        "pruned": outcome.pruned,
        "message": if outcome.uploaded {
            "Snapshot compressed and uploaded to Google Drive."
        } else {
            "Snapshot created locally. Connect Google Drive to upload it."
        },
    }))
}

#[tauri::command]
pub fn run_delta_sync_now(state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let client = ensure_access_token(&conn)?;
    let folder_name = get_setting(&conn, "gdrive_sync_folder")?.unwrap_or_else(|| "Saltbook_Sync".into());
    let sync_root = client.ensure_folder(&folder_name)?;
    let deltas_folder = client.ensure_child_folder("deltas", &sync_root)?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let push = gdrive_delta_sync::push_outbox(&mut conn, &device_id, &client, &deltas_folder)?;
    let pull = gdrive_delta_sync::pull_deltas(&mut conn, &device_id, &client, &deltas_folder)?;
    set_setting(&conn, "last_sync_at", &now_ms().to_string())?;
    Ok(json!({
        "pushed": push.pushed,
        "uploaded_file": push.file,
        "files_pulled": pull.files,
        "rows_applied": pull.applied,
    }))
}

#[tauri::command]
pub fn list_backups(state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let dir = backups_dir(&state);
    let local = gdrive_backup::list_local_backups(&dir);
    let mut remote: Vec<Value> = Vec::new();
    if let Some(client) = optional_client(&conn) {
        let folder = get_setting(&conn, "gdrive_backup_folder")?.unwrap_or_else(|| "Saltbook_Backups".into());
        if let Ok(folder_id) = client.ensure_folder(&folder) {
            let query = format!("'{}' in parents and trashed = false", folder_id.replace('\'', "\\'"));
            remote = client.list_files(&query).unwrap_or_default();
        }
    }
    Ok(json!({ "local": local, "remote": remote, "dir": dir.to_string_lossy() }))
}

#[derive(Debug, Deserialize)]
pub struct LanStartRequest {
    #[serde(default = "default_lan_port")]
    pub port: u16,
}

fn default_lan_port() -> u16 {
    8787
}

#[tauri::command]
pub fn start_lan_sync_server(
    req: LanStartRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    gdrive_delta_sync::start_lan_server(state.db.clone(), req.port)
}

#[derive(Debug, Deserialize)]
pub struct MigrationPreviewRequest {
    pub path: String,
}

#[tauri::command]
pub fn migration_preview(req: MigrationPreviewRequest) -> AppResult<Value> {
    legacy_import::read_and_preview(&req.path)
}

#[derive(Debug, Deserialize)]
pub struct MigrationImportRequest {
    pub path: String,
    #[serde(default = "default_true")]
    pub create_missing_products: bool,
    #[serde(default)]
    pub godown_id: Option<String>,
}

fn default_true() -> bool {
    true
}

#[tauri::command]
pub fn migration_import(
    req: MigrationImportRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let summary = legacy_import::run_import(
        &mut conn,
        &device_id,
        &req.path,
        req.create_missing_products,
        req.godown_id.as_deref(),
    )?;
    Ok(json!({
        "imported_products": summary.imported_products,
        "imported_batches": summary.imported_batches,
        "updated_batches": summary.updated_batches,
        "skipped_rows": summary.skipped_rows,
        "warnings": summary.warnings,
    }))
}

/// Background worker: automatic 2-hourly backups and 60-second delta sync.
/// Only runs when the corresponding setting is enabled.
pub fn spawn_workers(db: std::sync::Arc<Db>, db_dir: PathBuf) {
    std::thread::spawn(move || {
        let mut last_backup_check = 0i64;
        loop {
            std::thread::sleep(Duration::from_secs(20));
            let now = now_ms();
            if now - last_backup_check < 20_000 {
                continue;
            }
            last_backup_check = now;

            let conn = match db.lock() {
                Ok(conn) => conn,
                Err(_) => continue,
            };
            if setting_bool(&conn, "auto_backup") {
                let interval_ms = setting_i64(&conn, "backup_interval_hours", 2).max(1) * 3_600_000;
                let last = setting_i64(&conn, "last_backup_at", 0);
                if now - last >= interval_ms {
                    let folder = get_setting(&conn, "gdrive_backup_folder")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "Saltbook_Backups".into());
                    let client = optional_client(&conn);
                    match gdrive_backup::create_atomic_backup(&conn, &db_dir.join("backups"), client.as_ref(), &folder) {
                        Ok(_) => {
                            let _ = set_setting(&conn, "last_backup_at", &now_ms().to_string());
                        }
                        Err(err) => eprintln!("[saltbook] backup failed: {}", err.message),
                    }
                }
            }

            if setting_bool(&conn, "auto_sync") && setting_bool(&conn, "gdrive_connected") {
                let interval_ms = setting_i64(&conn, "sync_interval_secs", 60).max(15) * 1000;
                let last = setting_i64(&conn, "last_sync_at", 0);
                if now - last >= interval_ms {
                    if let Ok(client) = ensure_access_token(&conn) {
                        let folder_name = get_setting(&conn, "gdrive_sync_folder")
                            .ok()
                            .flatten()
                            .unwrap_or_else(|| "Saltbook_Sync".into());
                        if let Ok(folder_id) = client.ensure_folder(&folder_name) {
                            if let Ok(deltas) = client.ensure_child_folder("deltas", &folder_id) {
                                let device_id = get_setting(&conn, "device_id")
                                    .ok()
                                    .flatten()
                                    .unwrap_or_else(|| "unknown".into());
                                drop(conn);
                                let mut conn = match db.lock() {
                                    Ok(conn) => conn,
                                    Err(_) => continue,
                                };
                                let push = gdrive_delta_sync::push_outbox(&mut conn, &device_id, &client, &deltas);
                                if let Err(err) = push {
                                    eprintln!("[saltbook] sync push failed: {}", err.message);
                                    continue;
                                }
                                match gdrive_delta_sync::pull_deltas(&mut conn, &device_id, &client, &deltas) {
                                    Ok(_) => {
                                        let _ = set_setting(&conn, "last_sync_at", &now_ms().to_string());
                                    }
                                    Err(err) => eprintln!("[saltbook] sync pull failed: {}", err.message),
                                }
                            }
                        }
                    }
                }
            }
        }
    });
}

/// Used by tests to confirm the worker settings exist.
pub fn _has_setting(conn: &Connection, key: &str) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM app_settings WHERE key = ?1", params![key], |r| r.get::<_, i64>(0))
        .optional()?
        .is_some())
}
