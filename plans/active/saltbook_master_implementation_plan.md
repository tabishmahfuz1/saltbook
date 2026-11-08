# Saltbook — Master Implementation Plan & Agent Execution Spec

| Document Metadata | Details |
| :--- | :--- |
| **Product Name** | **Saltbook** (Pharmaceutical ERP, Billing, Inventory & Accounting System) |
| **Companion Spec** | *Saltbook — Pharmaceutical ERP & Billing System (SRD & UX Spec)* |
| **Target Audience** | Software Engineers, Code-Generation Models & Local Coding Agent Harnesses |
| **Tech Stack** | Tauri v2 (Rust) + React 18 (TypeScript, Vite, Tailwind CSS, TanStack Table/Virtual, Zustand) + SQLite 3 (WAL + FTS5) + Google Drive REST API v3 |

---

## 1. Global Agent Guardrails & Architectural Invariants

**CRITICAL INSTRUCTIONS FOR CODING MODELS:** Follow these 7 rules in every file you generate. Do not deviate or invent alternative patterns.

1. **No Floating-Point Money or Rates:**
   * Never use `f32`, `f64`, or JavaScript floats for storing currency in SQLite.
   * Store standard monetary amounts (`MRP`, `S.Rate`, `T.Rate`, `P.Rate`, `Invoice Total`) as **`INTEGER` scaled by `10,000` (micro-rupees, where `₹1.00 = 10000`)**. This natively supports the 4-decimal precision required for `NetRate` (e.g., `28.4233` is stored as `284233`).
   * Store percentages (`Dis%`, `Tax%`) in **basis points (`INTEGER` where `1.00% = 100`, e.g., `8.00% = 800`, `5.00% = 500`)**.
2. **UUIDv7 + Human Sequence IDs:**
   * Every database table MUST use `id TEXT PRIMARY KEY` containing a time-ordered **UUIDv7** string so records created offline across multiple PCs never collide during Google Drive sync.
   * Human-readable codes (`pro_code = 249`, `inv_no = 0728`) are stored in separate indexed columns.
3. **Deterministic Keyboard Navigation (`Enter` / `Esc` Contract):**
   * Every form input must register with the global `useKeyboardNav` hook using a sequential `data-nav-index` attribute.
   * Pressing `Enter` inside an input moves focus to `data-nav-index + 1` (not form submit).
   * Pressing `Esc` inside an open dropdown closes the dropdown; pressing `Esc` inside a form checks `formStore.isDirty`:
     * If `isDirty === false`, close the form immediately with **zero** confirmation popups.
     * If `isDirty === true`, open the `<ConfirmExitModal />` (`"Unsaved changes detected. Discard changes and exit? (Y/N)"`).
4. **Single-Step `Ctrl+E` Edit Unlock:**
   * Master forms (`Product`, `Party`, `Supplier`) open existing records in `VIEW_MODE` (inputs `readOnly`).
   * Pressing `Ctrl+E` immediately switches state to `EDIT_MODE`, unlocks inputs, focuses `data-nav-index="1"`, and changes the primary action button to `Save (Ctrl+S)`.
5. **FEFO (First Expiry, First Out) Batch Sorting:**
   * Every batch stores both `expiry_mm_yy TEXT` (`"03/26"`) and `expiry_sort_key INTEGER` (`202603`, calculated as `YYYYMM`).
   * All batch queries during billing MUST order by `expiry_sort_key ASC` where `cur_qty > 0`.
6. **Atomic Transactions & Sync Outbox:**
   * Every `INSERT`, `UPDATE`, or soft-delete (`is_deleted = 1`) in Rust MUST execute inside a single `rusqlite::Transaction` that also inserts a change record into `sync_outbox`.
7. **Strict Error Handling:**
   * Rust Tauri commands must return `Result<T, AppError>` where `AppError` serializes to `{ code: string, message: string, field?: string }` so the frontend renders inline validation banners instead of blocking OS alert boxes.

---

## 2. Exact Repository Directory Structure

Initialize the repository with this exact folder hierarchy:

```text
saltbook/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── index.html
├── src/                                  # React + TypeScript Frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── types/
│   │   ├── database.ts                   # Exact TypeScript interfaces matching SQLite tables
│   │   └── ipc.ts                        # Request/Response payloads for Tauri commands
│   ├── lib/
│   │   ├── invoke.ts                     # Typed wrapper around @tauri-apps/api/core invoke
│   │   ├── math.ts                       # Deterministic micro-rupee, GST, and Deal (10+4) math
│   │   └── format.ts                     # Formatters for ₹ currency, MM/YY expiry, GSTIN checksum
│   ├── stores/
│   │   ├── useWorkspaceStore.ts          # Active MDI child window, modal stack, isDirty flag
│   │   ├── useShortcutsStore.ts          # Global SOLVI Classic Keymap listener
│   │   └── useTickerStore.ts             # Bottom status bar alerts & hover-pause state
│   ├── hooks/
│   │   └── useKeyboardNav.ts             # Enter-to-advance, Esc-to-backtrack focus engine
│   ├── components/
│   │   ├── layout/
│   │   │   ├── TopMenuBar.tsx            # 8 top-level menus with Alt+Key mnemonics
│   │   │   ├── MdiWorkspace.tsx          # Central window host
│   │   │   ├── BottomAlertTicker.tsx     # Interactive hover-to-pause Near Expiry ticker
│   │   │   └── ConfirmExitModal.tsx      # Y/N dirty-state exit dialog
│   │   ├── masters/
│   │   │   ├── ProductMasterForm.tsx     # Ctrl+P: <50ms search + 12-col pinned batch grid
│   │   │   ├── PartyMasterForm.tsx       # Ctrl+Y: Customer debtor + credit locking controls
│   │   │   ├── SupplierMasterForm.tsx    # Ctrl+S: Supplier creditor + company mapping
│   │   │   └── CompanyCompositionForms.tsx
│   │   ├── billing/
│   │   │   ├── SalesInvoiceForm.tsx      # Ctrl+A: Wholesale/Estimate billing + FEFO popover
│   │   │   ├── FefoBatchPopover.tsx      # Inline batch selector + Alt+B Provisional Batch
│   │   │   ├── SubstituteDrawer.tsx      # Ctrl+R: Inline margin-ranked salt substitutes
│   │   │   └── BillModifyForm.tsx        # Ctrl+D: Auto-load date presets + Ctrl+M E-to-ABC
│   │   ├── purchase/
│   │   │   ├── PurchaseInvoiceForm.tsx   # Inward billing + provisional batch reconciliation
│   │   │   └── PurchaseCsvImporter.tsx   # Drag-and-drop CSV/Excel/JSON purchase importer
│   │   ├── adjustment/
│   │   │   └── StockAdjustmentForm.tsx   # Breakage/Expiry, Godown Transfer, Credit/Debit Notes
│   │   ├── accounts/
│   │   │   └── VoucherEntryForm.tsx      # Receipts, Payments, Contra, Journal, PaySlip
│   │   └── settings/
│   │       ├── GoogleDriveSyncPanel.tsx  # OAuth2 login, snapshot backup, delta sync status
│   │       └── SolviMigrationWizard.tsx  # 1-Click legacy SOLVI data importer
└── src-tauri/                            # Rust Backend
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs
        ├── lib.rs
        ├── error.rs                      # Serializable AppError enum
        ├── db/
        │   ├── mod.rs                    # Connection pool, WAL pragma, migration runner
        │   ├── schema.sql                # Complete DDL + FTS5 triggers
        │   └── outbox.rs                 # Helper to append mutations to sync_outbox
        ├── commands/
        │   ├── mod.rs
        │   ├── products.rs               # CRUD + FTS5 search + batch queries
        │   ├── parties_suppliers.rs      # Party/Supplier CRUD + credit lock check
        │   ├── sales.rs                  # Save/Edit invoice, FEFO deduction, E-to-ABC convert
        │   ├── purchases.rs              # Purchase save, provisional batch merge, CSV alias
        │   ├── adjustments_accounts.rs   # Stock adjustments & financial vouchers
        │   └── reports_ticker.rs         # Ticker feed, Stock Query, Composition Query
        └── services/
            ├── calc_engine.rs            # Rust unit-tested billing & GST math
            ├── print_spooler.rs          # Raw ESC/P dot-matrix + PDF/UPI QR generator
            ├── gdrive_backup.rs          # VACUUM INTO + zstd compression + Drive API upload
            └── gdrive_delta_sync.rs      # Outbox delta push/pull & LAN Axum server
```

---

## 3. Complete SQLite Database Schema (`src-tauri/src/db/schema.sql`)

Save this exact SQL schema into `src-tauri/src/db/schema.sql` and execute it on startup:

```sql
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
```

---

## 4. Deterministic Calculation Engine Rules (`calc_engine.rs` & `math.ts`)

Smaller models MUST implement these exact formulas in both `src/lib/math.ts` (for instant UI preview) and `src-tauri/src/services/calc_engine.rs` (for backend validation before saving).

### 4.1 Purchase NetRate Calculation (4-Decimal Precision)
Given a batch row with `P.Rate` ($P$), `Deal` ($B + F$, e.g., $10 + 4$), `Dis%` ($d\%$), and `Pur Tax%` ($t\%$):

1. **Effective Deal Factor:**
   $$\text{DealFactor} = \frac{B}{B + F}$$
   *(If `Deal` is `0+0` or empty, $\text{DealFactor} = 1.0$.)*
2. **Discounted Rate:**
   $$\text{RateAfterDis} = P \times \left(1 - \frac{d}{100}\right) \times \text{DealFactor}$$
3. **NetRate (Inclusive of Purchase GST):**
   $$\text{NetRate} = \text{round\_4\_decimals}\left(\text{RateAfterDis} \times \left(1 + \frac{t}{100}\right)\right)$$

### 4.2 Sales Invoice Line Item & GST Calculation
For each invoice line with `QTY` ($Q$), `RATE` ($R$), `DIS%` ($d\%$), `Tax%` ($t\%$), and `Tax Im-Ex` mode:

1. **Gross Line Amount:** $\text{Gross} = Q \times R$
2. **Line Discount Amount:** $\text{DisAmt} = \text{Gross} \times \frac{d}{100}$
3. **If `Tax Im-Ex` == Exclusive (`0`):**
   * $\text{TaxableAmt} = \text{Gross} - \text{DisAmt}$
   * $\text{TaxAmt} = \text{TaxableAmt} \times \frac{t}{100}$
   * $\text{NetLineAmt} = \text{TaxableAmt} + \text{TaxAmt}$
4. **If `Tax Im-Ex` == Inclusive (`1`):**
   * $\text{NetLineAmt} = \text{Gross} - \text{DisAmt}$
   * $\text{TaxableAmt} = \frac{\text{NetLineAmt}}{1 + \frac{t}{100}}$
   * $\text{TaxAmt} = \text{NetLineAmt} - \text{TaxableAmt}$
5. **Intra-State vs. Inter-State Split:**
   * If `party.is_inter_state == 0`: $\text{CGST} = \frac{\text{TaxAmt}}{2}$, $\text{SGST} = \frac{\text{TaxAmt}}{2}$, $\text{IGST} = 0$.
   * If `party.is_inter_state == 1`: $\text{CGST} = 0$, $\text{SGST} = 0$, $\text{IGST} = \text{TaxAmt}$.
6. **Inventory Deduction Rule:**
   * Total units deducted from `batches.cur_qty` = $\text{BilledQty} + \text{FreeDealQty}$.
   * If the invoice series has `is_estimate == 0` (e.g., `Series ABC`), also deduct from `batches.tax_stock_qty`.

---

## 5. Phased Implementation Plan (Step-by-Step for Coding Agents)

Execute these phases sequentially. Complete and verify all tasks in a phase before starting the next phase.

### Phase 1: Project Scaffolding, SQLite WAL Engine & FTS5 Search
**Goal:** Boot the Tauri v2 + React + SQLite application and verify `<5ms` search across 13,000+ dummy pharmaceutical products.

* **Task 1.1: Initialize Tauri + React + Tailwind Workspace**
  * **Files:** `package.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src/App.tsx`
  * **Dependencies to add in `Cargo.toml`:** `rusqlite = { version = "0.31", features = ["bundled"] }`, `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"`, `uuid = { version = "1", features = ["v7"] }`, `chrono = "0.4"`, `zstd = "0.13"`.
  * **Dependencies to add in `package.json`:** `zustand`, `@tanstack/react-table`, `@tanstack/react-virtual`, `lucide-react`, `clsx`.
* **Task 1.2: Implement SQLite Connection Pool, Schema Runner & Seed Generator**
  * **Files:** `src-tauri/src/db/mod.rs`, `src-tauri/src/db/schema.sql`, `src-tauri/src/db/outbox.rs`
  * **Implementation Steps:**
    1. On app startup, create `saltbook.db` in the OS AppData directory and run `schema.sql`.
    2. Insert default seed records if empty:
       * `tax_plans`: `GST-0` (0%), `GST-5` (5%), `GST-12` (12%), `GST-18` (18%).
       * `godowns`: `MAIN` (`is_default = 1`).
       * `invoice_series`: `E` (`Estimate Series`, `is_estimate = 1`, `next_inv_no = 728`) and `ABC` (`Tax Invoice Series`, `is_estimate = 0`, `next_inv_no = 3`).
    3. Create a development seeder command `seed_demo_catalog` that inserts the sample medicines (`MONOCEF 500 VIAL`, `MONOCEF 250`, `ALBOSLID-P`, `ALMOX-500`, `AMBRODIL PLUS SYP`, `MONO AZI 500 MG TAB`) along with their exact batches (`MPG242952`, `GB1716014`, `MBU1024`) and sample parties (`HIND MEDICAL - BARH`, `ARADHYA PHARMA - BARH`, `SANJAY MEDICO - PATNA`).
  * **Verification Gate:** Run `cargo test` in `src-tauri` to confirm `schema.sql` executes cleanly and FTS5 triggers populate `products_fts`.

---

### Phase 2: Global MDI Shell, Keyboard Navigation Engine & Classic Hotkeys
**Goal:** Build the top menu bar, MDI workspace, `Enter`/`Esc` keyboard navigation hook, smart dirty-state exit guardrails, and interactive bottom ticker.

* **Task 2.1: Build `useKeyboardNav` & `useShortcutsStore`**
  * **Files:** `src/hooks/useKeyboardNav.ts`, `src/stores/useShortcutsStore.ts`, `src/stores/useWorkspaceStore.ts`
  * **Implementation Steps:**
    1. Bind global `window.addEventListener('keydown')` to intercept:
       * `Ctrl+A` -> Open `SalesInvoiceForm` (`New`)
       * `Ctrl+D` -> Open `BillModifyForm` (`Edit`)
       * `Ctrl+P` -> Open `ProductMasterForm`
       * `Ctrl+Y` -> Open `PartyMasterForm`
       * `Ctrl+S` -> Open `SupplierMasterForm` (when no active form is in `EDIT_MODE`; if a form is in `EDIT_MODE`, `Ctrl+S` triggers form `Save`)
       * `Ctrl+L` -> Open `CompanyMasterForm`
       * `Ctrl+Q` -> Open `StockQueryModal`
       * `Ctrl+R` -> Open `SubstituteDrawer`
       * `Ctrl+E` -> Dispatch `UNLOCK_EDIT_MODE` to active master form
       * `F9` -> Trigger safe backup check and exit app
    2. Implement `handleEnterKey(e)`: Queries `[data-nav-index="${currentIndex + 1}"]` within the active form container and calls `.focus()` and `.select()`.
    3. Implement `handleEscapeKey(e)`: Checks `useWorkspaceStore.getState().isDirty`. If `false`, closes active form immediately; if `true`, opens `<ConfirmExitModal />` where pressing `Y` discards changes and `N` returns focus to the form.
* **Task 2.2: Build Top Menu Bar & Interactive Bottom Alert Ticker**
  * **Files:** `src/components/layout/TopMenuBar.tsx`, `src/components/layout/BottomAlertTicker.tsx`
  * **Implementation Steps:**
    1. Render the 8 top menus (`Setup`, `Purchase`, `Sale`, `Adjustment`, `Accounts`, `Window`, `Report`, `Alert & Reminder`) with exact sub-items and shortcut badges on the right.
    2. In `BottomAlertTicker.tsx`, fetch near-expiry batches (`get_ticker_alerts`) and scroll them horizontally via CSS marquee/requestAnimationFrame.
    3. Pause scrolling on `onMouseEnter` and resume on `onMouseLeave`. Clicking any batch chip opens a context menu: `Open in Product Master (Ctrl+P)` or `Write Off in Breakage/Expiry`.
  * **Verification Gate:** Open any mock form, press `Esc` without typing (closes immediately), type 1 character and press `Esc` (shows `Confirm Exit (Y/N)` modal).

---

### Phase 3: Master Modules (`Setup -> Product`, `Party`, `Supplier`, `Company`)
**Goal:** Implement the `Ctrl+P` Product Master with its 12-column pinned batch grid and the `Ctrl+Y` / `Ctrl+S` Party and Supplier forms.

* **Task 3.1: Product Entry / Edit Form (`Ctrl+P`)**
  * **Files:** `src-tauri/src/commands/products.rs`, `src/components/masters/ProductMasterForm.tsx`
  * **Implementation Steps:**
    1. Create Tauri command `search_products(query: String, limit: usize) -> Result<SearchProductResponse, AppError>` that returns `{ total_found: usize, items: Vec<ProductSummary> }` using `products_fts` in `<5ms`.
    2. Render the top search bar with live `Matches Found: X / Total` counter and a 2-column keyboard-navigable dropdown (`Name` and `Pack Form`).
    3. Render the 3-column Product Master header attributes (`Group`, `Pro. Code`, `Pack Size` (`1 x 10 INJ`), `C/B`, `Name`, `Company`, `Comp.`, `HSN Code`, `Pur Tax`, `Sale Tax`, `TIN Tax`, `T. Out Tax`, `Min. Qty`, `Max. Qty`, `Weight in Kg.`).
    4. Render the **12-Column Batch Grid** (`BATCH`, `Expiry`, `CurQty`, `Op.Qty`, `Deal`, `MRP`, `S.Rate`, `T.Rate`, `P.Rate`, `Dis%`, `NetRate`, `Gdn`) with:
       * Sticky left columns (`sticky left-0`) for `BATCH`, `Expiry`, and `CurQty`.
       * Crimson alert styling (`bg-red-100 text-red-700 font-bold`) whenever `cur_qty < 0` (e.g., `-299`).
       * Amber badge (`bg-amber-100 text-amber-800`) when `expiry_sort_key` is within 3 months of current `YYYYMM`.
    5. Wire `Ctrl+E` to immediately unlock all inputs from `VIEW_MODE` to `EDIT_MODE` without requiring a mouse click on the `EDIT` button.
* **Task 3.2: Party (`Ctrl+Y`) & Supplier (`Ctrl+S`) Creation/Edit Forms**
  * **Files:** `src-tauri/src/commands/parties_suppliers.rs`, `src/components/masters/PartyMasterForm.tsx`, `src/components/masters/SupplierMasterForm.tsx`
  * **Implementation Steps:**
    1. Implement shared contact, statutory (`Inter State Operation`, `GST No.`, `PAN/Adhar`, dual `DL No.`), credit control (`Cr Limit`, `Cr Days`, `Locking Days`, `Bills For Locking`), and opening balance (`Op. Bal Dr/Cr`) fields.
    2. Add 15-character GSTIN regex/checksum validation and mutual exclusion between `Op. Bal (Dr)` and `Op. Bal (Cr)`.
  * **Verification Gate:** Search `"MONOC"` in `Ctrl+P`, select `MONOCEF 500 VIAL`, press `Ctrl+E` (unlocks immediately), edit `Min. Qty` to `250`, press `Ctrl+S` (saves to SQLite and appends to `sync_outbox`).

---

### Phase 4: High-Speed Wholesale & Estimate Billing Engine (`Ctrl+A` & `Ctrl+D`)
**Goal:** Build the 7-zone Sales/Estimate Invoice screen (`Ctrl+A`) and the instant Bill Modification screen (`Ctrl+D`).

* **Task 4.1: Sales & Estimate Invoice Screen (`Ctrl+A`)**
  * **Files:** `src-tauri/src/commands/sales.rs`, `src/components/billing/SalesInvoiceForm.tsx`, `src/components/billing/FefoBatchPopover.tsx`, `src/components/billing/SubstituteDrawer.tsx`
  * **Implementation Steps:**
    1. **Zone 1 (Header):** Series selector (`E` or `ABC`), auto-incrementing `Inv No`, `Date`, `Mode` (`CASH`/`CREDIT`), and `Party` autocomplete. Selecting a Party populates `Address`, `City`, `GSTIN`, `DL No.`, and `CUR BAL` (highlighted in red if overdue bills breach `Bills For Locking` or `Cr Limit`).
    2. **Zone 2 (Active Item Context Strip):** Live read-only bar showing `Company`, `Pack`, `C/B`, `Composition`, and `Godown` for the active grid row.
    3. **Zone 3 (Line Item Grid & FEFO Popover):**
       * Typing in `Product Name` opens the incremental search dropdown.
       * Pressing `Enter` on a product opens `<FefoBatchPopover />` sorted by `expiry_sort_key ASC`.
       * If the physical batch strip in the operator's hand is not in the list, pressing `Alt+B` opens the inline **Provisional Batch** mini-row (`Batch No`, `Expiry MM/YY`, `MRP`, `Rate`), creating a batch with `is_provisional = 1` so stock never goes falsely negative without tracking.
       * If selected product has `cur_qty <= 0`, automatically show the `<SubstituteDrawer />` (`Ctrl+R`) listing in-stock items with the same `composition_id` sorted by highest margin `(s_rate - net_rate) DESC`.
    4. **Zone 4–7 (Tax Sub-Grid, Return Toggle, Totals Stack & Validation):**
       * Compute live totals via `math.ts`.
       * If operator presses `Ctrl+S` or clicks `Save`/`Print` when `items.length === 0`, display an inline red banner (`"Please add at least one product line item before saving"`) and focus Row 1 `Product Name`—never show a blocking OS alert box.
* **Task 4.2: Bill Modification & 1-Click Estimate-to-GST Conversion (`Ctrl+D`)**
  * **Files:** `src/components/billing/BillModifyForm.tsx`
  * **Implementation Steps:**
    1. On mount, automatically query invoices for the current month (or `All` in demo mode) without requiring manual date digit edits or clicking `Refresh`.
    2. Render quick date preset chips (`Today`, `Yesterday`, `Last 7 Days`, `This Month`, `Custom Range`) and live debounced filters for `Series` (`E` / `ABC`), `Inv. No`, and `Party`.
    3. Display total record count (`Tot Recd: 586`) and cumulative amount (`₹6,39,278.00`) in the footer.
    4. Implement `Ctrl+M` (**Convert Estimate to GST Invoice**): Converts selected `Series E` estimate bill(s) into formal `Series ABC` GST invoices and deducts `tax_stock_qty`.
  * **Verification Gate:** Create and save an Estimate Bill (`Series E`) and a Tax Bill (`Series ABC`), reopen via `Ctrl+D`, and convert the Estimate Bill to `Series ABC` via `Ctrl+M`.

---

### Phase 5: Purchase Module, CSV Importer, Stock Adjustments & Accounts
**Goal:** Complete inward procurement, provisional batch reconciliation, godown adjustments, and accounting vouchers.

* **Task 5.1: Purchase Invoice & Provisional Batch Reconciliation**
  * **Files:** `src-tauri/src/commands/purchases.rs`, `src/components/purchase/PurchaseInvoiceForm.tsx`, `src/components/purchase/PurchaseCsvImporter.tsx`
  * **Implementation Steps:**
    1. When saving a Purchase Invoice line for `(product_id, batch_no)`, check if a batch with `is_provisional = 1` exists. If found, merge the inward quantity into that batch, update `p_rate_scaled`, `deal_billed`, `deal_free`, `net_rate_scaled`, and set `is_provisional = 0`.
    2. Build `<PurchaseCsvImporter />` to parse supplier CSV/Excel/GST e-Invoice JSON files and save supplier SKU name aliases in a `supplier_sku_aliases` table.
* **Task 5.2: Stock Adjustments & Financial Accounting Vouchers**
  * **Files:** `src-tauri/src/commands/adjustments_accounts.rs`, `src/components/adjustment/StockAdjustmentForm.tsx`, `src/components/accounts/VoucherEntryForm.tsx`
  * **Implementation Steps:**
    1. Support all `Adjustment` types (`Transfer In`, `Transfer Out`, `Replacement In`, `Replacement Out`, `Sample Issue`, `Credit Note`, `Debit Note`, `Stock Shortage`, `Stock SurPlus`, `Godown -> Breakage Expiry`, `Godown Transfer`).
    2. Support all `Accounts` voucher types (`Receipts`, `Payments`, `Contra`, `Journal`, `PaySlip`) with automatic Party/Supplier `cur_bal_scaled` ledger updates.

---

### Phase 6: Google Drive Atomic Backup, Multi-Client Delta Sync & Migration Wizard
**Goal:** Deliver zero-cost cloud backup, optional multi-PC delta synchronization, dot-matrix/PDF printing, and legacy SOLVI migration.

* **Task 6.1: Atomic Google Drive Snapshot Backup (`gdrive_backup.rs`)**
  * **Files:** `src-tauri/src/services/gdrive_backup.rs`, `src/components/settings/GoogleDriveSyncPanel.tsx`
  * **Implementation Steps:**
    1. Implement OAuth 2.0 PKCE login for Google Drive API v3 (`https://www.googleapis.com/auth/drive.file`).
    2. Implement `create_atomic_backup()`:
       * Execute `VACUUM INTO 'saltbook_snapshot.db'` on the SQLite connection.
       * Compress `saltbook_snapshot.db` using `zstd::encode_all` (level 6) into `saltbook_<timestamp>.db.zst`.
       * Upload to `/Saltbook_Backups/` on Google Drive and prune backups older than 30 days.
    3. Trigger automatically every 2 hours and on `F9` application exit.
* **Task 6.2: Multi-Client Delta Sync over Google Drive (`gdrive_delta_sync.rs`)**
  * **Files:** `src-tauri/src/services/gdrive_delta_sync.rs`
  * **Implementation Steps:**
    1. **Push Loop (every 60s):** Query `SELECT * FROM sync_outbox WHERE pushed_at IS NULL LIMIT 500`. Serialize rows to JSON, compress with `zstd` as `<device_id>_<first_seq>_<last_seq>.delta.zst`, upload to `/Saltbook_Sync/deltas/` on Google Drive, and set `pushed_at = now()`.
    2. **Pull Loop (every 60s & on startup):** List files in `/Saltbook_Sync/deltas/` where `device_id != local_device_id` and filename is not in `sync_applied_files`. Download, decompress, apply `UPSERT`/`DELETE` rows where incoming `updated_at >= local.updated_at` (Last-Write-Wins per record + additive batch stock deltas), and record filename in `sync_applied_files`.
* **Task 6.3: Printing Engine & 1-Click Legacy SOLVI Migration Wizard**
  * **Files:** `src-tauri/src/services/print_spooler.rs`, `src/components/settings/SolviMigrationWizard.tsx`
  * **Implementation Steps:**
    1. Implement ESC/P raw byte template for high-speed dot-matrix continuous paper (`Print Continuous - Window Based`) and half-page/A4 PDF invoice generation with dynamic UPI QR code (`upi://pay?pa=<merchant_vpa>&am=<grand_total>`).
    2. Implement `<SolviMigrationWizard />` to import legacy SOLVI `.db`/`.mdb`/`.dbf`/Excel exports directly into `products`, `batches`, `accounts_parties`, and `sales_invoices`, automatically fixing common legacy typos (`"VAIL"` -> `"VIAL"`) during import.