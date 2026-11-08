//! Sales & estimate billing: FEFO deduction, GST math, editing, estimate→GST
//! conversion, printing payloads and substitute lookup.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::parties_suppliers::{
    account_credit_check_excluding, account_detail_json,
};
use crate::commands::{clamp_limit, query_json, query_one_json, scalar_i64};
use crate::db::{
    display_to_iso, expiry_display_from_key, get_setting, new_id, now_ms, today_display, today_iso,
};
use crate::error::{AppError, AppResult};
use crate::services::print_spooler::PrintDoc;
use crate::services::calc_engine::{
    format_money, invoice_totals, line_totals, LineInput, LineTotals,
};

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct InvoiceItemRequest {
    pub product_id: String,
    pub batch_id: String,
    #[serde(default)]
    pub loose_or_box: Option<String>,
    pub billed_qty: i64,
    #[serde(default)]
    pub free_deal_qty: i64,
    #[serde(default)]
    pub deal_str: Option<String>,
    #[serde(default)]
    pub tax_inclusive: bool,
    #[serde(default)]
    pub mrp_scaled: i64,
    pub rate_scaled: i64,
    #[serde(default)]
    pub dis_bps: i64,
    #[serde(default)]
    pub tax_bps: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InvoiceSaveRequest {
    #[serde(default)]
    pub invoice_id: Option<String>,
    #[serde(default = "estimate_series")]
    pub series_code: String,
    #[serde(default)]
    pub inv_date_display: Option<String>,
    #[serde(default = "cash_mode")]
    pub payment_mode: String,
    #[serde(default)]
    pub party_id: String,
    #[serde(default)]
    pub salesman_name: Option<String>,
    #[serde(default)]
    pub remarks: Option<String>,
    #[serde(default)]
    pub is_sale_return: bool,
    #[serde(default)]
    pub freight_scaled: i64,
    #[serde(default)]
    pub oth_adj_scaled: i64,
    #[serde(default)]
    pub reclaimed_scaled: i64,
    #[serde(default)]
    pub paid_amt_scaled: i64,
    #[serde(default)]
    pub override_credit_lock: bool,
    pub items: Vec<InvoiceItemRequest>,
}

fn estimate_series() -> String {
    "E".to_string()
}
fn cash_mode() -> String {
    "CASH".to_string()
}

#[derive(Debug, Deserialize)]
pub struct NextInvoiceRequest {
    pub series_code: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct InvoiceListRequest {
    #[serde(default)]
    pub from_iso: Option<String>,
    #[serde(default)]
    pub to_iso: Option<String>,
    #[serde(default)]
    pub series_code: Option<String>,
    #[serde(default)]
    pub payment_mode: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct InvoiceIdRequest {
    pub invoice_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ConvertRequest {
    pub invoice_ids: Vec<String>,
    #[serde(default)]
    pub inv_date_display: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct FefoRequest {
    pub product_id: String,
    #[serde(default)]
    pub include_empty: bool,
    #[serde(default)]
    pub godown_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SubstituteRequest {
    pub product_id: String,
    #[serde(default = "default_substitutes")]
    pub limit: usize,
}

fn default_substitutes() -> usize {
    12
}

#[derive(Debug, Deserialize)]
pub struct ProvisionalBatchRequest {
    pub product_id: String,
    pub batch_no: String,
    pub expiry_mm_yy: String,
    #[serde(default)]
    pub mrp_scaled: i64,
    pub rate_scaled: i64,
    #[serde(default)]
    pub qty: Option<i64>,
    #[serde(default)]
    pub godown_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PrintRequest {
    pub invoice_id: String,
    #[serde(default)]
    pub printer: Option<String>,
    #[serde(default)]
    pub dest_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Internal models
// ---------------------------------------------------------------------------

struct Series {
    id: String,
    code: String,
    is_estimate: bool,
    next_inv_no: i64,
}

#[derive(Debug, Clone)]
struct PartySnapshot {
    id: String,
    name: String,
    city: Option<String>,
    is_inter_state: bool,
}

struct ExistingInvoice {
    id: String,
    series_code: String,
    inv_no: i64,
    inv_no_display: String,
    is_estimate: bool,
    payment_mode: String,
    due_amt_scaled: i64,
    is_sale_return: bool,
}

struct ResolvedItem {
    product_id: String,
    batch_id: String,
    loose_or_box: String,
    billed_qty: i64,
    free_deal_qty: i64,
    deal_str: Option<String>,
    tax_inclusive: bool,
    mrp_scaled: i64,
    rate_scaled: i64,
    dis_bps: i64,
    tax_bps: i64,
    totals: LineTotals,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn next_invoice_no(
    req: NextInvoiceRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let series = load_series(&conn, &req.series_code)?;
    let display = invoice_display(&series.code, series.next_inv_no);
    Ok(json!({
        "series_code": series.code,
        "is_estimate": series.is_estimate,
        "inv_no": series.next_inv_no,
        "inv_no_display": display,
        "inv_date_display": today_display(),
        "inv_date_iso": today_iso(),
    }))
}

#[tauri::command]
pub fn save_invoice(
    req: InvoiceSaveRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let invoice_id = save_invoice_core(&mut conn, &device_id, req)?;
    invoice_detail_json(&conn, &invoice_id)
}

#[tauri::command]
pub fn get_invoice(
    req: InvoiceIdRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    invoice_detail_json(&conn, &req.invoice_id)
}

#[tauri::command]
pub fn list_invoices(
    req: InvoiceListRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let limit = req.limit.map(clamp_limit).unwrap_or(50);
    let offset = req.offset.unwrap_or(0).max(0) as i64;
    let from = req.from_iso.filter(|s| !s.is_empty());
    let to = req.to_iso.filter(|s| !s.is_empty());
    let series = req.series_code.filter(|s| !s.is_empty());
    let mode = req.payment_mode.filter(|s| !s.is_empty());
    let query = req.query.unwrap_or_default().trim().to_string();
    let like = format!("%{}%", query.replace('%', "").replace('_', ""));
    let numeric: Option<i64> = query.parse().ok();

    const WHERE: &str = " i.is_deleted = 0
        AND (?1 IS NULL OR i.inv_date_iso >= ?1)
        AND (?2 IS NULL OR i.inv_date_iso <= ?2)
        AND (?3 IS NULL OR i.series_code = ?3)
        AND (?4 IS NULL OR i.payment_mode = ?4)
        AND (?5 = '' OR i.party_name_snapshot LIKE ?6 OR i.inv_no_display LIKE ?6
             OR (?7 IS NOT NULL AND i.inv_no = ?7))";

    let total_count = scalar_i64(
        &conn,
        &format!("SELECT COUNT(*) FROM sales_invoices i WHERE {WHERE}"),
        params![from, to, series, mode, query, like, numeric],
    )?;
    let total_amount = scalar_i64(
        &conn,
        &format!("SELECT COALESCE(SUM(i.grand_total_scaled), 0) FROM sales_invoices i WHERE {WHERE}"),
        params![from, to, series, mode, query, like, numeric],
    )?;
    let total_due = scalar_i64(
        &conn,
        &format!("SELECT COALESCE(SUM(i.due_amt_scaled), 0) FROM sales_invoices i WHERE {WHERE}"),
        params![from, to, series, mode, query, like, numeric],
    )?;

    let items = query_json(
        &conn,
        &format!(
            "SELECT i.id, i.series_code, i.inv_no, i.inv_no_display, i.inv_date_iso, i.inv_date_display,
                    i.payment_mode, i.party_id, i.party_name_snapshot, i.city_snapshot,
                    i.salesman_name, i.is_sale_return, i.gross_total_scaled, i.tax_amt_scaled,
                    i.dis_amt_scaled, i.grand_total_scaled, i.paid_amt_scaled, i.due_amt_scaled,
                    i.converted_to_tax_inv_id, i.remarks, i.updated_at,
                    (SELECT COUNT(*) FROM sales_invoice_items it WHERE it.invoice_id = i.id) AS item_count
             FROM sales_invoices i
             WHERE {WHERE}
             ORDER BY i.inv_date_iso DESC, i.series_code ASC, i.inv_no DESC
             LIMIT ?8 OFFSET ?9"
        ),
        params![from, to, series, mode, query, like, numeric, limit, offset],
    )?;

    Ok(json!({
        "items": items,
        "total_count": total_count,
        "total_amount_scaled": total_amount,
        "total_due_scaled": total_due,
    }))
}

#[tauri::command]
pub fn fefo_batches(req: FefoRequest, state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let rows = query_json(
        &conn,
        "SELECT b.id, b.product_id, b.batch_no, b.expiry_mm_yy, b.expiry_sort_key, b.op_qty,
                b.cur_qty, b.tax_stock_qty, b.mrp_scaled, b.s_rate_scaled, b.t_rate_scaled,
                b.p_rate_scaled, b.dis_bps, b.net_rate_scaled, b.deal_billed, b.deal_free,
                b.is_provisional, b.godown_id, g.code AS godown_code, g.name AS godown_name,
                p.name AS product_name, p.pack_form,
                COALESCE(pm.cgst_bps + pm.sgst_bps, 0) AS tax_bps
         FROM batches b
         JOIN products p ON p.id = b.product_id
         JOIN godowns g ON g.id = b.godown_id
         LEFT JOIN tax_plans pm ON pm.id = p.sale_tax_id
         WHERE b.product_id = ?1 AND b.is_deleted = 0
           AND (?2 = 1 OR b.cur_qty > 0)
           AND (?3 IS NULL OR b.godown_id = ?3)
         ORDER BY b.expiry_sort_key ASC, b.batch_no ASC",
        params![req.product_id, req.include_empty as i64, req.godown_id],
    )?;
    let items: Vec<Value> = rows.into_iter().map(decorate_batch).collect();
    Ok(json!({ "items": items }))
}

fn decorate_batch(mut row: Value) -> Value {
    let current = crate::db::current_expiry_key();
    let expiry = row.get("expiry_sort_key").and_then(|v| v.as_i64()).unwrap_or(0);
    let billed = row.get("deal_billed").and_then(|v| v.as_i64()).unwrap_or(0);
    let free = row.get("deal_free").and_then(|v| v.as_i64()).unwrap_or(0);
    if let Some(obj) = row.as_object_mut() {
        obj.insert("is_expired".into(), json!(expiry < current));
        obj.insert("is_near_expiry".into(), json!(expiry <= add_months(current, 3)));
        obj.insert(
            "deal_str".into(),
            json!(if billed > 0 { format!("{billed}+{free}") } else { String::new() }),
        );
        obj.insert("expiry_display".into(), json!(expiry_display_from_key(expiry)));
        let qty = obj.get("cur_qty").and_then(|v| v.as_i64()).unwrap_or(0);
        obj.insert("is_negative".into(), json!(qty < 0));
    }
    row
}

fn add_months(key: i64, months: i64) -> i64 {
    let year = key / 100;
    let month = key % 100;
    let total = year * 12 + (month - 1) + months;
    total.div_euclid(12) * 100 + total.rem_euclid(12) + 1
}

#[tauri::command]
pub fn substitutes(
    req: SubstituteRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let limit = clamp_limit(req.limit);
    let items = query_json(
        &conn,
        "WITH target AS (
            SELECT composition_id FROM products WHERE id = ?1
         )
         SELECT p.id, p.pro_code, p.name, p.pack_form, p.pack_unit, p.pack_subunit,
                COALESCE(c.name, '') AS company_name,
                COALESCE(cp.description, '') AS composition_desc,
                COALESCE((SELECT SUM(b.cur_qty) FROM batches b
                          WHERE b.product_id = p.id AND b.is_deleted = 0), 0) AS cur_qty,
                COALESCE((SELECT MAX(b.s_rate_scaled) FROM batches b
                          WHERE b.product_id = p.id AND b.is_deleted = 0), 0) AS s_rate_scaled,
                COALESCE((SELECT MAX(b.net_rate_scaled) FROM batches b
                          WHERE b.product_id = p.id AND b.is_deleted = 0), 0) AS net_rate_scaled,
                COALESCE((SELECT MAX(b.mrp_scaled) FROM batches b
                          WHERE b.product_id = p.id AND b.is_deleted = 0), 0) AS mrp_scaled,
                COALESCE((SELECT MAX(b.s_rate_scaled - b.net_rate_scaled) FROM batches b
                          WHERE b.product_id = p.id AND b.is_deleted = 0), 0) AS margin_scaled,
                (SELECT MIN(b.expiry_sort_key) FROM batches b
                 WHERE b.product_id = p.id AND b.cur_qty > 0 AND b.is_deleted = 0) AS nearest_expiry
         FROM products p
         JOIN target t ON t.composition_id = p.composition_id
         LEFT JOIN companies c ON c.id = p.company_id
         LEFT JOIN compositions cp ON cp.id = p.composition_id
         WHERE p.id <> ?1 AND p.is_deleted = 0 AND p.composition_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM batches b WHERE b.product_id = p.id AND b.cur_qty > 0 AND b.is_deleted = 0)
         ORDER BY margin_scaled DESC, p.name ASC
         LIMIT ?2",
        params![req.product_id, limit],
    )?;
    Ok(json!({ "items": items }))
}

#[tauri::command]
pub fn create_provisional_batch(
    req: ProvisionalBatchRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let batch_no = req.batch_no.trim().to_uppercase();
    if batch_no.is_empty() {
        return Err(AppError::validation_field("Batch number is required.", "batch_no"));
    }
    let expiry_key = crate::db::expiry_key_from_mm_yy(&req.expiry_mm_yy)?;
    let godown_id = match req.godown_id {
        Some(id) if !id.is_empty() => id,
        _ => crate::commands::products::default_godown_id(&conn)?,
    };
    let tx = conn.transaction()?;
    let now = now_ms();
    let product_tax_bps: i64 = tx
        .query_row(
            "SELECT COALESCE(tp.cgst_bps + tp.sgst_bps, 0) FROM products p
             LEFT JOIN tax_plans tp ON tp.id = p.pur_tax_id WHERE p.id = ?1",
            params![req.product_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Product not found."))?;
    let duplicate: Option<String> = tx
        .query_row(
            "SELECT id FROM batches WHERE product_id = ?1 AND batch_no = ?2 AND godown_id = ?3",
            params![req.product_id, batch_no, godown_id],
            |r| r.get(0),
        )
        .optional()?;
    if duplicate.is_some() {
        return Err(AppError::with_field(
            "DUPLICATE",
            format!("Batch {batch_no} already exists for this product in this godown."),
            "batch_no",
        ));
    }
    let qty = req.qty.unwrap_or(0);
    let net_rate = crate::services::calc_engine::calc_net_rate(
        req.rate_scaled,
        0,
        0,
        0,
        product_tax_bps,
    );
    let id = new_id();
    tx.execute(
        "INSERT INTO batches (id, product_id, batch_no, expiry_mm_yy, expiry_sort_key, op_qty,
            deal_billed, deal_free, cur_qty, tax_stock_qty, mrp_scaled, s_rate_scaled, t_rate_scaled,
            p_rate_scaled, dis_bps, net_rate_scaled, godown_id, is_provisional, updated_at, is_deleted)
         VALUES (?1,?2,?3,?4,?5,?6,0,0,?6,0,?7,?8,?8,?9,0,?10,?11,1,?12,0)",
        params![
            id, req.product_id, batch_no, expiry_display_from_key(expiry_key), expiry_key, qty,
            req.mrp_scaled, req.rate_scaled, req.rate_scaled, net_rate, godown_id, now
        ],
    )?;
    if let Some(snapshot) = query_one_json(&tx, "SELECT * FROM batches WHERE id = ?1", params![id])? {
        crate::db::outbox::push_upsert(&tx, &device_id, "batches", &id, &snapshot)?;
    }
    tx.commit()?;
    let rows = query_json(
        &conn,
        "SELECT b.*, g.code AS godown_code, g.name AS godown_name, p.name AS product_name,
                p.pack_form, COALESCE(tp.cgst_bps + tp.sgst_bps, 0) AS tax_bps
         FROM batches b JOIN products p ON p.id = b.product_id
         JOIN godowns g ON g.id = b.godown_id
         LEFT JOIN tax_plans tp ON tp.id = p.sale_tax_id
         WHERE b.id = ?1",
        params![id],
    )?;
    let mut batch = rows.into_iter().next().ok_or_else(|| AppError::not_found("Batch not found."))?;
    batch = decorate_batch(batch);
    Ok(json!({ "batch": batch }))
}

#[tauri::command]
pub fn convert_estimates_to_tax(
    req: ConvertRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let converted = convert_estimates_core(
        &mut conn,
        &device_id,
        &req.invoice_ids,
        req.inv_date_display.as_deref(),
    )?;
    Ok(json!({ "converted": converted }))
}

#[tauri::command]
pub fn delete_invoice(
    req: InvoiceIdRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    delete_invoice_core(&mut conn, &device_id, &req.invoice_id)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn invoice_print_payload(
    req: InvoiceIdRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let doc = build_print_doc(&conn, &req.invoice_id)?;
    let text = crate::services::print_spooler::esc_p_text(&doc);
    let qr_svg = crate::services::print_spooler::qr_svg(&doc.upi_uri);
    Ok(json!({
        "text": text,
        "upi_uri": doc.upi_uri,
        "qr_svg": qr_svg,
        "title": doc.title,
        "lines": doc.lines,
        "totals": doc.totals,
    }))
}

#[tauri::command]
pub fn print_invoice(req: PrintRequest, state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let doc = build_print_doc(&conn, &req.invoice_id)?;
    let bytes = crate::services::print_spooler::esc_p_bytes(&doc, 40);
    let printer = req
        .printer
        .filter(|p| !p.trim().is_empty())
        .or_else(|| get_setting(&conn, "printer_name").ok().flatten())
        .unwrap_or_default();
    let result = crate::services::print_spooler::write_spool(&printer, &bytes)?;
    Ok(json!({ "path": result.path, "bytes": bytes.len(), "printer": result.printer }))
}

#[tauri::command]
pub fn export_invoice_pdf(
    req: PrintRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let doc = build_print_doc(&conn, &req.invoice_id)?;
    let path = crate::services::print_spooler::write_pdf(&doc, req.dest_path.as_deref())?;
    Ok(json!({ "path": path }))
}

// ---------------------------------------------------------------------------
// Core save logic
// ---------------------------------------------------------------------------

pub fn save_invoice_core(
    conn: &mut Connection,
    device_id: &str,
    req: InvoiceSaveRequest,
) -> AppResult<String> {
    if req.items.is_empty() {
        return Err(AppError::new(
            "EMPTY_INVOICE",
            "Please add at least one product line item before saving.",
        ));
    }
    let payment_mode = req.payment_mode.trim().to_ascii_uppercase();
    if payment_mode != "CASH" && payment_mode != "CREDIT" {
        return Err(AppError::validation_field(
            "Payment mode must be CASH or CREDIT.",
            "payment_mode",
        ));
    }
    let series = load_series(conn, &req.series_code)?;
    let party = load_party(conn, &req.party_id)?;

    let invoice_date_display = req
        .inv_date_display
        .clone()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(today_display);
    let invoice_date_iso = display_to_iso(&invoice_date_display)?;

    let existing = match req.invoice_id.as_deref() {
        Some(id) if !id.is_empty() => {
            let existing = load_existing_invoice(conn, id)?;
            if existing.series_code != series.code {
                return Err(AppError::validation(
                    "The invoice series cannot be changed on an existing bill.",
                ));
            }
            let is_target: Option<String> = conn
                .query_row(
                    "SELECT id FROM sales_invoices WHERE converted_to_tax_inv_id = ?1 AND is_deleted = 0 LIMIT 1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?;
            if is_target.is_some() {
                return Err(AppError::validation(
                    "This GST invoice was generated from an estimate and cannot be edited.",
                ));
            }
            Some(existing)
        }
        _ => None,
    };

    // Resolve items and compute line totals.
    let mut resolved: Vec<ResolvedItem> = Vec::with_capacity(req.items.len());
    for item in &req.items {
        if item.billed_qty <= 0 {
            return Err(AppError::validation_field(
                "Billed quantity must be greater than zero.",
                "billed_qty",
            ));
        }
        if item.free_deal_qty < 0 {
            return Err(AppError::validation_field(
                "Free quantity cannot be negative.",
                "free_deal_qty",
            ));
        }
        if item.rate_scaled < 0 || item.mrp_scaled < 0 {
            return Err(AppError::validation_field(
                "Rate and MRP cannot be negative.",
                "rate_scaled",
            ));
        }
        if !(0..=10_000).contains(&item.dis_bps) {
            return Err(AppError::validation_field(
                "Discount must be between 0% and 100%.",
                "dis_bps",
            ));
        }
        let batch = load_batch(conn, &item.batch_id, &item.product_id)?;
        let tax_bps = item.tax_bps.unwrap_or(batch.tax_bps);
        if !(0..=2_800).contains(&tax_bps) {
            return Err(AppError::validation_field(
                "GST rate must be between 0% and 28%.",
                "tax_bps",
            ));
        }
        let totals = line_totals(LineInput {
            qty: item.billed_qty,
            free_qty: item.free_deal_qty,
            rate_scaled: item.rate_scaled,
            dis_bps: item.dis_bps,
            tax_bps,
            tax_inclusive: item.tax_inclusive,
            is_inter_state: party.is_inter_state,
        });
        resolved.push(ResolvedItem {
            product_id: item.product_id.clone(),
            batch_id: item.batch_id.clone(),
            loose_or_box: item
                .loose_or_box
                .clone()
                .filter(|v| v == "L" || v == "B")
                .unwrap_or_else(|| "B".to_string()),
            billed_qty: item.billed_qty,
            free_deal_qty: item.free_deal_qty,
            deal_str: item.deal_str.clone().or_else(|| {
                if batch.deal_billed > 0 {
                    Some(format!("{}+{}", batch.deal_billed, batch.deal_free))
                } else {
                    None
                }
            }),
            tax_inclusive: item.tax_inclusive,
            mrp_scaled: if item.mrp_scaled > 0 { item.mrp_scaled } else { batch.mrp_scaled },
            rate_scaled: item.rate_scaled,
            dis_bps: item.dis_bps,
            tax_bps,
            totals,
        });
    }

    let line_totals_vec: Vec<LineTotals> = resolved.iter().map(|r| r.totals).collect();
    let mut totals = invoice_totals(
        &line_totals_vec,
        req.freight_scaled,
        req.oth_adj_scaled,
        req.reclaimed_scaled,
        req.paid_amt_scaled,
        req.is_sale_return,
    );
    if !req.is_sale_return {
        if req.paid_amt_scaled < 0 || req.paid_amt_scaled > totals.grand_total_scaled {
            return Err(AppError::validation_field(
                "Paid amount must be between zero and the grand total.",
                "paid_amt_scaled",
            ));
        }
        if payment_mode == "CASH" {
            totals.paid_amt_scaled = totals.grand_total_scaled;
            totals.due_amt_scaled = 0;
        }
    }

    // Credit lock check (the invoice being edited is excluded from outstanding).
    if payment_mode == "CREDIT" && !req.is_sale_return {
        let status = account_credit_check_excluding(
            conn,
            &party.id,
            totals.due_amt_scaled.max(0),
            "CREDIT",
            existing.as_ref().map(|e| e.id.as_str()),
        )?;
        if status.locked && !req.override_credit_lock {
            return Err(AppError::with_field(
                "CREDIT_LOCKED",
                status.reasons.join(" "),
                "party_id",
            ));
        }
    }

    // Aggregate batch quantities for stock validation.
    let mut required: HashMap<String, i64> = HashMap::new();
    for item in &resolved {
        *required.entry(item.batch_id.clone()).or_insert(0) += item.billed_qty + item.free_deal_qty;
    }
    if !req.is_sale_return {
        for (batch_id, qty) in &required {
            let (batch_no, cur_qty, product_name) = {
                let row = conn.query_row(
                    "SELECT b.batch_no, b.cur_qty, p.name FROM batches b
                     JOIN products p ON p.id = b.product_id WHERE b.id = ?1",
                    params![batch_id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
                )?;
                row
            };
            if *qty > cur_qty {
                return Err(AppError::with_field(
                    "STOCK_NEGATIVE",
                    format!(
                        "{product_name} batch {batch_no} has only {cur_qty} unit(s) but {qty} are billed. \
                         Reduce quantity, add a provisional batch (Alt+B), or pick a substitute (Ctrl+R)."
                    ),
                    "billed_qty",
                ));
            }
        }
    }

    let tx = conn.transaction()?;
    let now = now_ms();

    // Reverse a previously saved version of this invoice.
    if let Some(old) = &existing {
        reverse_invoice_stock(&tx, device_id, &old.id, old.is_estimate, old.is_sale_return, now)?;
        tx.execute(
            "DELETE FROM account_ledger WHERE ref_table = 'sales_invoices' AND ref_id = ?1",
            params![old.id],
        )?;
        if old.payment_mode == "CREDIT" || old.is_sale_return {
            tx.execute(
                "UPDATE accounts_parties SET cur_bal_scaled = cur_bal_scaled - ?1, updated_at = ?2 WHERE id = ?3",
                params![old.due_amt_scaled, now, party.id],
            )?;
        }
        tx.execute("DELETE FROM sales_invoice_items WHERE invoice_id = ?1", params![old.id])?;
    }

    // Allocate the human invoice number.
    let (inv_no, inv_no_display) = match &existing {
        Some(old) => (old.inv_no, old.inv_no_display.clone()),
        None => {
            let next: i64 = tx.query_row(
                "SELECT next_inv_no FROM invoice_series WHERE id = ?1",
                params![series.id],
                |r| r.get(0),
            )?;
            let display = invoice_display(&series.code, next);
            tx.execute(
                "UPDATE invoice_series SET next_inv_no = ?1, updated_at = ?2 WHERE id = ?3",
                params![next + 1, now, series.id],
            )?;
            (next, display)
        }
    };

    let sign: i64 = if req.is_sale_return { -1 } else { 1 };
    let invoice_id = match &existing {
        Some(old) => {
            tx.execute(
                "UPDATE sales_invoices SET inv_date_iso=?1, inv_date_display=?2, payment_mode=?3,
                    party_id=?4, party_name_snapshot=?5, city_snapshot=?6, salesman_name=?7, remarks=?8,
                    is_sale_return=?9, reclaimed_scaled=?10, gross_total_scaled=?11, tax_amt_scaled=?12,
                    dis_amt_scaled=?13, dis_bps=?14, freight_scaled=?15, oth_adj_scaled=?16,
                    roundoff_scaled=?17, grand_total_scaled=?18, paid_amt_scaled=?19, due_amt_scaled=?20,
                    updated_at=?21
                 WHERE id=?22",
                params![
                    invoice_date_iso, invoice_date_display, payment_mode, party.id, party.name,
                    party.city, req.salesman_name, req.remarks, req.is_sale_return as i64,
                    req.reclaimed_scaled, totals.gross_total_scaled, totals.tax_amt_scaled,
                    totals.dis_amt_scaled, totals.dis_bps, totals.freight_scaled, totals.oth_adj_scaled,
                    totals.roundoff_scaled, totals.grand_total_scaled, totals.paid_amt_scaled,
                    totals.due_amt_scaled, now, old.id
                ],
            )?;
            old.id.clone()
        }
        None => {
            let id = new_id();
            tx.execute(
                "INSERT INTO sales_invoices (id, series_id, series_code, inv_no, inv_no_display,
                    inv_date_iso, inv_date_display, payment_mode, party_id, party_name_snapshot,
                    city_snapshot, salesman_name, remarks, is_sale_return, reclaimed_scaled,
                    gross_total_scaled, tax_amt_scaled, dis_amt_scaled, dis_bps, freight_scaled,
                    oth_adj_scaled, roundoff_scaled, grand_total_scaled, paid_amt_scaled, due_amt_scaled,
                    updated_at, is_deleted)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
                    ?21,?22,?23,?24,?25,?26,0)",
                params![
                    id, series.id, series.code, inv_no, inv_no_display, invoice_date_iso,
                    invoice_date_display, payment_mode, party.id, party.name, party.city,
                    req.salesman_name, req.remarks, req.is_sale_return as i64, req.reclaimed_scaled,
                    totals.gross_total_scaled, totals.tax_amt_scaled, totals.dis_amt_scaled,
                    totals.dis_bps, totals.freight_scaled, totals.oth_adj_scaled,
                    totals.roundoff_scaled, totals.grand_total_scaled, totals.paid_amt_scaled,
                    totals.due_amt_scaled, now
                ],
            )?;
            id
        }
    };

    // Insert line items.
    for (index, item) in resolved.iter().enumerate() {
        let item_id = new_id();
        tx.execute(
            "INSERT INTO sales_invoice_items (id, invoice_id, row_order, product_id, batch_id,
                loose_or_box, billed_qty, free_deal_qty, deal_str, tax_inclusive, mrp_scaled,
                rate_scaled, dis_bps, dis_rs_scaled, taxable_amt_scaled, tax_bps, cgst_amt_scaled,
                sgst_amt_scaled, igst_amt_scaled, net_unit_rate_scaled, line_amount_scaled, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
            params![
                item_id,
                invoice_id,
                index as i64,
                item.product_id,
                item.batch_id,
                item.loose_or_box,
                item.billed_qty,
                item.free_deal_qty,
                item.deal_str,
                item.tax_inclusive as i64,
                item.mrp_scaled,
                item.rate_scaled,
                item.dis_bps,
                item.totals.dis_amt_scaled * sign,
                item.totals.taxable_amt_scaled * sign,
                item.tax_bps,
                item.totals.cgst_amt_scaled * sign,
                item.totals.sgst_amt_scaled * sign,
                item.totals.igst_amt_scaled * sign,
                item.totals.net_unit_rate_scaled * sign,
                item.totals.net_line_scaled * sign,
                now
            ],
        )?;
        if let Some(snapshot) =
            query_one_json(&tx, "SELECT * FROM sales_invoice_items WHERE id = ?1", params![item_id])?
        {
            crate::db::outbox::push_upsert(
                &tx,
                device_id,
                "sales_invoice_items",
                &item_id,
                &snapshot,
            )?;
        }
    }

    // Apply stock movements (physical always; book stock only for GST series).
    for (batch_id, qty) in &required {
        let delta = if req.is_sale_return { *qty } else { -*qty };
        let tax_delta = if series.is_estimate { 0 } else { delta };
        tx.execute(
            "UPDATE batches SET cur_qty = cur_qty + ?1, tax_stock_qty = tax_stock_qty + ?2,
                updated_at = ?3 WHERE id = ?4",
            params![delta, tax_delta, now, batch_id],
        )?;
        if let Some(snapshot) =
            query_one_json(&tx, "SELECT * FROM batches WHERE id = ?1", params![batch_id])?
        {
            crate::db::outbox::push_batch_delta(&tx, device_id, batch_id, delta, tax_delta, &snapshot)?;
        }
    }

    // Party ledger + outstanding balance.
    if payment_mode == "CREDIT" || req.is_sale_return {
        let cur_delta = if req.is_sale_return { totals.grand_total_scaled } else { totals.due_amt_scaled };
        tx.execute(
            "UPDATE accounts_parties SET cur_bal_scaled = cur_bal_scaled + ?1, updated_at = ?2 WHERE id = ?3",
            params![cur_delta, now, party.id],
        )?;
        crate::db::outbox::push_table_row(&tx, device_id, "accounts_parties", &party.id)?;
        let narration = if req.is_sale_return {
            format!("Sale return {inv_no_display}")
        } else {
            format!("Sales invoice {inv_no_display}")
        };
        let ledger_id = new_id();
        tx.execute(
            "INSERT INTO account_ledger (id, account_id, entry_date_iso, entry_type, ref_table, ref_id,
                ref_no, dr_scaled, cr_scaled, narration, created_at)
             VALUES (?1,?2,?3,'SALES','sales_invoices',?4,?5,?6,?7,?8,?9)",
            params![
                ledger_id,
                party.id,
                invoice_date_iso,
                invoice_id,
                inv_no_display,
                if totals.grand_total_scaled > 0 { totals.grand_total_scaled } else { 0 },
                if totals.grand_total_scaled < 0 { -totals.grand_total_scaled } else { 0 },
                narration,
                now
            ],
        )?;
        crate::db::outbox::push_table_row(&tx, device_id, "account_ledger", &ledger_id)?;
        if totals.paid_amt_scaled > 0 && !req.is_sale_return {
            let receipt_id = new_id();
            tx.execute(
                "INSERT INTO account_ledger (id, account_id, entry_date_iso, entry_type, ref_table,
                    ref_id, ref_no, dr_scaled, cr_scaled, narration, created_at)
                 VALUES (?1,?2,?3,'RECEIPT','sales_invoices',?4,?5,0,?6,'Amount received',?7)",
                params![
                    receipt_id,
                    party.id,
                    invoice_date_iso,
                    invoice_id,
                    inv_no_display,
                    totals.paid_amt_scaled,
                    now
                ],
            )?;
            crate::db::outbox::push_table_row(&tx, device_id, "account_ledger", &receipt_id)?;
        }
    }

    if let Some(snapshot) =
        query_one_json(&tx, "SELECT * FROM sales_invoices WHERE id = ?1", params![invoice_id])?
    {
        crate::db::outbox::push_upsert(&tx, device_id, "sales_invoices", &invoice_id, &snapshot)?;
    }

    tx.commit()?;
    Ok(invoice_id)
}

fn reverse_invoice_stock(
    tx: &Transaction,
    device_id: &str,
    invoice_id: &str,
    is_estimate: bool,
    is_sale_return: bool,
    now: i64,
) -> AppResult<()> {
    let items = query_json(
        tx,
        "SELECT batch_id, billed_qty, free_deal_qty FROM sales_invoice_items WHERE invoice_id = ?1",
        params![invoice_id],
    )?;
    let mut restored: HashMap<String, i64> = HashMap::new();
    for item in items {
        let batch_id = item["batch_id"].as_str().unwrap_or_default().to_string();
        let qty = item["billed_qty"].as_i64().unwrap_or(0)
            + item["free_deal_qty"].as_i64().unwrap_or(0);
        *restored.entry(batch_id).or_insert(0) += qty;
    }
    let sign: i64 = if is_sale_return { -1 } else { 1 };
    for (batch_id, qty) in restored {
        let delta = sign * qty;
        let tax_delta = if is_estimate { 0 } else { delta };
        tx.execute(
            "UPDATE batches SET cur_qty = cur_qty + ?1, tax_stock_qty = tax_stock_qty + ?2,
                updated_at = ?3 WHERE id = ?4",
            params![delta, tax_delta, now, batch_id],
        )?;
        if let Some(snapshot) =
            query_one_json(tx, "SELECT * FROM batches WHERE id = ?1", params![batch_id])?
        {
            crate::db::outbox::push_batch_delta(tx, device_id, &batch_id, delta, tax_delta, &snapshot)?;
        }
    }
    Ok(())
}

/// Delete (soft) an invoice, restoring stock and party balance.
pub fn delete_invoice_core(
    conn: &mut Connection,
    device_id: &str,
    invoice_id: &str,
) -> AppResult<()> {
    let existing = load_existing_invoice(conn, invoice_id)?;
    let target_of: Option<String> = conn
        .query_row(
            "SELECT id FROM sales_invoices WHERE converted_to_tax_inv_id = ?1 AND is_deleted = 0 LIMIT 1",
            params![invoice_id],
            |r| r.get(0),
        )
        .optional()?;
    if target_of.is_some() {
        return Err(AppError::validation(
            "This GST invoice was generated from an estimate and cannot be deleted.",
        ));
    }
    if let Some(converted) = conn
        .query_row(
            "SELECT converted_to_tax_inv_id FROM sales_invoices WHERE id = ?1",
            params![invoice_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
    {
        let still_there: Option<String> = conn
            .query_row(
                "SELECT id FROM sales_invoices WHERE id = ?1 AND is_deleted = 0",
                params![converted],
                |r| r.get(0),
            )
            .optional()?;
        if still_there.is_some() {
            return Err(AppError::validation(
                "This estimate was already converted to a GST invoice. Delete the GST invoice first.",
            ));
        }
    }

    let tx = conn.transaction()?;
    let now = now_ms();
    reverse_invoice_stock(&tx, device_id, invoice_id, existing.is_estimate, existing.is_sale_return, now)?;
    tx.execute(
        "DELETE FROM account_ledger WHERE ref_table = 'sales_invoices' AND ref_id = ?1",
        params![invoice_id],
    )?;
    if existing.payment_mode == "CREDIT" || existing.is_sale_return {
        let party_id: Option<String> = tx
            .query_row(
                "SELECT party_id FROM sales_invoices WHERE id = ?1",
                params![invoice_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(party_id) = party_id {
            tx.execute(
                "UPDATE accounts_parties SET cur_bal_scaled = cur_bal_scaled - ?1, updated_at = ?2 WHERE id = ?3",
                params![existing.due_amt_scaled, now, party_id],
            )?;
            crate::db::outbox::push_table_row(&tx, device_id, "accounts_parties", &party_id)?;
        }
    }
    tx.execute(
        "UPDATE sales_invoices SET is_deleted = 1, updated_at = ?1 WHERE id = ?2",
        params![now, invoice_id],
    )?;
    crate::db::outbox::push_delete(&tx, device_id, "sales_invoices", invoice_id)?;
    tx.commit()?;
    Ok(())
}

/// Convert estimates to formal GST invoices. Only tax stock is deducted here,
/// because physical stock was already taken when the estimate was saved.
pub fn convert_estimates_core(
    conn: &mut Connection,
    device_id: &str,
    invoice_ids: &[String],
    date_display: Option<&str>,
) -> AppResult<Vec<Value>> {
    if invoice_ids.is_empty() {
        return Err(AppError::validation("Select at least one estimate to convert."));
    }
    let tx = conn.transaction()?;
    let now = now_ms();
    let mut converted = Vec::new();

    for invoice_id in invoice_ids {
        let header = load_convert_header(&tx, invoice_id)?;
        if !header.is_estimate {
            return Err(AppError::validation(format!(
                "Invoice {} is already a GST invoice.",
                header.inv_no_display
            )));
        }
        if header.converted.is_some() {
            return Err(AppError::validation(format!(
                "Invoice {} was already converted.",
                header.inv_no_display
            )));
        }

        let abc = load_series(&tx, "ABC")?;
        let next: i64 = tx.query_row(
            "SELECT next_inv_no FROM invoice_series WHERE id = ?1",
            params![abc.id],
            |r| r.get(0),
        )?;
        let new_display = invoice_display(&abc.code, next);
        tx.execute(
            "UPDATE invoice_series SET next_inv_no = ?1, updated_at = ?2 WHERE id = ?3",
            params![next + 1, now, abc.id],
        )?;

        let new_invoice_id = new_id();
        let (display_date, iso_date) = match date_display.filter(|d| !d.trim().is_empty()) {
            Some(value) => (value.to_string(), display_to_iso(value)?),
            None => (header.inv_date_display.clone(), header.inv_date_iso.clone()),
        };
        tx.execute(
            "INSERT INTO sales_invoices (id, series_id, series_code, inv_no, inv_no_display,
                inv_date_iso, inv_date_display, payment_mode, party_id, party_name_snapshot,
                city_snapshot, salesman_name, remarks, is_sale_return, reclaimed_scaled,
                gross_total_scaled, tax_amt_scaled, dis_amt_scaled, dis_bps, freight_scaled,
                oth_adj_scaled, roundoff_scaled, grand_total_scaled, paid_amt_scaled, due_amt_scaled,
                updated_at, is_deleted)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0,?14,?15,?16,?17,?18,?19,?20,
                ?21,?22,?23,?24,?25,0)",
            params![
                new_invoice_id, abc.id, abc.code, next, new_display, iso_date, display_date,
                header.payment_mode, header.party_id, header.party_name, header.city,
                header.salesman, header.remarks, header.reclaimed, header.gross, header.tax,
                header.dis, header.dis_bps, header.freight, header.oth, header.roundoff,
                header.grand, header.paid, header.due, now
            ],
        )?;

        let items = query_json(
            &tx,
            "SELECT it.row_order, it.product_id, it.batch_id, it.loose_or_box, it.billed_qty,
                    it.free_deal_qty, it.deal_str, it.tax_inclusive, it.mrp_scaled, it.rate_scaled,
                    it.dis_bps, it.dis_rs_scaled, it.taxable_amt_scaled, it.tax_bps,
                    it.cgst_amt_scaled, it.sgst_amt_scaled, it.igst_amt_scaled,
                    it.net_unit_rate_scaled, it.line_amount_scaled,
                    b.batch_no, b.tax_stock_qty
             FROM sales_invoice_items it
             JOIN batches b ON b.id = it.batch_id
             WHERE it.invoice_id = ?1 ORDER BY it.row_order",
            params![invoice_id],
        )?;

        for item in &items {
            let batch_id = item["batch_id"].as_str().unwrap_or_default().to_string();
            let billed = item["billed_qty"].as_i64().unwrap_or(0);
            let free = item["free_deal_qty"].as_i64().unwrap_or(0);
            let qty = billed + free;
            let available = item["tax_stock_qty"].as_i64().unwrap_or(0);
            if available < qty {
                return Err(AppError::with_field(
                    "TAX_STOCK_NEGATIVE",
                    format!(
                        "Batch {} has only {} unit(s) of GST stock; {} needed to convert this estimate.",
                        item["batch_no"].as_str().unwrap_or(""),
                        available,
                        qty
                    ),
                    "billed_qty",
                ));
            }

            let item_id = new_id();
            tx.execute(
                "INSERT INTO sales_invoice_items (id, invoice_id, row_order, product_id, batch_id,
                    loose_or_box, billed_qty, free_deal_qty, deal_str, tax_inclusive, mrp_scaled,
                    rate_scaled, dis_bps, dis_rs_scaled, taxable_amt_scaled, tax_bps, cgst_amt_scaled,
                    sgst_amt_scaled, igst_amt_scaled, net_unit_rate_scaled, line_amount_scaled, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
                params![
                    item_id,
                    new_invoice_id,
                    item["row_order"].as_i64().unwrap_or(0),
                    item["product_id"].as_str().unwrap_or_default(),
                    batch_id,
                    item["loose_or_box"].as_str().unwrap_or("B"),
                    billed,
                    free,
                    item["deal_str"].as_str(),
                    item["tax_inclusive"].as_i64().unwrap_or(0),
                    item["mrp_scaled"].as_i64().unwrap_or(0),
                    item["rate_scaled"].as_i64().unwrap_or(0),
                    item["dis_bps"].as_i64().unwrap_or(0),
                    item["dis_rs_scaled"].as_i64().unwrap_or(0),
                    item["taxable_amt_scaled"].as_i64().unwrap_or(0),
                    item["tax_bps"].as_i64().unwrap_or(0),
                    item["cgst_amt_scaled"].as_i64().unwrap_or(0),
                    item["sgst_amt_scaled"].as_i64().unwrap_or(0),
                    item["igst_amt_scaled"].as_i64().unwrap_or(0),
                    item["net_unit_rate_scaled"].as_i64().unwrap_or(0),
                    item["line_amount_scaled"].as_i64().unwrap_or(0),
                    now
                ],
            )?;
            tx.execute(
                "UPDATE batches SET tax_stock_qty = tax_stock_qty - ?1, updated_at = ?2 WHERE id = ?3",
                params![qty, now, batch_id],
            )?;
            if let Some(snapshot) =
                query_one_json(&tx, "SELECT * FROM batches WHERE id = ?1", params![batch_id])?
            {
                crate::db::outbox::push_batch_delta(&tx, device_id, &batch_id, 0, -qty, &snapshot)?;
            }
            if let Some(snapshot) =
                query_one_json(&tx, "SELECT * FROM sales_invoice_items WHERE id = ?1", params![item_id])?
            {
                crate::db::outbox::push_upsert(
                    &tx,
                    device_id,
                    "sales_invoice_items",
                    &item_id,
                    &snapshot,
                )?;
            }
        }

        tx.execute(
            "UPDATE sales_invoices SET converted_to_tax_inv_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_invoice_id, now, invoice_id],
        )?;
        if let Some(snapshot) =
            query_one_json(&tx, "SELECT * FROM sales_invoices WHERE id = ?1", params![new_invoice_id])?
        {
            crate::db::outbox::push_upsert(
                &tx,
                device_id,
                "sales_invoices",
                &new_invoice_id,
                &snapshot,
            )?;
        }
        if let Some(snapshot) =
            query_one_json(&tx, "SELECT * FROM sales_invoices WHERE id = ?1", params![invoice_id])?
        {
            crate::db::outbox::push_upsert(&tx, device_id, "sales_invoices", invoice_id, &snapshot)?;
        }

        converted.push(json!({
            "from_id": invoice_id,
            "to_id": new_invoice_id,
            "from_display": header.inv_no_display,
            "to_display": new_display,
        }));
    }

    tx.commit()?;
    Ok(converted)
}

struct ConvertHeader {
    inv_no_display: String,
    inv_date_iso: String,
    inv_date_display: String,
    payment_mode: String,
    party_id: Option<String>,
    party_name: String,
    city: Option<String>,
    salesman: Option<String>,
    remarks: Option<String>,
    reclaimed: i64,
    gross: i64,
    tax: i64,
    dis: i64,
    dis_bps: i64,
    freight: i64,
    oth: i64,
    roundoff: i64,
    grand: i64,
    paid: i64,
    due: i64,
    converted: Option<String>,
    is_estimate: bool,
}

fn load_convert_header(conn: &Connection, invoice_id: &str) -> AppResult<ConvertHeader> {
    conn.query_row(
        "SELECT i.inv_no_display, i.inv_date_iso, i.inv_date_display, i.payment_mode, i.party_id,
                i.party_name_snapshot, i.city_snapshot, i.salesman_name, i.remarks,
                i.reclaimed_scaled, i.gross_total_scaled, i.tax_amt_scaled, i.dis_amt_scaled,
                i.dis_bps, i.freight_scaled, i.oth_adj_scaled, i.roundoff_scaled,
                i.grand_total_scaled, i.paid_amt_scaled, i.due_amt_scaled, i.converted_to_tax_inv_id,
                s.is_estimate
         FROM sales_invoices i JOIN invoice_series s ON s.id = i.series_id
         WHERE i.id = ?1 AND i.is_deleted = 0",
        params![invoice_id],
        |r| {
            Ok(ConvertHeader {
                inv_no_display: r.get(0)?,
                inv_date_iso: r.get(1)?,
                inv_date_display: r.get(2)?,
                payment_mode: r.get(3)?,
                party_id: r.get(4)?,
                party_name: r.get(5)?,
                city: r.get(6)?,
                salesman: r.get(7)?,
                remarks: r.get(8)?,
                reclaimed: r.get(9)?,
                gross: r.get(10)?,
                tax: r.get(11)?,
                dis: r.get(12)?,
                dis_bps: r.get(13)?,
                freight: r.get(14)?,
                oth: r.get(15)?,
                roundoff: r.get(16)?,
                grand: r.get(17)?,
                paid: r.get(18)?,
                due: r.get(19)?,
                converted: r.get(20)?,
                is_estimate: r.get::<_, i64>(21)? != 0,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("Invoice not found."))
}

// ---------------------------------------------------------------------------
// Lookup helpers + detail
// ---------------------------------------------------------------------------

fn load_series(conn: &Connection, code: &str) -> AppResult<Series> {
    let code = code.trim().to_ascii_uppercase();
    conn.query_row(
        "SELECT id, series_code, is_estimate, next_inv_no FROM invoice_series
         WHERE series_code = ?1 AND is_deleted = 0",
        params![code],
        |r| {
            Ok(Series {
                id: r.get(0)?,
                code: r.get(1)?,
                is_estimate: r.get::<_, i64>(2)? != 0,
                next_inv_no: r.get(3)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found(format!("Invoice series '{code}' is not configured.")))
}

fn load_party(conn: &Connection, party_id: &str) -> AppResult<PartySnapshot> {
    if party_id.trim().is_empty() {
        return Err(AppError::validation_field("Select a party before saving.", "party_id"));
    }
    conn.query_row(
        "SELECT id, name, city, is_inter_state FROM accounts_parties
         WHERE id = ?1 AND is_deleted = 0",
        params![party_id],
        |r| {
            Ok(PartySnapshot {
                id: r.get(0)?,
                name: r.get(1)?,
                city: r.get(2)?,
                is_inter_state: r.get::<_, i64>(3)? != 0,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::validation_field("Party not found.", "party_id"))
}

struct BatchInfo {
    mrp_scaled: i64,
    deal_billed: i64,
    deal_free: i64,
    tax_bps: i64,
}

fn load_batch(conn: &Connection, batch_id: &str, product_id: &str) -> AppResult<BatchInfo> {
    conn.query_row(
        "SELECT b.mrp_scaled, b.deal_billed, b.deal_free,
                COALESCE(tp.cgst_bps + tp.sgst_bps, 0)
         FROM batches b
         JOIN products p ON p.id = b.product_id
         LEFT JOIN tax_plans tp ON tp.id = p.sale_tax_id
         WHERE b.id = ?1 AND b.product_id = ?2 AND b.is_deleted = 0",
        params![batch_id, product_id],
        |r| {
            Ok(BatchInfo {
                mrp_scaled: r.get(0)?,
                deal_billed: r.get(1)?,
                deal_free: r.get(2)?,
                tax_bps: r.get(3)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| {
        AppError::validation_field(
            "The selected batch does not belong to this product or has been deleted.",
            "batch_id",
        )
    })
}

fn load_existing_invoice(conn: &Connection, id: &str) -> AppResult<ExistingInvoice> {
    conn.query_row(
        "SELECT i.id, i.series_code, i.inv_no, i.inv_no_display, s.is_estimate,
                i.payment_mode, i.due_amt_scaled, i.is_sale_return
         FROM sales_invoices i JOIN invoice_series s ON s.id = i.series_id
         WHERE i.id = ?1 AND i.is_deleted = 0",
        params![id],
        |r| {
            Ok(ExistingInvoice {
                id: r.get(0)?,
                series_code: r.get(1)?,
                inv_no: r.get(2)?,
                inv_no_display: r.get(3)?,
                is_estimate: r.get::<_, i64>(4)? != 0,
                payment_mode: r.get(5)?,
                due_amt_scaled: r.get(6)?,
                is_sale_return: r.get::<_, i64>(7)? != 0,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("Invoice not found."))
}

fn invoice_display(series_code: &str, number: i64) -> String {
    if series_code.eq_ignore_ascii_case("E") {
        format!("E{number}")
    } else {
        format!("{series_code}-{number}")
    }
}

pub fn invoice_detail_json(conn: &Connection, invoice_id: &str) -> AppResult<Value> {
    let invoice = query_one_json(
        conn,
        "SELECT i.*, s.series_name, s.is_estimate
         FROM sales_invoices i JOIN invoice_series s ON s.id = i.series_id
         WHERE i.id = ?1 AND i.is_deleted = 0",
        params![invoice_id],
    )?
    .ok_or_else(|| AppError::not_found("Invoice not found."))?;

    let items = query_json(
        conn,
        "SELECT it.*, p.name AS product_name, p.pro_code, p.pack_form, p.pack_unit, p.pack_subunit,
                b.batch_no, b.expiry_mm_yy, b.expiry_sort_key, b.godown_id,
                b.cur_qty AS batch_cur_qty, b.tax_stock_qty AS batch_tax_qty,
                gd.code AS godown_code,
                COALESCE(c.name, '') AS company_name,
                COALESCE(cp.description, '') AS composition_desc
         FROM sales_invoice_items it
         JOIN products p ON p.id = it.product_id
         JOIN batches b ON b.id = it.batch_id
         JOIN godowns gd ON gd.id = b.godown_id
         LEFT JOIN companies c ON c.id = p.company_id
         LEFT JOIN compositions cp ON cp.id = p.composition_id
         WHERE it.invoice_id = ?1
         ORDER BY it.row_order",
        params![invoice_id],
    )?;

    let party = match invoice.get("party_id").and_then(|v| v.as_str()) {
        Some(party_id) if !party_id.is_empty() => {
            let detail = account_detail_json(conn, party_id)?;
            Some(detail)
        }
        _ => None,
    };

    Ok(json!({ "invoice": invoice, "items": items, "party": party }))
}

// ---------------------------------------------------------------------------
// Print document builder
// ---------------------------------------------------------------------------

fn build_print_doc(conn: &Connection, invoice_id: &str) -> AppResult<PrintDoc> {
    let detail = invoice_detail_json(conn, invoice_id)?;
    let invoice = &detail["invoice"];
    let items = detail["items"].as_array().cloned().unwrap_or_default();
    let company_name = get_setting(conn, "company_name")?.unwrap_or_else(|| "SALTBOOK PHARMACEUTICALS".into());
    let company_address = get_setting(conn, "company_address")?
        .unwrap_or_else(|| "MAIN ROAD, BARH, PATNA - 803213".into());
    let company_gst = get_setting(conn, "company_gst_no")?.unwrap_or_else(|| "10ABCDE1234F1ZF".into());
    let company_dl = get_setting(conn, "company_dl_no")?.unwrap_or_else(|| "BR-20B/0001".into());
    let merchant_vpa = get_setting(conn, "merchant_vpa")?.unwrap_or_else(|| "saltbook@upi".into());

    let is_estimate = invoice.get("is_estimate").and_then(|v| v.as_i64()).unwrap_or(0) != 0;
    let title = if is_estimate { "ESTIMATE" } else { "TAX INVOICE" };
    let mut lines = Vec::new();
    lines.push(company_name.clone());
    lines.push(company_address);
    lines.push(format!("GSTIN: {company_gst}   DL: {company_dl}"));
    lines.push(format!("{title}  {}", invoice["inv_no_display"].as_str().unwrap_or("")));
    lines.push(format!("DATE: {}", invoice["inv_date_display"].as_str().unwrap_or("")));
    lines.push(format!(
        "PARTY: {} ({})",
        invoice["party_name_snapshot"].as_str().unwrap_or(""),
        invoice["city_snapshot"].as_str().unwrap_or("")
    ));
    lines.push(format!(
        "MODE: {}   SALESMAN: {}",
        invoice["payment_mode"].as_str().unwrap_or(""),
        invoice["salesman_name"].as_str().unwrap_or("-")
    ));
    lines.push(String::new());
    lines.push(format!("{:<4}{:<26}{:>7}{:>7}{:>7}", "#", "ITEM / BATCH", "QTY", "RATE", "AMT"));
    for (index, item) in items.iter().enumerate() {
        let name = item["product_name"].as_str().unwrap_or("");
        lines.push(format!(
            "{:<4}{:<26}{:>7}{:>7}{:>7}",
            index + 1,
            truncate(name, 26),
            item["billed_qty"].as_i64().unwrap_or(0),
            format_money(item["rate_scaled"].as_i64().unwrap_or(0)),
            format_money(item["line_amount_scaled"].as_i64().unwrap_or(0))
        ));
        lines.push(format!(
            "    BATCH {}  EXP {}  GST {}%",
            item["batch_no"].as_str().unwrap_or(""),
            item["expiry_mm_yy"].as_str().unwrap_or(""),
            item["tax_bps"].as_i64().unwrap_or(0) as f64 / 100.0
        ));
    }
    lines.push(String::new());
    let mut totals = Vec::new();
    totals.push(format!("GROSS      {:>12}", format_money(invoice["gross_total_scaled"].as_i64().unwrap_or(0))));
    totals.push(format!("DISCOUNT   {:>12}", format_money(invoice["dis_amt_scaled"].as_i64().unwrap_or(0))));
    totals.push(format!("GST        {:>12}", format_money(invoice["tax_amt_scaled"].as_i64().unwrap_or(0))));
    totals.push(format!("ROUND OFF  {:>12}", format_money(invoice["roundoff_scaled"].as_i64().unwrap_or(0))));
    totals.push(format!("GRAND TOTAL {:>11}", format_money(invoice["grand_total_scaled"].as_i64().unwrap_or(0))));
    let grand = invoice["grand_total_scaled"].as_i64().unwrap_or(0);
    let upi_uri = format!("upi://pay?pa={}&pn={}&am={}&cu=INR&tn={}", urlencoding::encode(&merchant_vpa),
        urlencoding::encode(&company_name), format_money(grand), urlencoding::encode(invoice["inv_no_display"].as_str().unwrap_or("")));
    Ok(PrintDoc { title: title.to_string(), lines, totals, upi_uri })
}

fn truncate(input: &str, max: usize) -> String {
    if input.chars().count() <= max {
        input.to_string()
    } else {
        input.chars().take(max.saturating_sub(1)).collect::<String>() + "~"
    }
}

// ---------------------------------------------------------------------------
// Demo invoice seeding (used by the demo command)
// ---------------------------------------------------------------------------

pub fn seed_demo_invoices(conn: &mut Connection, device_id: &str) -> AppResult<i64> {
    let already: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sales_invoices WHERE is_deleted = 0",
        [],
        |r| r.get(0),
    )?;
    if already > 0 {
        return Ok(0);
    }
    let party_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM accounts_parties WHERE account_type = 'PARTY' AND is_deleted = 0 ORDER BY code LIMIT 5",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    if party_ids.is_empty() {
        return Ok(0);
    }
    let product_rows: Vec<(String, String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT p.id, b.id, b.s_rate_scaled FROM products p
             JOIN batches b ON b.product_id = p.id AND b.cur_qty > 5 AND b.is_deleted = 0
             ORDER BY p.pro_code LIMIT 20",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    if product_rows.is_empty() {
        return Ok(0);
    }
    let today = chrono::Local::now();
    let mut created = 0;
    for index in 0..5usize {
        let party = &party_ids[index % party_ids.len()];
        let date = today - chrono::Duration::days(index as i64 * 2);
        let mut items = Vec::new();
        for offset in 0..3usize {
            let (product_id, batch_id, rate) = &product_rows[(index * 3 + offset) % product_rows.len()];
            items.push(InvoiceItemRequest {
                product_id: product_id.clone(),
                batch_id: batch_id.clone(),
                loose_or_box: Some("B".into()),
                billed_qty: 2 + offset as i64,
                free_deal_qty: 0,
                deal_str: None,
                tax_inclusive: false,
                mrp_scaled: 0,
                rate_scaled: *rate,
                dis_bps: 1000,
                tax_bps: None,
            });
        }
        let req = InvoiceSaveRequest {
            invoice_id: None,
            series_code: "E".into(),
            inv_date_display: Some(date.format("%d/%m/%Y").to_string()),
            payment_mode: if index % 2 == 0 { "CASH".into() } else { "CREDIT".into() },
            party_id: party.clone(),
            salesman_name: Some("R. K. SINGH".into()),
            remarks: None,
            is_sale_return: false,
            freight_scaled: 0,
            oth_adj_scaled: 0,
            reclaimed_scaled: 0,
            paid_amt_scaled: 0,
            override_credit_lock: true,
            items,
        };
        save_invoice_core(conn, device_id, req)?;
        created += 1;
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::services::calc_engine::parse_scaled;

    fn seed(db: &Db) -> (String, String, String, String) {
        let mut conn = db.lock().unwrap();
        crate::db::demo::seed_masters(&mut conn).unwrap();
        let product_id: String = conn
            .query_row("SELECT id FROM products WHERE pro_code = 249", [], |r| r.get(0))
            .unwrap();
        let batch_id: String = conn
            .query_row(
                "SELECT id FROM batches WHERE product_id = ?1 ORDER BY expiry_sort_key LIMIT 1",
                params![product_id],
                |r| r.get(0),
            )
            .unwrap();
        let party_id: String = conn
            .query_row("SELECT id FROM accounts_parties WHERE code = 'C001'", [], |r| r.get(0))
            .unwrap();
        let device_id = crate::db::get_setting(&conn, "device_id").unwrap().unwrap();
        (product_id, batch_id, party_id, device_id)
    }

    fn simple_request(product_id: &str, batch_id: &str, party_id: &str, series: &str, qty: i64) -> InvoiceSaveRequest {
        InvoiceSaveRequest {
            invoice_id: None,
            series_code: series.into(),
            inv_date_display: None,
            payment_mode: "CASH".into(),
            party_id: party_id.into(),
            salesman_name: None,
            remarks: None,
            is_sale_return: false,
            freight_scaled: 0,
            oth_adj_scaled: 0,
            reclaimed_scaled: 0,
            paid_amt_scaled: 0,
            override_credit_lock: false,
            items: vec![InvoiceItemRequest {
                product_id: product_id.into(),
                batch_id: batch_id.into(),
                loose_or_box: Some("B".into()),
                billed_qty: qty,
                free_deal_qty: 0,
                deal_str: None,
                tax_inclusive: false,
                mrp_scaled: 0,
                rate_scaled: parse_scaled("228").unwrap(),
                dis_bps: 800,
                tax_bps: None,
            }],
        }
    }

    #[test]
    fn saving_a_gst_invoice_deducts_physical_and_tax_stock() {
        let db = Db::open_memory().unwrap();
        let (product_id, batch_id, party_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        let before: (i64, i64) = conn
            .query_row("SELECT cur_qty, tax_stock_qty FROM batches WHERE id = ?1", params![batch_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        let invoice_id = save_invoice_core(&mut conn, &device_id, simple_request(&product_id, &batch_id, &party_id, "ABC", 5)).unwrap();
        let after: (i64, i64) = conn
            .query_row("SELECT cur_qty, tax_stock_qty FROM batches WHERE id = ?1", params![batch_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(after.0, before.0 - 5);
        assert_eq!(after.1, before.1 - 5);

        let invoice = invoice_detail_json(&conn, &invoice_id).unwrap();
        assert_eq!(invoice["invoice"]["series_code"], "ABC");
        assert_eq!(invoice["invoice"]["payment_mode"], "CASH");
        assert_eq!(invoice["invoice"]["due_amt_scaled"], 0);
        assert_eq!(invoice["items"].as_array().unwrap().len(), 1);
        // GST split present for intra-state party.
        let cgst = invoice["items"][0]["cgst_amt_scaled"].as_i64().unwrap();
        let sgst = invoice["items"][0]["sgst_amt_scaled"].as_i64().unwrap();
        assert!(cgst > 0 && sgst > 0);
        assert_eq!(invoice["items"][0]["igst_amt_scaled"], 0);

        let outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_table = 'batches'", [], |r| r.get(0))
            .unwrap();
        assert!(outbox >= 1, "batch delta must be queued in the outbox");
    }

    #[test]
    fn estimates_deduct_physical_stock_but_not_tax_stock() {
        let db = Db::open_memory().unwrap();
        let (product_id, batch_id, party_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        let before: (i64, i64) = conn
            .query_row("SELECT cur_qty, tax_stock_qty FROM batches WHERE id = ?1", params![batch_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        save_invoice_core(&mut conn, &device_id, simple_request(&product_id, &batch_id, &party_id, "E", 4)).unwrap();
        let after: (i64, i64) = conn
            .query_row("SELECT cur_qty, tax_stock_qty FROM batches WHERE id = ?1", params![batch_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(after.0, before.0 - 4);
        assert_eq!(after.1, before.1, "estimate must not touch book stock");
    }

    #[test]
    fn blocks_selling_more_than_batch_stock() {
        let db = Db::open_memory().unwrap();
        let (product_id, batch_id, party_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        let qty: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        let err = save_invoice_core(
            &mut conn,
            &device_id,
            simple_request(&product_id, &batch_id, &party_id, "ABC", qty + 1),
        )
        .unwrap_err();
        assert_eq!(err.code, "STOCK_NEGATIVE");
        assert!(err.message.contains("provisional"));
    }

    #[test]
    fn empty_invoice_returns_the_srd_banner_message() {
        let db = Db::open_memory().unwrap();
        let (_product_id, _batch_id, party_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        let mut req = simple_request("x", "y", &party_id, "E", 1);
        req.items.clear();
        let err = save_invoice_core(&mut conn, &device_id, req).unwrap_err();
        assert_eq!(err.code, "EMPTY_INVOICE");
        assert!(err.message.contains("at least one product line item"));
    }

    #[test]
    fn editing_an_invoice_restores_then_reapplies_stock() {
        let db = Db::open_memory().unwrap();
        let (product_id, batch_id, party_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        let before: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        let invoice_id = save_invoice_core(&mut conn, &device_id, simple_request(&product_id, &batch_id, &party_id, "ABC", 3)).unwrap();
        let mut req = simple_request(&product_id, &batch_id, &party_id, "ABC", 7);
        req.invoice_id = Some(invoice_id.clone());
        save_invoice_core(&mut conn, &device_id, req).unwrap();
        let after: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        assert_eq!(after, before - 7);
        let item_qty: i64 = conn
            .query_row("SELECT billed_qty FROM sales_invoice_items WHERE invoice_id = ?1", params![invoice_id], |r| r.get(0))
            .unwrap();
        assert_eq!(item_qty, 7);
    }

    #[test]
    fn converting_estimate_moves_only_tax_stock_and_links_invoices() {
        let db = Db::open_memory().unwrap();
        let (product_id, batch_id, party_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        let estimate_id = save_invoice_core(&mut conn, &device_id, simple_request(&product_id, &batch_id, &party_id, "E", 2)).unwrap();
        let before: (i64, i64) = conn
            .query_row("SELECT cur_qty, tax_stock_qty FROM batches WHERE id = ?1", params![batch_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        let converted = convert_estimates_core(&mut conn, &device_id, &[estimate_id.clone()], None).unwrap();
        assert_eq!(converted.len(), 1);
        let new_id = converted[0]["to_id"].as_str().unwrap().to_string();
        let after: (i64, i64) = conn
            .query_row("SELECT cur_qty, tax_stock_qty FROM batches WHERE id = ?1", params![batch_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(after.0, before.0, "physical stock must not move again");
        assert_eq!(after.1, before.1 - 2);
        let linked: String = conn
            .query_row("SELECT converted_to_tax_inv_id FROM sales_invoices WHERE id = ?1", params![estimate_id], |r| r.get(0))
            .unwrap();
        assert_eq!(linked, new_id);
        let series: String = conn
            .query_row("SELECT series_code FROM sales_invoices WHERE id = ?1", params![new_id], |r| r.get(0))
            .unwrap();
        assert_eq!(series, "ABC");
    }

    #[test]
    fn deleting_an_invoice_restores_stock_and_balance() {
        let db = Db::open_memory().unwrap();
        let (product_id, batch_id, party_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        let before: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        let balance_before: i64 = conn
            .query_row("SELECT cur_bal_scaled FROM accounts_parties WHERE id = ?1", params![party_id], |r| r.get(0))
            .unwrap();
        let mut req = simple_request(&product_id, &batch_id, &party_id, "ABC", 2);
        req.payment_mode = "CREDIT".into();
        let invoice_id = save_invoice_core(&mut conn, &device_id, req).unwrap();
        delete_invoice_core(&mut conn, &device_id, &invoice_id).unwrap();
        let after: i64 = conn
            .query_row("SELECT cur_qty FROM batches WHERE id = ?1", params![batch_id], |r| r.get(0))
            .unwrap();
        let balance_after: i64 = conn
            .query_row("SELECT cur_bal_scaled FROM accounts_parties WHERE id = ?1", params![party_id], |r| r.get(0))
            .unwrap();
        assert_eq!(after, before);
        assert_eq!(balance_after, balance_before);
    }

    #[test]
    fn credit_lock_blocks_credit_invoice_without_override() {
        let db = Db::open_memory().unwrap();
        let (product_id, batch_id, party_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        conn.execute(
            "UPDATE accounts_parties SET cr_limit_scaled = 1 WHERE id = ?1",
            params![party_id],
        )
        .unwrap();
        let mut req = simple_request(&product_id, &batch_id, &party_id, "ABC", 2);
        req.payment_mode = "CREDIT".into();
        let err = save_invoice_core(&mut conn, &device_id, req.clone()).unwrap_err();
        assert_eq!(err.code, "CREDIT_LOCKED");
        req.override_credit_lock = true;
        assert!(save_invoice_core(&mut conn, &device_id, req).is_ok());
    }
}
