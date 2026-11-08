# Saltbook

Offline-first pharmaceutical ERP, billing, inventory and accounting for a wholesale
medical store — Tauri v2 (Rust) + React 18 + SQLite (WAL + FTS5) + Google Drive.

The implementation follows `plans/active/saltbook_master_implementation_plan.md`.

## Quick start

```bash
npm install
npm run tauri:dev      # real desktop app (Rust + SQLite)
```

Browser preview (design/QA only, in-memory mock persisted to localStorage):

```bash
npm run dev            # http://127.0.0.1:1420
```

Production build and shop deployment:

```bash
npm run build                     # TypeScript + Vite
cd src-tauri && cargo test        # 61 Rust tests
cd src-tauri && cargo build       # desktop binary
npm run tauri:build               # bundle (build on the target OS)
```

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for Windows build prerequisites, installer
paths, shop setup, printer configuration, backup/restore and updating.

On first launch the app creates `saltbook.db` in the OS app-data directory, applies
the schema and seeds tax plans / godown / invoice series. Development builds also
load a demo catalogue; **release builds start with an empty database**. Use
Setup → Load Demo Catalog for training, or `SALTBOOK_NO_DEMO=0` to force demo data.

## Architecture

```text
src/                          React frontend
  types/database.ts           Row types (money in micro-rupees, bps for percentages)
  types/ipc.ts                Tauri command payloads
  lib/math.ts                 Deterministic scaled math (mirrors calc_engine.rs)
  lib/format.ts               ₹ formatting, expiry, GSTIN checksum, date presets
  lib/invoke.ts               Typed invoke wrapper + ApiError
  lib/mockBackend.ts          Browser-only command mock (localStorage)
  stores/                     Workspace (MDI), shortcuts, ticker, toasts
  hooks/useKeyboardNav.ts     Enter-to-advance / Esc-to-back contract
  components/layout           Menu bar, MDI workspace, ticker, dirty-exit modal, status
  components/masters          Product / Party / Supplier / Company & lookups
  components/billing          Sale + FEFO popover + substitutes + Bill Modify
  components/purchase         Purchase invoice + supplier CSV/JSON importer
  components/adjustment       Breakage, transfers, notes, shortage/surplus
  components/accounts         Receipts, payments, contra, journal, payslip
  components/report           Stock query, composition, sales report, ledger
  components/settings         Google Drive sync + SOLVI migration wizard

src-tauri/src/
  db/schema.sql               Complete DDL, FTS5 triggers, extra phase 5–6 tables
  db/mod.rs                   WAL connection, migrations, defaults, helpers
  db/outbox.rs                Change log + additive batch deltas
  db/demo.rs                  SRD sample catalogue
  commands/                   products, parties_suppliers, sales, purchases,
                              adjustments_accounts, reports_ticker, sync, demo
  services/calc_engine.rs     Money/GST/deal math (unit-tested)
  services/print_spooler.rs   ESC/P raw, A4 PDF, UPI QR
  services/gdrive_backup.rs   PKCE, VACUUM INTO + zstd, upload, 30-day prune
  services/gdrive_delta_sync.rs  Outbox push/pull, LWW + batch deltas, LAN Axum
  services/legacy_import.rs   SOLVI .db/.csv/.json/.xlsx/.dbf import + typo repair
```

## Invariants enforced

- **Money** is `INTEGER` micro-rupees (×10,000); **percentages** are basis points.
  No floats in SQLite or in the Rust billing math.
- Every table has a UUIDv7 `TEXT PRIMARY KEY`; human codes live in separate
  indexed columns (`pro_code`, `inv_no`, …).
- Every mutation writes `sync_outbox` in the same transaction. Batch quantity
  changes travel as additive `__qty_delta` / `__tax_qty_delta`; other rows are LWW.
- `Enter` moves to the next `data-nav-index` within the form; it never submits.
  `Esc` closes an open dropdown first, then closes the window. A dirty form opens
  the Y/N confirm dialog; a clean form closes immediately.
- Master forms open read-only; `Ctrl+E` unlocks editing instantly and focuses the
  first field. `Ctrl+S` saves when a form is in edit mode, otherwise opens Supplier
  Master.
- FEFO ordering is always `expiry_sort_key ASC` with `cur_qty > 0`.
- Errors serialize as `{ code, message, field? }` and render as inline banners.

## Keyboard map

| Key | Action |
| --- | --- |
| `Ctrl+A` | New sale / estimate |
| `Ctrl+D` | Bill Modify (auto-loads current month) |
| `Ctrl+P` | Product Master |
| `Ctrl+Y` | Party Master |
| `Ctrl+S` | Supplier Master / save active form |
| `Ctrl+L` | Company & lookups |
| `Ctrl+Q` | Stock Query |
| `Ctrl+R` | Salt substitutes (inline when billing) |
| `Ctrl+E` | Unlock edit on a master |
| `Ctrl+M` | Convert selected estimates to GST |
| `Alt+B` | Provisional batch while billing |
| `F9` | Safe backup then exit |
| `Alt+S/P/A/J/C/W/R/L` | Open top menus |
| `Enter` / `Esc` | Next field / back, close, or confirm exit |

## Modules

- **Product Master** — live FTS5 search with match counter and elapsed time,
  3-column header attributes, and the 12-column batch grid
  (`Batch, Expiry, CurQty, Op.Qty, Deal, MRP, S.Rate, T.Rate, P.Rate, Dis%, NetRate, Gdn`)
  with sticky columns, crimson negative stock and amber near-expiry highlighting.
- **Billing** — 7-zone screen: header/party, active item strip, FEFO batch popover,
  provisional batch (`Alt+B`), substitutes (`Ctrl+R`), GST sub-grid, totals and
  validation. Cash/credit, returns, partial payment, credit locking with override.
- **Bill Modify** — date presets, live filters, totals footer, one-click
  estimate → GST conversion (only tax stock moves) and safe delete with stock restore.
- **Purchase** — inward invoice, supplier SKU alias resolution, provisional-batch
  merge, CSV/JSON importer (XLSX via migration wizard), purchase register.
- **Adjustments** — transfer in/out, replacement in/out, sample issue, credit/debit
  note, shortage, surplus, breakage/expiry and godown transfer.
- **Accounts** — receipts, payments, contra, journal (balanced double entry) and
  payslip, with party ledger updates and statements.
- **Reports** — ticker alerts, stock query with CSV export, composition query,
  sales report, ledger statement and a live status bar.
- **Settings** — Google Drive PKCE login, atomic backup + delta sync, local archive,
  LAN diagnostics, company profile (name, GSTIN, DL, state, invoice start numbers),
  UPI VPA / printer / device settings, SOLVI migration wizard.

## Google Drive setup

1. Google Cloud Console → Credentials → **OAuth client ID → Desktop app**.
2. Register `http://127.0.0.1:1421/oauth2callback` as a redirect URI.
3. Paste the client ID in Setup → Google Drive Sync → Connect.
4. Approve in the browser, then copy the `code` from the redirected URL and paste it
   in the panel. Tokens are stored only in this device's SQLite settings.
5. Backups: `VACUUM INTO` snapshot → zstd level 6 → `/Saltbook_Backups/` (30-day
   retention). Delta sync uses `/Saltbook_Sync/deltas/<device>_<first>_<last>.delta.zst`.

The LAN server (`start_lan_sync_server`) exposes read-only `/health` and `/outbox`
for on-site diagnostics; Google Drive remains the transport.

## Printing

- ESC/P raw bytes for dot-matrix (40-column receipt, cut/feed commands). Windows
  sends RAW through the spooler (`OpenPrinter`/`WritePrinter`); macOS/Linux use
  `lp -o raw`. A spool file is always retained for manual retry.
- A dependency-free A4 PDF writer.
- Dynamic UPI QR (`upi://pay?pa=…&am=…&cu=INR`) rendered inline as SVG.

## Migration

The wizard reads SQLite (`.db`), CSV, JSON, XLSX and dBase III (`.dbf`), normalizes
expiry (MM/YY, YYYY-MM, YYYYMM, DD/MM/YYYY) and repairs common legacy typos
(`VAIL → VIAL`, `SYPUP → SYRUP`, …). Access `.mdb` must be exported to CSV first.
Imports are idempotent by product name + batch number and queue outbox changes.

## Demo data

`db/demo.rs` seeds the SRD fixtures: MONOCEF 500 VIAL / batch MPG242952, ALBOSLID-P /
GB1716014, ALMOX-500 / MBU1024, HIND MEDICAL - BARH, ARADHYA PHARMA - BARH and
SANJAY MEDICO - PATNA, plus a wider catalogue with varied expiries, negative stock
and credit terms. Load it any time from Setup → Load Demo Catalog.

## Multi-PC provisioning

Delta sync assumes shared lookup identifiers (godowns, tax plans, invoice series).
Provision every additional PC from a Google Drive snapshot of the first device
(Setup → Google Drive Sync → Backup now, restore the `.db.zst`) before enabling
delta sync. Invoice numbering remains per-device; use one billing station per
series or separate series codes when two PCs bill concurrently.

## Known constraints

- The Google OAuth flow uses a copy/paste authorization code (no embedded client
  secret). A loopback listener can replace this later without changing storage.
- The LAN endpoint is diagnostic; full peer sync runs through Drive deltas.
- Legacy `.mdb`/`.accdb` files are rejected with an export-to-CSV instruction.
- Installers are unsigned and there is no auto-updater yet; updates are manual.
- Windows RAW printing is compile-checked but must be verified with the shop's
  actual printer driver and queue during commissioning.
