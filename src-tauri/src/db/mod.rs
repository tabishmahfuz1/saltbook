//! SQLite engine: connection, idempotent schema/migration runner, default
//! seeds and shared helpers.

pub mod demo;
pub mod outbox;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use chrono::{Datelike, Local};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

pub const SCHEMA: &str = include_str!("schema.sql");

/// Current epoch in milliseconds.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A time-ordered UUIDv7 for every primary key (Guardrail 2).
pub fn new_id() -> String {
    Uuid::now_v7().to_string()
}

pub fn today_iso() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

pub fn today_display() -> String {
    Local::now().format("%d/%m/%Y").to_string()
}

pub fn iso_to_display(iso: &str) -> String {
    match chrono::NaiveDate::parse_from_str(iso.trim(), "%Y-%m-%d") {
        Ok(d) => d.format("%d/%m/%Y").to_string(),
        Err(_) => iso.to_string(),
    }
}

pub fn display_to_iso(display: &str) -> AppResult<String> {
    chrono::NaiveDate::parse_from_str(display.trim(), "%d/%m/%Y")
        .map(|d| d.format("%Y-%m-%d").to_string())
        .map_err(|_| AppError::validation_field("Date must be DD/MM/YYYY.", "date"))
}

/// `"03/26"` -> `202603`. Accepts `MM/YY`, `M/YYYY` and `MM-YY`.
pub fn expiry_key_from_mm_yy(input: &str) -> AppResult<i64> {
    let text = input.trim();
    let parts: Vec<&str> = text.split(['/', '-', ' ']).filter(|p| !p.is_empty()).collect();
    if parts.len() != 2 {
        return Err(AppError::validation_field(
            "Expiry must be in MM/YY format, e.g. 03/26.",
            "expiry",
        ));
    }
    let month: i32 = parts[0].parse().map_err(|_| {
        AppError::validation_field("Expiry month must be 01-12.", "expiry")
    })?;
    let year_in: i32 = parts[1].parse().map_err(|_| {
        AppError::validation_field("Expiry year must be two or four digits.", "expiry")
    })?;
    if !(1..=12).contains(&month) {
        return Err(AppError::validation_field("Expiry month must be 01-12.", "expiry"));
    }
    let year = if year_in < 100 { 2000 + year_in } else { year_in };
    if !(1990..=2100).contains(&year) {
        return Err(AppError::validation_field("Expiry year is out of range.", "expiry"));
    }
    Ok((year * 100 + month) as i64)
}

/// `202603` -> `"03/26"`.
pub fn expiry_display_from_key(key: i64) -> String {
    format!("{:02}/{:02}", key % 100, (key / 100) % 100)
}

/// Current YYYYMM key, used for near-expiry highlighting.
pub fn current_expiry_key() -> i64 {
    let now = Local::now();
    (now.year() * 100 + now.month() as i32) as i64
}

pub struct Db {
    pub path: PathBuf,
    pub conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path).map_err(AppError::from)?;
        Self::finish_open(path, conn)
    }

    /// In-memory database used by unit/integration tests.
    pub fn open_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::finish_open(PathBuf::from(":memory:"), conn)
    }

    fn finish_open(path: PathBuf, conn: Connection) -> AppResult<Self> {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        run_migrations(&conn)?;
        seed_defaults(&conn)?;
        Ok(Self { path, conn: Mutex::new(conn) })
    }

    pub fn lock(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| AppError::internal("Database lock was poisoned by a previous panic."))
    }

    pub fn device_id(&self) -> AppResult<String> {
        let conn = self.lock()?;
        Ok(get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown-device".into()))
    }

    pub fn setting(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.lock()?;
        get_setting(&conn, key)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        let conn = self.lock()?;
        set_setting(&conn, key, value)
    }
}

/// Idempotent schema application plus a forward-compatible column guard.
pub fn run_migrations(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    ensure_column(conn, "products", "short_name", "TEXT")?;
    ensure_column(conn, "batches", "rack_no", "TEXT")?;
    conn.pragma_update(None, "user_version", 1)?;
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> AppResult<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;
    if !names.iter().any(|n| n == column) {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    }
    Ok(())
}

/// Default configuration rows required by the SRD. Idempotent.
pub fn seed_defaults(conn: &Connection) -> AppResult<()> {
    let now = now_ms();

    for (name, cgst, sgst, igst) in [
        ("GST-0", 0, 0, 0),
        ("GST-5", 250, 250, 500),
        ("GST-12", 600, 600, 1200),
        ("GST-18", 900, 900, 1800),
    ] {
        conn.execute(
            "INSERT OR IGNORE INTO tax_plans (id, name, cgst_bps, sgst_bps, igst_bps, updated_at, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![new_id(), name, cgst, sgst, igst, now],
        )?;
    }

    conn.execute(
        "INSERT OR IGNORE INTO godowns (id, code, name, is_default, updated_at, is_deleted)
         VALUES (?1, 'MAIN', 'Main Godown', 1, ?2, 0)",
        params![new_id(), now],
    )?;

    conn.execute(
        "INSERT OR IGNORE INTO invoice_series (id, series_code, series_name, is_estimate, next_inv_no, updated_at, is_deleted)
         VALUES (?1, 'E', 'Estimate Series', 1, 728, ?2, 0)",
        params![new_id(), now],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO invoice_series (id, series_code, series_name, is_estimate, next_inv_no, updated_at, is_deleted)
         VALUES (?1, 'ABC', 'Tax Invoice Series', 0, 3, ?2, 0)",
        params![new_id(), now],
    )?;

    for (key, value) in [
        ("device_id", new_id()),
        ("device_name", "FRONT DESK".to_string()),
        ("merchant_vpa", "saltbook@upi".to_string()),
        ("printer_name", String::new()),
        ("auto_backup", "1".to_string()),
        ("auto_sync", "0".to_string()),
        ("backup_interval_hours", "2".to_string()),
        ("sync_interval_secs", "60".to_string()),
        ("gdrive_connected", "0".to_string()),
        ("gdrive_access_token", String::new()),
        ("gdrive_refresh_token", String::new()),
        ("gdrive_token_expiry", "0".to_string()),
        ("gdrive_backup_folder", "Saltbook_Backups".to_string()),
        ("gdrive_sync_folder", "Saltbook_Sync".to_string()),
        ("last_backup_at", "0".to_string()),
        ("last_sync_at", "0".to_string()),
        ("demo_seeded", "0".to_string()),
        ("company_name", "SALTBOOK PHARMACEUTICALS".to_string()),
        ("company_address", "MAIN ROAD, BARH, PATNA - 803213".to_string()),
        ("company_state", "BIHAR".to_string()),
        ("company_state_code", "10".to_string()),
        ("company_gst_no", "10ABCDE1234F1ZF".to_string()),
        ("company_dl_no", "BR-20B/0001".to_string()),
        ("company_phone", "0612-2233445".to_string()),
        ("gdrive_client_id", String::new()),
        ("gdrive_redirect_uri", "http://127.0.0.1:1421/oauth2callback".to_string()),
        ("gdrive_pkce_verifier", String::new()),
        ("gdrive_oauth_state", String::new()),
    ] {
        conn.execute(
            "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value, now],
        )?;
    }
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| {
            r.get::<_, String>(0)
        })
        .optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_ms()],
    )?;
    Ok(())
}

pub fn setting_bool(conn: &Connection, key: &str) -> bool {
    matches!(get_setting(conn, key).ok().flatten().as_deref(), Some("1") | Some("true"))
}

pub fn setting_i64(conn: &Connection, key: &str, fallback: i64) -> i64 {
    get_setting(conn, key)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_applies_and_seeds_defaults() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        let tax_plans: i64 = conn
            .query_row("SELECT COUNT(*) FROM tax_plans", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tax_plans, 4);
        let series: i64 = conn
            .query_row("SELECT next_inv_no FROM invoice_series WHERE series_code = 'E'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(series, 728);
        let godown: i64 = conn
            .query_row("SELECT COUNT(*) FROM godowns WHERE code = 'MAIN' AND is_default = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(godown, 1);
        assert!(!get_setting(&conn, "device_id").unwrap().unwrap().is_empty());
    }

    #[test]
    fn schema_is_idempotent() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        run_migrations(&conn).unwrap();
        run_migrations(&conn).unwrap();
        seed_defaults(&conn).unwrap();
    }

    #[test]
    fn fts_triggers_populate_search_index() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        let now = now_ms();
        conn.execute(
            "INSERT INTO companies (id, code, name, updated_at) VALUES ('c1', 'C1', 'CIPLA', ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO products (id, pro_code, name, company_id, pack_form, updated_at)
             VALUES ('p1', 249, 'MONOCEF 500 VIAL', 'c1', 'INJ', ?1)",
            params![now],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM products_fts WHERE products_fts MATCH '\"monocef\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
        conn.execute("UPDATE products SET name = 'MONOCEF 1GM VIAL' WHERE id = 'p1'", [])
            .unwrap();
        let old: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM products_fts WHERE products_fts MATCH '\"500\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let new: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM products_fts WHERE products_fts MATCH '\"1gm\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old, 0);
        assert_eq!(new, 1);
    }

    #[test]
    fn expiry_keys_round_trip() {
        assert_eq!(expiry_key_from_mm_yy("03/26").unwrap(), 202603);
        assert_eq!(expiry_key_from_mm_yy("11/2027").unwrap(), 202711);
        assert_eq!(expiry_key_from_mm_yy("3-25").unwrap(), 202503);
        assert!(expiry_key_from_mm_yy("13/26").is_err());
        assert_eq!(expiry_display_from_key(202603), "03/26");
    }

    #[test]
    fn dates_convert_between_display_and_iso() {
        assert_eq!(display_to_iso("04/11/2026").unwrap(), "2026-11-04");
        assert_eq!(iso_to_display("2026-11-04"), "04/11/2026");
        assert!(display_to_iso("2026-11-04").is_err());
    }
}
