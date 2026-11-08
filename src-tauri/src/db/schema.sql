-- Saltbook — Complete SQLite Schema
-- Executed on every startup. All statements are idempotent.
-- Money is stored as INTEGER micro-rupees (scaled x 10000).
-- Percentages are stored as INTEGER basis points (1.00% = 100).

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- 1. Lookup & Configuration Tables
CREATE TABLE IF NOT EXISTS product_groups (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    short_name TEXT,
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS compositions (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL, -- e.g. "Ceftriaxone 500mg"
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tax_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE, -- e.g. "GST-0", "GST-5", "GST-12", "GST-18"
    cgst_bps INTEGER NOT NULL, -- 250 = 2.50%
    sgst_bps INTEGER NOT NULL, -- 250 = 2.50%
    igst_bps INTEGER NOT NULL, -- 500 = 5.00%
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS godowns (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE, -- e.g. "MAIN"
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoice_series (
    id TEXT PRIMARY KEY,
    series_code TEXT NOT NULL UNIQUE, -- e.g. "E" (Estimate), "ABC" (GST Tax)
    series_name TEXT NOT NULL,
    is_estimate INTEGER NOT NULL DEFAULT 0, -- 1 for Series E, 0 for GST Series ABC
    next_inv_no INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

-- 2. Product Master (12,968+ SKUs)
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    pro_code INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,                 -- e.g. "MONOCEF 500 VIAL"
    group_id TEXT REFERENCES product_groups(id),
    pack_unit INTEGER NOT NULL DEFAULT 1,     -- e.g. 1
    pack_subunit INTEGER NOT NULL DEFAULT 10, -- e.g. 10
    pack_form TEXT NOT NULL DEFAULT 'TAB',    -- TAB, CAP, SYP, INJ, DROP, LIQ, OINT, GEN
    case_box_qty INTEGER NOT NULL DEFAULT 1,  -- C/B
    composition_id TEXT REFERENCES compositions(id),
    company_id TEXT REFERENCES companies(id),
    hsn_code TEXT,
    drug_schedule TEXT DEFAULT 'OTC',   -- OTC, H, H1, X, NARCOTIC, COLD_CHAIN
    pur_tax_id TEXT REFERENCES tax_plans(id),
    sale_tax_id TEXT REFERENCES tax_plans(id),
    tin_tax_id TEXT REFERENCES tax_plans(id),
    tout_tax_id TEXT REFERENCES tax_plans(id),
    min_qty INTEGER NOT NULL DEFAULT 0,
    max_qty INTEGER NOT NULL DEFAULT 0,
    weight_grams INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_comp ON products(composition_id);

-- Virtual FTS5 Table for <5ms Incremental Product Search
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
    product_id UNINDEXED,
    name,
    pack_form,
    company_name,
    composition_desc,
    tokenize='trigram'
);

-- 3. Batch-Level Inventory & 12-Column Pricing Table
CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    batch_no TEXT NOT NULL,
    expiry_mm_yy TEXT NOT NULL,         -- Display format: "03/26"
    expiry_sort_key INTEGER NOT NULL,   -- Sort format: 202603 (YYYYMM)
    op_qty INTEGER NOT NULL DEFAULT 0,
    deal_billed INTEGER NOT NULL DEFAULT 0, -- e.g. 10 in "10+4"
    deal_free INTEGER NOT NULL DEFAULT 0,   -- e.g. 4 in "10+4"
    cur_qty INTEGER NOT NULL DEFAULT 0,     -- Physical stock in units
    tax_stock_qty INTEGER NOT NULL DEFAULT 0, -- Book/GST stock in units
    mrp_scaled INTEGER NOT NULL DEFAULT 0,    -- Scaled x10000
    s_rate_scaled INTEGER NOT NULL DEFAULT 0, -- Sales Rate x10000
    t_rate_scaled INTEGER NOT NULL DEFAULT 0, -- Trade Rate x10000
    p_rate_scaled INTEGER NOT NULL DEFAULT 0, -- Purchase Rate x10000
    dis_bps INTEGER NOT NULL DEFAULT 0,       -- 800 = 8.00%
    net_rate_scaled INTEGER NOT NULL DEFAULT 0, -- e.g. 284233 = 28.4233
    godown_id TEXT NOT NULL REFERENCES godowns(id),
    is_provisional INTEGER NOT NULL DEFAULT 0, -- 1 if created inline via Alt+B
    last_supplier_id TEXT,
    last_purchase_inv_id TEXT,
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(product_id, batch_no, godown_id)
);

CREATE INDEX IF NOT EXISTS idx_batches_product_fefo ON batches(product_id, expiry_sort_key ASC);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON batches(expiry_sort_key ASC);

-- 4. Party (Customer) & Supplier Master Tables
CREATE TABLE IF NOT EXISTS accounts_parties (
    id TEXT PRIMARY KEY,
    account_type TEXT NOT NULL, -- 'PARTY' or 'SUPPLIER'
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    address_line1 TEXT,
    address_line2 TEXT,
    address_line3 TEXT,
    city TEXT,
    state TEXT,
    phone_office TEXT,
    phone_res TEXT,
    contact_person TEXT,
    email TEXT,
    creation_date TEXT NOT NULL, -- DD/MM/YYYY
    billing_on_rate TEXT DEFAULT 'S_RATE', -- S_RATE, T_RATE, MRP
    status TEXT DEFAULT 'ACTIVE',
    hq TEXT,
    mr_name TEXT,
    linked_company_id TEXT REFERENCES companies(id), -- Used for Suppliers
    is_inter_state INTEGER NOT NULL DEFAULT 0,
    gst_no TEXT,
    pan_aadhar TEXT,
    dl_no_1 TEXT,
    dl_no_2 TEXT,
    dl_expiry_date TEXT,
    transport_name TEXT,
    banker_name TEXT,
    interest_rate_bps INTEGER NOT NULL DEFAULT 0,
    cr_limit_scaled INTEGER NOT NULL DEFAULT 0,
    cr_days INTEGER NOT NULL DEFAULT 0,
    locking_days INTEGER NOT NULL DEFAULT 0,
    bills_for_locking INTEGER NOT NULL DEFAULT 0,
    op_bal_dr_scaled INTEGER NOT NULL DEFAULT 0,
    op_bal_cr_scaled INTEGER NOT NULL DEFAULT 0,
    cur_bal_scaled INTEGER NOT NULL DEFAULT 0, -- Positive = Dr (Receivable), Negative = Cr (Payable)
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_accounts_type_name ON accounts_parties(account_type, name);

-- 5. Sales & Estimate Invoices Header & Line Items
CREATE TABLE IF NOT EXISTS sales_invoices (
    id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL REFERENCES invoice_series(id),
    series_code TEXT NOT NULL,       -- "E" or "ABC"
    inv_no INTEGER NOT NULL,         -- e.g. 728
    inv_no_display TEXT NOT NULL,    -- e.g. "E728" or "ABC-1"
    inv_date_iso TEXT NOT NULL,      -- "2026-11-04" for fast range filtering
    inv_date_display TEXT NOT NULL,  -- "04/11/2026"
    payment_mode TEXT NOT NULL,      -- "CASH" or "CREDIT"
    party_id TEXT REFERENCES accounts_parties(id),
    party_name_snapshot TEXT NOT NULL,
    city_snapshot TEXT,
    salesman_name TEXT,
    remarks TEXT,
    is_sale_return INTEGER NOT NULL DEFAULT 0,
    reclaimed_scaled INTEGER NOT NULL DEFAULT 0,
    gross_total_scaled INTEGER NOT NULL DEFAULT 0,
    tax_amt_scaled INTEGER NOT NULL DEFAULT 0,
    dis_amt_scaled INTEGER NOT NULL DEFAULT 0,
    dis_bps INTEGER NOT NULL DEFAULT 0,
    freight_scaled INTEGER NOT NULL DEFAULT 0,
    oth_adj_scaled INTEGER NOT NULL DEFAULT 0,
    roundoff_scaled INTEGER NOT NULL DEFAULT 0,
    grand_total_scaled INTEGER NOT NULL DEFAULT 0,
    paid_amt_scaled INTEGER NOT NULL DEFAULT 0,
    due_amt_scaled INTEGER NOT NULL DEFAULT 0,
    converted_to_tax_inv_id TEXT,    -- Populated when Series E is converted to Series ABC
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(series_id, inv_no)
);

CREATE INDEX IF NOT EXISTS idx_sales_date_series ON sales_invoices(inv_date_iso, series_code);
CREATE INDEX IF NOT EXISTS idx_sales_party ON sales_invoices(party_id, inv_date_iso);
CREATE INDEX IF NOT EXISTS idx_sales_updated ON sales_invoices(updated_at);

CREATE TABLE IF NOT EXISTS sales_invoice_items (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
    row_order INTEGER NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    batch_id TEXT NOT NULL REFERENCES batches(id),
    loose_or_box TEXT NOT NULL DEFAULT 'B', -- 'L' or 'B'
    billed_qty INTEGER NOT NULL,
    free_deal_qty INTEGER NOT NULL DEFAULT 0,
    deal_str TEXT,                          -- e.g. "10+4"
    tax_inclusive INTEGER NOT NULL DEFAULT 0, -- 0 = Excl, 1 = Incl
    mrp_scaled INTEGER NOT NULL,
    rate_scaled INTEGER NOT NULL,
    dis_bps INTEGER NOT NULL DEFAULT 0,
    dis_rs_scaled INTEGER NOT NULL DEFAULT 0,
    taxable_amt_scaled INTEGER NOT NULL,
    tax_bps INTEGER NOT NULL DEFAULT 0,
    cgst_amt_scaled INTEGER NOT NULL DEFAULT 0,
    sgst_amt_scaled INTEGER NOT NULL DEFAULT 0,
    igst_amt_scaled INTEGER NOT NULL DEFAULT 0,
    net_unit_rate_scaled INTEGER NOT NULL,
    line_amount_scaled INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_items_invoice ON sales_invoice_items(invoice_id, row_order);

-- 6. Sync Outbox for Google Drive Multi-Client Delta Sync
CREATE TABLE IF NOT EXISTS sync_outbox (
    seq_no INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    entity_table TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL, -- 'UPSERT' or 'DELETE'
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    pushed_at INTEGER
);

-- ============================================================================
-- FTS5 INCREMENTAL SYNC TRIGGERS (products_fts <-> products)
-- ============================================================================
CREATE TRIGGER IF NOT EXISTS trg_products_ai AFTER INSERT ON products
WHEN new.is_deleted = 0
BEGIN
    INSERT INTO products_fts(product_id, name, pack_form, company_name, composition_desc)
    VALUES (
        new.id,
        new.name,
        new.pack_form,
        COALESCE((SELECT name FROM companies WHERE id = new.company_id), ''),
        COALESCE((SELECT description FROM compositions WHERE id = new.composition_id), '')
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_products_ad AFTER DELETE ON products
BEGIN
    DELETE FROM products_fts WHERE product_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_products_au AFTER UPDATE ON products
BEGIN
    DELETE FROM products_fts WHERE product_id = old.id;
    INSERT INTO products_fts(product_id, name, pack_form, company_name, composition_desc)
    SELECT
        new.id,
        new.name,
        new.pack_form,
        COALESCE((SELECT name FROM companies WHERE id = new.company_id), ''),
        COALESCE((SELECT description FROM compositions WHERE id = new.composition_id), '')
    WHERE new.is_deleted = 0;
END;

CREATE TRIGGER IF NOT EXISTS trg_companies_au AFTER UPDATE ON companies
BEGIN
    DELETE FROM products_fts WHERE product_id IN (SELECT id FROM products WHERE company_id = new.id);
    INSERT INTO products_fts(product_id, name, pack_form, company_name, composition_desc)
    SELECT p.id, p.name, p.pack_form, new.name,
           COALESCE((SELECT description FROM compositions WHERE id = p.composition_id), '')
    FROM products p WHERE p.company_id = new.id AND p.is_deleted = 0;
END;

CREATE TRIGGER IF NOT EXISTS trg_compositions_au AFTER UPDATE ON compositions
BEGIN
    DELETE FROM products_fts WHERE product_id IN (SELECT id FROM products WHERE composition_id = new.id);
    INSERT INTO products_fts(product_id, name, pack_form, company_name, composition_desc)
    SELECT p.id, p.name, p.pack_form,
           COALESCE((SELECT name FROM companies WHERE id = p.company_id), ''), new.description
    FROM products p WHERE p.composition_id = new.id AND p.is_deleted = 0;
END;

-- ============================================================================
-- ADDITIONAL TABLES REQUIRED BY PHASES 5 & 6
-- (Purchasing, adjustments, accounting vouchers, sync bookkeeping, settings)
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_invoices (
    id TEXT PRIMARY KEY,
    sup_inv_no TEXT,
    inv_date_iso TEXT NOT NULL,
    inv_date_display TEXT NOT NULL,
    supplier_id TEXT REFERENCES accounts_parties(id),
    supplier_name_snapshot TEXT NOT NULL,
    godown_id TEXT NOT NULL REFERENCES godowns(id),
    payment_mode TEXT NOT NULL DEFAULT 'CREDIT',
    gross_total_scaled INTEGER NOT NULL DEFAULT 0,
    dis_amt_scaled INTEGER NOT NULL DEFAULT 0,
    tax_amt_scaled INTEGER NOT NULL DEFAULT 0,
    freight_scaled INTEGER NOT NULL DEFAULT 0,
    oth_adj_scaled INTEGER NOT NULL DEFAULT 0,
    roundoff_scaled INTEGER NOT NULL DEFAULT 0,
    grand_total_scaled INTEGER NOT NULL DEFAULT 0,
    paid_amt_scaled INTEGER NOT NULL DEFAULT 0,
    due_amt_scaled INTEGER NOT NULL DEFAULT 0,
    remarks TEXT,
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_purchase_date ON purchase_invoices(inv_date_iso);
CREATE INDEX IF NOT EXISTS idx_purchase_supplier ON purchase_invoices(supplier_id);

CREATE TABLE IF NOT EXISTS purchase_invoice_items (
    id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
    row_order INTEGER NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    batch_id TEXT NOT NULL REFERENCES batches(id),
    batch_no TEXT NOT NULL,
    expiry_mm_yy TEXT NOT NULL,
    expiry_sort_key INTEGER NOT NULL,
    billed_qty INTEGER NOT NULL,
    free_deal_qty INTEGER NOT NULL DEFAULT 0,
    deal_billed INTEGER NOT NULL DEFAULT 0,
    deal_free INTEGER NOT NULL DEFAULT 0,
    mrp_scaled INTEGER NOT NULL DEFAULT 0,
    p_rate_scaled INTEGER NOT NULL DEFAULT 0,
    dis_bps INTEGER NOT NULL DEFAULT 0,
    tax_bps INTEGER NOT NULL DEFAULT 0,
    net_rate_scaled INTEGER NOT NULL DEFAULT 0,
    taxable_amt_scaled INTEGER NOT NULL DEFAULT 0,
    tax_amt_scaled INTEGER NOT NULL DEFAULT 0,
    line_amount_scaled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_invoice_items(purchase_id, row_order);

CREATE TABLE IF NOT EXISTS stock_adjustments (
    id TEXT PRIMARY KEY,
    adj_type TEXT NOT NULL,
    adj_date_iso TEXT NOT NULL,
    adj_date_display TEXT NOT NULL,
    godown_id TEXT NOT NULL REFERENCES godowns(id),
    to_godown_id TEXT REFERENCES godowns(id),
    party_id TEXT REFERENCES accounts_parties(id),
    reason TEXT,
    total_value_scaled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_adjustments_date ON stock_adjustments(adj_date_iso);

CREATE TABLE IF NOT EXISTS stock_adjustment_items (
    id TEXT PRIMARY KEY,
    adjustment_id TEXT NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id),
    batch_id TEXT NOT NULL REFERENCES batches(id),
    qty INTEGER NOT NULL,
    rate_scaled INTEGER NOT NULL DEFAULT 0,
    value_scaled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vouchers (
    id TEXT PRIMARY KEY,
    voucher_type TEXT NOT NULL, -- RECEIPT, PAYMENT, CONTRA, JOURNAL, PAYSLIP
    voucher_no INTEGER NOT NULL,
    voucher_no_display TEXT NOT NULL,
    voucher_date_iso TEXT NOT NULL,
    voucher_date_display TEXT NOT NULL,
    account_id TEXT REFERENCES accounts_parties(id),
    contra_account_id TEXT REFERENCES accounts_parties(id),
    amount_scaled INTEGER NOT NULL DEFAULT 0,
    payment_mode TEXT,
    instrument_no TEXT,
    narration TEXT,
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_vouchers_date ON vouchers(voucher_date_iso);
CREATE INDEX IF NOT EXISTS idx_vouchers_account ON vouchers(account_id);

CREATE TABLE IF NOT EXISTS voucher_lines (
    id TEXT PRIMARY KEY,
    voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    account_id TEXT,
    dr_scaled INTEGER NOT NULL DEFAULT 0,
    cr_scaled INTEGER NOT NULL DEFAULT 0,
    narration TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_ledger (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    entry_date_iso TEXT NOT NULL,
    entry_type TEXT NOT NULL, -- SALES, PURCHASE, RECEIPT, PAYMENT, JOURNAL, OPENING
    ref_table TEXT,
    ref_id TEXT,
    ref_no TEXT,
    dr_scaled INTEGER NOT NULL DEFAULT 0,
    cr_scaled INTEGER NOT NULL DEFAULT 0,
    narration TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_account_date ON account_ledger(account_id, entry_date_iso);

CREATE TABLE IF NOT EXISTS supplier_sku_aliases (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL REFERENCES accounts_parties(id),
    alias_name TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(supplier_id, alias_name)
);

CREATE TABLE IF NOT EXISTS sync_applied_files (
    filename TEXT PRIMARY KEY,
    device_id TEXT,
    applied_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpushed ON sync_outbox(pushed_at, seq_no);
