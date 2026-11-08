//! Saltbook — Tauri application entry point and command registration.

pub mod commands;
pub mod db;
pub mod error;
pub mod services;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;

use db::Db;

pub struct AppState {
    pub db: Arc<Db>,
    pub db_dir: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("saltbook.db");
            let db = Db::open(&db_path)?;

            // First run: seed the SRD demo catalog so every screen has data.
            // Demo data is for development/training. Release builds start with an
            // empty database unless SALTBOOK_NO_DEMO=0 or the operator loads the
            // demo catalogue from Setup.
            let demo_env = std::env::var("SALTBOOK_NO_DEMO").ok();
            let want_demo = match demo_env.as_deref() {
                Some("1") => false,
                Some("0") => true,
                _ => cfg!(debug_assertions),
            };
            if want_demo {
                let mut conn = db.lock()?;
                let products = commands::scalar_i64(
                    &conn,
                    "SELECT COUNT(*) FROM products WHERE is_deleted = 0",
                    [],
                )?;
                let already = db::get_setting(&conn, "demo_seeded")?.unwrap_or_default();
                if products == 0 && already != "1" {
                    match db::demo::seed_masters(&mut conn) {
                        Ok(_) => {
                            let device_id = db::get_setting(&conn, "device_id")?
                                .unwrap_or_else(|| "unknown".into());
                            let _ = commands::sales::seed_demo_invoices(&mut conn, &device_id);
                            let _ = db::set_setting(&conn, "demo_seeded", "1");
                        }
                        Err(err) => eprintln!("[saltbook] demo seed skipped: {}", err.message),
                    }
                }
            }

            let db = Arc::new(db);
            commands::sync::spawn_workers(db.clone(), data_dir.clone());
            app.manage(AppState { db, db_dir: data_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Products & lookups
            commands::products::search_products,
            commands::products::get_product,
            commands::products::next_product_code,
            commands::products::save_product,
            commands::products::delete_product,
            commands::products::list_lookups,
            commands::products::save_lookup,
            // Parties & suppliers
            commands::parties_suppliers::search_accounts,
            commands::parties_suppliers::get_account,
            commands::parties_suppliers::save_account,
            commands::parties_suppliers::next_account_code,
            commands::parties_suppliers::account_credit_status,
            // Sales
            commands::sales::next_invoice_no,
            commands::sales::save_invoice,
            commands::sales::get_invoice,
            commands::sales::list_invoices,
            commands::sales::fefo_batches,
            commands::sales::substitutes,
            commands::sales::create_provisional_batch,
            commands::sales::convert_estimates_to_tax,
            commands::sales::delete_invoice,
            commands::sales::invoice_print_payload,
            commands::sales::print_invoice,
            commands::sales::export_invoice_pdf,
            // Purchases
            commands::purchases::save_purchase,
            commands::purchases::get_purchase,
            commands::purchases::list_purchases,
            commands::purchases::save_sku_alias,
            commands::purchases::list_sku_aliases,
            commands::purchases::import_purchase_rows,
            // Adjustments & accounts
            commands::adjustments_accounts::list_adjustment_types,
            commands::adjustments_accounts::list_voucher_types,
            commands::adjustments_accounts::save_adjustment,
            commands::adjustments_accounts::list_adjustments,
            commands::adjustments_accounts::save_voucher,
            commands::adjustments_accounts::list_vouchers,
            // Reports & ticker
            commands::reports_ticker::get_ticker_alerts,
            commands::reports_ticker::stock_query,
            commands::reports_ticker::composition_query,
            commands::reports_ticker::sales_report,
            commands::reports_ticker::ledger_report,
            commands::reports_ticker::window_summary,
            commands::reports_ticker::batch_movement_history,
            // Sync, backup & migration
            commands::sync::get_sync_status,
            commands::sync::set_sync_settings,
            commands::sync::start_gdrive_login,
            commands::sync::complete_gdrive_login,
            commands::sync::gdrive_disconnect,
            commands::sync::run_backup_now,
            commands::sync::run_delta_sync_now,
            commands::sync::list_backups,
            commands::sync::start_lan_sync_server,
            commands::sync::migration_preview,
            commands::sync::migration_import,
            // Dev seeding
            commands::demo::seed_demo_catalog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Saltbook");
}
