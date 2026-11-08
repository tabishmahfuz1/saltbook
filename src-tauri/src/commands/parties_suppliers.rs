//! Party (customer) and Supplier master commands, including credit locking.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::{clamp_limit, query_json, query_one_json, require_text, scalar_i64, DEFAULT_LIMIT};
use crate::db::{get_setting, new_id, now_ms, today_display};
use crate::error::{AppError, AppResult};
use crate::services::validation::{validate_gstin, validate_pan, validate_phone};

#[derive(Debug, Deserialize)]
pub struct AccountSearchRequest {
    pub account_type: String,
    #[serde(default)]
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    DEFAULT_LIMIT
}

fn normalize_type(value: &str) -> AppResult<String> {
    let kind = value.trim().to_ascii_uppercase();
    if kind == "PARTY" || kind == "SUPPLIER" {
        Ok(kind)
    } else {
        Err(AppError::validation_field(
            "Account type must be PARTY or SUPPLIER.",
            "account_type",
        ))
    }
}

#[tauri::command]
pub fn search_accounts(
    req: AccountSearchRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let account_type = normalize_type(&req.account_type)?;
    let conn = state.db.lock()?;
    let limit = clamp_limit(req.limit);
    let query = req.query.trim().to_string();
    let like = format!("%{}%", query.replace('%', "").replace('_', ""));
    let total = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM accounts_parties
         WHERE account_type = ?1 AND is_deleted = 0
           AND (?2 = '' OR name LIKE ?3 OR code LIKE ?3 OR city LIKE ?3 OR gst_no LIKE ?3)",
        params![account_type, query, like],
    )?;
    let items = query_json(
        &conn,
        "SELECT a.id, a.account_type, a.code, a.name, a.city, a.phone_office, a.gst_no, a.pan_aadhar,
                a.billing_on_rate, a.status, a.is_inter_state, a.cur_bal_scaled, a.cr_limit_scaled,
                a.cr_days, a.locking_days, a.bills_for_locking, a.op_bal_dr_scaled, a.op_bal_cr_scaled,
                a.updated_at,
                (SELECT COUNT(*) FROM sales_invoices i
                 WHERE i.party_id = a.id AND i.is_deleted = 0 AND i.due_amt_scaled > 0
                   AND i.payment_mode = 'CREDIT') AS open_bills
         FROM accounts_parties a
         WHERE a.account_type = ?1 AND a.is_deleted = 0
           AND (?2 = '' OR a.name LIKE ?3 OR a.code LIKE ?3 OR a.city LIKE ?3 OR a.gst_no LIKE ?3)
         ORDER BY a.name LIMIT ?4",
        params![account_type, query, like, limit],
    )?;
    Ok(json!({ "items": items, "total_found": total }))
}

#[derive(Debug, Deserialize)]
pub struct GetAccountRequest {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}

#[tauri::command]
pub fn get_account(
    req: GetAccountRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let id = resolve_account_id(&conn, req.id.as_deref(), req.code.as_deref())?;
    account_detail_json(&conn, &id)
}

pub fn resolve_account_id(
    conn: &Connection,
    id: Option<&str>,
    code: Option<&str>,
) -> AppResult<String> {
    if let Some(id) = id {
        let found: Option<String> = conn
            .query_row("SELECT id FROM accounts_parties WHERE id = ?1 AND is_deleted = 0", params![id], |r| r.get(0))
            .optional()?;
        if let Some(id) = found {
            return Ok(id);
        }
    }
    if let Some(code) = code {
        let found: Option<String> = conn
            .query_row(
                "SELECT id FROM accounts_parties WHERE code = ?1 AND is_deleted = 0",
                params![code],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = found {
            return Ok(id);
        }
    }
    Err(AppError::not_found("Account not found."))
}

pub fn account_detail_json(conn: &Connection, account_id: &str) -> AppResult<Value> {
    let account = query_one_json(
        conn,
        "SELECT a.*, c.name AS linked_company_name
         FROM accounts_parties a
         LEFT JOIN companies c ON c.id = a.linked_company_id
         WHERE a.id = ?1",
        params![account_id],
    )?
    .ok_or_else(|| AppError::not_found("Account not found."))?;

    let account_type = account
        .get("account_type")
        .and_then(|v| v.as_str())
        .unwrap_or("PARTY")
        .to_string();

    let credit = credit_status(conn, account_id, 0, "CREDIT", None)?;

    let recent = if account_type == "SUPPLIER" {
        query_json(
            conn,
            "SELECT id, sup_inv_no AS inv_no_display, inv_date_display, sup_inv_no AS sup_inv_display,
                    grand_total_scaled, due_amt_scaled
             FROM purchase_invoices WHERE supplier_id = ?1 AND is_deleted = 0
             ORDER BY inv_date_iso DESC LIMIT 12",
            params![account_id],
        )?
    } else {
        query_json(
            conn,
            "SELECT id, inv_no_display, inv_date_display, series_code, payment_mode,
                    grand_total_scaled, due_amt_scaled, converted_to_tax_inv_id
             FROM sales_invoices
             WHERE party_id = ?1 AND is_deleted = 0
             ORDER BY inv_date_iso DESC, inv_no DESC LIMIT 12",
            params![account_id],
        )?
    };

    Ok(json!({ "account": account, "credit": credit, "recent": recent }))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CreditStatus {
    pub locked: bool,
    pub reasons: Vec<String>,
    pub credit_limit_scaled: i64,
    pub outstanding_scaled: i64,
    pub available_scaled: i64,
    pub overdue_count: i64,
    pub overdue_amount_scaled: i64,
    pub locking_days: i64,
    pub bills_for_locking: i64,
}

impl CreditStatus {
    fn to_json(&self) -> Value {
        json!({
            "locked": self.locked,
            "reasons": self.reasons,
            "credit_limit_scaled": self.credit_limit_scaled,
            "outstanding_scaled": self.outstanding_scaled,
            "available_scaled": self.available_scaled,
            "overdue_count": self.overdue_count,
            "overdue_amount_scaled": self.overdue_amount_scaled,
            "locking_days": self.locking_days,
            "bills_for_locking": self.bills_for_locking,
        })
    }
}

fn credit_status(
    conn: &Connection,
    account_id: &str,
    new_invoice_scaled: i64,
    payment_mode: &str,
    exclude_invoice_id: Option<&str>,
) -> AppResult<CreditStatus> {
    let account = conn
        .query_row(
            "SELECT cr_limit_scaled, cr_days, locking_days, bills_for_locking, cur_bal_scaled, is_deleted
             FROM accounts_parties WHERE id = ?1",
            params![account_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((limit, cr_days, locking_days, bills_for_locking, outstanding, deleted)) = account else {
        return Err(AppError::not_found("Account not found."));
    };
    if deleted != 0 {
        return Err(AppError::not_found("Account has been deleted."));
    }
    let threshold_days = if locking_days > 0 { locking_days } else { cr_days };
    let exclude = exclude_invoice_id.unwrap_or("");
    let (overdue_count, overdue_amount) = if threshold_days > 0 {
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(due_amt_scaled), 0) FROM sales_invoices
             WHERE party_id = ?1 AND is_deleted = 0 AND payment_mode = 'CREDIT'
               AND due_amt_scaled > 0 AND is_sale_return = 0
               AND julianday('now') - julianday(inv_date_iso) > ?2
               AND (?3 = '' OR id <> ?3)",
            params![account_id, threshold_days as f64, exclude],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )?
    } else {
        (0, 0)
    };

    let excluded_due: i64 = if exclude.is_empty() {
        0
    } else {
        conn.query_row(
            "SELECT COALESCE(due_amt_scaled, 0) FROM sales_invoices WHERE id = ?1",
            params![exclude],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0)
    };
    let outstanding = outstanding - excluded_due;

    let mut reasons = Vec::new();
    let is_credit = payment_mode.eq_ignore_ascii_case("CREDIT");
    if is_credit {
        if limit > 0 && outstanding + new_invoice_scaled > limit {
            reasons.push(format!(
                "Credit limit of {} exceeded: outstanding {} plus this bill {}.",
                crate::services::calc_engine::format_money(limit),
                crate::services::calc_engine::format_money(outstanding),
                crate::services::calc_engine::format_money(new_invoice_scaled)
            ));
        }
        if bills_for_locking > 0 && overdue_count >= bills_for_locking {
            reasons.push(format!(
                "{overdue_count} unpaid bill(s) older than {threshold_days} days (locking threshold {bills_for_locking}).",
            ));
        }
    }
    let available = if limit > 0 { (limit - outstanding).max(0) } else { 0 };
    Ok(CreditStatus {
        locked: !reasons.is_empty(),
        reasons,
        credit_limit_scaled: limit,
        outstanding_scaled: outstanding,
        available_scaled: available,
        overdue_count,
        overdue_amount_scaled: overdue_amount,
        locking_days: threshold_days,
        bills_for_locking,
    })
}

#[derive(Debug, Deserialize)]
pub struct CreditCheckRequest {
    pub account_id: String,
    #[serde(default)]
    pub new_invoice_scaled: i64,
    #[serde(default = "credit_mode")]
    pub payment_mode: String,
}

fn credit_mode() -> String {
    "CREDIT".to_string()
}

#[tauri::command]
pub fn account_credit_status(
    req: CreditCheckRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let conn = state.db.lock()?;
    let status = credit_status(&conn, &req.account_id, req.new_invoice_scaled, &req.payment_mode, None)?;
    Ok(status.to_json())
}

#[derive(Debug, Deserialize)]
pub struct NextAccountCodeRequest {
    pub account_type: String,
}

#[tauri::command]
pub fn next_account_code(
    req: NextAccountCodeRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let account_type = normalize_type(&req.account_type)?;
    let conn = state.db.lock()?;
    let prefix = if account_type == "PARTY" { "C" } else { "S" };
    let max_code: Option<String> = conn
        .query_row(
            "SELECT code FROM accounts_parties WHERE code LIKE ?1 ORDER BY code DESC LIMIT 1",
            params![format!("{prefix}%")],
            |r| r.get(0),
        )
        .optional()?;
    let next_number = max_code
        .and_then(|code| code.trim_start_matches(prefix).parse::<i64>().ok())
        .unwrap_or(0)
        + 1;
    Ok(json!({ "code": format!("{prefix}{next_number:03}") }))
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountSaveRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub account_type: String,
    #[serde(default)]
    pub code: Option<String>,
    pub name: String,
    #[serde(default)]
    pub address_line1: Option<String>,
    #[serde(default)]
    pub address_line2: Option<String>,
    #[serde(default)]
    pub address_line3: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub phone_office: Option<String>,
    #[serde(default)]
    pub phone_res: Option<String>,
    #[serde(default)]
    pub contact_person: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub creation_date: Option<String>,
    #[serde(default = "default_billing_on")]
    pub billing_on_rate: String,
    #[serde(default = "active_status")]
    pub status: String,
    #[serde(default)]
    pub hq: Option<String>,
    #[serde(default)]
    pub mr_name: Option<String>,
    #[serde(default)]
    pub linked_company_id: Option<String>,
    #[serde(default)]
    pub is_inter_state: bool,
    #[serde(default)]
    pub gst_no: Option<String>,
    #[serde(default)]
    pub pan_aadhar: Option<String>,
    #[serde(default)]
    pub dl_no_1: Option<String>,
    #[serde(default)]
    pub dl_no_2: Option<String>,
    #[serde(default)]
    pub dl_expiry_date: Option<String>,
    #[serde(default)]
    pub transport_name: Option<String>,
    #[serde(default)]
    pub banker_name: Option<String>,
    #[serde(default)]
    pub interest_rate_bps: i64,
    #[serde(default)]
    pub cr_limit_scaled: i64,
    #[serde(default)]
    pub cr_days: i64,
    #[serde(default)]
    pub locking_days: i64,
    #[serde(default)]
    pub bills_for_locking: i64,
    #[serde(default)]
    pub op_bal_dr_scaled: i64,
    #[serde(default)]
    pub op_bal_cr_scaled: i64,
}

fn default_billing_on() -> String {
    "S_RATE".to_string()
}
fn active_status() -> String {
    "ACTIVE".to_string()
}

const BILLING_ON: &[&str] = &["S_RATE", "T_RATE", "MRP", "P_RATE"];

#[tauri::command]
pub fn save_account(
    req: AccountSaveRequest,
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<Value> {
    let account_type = normalize_type(&req.account_type)?;
    let name = require_text(&req.name, "name", "Name")?;
    let billing_on = req.billing_on_rate.trim().to_ascii_uppercase();
    if !BILLING_ON.contains(&billing_on.as_str()) {
        return Err(AppError::validation_field(
            "Billing on rate must be S_RATE, T_RATE, MRP or P_RATE.",
            "billing_on_rate",
        ));
    }
    let status = req.status.trim().to_ascii_uppercase();
    let status = if status == "INACTIVE" { "INACTIVE" } else { "ACTIVE" };
    if req.op_bal_dr_scaled != 0 && req.op_bal_cr_scaled != 0 {
        return Err(AppError::validation_field(
            "Opening balance cannot be both Dr and Cr. Enter one side only.",
            "op_bal_cr_scaled",
        ));
    }
    if req.cr_limit_scaled < 0 || req.cr_days < 0 || req.locking_days < 0 || req.bills_for_locking < 0 {
        return Err(AppError::validation_field(
            "Credit terms cannot be negative.",
            "cr_limit_scaled",
        ));
    }

    let gst_raw = req.gst_no.clone().unwrap_or_default();
    let gst = gst_raw.trim().to_ascii_uppercase();
    validate_gstin(&gst)?;
    validate_pan(req.pan_aadhar.as_deref().unwrap_or(""))?;
    validate_phone(req.phone_office.as_deref().unwrap_or(""))?;

    let mut conn = state.db.lock()?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let mut is_inter_state = req.is_inter_state;
    if !gst.is_empty() {
        let home_state = get_setting(&conn, "company_state_code")?
            .unwrap_or_else(|| "10".to_string());
        if !gst.starts_with(&home_state) {
            is_inter_state = true;
        }
    }

    let tx = conn.transaction()?;
    let now = now_ms();
    let opening = req.op_bal_dr_scaled - req.op_bal_cr_scaled;

    let existing = match &req.id {
        Some(id) if !id.is_empty() => {
            let row: Option<(String, i64, i64, i64)> = tx
                .query_row(
                    "SELECT account_type, op_bal_dr_scaled, op_bal_cr_scaled, cur_bal_scaled
                     FROM accounts_parties WHERE id = ?1 AND is_deleted = 0",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            match row {
                Some((existing_type, dr, cr, cur_bal)) => {
                    if existing_type != account_type {
                        return Err(AppError::validation_field(
                            "An account cannot change type between Party and Supplier.",
                            "account_type",
                        ));
                    }
                    Some((id.clone(), dr - cr, cur_bal))
                }
                None => return Err(AppError::not_found("Account to update was not found.")),
            }
        }
        _ => None,
    };

    let code = match &existing {
        Some((id, _, _)) => {
            let current = crate::commands::scalar_string(
                &tx,
                "SELECT code FROM accounts_parties WHERE id = ?1",
                params![id],
            )?;
            req.code.clone().filter(|c| !c.trim().is_empty()).unwrap_or(current)
        }
        None => {
            let requested = req.code.clone().filter(|c| !c.trim().is_empty());
            match requested {
                Some(code) => code.trim().to_ascii_uppercase(),
                None => {
                    let prefix = if account_type == "PARTY" { "C" } else { "S" };
                    let max_code: Option<String> = tx
                        .query_row(
                            "SELECT code FROM accounts_parties WHERE code LIKE ?1 ORDER BY code DESC LIMIT 1",
                            params![format!("{prefix}%")],
                            |r| r.get(0),
                        )
                        .optional()?;
                    let number = max_code
                        .and_then(|c| c.trim_start_matches(prefix).parse::<i64>().ok())
                        .unwrap_or(0)
                        + 1;
                    format!("{prefix}{number:03}")
                }
            }
        }
    };

    let duplicate: Option<String> = tx
        .query_row(
            "SELECT id FROM accounts_parties WHERE code = ?1 AND id <> ?2",
            params![code, req.id.clone().unwrap_or_default()],
            |r| r.get(0),
        )
        .optional()?;
    if duplicate.is_some() {
        return Err(AppError::with_field(
            "DUPLICATE",
            format!("Account code {code} is already in use."),
            "code",
        ));
    }

    let creation_date = req
        .creation_date
        .clone()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(today_display);

    let account_id = match &existing {
        Some((id, old_opening, cur_bal)) => {
            let new_cur_bal = cur_bal + (opening - old_opening);
            tx.execute(
                "UPDATE accounts_parties SET account_type=?1, code=?2, name=?3, address_line1=?4,
                    address_line2=?5, address_line3=?6, city=?7, state=?8, phone_office=?9, phone_res=?10,
                    contact_person=?11, email=?12, creation_date=?13, billing_on_rate=?14, status=?15,
                    hq=?16, mr_name=?17, linked_company_id=?18, is_inter_state=?19, gst_no=?20,
                    pan_aadhar=?21, dl_no_1=?22, dl_no_2=?23, dl_expiry_date=?24, transport_name=?25,
                    banker_name=?26, interest_rate_bps=?27, cr_limit_scaled=?28, cr_days=?29,
                    locking_days=?30, bills_for_locking=?31, op_bal_dr_scaled=?32, op_bal_cr_scaled=?33,
                    cur_bal_scaled=?34, updated_at=?35
                 WHERE id=?36",
                params![
                    account_type, code, name, req.address_line1, req.address_line2, req.address_line3,
                    req.city, req.state, req.phone_office, req.phone_res, req.contact_person, req.email,
                    creation_date, billing_on, status, req.hq, req.mr_name, req.linked_company_id,
                    is_inter_state as i64, gst, req.pan_aadhar, req.dl_no_1, req.dl_no_2,
                    req.dl_expiry_date, req.transport_name, req.banker_name, req.interest_rate_bps,
                    req.cr_limit_scaled, req.cr_days, req.locking_days, req.bills_for_locking,
                    req.op_bal_dr_scaled, req.op_bal_cr_scaled, new_cur_bal, now, id
                ],
            )?;
            id.clone()
        }
        None => {
            let id = new_id();
            tx.execute(
                "INSERT INTO accounts_parties (id, account_type, code, name, address_line1, address_line2,
                    address_line3, city, state, phone_office, phone_res, contact_person, email,
                    creation_date, billing_on_rate, status, hq, mr_name, linked_company_id,
                    is_inter_state, gst_no, pan_aadhar, dl_no_1, dl_no_2, dl_expiry_date,
                    transport_name, banker_name, interest_rate_bps, cr_limit_scaled, cr_days,
                    locking_days, bills_for_locking, op_bal_dr_scaled, op_bal_cr_scaled,
                    cur_bal_scaled, updated_at, is_deleted)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
                    ?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,0)",
                params![
                    id, account_type, code, name, req.address_line1, req.address_line2,
                    req.address_line3, req.city, req.state, req.phone_office, req.phone_res,
                    req.contact_person, req.email, creation_date, billing_on, status, req.hq,
                    req.mr_name, req.linked_company_id, is_inter_state as i64, gst,
                    req.pan_aadhar, req.dl_no_1, req.dl_no_2, req.dl_expiry_date,
                    req.transport_name, req.banker_name, req.interest_rate_bps,
                    req.cr_limit_scaled, req.cr_days, req.locking_days, req.bills_for_locking,
                    req.op_bal_dr_scaled, req.op_bal_cr_scaled, opening, now
                ],
            )?;
            id
        }
    };

    if existing.is_none() && opening != 0 {
        tx.execute(
            "INSERT INTO account_ledger (id, account_id, entry_date_iso, entry_type, ref_table, ref_id,
                ref_no, dr_scaled, cr_scaled, narration, created_at)
             VALUES (?1,?2,?3,'OPENING','accounts_parties',?2,'Opening',?4,?5,'Opening balance',?6)",
            params![
                new_id(),
                account_id,
                crate::db::today_iso(),
                req.op_bal_dr_scaled,
                req.op_bal_cr_scaled,
                now
            ],
        )?;
    }

    if let Some(snapshot) =
        query_one_json(&tx, "SELECT * FROM accounts_parties WHERE id = ?1", params![account_id])?
    {
        crate::db::outbox::push_upsert(&tx, &device_id, "accounts_parties", &account_id, &snapshot)?;
    }

    tx.commit()?;
    account_detail_json(&conn, &account_id)
}

/// Helper used by sales/purchases to fetch account credit terms.
pub fn account_credit_check(
    conn: &Connection,
    account_id: &str,
    amount_scaled: i64,
    payment_mode: &str,
) -> AppResult<CreditStatus> {
    credit_status(conn, account_id, amount_scaled, payment_mode, None)
}

pub fn account_credit_check_excluding(
    conn: &Connection,
    account_id: &str,
    amount_scaled: i64,
    payment_mode: &str,
    exclude_invoice_id: Option<&str>,
) -> AppResult<CreditStatus> {
    credit_status(conn, account_id, amount_scaled, payment_mode, exclude_invoice_id)
}

/// Helper used by importers.
pub fn find_party_id(conn: &Connection, name: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM accounts_parties
             WHERE is_deleted = 0 AND (UPPER(name) = UPPER(?1) OR UPPER(code) = UPPER(?1))
             LIMIT 1",
            params![name.trim()],
            |r| r.get(0),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::services::calc_engine::parse_scaled;

    fn insert_party(conn: &Connection, id: &str, limit: i64) -> String {
        let now = now_ms();
        conn.execute(
            "INSERT INTO accounts_parties (id, account_type, code, name, creation_date, cr_limit_scaled,
                cr_days, locking_days, bills_for_locking, cur_bal_scaled, updated_at)
             VALUES (?1,'PARTY',?1,'TEST MEDICO','01/04/2024',?2,30,15,2,?3,?4)",
            params![id, limit, parse_scaled("1000").unwrap(), now],
        )
        .unwrap();
        id.to_string()
    }

    #[test]
    fn credit_limit_blocks_credit_sales_only() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        insert_party(&conn, "party-limit", parse_scaled("5000").unwrap());
        let new_bill = parse_scaled("4500").unwrap();
        let credit = credit_status(&conn, "party-limit", new_bill, "CREDIT", None).unwrap();
        assert!(credit.locked, "exceeding the limit must lock credit sales");
        let cash = credit_status(&conn, "party-limit", new_bill, "CASH", None).unwrap();
        assert!(!cash.locked, "cash sales are never credit-locked");
        let small = credit_status(&conn, "party-limit", parse_scaled("100").unwrap(), "CREDIT", None).unwrap();
        // Rs 1,000 outstanding + 100 = 1,100 < 5,000 limit
        assert!(!small.locked);
    }

    #[test]
    fn overdue_bill_count_blocks_credit_sales() {
        let db = Db::open_memory().unwrap();
        let conn = db.lock().unwrap();
        insert_party(&conn, "party-overdue", 0);
        let series: String = conn
            .query_row("SELECT id FROM invoice_series WHERE series_code='ABC'", [], |r| r.get(0))
            .unwrap();
        for i in 0..2 {
            let id = format!("inv{i}");
            conn.execute(
                "INSERT INTO sales_invoices (id, series_id, series_code, inv_no, inv_no_display,
                    inv_date_iso, inv_date_display, payment_mode, party_id, party_name_snapshot,
                    grand_total_scaled, due_amt_scaled, updated_at)
                 VALUES (?1, ?2, 'ABC', ?3, ?4, date('now', '-40 days'), '01/01/2020', 'CREDIT',
                    'party-overdue', 'TEST MEDICO', 100000, 100000, 1)",
                params![id, series, 100 + i, format!("ABC-{}", 100 + i)],
            )
            .unwrap();
        }
        let status = credit_status(&conn, "party-overdue", 1, "CREDIT", None).unwrap();
        assert_eq!(status.overdue_count, 2);
        assert!(status.locked);
        assert!(status.reasons.iter().any(|r| r.contains("unpaid bill")));
    }
}
