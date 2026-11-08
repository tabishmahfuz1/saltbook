//! Stock adjustments (breakage/expiry, godown transfer, shortage/surplus,
//! credit/debit notes) and financial vouchers (receipt, payment, contra,
//! journal, payslip).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::products::default_godown_id;
use crate::commands::{clamp_limit, query_json, query_one_json, scalar_i64};
use crate::db::{
    display_to_iso, get_setting, new_id, now_ms, today_display,
};
use crate::error::{AppError, AppResult};

pub const ADJUSTMENT_TYPES: &[(&str, &str, &str)] = &[
    ("TRANSFER_IN", "Transfer In", "IN"),
    ("TRANSFER_OUT", "Transfer Out", "OUT"),
    ("REPLACEMENT_IN", "Replacement In", "IN"),
    ("REPLACEMENT_OUT", "Replacement Out", "OUT"),
    ("SAMPLE_ISSUE", "Sample Issue", "OUT"),
    ("CREDIT_NOTE", "Credit Note", "IN"),
    ("DEBIT_NOTE", "Debit Note", "OUT"),
    ("STOCK_SHORTAGE", "Stock Shortage", "OUT"),
    ("STOCK_SURPLUS", "Stock SurPlus", "IN"),
    ("BREAKAGE_EXPIRY", "Godown -> Breakage / Expiry", "OUT"),
    ("GODOWN_TRANSFER", "Godown Transfer", "MOVE"),
];

pub const VOUCHER_TYPES: &[(&str, &str, &str)] = &[
    ("RECEIPT", "Receipts", "RCP"),
    ("PAYMENT", "Payments", "PAY"),
    ("CONTRA", "Contra", "CON"),
    ("JOURNAL", "Journal", "JRN"),
    ("PAYSLIP", "PaySlip", "PSL"),
];

fn normalize_adjustment(value: &str) -> AppResult<(&'static str, &'static str)> {
    let key = value.trim().to_ascii_uppercase().replace([' ', '-', '>'], "_");
    let key = match key.as_str() {
        "GODOWN_BREAKAGE_EXPIRY" | "BREAKAGE" | "EXPIRY" => "BREAKAGE_EXPIRY",
        "STOCK_SURPLUS" => "STOCK_SURPLUS",
        other => other,
    };
    ADJUSTMENT_TYPES
        .iter()
        .find(|(code, _, _)| *code == key)
        .map(|(code, _, direction)| (*code, *direction))
        .ok_or_else(|| AppError::validation_field("Unknown adjustment type.", "adj_type"))
}

fn voucher_prefix(kind: &str) -> AppResult<(&'static str, &'static str)> {
    let key = kind.trim().to_ascii_uppercase();
    VOUCHER_TYPES
        .iter()
        .find(|(code, _, _)| *code == key)
        .map(|(code, _, prefix)| (*code, *prefix))
        .ok_or_else(|| AppError::validation_field("Unknown voucher type.", "voucher_type"))
}

#[tauri::command]
pub fn list_adjustment_types() -> AppResult<Value> {
    Ok(json!({
        "items": ADJUSTMENT_TYPES.iter()
            .map(|(code, label, direction)| json!({"code": code, "label": label, "direction": direction}))
            .collect::<Vec<_>>()
    }))
}

#[tauri::command]
pub fn list_voucher_types() -> AppResult<Value> {
    Ok(json!({
        "items": VOUCHER_TYPES.iter()
            .map(|(code, label, prefix)| json!({"code": code, "label": label, "prefix": prefix}))
            .collect::<Vec<_>>()
    }))
}

#[derive(Debug, Clone, Deserialize)]
pub struct AdjustmentItemRequest {
    pub product_id: String,
    pub batch_id: String,
    pub qty: i64,
    #[serde(default)]
    pub rate_scaled: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AdjustmentSaveRequest {
    pub adj_type: String,
    #[serde(default)]
    pub adj_date_display: Option<String>,
    #[serde(default)]
    pub godown_id: Option<String>,
    #[serde(default)]
    pub to_godown_id: Option<String>,
    #[serde(default)]
    pub party_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    pub items: Vec<AdjustmentItemRequest>,
}

#[tauri::command]
pub fn save_adjustment(
    req: AdjustmentSaveRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    save_adjustment_internal(&mut conn, &device_id, req)
}

pub fn save_adjustment_internal(
    conn: &mut Connection,
    device_id: &str,
    req: AdjustmentSaveRequest,
) -> AppResult<Value> {
    if req.items.is_empty() {
        return Err(AppError::new(
            "EMPTY_ADJUSTMENT",
            "Add at least one batch line to this adjustment.",
        ));
    }
    let (kind, direction) = normalize_adjustment(&req.adj_type)?;
    let date_display = req
        .adj_date_display
        .clone()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(today_display);
    let date_iso = display_to_iso(&date_display)?;
    let godown_id = match req.godown_id.clone().filter(|g| !g.is_empty()) {
        Some(id) => id,
        None => default_godown_id(&conn)?,
    };
    let to_godown_id = req.to_godown_id.clone().filter(|g| !g.is_empty());
    if direction == "MOVE" {
        let Some(target) = &to_godown_id else {
            return Err(AppError::validation_field(
                "Godown Transfer needs a destination godown.",
                "to_godown_id",
            ));
        };
        if *target == godown_id {
            return Err(AppError::validation_field(
                "Source and destination godown must differ.",
                "to_godown_id",
            ));
        }
    }

    let mut lines: Vec<(String, String, String, i64, i64, i64)> = Vec::new(); // product, batch, batch_no, qty, rate, value
    for item in &req.items {
        if item.qty <= 0 {
            return Err(AppError::validation_field(
                "Adjustment quantity must be greater than zero.",
                "qty",
            ));
        }
        let batch: (String, String, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT batch_no, product_id, cur_qty, tax_stock_qty, p_rate_scaled, s_rate_scaled
                 FROM batches WHERE id = ?1 AND is_deleted = 0",
                params![item.batch_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::validation_field("Batch not found.", "batch_id"))?;
        if batch.1 != item.product_id {
            return Err(AppError::validation_field(
                "The selected batch does not belong to this product.",
                "batch_id",
            ));
        }
        if direction == "OUT" || direction == "MOVE" {
            if item.qty > batch.2 {
                return Err(AppError::validation_field(
                    format!(
                        "Batch {} has only {} unit(s); cannot adjust out {}.",
                        batch.0, batch.2, item.qty
                    ),
                    "qty",
                ));
            }
        }
        let rate = if item.rate_scaled > 0 {
            item.rate_scaled
        } else if batch.4 > 0 {
            batch.4
        } else {
            batch.5
        };
        lines.push((
            item.product_id.clone(),
            item.batch_id.clone(),
            batch.0,
            item.qty,
            rate,
            rate * item.qty,
        ));
    }
    let total_value: i64 = lines.iter().map(|line| line.5).sum();

    let tx = conn.transaction()?;
    let now = now_ms();
    let adjustment_id = new_id();
    let sequence = scalar_i64(&tx, "SELECT COUNT(*) FROM stock_adjustments", [])? + 1;
    let display = format!("ADJ-{sequence}");
    tx.execute(
        "INSERT INTO stock_adjustments (id, adj_type, adj_date_iso, adj_date_display, godown_id,
            to_godown_id, party_id, reason, total_value_scaled, updated_at, is_deleted)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0)",
        params![
            adjustment_id, kind, date_iso, date_display, godown_id, to_godown_id, req.party_id,
            req.reason, total_value, now
        ],
    )?;

    for (product_id, batch_id, batch_no, qty, rate, value) in &lines {
        let item_id = new_id();
        tx.execute(
            "INSERT INTO stock_adjustment_items (id, adjustment_id, product_id, batch_id, qty,
                rate_scaled, value_scaled, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![item_id, adjustment_id, product_id, batch_id, qty, rate, value, now],
        )?;
        if let Some(snapshot) =
            query_one_json(&tx, "SELECT * FROM stock_adjustment_items WHERE id = ?1", params![item_id])?
        {
            crate::db::outbox::push_upsert(
                &tx, &device_id, "stock_adjustment_items", &item_id, &snapshot,
            )?;
        }

        if direction == "MOVE" {
            let target = to_godown_id.as_ref().unwrap();
            let target_batch: Option<(String, i64)> = tx
                .query_row(
                    "SELECT id, cur_qty FROM batches
                     WHERE product_id = ?1 AND batch_no = ?2 AND godown_id = ?3 AND is_deleted = 0",
                    params![product_id, batch_no, target],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let target_id = match target_batch {
                Some((id, _)) => id,
                None => {
                    let clone_id = new_id();
                    tx.execute(
                        "INSERT INTO batches (id, product_id, batch_no, expiry_mm_yy, expiry_sort_key,
                            op_qty, deal_billed, deal_free, cur_qty, tax_stock_qty, mrp_scaled,
                            s_rate_scaled, t_rate_scaled, p_rate_scaled, dis_bps, net_rate_scaled,
                            godown_id, is_provisional, updated_at, is_deleted)
                         SELECT ?1, product_id, batch_no, expiry_mm_yy, expiry_sort_key, 0,
                            deal_billed, deal_free, 0, 0, mrp_scaled, s_rate_scaled, t_rate_scaled,
                            p_rate_scaled, dis_bps, net_rate_scaled, ?2, 0, ?3, 0
                         FROM batches WHERE id = ?4",
                        params![clone_id, target, now, batch_id],
                    )?;
                    clone_id
                }
            };
            tx.execute(
                "UPDATE batches SET cur_qty = cur_qty - ?1, tax_stock_qty = tax_stock_qty - ?1, updated_at = ?2 WHERE id = ?3",
                params![qty, now, batch_id],
            )?;
            tx.execute(
                "UPDATE batches SET cur_qty = cur_qty + ?1, tax_stock_qty = tax_stock_qty + ?1, updated_at = ?2 WHERE id = ?3",
                params![qty, now, target_id],
            )?;
            for (id, delta) in [(batch_id.clone(), -*qty), (target_id.clone(), *qty)] {
                if let Some(snapshot) =
                    query_one_json(&tx, "SELECT * FROM batches WHERE id = ?1", params![id])?
                {
                    crate::db::outbox::push_batch_delta(&tx, &device_id, &id, delta, delta, &snapshot)?;
                }
            }
        } else {
            let sign: i64 = if direction == "IN" { 1 } else { -1 };
            let delta = sign * qty;
            tx.execute(
                "UPDATE batches SET cur_qty = cur_qty + ?1, tax_stock_qty = tax_stock_qty + ?1,
                    updated_at = ?2 WHERE id = ?3",
                params![delta, now, batch_id],
            )?;
            if let Some(snapshot) =
                query_one_json(&tx, "SELECT * FROM batches WHERE id = ?1", params![batch_id])?
            {
                crate::db::outbox::push_batch_delta(&tx, &device_id, batch_id, delta, delta, &snapshot)?;
            }
        }
    }

    // Credit / debit notes move the party ledger.
    if let Some(party_id) = req.party_id.clone().filter(|p| !p.is_empty()) {
        let (dr, cr, balance_delta) = match kind {
            "CREDIT_NOTE" => (0, total_value, -total_value),
            "DEBIT_NOTE" => (total_value, 0, total_value),
            _ => (0, 0, 0),
        };
        if balance_delta != 0 {
            tx.execute(
                "UPDATE accounts_parties SET cur_bal_scaled = cur_bal_scaled + ?1, updated_at = ?2 WHERE id = ?3",
                params![balance_delta, now, party_id],
            )?;
            crate::db::outbox::push_table_row(&tx, device_id, "accounts_parties", &party_id)?;
            let ledger_id = new_id();
            tx.execute(
                "INSERT INTO account_ledger (id, account_id, entry_date_iso, entry_type, ref_table,
                    ref_id, ref_no, dr_scaled, cr_scaled, narration, created_at)
                 VALUES (?1,?2,?3,'ADJUSTMENT','stock_adjustments',?4,?5,?6,?7,?8,?9)",
                params![
                    ledger_id, party_id, date_iso, adjustment_id, display, dr, cr,
                    req.reason.clone().unwrap_or_else(|| kind.to_string()), now
                ],
            )?;
            crate::db::outbox::push_table_row(&tx, device_id, "account_ledger", &ledger_id)?;
        }
    }

    if let Some(snapshot) =
        query_one_json(&tx, "SELECT * FROM stock_adjustments WHERE id = ?1", params![adjustment_id])?
    {
        crate::db::outbox::push_upsert(
            &tx, &device_id, "stock_adjustments", &adjustment_id, &snapshot,
        )?;
    }
    tx.commit()?;

    Ok(json!({
        "id": adjustment_id,
        "display": display,
        "adj_type": kind,
        "total_value_scaled": total_value,
        "lines": lines.len(),
    }))
}

#[derive(Debug, Default, Deserialize)]
pub struct AdjustmentListRequest {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub adj_type: Option<String>,
}

#[tauri::command]
pub fn list_adjustments(
    req: AdjustmentListRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let limit = req.limit.map(clamp_limit).unwrap_or(40);
    let kind = req.adj_type.filter(|t| !t.is_empty());
    let items = query_json(
        &conn,
        "SELECT a.*, g.code AS godown_code, tg.code AS to_godown_code,
                p.name AS party_name,
                (SELECT COUNT(*) FROM stock_adjustment_items it WHERE it.adjustment_id = a.id) AS line_count
         FROM stock_adjustments a
         LEFT JOIN godowns g ON g.id = a.godown_id
         LEFT JOIN godowns tg ON tg.id = a.to_godown_id
         LEFT JOIN accounts_parties p ON p.id = a.party_id
         WHERE a.is_deleted = 0 AND (?1 IS NULL OR a.adj_type = ?1)
         ORDER BY a.adj_date_iso DESC, a.updated_at DESC LIMIT ?2",
        params![kind, limit],
    )?;
    Ok(json!({ "items": items }))
}

#[derive(Debug, Clone, Deserialize)]
pub struct VoucherLineRequest {
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub dr_scaled: i64,
    #[serde(default)]
    pub cr_scaled: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VoucherSaveRequest {
    pub voucher_type: String,
    #[serde(default)]
    pub voucher_date_display: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub contra_account_id: Option<String>,
    #[serde(default)]
    pub amount_scaled: i64,
    #[serde(default)]
    pub payment_mode: Option<String>,
    #[serde(default)]
    pub instrument_no: Option<String>,
    #[serde(default)]
    pub narration: Option<String>,
    #[serde(default)]
    pub lines: Vec<VoucherLineRequest>,
}

#[tauri::command]
pub fn save_voucher(
    req: VoucherSaveRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    save_voucher_internal(&mut conn, &device_id, req)
}

pub fn save_voucher_internal(
    conn: &mut Connection,
    device_id: &str,
    req: VoucherSaveRequest,
) -> AppResult<Value> {
    let (kind, prefix) = voucher_prefix(&req.voucher_type)?;
    let date_display = req
        .voucher_date_display
        .clone()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(today_display);
    let date_iso = display_to_iso(&date_display)?;

    // Build debit/credit lines.
    let mut lines: Vec<(Option<String>, i64, i64)> = Vec::new();
    if kind == "JOURNAL" {
        if req.lines.is_empty() {
            return Err(AppError::validation_field(
                "A journal needs at least two lines.",
                "lines",
            ));
        }
        let mut dr = 0i64;
        let mut cr = 0i64;
        for line in &req.lines {
            if line.dr_scaled < 0 || line.cr_scaled < 0 {
                return Err(AppError::validation_field(
                    "Debit and credit amounts cannot be negative.",
                    "lines",
                ));
            }
            if line.dr_scaled > 0 && line.cr_scaled > 0 {
                return Err(AppError::validation_field(
                    "A journal line is either a debit or a credit, not both.",
                    "lines",
                ));
            }
            dr += line.dr_scaled;
            cr += line.cr_scaled;
            lines.push((line.account_id.clone(), line.dr_scaled, line.cr_scaled));
        }
        if dr != cr || dr == 0 {
            return Err(AppError::validation_field(
                format!(
                    "Journal is not balanced: debits {} vs credits {}.",
                    crate::services::calc_engine::format_money(dr),
                    crate::services::calc_engine::format_money(cr)
                ),
                "lines",
            ));
        }
    } else {
        if req.amount_scaled <= 0 {
            return Err(AppError::validation_field(
                "Amount must be greater than zero.",
                "amount_scaled",
            ));
        }
        let party = req.account_id.clone().filter(|a| !a.is_empty());
        match kind {
            "RECEIPT" => {
                lines.push((party.clone(), 0, req.amount_scaled));
                if let Some(contra) = req.contra_account_id.clone().filter(|a| !a.is_empty()) {
                    lines.push((Some(contra), req.amount_scaled, 0));
                }
            }
            "PAYMENT" => {
                lines.push((party.clone(), req.amount_scaled, 0));
                if let Some(contra) = req.contra_account_id.clone().filter(|a| !a.is_empty()) {
                    lines.push((Some(contra), 0, req.amount_scaled));
                }
            }
            "CONTRA" => {
                lines.push((req.contra_account_id.clone(), req.amount_scaled, 0));
                lines.push((party.clone(), 0, req.amount_scaled));
            }
            "PAYSLIP" => {
                lines.push((party.clone(), req.amount_scaled, 0));
                if let Some(contra) = req.contra_account_id.clone().filter(|a| !a.is_empty()) {
                    lines.push((Some(contra), 0, req.amount_scaled));
                }
            }
            _ => {}
        }
    }

    let tx = conn.transaction()?;
    let now = now_ms();
    let next_no = scalar_i64(
        &tx,
        "SELECT COALESCE(MAX(voucher_no), 0) + 1 FROM vouchers WHERE voucher_type = ?1",
        params![kind],
    )?;
    let display = format!("{prefix}-{next_no}");
    let voucher_id = new_id();
    let total_amount: i64 = if kind == "JOURNAL" {
        req.lines.iter().map(|l| l.dr_scaled).sum()
    } else {
        req.amount_scaled
    };

    tx.execute(
        "INSERT INTO vouchers (id, voucher_type, voucher_no, voucher_no_display, voucher_date_iso,
            voucher_date_display, account_id, contra_account_id, amount_scaled, payment_mode,
            instrument_no, narration, updated_at, is_deleted)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0)",
        params![
            voucher_id, kind, next_no, display, date_iso, date_display, req.account_id,
            req.contra_account_id, total_amount, req.payment_mode, req.instrument_no,
            req.narration, now
        ],
    )?;

    for (account_id, dr, cr) in &lines {
        let line_id = new_id();
        tx.execute(
            "INSERT INTO voucher_lines (id, voucher_id, account_id, dr_scaled, cr_scaled, narration, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![line_id, voucher_id, account_id, dr, cr, req.narration, now],
        )?;
        crate::db::outbox::push_table_row(&tx, device_id, "voucher_lines", &line_id)?;
        if let Some(account_id) = account_id {
            let exists: Option<String> = tx
                .query_row(
                    "SELECT id FROM accounts_parties WHERE id = ?1",
                    params![account_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_some() {
                tx.execute(
                    "UPDATE accounts_parties SET cur_bal_scaled = cur_bal_scaled + ?1, updated_at = ?2 WHERE id = ?3",
                    params![dr - cr, now, account_id],
                )?;
                crate::db::outbox::push_table_row(&tx, device_id, "accounts_parties", account_id)?;
                let ledger_id = new_id();
                tx.execute(
                    "INSERT INTO account_ledger (id, account_id, entry_date_iso, entry_type, ref_table,
                        ref_id, ref_no, dr_scaled, cr_scaled, narration, created_at)
                     VALUES (?1,?2,?3,?4,'vouchers',?5,?6,?7,?8,?9,?10)",
                    params![
                        ledger_id, account_id, date_iso, kind, voucher_id, display, dr, cr,
                        req.narration.clone().unwrap_or_else(|| format!("{kind} {display}")), now
                    ],
                )?;
                crate::db::outbox::push_table_row(&tx, device_id, "account_ledger", &ledger_id)?;
            }
        }
    }

    if let Some(snapshot) =
        query_one_json(&tx, "SELECT * FROM vouchers WHERE id = ?1", params![voucher_id])?
    {
        crate::db::outbox::push_upsert(&tx, &device_id, "vouchers", &voucher_id, &snapshot)?;
    }
    tx.commit()?;
    Ok(json!({
        "id": voucher_id,
        "voucher_no_display": display,
        "voucher_type": kind,
        "amount_scaled": total_amount,
    }))
}

#[derive(Debug, Default, Deserialize)]
pub struct VoucherListRequest {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub voucher_type: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[tauri::command]
pub fn list_vouchers(
    req: VoucherListRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let limit = req.limit.map(clamp_limit).unwrap_or(40);
    let kind = req.voucher_type.filter(|t| !t.is_empty());
    let account = req.account_id.filter(|t| !t.is_empty());
    let items = query_json(
        &conn,
        "SELECT v.*, COALESCE(a.name, 'Cash / Bank') AS account_name,
                c.name AS contra_account_name
         FROM vouchers v
         LEFT JOIN accounts_parties a ON a.id = v.account_id
         LEFT JOIN accounts_parties c ON c.id = v.contra_account_id
         WHERE v.is_deleted = 0
           AND (?1 IS NULL OR v.voucher_type = ?1)
           AND (?2 IS NULL OR v.account_id = ?2)
         ORDER BY v.voucher_date_iso DESC, v.voucher_no DESC LIMIT ?3",
        params![kind, account, limit],
    )?;
    Ok(json!({ "items": items }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn seed(db: &Db) -> (String, String, String, String) {
        let mut conn = db.lock().unwrap();
        crate::db::demo::seed_masters(&mut conn).unwrap();
        let product_id: String = conn
            .query_row("SELECT id FROM products WHERE pro_code = 415", [], |r| r.get(0))
            .unwrap();
        let batch_id: String = conn
            .query_row(
                "SELECT id FROM batches WHERE product_id = ?1 AND cur_qty > 0 LIMIT 1",
                params![product_id],
                |r| r.get(0),
            )
            .unwrap();
        let party_id: String = conn
            .query_row("SELECT id FROM accounts_parties WHERE code = 'C002'", [], |r| r.get(0))
            .unwrap();
        let device_id = crate::db::get_setting(&conn, "device_id").unwrap().unwrap();
        (product_id, batch_id, party_id, device_id)
    }

    fn adjustment(kind: &str, product_id: &str, batch_id: &str, qty: i64) -> AdjustmentSaveRequest {
        AdjustmentSaveRequest {
            adj_type: kind.into(),
            adj_date_display: None,
            godown_id: None,
            to_godown_id: None,
            party_id: None,
            reason: Some("Test adjustment".into()),
            items: vec![AdjustmentItemRequest {
                product_id: product_id.into(),
                batch_id: batch_id.into(),
                qty,
                rate_scaled: 0,
            }],
        }
    }

    #[test]
    fn breakage_writes_off_stock() {
        let db = Db::open_memory().unwrap();
        let (product_id, batch_id, _party, _device) = seed(&db);
        let conn = db.lock().unwrap();
        let before: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        drop(conn);
        let mut conn = db.lock().unwrap();
        let device_id = crate::db::get_setting(&conn, "device_id").unwrap().unwrap();
        let result = save_adjustment_internal(
            &mut conn,
            &device_id,
            adjustment("BREAKAGE_EXPIRY", &product_id, &batch_id, 3),
        )
        .unwrap();
        assert_eq!(result["adj_type"], "BREAKAGE_EXPIRY");
        let after: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        assert_eq!(after, before - 3);
    }

    #[test]
    fn stock_surplus_adds_stock_and_rejects_oversell_of_writeoffs() {
        let db = Db::open_memory().unwrap();
        let (product_id, batch_id, _party, _device) = seed(&db);
        let mut conn = db.lock().unwrap();
        let device_id = crate::db::get_setting(&conn, "device_id").unwrap().unwrap();
        let before: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        save_adjustment_internal(
            &mut conn,
            &device_id,
            adjustment("STOCK_SURPLUS", &product_id, &batch_id, 5),
        )
        .unwrap();
        let after: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        assert_eq!(after, before + 5);
        let err = save_adjustment_internal(
            &mut conn,
            &device_id,
            adjustment("SAMPLE_ISSUE", &product_id, &batch_id, after + 100),
        )
        .unwrap_err();
        assert_eq!(err.code, "VALIDATION");
    }

    #[test]
    fn godown_transfer_moves_stock_between_batches() {
        let db = Db::open_memory().unwrap();
        let (product_id, batch_id, _party, _device) = seed(&db);
        let mut conn = db.lock().unwrap();
        let device_id = crate::db::get_setting(&conn, "device_id").unwrap().unwrap();
        let now = now_ms();
        conn.execute(
            "INSERT INTO godowns (id, code, name, is_default, updated_at) VALUES ('g2','SECOND','Second Godown',0,?1)",
            params![now],
        )
        .unwrap();
        let before: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        let mut req = adjustment("GODOWN_TRANSFER", &product_id, &batch_id, 4);
        req.to_godown_id = Some("g2".into());
        save_adjustment_internal(&mut conn, &device_id, req).unwrap();
        let source_after: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        let target_qty: i64 = conn
            .query_row(
                "SELECT cur_qty FROM batches WHERE product_id = ?1 AND godown_id = 'g2'",
                params![product_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(source_after, before - 4);
        assert_eq!(target_qty, 4);
    }

    #[test]
    fn receipt_reduces_party_outstanding_and_journal_must_balance() {
        let db = Db::open_memory().unwrap();
        let (_product, _batch, party_id, _device) = seed(&db);
        let mut conn = db.lock().unwrap();
        let device_id = crate::db::get_setting(&conn, "device_id").unwrap().unwrap();
        let before: i64 = conn
            .query_row("SELECT cur_bal_scaled FROM accounts_parties WHERE id = ?1", params![party_id], |r| r.get(0))
            .unwrap();
        let result = save_voucher_internal(
            &mut conn,
            &device_id,
            VoucherSaveRequest {
                voucher_type: "RECEIPT".into(),
                voucher_date_display: None,
                account_id: Some(party_id.clone()),
                contra_account_id: None,
                amount_scaled: 500_000,
                payment_mode: Some("CASH".into()),
                instrument_no: None,
                narration: Some("Part payment".into()),
                lines: vec![],
            },
        )
        .unwrap();
        assert_eq!(result["voucher_no_display"], "RCP-1");
        let after: i64 = conn
            .query_row("SELECT cur_bal_scaled FROM accounts_parties WHERE id = ?1", params![party_id], |r| r.get(0))
            .unwrap();
        assert_eq!(after, before - 500_000);

        let err = save_voucher_internal(
            &mut conn,
            &device_id,
            VoucherSaveRequest {
                voucher_type: "JOURNAL".into(),
                voucher_date_display: None,
                account_id: None,
                contra_account_id: None,
                amount_scaled: 0,
                payment_mode: None,
                instrument_no: None,
                narration: None,
                lines: vec![
                    VoucherLineRequest { account_id: Some(party_id.clone()), dr_scaled: 100, cr_scaled: 0 },
                    VoucherLineRequest { account_id: None, dr_scaled: 0, cr_scaled: 90 },
                ],
            },
        )
        .unwrap_err();
        assert!(err.message.contains("not balanced"));
    }
}
