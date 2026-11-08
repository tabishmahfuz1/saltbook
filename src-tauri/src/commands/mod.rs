//! Tauri command surface.

pub mod adjustments_accounts;
pub mod demo;
pub mod parties_suppliers;
pub mod products;
pub mod purchases;
pub mod reports_ticker;
pub mod sales;
pub mod sync;

use rusqlite::{Connection, Params};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};

pub const DEFAULT_LIMIT: usize = 25;

fn value_ref_to_json(value: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
    }
}

/// Run a query and return every row as a JSON object keyed by column name.
pub fn query_json<P: Params>(conn: &Connection, sql: &str, params: P) -> AppResult<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt.query_map(params, |row| {
        let mut object = Map::new();
        for (index, name) in names.iter().enumerate() {
            object.insert(name.clone(), value_ref_to_json(row.get_ref(index)?));
        }
        Ok(Value::Object(object))
    })?;
    let collected: Result<Vec<_>, _> = rows.collect();
    collected.map_err(AppError::from)
}

pub fn query_one_json<P: Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> AppResult<Option<Value>> {
    Ok(query_json(conn, sql, params)?.into_iter().next())
}

pub fn scalar_i64<P: Params>(conn: &Connection, sql: &str, params: P) -> AppResult<i64> {
    Ok(conn.query_row(sql, params, |r| r.get::<_, i64>(0))?)
}

pub fn scalar_string<P: Params>(conn: &Connection, sql: &str, params: P) -> AppResult<String> {
    Ok(conn.query_row(sql, params, |r| r.get::<_, String>(0))?)
}

/// Trim and reject empty free-text fields with a field-scoped error.
pub fn require_text(value: &str, field: &str, label: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation_field(
            format!("{label} is required."),
            field,
        ));
    }
    Ok(trimmed.to_string())
}

pub fn clamp_limit(limit: usize) -> i64 {
    limit.clamp(1, 500) as i64
}

/// Standard SQL fragment for a party's outstanding amount.
pub const PARTY_BALANCE_SQL: &str = "accounts_parties.cur_bal_scaled";
