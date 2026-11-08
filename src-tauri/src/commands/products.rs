//! Product master commands: FTS5 search, detail, save, batch grid, lookups.

use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::{clamp_limit, query_json, query_one_json, require_text, scalar_i64, DEFAULT_LIMIT};
use crate::db::{current_expiry_key, expiry_display_from_key, expiry_key_from_mm_yy, new_id, now_ms};
use crate::error::{AppError, AppResult};
use crate::services::calc_engine::{calc_net_rate, tax_plan_total_bps};

const PRODUCT_SELECT: &str = r#"
SELECT p.id, p.pro_code, p.name, p.pack_form, p.pack_unit, p.pack_subunit, p.case_box_qty,
       p.group_id, g.name AS group_name,
       p.company_id, c.name AS company_name,
       p.composition_id, cp.description AS composition_desc,
       p.hsn_code, p.drug_schedule,
       p.min_qty, p.max_qty, p.weight_grams,
       p.pur_tax_id, pt.name AS pur_tax_name, COALESCE(pt.cgst_bps + pt.sgst_bps, 0) AS pur_tax_bps,
       p.sale_tax_id, st.name AS sale_tax_name, COALESCE(st.cgst_bps + st.sgst_bps, 0) AS sale_tax_bps,
       p.tin_tax_id, tt.name AS tin_tax_name, COALESCE(tt.cgst_bps + tt.sgst_bps, 0) AS tin_tax_bps,
       p.tout_tax_id, ot.name AS tout_tax_name, COALESCE(ot.cgst_bps + ot.sgst_bps, 0) AS tout_tax_bps,
       p.updated_at, p.is_deleted,
       COALESCE((SELECT SUM(b.cur_qty) FROM batches b WHERE b.product_id = p.id AND b.is_deleted = 0), 0) AS total_cur_qty,
       COALESCE((SELECT SUM(b.tax_stock_qty) FROM batches b WHERE b.product_id = p.id AND b.is_deleted = 0), 0) AS total_tax_qty,
       COALESCE((SELECT b.mrp_scaled FROM batches b WHERE b.product_id = p.id AND b.is_deleted = 0 ORDER BY b.updated_at DESC LIMIT 1), 0) AS mrp_scaled,
       COALESCE((SELECT b.s_rate_scaled FROM batches b WHERE b.product_id = p.id AND b.is_deleted = 0 ORDER BY b.updated_at DESC LIMIT 1), 0) AS s_rate_scaled,
       COALESCE((SELECT b.t_rate_scaled FROM batches b WHERE b.product_id = p.id AND b.is_deleted = 0 ORDER BY b.updated_at DESC LIMIT 1), 0) AS t_rate_scaled,
       COALESCE((SELECT b.p_rate_scaled FROM batches b WHERE b.product_id = p.id AND b.is_deleted = 0 ORDER BY b.updated_at DESC LIMIT 1), 0) AS p_rate_scaled,
       (SELECT COUNT(*) FROM batches b WHERE b.product_id = p.id AND b.is_deleted = 0) AS batch_count
FROM products p
LEFT JOIN product_groups g ON g.id = p.group_id
LEFT JOIN companies c ON c.id = p.company_id
LEFT JOIN compositions cp ON cp.id = p.composition_id
LEFT JOIN tax_plans pt ON pt.id = p.pur_tax_id
LEFT JOIN tax_plans st ON st.id = p.sale_tax_id
LEFT JOIN tax_plans tt ON tt.id = p.tin_tax_id
LEFT JOIN tax_plans ot ON ot.id = p.tout_tax_id
"#;

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    #[serde(default)]
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    DEFAULT_LIMIT
}

fn escape_like(input: &str) -> String {
    input.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn fts_query(input: &str) -> Option<String> {
    let tokens: Vec<String> = input
        .split_whitespace()
        .filter(|t| t.chars().count() >= 3)
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() || tokens.len() != input.split_whitespace().count() {
        return None;
    }
    Some(tokens.join(" AND "))
}

#[tauri::command]
pub fn search_products(req: SearchRequest, state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let started = Instant::now();
    let conn = state.db.lock()?;
    let limit = clamp_limit(req.limit);
    let query = req.query.trim().to_string();
    let total_products = scalar_i64(&conn, "SELECT COUNT(*) FROM products WHERE is_deleted = 0", [])?;

    let (items, total_found) = if query.is_empty() {
        let items = query_json(
            &conn,
            &format!("{PRODUCT_SELECT} WHERE p.is_deleted = 0 ORDER BY p.updated_at DESC LIMIT ?1"),
            params![limit],
        )?;
        (items, total_products)
    } else if let Some(fts) = fts_query(&query) {
        let count_sql = "SELECT COUNT(*) FROM products p WHERE p.is_deleted = 0
                         AND p.id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?1)";
        let total = scalar_i64(&conn, count_sql, params![fts])?;
        let items = query_json(
            &conn,
            &format!(
                "{PRODUCT_SELECT} WHERE p.is_deleted = 0
                 AND p.id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?1)
                 ORDER BY p.name LIMIT ?2"
            ),
            params![fts, limit],
        )?;
        (items, total)
    } else {
        let like = format!("%{}%", escape_like(&query));
        let numeric: Option<i64> = query.parse().ok();
        let count_sql = "SELECT COUNT(*) FROM products p WHERE p.is_deleted = 0
                         AND (p.name LIKE ?1 ESCAPE '\\' OR CAST(p.pro_code AS TEXT) LIKE ?1 ESCAPE '\\'
                              OR (?2 IS NOT NULL AND p.pro_code = ?2))";
        let total = scalar_i64(&conn, count_sql, params![like, numeric])?;
        let items = query_json(
            &conn,
            &format!(
                "{PRODUCT_SELECT} WHERE p.is_deleted = 0
                 AND (p.name LIKE ?1 ESCAPE '\\' OR CAST(p.pro_code AS TEXT) LIKE ?1 ESCAPE '\\'
                      OR (?2 IS NOT NULL AND p.pro_code = ?2))
                 ORDER BY p.name LIMIT ?3"
            ),
            params![like, numeric, limit],
        )?;
        (items, total)
    };

    Ok(json!({
        "items": items,
        "total_found": total_found,
        "total_products": total_products,
        "elapsed_ms": started.elapsed().as_secs_f64() * 1000.0,
    }))
}

#[derive(Debug, Deserialize)]
pub struct GetProductRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub pro_code: Option<i64>,
}

#[tauri::command]
pub fn get_product(req: GetProductRequest, state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let product_id = resolve_product_id(&conn, req.id.as_deref(), req.pro_code)?;
    product_detail_json(&conn, &product_id)
}

pub fn resolve_product_id(
    conn: &Connection,
    id: Option<&str>,
    pro_code: Option<i64>,
) -> AppResult<String> {
    if let Some(id) = id {
        let exists: Option<String> = conn
            .query_row("SELECT id FROM products WHERE id = ?1 AND is_deleted = 0", params![id], |r| r.get(0))
            .optional()?;
        if let Some(id) = exists {
            return Ok(id);
        }
    }
    if let Some(code) = pro_code {
        let found: Option<String> = conn
            .query_row("SELECT id FROM products WHERE pro_code = ?1 AND is_deleted = 0", params![code], |r| r.get(0))
            .optional()?;
        if let Some(id) = found {
            return Ok(id);
        }
    }
    Err(AppError::not_found("Product not found."))
}

pub fn product_detail_json(conn: &Connection, product_id: &str) -> AppResult<Value> {
    let product = query_one_json(
        conn,
        &format!("{PRODUCT_SELECT} WHERE p.id = ?1"),
        params![product_id],
    )?
    .ok_or_else(|| AppError::not_found("Product not found."))?;

    let batches = batch_rows_json(conn, product_id)?;
    let total_value: i64 = batches
        .iter()
        .filter_map(|b| b.get("cur_qty").and_then(|v| v.as_i64()))
        .zip(batches.iter().filter_map(|b| b.get("p_rate_scaled").and_then(|v| v.as_i64())))
        .map(|(qty, rate)| qty * rate)
        .sum();

    Ok(json!({
        "product": product,
        "batches": batches,
        "stats": {
            "batch_count": batches.len(),
            "total_cur_qty": batches.iter().filter_map(|b| b.get("cur_qty").and_then(|v| v.as_i64())).sum::<i64>(),
            "total_tax_qty": batches.iter().filter_map(|b| b.get("tax_stock_qty").and_then(|v| v.as_i64())).sum::<i64>(),
            "stock_value_scaled": total_value,
        }
    }))
}

pub fn batch_rows_json(conn: &Connection, product_id: &str) -> AppResult<Vec<Value>> {
    let rows = query_json(
        conn,
        "SELECT b.id, b.product_id, b.batch_no, b.expiry_mm_yy, b.expiry_sort_key, b.op_qty,
                b.deal_billed, b.deal_free, b.cur_qty, b.tax_stock_qty,
                b.mrp_scaled, b.s_rate_scaled, b.t_rate_scaled, b.p_rate_scaled, b.dis_bps,
                b.net_rate_scaled, b.godown_id, gd.code AS godown_code, gd.name AS godown_name,
                b.is_provisional, b.last_supplier_id, b.updated_at, b.is_deleted
         FROM batches b
         JOIN godowns gd ON gd.id = b.godown_id
         WHERE b.product_id = ?1 AND b.is_deleted = 0
         ORDER BY b.expiry_sort_key ASC, b.batch_no ASC",
        params![product_id],
    )?;
    Ok(rows.into_iter().map(|mut row| decorate_batch(&mut row)).collect())
}

fn decorate_batch(row: &mut Value) -> Value {
    let current = current_expiry_key();
    let expiry = row.get("expiry_sort_key").and_then(|v| v.as_i64()).unwrap_or(0);
    let near_threshold = add_months(current, 3);
    let billed = row.get("deal_billed").and_then(|v| v.as_i64()).unwrap_or(0);
    let free = row.get("deal_free").and_then(|v| v.as_i64()).unwrap_or(0);
    if let Some(obj) = row.as_object_mut() {
        obj.insert("is_expired".into(), json!(expiry < current));
        obj.insert("is_near_expiry".into(), json!(expiry <= near_threshold));
        obj.insert(
            "deal_str".into(),
            json!(if billed > 0 { format!("{billed}+{free}") } else { String::new() }),
        );
        obj.insert("expiry_display".into(), json!(expiry_display_from_key(expiry)));
    }
    row.clone()
}

fn add_months(key: i64, months: i64) -> i64 {
    let year = key / 100;
    let month = key % 100;
    let total = year * 12 + (month - 1) + months;
    total.div_euclid(12) * 100 + total.rem_euclid(12) + 1
}

#[tauri::command]
pub fn next_product_code(state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let code = scalar_i64(
        &conn,
        "SELECT COALESCE(MAX(pro_code), 0) + 1 FROM products",
        [],
    )?;
    Ok(json!({ "pro_code": code }))
}

#[derive(Debug, Clone, Deserialize)]
pub struct BatchSaveRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub batch_no: String,
    pub expiry_mm_yy: String,
    #[serde(default)]
    pub op_qty: i64,
    #[serde(default)]
    pub deal_billed: i64,
    #[serde(default)]
    pub deal_free: i64,
    #[serde(default)]
    pub cur_qty: i64,
    #[serde(default)]
    pub tax_stock_qty: i64,
    #[serde(default)]
    pub mrp_scaled: i64,
    #[serde(default)]
    pub s_rate_scaled: i64,
    #[serde(default)]
    pub t_rate_scaled: i64,
    #[serde(default)]
    pub p_rate_scaled: i64,
    #[serde(default)]
    pub dis_bps: i64,
    #[serde(default)]
    pub godown_id: Option<String>,
    #[serde(default)]
    pub is_provisional: bool,
    #[serde(default)]
    pub last_supplier_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProductSaveRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub pro_code: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub company_id: Option<String>,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub composition_id: Option<String>,
    #[serde(default)]
    pub composition_desc: Option<String>,
    #[serde(default = "one")]
    pub pack_unit: i64,
    #[serde(default = "ten")]
    pub pack_subunit: i64,
    #[serde(default = "default_form")]
    pub pack_form: String,
    #[serde(default = "one")]
    pub case_box_qty: i64,
    #[serde(default)]
    pub hsn_code: Option<String>,
    #[serde(default = "default_schedule")]
    pub drug_schedule: String,
    #[serde(default)]
    pub pur_tax_id: Option<String>,
    #[serde(default)]
    pub sale_tax_id: Option<String>,
    #[serde(default)]
    pub tin_tax_id: Option<String>,
    #[serde(default)]
    pub tout_tax_id: Option<String>,
    #[serde(default)]
    pub min_qty: i64,
    #[serde(default)]
    pub max_qty: i64,
    #[serde(default)]
    pub weight_grams: i64,
    #[serde(default)]
    pub batches: Vec<BatchSaveRequest>,
}

fn one() -> i64 {
    1
}
fn ten() -> i64 {
    10
}
fn default_form() -> String {
    "TAB".to_string()
}
fn default_schedule() -> String {
    "OTC".to_string()
}

pub const PACK_FORMS: &[&str] = &["TAB", "CAP", "SYP", "INJ", "DROP", "LIQ", "OINT", "GEN"];
pub const DRUG_SCHEDULES: &[&str] = &["OTC", "H", "H1", "X", "NARCOTIC", "COLD_CHAIN"];

#[tauri::command]
pub fn save_product(
    req: ProductSaveRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = crate::db::get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let id = save_product_internal(&mut conn, &device_id, req)?;
    product_detail_json(&conn, &id)
}

/// Shared product save used by the command and the purchase importer.
pub fn save_product_internal(
    conn: &mut Connection,
    device_id: &str,
    req: ProductSaveRequest,
) -> AppResult<String> {
    let name = require_text(&req.name, "name", "Product name")?;
    let pack_form = req.pack_form.trim().to_ascii_uppercase();
    if !PACK_FORMS.contains(&pack_form.as_str()) {
        return Err(AppError::validation_field(
            format!("Pack form must be one of {}.", PACK_FORMS.join(", ")),
            "pack_form",
        ));
    }
    let schedule = req.drug_schedule.trim().to_ascii_uppercase();
    let schedule = if DRUG_SCHEDULES.contains(&schedule.as_str()) { schedule } else { "OTC".to_string() };
    if req.pack_unit <= 0 || req.pack_subunit <= 0 || req.case_box_qty <= 0 {
        return Err(AppError::validation_field(
            "Pack unit, subunit and case/box quantity must be positive.",
            "pack_unit",
        ));
    }

    let tx = conn.transaction()?;
    let now = now_ms();

    let group_id = match (&req.group_id, &req.group_name) {
        (Some(id), _) if !id.is_empty() => Some(id.clone()),
        (_, Some(group)) if !group.trim().is_empty() => Some(ensure_group(&tx, group.trim(), now)?),
        _ => None,
    };
    let company_id = match (&req.company_id, &req.company_name) {
        (Some(id), _) if !id.is_empty() => Some(id.clone()),
        (_, Some(company)) if !company.trim().is_empty() => {
            Some(ensure_company(&tx, company.trim(), now)?)
        }
        _ => None,
    };
    let composition_id = match (&req.composition_id, &req.composition_desc) {
        (Some(id), _) if !id.is_empty() => Some(id.clone()),
        (_, Some(desc)) if !desc.trim().is_empty() => {
            Some(ensure_composition(&tx, desc.trim(), now)?)
        }
        _ => None,
    };

    let existing_id: Option<String> = match &req.id {
        Some(id) if !id.is_empty() => {
            let found: Option<String> = tx
                .query_row("SELECT id FROM products WHERE id = ?1", params![id], |r| r.get(0))
                .optional()?;
            if found.is_none() {
                return Err(AppError::not_found("Product to update was not found."));
            }
            found
        }
        _ => None,
    };

    let pro_code = match existing_id.as_ref() {
        Some(id) => {
            let current: i64 =
                tx.query_row("SELECT pro_code FROM products WHERE id = ?1", params![id], |r| r.get(0))?;
            if let Some(requested) = req.pro_code {
                if requested != current {
                    let conflict: Option<String> = tx
                        .query_row(
                            "SELECT id FROM products WHERE pro_code = ?1 AND id <> ?2",
                            params![requested, id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if conflict.is_some() {
                        return Err(AppError::with_field(
                            "DUPLICATE",
                            format!("Pro. Code {requested} is already used by another product."),
                            "pro_code",
                        ));
                    }
                }
            }
            req.pro_code.unwrap_or(current)
        }
        None => {
            let requested = match req.pro_code {
                Some(code) if code > 0 => code,
                _ => scalar_i64(
                    &tx,
                    "SELECT COALESCE(MAX(pro_code), 0) + 1 FROM products",
                    [],
                )?,
            };
            let conflict: Option<String> = tx
                .query_row("SELECT id FROM products WHERE pro_code = ?1", params![requested], |r| r.get(0))
                .optional()?;
            if conflict.is_some() {
                return Err(AppError::with_field(
                    "DUPLICATE",
                    format!("Pro. Code {requested} is already used by another product."),
                    "pro_code",
                ));
            }
            requested
        }
    };

    let product_id = match existing_id {
        Some(id) => {
            tx.execute(
                "UPDATE products SET pro_code=?1, name=?2, group_id=?3, pack_unit=?4, pack_subunit=?5,
                    pack_form=?6, case_box_qty=?7, composition_id=?8, company_id=?9, hsn_code=?10,
                    drug_schedule=?11, pur_tax_id=?12, sale_tax_id=?13, tin_tax_id=?14, tout_tax_id=?15,
                    min_qty=?16, max_qty=?17, weight_grams=?18, updated_at=?19
                 WHERE id=?20",
                params![
                    pro_code, name, group_id, req.pack_unit, req.pack_subunit, pack_form,
                    req.case_box_qty, composition_id, company_id, req.hsn_code, schedule,
                    req.pur_tax_id, req.sale_tax_id, req.tin_tax_id, req.tout_tax_id,
                    req.min_qty, req.max_qty, req.weight_grams, now, id
                ],
            )?;
            id
        }
        None => {
            let id = new_id();
            tx.execute(
                "INSERT INTO products (id, pro_code, name, group_id, pack_unit, pack_subunit, pack_form,
                    case_box_qty, composition_id, company_id, hsn_code, drug_schedule,
                    pur_tax_id, sale_tax_id, tin_tax_id, tout_tax_id, min_qty, max_qty, weight_grams,
                    updated_at, is_deleted)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,0)",
                params![
                    id, pro_code, name, group_id, req.pack_unit, req.pack_subunit, pack_form,
                    req.case_box_qty, composition_id, company_id, req.hsn_code, schedule,
                    req.pur_tax_id, req.sale_tax_id, req.tin_tax_id, req.tout_tax_id,
                    req.min_qty, req.max_qty, req.weight_grams, now
                ],
            )?;
            id
        }
    };

    let pur_tax_bps = if let Some(tax_id) = &req.pur_tax_id {
        tax_bps_for_plan(&tx, tax_id)?
    } else {
        0
    };

    let default_godown = default_godown_id(&tx)?;

    for batch in &req.batches {
        let batch_no = require_text(&batch.batch_no, "batch_no", "Batch number")?;
        let expiry_key = expiry_key_from_mm_yy(&batch.expiry_mm_yy)?;
        let godown_id = batch.godown_id.clone().unwrap_or_else(|| default_godown.clone());
        let net_rate = calc_net_rate(
            batch.p_rate_scaled,
            batch.deal_billed,
            batch.deal_free,
            batch.dis_bps,
            pur_tax_bps,
        );
        let conflict: Option<String> = tx
            .query_row(
                "SELECT id FROM batches WHERE product_id = ?1 AND batch_no = ?2 AND godown_id = ?3 AND is_deleted = 0",
                params![product_id, batch_no, godown_id],
                |r| r.get(0),
            )
            .optional()?;
        if let (Some(conflict_id), Some(requested_id)) = (&conflict, &batch.id) {
            if conflict_id != requested_id {
                return Err(AppError::with_field(
                    "DUPLICATE",
                    format!("Batch {batch_no} already exists in this godown."),
                    "batch_no",
                ));
            }
        }
        let batch_id = match &batch.id {
            Some(id) if !id.is_empty() => {
                tx.execute(
                    "UPDATE batches SET batch_no=?1, expiry_mm_yy=?2, expiry_sort_key=?3, op_qty=?4,
                        deal_billed=?5, deal_free=?6, cur_qty=?7, tax_stock_qty=?8, mrp_scaled=?9,
                        s_rate_scaled=?10, t_rate_scaled=?11, p_rate_scaled=?12, dis_bps=?13,
                        net_rate_scaled=?14, godown_id=?15, is_provisional=?16, last_supplier_id=?17,
                        updated_at=?18
                     WHERE id=?19 AND product_id=?20",
                    params![
                        batch_no, expiry_display_from_key(expiry_key), expiry_key, batch.op_qty,
                        batch.deal_billed, batch.deal_free, batch.cur_qty, batch.tax_stock_qty,
                        batch.mrp_scaled, batch.s_rate_scaled, batch.t_rate_scaled, batch.p_rate_scaled,
                        batch.dis_bps, net_rate, godown_id, batch.is_provisional as i64,
                        batch.last_supplier_id, now, id, product_id
                    ],
                )?;
                id.clone()
            }
            _ => {
                if let Some(existing) = conflict {
                    tx.execute(
                        "UPDATE batches SET batch_no=?1, expiry_mm_yy=?2, expiry_sort_key=?3, op_qty=?4,
                            deal_billed=?5, deal_free=?6, cur_qty=?7, tax_stock_qty=?8, mrp_scaled=?9,
                            s_rate_scaled=?10, t_rate_scaled=?11, p_rate_scaled=?12, dis_bps=?13,
                            net_rate_scaled=?14, godown_id=?15, is_provisional=?16, last_supplier_id=?17,
                            updated_at=?18
                         WHERE id=?19",
                        params![
                            batch_no, expiry_display_from_key(expiry_key), expiry_key, batch.op_qty,
                            batch.deal_billed, batch.deal_free, batch.cur_qty, batch.tax_stock_qty,
                            batch.mrp_scaled, batch.s_rate_scaled, batch.t_rate_scaled, batch.p_rate_scaled,
                            batch.dis_bps, net_rate, godown_id, batch.is_provisional as i64,
                            batch.last_supplier_id, now, existing
                        ],
                    )?;
                    existing
                } else {
                    let id = new_id();
                    tx.execute(
                        "INSERT INTO batches (id, product_id, batch_no, expiry_mm_yy, expiry_sort_key,
                            op_qty, deal_billed, deal_free, cur_qty, tax_stock_qty, mrp_scaled,
                            s_rate_scaled, t_rate_scaled, p_rate_scaled, dis_bps, net_rate_scaled,
                            godown_id, is_provisional, last_supplier_id, updated_at, is_deleted)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,0)",
                        params![
                            id, product_id, batch_no, expiry_display_from_key(expiry_key), expiry_key,
                            batch.op_qty, batch.deal_billed, batch.deal_free, batch.cur_qty,
                            batch.tax_stock_qty, batch.mrp_scaled, batch.s_rate_scaled,
                            batch.t_rate_scaled, batch.p_rate_scaled, batch.dis_bps, net_rate,
                            godown_id, batch.is_provisional as i64, batch.last_supplier_id, now
                        ],
                    )?;
                    id
                }
            }
        };

        if let Some(snapshot) = query_one_json(
            &tx,
            "SELECT * FROM batches WHERE id = ?1",
            params![batch_id],
        )? {
            crate::db::outbox::push_upsert(&tx, &device_id, "batches", &batch_id, &snapshot)?;
        }
    }

    for (table, lookup_id) in [
        ("product_groups", group_id.as_deref()),
        ("companies", company_id.as_deref()),
        ("compositions", composition_id.as_deref()),
    ] {
        if let Some(id) = lookup_id {
            crate::db::outbox::push_table_row(&tx, device_id, table, id)?;
        }
    }
    if let Some(snapshot) = query_one_json(&tx, "SELECT * FROM products WHERE id = ?1", params![product_id])? {
        crate::db::outbox::push_upsert(&tx, &device_id, "products", &product_id, &snapshot)?;
    }
    tx.commit()?;
    Ok(product_id)
}

pub fn default_godown_id(conn: &Connection) -> AppResult<String> {
    conn.query_row(
        "SELECT id FROM godowns WHERE is_deleted = 0 ORDER BY is_default DESC, code ASC LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .ok_or_else(|| AppError::validation("No godown is configured. Add one under Setup."))
}

fn tax_bps_for_plan(conn: &Connection, tax_id: &str) -> AppResult<i64> {
    let row = conn
        .query_row(
            "SELECT cgst_bps, sgst_bps, igst_bps FROM tax_plans WHERE id = ?1",
            params![tax_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::validation_field("Tax plan not found.", "tax"))?;
    Ok(tax_plan_total_bps(row.0, row.1, row.2))
}

#[tauri::command]
pub fn delete_product(
    req: GetProductRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = crate::db::get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let product_id = resolve_product_id(&conn, req.id.as_deref(), req.pro_code)?;
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE products SET is_deleted = 1, updated_at = ?1 WHERE id = ?2",
        params![now_ms(), product_id],
    )?;
    crate::db::outbox::push_delete(&tx, &device_id, "products", &product_id)?;
    tx.commit()?;
    Ok(json!({ "ok": true }))
}

#[derive(Debug, Deserialize)]
pub struct LookupListRequest {
    pub kind: String,
}

#[tauri::command]
pub fn list_lookups(
    req: LookupListRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let items: Vec<Value> = match req.kind.as_str() {
        "groups" => query_json(
            &conn,
            "SELECT id, code, name FROM product_groups WHERE is_deleted = 0 ORDER BY name",
            [],
        )?,
        "companies" => query_json(
            &conn,
            "SELECT id, code, name, short_name AS description FROM companies WHERE is_deleted = 0 ORDER BY name",
            [],
        )?,
        "compositions" => query_json(
            &conn,
            "SELECT id, code, description AS name, description FROM compositions WHERE is_deleted = 0 ORDER BY description",
            [],
        )?,
        "tax_plans" => query_json(
            &conn,
            "SELECT id, name AS code, name, cgst_bps, sgst_bps, igst_bps,
                    (cgst_bps + sgst_bps) AS total_bps
             FROM tax_plans WHERE is_deleted = 0
             ORDER BY (cgst_bps + sgst_bps)",
            [],
        )?,
        "godowns" => query_json(
            &conn,
            "SELECT id, code, name, is_default FROM godowns WHERE is_deleted = 0 ORDER BY is_default DESC, name",
            [],
        )?,
        "series" => query_json(
            &conn,
            "SELECT id, series_code AS code, series_name AS name, is_estimate, next_inv_no
             FROM invoice_series WHERE is_deleted = 0 ORDER BY is_estimate DESC",
            [],
        )?,
        "schedules" => DRUG_SCHEDULES
            .iter()
            .map(|s| json!({ "id": s, "code": s, "name": s }))
            .collect(),
        "pack_forms" => PACK_FORMS
            .iter()
            .map(|s| json!({ "id": s, "code": s, "name": s }))
            .collect(),
        other => {
            return Err(AppError::validation(format!("Unknown lookup kind '{other}'.")));
        }
    };
    Ok(json!({ "items": items }))
}

#[derive(Debug, Deserialize)]
pub struct LookupSaveRequest {
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_default: Option<bool>,
}

#[tauri::command]
pub fn save_lookup(
    req: LookupSaveRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let device_id = crate::db::get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let now = now_ms();
    let tx = conn.transaction()?;
    let display_name = req
        .name
        .clone()
        .or_else(|| req.description.clone())
        .unwrap_or_default();
    let name = require_text(&display_name, "name", "Name")?;
    let id = match req.kind.as_str() {
        "companies" => {
            let id = upsert_lookup(&tx, "companies", req.id.as_deref(), req.code.as_deref(), &name, now, |tx, id| {
                tx.execute(
                    "UPDATE companies SET name = ?1, short_name = ?2, updated_at = ?3 WHERE id = ?4",
                    params![&name, &req.description, now, id],
                )?;
                Ok(())
            })?;
            id
        }
        "groups" => upsert_lookup(&tx, "product_groups", req.id.as_deref(), req.code.as_deref(), &name, now, |tx, id| {
            tx.execute(
                "UPDATE product_groups SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![&name, now, id],
            )?;
            Ok(())
        })?,
        "compositions" => upsert_lookup(
            &tx,
            "compositions",
            req.id.as_deref(),
            req.code.as_deref(),
            &name,
            now,
            |tx, id| {
                tx.execute(
                    "UPDATE compositions SET description = ?1, updated_at = ?2 WHERE id = ?3",
                    params![&name, now, id],
                )?;
                Ok(())
            },
        )?,
        "godowns" => {
            let id = upsert_lookup(&tx, "godowns", req.id.as_deref(), req.code.as_deref(), &name, now, |tx, id| {
                tx.execute(
                    "UPDATE godowns SET name = ?1, is_default = ?2, updated_at = ?3 WHERE id = ?4",
                    params![&name, req.is_default.unwrap_or(false) as i64, now, id],
                )?;
                Ok(())
            })?;
            if req.is_default.unwrap_or(false) {
                tx.execute("UPDATE godowns SET is_default = 0 WHERE id <> ?1", params![&id])?;
            }
            id
        }
        other => {
            return Err(AppError::validation(format!(
                "Lookup kind '{other}' cannot be edited here."
            )))
        }
    };
    let snapshot = crate::commands::query_one_json(&tx, &lookup_select(&req.kind), params![id])?;
    if let Some(snapshot) = snapshot {
        let table = match req.kind.as_str() {
            "groups" => "product_groups",
            "companies" => "companies",
            "compositions" => "compositions",
            "godowns" => "godowns",
            _ => "app_settings",
        };
        crate::db::outbox::push_upsert(&tx, &device_id, table, &id, &snapshot)?;
    }
    tx.commit()?;
    Ok(json!({ "id": id, "name": name }))
}

fn lookup_select(kind: &str) -> String {
    match kind {
        "groups" => "SELECT id, code, name FROM product_groups WHERE id = ?1".into(),
        "companies" => "SELECT id, code, name, short_name AS description FROM companies WHERE id = ?1".into(),
        "compositions" => {
            "SELECT id, code, description AS name, description FROM compositions WHERE id = ?1".into()
        }
        "godowns" => "SELECT id, code, name, is_default FROM godowns WHERE id = ?1".into(),
        _ => "SELECT id, code, name FROM product_groups WHERE id = ?1".into(),
    }
}

fn upsert_lookup<F>(
    tx: &Transaction,
    table: &str,
    id: Option<&str>,
    code: Option<&str>,
    name: &str,
    now: i64,
    update: F,
) -> AppResult<String>
where
    F: FnOnce(&Transaction, &str) -> AppResult<()>,
{
    if let Some(id) = id {
        update(tx, id)?;
        return Ok(id.to_string());
    }
    let base_code = code
        .map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| sanitize_code(name));
    let mut candidate = base_code.clone();
    let mut suffix = 2;
    loop {
        let exists: Option<String> = tx
            .query_row(&format!("SELECT id FROM {table} WHERE code = ?1"), params![candidate], |r| r.get(0))
            .optional()?;
        if exists.is_none() {
            break;
        }
        candidate = format!("{base_code}{suffix}");
        suffix += 1;
    }
    let id = new_id();
    let sql = match table {
        "companies" => "INSERT INTO companies (id, code, name, short_name, updated_at, is_deleted) VALUES (?1,?2,?3,NULL,?4,0)",
        "godowns" => "INSERT INTO godowns (id, code, name, is_default, updated_at, is_deleted) VALUES (?1,?2,?3,0,?4,0)",
        "compositions" => "INSERT INTO compositions (id, code, description, updated_at, is_deleted) VALUES (?1,?2,?3,?4,0)",
        _ => "INSERT INTO product_groups (id, code, name, updated_at, is_deleted) VALUES (?1,?2,?3,?4,0)",
    };
    tx.execute(sql, params![id, candidate, name, now])?;
    Ok(id)
}

fn sanitize_code(name: &str) -> String {
    let mut code: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(10)
        .collect::<String>()
        .to_ascii_uppercase();
    if code.is_empty() {
        code = "GEN".to_string();
    }
    code
}

fn ensure_group(tx: &Transaction, name: &str, now: i64) -> AppResult<String> {
    let existing: Option<String> = tx
        .query_row("SELECT id FROM product_groups WHERE UPPER(name) = UPPER(?1)", params![name], |r| r.get(0))
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    upsert_lookup(tx, "product_groups", None, None, name, now, |_, _| Ok(()))
}

fn ensure_company(tx: &Transaction, name: &str, now: i64) -> AppResult<String> {
    let existing: Option<String> = tx
        .query_row("SELECT id FROM companies WHERE UPPER(name) = UPPER(?1)", params![name], |r| r.get(0))
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    upsert_lookup(tx, "companies", None, None, name, now, |_, _| Ok(()))
}

fn ensure_composition(tx: &Transaction, description: &str, now: i64) -> AppResult<String> {
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM compositions WHERE UPPER(description) = UPPER(?1)",
            params![description],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    upsert_lookup(tx, "compositions", None, None, description, now, |_, _| Ok(()))
}

/// Used by other command modules that need to resolve a name to an id.
pub fn resolve_product_by_name(conn: &Connection, name: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM products WHERE is_deleted = 0 AND UPPER(name) = UPPER(?1) LIMIT 1",
            params![name.trim()],
            |r| r.get(0),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn seed_products(conn: &Connection, total: i64) {
        let now = now_ms();
        conn.execute(
            "INSERT INTO companies (id, code, name, updated_at) VALUES ('co1','CO1','CIPLA',?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO compositions (id, code, description, updated_at) VALUES ('cmp1','CMP1','Ceftriaxone 500mg',?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO product_groups (id, code, name, updated_at) VALUES ('grp1','G1','ANTIBIOTICS',?1)",
            params![now],
        )
        .unwrap();
        let tax_id: String = conn
            .query_row("SELECT id FROM tax_plans WHERE name = 'GST-12'", [], |r| r.get(0))
            .unwrap();
        let godown: String = conn
            .query_row("SELECT id FROM godowns WHERE code='MAIN'", [], |r| r.get(0))
            .unwrap();
        for i in 0..total {
            let id = format!("p{i}");
            let name = if i == 0 {
                "MONOCEF 500 VIAL".to_string()
            } else {
                format!("DEMO MEDICINE {i:05} TAB")
            };
            conn.execute(
                "INSERT INTO products (id, pro_code, name, group_id, pack_form, composition_id, company_id,
                    sale_tax_id, pur_tax_id, updated_at)
                 VALUES (?1, ?2, ?3, 'grp1', 'TAB', 'cmp1', 'co1', ?4, ?4, ?5)",
                params![id, 1000 + i, name, tax_id, now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO batches (id, product_id, batch_no, expiry_mm_yy, expiry_sort_key,
                    cur_qty, tax_stock_qty, mrp_scaled, s_rate_scaled, p_rate_scaled, godown_id, updated_at)
                 VALUES (?1, ?2, ?3, '12/27', 202712, 10, 10, 100000, 90000, 50000, ?4, ?5)",
                params![format!("b{i}"), id, format!("B{i}"), godown, now],
            )
            .unwrap();
        }
    }

    #[test]
    fn fts_search_finds_products_and_counts() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        seed_products(&conn, 100);
        let query = fts_query("monocef").unwrap();
        let count = scalar_i64(
            &conn,
            "SELECT COUNT(*) FROM products p WHERE p.is_deleted=0
             AND p.id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?1)",
            params![query],
        )
        .unwrap();
        assert_eq!(count, 1);
        let rows = query_json(
            &conn,
            &format!("{PRODUCT_SELECT} WHERE p.is_deleted=0
                      AND p.id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?1)"),
            params![query],
        )
        .unwrap();
        assert_eq!(rows[0]["name"], "MONOCEF 500 VIAL");
        assert_eq!(rows[0]["total_cur_qty"], 10);
    }

    #[test]
    fn short_queries_fall_back_to_like() {
        assert!(fts_query("mo").is_none());
        assert!(fts_query("monocef 500").is_some());
        assert!(fts_query("ab").is_none());
    }

    #[test]
    fn thirteen_thousand_products_search_stays_fast() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        seed_products(&conn, 13_000);
        let started = Instant::now();
        let query = fts_query("medicine 129").or_else(|| fts_query("demo")).unwrap();
        let count = scalar_i64(
            &conn,
            "SELECT COUNT(*) FROM products p WHERE p.is_deleted=0
             AND p.id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?1)",
            params![query],
        )
        .unwrap();
        let elapsed = started.elapsed();
        assert!(count > 0);
        // Generous bound for CI; the SRD target is <5ms on warm caches.
        assert!(elapsed.as_millis() < 500, "search took {elapsed:?}");
    }
}
