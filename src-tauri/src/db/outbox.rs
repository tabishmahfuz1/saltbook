//! Append-only change log for Google Drive / LAN delta sync.
//!
//! Every business mutation writes one row here inside the same SQLite
//! transaction (Guardrail 6). Batch quantity changes travel as additive deltas
//! (`__qty_delta`, `__tax_qty_delta`) so concurrent offline sales on two PCs
//! both land, while batch metadata is last-write-wins.

use rusqlite::{params, Transaction};
use serde::Serialize;

use crate::db::now_ms;
use crate::error::AppResult;

pub fn push(
    tx: &Transaction,
    device_id: &str,
    entity_table: &str,
    entity_id: &str,
    operation: &str,
    payload: &serde_json::Value,
) -> AppResult<()> {
    tx.execute(
        "INSERT INTO sync_outbox (device_id, entity_table, entity_id, operation, payload_json, created_at, pushed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
        params![
            device_id,
            entity_table,
            entity_id,
            operation,
            serde_json::to_string(payload)?,
            now_ms()
        ],
    )?;
    Ok(())
}

pub fn push_upsert<T: Serialize>(
    tx: &Transaction,
    device_id: &str,
    entity_table: &str,
    entity_id: &str,
    value: &T,
) -> AppResult<()> {
    let payload = serde_json::to_value(value)?;
    push(tx, device_id, entity_table, entity_id, "UPSERT", &payload)
}

/// Queue a full row snapshot for any table (used after balance/ledger writes).
pub fn push_table_row(
    tx: &Transaction,
    device_id: &str,
    entity_table: &str,
    entity_id: &str,
) -> AppResult<()> {
    let snapshot = crate::commands::query_one_json(
        tx,
        &format!("SELECT * FROM {entity_table} WHERE id = ?1"),
        params![entity_id],
    )?;
    if let Some(snapshot) = snapshot {
        push_upsert(tx, device_id, entity_table, entity_id, &snapshot)?;
    }
    Ok(())
}

pub fn push_delete(
    tx: &Transaction,
    device_id: &str,
    entity_table: &str,
    entity_id: &str,
) -> AppResult<()> {
    push(
        tx,
        device_id,
        entity_table,
        entity_id,
        "DELETE",
        &serde_json::json!({ "id": entity_id }),
    )
}

/// Record an additive stock movement for a batch.
pub fn push_batch_delta(
    tx: &Transaction,
    device_id: &str,
    batch_id: &str,
    cur_qty_delta: i64,
    tax_qty_delta: i64,
    snapshot: &serde_json::Value,
) -> AppResult<()> {
    let mut payload = snapshot.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("__qty_delta".into(), serde_json::json!(cur_qty_delta));
        obj.insert("__tax_qty_delta".into(), serde_json::json!(tax_qty_delta));
    }
    push(tx, device_id, "batches", batch_id, "UPSERT", &payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn writes_outbox_rows_inside_a_transaction() {
        let db = Db::open_memory().unwrap();
        let mut conn = db.lock().unwrap();
        let tx = conn.transaction().unwrap();
        push_upsert(&tx, "dev-1", "products", "p1", &serde_json::json!({"id":"p1"})).unwrap();
        push_delete(&tx, "dev-1", "products", "p2").unwrap();
        push_batch_delta(&tx, "dev-1", "b1", -10, 0, &serde_json::json!({"id":"b1"})).unwrap();
        tx.commit().unwrap();

        let mut stmt = conn
            .prepare("SELECT entity_table, operation, payload_json FROM sync_outbox ORDER BY seq_no")
            .unwrap();
        let rows: Vec<(String, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].1, "UPSERT");
        assert_eq!(rows[1].1, "DELETE");
        assert!(rows[2].2.contains("__qty_delta"));
    }
}
