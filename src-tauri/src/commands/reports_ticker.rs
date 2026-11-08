//! Reporting: near-expiry ticker, stock/composition queries, sales summary,
//! ledger statements and the status-bar window summary.

use chrono::{Datelike, NaiveDate};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::{clamp_limit, query_json, query_one_json, scalar_i64};
use crate::db::{current_expiry_key, expiry_display_from_key};
use crate::error::AppResult;

fn add_months(key: i64, months: i64) -> i64 {
    let year = key / 100;
    let month = key % 100;
    let total = year * 12 + (month - 1) + months;
    total.div_euclid(12) * 100 + total.rem_euclid(12) + 1
}

fn expiry_end_date(key: i64) -> Option<NaiveDate> {
    let year = (key / 100) as i32;
    let month = (key % 100) as u32;
    if !(1..=12).contains(&month) {
        return None;
    }
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)?.pred_opt()
}

fn days_to_expiry(key: i64) -> i64 {
    expiry_end_date(key)
        .map(|end| (end - chrono::Local::now().date_naive()).num_days())
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
pub struct TickerRequest {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default = "default_months")]
    pub months_ahead: i64,
}

fn default_months() -> i64 {
    3
}

#[tauri::command]
pub fn get_ticker_alerts(
    req: TickerRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let limit = req.limit.map(clamp_limit).unwrap_or(80);
    let threshold = add_months(current_expiry_key(), req.months_ahead.clamp(0, 24));
    let mut items = query_json(
        &conn,
        "SELECT b.id AS batch_id, b.product_id, b.batch_no, b.expiry_mm_yy, b.expiry_sort_key,
                b.cur_qty, b.tax_stock_qty, b.mrp_scaled, b.s_rate_scaled, b.p_rate_scaled,
                b.is_provisional, g.code AS godown_code, g.name AS godown_name,
                p.name AS product_name, p.pro_code, p.pack_form
         FROM batches b
         JOIN products p ON p.id = b.product_id
         JOIN godowns g ON g.id = b.godown_id
         WHERE b.is_deleted = 0 AND p.is_deleted = 0
           AND ((b.expiry_sort_key <= ?1 AND b.cur_qty > 0) OR b.cur_qty < 0)
         ORDER BY (b.cur_qty < 0) DESC, b.expiry_sort_key ASC
         LIMIT ?2",
        params![threshold, limit],
    )?;

    for item in items.iter_mut() {
        let expiry = item
            .get("expiry_sort_key")
            .and_then(|v| v.as_i64())
            .unwrap_or_default();
        let qty = item.get("cur_qty").and_then(|v| v.as_i64()).unwrap_or_default();
        let days = days_to_expiry(expiry);
        let severity = if qty < 0 {
            "NEGATIVE"
        } else if days < 0 {
            "EXPIRED"
        } else if days <= 30 {
            "CRITICAL"
        } else if days <= 90 {
            "WARNING"
        } else {
            "INFO"
        };
        let product_name = item
            .get("product_name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let label = if qty < 0 {
            format!("NEGATIVE STOCK {qty} @ {product_name}")
        } else if days < 0 {
            format!("EXPIRED {} {product_name}", expiry_display_from_key(expiry))
        } else {
            format!("{product_name} {} ({days}d)", expiry_display_from_key(expiry))
        };
        if let Some(object) = item.as_object_mut() {
            object.insert("days_to_expiry".into(), json!(days));
            object.insert("severity".into(), json!(severity));
            object.insert("expiry_display".into(), json!(expiry_display_from_key(expiry)));
            object.insert("label".into(), json!(label));
        }
    }
    Ok(json!({ "items": items, "threshold_expiry_key": threshold }))
}

#[derive(Debug, Default, Deserialize)]
pub struct StockQueryRequest {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub godown_id: Option<String>,
    #[serde(default)]
    pub only_in_stock: Option<bool>,
    #[serde(default)]
    pub expiry_within_months: Option<i64>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[tauri::command]
pub fn stock_query(
    req: StockQueryRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let limit = req.limit.map(clamp_limit).unwrap_or(200);
    let query = req.query.unwrap_or_default().trim().to_string();
    let like = format!("%{}%", query.replace('%', "").replace('_', ""));
    let godown = req.godown_id.filter(|g| !g.is_empty());
    let only_in_stock = req.only_in_stock.unwrap_or(true) as i64;
    let expiry_threshold = match req.expiry_within_months {
        Some(months) if months > 0 => add_months(current_expiry_key(), months),
        _ => 0,
    };

    const FILTERS: &str = " b.is_deleted = 0 AND p.is_deleted = 0
        AND (?1 = '' OR p.name LIKE ?2 OR b.batch_no LIKE ?2 OR CAST(p.pro_code AS TEXT) LIKE ?2)
        AND (?3 IS NULL OR b.godown_id = ?3)
        AND (?4 = 0 OR b.cur_qty > 0)
        AND (?5 = 0 OR (b.expiry_sort_key <= ?5 AND b.cur_qty > 0))";

    let items = query_json(
        &conn,
        &format!(
            "SELECT b.id AS batch_id, b.product_id, b.batch_no, b.expiry_mm_yy, b.expiry_sort_key,
                    b.cur_qty, b.tax_stock_qty, b.op_qty, b.mrp_scaled, b.s_rate_scaled,
                    b.t_rate_scaled, b.p_rate_scaled, b.dis_bps, b.net_rate_scaled,
                    b.is_provisional, (b.cur_qty * b.p_rate_scaled) AS stock_value_scaled,
                    g.code AS godown_code, p.name AS product_name, p.pro_code, p.pack_form,
                    COALESCE(c.name, '') AS company_name
             FROM batches b
             JOIN products p ON p.id = b.product_id
             JOIN godowns g ON g.id = b.godown_id
             LEFT JOIN companies c ON c.id = p.company_id
             WHERE {FILTERS}
             ORDER BY p.name ASC, b.expiry_sort_key ASC
             LIMIT ?6"
        ),
        params![query, like, godown, only_in_stock, expiry_threshold, limit],
    )?;

    let totals = query_one_json(
        &conn,
        &format!(
            "SELECT COUNT(*) AS batch_count,
                    COALESCE(SUM(b.cur_qty), 0) AS total_units,
                    COALESCE(SUM(b.tax_stock_qty), 0) AS total_tax_units,
                    COALESCE(SUM(b.cur_qty * b.p_rate_scaled), 0) AS total_value_scaled,
                    COALESCE(SUM(CASE WHEN b.cur_qty < 0 THEN 1 ELSE 0 END), 0) AS negative_batches,
                    COALESCE(SUM(CASE WHEN b.expiry_sort_key <= ?5 AND b.cur_qty > 0 THEN 1 ELSE 0 END), 0) AS expiring_batches
             FROM batches b
             JOIN products p ON p.id = b.product_id
             LEFT JOIN companies c ON c.id = p.company_id
             WHERE {FILTERS}"
        ),
        params![query, like, godown, only_in_stock, expiry_threshold],
    )?
    .unwrap_or_else(|| json!({}));

    Ok(json!({ "items": items, "totals": totals }))
}

#[derive(Debug, Default, Deserialize)]
pub struct CompositionQueryRequest {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[tauri::command]
pub fn composition_query(
    req: CompositionQueryRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let limit = req.limit.map(clamp_limit).unwrap_or(100);
    let query = req.query.unwrap_or_default().trim().to_string();
    let like = format!("%{}%", query.replace('%', "").replace('_', ""));
    let items = query_json(
        &conn,
        "SELECT p.id, p.pro_code, p.name, p.pack_form, p.pack_unit, p.pack_subunit,
                COALESCE(cp.description, '(No composition)') AS composition_desc,
                COALESCE(c.name, '') AS company_name,
                COALESCE((SELECT SUM(b.cur_qty) FROM batches b
                          WHERE b.product_id = p.id AND b.is_deleted = 0), 0) AS cur_qty,
                COALESCE((SELECT MAX(b.s_rate_scaled) FROM batches b
                          WHERE b.product_id = p.id AND b.is_deleted = 0), 0) AS s_rate_scaled,
                COALESCE((SELECT MAX(b.mrp_scaled) FROM batches b
                          WHERE b.product_id = p.id AND b.is_deleted = 0), 0) AS mrp_scaled,
                (SELECT MIN(b.expiry_sort_key) FROM batches b
                 WHERE b.product_id = p.id AND b.cur_qty > 0 AND b.is_deleted = 0) AS nearest_expiry
         FROM products p
         LEFT JOIN compositions cp ON cp.id = p.composition_id
         LEFT JOIN companies c ON c.id = p.company_id
         WHERE p.is_deleted = 0
           AND (?1 = '' OR p.name LIKE ?2 OR cp.description LIKE ?2 OR c.name LIKE ?2)
         ORDER BY cp.description ASC, p.name ASC
         LIMIT ?3",
        params![query, like, limit],
    )?;
    Ok(json!({ "items": items }))
}

#[derive(Debug, Default, Deserialize)]
pub struct SalesReportRequest {
    #[serde(default)]
    pub from_iso: Option<String>,
    #[serde(default)]
    pub to_iso: Option<String>,
    #[serde(default)]
    pub series_code: Option<String>,
}

#[tauri::command]
pub fn sales_report(
    req: SalesReportRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let from = req.from_iso.filter(|s| !s.is_empty());
    let to = req.to_iso.filter(|s| !s.is_empty());
    let series = req.series_code.filter(|s| !s.is_empty());
    const FILTERS: &str = " i.is_deleted = 0
        AND NOT (i.series_code = 'E' AND i.converted_to_tax_inv_id IS NOT NULL)
        AND (?1 IS NULL OR i.inv_date_iso >= ?1)
        AND (?2 IS NULL OR i.inv_date_iso <= ?2)
        AND (?3 IS NULL OR i.series_code = ?3)";

    let daily = query_json(
        &conn,
        &format!(
            "SELECT i.inv_date_iso, i.inv_date_display, i.series_code, COUNT(*) AS bill_count,
                    COALESCE(SUM(i.gross_total_scaled),0) AS gross_scaled,
                    COALESCE(SUM(i.dis_amt_scaled),0) AS discount_scaled,
                    COALESCE(SUM(i.tax_amt_scaled),0) AS tax_scaled,
                    COALESCE(SUM(i.grand_total_scaled),0) AS total_scaled
             FROM sales_invoices i WHERE {FILTERS}
             GROUP BY i.inv_date_iso, i.series_code
             ORDER BY i.inv_date_iso DESC, i.series_code ASC"
        ),
        params![from, to, series],
    )?;
    let by_series = query_json(
        &conn,
        &format!(
            "SELECT i.series_code, COUNT(*) AS bill_count,
                    COALESCE(SUM(i.grand_total_scaled),0) AS total_scaled
             FROM sales_invoices i WHERE {FILTERS}
             GROUP BY i.series_code"
        ),
        params![from, to, series],
    )?;
    let top_products = query_json(
        &conn,
        &format!(
            "SELECT p.name AS product_name, p.pro_code, SUM(it.billed_qty) AS qty,
                    COALESCE(SUM(it.line_amount_scaled),0) AS amount_scaled
             FROM sales_invoice_items it
             JOIN sales_invoices i ON i.id = it.invoice_id
             JOIN products p ON p.id = it.product_id
             WHERE {FILTERS}
             GROUP BY p.id
             ORDER BY amount_scaled DESC
             LIMIT 12"
        ),
        params![from, to, series],
    )?;
    let totals = query_one_json(
        &conn,
        &format!(
            "SELECT COUNT(*) AS bill_count,
                    COALESCE(SUM(i.grand_total_scaled),0) AS total_scaled,
                    COALESCE(SUM(i.tax_amt_scaled),0) AS tax_scaled,
                    COALESCE(SUM(i.dis_amt_scaled),0) AS discount_scaled,
                    COALESCE(SUM(i.due_amt_scaled),0) AS due_scaled
             FROM sales_invoices i WHERE {FILTERS}"
        ),
        params![from, to, series],
    )?
    .unwrap_or_else(|| json!({}));

    Ok(json!({
        "daily": daily,
        "by_series": by_series,
        "top_products": top_products,
        "totals": totals,
    }))
}

#[derive(Debug, Deserialize)]
pub struct LedgerRequest {
    pub account_id: String,
    #[serde(default)]
    pub from_iso: Option<String>,
    #[serde(default)]
    pub to_iso: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[tauri::command]
pub fn ledger_report(
    req: LedgerRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let limit = req.limit.map(clamp_limit).unwrap_or(500);
    let from = req.from_iso.clone().filter(|s| !s.is_empty());
    let to = req.to_iso.filter(|s| !s.is_empty());
    let account = query_one_json(
        &conn,
        "SELECT id, code, name, account_type, cur_bal_scaled, op_bal_dr_scaled, op_bal_cr_scaled
         FROM accounts_parties WHERE id = ?1",
        params![req.account_id],
    )?
    .unwrap_or_else(|| json!({}));

    let ledger_count: i64 = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM account_ledger WHERE account_id = ?1",
        params![req.account_id],
    )?;
    let opening = if ledger_count == 0 {
        account["op_bal_dr_scaled"].as_i64().unwrap_or(0)
            - account["op_bal_cr_scaled"].as_i64().unwrap_or(0)
    } else if let Some(from) = &from {
        scalar_i64(
            &conn,
            "SELECT COALESCE(SUM(dr_scaled - cr_scaled),0) FROM account_ledger
             WHERE account_id = ?1 AND entry_date_iso < ?2",
            params![req.account_id, from],
        )?
    } else {
        0
    };

    let entries = query_json(
        &conn,
        "SELECT entry_date_iso, entry_type, ref_no, dr_scaled, cr_scaled, narration, created_at
         FROM account_ledger
         WHERE account_id = ?1
           AND (?2 IS NULL OR entry_date_iso >= ?2)
           AND (?3 IS NULL OR entry_date_iso <= ?3)
         ORDER BY entry_date_iso ASC, created_at ASC
         LIMIT ?4",
        params![req.account_id, from, to, limit],
    )?;
    let movement: i64 = entries
        .iter()
        .map(|e| e["dr_scaled"].as_i64().unwrap_or(0) - e["cr_scaled"].as_i64().unwrap_or(0))
        .sum();
    let closing = opening + movement;

    Ok(json!({
        "account": account,
        "opening_scaled": opening,
        "closing_scaled": closing,
        "entries": entries,
    }))
}

#[tauri::command]
pub fn window_summary(state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let expiring_threshold = add_months(current_expiry_key(), 3);
    let summary = query_one_json(
        &conn,
        "SELECT
            (SELECT COUNT(*) FROM products WHERE is_deleted = 0) AS products,
            (SELECT COUNT(*) FROM accounts_parties WHERE account_type = 'PARTY' AND is_deleted = 0) AS parties,
            (SELECT COUNT(*) FROM accounts_parties WHERE account_type = 'SUPPLIER' AND is_deleted = 0) AS suppliers,
            (SELECT COALESCE(SUM(grand_total_scaled), 0) FROM sales_invoices
              WHERE is_deleted = 0
                AND NOT (series_code = 'E' AND converted_to_tax_inv_id IS NOT NULL)
                AND inv_date_iso = date('now', 'localtime')) AS today_sales_scaled,
            (SELECT COALESCE(SUM(grand_total_scaled), 0) FROM sales_invoices
              WHERE is_deleted = 0
                AND NOT (series_code = 'E' AND converted_to_tax_inv_id IS NOT NULL)
                AND strftime('%Y-%m', inv_date_iso) = strftime('%Y-%m', 'now', 'localtime')) AS month_sales_scaled,
            (SELECT COUNT(*) FROM products p WHERE p.is_deleted = 0 AND p.min_qty > 0
              AND COALESCE((SELECT SUM(b.cur_qty) FROM batches b
                            WHERE b.product_id = p.id AND b.is_deleted = 0), 0) <= p.min_qty) AS low_stock,
            (SELECT COUNT(*) FROM batches b WHERE b.is_deleted = 0 AND b.cur_qty > 0
              AND b.expiry_sort_key <= ?1) AS expiring,
            (SELECT COUNT(*) FROM batches b WHERE b.is_deleted = 0 AND b.cur_qty < 0) AS negative_stock,
            (SELECT COUNT(*) FROM sales_invoices WHERE is_deleted = 0 AND due_amt_scaled > 0) AS open_bills,
            (SELECT COALESCE(SUM(due_amt_scaled), 0) FROM sales_invoices
              WHERE is_deleted = 0 AND due_amt_scaled > 0) AS receivables_scaled,
            (SELECT COUNT(*) FROM sync_outbox WHERE pushed_at IS NULL) AS pending_outbox,
            (SELECT COUNT(*) FROM sales_invoices
              WHERE is_deleted = 0
                AND NOT (series_code = 'E' AND converted_to_tax_inv_id IS NOT NULL)) AS invoices",
        params![expiring_threshold],
    )?
    .unwrap_or_else(|| json!({}));
    Ok(summary)
}

#[derive(Debug, Deserialize)]
pub struct BatchHistoryRequest {
    pub batch_id: String,
}

#[tauri::command]
pub fn batch_movement_history(
    req: BatchHistoryRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let items = query_json(
        &conn,
        "SELECT 'SALE' AS movement_type, i.inv_no_display AS reference, i.inv_date_display AS date_display,
                -(it.billed_qty + it.free_deal_qty) AS qty, i.party_name_snapshot AS party
         FROM sales_invoice_items it JOIN sales_invoices i ON i.id = it.invoice_id
         WHERE it.batch_id = ?1 AND i.is_deleted = 0
         UNION ALL
         SELECT 'PURCHASE', p.sup_inv_no, p.inv_date_display, ii.billed_qty + ii.free_deal_qty,
                p.supplier_name_snapshot
         FROM purchase_invoice_items ii JOIN purchase_invoices p ON p.id = ii.purchase_id
         WHERE ii.batch_id = ?1 AND p.is_deleted = 0
         ORDER BY date_display DESC LIMIT 100",
        params![req.batch_id],
    )?;
    Ok(json!({ "items": items }))
}

/// Helper used by the ticker to label the current month.
pub fn current_month_label() -> String {
    let now = chrono::Local::now();
    format!("{:02}/{:02}", now.month(), now.year() % 100)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn near_expiry_days_are_computed() {
        let key = current_expiry_key();
        let days = days_to_expiry(key);
        assert!(days >= 0 && days <= 62, "current month end should be near, got {days}");
        assert!(days_to_expiry(202001) < 0);
    }

    #[test]
    fn month_labels_round_trip() {
        let label = current_month_label();
        assert_eq!(label.len(), 5);
        assert_eq!(&label[2..3], "/");
    }

    #[test]
    fn demo_stock_query_returns_totals() {
        let db = Db::open_memory().unwrap();
        let mut conn = db.lock().unwrap();
        crate::db::demo::seed_masters(&mut conn).unwrap();
        drop(conn);
        let conn = db.lock().unwrap();
        let threshold = add_months(current_expiry_key(), 3);
        let negative = scalar_i64(
            &conn,
            "SELECT COUNT(*) FROM batches WHERE cur_qty < 0",
            [],
        )
        .unwrap();
        assert!(negative >= 1, "demo data should include a negative batch");
        let expiring = scalar_i64(
            &conn,
            "SELECT COUNT(*) FROM batches b WHERE b.cur_qty > 0 AND b.expiry_sort_key <= ?1",
            params![threshold],
        )
        .unwrap();
        assert!(expiring >= 1, "demo data should include near-expiry stock");
        let value = scalar_i64(
            &conn,
            "SELECT COALESCE(SUM(cur_qty * p_rate_scaled / 10000),0) FROM batches",
            [],
        )
        .unwrap();
        assert!(value > 0);
    }
}
