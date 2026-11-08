//! Development demo catalog command.

use serde_json::{json, Value};

use crate::commands::sales;
use crate::db::{demo, get_setting, set_setting};
use crate::error::AppResult;

#[tauri::command]
pub fn seed_demo_catalog(state: tauri::State<'_, crate::AppState>) -> AppResult<Value> {
    let mut conn = state.db.lock()?;
    let counts = demo::seed_masters(&mut *conn)?;
    let device_id = get_setting(&conn, "device_id")?.unwrap_or_else(|| "unknown".into());
    let invoices = sales::seed_demo_invoices(&mut *conn, &device_id)?;
    set_setting(&conn, "demo_seeded", "1")?;
    Ok(json!({
        "products": counts.products,
        "new_batches": counts.batches,
        "parties": counts.parties,
        "suppliers": counts.suppliers,
        "invoices": invoices,
    }))
}
