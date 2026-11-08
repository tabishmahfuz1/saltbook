//! Multi-client delta sync over Google Drive, plus a small read-only LAN
//! diagnostics server (Axum) for same-network visibility.
//!
//! Push: unpushed `sync_outbox` rows are batched into
//! `<device>_<first_seq>_<last_seq>.delta.zst` and uploaded to
//! `/Saltbook_Sync/deltas/`.
//!
//! Pull: every delta file from other devices is downloaded once, applied with
//! last-write-wins per record, and additive deltas for batch stock.

use std::collections::HashSet;
use std::sync::Arc;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Value};

use axum::{extract::State, routing::get, Json, Router};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::gdrive_backup::GDriveClient;

/// Tables that participate in sync. Local-only tables (`app_settings`,
/// `invoice_series`, sync bookkeeping) are deliberately excluded.
pub const SYNC_TABLES: &[&str] = &[
    "product_groups",
    "companies",
    "compositions",
    "godowns",
    "products",
    "batches",
    "accounts_parties",
    "sales_invoices",
    "sales_invoice_items",
    "purchase_invoices",
    "purchase_invoice_items",
    "stock_adjustments",
    "stock_adjustment_items",
    "vouchers",
    "voucher_lines",
    "account_ledger",
    "supplier_sku_aliases",
];

#[derive(Debug, Clone, serde::Serialize)]
pub struct PushOutcome {
    pub pushed: usize,
    pub file: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PullOutcome {
    pub files: usize,
    pub applied: usize,
}

fn table_columns(conn: &Connection, table: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns)
}

fn json_to_sql(value: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as SqlValue;
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                SqlValue::Integer(integer)
            } else {
                SqlValue::Real(number.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(text) => SqlValue::Text(text.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

pub fn collect_outbox(conn: &Connection) -> AppResult<Vec<Value>> {
    crate::commands::query_json(
        conn,
        "SELECT seq_no, entity_table, entity_id, operation, payload_json, created_at
         FROM sync_outbox WHERE pushed_at IS NULL ORDER BY seq_no LIMIT 500",
        [],
    )
}

/// Upload one delta file containing up to 500 unpushed outbox rows.
pub fn push_outbox(
    conn: &mut Connection,
    device_id: &str,
    client: &GDriveClient,
    folder_id: &str,
) -> AppResult<PushOutcome> {
    let rows = collect_outbox(conn)?;
    if rows.is_empty() {
        return Ok(PushOutcome { pushed: 0, file: None });
    }
    let first = rows[0]["seq_no"].as_i64().unwrap_or(0);
    let last = rows[rows.len() - 1]["seq_no"].as_i64().unwrap_or(first);
    let filename = format!("{device_id}_{first}_{last}.delta.zst");
    let encoded = serde_json::to_vec(&rows)?;
    let compressed = zstd::encode_all(&encoded[..], 6)?;
    client.upload_file(&filename, &compressed, folder_id, "application/zstd")?;
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE sync_outbox SET pushed_at = ?1 WHERE seq_no BETWEEN ?2 AND ?3 AND pushed_at IS NULL",
        params![crate::db::now_ms(), first, last],
    )?;
    tx.commit()?;
    Ok(PushOutcome { pushed: rows.len(), file: Some(filename) })
}

/// Download and apply every not-yet-applied delta from other devices.
pub fn pull_deltas(
    conn: &mut Connection,
    device_id: &str,
    client: &GDriveClient,
    folder_id: &str,
) -> AppResult<PullOutcome> {
    let query = format!(
        "'{}' in parents and trashed = false and name contains '.delta.zst'",
        folder_id.replace('\'', "\\'")
    );
    let files = client.list_files(&query)?;
    let applied: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT filename FROM sync_applied_files")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut file_count = 0usize;
    let mut applied_count = 0usize;
    for file in files {
        let Some(name) = file["name"].as_str() else { continue };
        if !name.ends_with(".delta.zst") || name.starts_with(&format!("{device_id}_")) {
            continue;
        }
        if applied.contains(name) {
            continue;
        }
        let Some(file_id) = file["id"].as_str() else { continue };
        let compressed = client.download_file(file_id)?;
        let decoded = zstd::decode_all(&compressed[..])?;
        let rows: Vec<Value> = serde_json::from_slice(&decoded)?;
        let tx = conn.transaction()?;
        // A delta file may contain a batch before its product or an item before
        // its invoice; defer FK checks to commit so intra-file order is free.
        tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        for row in &rows {
            match apply_delta_row(&tx, row) {
                Ok(true) => applied_count += 1,
                Ok(false) => {}
                Err(err) => eprintln!(
                    "[saltbook] skipped {} row {}: {}",
                    row["entity_table"].as_str().unwrap_or("?"),
                    row["entity_id"].as_str().unwrap_or("?"),
                    err.message
                ),
            }
        }
        tx.execute(
            "INSERT OR REPLACE INTO sync_applied_files (filename, device_id, applied_at) VALUES (?1, ?2, ?3)",
            params![name, device_id, crate::db::now_ms()],
        )?;
        tx.commit()?;
        file_count += 1;
    }
    Ok(PullOutcome { files: file_count, applied: applied_count })
}

/// Apply one outbox row. Returns whether a change was applied.
pub fn apply_delta_row(conn: &Connection, row: &Value) -> AppResult<bool> {
    let table = row["entity_table"].as_str().unwrap_or_default();
    if !SYNC_TABLES.contains(&table) {
        return Ok(false);
    }
    let operation = row["operation"].as_str().unwrap_or("UPSERT");
    let payload_text = row["payload_json"].as_str().unwrap_or("{}");
    let payload: Value = serde_json::from_str(payload_text).unwrap_or_else(|_| json!({}));
    let entity_id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .or_else(|| row["entity_id"].as_str())
        .unwrap_or_default();
    if entity_id.is_empty() {
        return Ok(false);
    }

    if operation == "DELETE" {
        let columns = table_columns(conn, table)?;
        if columns.iter().any(|c| c == "is_deleted") {
            conn.execute(
                &format!("UPDATE {table} SET is_deleted = 1 WHERE id = ?1"),
                params![entity_id],
            )?;
        } else {
            conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![entity_id])?;
        }
        return Ok(true);
    }

    // Batch quantity deltas stay additive; metadata remains last-write-wins.
    if table == "batches" && payload.get("__qty_delta").is_some() {
        return apply_batch_delta(conn, &payload, entity_id);
    }

    let columns = table_columns(conn, table)?;
    let existing_updated: Option<i64> = if columns.iter().any(|c| c == "updated_at") {
        conn.query_row(
            &format!("SELECT updated_at FROM {table} WHERE id = ?1"),
            params![entity_id],
            |r| r.get(0),
        )
        .optional()?
    } else {
        None
    };
    let incoming_updated = payload.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
    if let Some(local) = existing_updated {
        if incoming_updated < local {
            return Ok(false); // last-write-wins
        }
    }

    let fields: Vec<&String> = columns
        .iter()
        .filter(|c| payload.get(c.as_str()).is_some())
        .collect();
    if fields.is_empty() {
        return Ok(false);
    }
    let column_list = fields
        .iter()
        .map(|c| c.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=fields.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let updates = fields
        .iter()
        .filter(|c| c.as_str() != "id")
        .map(|c| format!("{}=excluded.{}", c, c))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = if updates.is_empty() {
        format!("INSERT OR IGNORE INTO {table} ({column_list}) VALUES ({placeholders})")
    } else {
        format!(
            "INSERT INTO {table} ({column_list}) VALUES ({placeholders})
             ON CONFLICT(id) DO UPDATE SET {updates}"
        )
    };
    let values: Vec<rusqlite::types::Value> = fields
        .iter()
        .map(|c| json_to_sql(payload.get(c.as_str()).unwrap_or(&Value::Null)))
        .collect();
    conn.execute(&sql, params_from_iter(values))?;
    Ok(true)
}

fn apply_batch_delta(conn: &Connection, payload: &Value, entity_id: &str) -> AppResult<bool> {
    let cur_delta = payload.get("__qty_delta").and_then(|v| v.as_i64()).unwrap_or(0);
    let tax_delta = payload.get("__tax_qty_delta").and_then(|v| v.as_i64()).unwrap_or(0);
    let exists: Option<i64> = conn
        .query_row(
            "SELECT updated_at FROM batches WHERE id = ?1",
            params![entity_id],
            |r| r.get(0),
        )
        .optional()?;
    match exists {
        Some(local_updated) => {
            conn.execute(
                "UPDATE batches SET cur_qty = cur_qty + ?1, tax_stock_qty = tax_stock_qty + ?2 WHERE id = ?3",
                params![cur_delta, tax_delta, entity_id],
            )?;
            let incoming = payload.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
            if incoming >= local_updated {
                // Metadata-only update; quantities were applied additively above.
                let columns = table_columns(conn, "batches")?;
                let fields: Vec<&String> = columns
                    .iter()
                    .filter(|c| {
                        !matches!(c.as_str(), "id" | "cur_qty" | "tax_stock_qty")
                            && payload.get(c.as_str()).is_some()
                    })
                    .collect();
                if !fields.is_empty() {
                    let assignments = fields
                        .iter()
                        .enumerate()
                        .map(|(index, c)| format!("{c} = ?{}", index + 1))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let mut values: Vec<rusqlite::types::Value> = fields
                        .iter()
                        .map(|c| json_to_sql(payload.get(c.as_str()).unwrap_or(&Value::Null)))
                        .collect();
                    values.push(rusqlite::types::Value::Text(entity_id.to_string()));
                    conn.execute(
                        &format!(
                            "UPDATE batches SET {assignments} WHERE id = ?{}",
                            values.len()
                        ),
                        params_from_iter(values),
                    )?;
                }
            }
        }
        None => {
            // First sight of this batch: its snapshot already contains the
            // post-change quantity, so do not apply the delta again.
            let columns = table_columns(conn, "batches")?;
            let fields: Vec<&String> = columns
                .iter()
                .filter(|c| payload.get(c.as_str()).is_some())
                .collect();
            if fields.is_empty() {
                return Ok(false);
            }
            let column_list = fields
                .iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let placeholders = (1..=fields.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(", ");
            let values: Vec<rusqlite::types::Value> = fields
                .iter()
                .map(|c| json_to_sql(payload.get(c.as_str()).unwrap_or(&Value::Null)))
                .collect();
            conn.execute(
                &format!("INSERT OR REPLACE INTO batches ({column_list}) VALUES ({placeholders})"),
                params_from_iter(values),
            )?;
        }
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// LAN diagnostics server (Axum)
// ---------------------------------------------------------------------------

pub fn start_lan_server(db: Arc<Db>, port: u16) -> AppResult<Value> {
    let listener = std::net::TcpListener::bind(("0.0.0.0", port))
        .map_err(|err| AppError::new("NETWORK", format!("Cannot bind port {port}: {err}")))?;
    listener.set_nonblocking(true)?;
    let local_addr = listener.local_addr()?;

    let app = Router::new()
        .route("/health", get(lan_health))
        .route("/outbox", get(lan_outbox))
        .with_state(db);

    tauri::async_runtime::spawn(async move {
        if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
            let _ = axum::serve(listener, app).await;
        }
    });

    let ip = local_ip().unwrap_or_else(|| "127.0.0.1".to_string());
    Ok(json!({
        "port": local_addr.port(),
        "url": format!("http://{ip}:{}", local_addr.port()),
        "local_url": format!("http://127.0.0.1:{}", local_addr.port()),
    }))
}

async fn lan_health(State(db): State<Arc<Db>>) -> Json<Value> {
    let result = tokio::task::spawn_blocking(move || -> AppResult<Value> {
        let conn = db.lock()?;
        let device_id = crate::db::get_setting(&conn, "device_id")?.unwrap_or_default();
        let pending = crate::commands::scalar_i64(
            &conn,
            "SELECT COUNT(*) FROM sync_outbox WHERE pushed_at IS NULL",
            [],
        )?;
        Ok(json!({
            "status": "ok",
            "device_id": device_id,
            "pending_outbox": pending,
            "app": "saltbook",
        }))
    })
    .await;
    match result {
        Ok(Ok(value)) => Json(value),
        Ok(Err(err)) => Json(json!({ "status": "error", "message": err.message })),
        Err(err) => Json(json!({ "status": "error", "message": err.to_string() })),
    }
}

async fn lan_outbox(State(db): State<Arc<Db>>) -> Json<Value> {
    let result = tokio::task::spawn_blocking(move || -> AppResult<Value> {
        let conn = db.lock()?;
        let rows = collect_outbox(&conn)?;
        Ok(json!({ "items": rows }))
    })
    .await;
    match result {
        Ok(Ok(value)) => Json(value),
        Ok(Err(err)) => Json(json!({ "items": [], "error": err.message })),
        Err(err) => Json(json!({ "items": [], "error": err.to_string() })),
    }
}

fn local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip().to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{new_id, now_ms, Db};
    use serde_json::json;

    fn outbox_row(table: &str, id: &str, operation: &str, payload: Value) -> Value {
        json!({
            "seq_no": 1,
            "entity_table": table,
            "entity_id": id,
            "operation": operation,
            "payload_json": payload.to_string(),
            "created_at": now_ms(),
        })
    }

    #[test]
    fn upsert_applies_new_rows() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        let row = outbox_row(
            "product_groups",
            "g1",
            "UPSERT",
            json!({"id": "g1", "code": "G1", "name": "CARDIAC", "updated_at": 100, "is_deleted": 0}),
        );
        assert!(apply_delta_row(&conn, &row).unwrap());
        let name: String = conn
            .query_row("SELECT name FROM product_groups WHERE id = 'g1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "CARDIAC");

        // Older update must be ignored (LWW).
        let stale = outbox_row(
            "product_groups",
            "g1",
            "UPSERT",
            json!({"id": "g1", "code": "G1", "name": "OLD", "updated_at": 50, "is_deleted": 0}),
        );
        assert!(!apply_delta_row(&conn, &stale).unwrap());
        let name: String = conn
            .query_row("SELECT name FROM product_groups WHERE id = 'g1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "CARDIAC");
    }

    #[test]
    fn deletes_are_soft_when_the_table_supports_it() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO product_groups (id, code, name, updated_at, is_deleted) VALUES ('g1','G1','TEST',1,0)",
            [],
        )
        .unwrap();
        let row = outbox_row("product_groups", "g1", "DELETE", json!({"id": "g1"}));
        assert!(apply_delta_row(&conn, &row).unwrap());
        let deleted: i64 = conn
            .query_row("SELECT is_deleted FROM product_groups WHERE id = 'g1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(deleted, 1);
    }

    #[test]
    fn batch_stock_deltas_are_additive() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        let now = now_ms();
        conn.execute(
            "INSERT INTO product_groups (id, code, name, updated_at) VALUES ('g1','G1','G',1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO companies (id, code, name, updated_at) VALUES ('c1','C1','C',1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO products (id, pro_code, name, updated_at) VALUES ('p1',1,'P',1)",
            [],
        )
        .unwrap();
        let godown: String = conn
            .query_row("SELECT id FROM godowns WHERE code = 'MAIN'", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO batches (id, product_id, batch_no, expiry_mm_yy, expiry_sort_key, cur_qty,
                tax_stock_qty, godown_id, updated_at)
             VALUES ('b1','p1','B1','12/27',202712,100,100,?1,?2)",
            params![godown, now],
        )
        .unwrap();

        let row = outbox_row(
            "batches",
            "b1",
            "UPSERT",
            json!({
                "id": "b1", "product_id": "p1", "batch_no": "B1", "expiry_mm_yy": "12/27",
                "expiry_sort_key": 202712, "cur_qty": 90, "tax_stock_qty": 90,
                "godown_id": godown, "updated_at": now + 10,
                "__qty_delta": -10, "__tax_qty_delta": -10
            }),
        );
        assert!(apply_delta_row(&conn, &row).unwrap());
        let (cur, tax): (i64, i64) = conn
            .query_row("SELECT cur_qty, tax_stock_qty FROM batches WHERE id = 'b1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((cur, tax), (90, 90));
    }

    #[test]
    fn unknown_tables_are_ignored() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        let row = outbox_row("sqlite_master", "x", "DELETE", json!({"id": "x"}));
        assert!(!apply_delta_row(&conn, &row).unwrap());
    }

    #[test]
    fn temp_ids_are_unique() {
        assert_ne!(new_id(), new_id());
    }
}
