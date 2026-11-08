//! One-click legacy SOLVI migration.
//!
//! Reads SQLite, CSV, JSON, XLSX and dBase III (.dbf) exports, normalizes
//! common legacy typos ("VAIL" -> "VIAL") and imports products, batches and
//! opening stock. Access `.mdb` files must be exported to CSV first.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value as JsonValue;

use crate::db::{expiry_key_from_mm_yy, get_setting, new_id, now_ms};
use crate::error::{AppError, AppResult};
use crate::services::calc_engine::{calc_net_rate, parse_scaled};

#[derive(Debug, Clone, Default, Serialize)]
pub struct LegacyRow {
    pub name: String,
    pub company: Option<String>,
    pub composition: Option<String>,
    pub pack_form: Option<String>,
    pub hsn_code: Option<String>,
    pub mrp: Option<String>,
    pub s_rate: Option<String>,
    pub t_rate: Option<String>,
    pub p_rate: Option<String>,
    pub batch_no: Option<String>,
    pub expiry: Option<String>,
    pub qty: Option<i64>,
    pub tax_percent: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct LegacyData {
    pub format: String,
    pub rows: Vec<LegacyRow>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportSummary {
    pub imported_products: i64,
    pub imported_batches: i64,
    pub updated_batches: i64,
    pub skipped_rows: i64,
    pub warnings: Vec<String>,
}

fn clean(value: &str) -> String {
    value.trim().trim_matches('"').trim().to_string()
}

fn fix_typos(name: &str) -> String {
    let mut fixed = name.to_ascii_uppercase();
    for (from, to) in [
        ("VAIL", "VIAL"),
        ("SYPUP", "SYRUP"),
        ("SYRP", "SYRUP"),
        ("TABS", "TAB"),
        ("CAPS", "CAP"),
        ("INJECTION", "INJ"),
        ("OINTMENT", "OINT"),
    ] {
        fixed = fixed.replace(from, to);
    }
    fixed.trim().to_string()
}

pub fn normalize_expiry(input: &str) -> Option<String> {
    let text = clean(input);
    if text.is_empty() {
        return None;
    }
    let key = if let Ok(key) = expiry_key_from_mm_yy(&text) {
        key
    } else if text.contains('-') && text.len() >= 7 {
        // YYYY-MM
        let parts: Vec<&str> = text.split('-').collect();
        let month: i64 = parts.get(1)?.parse().ok()?;
        let year: i64 = parts.get(0)?.parse().ok()?;
        year * 100 + month
    } else if text.chars().all(|c| c.is_ascii_digit()) && text.len() == 6 {
        text.parse().ok()?
    } else if text.len() == 8 && text.chars().all(|c| c.is_ascii_digit()) {
        // YYYYMMDD
        let year: i64 = text[0..4].parse().ok()?;
        let month: i64 = text[4..6].parse().ok()?;
        year * 100 + month
    } else {
        return None;
    };
    if key < 199001 || key % 100 == 0 || key % 100 > 12 {
        return None;
    }
    Some(crate::db::expiry_display_from_key(key))
}

fn row_from_map(map: &HashMap<String, String>) -> LegacyRow {
    let get = |keys: &[&str]| -> Option<String> {
        for key in keys {
            if let Some(value) = map.get(*key) {
                if !value.trim().is_empty() {
                    return Some(value.clone());
                }
            }
        }
        None
    };
    LegacyRow {
        name: fix_typos(&get(&["name", "product", "product name", "item", "item name", "description"]).unwrap_or_default()),
        company: get(&["company", "company name", "manufacturer", "mfr"]),
        composition: get(&["composition", "comp", "generic", "salt", "composition desc"]),
        pack_form: get(&["pack", "pack form", "form", "type"]),
        hsn_code: get(&["hsn", "hsn code"]),
        mrp: get(&["mrp"]),
        s_rate: get(&["s_rate", "s rate", "sales rate", "srate", "sp"]),
        t_rate: get(&["t_rate", "t rate", "trade rate", "trate"]),
        p_rate: get(&["p_rate", "p rate", "purchase rate", "prate", "rate"]),
        batch_no: get(&["batch", "batch no", "batch_no", "batchno"]),
        expiry: get(&["expiry", "exp", "expiry date", "exp date"]),
        qty: get(&["qty", "quantity", "stock", "cur qty", "cur_qty"])
            .and_then(|v| v.trim().parse::<i64>().ok()),
        tax_percent: get(&["tax", "gst", "tax %", "gst %", "tax_percent"]),
    }
}

fn normalize_headers(headers: &[String]) -> Vec<String> {
    headers
        .iter()
        .map(|h| h.trim().to_ascii_lowercase().replace(['.', '_'], " "))
        .collect()
}

pub fn read_legacy(path: &Path) -> AppResult<LegacyData> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "db" | "sqlite" | "sqlite3" => read_sqlite(path),
        "csv" | "txt" => read_csv(path),
        "json" => read_json(path),
        "xlsx" | "xls" | "xlsm" => read_xlsx(path),
        "dbf" => read_dbf(path),
        "mdb" | "accdb" => Err(AppError::new(
            "UNSUPPORTED",
            "Access databases cannot be read directly. Export the product/stock table to CSV in Access and import that file.",
        )),
        other => Err(AppError::new(
            "UNSUPPORTED",
            format!("Unsupported legacy file type '.{other}'. Use .db, .csv, .json, .xlsx or .dbf."),
        )),
    }
}

fn read_csv(path: &Path) -> AppResult<LegacyData> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_path(path)
        .map_err(|err| AppError::new("IO", format!("Cannot read CSV: {err}")))?;
    let headers = normalize_headers(&reader.headers()?.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    for (index, record) in reader.records().enumerate() {
        let Ok(record) = record else { continue };
        let mut map = HashMap::new();
        for (col, header) in headers.iter().enumerate() {
            map.insert(header.clone(), record.get(col).unwrap_or("").to_string());
        }
        let row = row_from_map(&map);
        if row.name.is_empty() {
            warnings.push(format!("Row {} skipped: no product name.", index + 2));
            continue;
        }
        rows.push(row);
    }
    Ok(LegacyData { format: "CSV".into(), rows, warnings })
}

fn read_json(path: &Path) -> AppResult<LegacyData> {
    let text = std::fs::read_to_string(path)?;
    let parsed: JsonValue = serde_json::from_str(&text)
        .map_err(|err| AppError::new("VALIDATION", format!("Invalid JSON: {err}")))?;
    let array = parsed
        .as_array()
        .cloned()
        .or_else(|| parsed.get("products").and_then(|v| v.as_array()).cloned())
        .or_else(|| parsed.get("rows").and_then(|v| v.as_array()).cloned())
        .ok_or_else(|| AppError::validation("JSON must be an array of product rows."))?;
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    for (index, object) in array.iter().enumerate() {
        let Some(object) = object.as_object() else {
            warnings.push(format!("Entry {} is not an object.", index + 1));
            continue;
        };
        let mut map = HashMap::new();
        for (key, value) in object {
            let text = match value {
                JsonValue::String(s) => s.clone(),
                JsonValue::Number(n) => n.to_string(),
                JsonValue::Bool(b) => b.to_string(),
                _ => String::new(),
            };
            map.insert(key.to_ascii_lowercase().replace(['.', '_'], " "), text);
        }
        let row = row_from_map(&map);
        if row.name.is_empty() {
            warnings.push(format!("Entry {} skipped: no product name.", index + 1));
            continue;
        }
        rows.push(row);
    }
    Ok(LegacyData { format: "JSON".into(), rows, warnings })
}

fn read_xlsx(path: &Path) -> AppResult<LegacyData> {
    use calamine::{open_workbook_auto, Reader};
    let mut workbook = open_workbook_auto(path)
        .map_err(|err| AppError::new("IO", format!("Cannot open workbook: {err}")))?;
    let range = workbook
        .worksheet_range_at(0)
        .ok_or_else(|| AppError::validation("Workbook has no worksheets."))?
        .map_err(|err| AppError::new("IO", format!("Cannot read worksheet: {err}")))?;
    let mut iter = range.rows();
    let headers: Vec<String> = iter
        .next()
        .map(|row| normalize_headers(&row.iter().map(|c| c.to_string()).collect::<Vec<_>>()))
        .unwrap_or_default();
    if headers.is_empty() {
        return Err(AppError::validation("The first worksheet is empty."));
    }
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    for (index, record) in iter.enumerate() {
        let mut map = HashMap::new();
        for (col, header) in headers.iter().enumerate() {
            map.insert(header.clone(), record.get(col).map(|c| c.to_string()).unwrap_or_default());
        }
        let row = row_from_map(&map);
        if row.name.is_empty() {
            continue;
        }
        if row.p_rate.is_none() && row.s_rate.is_none() {
            warnings.push(format!("Row {} has no rate.", index + 2));
        }
        rows.push(row);
    }
    Ok(LegacyData { format: "XLSX".into(), rows, warnings })
}

fn read_sqlite(path: &Path) -> AppResult<LegacyData> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|err| AppError::new("IO", format!("Cannot open SQLite file: {err}")))?;

    let tables: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut chosen: Option<String> = tables
        .iter()
        .find(|t| t.to_ascii_lowercase().contains("prod"))
        .cloned();
    if chosen.is_none() {
        for table in &tables {
            let columns = columns_of(&conn, table)?;
            if columns.iter().any(|c| c.eq_ignore_ascii_case("name")) {
                chosen = Some(table.clone());
                break;
            }
        }
    }
    let table = chosen.ok_or_else(|| {
        AppError::validation(
            "No product table found. Expected a table with a 'name' column or a name containing 'prod'.",
        )
    })?;
    let columns = columns_of(&conn, &table)?;
    let mut stmt = conn.prepare(&format!("SELECT * FROM \"{table}\" LIMIT 10000"))?;
    let mut rows_iter = stmt.query([])?;
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    while let Some(row) = rows_iter.next()? {
        let mut map = HashMap::new();
        for (position, column) in columns.iter().enumerate() {
            let normalized = column.to_ascii_lowercase().replace(['.', '_'], " ");
            let text = match row.get_ref(position)? {
                rusqlite::types::ValueRef::Null => String::new(),
                rusqlite::types::ValueRef::Integer(i) => i.to_string(),
                rusqlite::types::ValueRef::Real(f) => format!("{f:.4}"),
                rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).to_string(),
                rusqlite::types::ValueRef::Blob(_) => String::new(),
            };
            map.insert(normalized.clone(), text.clone());
            // Keep a compact alias for common legacy column names.
            let compact = normalized.replace(' ', "");
            map.entry(compact).or_insert(text);
        }
        let row = row_from_map(&map);
        if row.name.is_empty() {
            continue;
        }
        rows.push(row);
    }
    if rows.is_empty() {
        warnings.push(format!("Table '{table}' returned no product rows."));
    }
    Ok(LegacyData { format: format!("SQLite ({table})"), rows, warnings })
}

fn columns_of(conn: &Connection, table: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn read_dbf(path: &Path) -> AppResult<LegacyData> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < 32 {
        return Err(AppError::validation("DBF file is too short."));
    }
    let record_count = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    let header_len = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
    let record_len = u16::from_le_bytes([bytes[10], bytes[11]]) as usize;
    let mut fields: Vec<(String, u8, usize)> = Vec::new();
    let mut offset = 32;
    while offset + 32 <= bytes.len() && bytes[offset] != 0x0D {
        let name_bytes: Vec<u8> = bytes[offset..offset + 11]
            .iter()
            .copied()
            .take_while(|b| *b != 0)
            .collect();
        let name = String::from_utf8_lossy(&name_bytes).trim().to_ascii_lowercase();
        let kind = bytes[offset + 11];
        let length = bytes[offset + 16] as usize;
        fields.push((name, kind, length));
        offset += 32;
    }
    if fields.is_empty() || record_len == 0 || header_len >= bytes.len() {
        return Err(AppError::validation("Unrecognized DBF layout."));
    }
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    for record_index in 0..record_count {
        let start = header_len + record_index * record_len;
        if start + record_len > bytes.len() {
            break;
        }
        let record = &bytes[start..start + record_len];
        if record[0] == b'*' {
            continue; // deleted
        }
        let mut cursor = 1usize;
        let mut map = HashMap::new();
        for (name, kind, length) in &fields {
            if cursor + length > record.len() {
                break;
            }
            let raw = String::from_utf8_lossy(&record[cursor..cursor + length]).trim().to_string();
            cursor += length;
            let value = if *kind == b'D' && raw.len() == 8 {
                format!("{}/{}", &raw[4..6], &raw[2..4])
            } else {
                raw
            };
            map.insert(name.clone(), value);
        }
        let row = row_from_map(&map);
        if row.name.is_empty() {
            warnings.push(format!("DBF record {} skipped.", record_index + 1));
            continue;
        }
        rows.push(row);
    }
    Ok(LegacyData { format: "DBF".into(), rows, warnings })
}

fn resolve_tax_plan(conn: &Connection, percent: Option<&str>) -> AppResult<String> {
    let default: String = conn.query_row(
        "SELECT id FROM tax_plans WHERE name = 'GST-12'",
        [],
        |r| r.get(0),
    )?;
    let Some(text) = percent else { return Ok(default) };
    let cleaned = text.replace('%', "");
    let Ok(rate) = cleaned.trim().parse::<f64>() else {
        return Ok(default);
    };
    let bps = (rate * 100.0).round() as i64;
    let found: Option<String> = conn
        .query_row(
            "SELECT id FROM tax_plans WHERE (cgst_bps + sgst_bps) = ?1 ORDER BY ABS((cgst_bps + sgst_bps) - ?1) LIMIT 1",
            params![bps],
            |r| r.get(0),
        )
        .optional()?;
    Ok(found.unwrap_or(default))
}

pub fn import_rows(
    conn: &mut Connection,
    device_id: &str,
    data: &LegacyData,
    create_missing_products: bool,
    godown_id: Option<&str>,
) -> AppResult<ImportSummary> {
    let default_godown = match godown_id.filter(|g| !g.is_empty()) {
        Some(id) => id.to_string(),
        None => crate::commands::products::default_godown_id(conn)?,
    };
    let mut summary = ImportSummary {
        warnings: data.warnings.clone(),
        ..Default::default()
    };

    for row in &data.rows {
        if row.name.trim().is_empty() {
            summary.skipped_rows += 1;
            continue;
        }
        let existing = crate::commands::products::resolve_product_by_name(conn, &row.name)?;
        let product_id = match existing {
            Some(id) => id,
            None => {
                if !create_missing_products {
                    summary.skipped_rows += 1;
                    summary
                        .warnings
                        .push(format!("{}: product does not exist (create-missing is off).", row.name));
                    continue;
                }
                let tax_id = resolve_tax_plan(conn, row.tax_percent.as_deref())?;
                let request = crate::commands::products::ProductSaveRequest {
                    id: None,
                    pro_code: None,
                    name: row.name.clone(),
                    group_id: None,
                    group_name: None,
                    company_id: None,
                    company_name: row.company.clone(),
                    composition_id: None,
                    composition_desc: row.composition.clone(),
                    pack_unit: 1,
                    pack_subunit: 10,
                    pack_form: row
                        .pack_form
                        .clone()
                        .filter(|p| crate::commands::products::PACK_FORMS.contains(&p.to_ascii_uppercase().as_str()))
                        .map(|p| p.to_ascii_uppercase())
                        .unwrap_or_else(|| "TAB".to_string()),
                    case_box_qty: 1,
                    hsn_code: row.hsn_code.clone(),
                    drug_schedule: "OTC".to_string(),
                    pur_tax_id: Some(tax_id.clone()),
                    sale_tax_id: Some(tax_id.clone()),
                    tin_tax_id: Some(tax_id.clone()),
                    tout_tax_id: Some(tax_id),
                    min_qty: 0,
                    max_qty: 0,
                    weight_grams: 0,
                    batches: Vec::new(),
                };
                let id = crate::commands::products::save_product_internal(conn, device_id, request)?;
                summary.imported_products += 1;
                id
            }
        };

        let expiry = match row.expiry.as_deref().and_then(normalize_expiry) {
            Some(value) => value,
            None => {
                summary.skipped_rows += 1;
                summary
                    .warnings
                    .push(format!("{}: missing or invalid expiry, batch skipped.", row.name));
                continue;
            }
        };
        let expiry_key = expiry_key_from_mm_yy(&expiry)?;
        let batch_no = row
            .batch_no
            .clone()
            .map(|b| clean(&b).to_ascii_uppercase())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| format!("IMP{}", expiry_key));
        let p_rate = row
            .p_rate
            .as_deref()
            .map(parse_scaled)
            .transpose()?
            .unwrap_or(0);
        let s_rate = row.s_rate.as_deref().map(parse_scaled).transpose()?.unwrap_or(0);
        let t_rate = row.t_rate.as_deref().map(parse_scaled).transpose()?.unwrap_or(0);
        let mrp = row.mrp.as_deref().map(parse_scaled).transpose()?.unwrap_or(0);
        let qty = row.qty.unwrap_or(0);
        let tax_bps: i64 = conn
            .query_row(
                "SELECT COALESCE(tp.cgst_bps + tp.sgst_bps, 0) FROM products p
                 LEFT JOIN tax_plans tp ON tp.id = p.pur_tax_id WHERE p.id = ?1",
                params![product_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let net_rate = calc_net_rate(p_rate, 0, 0, 0, tax_bps);
        let tx = conn.transaction()?;
        let now = now_ms();
        let existing_batch: Option<(String, i64)> = tx
            .query_row(
                "SELECT id, cur_qty FROM batches
                 WHERE product_id = ?1 AND batch_no = ?2 AND godown_id = ?3 AND is_deleted = 0",
                params![product_id, batch_no, default_godown],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let batch_id = match existing_batch {
            Some((id, _)) => {
                tx.execute(
                    "UPDATE batches SET cur_qty = cur_qty + ?1, tax_stock_qty = tax_stock_qty + ?1,
                        op_qty = op_qty + ?1, p_rate_scaled = ?2, s_rate_scaled = ?3,
                        t_rate_scaled = ?4, mrp_scaled = CASE WHEN ?5 > 0 THEN ?5 ELSE mrp_scaled END,
                        net_rate_scaled = ?6, expiry_mm_yy = ?7, expiry_sort_key = ?8, updated_at = ?9
                     WHERE id = ?10",
                    params![
                        qty, p_rate, s_rate, t_rate, mrp, net_rate, expiry, expiry_key, now, id
                    ],
                )?;
                summary.updated_batches += 1;
                id
            }
            None => {
                let id = new_id();
                tx.execute(
                    "INSERT INTO batches (id, product_id, batch_no, expiry_mm_yy, expiry_sort_key,
                        op_qty, deal_billed, deal_free, cur_qty, tax_stock_qty, mrp_scaled,
                        s_rate_scaled, t_rate_scaled, p_rate_scaled, dis_bps, net_rate_scaled,
                        godown_id, is_provisional, updated_at, is_deleted)
                     VALUES (?1,?2,?3,?4,?5,?6,0,0,?6,?6,?7,?8,?9,?10,0,?11,?12,0,?13,0)",
                    params![
                        id, product_id, batch_no, expiry, expiry_key, qty, mrp, s_rate, t_rate,
                        p_rate, net_rate, default_godown, now
                    ],
                )?;
                summary.imported_batches += 1;
                id
            }
        };
        if let Some(snapshot) = crate::commands::query_one_json(
            &tx,
            "SELECT * FROM batches WHERE id = ?1",
            params![batch_id],
        )? {
            crate::db::outbox::push_upsert(&tx, device_id, "batches", &batch_id, &snapshot)?;
        }
        tx.commit()?;
    }
    Ok(summary)
}

pub fn read_and_preview(path: &str) -> AppResult<serde_json::Value> {
    let data = read_legacy(Path::new(path))?;
    Ok(serde_json::json!({
        "format": data.format,
        "total_rows": data.rows.len(),
        "products": data.rows.iter().filter(|r| !r.name.is_empty()).count(),
        "with_batches": data.rows.iter().filter(|r| r.expiry.is_some()).count(),
        "warnings": data.warnings,
        "sample": data.rows.iter().take(12).collect::<Vec<_>>(),
    }))
}

pub fn run_import(
    conn: &mut Connection,
    device_id: &str,
    path: &str,
    create_missing_products: bool,
    godown_id: Option<&str>,
) -> AppResult<ImportSummary> {
    let data = read_legacy(Path::new(path))?;
    if data.rows.is_empty() {
        return Err(AppError::validation(
            "No importable rows were found in this file.",
        ));
    }
    import_rows(conn, device_id, &data, create_missing_products, godown_id)
}

/// Used by demo seeding to confirm the device id exists.
pub fn _device_id(conn: &Connection) -> AppResult<String> {
    Ok(get_setting(conn, "device_id")?.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn typo_repair_and_expiry_normalization() {
        assert_eq!(fix_typos("monocef 500 vail"), "MONOCEF 500 VIAL");
        assert_eq!(normalize_expiry("03/26").as_deref(), Some("03/26"));
        assert_eq!(normalize_expiry("2026-03").as_deref(), Some("03/26"));
        assert_eq!(normalize_expiry("202603").as_deref(), Some("03/26"));
        assert_eq!(normalize_expiry("garbage"), None);
    }

    #[test]
    fn csv_import_creates_products_and_batches() {
        let dir = std::env::temp_dir().join(format!("saltbook-legacy-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let csv_path = dir.join("legacy.csv");
        std::fs::write(
            &csv_path,
            "NAME,COMPANY,COMP,PACK,MRP,S.RATE,P.RATE,BATCH,EXPIRY,QTY,TAX\n\
             MONOCEF 500 VAIL,CIPLA,Ceftriaxone 500mg,INJ,285.00,228.00,142.50,LEG1001,03/28,40,5\n\
             ALBOSLID-P,MANKIND,Albendazole 400mg,TAB,95.00,76.00,47.50,LEG1002,06/27,25,12\n",
        )
        .unwrap();
        let data = read_legacy(&csv_path).unwrap();
        assert_eq!(data.rows.len(), 2);
        assert_eq!(data.rows[0].name, "MONOCEF 500 VIAL");

        let db = Db::open_memory().unwrap();
        let mut conn = db.lock().unwrap();
        let device_id = crate::db::get_setting(&conn, "device_id").unwrap().unwrap();
        let summary = import_rows(&mut conn, &device_id, &data, true, None).unwrap();
        assert!(summary.imported_products >= 2);
        assert_eq!(summary.imported_batches, 2);
        let batch: (i64, i64) = conn
            .query_row(
                "SELECT cur_qty, expiry_sort_key FROM batches WHERE batch_no = 'LEG1001'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(batch, (40, 202803));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_import_reads_array_of_objects() {
        let dir = std::env::temp_dir().join(format!("saltbook-legacy-json-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("legacy.json");
        std::fs::write(
            &path,
            r#"[{"name":"TEST SYPUP","mrp":"50","s_rate":"40","p_rate":"25","batch":"J1","expiry":"12/27","qty":10}]"#,
        )
        .unwrap();
        let data = read_legacy(&path).unwrap();
        assert_eq!(data.rows.len(), 1);
        assert_eq!(data.rows[0].name, "TEST SYRUP");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_formats_are_reported_clearly() {
        let error = read_legacy(Path::new("/tmp/legacy.mdb")).unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED");
        assert!(error.message.contains("CSV"));
    }
}
