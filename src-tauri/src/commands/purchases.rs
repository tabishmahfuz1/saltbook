//! Purchases: inward billing, provisional batch reconciliation, CSV/Excel/JSON
//! importer and supplier SKU alias resolution.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::products::default_godown_id;
use crate::commands::{clamp_limit, query_json, query_one_json, require_text, scalar_i64};
use crate::db::{
    display_to_iso, expiry_display_from_key, expiry_key_from_mm_yy, get_setting, new_id, now_ms,
    today_display,
};
use crate::error::{AppError, AppResult};
use crate::services::calc_engine::{calc_net_rate, parse_scaled, round_to_rupee};

#[derive(Debug, Clone, Deserialize)]
pub struct PurchaseItemRequest {
    pub product_id: String,
    #[serde(default)]
    pub batch_id: Option<String>,
    pub batch_no: String,
    pub expiry_mm_yy: String,
    pub billed_qty: i64,
    #[serde(default)]
    pub free_deal_qty: i64,
    #[serde(default)]
    pub deal_billed: i64,
    #[serde(default)]
    pub deal_free: i64,
    #[serde(default)]
    pub mrp_scaled: i64,
    pub p_rate_scaled: i64,
    #[serde(default)]
    pub dis_bps: i64,
    #[serde(default)]
    pub tax_bps: Option<i64>,
    #[serde(default)]
    pub s_rate_scaled: i64,
    #[serde(default)]
    pub t_rate_scaled: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PurchaseSaveRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub supplier_id: String,
    #[serde(default)]
    pub sup_inv_no: Option<String>,
    #[serde(default)]
    pub inv_date_display: Option<String>,
    #[serde(default)]
    pub godown_id: Option<String>,
    #[serde(default = "credit_mode")]
    pub payment_mode: String,
    #[serde(default)]
    pub freight_scaled: i64,
    #[serde(default)]
    pub oth_adj_scaled: i64,
    #[serde(default)]
    pub paid_amt_scaled: i64,
    #[serde(default)]
    pub remarks: Option<String>,
    #[serde(default)]
    pub override_credit_lock: bool,
    pub items: Vec<PurchaseItemRequest>,
}

fn credit_mode() -> String {
    "CREDIT".to_string()
}

#[derive(Debug, Default, Deserialize)]
pub struct PurchaseListRequest {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub from_iso: Option<String>,
    #[serde(default)]
    pub to_iso: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct PurchaseIdRequest {
    pub purchase_id: String,
}

#[tauri::command]
pub fn save_purchase(
    req: PurchaseSaveRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let purchase_id = save_purchase_core(&mut conn, &device_id, req)?;
    purchase_detail_json(&conn, &purchase_id)
}

#[tauri::command]
pub fn get_purchase(
    req: PurchaseIdRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    purchase_detail_json(&conn, &req.purchase_id)
}

#[tauri::command]
pub fn list_purchases(
    req: PurchaseListRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let limit = req.limit.map(clamp_limit).unwrap_or(50);
    let offset = req.offset.unwrap_or(0).max(0) as i64;
    let from = req.from_iso.filter(|s| !s.is_empty());
    let to = req.to_iso.filter(|s| !s.is_empty());
    let query = req.query.unwrap_or_default().trim().to_string();
    let like = format!("%{}%", query.replace('%', "").replace('_', ""));
    const WHERE: &str = " p.is_deleted = 0
        AND (?1 IS NULL OR p.inv_date_iso >= ?1)
        AND (?2 IS NULL OR p.inv_date_iso <= ?2)
        AND (?3 = '' OR p.supplier_name_snapshot LIKE ?4 OR p.sup_inv_no LIKE ?4)";
    let total_count = scalar_i64(
        &conn,
        &format!("SELECT COUNT(*) FROM purchase_invoices p WHERE {WHERE}"),
        params![from, to, query, like],
    )?;
    let total_amount = scalar_i64(
        &conn,
        &format!("SELECT COALESCE(SUM(p.grand_total_scaled),0) FROM purchase_invoices p WHERE {WHERE}"),
        params![from, to, query, like],
    )?;
    let items = query_json(
        &conn,
        &format!(
            "SELECT p.*, (SELECT COUNT(*) FROM purchase_invoice_items it WHERE it.purchase_id = p.id) AS item_count
             FROM purchase_invoices p WHERE {WHERE}
             ORDER BY p.inv_date_iso DESC, p.updated_at DESC LIMIT ?5 OFFSET ?6"
        ),
        params![from, to, query, like, limit, offset],
    )?;
    Ok(json!({
        "items": items,
        "total_count": total_count,
        "total_amount_scaled": total_amount,
    }))
}

struct ResolvedPurchaseItem {
    product_id: String,
    batch_id: String,
    batch_no: String,
    expiry_mm_yy: String,
    expiry_key: i64,
    billed_qty: i64,
    free_deal_qty: i64,
    deal_billed: i64,
    deal_free: i64,
    mrp_scaled: i64,
    p_rate_scaled: i64,
    dis_bps: i64,
    tax_bps: i64,
    s_rate_scaled: i64,
    t_rate_scaled: i64,
    net_rate_scaled: i64,
    taxable_amt_scaled: i64,
    tax_amt_scaled: i64,
    line_amount_scaled: i64,
}

pub fn save_purchase_core(
    conn: &mut Connection,
    device_id: &str,
    req: PurchaseSaveRequest,
) -> AppResult<String> {
    if req.items.is_empty() {
        return Err(AppError::new(
            "EMPTY_PURCHASE",
            "Please add at least one product line item before saving the purchase.",
        ));
    }
    let payment_mode = req.payment_mode.trim().to_ascii_uppercase();
    if payment_mode != "CASH" && payment_mode != "CREDIT" {
        return Err(AppError::validation_field(
            "Payment mode must be CASH or CREDIT.",
            "payment_mode",
        ));
    }
    let invoice_date_display = req
        .inv_date_display
        .clone()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(today_display);
    let invoice_date_iso = display_to_iso(&invoice_date_display)?;
    let godown_id = match req.godown_id.clone().filter(|g| !g.is_empty()) {
        Some(id) => id,
        None => default_godown_id(conn)?,
    };

    let supplier: (String, String) = conn
        .query_row(
            "SELECT id, name FROM accounts_parties
             WHERE id = ?1 AND account_type = 'SUPPLIER' AND is_deleted = 0",
            params![req.supplier_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::validation_field("Select a valid supplier.", "supplier_id"))?;

    let tx = conn.transaction()?;
    let now = now_ms();
    let mut resolved: Vec<ResolvedPurchaseItem> = Vec::new();
    let mut gross_total = 0i64;
    let mut dis_total = 0i64;
    let mut tax_total = 0i64;

    for item in &req.items {
        if item.billed_qty <= 0 {
            return Err(AppError::validation_field(
                "Purchase quantity must be greater than zero.",
                "billed_qty",
            ));
        }
        if item.free_deal_qty < 0 || item.p_rate_scaled < 0 || item.dis_bps < 0 {
            return Err(AppError::validation_field(
                "Free quantity, purchase rate and discount cannot be negative.",
                "p_rate_scaled",
            ));
        }
        let batch_no = require_text(&item.batch_no, "batch_no", "Batch number")?.to_uppercase();
        let expiry_key = expiry_key_from_mm_yy(&item.expiry_mm_yy)?;
        let (_product_name, product_tax_bps) = tx
            .query_row(
                "SELECT p.name, COALESCE(tp.cgst_bps + tp.sgst_bps, 0)
                 FROM products p LEFT JOIN tax_plans tp ON tp.id = p.pur_tax_id
                 WHERE p.id = ?1 AND p.is_deleted = 0",
                params![item.product_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::validation_field("Product not found.", "product_id"))?;
        let tax_bps = item.tax_bps.unwrap_or(product_tax_bps);
        if !(0..=2_800).contains(&tax_bps) {
            return Err(AppError::validation_field(
                "Purchase GST rate must be between 0% and 28%.",
                "tax_bps",
            ));
        }

        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM batches WHERE product_id = ?1 AND batch_no = ?2 AND godown_id = ?3 AND is_deleted = 0",
                params![item.product_id, batch_no, godown_id],
                |r| r.get(0),
            )
            .optional()?;

        let gross = item.billed_qty * item.p_rate_scaled;
        let dis = crate::services::calc_engine::apply_bps(gross, item.dis_bps);
        let taxable = gross - dis;
        let tax = crate::services::calc_engine::apply_bps(taxable, tax_bps);
        let line_amount = taxable + tax;
        let net_rate = calc_net_rate(
            item.p_rate_scaled,
            item.deal_billed,
            item.deal_free,
            item.dis_bps,
            tax_bps,
        );

        let batch_id = match existing {
            Some(id) => id,
            None => {
                let id = new_id();
                tx.execute(
                    "INSERT INTO batches (id, product_id, batch_no, expiry_mm_yy, expiry_sort_key,
                        op_qty, deal_billed, deal_free, cur_qty, tax_stock_qty, mrp_scaled,
                        s_rate_scaled, t_rate_scaled, p_rate_scaled, dis_bps, net_rate_scaled,
                        godown_id, is_provisional, last_supplier_id, updated_at, is_deleted)
                     VALUES (?1,?2,?3,?4,?5,0,?6,?7,0,0,?8,?9,?10,?11,?12,?13,?14,0,?15,?16,0)",
                    params![
                        id, item.product_id, batch_no, expiry_display_from_key(expiry_key),
                        expiry_key, item.deal_billed, item.deal_free, item.mrp_scaled,
                        item.s_rate_scaled, item.t_rate_scaled, item.p_rate_scaled, item.dis_bps,
                        net_rate, godown_id, supplier.0, now
                    ],
                )?;
                id
            }
        };

        gross_total += gross;
        dis_total += dis;
        tax_total += tax;

        resolved.push(ResolvedPurchaseItem {
            product_id: item.product_id.clone(),
            batch_id,
            batch_no,
            expiry_mm_yy: expiry_display_from_key(expiry_key),
            expiry_key,
            billed_qty: item.billed_qty,
            free_deal_qty: item.free_deal_qty,
            deal_billed: item.deal_billed,
            deal_free: item.deal_free,
            mrp_scaled: item.mrp_scaled,
            p_rate_scaled: item.p_rate_scaled,
            dis_bps: item.dis_bps,
            tax_bps,
            s_rate_scaled: item.s_rate_scaled,
            t_rate_scaled: item.t_rate_scaled,
            net_rate_scaled: net_rate,
            taxable_amt_scaled: taxable,
            tax_amt_scaled: tax,
            line_amount_scaled: line_amount,
        });
    }

    let grand_before = resolved.iter().map(|i| i.line_amount_scaled).sum::<i64>()
        + req.freight_scaled
        + req.oth_adj_scaled;
    let grand = round_to_rupee(grand_before);
    let roundoff = grand - grand_before;
    if req.paid_amt_scaled < 0 || req.paid_amt_scaled > grand {
        return Err(AppError::validation_field(
            "Paid amount must be between zero and the grand total.",
            "paid_amt_scaled",
        ));
    }
    let paid = if payment_mode == "CASH" { grand } else { req.paid_amt_scaled };
    let due = grand - paid;

    let purchase_id = new_id();
    let sup_inv_no = match req.sup_inv_no.clone().filter(|s| !s.trim().is_empty()) {
        Some(value) => value.trim().to_string(),
        None => {
            let count = scalar_i64(&tx, "SELECT COUNT(*) FROM purchase_invoices", [])?;
            format!("P-{}", count + 1)
        }
    };

    tx.execute(
        "INSERT INTO purchase_invoices (id, sup_inv_no, inv_date_iso, inv_date_display, supplier_id,
            supplier_name_snapshot, godown_id, payment_mode, gross_total_scaled, dis_amt_scaled,
            tax_amt_scaled, freight_scaled, oth_adj_scaled, roundoff_scaled, grand_total_scaled,
            paid_amt_scaled, due_amt_scaled, remarks, updated_at, is_deleted)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,0)",
        params![
            purchase_id, sup_inv_no, invoice_date_iso, invoice_date_display, supplier.0, supplier.1,
            godown_id, payment_mode, gross_total, dis_total, tax_total, req.freight_scaled,
            req.oth_adj_scaled, roundoff, grand, paid, due, req.remarks, now
        ],
    )?;

    for (index, item) in resolved.iter().enumerate() {
        let item_id = new_id();
        tx.execute(
            "INSERT INTO purchase_invoice_items (id, purchase_id, row_order, product_id, batch_id,
                batch_no, expiry_mm_yy, expiry_sort_key, billed_qty, free_deal_qty, deal_billed,
                deal_free, mrp_scaled, p_rate_scaled, dis_bps, tax_bps, net_rate_scaled,
                taxable_amt_scaled, tax_amt_scaled, line_amount_scaled, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
            params![
                item_id, purchase_id, index as i64, item.product_id, item.batch_id, item.batch_no,
                item.expiry_mm_yy, item.expiry_key, item.billed_qty, item.free_deal_qty,
                item.deal_billed, item.deal_free, item.mrp_scaled, item.p_rate_scaled, item.dis_bps,
                item.tax_bps, item.net_rate_scaled, item.taxable_amt_scaled, item.tax_amt_scaled,
                item.line_amount_scaled, now
            ],
        )?;
        let received = item.billed_qty + item.free_deal_qty;
        tx.execute(
            "UPDATE batches SET cur_qty = cur_qty + ?1, tax_stock_qty = tax_stock_qty + ?1,
                op_qty = op_qty + ?1, p_rate_scaled = ?2, dis_bps = ?3, net_rate_scaled = ?4,
                deal_billed = ?5, deal_free = ?6, mrp_scaled = CASE WHEN ?7 > 0 THEN ?7 ELSE mrp_scaled END,
                s_rate_scaled = CASE WHEN ?8 > 0 THEN ?8 ELSE s_rate_scaled END,
                t_rate_scaled = CASE WHEN ?9 > 0 THEN ?9 ELSE t_rate_scaled END,
                expiry_mm_yy = ?10, expiry_sort_key = ?11,
                is_provisional = 0, last_supplier_id = ?12, last_purchase_inv_id = ?13,
                updated_at = ?14
             WHERE id = ?15",
            params![
                received, item.p_rate_scaled, item.dis_bps, item.net_rate_scaled,
                item.deal_billed, item.deal_free, item.mrp_scaled, item.s_rate_scaled,
                item.t_rate_scaled, item.expiry_mm_yy, item.expiry_key, supplier.0, purchase_id,
                now, item.batch_id
            ],
        )?;
        if let Some(snapshot) =
            query_one_json(&tx, "SELECT * FROM batches WHERE id = ?1", params![item.batch_id])?
        {
            crate::db::outbox::push_batch_delta(
                &tx, device_id, &item.batch_id, received, received, &snapshot,
            )?;
        }
        if let Some(snapshot) =
            query_one_json(&tx, "SELECT * FROM purchase_invoice_items WHERE id = ?1", params![item_id])?
        {
            crate::db::outbox::push_upsert(
                &tx, device_id, "purchase_invoice_items", &item_id, &snapshot,
            )?;
        }
    }

    if payment_mode == "CREDIT" && due != 0 {
        tx.execute(
            "UPDATE accounts_parties SET cur_bal_scaled = cur_bal_scaled - ?1, updated_at = ?2 WHERE id = ?3",
            params![due, now, supplier.0],
        )?;
        crate::db::outbox::push_table_row(&tx, device_id, "accounts_parties", &supplier.0)?;
        let ledger_id = new_id();
        tx.execute(
            "INSERT INTO account_ledger (id, account_id, entry_date_iso, entry_type, ref_table,
                ref_id, ref_no, dr_scaled, cr_scaled, narration, created_at)
             VALUES (?1,?2,?3,'PURCHASE','purchase_invoices',?4,?5,0,?6,?7,?8)",
            params![
                ledger_id, supplier.0, invoice_date_iso, purchase_id, sup_inv_no, due,
                format!("Purchase invoice {sup_inv_no}"), now
            ],
        )?;
        crate::db::outbox::push_table_row(&tx, device_id, "account_ledger", &ledger_id)?;
    }

    if let Some(snapshot) =
        query_one_json(&tx, "SELECT * FROM purchase_invoices WHERE id = ?1", params![purchase_id])?
    {
        crate::db::outbox::push_upsert(
            &tx, device_id, "purchase_invoices", &purchase_id, &snapshot,
        )?;
    }

    tx.commit()?;
    Ok(purchase_id)
}

pub fn purchase_detail_json(conn: &Connection, purchase_id: &str) -> AppResult<Value> {
    let purchase = query_one_json(
        conn,
        "SELECT p.*, g.code AS godown_code FROM purchase_invoices p
         LEFT JOIN godowns g ON g.id = p.godown_id
         WHERE p.id = ?1 AND p.is_deleted = 0",
        params![purchase_id],
    )?
    .ok_or_else(|| AppError::not_found("Purchase invoice not found."))?;
    let items = query_json(
        conn,
        "SELECT it.*, p.name AS product_name, p.pro_code, p.pack_form,
                COALESCE(c.name, '') AS company_name
         FROM purchase_invoice_items it
         JOIN products p ON p.id = it.product_id
         LEFT JOIN companies c ON c.id = p.company_id
         WHERE it.purchase_id = ?1 ORDER BY it.row_order",
        params![purchase_id],
    )?;
    Ok(json!({ "purchase": purchase, "items": items }))
}

// ---------------------------------------------------------------------------
// Supplier SKU aliases + bulk import
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AliasSaveRequest {
    pub supplier_id: String,
    pub alias_name: String,
    pub product_id: String,
}

#[tauri::command]
pub fn save_sku_alias(
    req: AliasSaveRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let alias = require_text(&req.alias_name, "alias_name", "Supplier SKU")?;
    let tx = conn.transaction()?;
    let now = now_ms();
    let id = new_id();
    tx.execute(
        "INSERT INTO supplier_sku_aliases (id, supplier_id, alias_name, product_id, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?5)
         ON CONFLICT(supplier_id, alias_name) DO UPDATE SET product_id = excluded.product_id, updated_at = excluded.updated_at",
        params![id, req.supplier_id, alias, req.product_id, now],
    )?;
    let snapshot = query_one_json(
        &tx,
        "SELECT * FROM supplier_sku_aliases WHERE supplier_id = ?1 AND alias_name = ?2",
        params![req.supplier_id, alias],
    )?;
    if let Some(snapshot) = snapshot {
        crate::db::outbox::push_upsert(
            &tx, &device_id, "supplier_sku_aliases", &id, &snapshot,
        )?;
    }
    tx.commit()?;
    Ok(json!({ "ok": true }))
}

#[derive(Debug, Deserialize)]
pub struct AliasListRequest {
    pub supplier_id: String,
}

#[tauri::command]
pub fn list_sku_aliases(
    req: AliasListRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let items = query_json(
        &conn,
        "SELECT a.id, a.alias_name, a.product_id, p.name AS product_name, p.pro_code
         FROM supplier_sku_aliases a JOIN products p ON p.id = a.product_id
         WHERE a.supplier_id = ?1 ORDER BY a.alias_name",
        params![req.supplier_id],
    )?;
    Ok(json!({ "items": items }))
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ImportRow {
    #[serde(default)]
    pub supplier_sku: String,
    #[serde(default)]
    pub product_name: Option<String>,
    pub batch_no: String,
    pub expiry_mm_yy: String,
    pub qty: i64,
    #[serde(default)]
    pub free_qty: i64,
    #[serde(default)]
    pub p_rate: Option<String>,
    #[serde(default)]
    pub p_rate_scaled: Option<i64>,
    #[serde(default)]
    pub mrp_scaled: Option<i64>,
    #[serde(default)]
    pub mrp: Option<String>,
    #[serde(default)]
    pub s_rate_scaled: Option<i64>,
    #[serde(default)]
    pub dis_bps: Option<i64>,
    #[serde(default)]
    pub tax_bps: Option<i64>,
    #[serde(default)]
    pub deal_billed: Option<i64>,
    #[serde(default)]
    pub deal_free: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    pub supplier_id: String,
    #[serde(default)]
    pub inv_date_display: Option<String>,
    #[serde(default)]
    pub godown_id: Option<String>,
    #[serde(default = "credit_mode")]
    pub payment_mode: String,
    #[serde(default)]
    pub create_missing_products: bool,
    pub rows: Vec<ImportRow>,
}

#[tauri::command]
pub fn import_purchase_rows(
    req: ImportRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    import_purchase_rows_internal(&mut conn, &device_id, req)
}

pub fn import_purchase_rows_internal(
    conn: &mut Connection,
    device_id: &str,
    req: ImportRequest,
) -> AppResult<Value> {
    if req.rows.is_empty() {
        return Err(AppError::validation("No rows to import."));
    }
    let supplier_name: String = conn
        .query_row(
            "SELECT name FROM accounts_parties WHERE id = ?1 AND account_type = 'SUPPLIER' AND is_deleted = 0",
            params![req.supplier_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::validation_field("Select a valid supplier.", "supplier_id"))?;

    let mut items: Vec<PurchaseItemRequest> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    let mut aliases_saved = 0i64;
    let mut created_products = 0i64;

    for row in &req.rows {
        let lookup_name = if row.supplier_sku.trim().is_empty() {
            row.product_name.clone().unwrap_or_default()
        } else {
            row.supplier_sku.clone()
        };
        if lookup_name.trim().is_empty() {
            unresolved.push("(blank row)".to_string());
            continue;
        }
        let mut product_id: Option<String> = conn
            .query_row(
                "SELECT product_id FROM supplier_sku_aliases WHERE supplier_id = ?1 AND UPPER(alias_name) = UPPER(?2)",
                params![req.supplier_id, lookup_name.trim()],
                |r| r.get(0),
            )
            .optional()?;
        if product_id.is_none() {
            product_id = crate::commands::products::resolve_product_by_name(&conn, &lookup_name)?;
        }
        if product_id.is_none() {
            if let Some(name) = &row.product_name {
                if !name.trim().is_empty() {
                    product_id = crate::commands::products::resolve_product_by_name(&conn, name)?;
                }
            }
        }
        if product_id.is_none() && req.create_missing_products {
            let name = row
                .product_name
                .clone()
                .unwrap_or_else(|| row.supplier_sku.clone());
            let save = crate::commands::products::ProductSaveRequest {
                id: None,
                pro_code: None,
                name,
                group_id: None,
                group_name: None,
                company_id: None,
                company_name: None,
                composition_id: None,
                composition_desc: None,
                pack_unit: 1,
                pack_subunit: 10,
                pack_form: "TAB".to_string(),
                case_box_qty: 1,
                hsn_code: None,
                drug_schedule: "OTC".to_string(),
                pur_tax_id: None,
                sale_tax_id: None,
                tin_tax_id: None,
                tout_tax_id: None,
                min_qty: 0,
                max_qty: 0,
                weight_grams: 0,
                batches: Vec::new(),
            };
            let created = crate::commands::products::save_product_internal(&mut *conn, device_id, save)?;
            product_id = Some(created);
            created_products += 1;
        }
        let Some(product_id) = product_id else {
            unresolved.push(lookup_name);
            continue;
        };
        if !row.supplier_sku.trim().is_empty() {
            record_alias(conn, device_id, &req.supplier_id, row.supplier_sku.trim(), &product_id)?;
            aliases_saved += 1;
        }
        let p_rate_scaled = match (row.p_rate_scaled, row.p_rate.as_deref()) {
            (Some(value), _) if value > 0 => value,
            (_, Some(text)) => parse_scaled(text)?,
            _ => 0,
        };
        if p_rate_scaled <= 0 {
            unresolved.push(format!("{lookup_name} (missing purchase rate)"));
            continue;
        }
        let mrp_scaled = match (row.mrp_scaled, row.mrp.as_deref()) {
            (Some(value), _) if value > 0 => value,
            (_, Some(text)) => parse_scaled(text)?,
            _ => 0,
        };
        items.push(PurchaseItemRequest {
            product_id,
            batch_id: None,
            batch_no: row.batch_no.clone(),
            expiry_mm_yy: row.expiry_mm_yy.clone(),
            billed_qty: row.qty,
            free_deal_qty: row.free_qty,
            deal_billed: row.deal_billed.unwrap_or(0),
            deal_free: row.deal_free.unwrap_or(0),
            mrp_scaled,
            p_rate_scaled,
            dis_bps: row.dis_bps.unwrap_or(0),
            tax_bps: row.tax_bps,
            s_rate_scaled: row.s_rate_scaled.unwrap_or(0),
            t_rate_scaled: 0,
        });
    }

    if items.is_empty() {
        return Err(AppError::validation(
            "No importable rows: every row was unresolved or missing a purchase rate.",
        ));
    }
    let row_count = items.len();
    let save = PurchaseSaveRequest {
        id: None,
        supplier_id: req.supplier_id,
        sup_inv_no: None,
        inv_date_display: req.inv_date_display,
        godown_id: req.godown_id,
        payment_mode: req.payment_mode,
        freight_scaled: 0,
        oth_adj_scaled: 0,
        paid_amt_scaled: 0,
        remarks: Some(format!("Imported from supplier file for {supplier_name}")),
        override_credit_lock: false,
        items,
    };
    let purchase_id = save_purchase_core(&mut *conn, device_id, save)?;
    let detail = purchase_detail_json(&conn, &purchase_id)?;
    Ok(json!({
        "purchase_id": purchase_id,
        "imported_lines": row_count,
        "aliases_saved": aliases_saved,
        "created_products": created_products,
        "unresolved": unresolved,
        "total_scaled": detail["purchase"]["grand_total_scaled"],
    }))
}

fn record_alias(
    conn: &mut Connection,
    device_id: &str,
    supplier_id: &str,
    alias: &str,
    product_id: &str,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    let now = now_ms();
    let id = new_id();
    tx.execute(
        "INSERT INTO supplier_sku_aliases (id, supplier_id, alias_name, product_id, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?5)
         ON CONFLICT(supplier_id, alias_name) DO UPDATE SET product_id = excluded.product_id, updated_at = excluded.updated_at",
        params![id, supplier_id, alias, product_id, now],
    )?;
    if let Some(snapshot) = query_one_json(
        &tx,
        "SELECT * FROM supplier_sku_aliases WHERE supplier_id = ?1 AND alias_name = ?2",
        params![supplier_id, alias],
    )? {
        let row_id = snapshot["id"].as_str().unwrap_or(&id).to_string();
        crate::db::outbox::push_upsert(&tx, device_id, "supplier_sku_aliases", &row_id, &snapshot)?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn seed(db: &Db) -> (String, String, String) {
        let mut conn = db.lock().unwrap();
        crate::db::demo::seed_masters(&mut conn).unwrap();
        let product_id: String = conn
            .query_row("SELECT id FROM products WHERE pro_code = 304", [], |r| r.get(0))
            .unwrap();
        let supplier_id: String = conn
            .query_row("SELECT id FROM accounts_parties WHERE code = 'S001'", [], |r| r.get(0))
            .unwrap();
        let device_id = crate::db::get_setting(&conn, "device_id").unwrap().unwrap();
        (product_id, supplier_id, device_id)
    }

    fn purchase_req(product_id: &str, supplier_id: &str, batch_no: &str, qty: i64) -> PurchaseSaveRequest {
        PurchaseSaveRequest {
            id: None,
            supplier_id: supplier_id.into(),
            sup_inv_no: Some("SUP-778".into()),
            inv_date_display: None,
            godown_id: None,
            payment_mode: "CREDIT".into(),
            freight_scaled: 0,
            oth_adj_scaled: 0,
            paid_amt_scaled: 0,
            remarks: None,
            override_credit_lock: false,
            items: vec![PurchaseItemRequest {
                product_id: product_id.into(),
                batch_id: None,
                batch_no: batch_no.into(),
                expiry_mm_yy: "11/28".into(),
                billed_qty: qty,
                free_deal_qty: 2,
                deal_billed: 10,
                deal_free: 2,
                mrp_scaled: parse_scaled("210").unwrap(),
                p_rate_scaled: parse_scaled("105").unwrap(),
                dis_bps: 1000,
                tax_bps: None,
                s_rate_scaled: parse_scaled("168").unwrap(),
                t_rate_scaled: parse_scaled("147").unwrap(),
            }],
        }
    }

    #[test]
    fn purchase_adds_stock_and_updates_payable() {
        let db = Db::open_memory().unwrap();
        let (product_id, supplier_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        let balance_before: i64 = conn
            .query_row("SELECT cur_bal_scaled FROM accounts_parties WHERE id = ?1", params![supplier_id], |r| r.get(0))
            .unwrap();
        let id = save_purchase_core(&mut conn, &device_id, purchase_req(&product_id, &supplier_id, "NEWBATCH1", 20)).unwrap();
        let detail = purchase_detail_json(&conn, &id).unwrap();
        assert_eq!(detail["items"][0]["billed_qty"], 20);
        let batch: (i64, i64, i64, i64) = conn
            .query_row(
                "SELECT cur_qty, tax_stock_qty, is_provisional, deal_billed FROM batches WHERE batch_no = 'NEWBATCH1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(batch.0, 22, "billed + free units land in stock");
        assert_eq!(batch.1, 22);
        assert_eq!(batch.2, 0);
        assert_eq!(batch.3, 10);
        let balance_after: i64 = conn
            .query_row("SELECT cur_bal_scaled FROM accounts_parties WHERE id = ?1", params![supplier_id], |r| r.get(0))
            .unwrap();
        assert!(balance_after < balance_before, "payable must increase (more negative)");
    }

    #[test]
    fn purchase_promotes_provisional_batch_instead_of_duplicating() {
        let db = Db::open_memory().unwrap();
        let (product_id, supplier_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        let godown: String = conn
            .query_row("SELECT id FROM godowns WHERE code = 'MAIN'", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO batches (id, product_id, batch_no, expiry_mm_yy, expiry_sort_key, cur_qty,
                tax_stock_qty, mrp_scaled, s_rate_scaled, p_rate_scaled, godown_id, is_provisional, updated_at)
             VALUES ('prov-1', ?1, 'PROVBATCH', '11/28', 202811, 0, 0, 2100000, 1680000, 1050000, ?2, 1, 1)",
            params![product_id, godown],
        )
        .unwrap();
        let id = save_purchase_core(&mut conn, &device_id, purchase_req(&product_id, &supplier_id, "PROVBATCH", 10)).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM batches WHERE batch_no = 'PROVBATCH'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "provisional batch must be merged, not duplicated");
        let provisional: i64 = conn
            .query_row("SELECT is_provisional FROM batches WHERE batch_no = 'PROVBATCH'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(provisional, 0);
        let detail = purchase_detail_json(&conn, &id).unwrap();
        assert_eq!(detail["purchase"]["payment_mode"], "CREDIT");
    }

    #[test]
    fn import_resolves_alias_and_creates_purchase() {
        let db = Db::open_memory().unwrap();
        let (product_id, supplier_id, device_id) = seed(&db);
        let mut conn = db.lock().unwrap();
        let req = ImportRequest {
            supplier_id: supplier_id.clone(),
            inv_date_display: None,
            godown_id: None,
            payment_mode: "CREDIT".into(),
            create_missing_products: false,
            rows: vec![ImportRow {
                supplier_sku: "MONOCEF 500".into(),
                product_name: None,
                batch_no: "IMP9001".into(),
                expiry_mm_yy: "10/28".into(),
                qty: 12,
                free_qty: 1,
                p_rate: Some("142.50".into()),
                mrp_scaled: Some(parse_scaled("285").unwrap()),
                ..Default::default()
            }],
        };
        let result = import_purchase_rows_internal(&mut conn, &device_id, req).unwrap();
        assert_eq!(result["imported_lines"], 1);
        assert!(result["purchase_id"].as_str().is_some());
        let alias_product: String = conn
            .query_row(
                "SELECT product_id FROM supplier_sku_aliases WHERE supplier_id = ?1 AND alias_name = 'MONOCEF 500'",
                params![supplier_id],
                |r| r.get(0),
            )
            .unwrap();
        let monocef: String = conn
            .query_row("SELECT id FROM products WHERE pro_code = 249", [], |r| r.get(0))
            .unwrap();
        assert_eq!(alias_product, monocef);
        let _ = product_id;
    }
}
