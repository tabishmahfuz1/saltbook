/**
 * Browser-only mock of the Rust command surface.
 *
 * It exists so the UI can be designed, previewed and visually reviewed in a
 * plain browser. In the packaged Tauri app every command goes to Rust instead.
 * Money stays in micro-rupees; the same calc engine is used for totals.
 */

import type {
  AccountParty,
  Batch,
  CreditStatus,
  LedgerEntry,
  Product,
  PurchaseInvoice,
  PurchaseInvoiceItem,
  SalesInvoice,
  SalesInvoiceItem,
  StockAdjustment,
  Voucher,
  WindowSummary,
} from "../types/database";
import {
  addMonthsToKey,
  buildGstin,
  currentExpiryKey,
  daysToExpiry,
  expiryDisplayFromKey,
  todayDisplay,
  todayIso,
  validateGstin,
} from "./format";
import { calcNetRate, invoiceTotals, lineTotals } from "./math";

const STORAGE_KEY = "saltbook-mock-v2";
const DEVICE_ID = "mock-device-0001";

interface SeriesRow {
  id: string;
  is_deleted?: number;
  series_code: string;
  series_name: string;
  is_estimate: number;
  next_inv_no: number;
}

interface MockDb {
  products: Product[];
  batches: Batch[];
  parties: AccountParty[];
  invoices: SalesInvoice[];
  invoiceItems: SalesInvoiceItem[];
  purchases: PurchaseInvoice[];
  purchaseItems: PurchaseInvoiceItem[];
  adjustments: StockAdjustment[];
  vouchers: Voucher[];
  ledger: Array<LedgerEntry & { id: string; account_id: string; ref_table?: string; ref_id?: string }>;
  series: SeriesRow[];
  groups: Array<{ id: string; code: string; name: string }>;
  companies: Array<{ id: string; code: string; name: string }>;
  compositions: Array<{ id: string; code: string; description: string }>;
  godowns: Array<{ id: string; code: string; name: string; is_default: number }>;
  taxPlans: Array<{ id: string; name: string; cgst_bps: number; sgst_bps: number; igst_bps: number }>;
  aliases: Array<{ id: string; supplier_id: string; alias_name: string; product_id: string }>;
  settings: Record<string, string>;
  outbox: number;
  appliedFiles: number;
}

const id = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const now = () => Date.now();
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function money(rupees: number): number {
  return Math.round(rupees * 10_000);
}

function error(code: string, message: string, field?: string): never {
  throw { code, message, field };
}

function taxPlan(db: MockDb, name: string) {
  return db.taxPlans.find((plan) => plan.name === name) ?? db.taxPlans[2];
}

function expiredWithin(months: number): number {
  return addMonthsToKey(currentExpiryKey(), months);
}

function activeProduct(db: MockDb, productId: string) {
  const product = db.products.find((item) => item.id === productId && !item.is_deleted);
  if (!product) error("NOT_FOUND", "Product not found.");
  return product;
}

function activeBatch(db: MockDb, batchId: string) {
  const batch = db.batches.find((item) => item.id === batchId && !item.is_deleted);
  if (!batch) error("NOT_FOUND", "Batch not found.");
  return batch;
}

function activeParty(db: MockDb, partyId: string) {
  const party = db.parties.find((item) => item.id === partyId && !item.is_deleted);
  if (!party) error("NOT_FOUND", "Account not found.");
  return party;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const PRODUCT_SEED: Array<[string, number, string, string, string, string, number, number, number, number, number, number, string, string]> = [
  // name, code, company, composition, form, schedule, mrp, s_rate, t_rate, p_rate, dis_bps, tax%, hsn, group
  ["MONOCEF 500 VIAL", 249, "CIPLA", "Ceftriaxone 500mg", "INJ", "H", 285, 228, 199.5, 142.5, 800, 5, "30042019", "ANTIBIOTICS"],
  ["MONOCEF 250 VIAL", 250, "CIPLA", "Ceftriaxone 250mg", "INJ", "H", 168, 134.4, 117.6, 84, 800, 5, "30042019", "ANTIBIOTICS"],
  ["ALBOSLID-P", 118, "MANKIND", "Albendazole 400mg + Ivermectin 6mg", "TAB", "OTC", 95, 76, 66.5, 47.5, 1000, 12, "30049099", "ANTIBIOTICS"],
  ["ALMOX-500", 304, "ALKEM", "Amoxicillin 500mg", "CAP", "H", 210, 168, 147, 105, 1000, 12, "30041020", "ANTIBIOTICS"],
  ["AMBRODIL PLUS SYP", 102, "CIPLA", "Ambroxol 30mg + Guaiphenesin 50mg + Terbutaline 1.25mg", "SYP", "H", 142, 113.6, 99.4, 71, 1000, 12, "30049099", "RESPIRATORY"],
  ["MONO AZI 500 MG TAB", 88, "CIPLA", "Azithromycin 500mg", "TAB", "H", 330, 264, 231, 165, 1000, 12, "30042019", "ANTIBIOTICS"],
  ["CALPOL 650", 415, "SUN PHARMA", "Paracetamol 650mg", "TAB", "OTC", 62, 49.6, 43.4, 31, 1000, 12, "30049099", "ANALGESICS"],
  ["PAN-D CAP", 512, "ALKEM", "Pantoprazole 40mg + Domperidone 30mg", "CAP", "H", 245, 196, 171.5, 122.5, 1000, 12, "30049099", "GASTRO"],
  ["GLYCOMET 500", 603, "USV", "Metformin 500mg", "TAB", "H", 48, 38.4, 33.6, 24, 1000, 5, "30049099", "CARDIAC"],
  ["TELMA 40", 701, "GLENMARK", "Telmisartan 40mg", "TAB", "H", 128, 102.4, 89.6, 64, 1000, 12, "30049099", "CARDIAC"],
  ["ATORVA 10", 702, "ZYDUS", "Atorvastatin 10mg", "TAB", "H", 156, 124.8, 109.2, 78, 1000, 12, "30049099", "CARDIAC"],
  ["MONTECIP-LC", 803, "CIPLA", "Montelukast 10mg + Levocetirizine 5mg", "TAB", "H", 185, 148, 129.5, 92.5, 1000, 12, "30049099", "RESPIRATORY"],
  ["AUGMENTIN 625", 628, "GLAXO", "Amoxicillin 500mg + Clavulanic 125mg", "TAB", "H", 385, 308, 269.5, 192.5, 1000, 12, "30041020", "ANTIBIOTICS"],
  ["THYRONORM 50", 634, "ABBOTT", "Thyroxine 50mcg", "TAB", "H", 175, 140, 122.5, 87.5, 1000, 5, "30049099", "CARDIAC"],
  ["LANTUS SOLOSTAR", 618, "ABBOTT", "Insulin Glargine 100IU", "INJ", "COLD_CHAIN", 1180, 944, 826, 590, 500, 5, "30043190", "INJECTABLES"],
  ["BETADINE OINT", 635, "ABBOTT", "Povidone Iodine 5%", "OINT", "OTC", 68, 54.4, 47.6, 34, 800, 12, "30049099", "DERMA"],
];

function seedState(): MockDb {
  const db: MockDb = {
    products: [],
    batches: [],
    parties: [],
    invoices: [],
    invoiceItems: [],
    purchases: [],
    purchaseItems: [],
    adjustments: [],
    vouchers: [],
    ledger: [],
    series: [
      { id: "series-e", series_code: "E", series_name: "Estimate Series", is_estimate: 1, next_inv_no: 728 },
      { id: "series-abc", series_code: "ABC", series_name: "Tax Invoice Series", is_estimate: 0, next_inv_no: 3 },
    ],
    groups: [],
    companies: [],
    compositions: [],
    godowns: [{ id: "godown-main", code: "MAIN", name: "Main Godown", is_default: 1 }],
    taxPlans: [
      { id: "tax-0", name: "GST-0", cgst_bps: 0, sgst_bps: 0, igst_bps: 0 },
      { id: "tax-5", name: "GST-5", cgst_bps: 250, sgst_bps: 250, igst_bps: 500 },
      { id: "tax-12", name: "GST-12", cgst_bps: 600, sgst_bps: 600, igst_bps: 1200 },
      { id: "tax-18", name: "GST-18", cgst_bps: 900, sgst_bps: 900, igst_bps: 1800 },
    ],
    aliases: [],
    settings: {
      device_id: DEVICE_ID,
      device_name: "FRONT DESK",
      company_name: "SALTBOOK PHARMACEUTICALS",
      company_address: "MAIN ROAD, BARH, PATNA - 803213",
      company_gst_no: "10ABCDE1234F1ZF",
      company_dl_no: "BR-20B/0001",
      merchant_vpa: "saltbook@upi",
      gdrive_connected: "0",
      auto_backup: "1",
      auto_sync: "0",
      backup_interval_hours: "2",
      sync_interval_secs: "60",
      last_backup_at: "0",
      last_sync_at: "0",
      gdrive_client_id: "",
    },
    outbox: 0,
    appliedFiles: 0,
  };

  const groupNames = ["ANTIBIOTICS", "ANALGESICS", "GASTRO", "CARDIAC", "RESPIRATORY", "INJECTABLES", "DERMA"];
  db.groups = groupNames.map((name) => ({ id: `group-${name}`, code: name, name }));
  const companyNames = ["CIPLA", "ALKEM", "MANKIND", "SUN PHARMA", "MICRO LABS", "ABBOTT", "ZYDUS", "TORRENT", "INTAS", "GLENMARK", "USV", "GLAXO"];
  db.companies = companyNames.map((name) => ({ id: `company-${name.replace(/\s/g, "-")}`, code: name.replace(/\s/g, ""), name }));
  const compositionNames = Array.from(new Set(PRODUCT_SEED.map((row) => row[3])));
  db.compositions = compositionNames.map((name, index) => ({ id: `comp-${index + 1}`, code: `CMP${String(index + 1).padStart(3, "0")}`, description: name }));

  let stamp = now();
  PRODUCT_SEED.forEach((row, index) => {
    const [name, code, company, composition, form, schedule, mrp, sRate, tRate, pRate, disBps, taxPct, hsn, group] = row;
    const tax = taxPlan(db, `GST-${taxPct}`);
    const companyRow = db.companies.find((item) => item.name === company);
    const compositionRow = db.compositions.find((item) => item.description === composition);
    const groupRow = db.groups.find((item) => item.name === group);
    const product: Product = {
      id: `product-${code}`,
      pro_code: code,
      name,
      group_id: groupRow?.id ?? null,
      group_name: groupRow?.name ?? null,
      company_id: companyRow?.id ?? null,
      company_name: company,
      composition_id: compositionRow?.id ?? null,
      composition_desc: composition,
      pack_unit: 1,
      pack_subunit: form === "TAB" || form === "CAP" ? 10 + (index % 3) * 5 : 1,
      pack_form: form,
      case_box_qty: 1,
      hsn_code: hsn,
      drug_schedule: schedule,
      pur_tax_id: tax.id,
      pur_tax_name: tax.name,
      pur_tax_bps: tax.cgst_bps + tax.sgst_bps,
      sale_tax_id: tax.id,
      sale_tax_name: tax.name,
      sale_tax_bps: tax.cgst_bps + tax.sgst_bps,
      tin_tax_id: tax.id,
      tout_tax_id: tax.id,
      min_qty: 10 + (code % 40),
      max_qty: 200 + (code % 300),
      weight_grams: 20 + (code % 80),
      updated_at: stamp,
      is_deleted: 0,
    };
    db.products.push(product);

    const pinned: Record<number, Array<[string, number, number]>> = {
      249: [["MPG242952", 202603, 128], ["MPG242953", expiredWithin(9), -299], ["MPG242954", expiredWithin(20), 64]],
      118: [["GB1716014", expiredWithin(2), 45], ["GB1716015", expiredWithin(15), 90]],
      304: [["MBU1024", expiredWithin(11), 210], ["MBU1025", expiredWithin(23), 380]],
    };
    const lots =
      pinned[code] ??
      [0, 1, 2].map((lot) => {
        const qty = Math.floor(((code * 7) % 180 + 20) / (lot + 1));
        return [
          `${name.slice(0, 3).replace(/\s/g, "")}${String(code % 100).padStart(2, "0")}${lot + 1}`,
          addMonthsToKey(currentExpiryKey(), 1 + lot * 13 + (index % 3)),
          qty,
        ] as [string, number, number];
      });
    lots.forEach(([batchNo, expiry, qty], lotIndex) => {
      const dealBilled = code % 5 === 0 ? 10 : code % 3 === 0 ? 10 : 0;
      const dealFree = code % 5 === 0 ? 4 : code % 3 === 0 ? 1 : 0;
      const p = money(pRate);
      const taxBps = tax.cgst_bps + tax.sgst_bps;
      const batch: Batch = {
        id: `batch-${code}-${lotIndex}`,
        product_id: product.id,
        batch_no: batchNo,
        expiry_mm_yy: expiryDisplayFromKey(expiry),
        expiry_sort_key: expiry,
        op_qty: qty,
        deal_billed: dealBilled,
        deal_free: dealFree,
        cur_qty: qty,
        tax_stock_qty: code % 11 === 0 ? 0 : qty,
        mrp_scaled: money(mrp),
        s_rate_scaled: money(sRate),
        t_rate_scaled: money(tRate),
        p_rate_scaled: p,
        dis_bps: disBps,
        net_rate_scaled: calcNetRate(p, dealBilled, dealFree, disBps, taxBps),
        godown_id: "godown-main",
        godown_code: "MAIN",
        is_provisional: 0,
        updated_at: stamp,
        is_deleted: 0,
      };
      db.batches.push(batch);
    });
    stamp += 1000;
  });

  const partySeed: Array<[string, string, string, string, number, number, number, number, number]> = [
    ["C001", "HIND MEDICAL - BARH", "BARH", "ABCDE1234F", 48250, 500000, 30, 15, 2],
    ["C002", "ARADHYA PHARMA - BARH", "BARH", "PQRSX5678K", 18760, 300000, 21, 15, 1],
    ["C003", "SANJAY MEDICO - PATNA", "PATNA", "LMNOP4321Q", 92500, 750000, 45, 30, 3],
    ["C004", "SHREE BALAJI MEDICAL - PATNA", "PATNA", "RSTUV8765W", 0, 250000, 30, 0, 0],
    ["C005", "KUMAR MEDICO - BAKHTIYARPUR", "BAKHTIYARPUR", "GHIJK1122L", 6400, 150000, 21, 15, 1],
    ["C006", "JAI MAA DURGA PHARMA - BEGUSARAI", "BEGUSARAI", "WXYZA7766B", 21300, 400000, 30, 21, 2],
  ];
  partySeed.forEach(([code, name, city, pan, opening, limit, crDays, lockingDays, bills], index) => {
    db.parties.push({
      id: `party-${code}`,
      account_type: "PARTY",
      code,
      name,
      address_line1: name,
      address_line2: null,
      address_line3: null,
      city,
      state: "BIHAR",
      phone_office: `98765${String(43210 + index).slice(0, 5)}`,
      phone_res: null,
      contact_person: "MR. VERMA",
      email: null,
      creation_date: "01/04/2024",
      billing_on_rate: index % 2 === 0 ? "S_RATE" : "T_RATE",
      status: "ACTIVE",
      hq: null,
      mr_name: null,
      linked_company_id: null,
      is_inter_state: 0,
      gst_no: buildGstin("10", pan),
      pan_aadhar: pan,
      dl_no_1: "BR-20B/1234",
      dl_no_2: "BR-21B/5678",
      dl_expiry_date: null,
      transport_name: null,
      banker_name: null,
      interest_rate_bps: 0,
      cr_limit_scaled: money(limit),
      cr_days: crDays,
      locking_days: lockingDays,
      bills_for_locking: bills,
      op_bal_dr_scaled: money(opening),
      op_bal_cr_scaled: 0,
      cur_bal_scaled: money(opening),
      updated_at: now(),
      is_deleted: 0,
    });
  });

  const supplierSeed: Array<[string, string, string, string, number]> = [
    ["S001", "MEDPLUS DISTRIBUTORS - PATNA", "PATNA", "MDPST4455A", 125000],
    ["S002", "CIPLA C&F AGENCY - PATNA", "PATNA", "CIPCF7788B", 82500],
    ["S003", "ALKEM AGENCY - MUZAFFARPUR", "MUZAFFARPUR", "ALKMA9900C", 46200],
    ["S004", "MANKIND DISTRIBUTOR - PATNA", "PATNA", "MNKND1122D", 31750],
  ];
  supplierSeed.forEach(([code, name, city, pan, opening], index) => {
    db.parties.push({
      id: `supplier-${code}`,
      account_type: "SUPPLIER",
      code,
      name,
      address_line1: name,
      address_line2: null,
      address_line3: null,
      city,
      state: "BIHAR",
      phone_office: `91122${String(33445 + index).slice(0, 5)}`,
      phone_res: null,
      contact_person: null,
      email: null,
      creation_date: "01/04/2024",
      billing_on_rate: "P_RATE",
      status: "ACTIVE",
      hq: null,
      mr_name: null,
      linked_company_id: null,
      is_inter_state: 0,
      gst_no: buildGstin("10", pan),
      pan_aadhar: pan,
      dl_no_1: null,
      dl_no_2: null,
      dl_expiry_date: null,
      transport_name: null,
      banker_name: null,
      interest_rate_bps: 0,
      cr_limit_scaled: 0,
      cr_days: 0,
      locking_days: 0,
      bills_for_locking: 0,
      op_bal_dr_scaled: 0,
      op_bal_cr_scaled: money(opening),
      cur_bal_scaled: -money(opening),
      updated_at: now(),
      is_deleted: 0,
    });
  });

  db.aliases.push(
    { id: id("alias"), supplier_id: "supplier-S001", alias_name: "MONOCEF 500", product_id: "product-249" },
    { id: id("alias"), supplier_id: "supplier-S001", alias_name: "MONOCEF INJ 500", product_id: "product-249" },
  );
  return db;
}

let cache: MockDb | null = null;

function load(): MockDb {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      cache = JSON.parse(raw) as MockDb;
      return cache;
    }
  } catch {
    /* fall through to a fresh seed */
  }
  cache = seedState();
  save();
  return cache;
}

function save() {
  if (!cache) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* storage may be unavailable in private mode */
  }
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

function productSummary(db: MockDb, product: Product): Product {
  const batches = db.batches.filter((batch) => batch.product_id === product.id && !batch.is_deleted);
  const last = [...batches].sort((a, b) => b.updated_at - a.updated_at)[0];
  return {
    ...product,
    total_cur_qty: batches.reduce((sum, batch) => sum + batch.cur_qty, 0),
    total_tax_qty: batches.reduce((sum, batch) => sum + batch.tax_stock_qty, 0),
    mrp_scaled: last?.mrp_scaled ?? 0,
    s_rate_scaled: last?.s_rate_scaled ?? 0,
    t_rate_scaled: last?.t_rate_scaled ?? 0,
    p_rate_scaled: last?.p_rate_scaled ?? 0,
    batch_count: batches.length,
  };
}

function decorateBatch(batch: Batch): Batch {
  const current = currentExpiryKey();
  return {
    ...batch,
    expiry_display: expiryDisplayFromKey(batch.expiry_sort_key),
    deal_str: batch.deal_billed > 0 ? `${batch.deal_billed}+${batch.deal_free}` : "",
    is_expired: batch.expiry_sort_key < current,
    is_near_expiry: batch.expiry_sort_key <= addMonthsToKey(current, 3),
    is_negative: batch.cur_qty < 0,
  };
}

function creditStatus(db: MockDb, party: AccountParty, newBill: number, mode: string): CreditStatus {
  const overdue = db.invoices.filter((invoice) => {
    if (invoice.party_id !== party.id || invoice.is_deleted || invoice.payment_mode !== "CREDIT") return false;
    if (invoice.due_amt_scaled <= 0) return false;
    const age = (Date.now() - new Date(`${invoice.inv_date_iso}T12:00:00`).getTime()) / 86_400_000;
    return age > (party.locking_days || party.cr_days);
  });
  const reasons: string[] = [];
  if (mode === "CREDIT") {
    if (party.cr_limit_scaled > 0 && party.cur_bal_scaled + newBill > party.cr_limit_scaled) {
      reasons.push(
        `Credit limit exceeded: outstanding ₹${(party.cur_bal_scaled / 10000).toFixed(2)} plus this bill.`,
      );
    }
    if (party.bills_for_locking > 0 && overdue.length >= party.bills_for_locking) {
      reasons.push(`${overdue.length} unpaid bill(s) older than ${party.locking_days || party.cr_days} days.`);
    }
  }
  return {
    locked: reasons.length > 0,
    reasons,
    credit_limit_scaled: party.cr_limit_scaled,
    outstanding_scaled: party.cur_bal_scaled,
    available_scaled: Math.max(0, party.cr_limit_scaled - party.cur_bal_scaled),
    overdue_count: overdue.length,
    overdue_amount_scaled: overdue.reduce((sum, invoice) => sum + invoice.due_amt_scaled, 0),
    locking_days: party.locking_days || party.cr_days,
    bills_for_locking: party.bills_for_locking,
  };
}

function invoiceDetail(db: MockDb, invoiceId: string) {
  const invoice = db.invoices.find((item) => item.id === invoiceId && !item.is_deleted);
  if (!invoice) error("NOT_FOUND", "Invoice not found.");
  const items = db.invoiceItems
    .filter((item) => item.invoice_id === invoiceId)
    .sort((a, b) => a.row_order - b.row_order)
    .map((item) => {
      const product = db.products.find((p) => p.id === item.product_id);
      const batch = db.batches.find((b) => b.id === item.batch_id);
      return {
        ...item,
        product_name: product?.name ?? "",
        pro_code: product?.pro_code ?? 0,
        pack_form: product?.pack_form ?? "TAB",
        batch_no: batch?.batch_no ?? "",
        expiry_mm_yy: batch?.expiry_mm_yy ?? "",
        batch_cur_qty: batch?.cur_qty ?? 0,
        batch_tax_qty: batch?.tax_stock_qty ?? 0,
        godown_code: batch?.godown_code ?? "MAIN",
        company_name: product?.company_name ?? "",
        composition_desc: product?.composition_desc ?? "",
      };
    });
  const party = invoice.party_id ? db.parties.find((p) => p.id === invoice.party_id) : null;
  return {
    invoice,
    items,
    party: party
      ? {
          account: party,
          credit: creditStatus(db, party, 0, "CREDIT"),
          recent: db.invoices
            .filter((row) => row.party_id === party.id && !row.is_deleted)
            .sort((a, b) => b.inv_date_iso.localeCompare(a.inv_date_iso))
            .slice(0, 12),
        }
      : null,
  };
}

function allocateInvoiceNumber(db: MockDb, seriesCode: string): { series: SeriesRow; invNo: number; display: string } {
  const series = db.series.find((row) => row.series_code === seriesCode && !row.is_deleted);
  if (!series) error("NOT_FOUND", `Invoice series '${seriesCode}' is not configured.`);
  const invNo = series.next_inv_no;
  series.next_inv_no += 1;
  return {
    series,
    invNo,
    display: series.series_code === "E" ? `E${invNo}` : `${series.series_code}-${invNo}`,
  };
}

function applyStock(batch: Batch, qty: number, isEstimate: boolean, direction: 1 | -1) {
  batch.cur_qty += direction * qty;
  if (!isEstimate) batch.tax_stock_qty += direction * qty;
  batch.updated_at = now();
  batch.is_negative = batch.cur_qty < 0;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function searchProducts(db: MockDb, query: string, limit: number) {
  const text = query.trim().toLowerCase();
  const matches = db.products
    .filter((product) => !product.is_deleted)
    .filter((product) => {
      if (!text) return true;
      return (
        product.name.toLowerCase().includes(text) ||
        String(product.pro_code).includes(text) ||
        (product.company_name ?? "").toLowerCase().includes(text) ||
        (product.composition_desc ?? "").toLowerCase().includes(text)
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const items = matches.slice(0, limit).map((product) => productSummary(db, product));
  return {
    items,
    total_found: matches.length,
    total_products: db.products.filter((p) => !p.is_deleted).length,
    elapsed_ms: 0.8,
  };
}

function saveInvoice(db: MockDb, req: Record<string, unknown>): string {
  const request = req as {
    invoice_id?: string;
    series_code: string;
    inv_date_display?: string;
    payment_mode: "CASH" | "CREDIT";
    party_id: string;
    salesman_name?: string;
    remarks?: string;
    is_sale_return?: boolean;
    freight_scaled?: number;
    oth_adj_scaled?: number;
    reclaimed_scaled?: number;
    paid_amt_scaled?: number;
    override_credit_lock?: boolean;
    items: Array<{
      product_id: string;
      batch_id: string;
      billed_qty: number;
      free_deal_qty?: number;
      loose_or_box?: "L" | "B";
      tax_inclusive?: boolean;
      mrp_scaled: number;
      rate_scaled: number;
      dis_bps?: number;
      tax_bps?: number | null;
    }>;
  };
  if (!request.items?.length) {
    error("EMPTY_INVOICE", "Please add at least one product line item before saving.");
  }
  const party = activeParty(db, request.party_id);
  const seriesRow = db.series.find((row) => row.series_code === request.series_code);
  if (!seriesRow) error("NOT_FOUND", "Invoice series not found.");
  const isEstimate = seriesRow.is_estimate === 1;
  const isReturn = Boolean(request.is_sale_return);
  const interState = party.is_inter_state === 1;

  const resolved = request.items.map((item) => {
    const product = activeProduct(db, item.product_id);
    const batch = activeBatch(db, item.batch_id);
    if (batch.product_id !== product.id) error("VALIDATION", "Batch does not belong to product.", "batch_id");
    const taxBps = item.tax_bps ?? product.sale_tax_bps ?? 0;
    const totals = lineTotals({
      qty: item.billed_qty,
      free_qty: item.free_deal_qty ?? 0,
      rate_scaled: item.rate_scaled,
      dis_bps: item.dis_bps ?? 0,
      tax_bps: taxBps,
      tax_inclusive: item.tax_inclusive,
      is_inter_state: interState,
    });
    return { item, product, batch, taxBps, totals, qty: item.billed_qty + (item.free_deal_qty ?? 0) };
  });

  const currentInvoice = request.invoice_id
    ? db.invoices.find((invoice) => invoice.id === request.invoice_id && !invoice.is_deleted)
    : null;
  if (request.invoice_id && !currentInvoice) error("NOT_FOUND", "Invoice to edit was not found.");

  const totals = invoiceTotals(
    resolved.map((row) => row.totals),
    request.freight_scaled ?? 0,
    request.oth_adj_scaled ?? 0,
    request.reclaimed_scaled ?? 0,
    request.paid_amt_scaled ?? 0,
    isReturn,
  );
  if (!isReturn) {
    if (request.payment_mode === "CASH") {
      totals.paid_amt_scaled = totals.grand_total_scaled;
      totals.due_amt_scaled = 0;
    }
  }

  if (request.payment_mode === "CREDIT" && !isReturn && !request.override_credit_lock) {
    const status = creditStatus(db, party, Math.max(0, totals.due_amt_scaled), "CREDIT");
    if (status.locked) error("CREDIT_LOCKED", status.reasons.join(" "), "party_id");
  }

  if (!isReturn) {
    const required = new Map<string, number>();
    resolved.forEach((row) => {
      required.set(row.batch.id, (required.get(row.batch.id) ?? 0) + row.qty);
    });
    required.forEach((qty, batchId) => {
      const batch = activeBatch(db, batchId);
      if (qty > batch.cur_qty) {
        error(
          "STOCK_NEGATIVE",
          `${batch.batch_no} has only ${batch.cur_qty} unit(s) but ${qty} are billed. Reduce quantity, add a provisional batch (Alt+B), or pick a substitute (Ctrl+R).`,
          "billed_qty",
        );
      }
    });
  }

  // Reverse the previous version of an edited invoice.
  if (currentInvoice) {
    const oldItems = db.invoiceItems.filter((item) => item.invoice_id === currentInvoice.id);
    oldItems.forEach((item) => {
      const batch = db.batches.find((row) => row.id === item.batch_id);
      if (batch) applyStock(batch, item.billed_qty + item.free_deal_qty, seriesRow.is_estimate === 1, 1);
    });
    db.invoiceItems = db.invoiceItems.filter((item) => item.invoice_id !== currentInvoice.id);
    if (currentInvoice.payment_mode === "CREDIT") {
      party.cur_bal_scaled -= currentInvoice.due_amt_scaled;
    }
    db.ledger = db.ledger.filter((entry) => entry.ref_id !== currentInvoice.id);
  }

  const allocated = currentInvoice
    ? {
        series: seriesRow,
        invNo: currentInvoice.inv_no,
        display: currentInvoice.inv_no_display,
      }
    : allocateInvoiceNumber(db, request.series_code);
  const invoiceId = currentInvoice?.id ?? id("invoice");
  const invoiceDateDisplay = request.inv_date_display?.trim() || todayDisplay();
  const invoiceDateIso = (() => {
    try {
      const [dd, mm, yyyy] = invoiceDateDisplay.split("/");
      return `${yyyy}-${mm}-${dd}`;
    } catch {
      return todayIso();
    }
  })();

  const sign = isReturn ? -1 : 1;
  const invoice: SalesInvoice = {
    id: invoiceId,
    series_id: allocated.series.id,
    series_code: allocated.series.series_code,
    series_name: allocated.series.series_name,
    is_estimate: allocated.series.is_estimate,
    inv_no: allocated.invNo,
    inv_no_display: allocated.display,
    inv_date_iso: invoiceDateIso,
    inv_date_display: invoiceDateDisplay,
    payment_mode: request.payment_mode,
    party_id: party.id,
    party_name_snapshot: party.name,
    city_snapshot: party.city,
    salesman_name: request.salesman_name ?? null,
    remarks: request.remarks ?? null,
    is_sale_return: isReturn ? 1 : 0,
    reclaimed_scaled: (request.reclaimed_scaled ?? 0) * sign,
    gross_total_scaled: totals.gross_total_scaled,
    tax_amt_scaled: totals.tax_amt_scaled,
    dis_amt_scaled: totals.dis_amt_scaled,
    dis_bps: totals.dis_bps,
    freight_scaled: (request.freight_scaled ?? 0) * sign,
    oth_adj_scaled: (request.oth_adj_scaled ?? 0) * sign,
    roundoff_scaled: totals.roundoff_scaled,
    grand_total_scaled: totals.grand_total_scaled,
    paid_amt_scaled: totals.paid_amt_scaled,
    due_amt_scaled: totals.due_amt_scaled,
    converted_to_tax_inv_id: null,
    updated_at: now(),
    is_deleted: 0,
  };
  if (currentInvoice) Object.assign(currentInvoice, invoice);
  else db.invoices.push(invoice);

  resolved.forEach((row, index) => {
    const item: SalesInvoiceItem = {
      id: id("item"),
      invoice_id: invoiceId,
      row_order: index,
      product_id: row.product.id,
      batch_id: row.batch.id,
      loose_or_box: row.item.loose_or_box ?? "B",
      billed_qty: row.item.billed_qty,
      free_deal_qty: row.item.free_deal_qty ?? 0,
      deal_str: row.batch.deal_billed > 0 ? `${row.batch.deal_billed}+${row.batch.deal_free}` : null,
      tax_inclusive: row.item.tax_inclusive ? 1 : 0,
      mrp_scaled: row.item.mrp_scaled || row.batch.mrp_scaled,
      rate_scaled: row.item.rate_scaled,
      dis_bps: row.item.dis_bps ?? 0,
      dis_rs_scaled: row.totals.dis_amt_scaled * sign,
      taxable_amt_scaled: row.totals.taxable_amt_scaled * sign,
      tax_bps: row.taxBps,
      cgst_amt_scaled: row.totals.cgst_amt_scaled * sign,
      sgst_amt_scaled: row.totals.sgst_amt_scaled * sign,
      igst_amt_scaled: row.totals.igst_amt_scaled * sign,
      net_unit_rate_scaled: row.totals.net_unit_rate_scaled * sign,
      line_amount_scaled: row.totals.net_line_scaled * sign,
      updated_at: now(),
    };
    db.invoiceItems.push(item);
    applyStock(row.batch, row.qty, isEstimate, isReturn ? 1 : -1);
    db.outbox += 1;
  });

  if (request.payment_mode === "CREDIT" || isReturn) {
    const delta = isReturn ? totals.grand_total_scaled : totals.due_amt_scaled;
    party.cur_bal_scaled += delta;
    db.ledger.push({
      id: id("ledger"),
      account_id: party.id,
      entry_date_iso: invoice.inv_date_iso,
      entry_type: "SALES",
      ref_table: "sales_invoices",
      ref_id: invoiceId,
      ref_no: invoice.inv_no_display,
      dr_scaled: totals.grand_total_scaled > 0 ? totals.grand_total_scaled : 0,
      cr_scaled: totals.grand_total_scaled < 0 ? -totals.grand_total_scaled : 0,
      narration: `Sales invoice ${invoice.inv_no_display}`,
      created_at: now(),
    });
    if (totals.paid_amt_scaled > 0) {
      db.ledger.push({
        id: id("ledger"),
        account_id: party.id,
        entry_date_iso: invoice.inv_date_iso,
        entry_type: "RECEIPT",
        ref_table: "sales_invoices",
        ref_id: invoiceId,
        ref_no: invoice.inv_no_display,
        dr_scaled: 0,
        cr_scaled: totals.paid_amt_scaled,
        narration: "Amount received",
        created_at: now(),
      });
    }
  }
  db.outbox += 1;
  save();
  return invoiceId;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const delay = (ms = 25) => new Promise((resolve) => window.setTimeout(resolve, ms));

export async function mockInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  await delay();
  const db = load();
  const req = (args?.req ?? {}) as Record<string, never> & Record<string, never> & Record<string, never> & Record<string, any>;

  switch (command) {
    case "search_products": {
      return searchProducts(db, String(req.query ?? ""), Number(req.limit ?? 25)) as T;
    }
    case "get_product": {
      const product = req.id
        ? activeProduct(db, String(req.id))
        : db.products.find((row) => row.pro_code === Number(req.pro_code) && !row.is_deleted);
      if (!product) error("NOT_FOUND", "Product not found.");
      const batches = db.batches
        .filter((batch) => batch.product_id === product.id && !batch.is_deleted)
        .sort((a, b) => a.expiry_sort_key - b.expiry_sort_key)
        .map(decorateBatch);
      return {
        product: productSummary(db, product),
        batches,
        stats: {
          batch_count: batches.length,
          total_cur_qty: batches.reduce((sum, batch) => sum + batch.cur_qty, 0),
          total_tax_qty: batches.reduce((sum, batch) => sum + batch.tax_stock_qty, 0),
          stock_value_scaled: batches.reduce((sum, batch) => sum + batch.cur_qty * batch.p_rate_scaled, 0),
        },
      } as T;
    }
    case "next_product_code": {
      return { pro_code: Math.max(...db.products.map((p) => p.pro_code), 100) + 1 } as T;
    }
    case "save_product": {
      const request = req as unknown as Record<string, any>;
      if (!String(request.name ?? "").trim()) error("VALIDATION", "Product name is required.", "name");
      const existing = request.id ? db.products.find((p) => p.id === request.id) : null;
      let product: Product;
      if (existing) {
        product = existing;
        Object.assign(product, {
          name: String(request.name).trim(),
          pro_code: Number(request.pro_code ?? existing.pro_code),
          pack_unit: Number(request.pack_unit ?? 1),
          pack_subunit: Number(request.pack_subunit ?? 10),
          pack_form: String(request.pack_form ?? "TAB"),
          case_box_qty: Number(request.case_box_qty ?? 1),
          hsn_code: request.hsn_code ?? null,
          drug_schedule: String(request.drug_schedule ?? "OTC"),
          min_qty: Number(request.min_qty ?? 0),
          max_qty: Number(request.max_qty ?? 0),
          weight_grams: Number(request.weight_grams ?? 0),
          updated_at: now(),
        });
        if (request.company_name && !request.company_id) {
          let company = db.companies.find((row) => row.name.toLowerCase() === String(request.company_name).toLowerCase());
          if (!company) {
            company = { id: id("company"), code: String(request.company_name).toUpperCase().slice(0, 8), name: String(request.company_name) };
            db.companies.push(company);
          }
          product.company_id = company.id;
          product.company_name = company.name;
        }
      } else {
        const code = Number(request.pro_code ?? 0) || Math.max(...db.products.map((p) => p.pro_code), 100) + 1;
        if (db.products.some((p) => p.pro_code === code)) {
          error("DUPLICATE", `Pro. Code ${code} is already used by another product.`, "pro_code");
        }
        let company = db.companies.find((row) => row.name.toLowerCase() === String(request.company_name ?? "").toLowerCase());
        if (!company && request.company_name) {
          company = { id: id("company"), code: String(request.company_name).toUpperCase().slice(0, 8), name: String(request.company_name) };
          db.companies.push(company);
        }
        let composition = db.compositions.find(
          (row) => row.description.toLowerCase() === String(request.composition_desc ?? "").toLowerCase(),
        );
        if (!composition && request.composition_desc) {
          composition = { id: id("comp"), code: `CMP${db.compositions.length + 1}`, description: String(request.composition_desc) };
          db.compositions.push(composition);
        }
        product = {
          id: id("product"),
          pro_code: code,
          name: String(request.name).trim(),
          group_id: request.group_id ?? null,
          company_id: company?.id ?? null,
          company_name: company?.name ?? "",
          composition_id: composition?.id ?? null,
          composition_desc: composition?.description ?? "",
          pack_unit: Number(request.pack_unit ?? 1),
          pack_subunit: Number(request.pack_subunit ?? 10),
          pack_form: String(request.pack_form ?? "TAB"),
          case_box_qty: Number(request.case_box_qty ?? 1),
          hsn_code: request.hsn_code ?? null,
          drug_schedule: String(request.drug_schedule ?? "OTC"),
          pur_tax_id: request.pur_tax_id ?? "tax-12",
          pur_tax_name: "GST-12",
          pur_tax_bps: 1200,
          sale_tax_id: request.sale_tax_id ?? "tax-12",
          sale_tax_name: "GST-12",
          sale_tax_bps: 1200,
          tin_tax_id: request.tin_tax_id ?? "tax-12",
          tout_tax_id: request.tout_tax_id ?? "tax-12",
          min_qty: Number(request.min_qty ?? 0),
          max_qty: Number(request.max_qty ?? 0),
          weight_grams: Number(request.weight_grams ?? 0),
          updated_at: now(),
          is_deleted: 0,
        };
        db.products.push(product);
      }
      (request.batches ?? []).forEach((batch: Record<string, any>) => {
        const existingBatch = batch.id
          ? db.batches.find((row) => row.id === batch.id)
          : db.batches.find(
              (row) => row.product_id === product.id && row.batch_no === batch.batch_no && row.godown_id === "godown-main",
            );
        const target =
          existingBatch ??
          ({
            id: id("batch"),
            product_id: product.id,
            batch_no: "",
            expiry_mm_yy: "",
            expiry_sort_key: 0,
            op_qty: 0,
            deal_billed: 0,
            deal_free: 0,
            cur_qty: 0,
            tax_stock_qty: 0,
            mrp_scaled: 0,
            s_rate_scaled: 0,
            t_rate_scaled: 0,
            p_rate_scaled: 0,
            dis_bps: 0,
            net_rate_scaled: 0,
            godown_id: "godown-main",
            godown_code: "MAIN",
            is_provisional: 0,
            updated_at: now(),
            is_deleted: 0,
          } as Batch);
        const expiry = String(batch.expiry_mm_yy ?? "12/28");
        const [mm, yy] = expiry.split("/");
        Object.assign(target, {
          batch_no: String(batch.batch_no ?? "").toUpperCase(),
          expiry_mm_yy: expiry,
          expiry_sort_key: Number(`20${yy}${mm}`),
          op_qty: Number(batch.op_qty ?? 0),
          deal_billed: Number(batch.deal_billed ?? 0),
          deal_free: Number(batch.deal_free ?? 0),
          cur_qty: Number(batch.cur_qty ?? 0),
          tax_stock_qty: Number(batch.tax_stock_qty ?? 0),
          mrp_scaled: Number(batch.mrp_scaled ?? 0),
          s_rate_scaled: Number(batch.s_rate_scaled ?? 0),
          t_rate_scaled: Number(batch.t_rate_scaled ?? 0),
          p_rate_scaled: Number(batch.p_rate_scaled ?? 0),
          dis_bps: Number(batch.dis_bps ?? 0),
          net_rate_scaled: calcNetRate(
            Number(batch.p_rate_scaled ?? 0),
            Number(batch.deal_billed ?? 0),
            Number(batch.deal_free ?? 0),
            Number(batch.dis_bps ?? 0),
            product.pur_tax_bps ?? 1200,
          ),
          updated_at: now(),
        });
        if (!existingBatch) db.batches.push(target);
      });
      db.outbox += 1;
      save();
      return {
        product: productSummary(db, product),
        batches: db.batches.filter((b) => b.product_id === product.id && !b.is_deleted).map(decorateBatch),
        stats: {
          batch_count: 0,
          total_cur_qty: 0,
          total_tax_qty: 0,
          stock_value_scaled: 0,
        },
      } as T;
    }
    case "delete_product": {
      const product = activeProduct(db, String(req.id));
      product.is_deleted = 1;
      save();
      return { ok: true } as T;
    }
    case "list_lookups": {
      const kind = String(req.kind ?? "");
      let items: any[] = [];
      if (kind === "groups") items = db.groups;
      else if (kind === "companies") items = db.companies;
      else if (kind === "compositions") items = db.compositions.map((row) => ({ ...row, name: row.description }));
      else if (kind === "tax_plans") items = db.taxPlans.map((row) => ({ ...row, code: row.name, total_bps: row.cgst_bps + row.sgst_bps }));
      else if (kind === "godowns") items = db.godowns;
      else if (kind === "series") items = db.series.map((row) => ({ ...row, code: row.series_code, name: row.series_name }));
      else if (kind === "pack_forms") items = ["TAB", "CAP", "SYP", "INJ", "DROP", "LIQ", "OINT", "GEN"].map((code) => ({ id: code, code, name: code }));
      else if (kind === "schedules") items = ["OTC", "H", "H1", "X", "NARCOTIC", "COLD_CHAIN"].map((code) => ({ id: code, code, name: code }));
      return { items } as T;
    }
    case "save_lookup": {
      const kind = String(req.kind ?? "");
      const name = String(req.name ?? req.description ?? "");
      if (!name.trim()) error("VALIDATION", "Name is required.", "name");
      if (kind === "companies") {
        const row = { id: req.id ?? id("company"), code: String(req.code ?? name.slice(0, 8)).toUpperCase(), name };
        db.companies = db.companies.filter((item) => item.id !== row.id).concat(row);
        return { id: row.id, name } as T;
      }
      if (kind === "groups") {
        const row = { id: req.id ?? id("group"), code: String(req.code ?? name.slice(0, 8)).toUpperCase(), name };
        db.groups = db.groups.filter((item) => item.id !== row.id).concat(row);
        return { id: row.id, name } as T;
      }
      if (kind === "compositions") {
        const row = { id: req.id ?? id("comp"), code: String(req.code ?? "CMP"), description: name };
        db.compositions = db.compositions.filter((item) => item.id !== row.id).concat(row);
        return { id: row.id, name } as T;
      }
      if (kind === "godowns") {
        const row = { id: req.id ?? id("godown"), code: String(req.code ?? name.slice(0, 6)).toUpperCase(), name, is_default: req.is_default ? 1 : 0 };
        db.godowns = db.godowns.filter((item) => item.id !== row.id).concat(row);
        return { id: row.id, name } as T;
      }
      return { id: id("lookup"), name } as T;
    }
    case "search_accounts": {
      const type = String(req.account_type ?? "PARTY");
      const query = String(req.query ?? "").trim().toLowerCase();
      const matches = db.parties
        .filter((row) => row.account_type === type && !row.is_deleted)
        .filter((row) => !query || row.name.toLowerCase().includes(query) || row.code.toLowerCase().includes(query) || (row.city ?? "").toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        items: matches.slice(0, Number(req.limit ?? 25)).map((row) => ({
          ...row,
          open_bills: db.invoices.filter((invoice) => invoice.party_id === row.id && invoice.due_amt_scaled > 0 && !invoice.is_deleted).length,
        })),
        total_found: matches.length,
      } as T;
    }
    case "get_account": {
      const account = db.parties.find((row) => (row.id === req.id || row.code === req.code) && !row.is_deleted);
      if (!account) error("NOT_FOUND", "Account not found.");
      return {
        account,
        credit: creditStatus(db, account, 0, "CREDIT"),
        recent: db.invoices.filter((row) => row.party_id === account.id && !row.is_deleted).slice(0, 12),
      } as T;
    }
    case "save_account": {
      const request = req as unknown as Record<string, any>;
      const name = String(request.name ?? "").trim();
      if (!name) error("VALIDATION", "Name is required.", "name");
      if (Number(request.op_bal_dr_scaled ?? 0) !== 0 && Number(request.op_bal_cr_scaled ?? 0) !== 0) {
        error("VALIDATION", "Opening balance cannot be both Dr and Cr.", "op_bal_cr_scaled");
      }
      if (request.gst_no) {
        const gstError = validateGstin(String(request.gst_no));
        if (gstError) error("VALIDATION", gstError, "gst_no");
      }
      const existing = request.id ? db.parties.find((row) => row.id === request.id) : null;
      if (existing) {
        const oldOpening = existing.op_bal_dr_scaled - existing.op_bal_cr_scaled;
        Object.assign(existing, request, {
          is_inter_state: request.is_inter_state ? 1 : 0,
          updated_at: now(),
        });
        const newOpening = Number(request.op_bal_dr_scaled ?? 0) - Number(request.op_bal_cr_scaled ?? 0);
        existing.cur_bal_scaled += newOpening - oldOpening;
      } else {
        const opening = Number(request.op_bal_dr_scaled ?? 0) - Number(request.op_bal_cr_scaled ?? 0);
        const target: AccountParty = {
          id: id("account"),
          account_type: request.account_type,
          code: String(request.code ?? `${request.account_type === "PARTY" ? "C" : "S"}${String(db.parties.length + 1).padStart(3, "0")}`),
          name,
          address_line1: request.address_line1 ?? null,
          address_line2: request.address_line2 ?? null,
          address_line3: request.address_line3 ?? null,
          city: request.city ?? null,
          state: request.state ?? "BIHAR",
          phone_office: request.phone_office ?? null,
          phone_res: request.phone_res ?? null,
          contact_person: request.contact_person ?? null,
          email: request.email ?? null,
          creation_date: request.creation_date ?? todayDisplay(),
          billing_on_rate: request.billing_on_rate ?? "S_RATE",
          status: request.status ?? "ACTIVE",
          hq: request.hq ?? null,
          mr_name: request.mr_name ?? null,
          linked_company_id: request.linked_company_id ?? null,
          is_inter_state: request.is_inter_state ? 1 : 0,
          gst_no: request.gst_no ?? null,
          pan_aadhar: request.pan_aadhar ?? null,
          dl_no_1: request.dl_no_1 ?? null,
          dl_no_2: request.dl_no_2 ?? null,
          dl_expiry_date: request.dl_expiry_date ?? null,
          transport_name: request.transport_name ?? null,
          banker_name: request.banker_name ?? null,
          interest_rate_bps: Number(request.interest_rate_bps ?? 0),
          cr_limit_scaled: Number(request.cr_limit_scaled ?? 0),
          cr_days: Number(request.cr_days ?? 0),
          locking_days: Number(request.locking_days ?? 0),
          bills_for_locking: Number(request.bills_for_locking ?? 0),
          op_bal_dr_scaled: Number(request.op_bal_dr_scaled ?? 0),
          op_bal_cr_scaled: Number(request.op_bal_cr_scaled ?? 0),
          cur_bal_scaled: opening,
          updated_at: now(),
          is_deleted: 0,
        };
        db.parties.push(target);
      }
      db.outbox += 1;
      save();
      const account = existing ?? db.parties[db.parties.length - 1];
      return {
        account,
        credit: creditStatus(db, account, 0, "CREDIT"),
        recent: db.invoices.filter((row) => row.party_id === account.id && !row.is_deleted).slice(0, 12),
      } as T;
    }
    case "next_account_code": {
      const prefix = String(req.account_type ?? "PARTY") === "PARTY" ? "C" : "S";
      const codes = db.parties
        .filter((row) => row.code.startsWith(prefix))
        .map((row) => Number(row.code.slice(1)))
        .filter((value) => Number.isFinite(value));
      return { code: `${prefix}${String(Math.max(0, ...codes) + 1).padStart(3, "0")}` } as T;
    }
    case "account_credit_status": {
      const account = activeParty(db, String(req.account_id));
      return creditStatus(db, account, Number(req.new_invoice_scaled ?? 0), String(req.payment_mode ?? "CREDIT")) as T;
    }
    case "next_invoice_no": {
      const series = db.series.find((row) => row.series_code === req.series_code);
      if (!series) error("NOT_FOUND", "Series not found.");
      return {
        series_code: series.series_code,
        is_estimate: series.is_estimate === 1,
        inv_no: series.next_inv_no,
        inv_no_display: series.series_code === "E" ? `E${series.next_inv_no}` : `${series.series_code}-${series.next_inv_no}`,
        inv_date_display: todayDisplay(),
        inv_date_iso: todayIso(),
      } as T;
    }
    case "save_invoice": {
      const invoiceId = saveInvoice(db, req);
      return invoiceDetail(db, invoiceId) as T;
    }
    case "get_invoice": {
      return invoiceDetail(db, String(req.invoice_id)) as T;
    }
    case "list_invoices": {
      let rows = db.invoices.filter((invoice) => !invoice.is_deleted);
      if (req.from_iso) rows = rows.filter((invoice) => invoice.inv_date_iso >= String(req.from_iso));
      if (req.to_iso) rows = rows.filter((invoice) => invoice.inv_date_iso <= String(req.to_iso));
      if (req.series_code) rows = rows.filter((invoice) => invoice.series_code === req.series_code);
      if (req.payment_mode) rows = rows.filter((invoice) => invoice.payment_mode === req.payment_mode);
      const query = String(req.query ?? "").trim().toLowerCase();
      if (query) {
        rows = rows.filter(
          (invoice) =>
            invoice.party_name_snapshot.toLowerCase().includes(query) ||
            invoice.inv_no_display.toLowerCase().includes(query),
        );
      }
      rows = rows.sort((a, b) => b.inv_date_iso.localeCompare(a.inv_date_iso) || b.inv_no - a.inv_no);
      const totalAmount = rows.reduce((sum, invoice) => sum + invoice.grand_total_scaled, 0);
      const totalDue = rows.reduce((sum, invoice) => sum + invoice.due_amt_scaled, 0);
      return {
        items: rows.slice(Number(req.offset ?? 0), Number(req.offset ?? 0) + Number(req.limit ?? 50)).map((invoice) => ({
          ...invoice,
          item_count: db.invoiceItems.filter((item) => item.invoice_id === invoice.id).length,
        })),
        total_count: rows.length,
        total_amount_scaled: totalAmount,
        total_due_scaled: totalDue,
      } as T;
    }
    case "fefo_batches": {
      const items = db.batches
        .filter((batch) => batch.product_id === req.product_id && !batch.is_deleted)
        .filter((batch) => req.include_empty || batch.cur_qty > 0)
        .sort((a, b) => a.expiry_sort_key - b.expiry_sort_key)
        .map((batch) => {
          const product = db.products.find((row) => row.id === batch.product_id);
          return {
            ...decorateBatch(batch),
            product_name: product?.name,
            pack_form: product?.pack_form,
            tax_bps: product?.sale_tax_bps ?? 0,
          };
        });
      return { items } as T;
    }
    case "substitutes": {
      const product = activeProduct(db, String(req.product_id));
      const items = db.products
        .filter((row) => row.composition_id && row.composition_id === product.composition_id && row.id !== product.id && !row.is_deleted)
        .map((row) => {
          const batches = db.batches.filter((batch) => batch.product_id === row.id && batch.cur_qty > 0 && !batch.is_deleted);
          const top = [...batches].sort((first, second) => (second.s_rate_scaled - second.net_rate_scaled) - (first.s_rate_scaled - first.net_rate_scaled))[0];
          return {
            id: row.id,
            pro_code: row.pro_code,
            name: row.name,
            pack_form: row.pack_form,
            pack_unit: row.pack_unit,
            pack_subunit: row.pack_subunit,
            company_name: row.company_name ?? "",
            composition_desc: row.composition_desc ?? "",
            cur_qty: batches.reduce((sum, batch) => sum + batch.cur_qty, 0),
            s_rate_scaled: top?.s_rate_scaled ?? 0,
            net_rate_scaled: top?.net_rate_scaled ?? 0,
            mrp_scaled: top?.mrp_scaled ?? 0,
            margin_scaled: top ? top.s_rate_scaled - top.net_rate_scaled : 0,
            nearest_expiry: batches.length ? Math.min(...batches.map((batch) => batch.expiry_sort_key)) : null,
          };
        })
        .filter((row) => row.cur_qty > 0)
        .sort((a, b) => b.margin_scaled - a.margin_scaled)
        .slice(0, Number(req.limit ?? 12));
      return { items } as T;
    }
    case "create_provisional_batch": {
      const product = activeProduct(db, String(req.product_id));
      const batchNo = String(req.batch_no ?? "").trim().toUpperCase();
      if (!batchNo) error("VALIDATION", "Batch number is required.", "batch_no");
      if (db.batches.some((batch) => batch.product_id === product.id && batch.batch_no === batchNo)) {
        error("DUPLICATE", `Batch ${batchNo} already exists for this product.`, "batch_no");
      }
      const [mm, yy] = String(req.expiry_mm_yy ?? "12/28").split("/");
      const qty = Number(req.qty ?? 0);
      const batch: Batch = {
        id: id("batch"),
        product_id: product.id,
        batch_no: batchNo,
        expiry_mm_yy: `${mm}/${yy}`,
        expiry_sort_key: Number(`20${yy}${mm}`),
        op_qty: qty,
        deal_billed: 0,
        deal_free: 0,
        cur_qty: qty,
        tax_stock_qty: 0,
        mrp_scaled: Number(req.mrp_scaled ?? 0),
        s_rate_scaled: Number(req.rate_scaled ?? 0),
        t_rate_scaled: Number(req.rate_scaled ?? 0),
        p_rate_scaled: Number(req.rate_scaled ?? 0),
        dis_bps: 0,
        net_rate_scaled: calcNetRate(Number(req.rate_scaled ?? 0), 0, 0, 0, product.pur_tax_bps ?? 0),
        godown_id: "godown-main",
        godown_code: "MAIN",
        is_provisional: 1,
        updated_at: now(),
        is_deleted: 0,
      };
      db.batches.push(batch);
      db.outbox += 1;
      save();
      return { batch: decorateBatch({ ...batch, product_name: product.name, tax_bps: product.sale_tax_bps }) } as T;
    }
    case "convert_estimates_to_tax": {
      const ids = (req.invoice_ids ?? []) as string[];
      const converted = ids.map((invoiceId) => {
        const estimate = db.invoices.find((invoice) => invoice.id === invoiceId && !invoice.is_deleted);
        if (!estimate) error("NOT_FOUND", "Invoice not found.");
        if (estimate.series_code !== "E") error("VALIDATION", "Only estimates can be converted.");
        if (estimate.converted_to_tax_inv_id) error("VALIDATION", "Estimate was already converted.");
        const allocated = allocateInvoiceNumber(db, "ABC");
        const items = db.invoiceItems.filter((item) => item.invoice_id === estimate.id);
        const newInvoiceId = id("invoice");
        const copy: SalesInvoice = {
          ...clone(estimate),
          id: newInvoiceId,
          series_id: allocated.series.id,
          series_code: "ABC",
          series_name: allocated.series.series_name,
          is_estimate: 0,
          inv_no: allocated.invNo,
          inv_no_display: allocated.display,
          converted_to_tax_inv_id: null,
          updated_at: now(),
        };
        db.invoices.push(copy);
        items.forEach((item) => {
          db.invoiceItems.push({ ...clone(item), id: id("item"), invoice_id: newInvoiceId });
          const batch = db.batches.find((row) => row.id === item.batch_id);
          if (batch) {
            const qty = item.billed_qty + item.free_deal_qty;
            if (batch.tax_stock_qty < qty) {
              error("TAX_STOCK_NEGATIVE", `Batch ${batch.batch_no} has insufficient GST stock for conversion.`, "billed_qty");
            }
            batch.tax_stock_qty -= qty;
            batch.updated_at = now();
          }
        });
        estimate.converted_to_tax_inv_id = newInvoiceId;
        db.outbox += 1;
        return {
          from_id: estimate.id,
          to_id: newInvoiceId,
          from_display: estimate.inv_no_display,
          to_display: allocated.display,
        };
      });
      save();
      return { converted } as T;
    }
    case "delete_invoice": {
      const invoice = db.invoices.find((row) => row.id === req.invoice_id && !row.is_deleted);
      if (!invoice) error("NOT_FOUND", "Invoice not found.");
      const items = db.invoiceItems.filter((item) => item.invoice_id === invoice.id);
      items.forEach((item) => {
        const batch = db.batches.find((row) => row.id === item.batch_id);
        if (batch) applyStock(batch, item.billed_qty + item.free_deal_qty, invoice.series_code === "E", 1);
      });
      const party = invoice.party_id ? db.parties.find((row) => row.id === invoice.party_id) : null;
      if (party && invoice.payment_mode === "CREDIT") party.cur_bal_scaled -= invoice.due_amt_scaled;
      invoice.is_deleted = 1;
      db.ledger = db.ledger.filter((entry) => entry.ref_id !== invoice.id);
      db.outbox += 1;
      save();
      return { ok: true } as T;
    }
    case "invoice_print_payload": {
      const detail = invoiceDetail(db, String(req.invoice_id));
      const lines = [
        String(db.settings.company_name ?? "SALTBOOK"),
        String(db.settings.company_address ?? ""),
        `GSTIN: ${db.settings.company_gst_no ?? ""}`,
        `${detail.invoice.series_code === "E" ? "ESTIMATE" : "TAX INVOICE"} ${detail.invoice.inv_no_display}`,
        `DATE: ${detail.invoice.inv_date_display}`,
        `PARTY: ${detail.invoice.party_name_snapshot}`,
        ...detail.items.map((item) => `${item.product_name}  ${item.billed_qty} x ${(item.rate_scaled / 10000).toFixed(2)}`),
      ];
      const totals = [
        `GROSS ${(detail.invoice.gross_total_scaled / 10000).toFixed(2)}`,
        `GST ${(detail.invoice.tax_amt_scaled / 10000).toFixed(2)}`,
        `GRAND ${(detail.invoice.grand_total_scaled / 10000).toFixed(2)}`,
      ];
      return {
        text: [...lines, ...totals].join("\r\n"),
        upi_uri: `upi://pay?pa=${db.settings.merchant_vpa}&am=${(detail.invoice.grand_total_scaled / 10000).toFixed(2)}&cu=INR`,
        qr_svg: "",
        title: detail.invoice.series_code === "E" ? "ESTIMATE" : "TAX INVOICE",
        lines,
        totals,
      } as T;
    }
    case "print_invoice": {
      error("UNSUPPORTED", "Printing is available in the desktop app.");
      break;
    }
    case "export_invoice_pdf": {
      return { path: "browser-preview/no-file.pdf" } as T;
    }
    case "save_purchase": {
      const request = req as unknown as Record<string, any>;
      const supplier = db.parties.find((row) => row.id === request.supplier_id && row.account_type === "SUPPLIER");
      if (!supplier) error("VALIDATION", "Select a valid supplier.", "supplier_id");
      const items = (request.items ?? []) as Array<Record<string, any>>;
      if (!items.length) error("EMPTY_PURCHASE", "Please add at least one line item.");
      let gross = 0;
      let dis = 0;
      let tax = 0;
      const purchaseId = id("purchase");
      const resolved = items.map((item, index) => {
        const product = activeProduct(db, String(item.product_id));
        const batchNo = String(item.batch_no ?? "").toUpperCase();
        const [mm, yy] = String(item.expiry_mm_yy ?? "12/28").split("/");
        const expiryKey = Number(`20${yy}${mm}`);
        const received = Number(item.billed_qty ?? 0) + Number(item.free_deal_qty ?? 0);
        let batch = db.batches.find((row) => row.product_id === product.id && row.batch_no === batchNo);
        if (!batch) {
          batch = {
            id: id("batch"),
            product_id: product.id,
            batch_no: batchNo,
            expiry_mm_yy: `${mm}/${yy}`,
            expiry_sort_key: expiryKey,
            op_qty: 0,
            deal_billed: 0,
            deal_free: 0,
            cur_qty: 0,
            tax_stock_qty: 0,
            mrp_scaled: 0,
            s_rate_scaled: 0,
            t_rate_scaled: 0,
            p_rate_scaled: 0,
            dis_bps: 0,
            net_rate_scaled: 0,
            godown_id: "godown-main",
            godown_code: "MAIN",
            is_provisional: 0,
            updated_at: now(),
            is_deleted: 0,
          };
          db.batches.push(batch);
        }
        const pRate = Number(item.p_rate_scaled ?? 0);
        const lineGross = Number(item.billed_qty ?? 0) * pRate;
        const lineDis = Math.round((lineGross * Number(item.dis_bps ?? 0)) / 10000);
        const taxable = lineGross - lineDis;
        const taxBps = Number(item.tax_bps ?? product.pur_tax_bps ?? 0);
        const lineTax = Math.round((taxable * taxBps) / 10000);
        gross += lineGross;
        dis += lineDis;
        tax += lineTax;
        batch.cur_qty += received;
        batch.tax_stock_qty += received;
        batch.op_qty += received;
        batch.p_rate_scaled = pRate;
        batch.net_rate_scaled = calcNetRate(pRate, Number(item.deal_billed ?? 0), Number(item.deal_free ?? 0), Number(item.dis_bps ?? 0), taxBps);
        batch.deal_billed = Number(item.deal_billed ?? 0);
        batch.deal_free = Number(item.deal_free ?? 0);
        batch.mrp_scaled = Number(item.mrp_scaled ?? 0) || batch.mrp_scaled;
        batch.is_provisional = 0;
        batch.expiry_mm_yy = `${mm}/${yy}`;
        batch.expiry_sort_key = expiryKey;
        batch.updated_at = now();
        return { item, product, batch, index, lineGross, lineDis, taxable, lineTax, taxBps };
      });
      const grand = Math.round((gross - dis + tax) / 10000) * 10000;
      const purchase: PurchaseInvoice = {
        id: purchaseId,
        sup_inv_no: String(request.sup_inv_no ?? `P-${db.purchases.length + 1}`),
        inv_date_iso: todayIso(),
        inv_date_display: request.inv_date_display ?? todayDisplay(),
        supplier_id: supplier.id,
        supplier_name_snapshot: supplier.name,
        godown_id: "godown-main",
        godown_code: "MAIN",
        payment_mode: request.payment_mode ?? "CREDIT",
        gross_total_scaled: gross,
        dis_amt_scaled: dis,
        tax_amt_scaled: tax,
        freight_scaled: Number(request.freight_scaled ?? 0),
        oth_adj_scaled: Number(request.oth_adj_scaled ?? 0),
        roundoff_scaled: grand - (gross - dis + tax),
        grand_total_scaled: grand,
        paid_amt_scaled: request.payment_mode === "CASH" ? grand : Number(request.paid_amt_scaled ?? 0),
        due_amt_scaled: request.payment_mode === "CASH" ? 0 : grand - Number(request.paid_amt_scaled ?? 0),
        remarks: request.remarks ?? null,
        updated_at: now(),
        is_deleted: 0,
      };
      db.purchases.push(purchase);
      resolved.forEach((row) => {
        db.purchaseItems.push({
          id: id("pitem"),
          purchase_id: purchaseId,
          row_order: row.index,
          product_id: row.product.id,
          batch_id: row.batch.id,
          batch_no: row.batch.batch_no,
          expiry_mm_yy: row.batch.expiry_mm_yy,
          expiry_sort_key: row.batch.expiry_sort_key,
          billed_qty: Number(row.item.billed_qty ?? 0),
          free_deal_qty: Number(row.item.free_deal_qty ?? 0),
          deal_billed: Number(row.item.deal_billed ?? 0),
          deal_free: Number(row.item.deal_free ?? 0),
          mrp_scaled: Number(row.item.mrp_scaled ?? 0),
          p_rate_scaled: Number(row.item.p_rate_scaled ?? 0),
          dis_bps: Number(row.item.dis_bps ?? 0),
          tax_bps: row.taxBps,
          net_rate_scaled: row.batch.net_rate_scaled,
          taxable_amt_scaled: row.taxable,
          tax_amt_scaled: row.lineTax,
          line_amount_scaled: row.taxable + row.lineTax,
          updated_at: now(),
        });
      });
      supplier.cur_bal_scaled -= purchase.due_amt_scaled;
      db.outbox += 1;
      save();
      return { purchase, items: db.purchaseItems.filter((item) => item.purchase_id === purchaseId) } as T;
    }
    case "get_purchase": {
      const purchase = db.purchases.find((row) => row.id === req.purchase_id);
      if (!purchase) error("NOT_FOUND", "Purchase not found.");
      return { purchase, items: db.purchaseItems.filter((item) => item.purchase_id === purchase.id) } as T;
    }
    case "list_purchases": {
      const query = String(req.query ?? "").toLowerCase();
      const rows = db.purchases
        .filter((row) => !row.is_deleted)
        .filter((row) => !query || row.supplier_name_snapshot.toLowerCase().includes(query) || String(row.sup_inv_no ?? "").toLowerCase().includes(query))
        .sort((a, b) => b.inv_date_iso.localeCompare(a.inv_date_iso));
      return {
        items: rows.slice(0, Number(req.limit ?? 50)).map((row) => ({
          ...row,
          item_count: db.purchaseItems.filter((item) => item.purchase_id === row.id).length,
        })),
        total_count: rows.length,
        total_amount_scaled: rows.reduce((sum, row) => sum + row.grand_total_scaled, 0),
      } as T;
    }
    case "import_purchase_rows": {
      const request = req as unknown as Record<string, any>;
      const rows = (request.rows ?? []) as Array<Record<string, any>>;
      const supplierId = String(request.supplier_id ?? "");
      const supplier = db.parties.find((row) => row.id === supplierId && row.account_type === "SUPPLIER");
      if (!supplier) error("VALIDATION", "Select a valid supplier.", "supplier_id");
      const unresolved: string[] = [];
      const items: Array<Record<string, unknown>> = [];
      rows.forEach((row) => {
        const alias = db.aliases.find(
          (entry) => entry.supplier_id === supplierId && entry.alias_name.toLowerCase() === String(row.supplier_sku ?? "").toLowerCase(),
        );
        let product = alias ? db.products.find((p) => p.id === alias.product_id) : undefined;
        if (!product) {
          product = db.products.find((p) => p.name.toLowerCase() === String(row.supplier_sku ?? row.product_name ?? "").toLowerCase());
        }
        if (!product) {
          unresolved.push(String(row.supplier_sku ?? row.product_name ?? "unknown"));
          return;
        }
        if (row.supplier_sku) {
          db.aliases.push({ id: id("alias"), supplier_id: supplierId, alias_name: String(row.supplier_sku), product_id: product.id });
        }
        items.push({
          product_id: product.id,
          batch_no: row.batch_no,
          expiry_mm_yy: row.expiry_mm_yy,
          billed_qty: Number(row.qty ?? 0),
          free_deal_qty: Number(row.free_qty ?? 0),
          mrp_scaled: Number(row.mrp_scaled ?? 0),
          p_rate_scaled: Number(row.p_rate_scaled ?? 0),
          dis_bps: Number(row.dis_bps ?? 0),
          tax_bps: row.tax_bps ?? product.pur_tax_bps,
        });
      });
      if (!items.length) error("VALIDATION", "No importable rows found.");
      const purchase = (await mockInvoke("save_purchase", {
        req: {
          supplier_id: supplierId,
          payment_mode: request.payment_mode ?? "CREDIT",
          items,
        },
      })) as { purchase: PurchaseInvoice };
      return {
        purchase_id: purchase.purchase.id,
        imported_lines: items.length,
        aliases_saved: rows.length,
        created_products: 0,
        unresolved,
        total_scaled: purchase.purchase.grand_total_scaled,
      } as T;
    }
    case "save_sku_alias": {
      db.aliases.push({
        id: id("alias"),
        supplier_id: String(req.supplier_id),
        alias_name: String(req.alias_name),
        product_id: String(req.product_id),
      });
      save();
      return { ok: true } as T;
    }
    case "list_sku_aliases": {
      return {
        items: db.aliases
          .filter((alias) => alias.supplier_id === req.supplier_id)
          .map((alias) => ({
            ...alias,
            product_name: db.products.find((product) => product.id === alias.product_id)?.name ?? "",
          })),
      } as T;
    }
    case "list_adjustment_types": {
      return {
        items: [
          ["TRANSFER_IN", "Transfer In", "IN"],
          ["TRANSFER_OUT", "Transfer Out", "OUT"],
          ["REPLACEMENT_IN", "Replacement In", "IN"],
          ["REPLACEMENT_OUT", "Replacement Out", "OUT"],
          ["SAMPLE_ISSUE", "Sample Issue", "OUT"],
          ["CREDIT_NOTE", "Credit Note", "IN"],
          ["DEBIT_NOTE", "Debit Note", "OUT"],
          ["STOCK_SHORTAGE", "Stock Shortage", "OUT"],
          ["STOCK_SURPLUS", "Stock SurPlus", "IN"],
          ["BREAKAGE_EXPIRY", "Godown -> Breakage / Expiry", "OUT"],
          ["GODOWN_TRANSFER", "Godown Transfer", "MOVE"],
        ].map(([code, label, direction]) => ({ code, label, direction })),
      } as T;
    }
    case "list_voucher_types": {
      return {
        items: [
          ["RECEIPT", "Receipts", "RCP"],
          ["PAYMENT", "Payments", "PAY"],
          ["CONTRA", "Contra", "CON"],
          ["JOURNAL", "Journal", "JRN"],
          ["PAYSLIP", "PaySlip", "PSL"],
        ].map(([code, label, prefix]) => ({ code, label, prefix })),
      } as T;
    }
    case "save_adjustment": {
      const request = req as unknown as Record<string, any>;
      const items = (request.items ?? []) as Array<Record<string, any>>;
      if (!items.length) error("EMPTY_ADJUSTMENT", "Add at least one batch line.");
      const kind = String(request.adj_type ?? "STOCK_SURPLUS");
      const direction = kind === "GODOWN_TRANSFER" ? "MOVE" : ["TRANSFER_IN", "REPLACEMENT_IN", "CREDIT_NOTE", "STOCK_SURPLUS"].includes(kind) ? "IN" : "OUT";
      let total = 0;
      items.forEach((item) => {
        const batch = activeBatch(db, String(item.batch_id));
        const qty = Number(item.qty ?? 0);
        if (qty <= 0) error("VALIDATION", "Quantity must be greater than zero.", "qty");
        if ((direction === "OUT" || direction === "MOVE") && qty > batch.cur_qty) {
          error("VALIDATION", `Batch ${batch.batch_no} has only ${batch.cur_qty} unit(s).`, "qty");
        }
        const rate = Number(item.rate_scaled ?? 0) || batch.p_rate_scaled;
        total += qty * rate;
        if (direction === "MOVE") {
          batch.cur_qty -= qty;
          batch.tax_stock_qty -= qty;
        } else {
          const delta = direction === "IN" ? qty : -qty;
          batch.cur_qty += delta;
          batch.tax_stock_qty += delta;
        }
        batch.updated_at = now();
      });
      const sequence = db.adjustments.length + 1;
      const adjustment: StockAdjustment = {
        id: id("adj"),
        adj_type: kind,
        adj_date_iso: todayIso(),
        adj_date_display: request.adj_date_display ?? todayDisplay(),
        godown_id: "godown-main",
        godown_code: "MAIN",
        to_godown_id: request.to_godown_id ?? null,
        party_id: request.party_id ?? null,
        party_name: null,
        reason: request.reason ?? null,
        total_value_scaled: total,
        line_count: items.length,
        updated_at: now(),
        is_deleted: 0,
      };
      db.adjustments.push(adjustment);
      db.outbox += 1;
      save();
      return {
        id: adjustment.id,
        display: `ADJ-${sequence}`,
        adj_type: kind,
        total_value_scaled: total,
        lines: items.length,
      } as T;
    }
    case "list_adjustments": {
      return {
        items: db.adjustments
          .filter((row) => !row.is_deleted)
          .sort((a, b) => b.adj_date_iso.localeCompare(a.adj_date_iso))
          .slice(0, Number(req.limit ?? 40)),
      } as T;
    }
    case "save_voucher": {
      const request = req as unknown as Record<string, any>;
      const kind = String(request.voucher_type ?? "RECEIPT");
      const amount = Number(request.amount_scaled ?? 0);
      if (kind !== "JOURNAL" && amount <= 0) error("VALIDATION", "Amount must be greater than zero.", "amount_scaled");
      if (kind === "JOURNAL") {
        const lines = (request.lines ?? []) as Array<Record<string, any>>;
        const dr = lines.reduce((sum, line) => sum + Number(line.dr_scaled ?? 0), 0);
        const cr = lines.reduce((sum, line) => sum + Number(line.cr_scaled ?? 0), 0);
        if (!lines.length || dr !== cr || dr === 0) error("VALIDATION", "Journal is not balanced.", "lines");
      }
      const account = request.account_id ? db.parties.find((row) => row.id === request.account_id) : null;
      if (account) {
        if (kind === "RECEIPT") account.cur_bal_scaled -= amount;
        if (kind === "PAYMENT") account.cur_bal_scaled += amount;
      }
      const prefixes: Record<string, string> = { RECEIPT: "RCP", PAYMENT: "PAY", CONTRA: "CON", JOURNAL: "JRN", PAYSLIP: "PSL" };
      const sequence = db.vouchers.filter((row) => row.voucher_type === kind).length + 1;
      const display = `${prefixes[kind] ?? "VCH"}-${sequence}`;
      const voucher: Voucher = {
        id: id("voucher"),
        voucher_type: kind,
        voucher_no: sequence,
        voucher_no_display: display,
        voucher_date_iso: todayIso(),
        voucher_date_display: request.voucher_date_display ?? todayDisplay(),
        account_id: request.account_id ?? null,
        contra_account_id: request.contra_account_id ?? null,
        amount_scaled: amount,
        payment_mode: request.payment_mode ?? null,
        instrument_no: request.instrument_no ?? null,
        narration: request.narration ?? null,
        updated_at: now(),
        is_deleted: 0,
      };
      db.vouchers.push(voucher);
      db.outbox += 1;
      save();
      return { id: voucher.id, voucher_no_display: display, voucher_type: kind, amount_scaled: amount } as T;
    }
    case "list_vouchers": {
      return {
        items: db.vouchers
          .filter((row) => !row.is_deleted)
          .sort((a, b) => b.voucher_date_iso.localeCompare(a.voucher_date_iso) || b.voucher_no - a.voucher_no)
          .slice(0, Number(req.limit ?? 40)),
      } as T;
    }
    case "get_ticker_alerts": {
      const threshold = expiredWithin(Number(req.months_ahead ?? 3));
      const items = db.batches
        .filter((batch) => !batch.is_deleted)
        .filter((batch) => (batch.expiry_sort_key <= threshold && batch.cur_qty > 0) || batch.cur_qty < 0)
        .sort((a, b) => Number(a.cur_qty < 0) * -1 - Number(b.cur_qty < 0) * -1 || a.expiry_sort_key - b.expiry_sort_key)
        .slice(0, Number(req.limit ?? 50))
        .map((batch) => {
          const product = db.products.find((row) => row.id === batch.product_id);
          const days = daysToExpiry(batch.expiry_sort_key);
          const severity =
            batch.cur_qty < 0 ? "NEGATIVE" : days < 0 ? "EXPIRED" : days <= 30 ? "CRITICAL" : days <= 90 ? "WARNING" : "INFO";
          return {
            batch_id: batch.id,
            product_id: batch.product_id,
            batch_no: batch.batch_no,
            expiry_mm_yy: batch.expiry_mm_yy,
            expiry_sort_key: batch.expiry_sort_key,
            cur_qty: batch.cur_qty,
            godown_code: "MAIN",
            product_name: product?.name ?? "",
            pro_code: product?.pro_code ?? 0,
            pack_form: product?.pack_form ?? "TAB",
            days_to_expiry: days,
            severity,
            label:
              batch.cur_qty < 0
                ? `NEGATIVE STOCK ${batch.cur_qty} @ ${product?.name ?? ""}`
                : days < 0
                  ? `EXPIRED ${batch.expiry_mm_yy} ${product?.name ?? ""}`
                  : `${product?.name ?? ""} ${batch.expiry_mm_yy} (${days}d)`,
          };
        });
      return { items, threshold_expiry_key: threshold } as T;
    }
    case "stock_query": {
      const query = String(req.query ?? "").toLowerCase();
      let rows = db.batches
        .filter((batch) => !batch.is_deleted)
        .filter((batch) => !query || (db.products.find((p) => p.id === batch.product_id)?.name ?? "").toLowerCase().includes(query) || batch.batch_no.toLowerCase().includes(query))
        .filter((batch) => req.only_in_stock === false || batch.cur_qty > 0)
        .filter((batch) => !req.expiry_within_months || batch.expiry_sort_key <= expiredWithin(Number(req.expiry_within_months)))
        .sort((a, b) => a.expiry_sort_key - b.expiry_sort_key)
        .slice(0, Number(req.limit ?? 200));
      const items = rows.map((batch) => {
        const product = db.products.find((p) => p.id === batch.product_id);
        return {
          batch_id: batch.id,
          product_id: batch.product_id,
          batch_no: batch.batch_no,
          expiry_mm_yy: batch.expiry_mm_yy,
          expiry_sort_key: batch.expiry_sort_key,
          cur_qty: batch.cur_qty,
          tax_stock_qty: batch.tax_stock_qty,
          op_qty: batch.op_qty,
          mrp_scaled: batch.mrp_scaled,
          s_rate_scaled: batch.s_rate_scaled,
          t_rate_scaled: batch.t_rate_scaled,
          p_rate_scaled: batch.p_rate_scaled,
          dis_bps: batch.dis_bps,
          net_rate_scaled: batch.net_rate_scaled,
          is_provisional: batch.is_provisional,
          stock_value_scaled: batch.cur_qty * batch.p_rate_scaled,
          godown_code: "MAIN",
          product_name: product?.name ?? "",
          pro_code: product?.pro_code ?? 0,
          pack_form: product?.pack_form ?? "TAB",
          company_name: product?.company_name ?? "",
        };
      });
      return {
        items,
        totals: {
          batch_count: items.length,
          total_units: items.reduce((sum, row) => sum + row.cur_qty, 0),
          total_tax_units: items.reduce((sum, row) => sum + row.tax_stock_qty, 0),
          total_value_scaled: items.reduce((sum, row) => sum + row.stock_value_scaled, 0),
          negative_batches: items.filter((row) => row.cur_qty < 0).length,
          expiring_batches: items.filter((row) => row.expiry_sort_key <= expiredWithin(3)).length,
        },
      } as T;
    }
    case "composition_query": {
      const query = String(req.query ?? "").toLowerCase();
      const items = db.products
        .filter((product) => !product.is_deleted)
        .filter((product) => !query || product.name.toLowerCase().includes(query) || (product.composition_desc ?? "").toLowerCase().includes(query))
        .slice(0, Number(req.limit ?? 100))
        .map((product) => {
          const batches = db.batches.filter((batch) => batch.product_id === product.id && !batch.is_deleted);
          const available = batches.filter((batch) => batch.cur_qty > 0);
          return {
            id: product.id,
            pro_code: product.pro_code,
            name: product.name,
            pack_form: product.pack_form,
            pack_unit: product.pack_unit,
            pack_subunit: product.pack_subunit,
            composition_desc: product.composition_desc ?? "(No composition)",
            company_name: product.company_name ?? "",
            cur_qty: batches.reduce((sum, batch) => sum + batch.cur_qty, 0),
            s_rate_scaled: Math.max(0, ...batches.map((batch) => batch.s_rate_scaled)),
            mrp_scaled: Math.max(0, ...batches.map((batch) => batch.mrp_scaled)),
            nearest_expiry: available.length ? Math.min(...available.map((batch) => batch.expiry_sort_key)) : null,
          };
        });
      return { items } as T;
    }
    case "sales_report": {
      const from = req.from_iso ? String(req.from_iso) : null;
      const to = req.to_iso ? String(req.to_iso) : null;
      const rows = db.invoices.filter(
        (invoice) =>
          !invoice.is_deleted &&
          !(invoice.series_code === "E" && invoice.converted_to_tax_inv_id) &&
          (!from || invoice.inv_date_iso >= from) &&
          (!to || invoice.inv_date_iso <= to),
      );
      const dailyMap = new Map<string, Record<string, number | string>>();
      rows.forEach((invoice) => {
        const key = `${invoice.inv_date_iso}|${invoice.series_code}`;
        const entry = dailyMap.get(key) ?? {
          inv_date_iso: invoice.inv_date_iso,
          inv_date_display: invoice.inv_date_display,
          series_code: invoice.series_code,
          bill_count: 0,
          gross_scaled: 0,
          discount_scaled: 0,
          tax_scaled: 0,
          total_scaled: 0,
        };
        entry.bill_count = Number(entry.bill_count) + 1;
        entry.gross_scaled = Number(entry.gross_scaled) + invoice.gross_total_scaled;
        entry.discount_scaled = Number(entry.discount_scaled) + invoice.dis_amt_scaled;
        entry.tax_scaled = Number(entry.tax_scaled) + invoice.tax_amt_scaled;
        entry.total_scaled = Number(entry.total_scaled) + invoice.grand_total_scaled;
        dailyMap.set(key, entry);
      });
      const bySeries = new Map<string, { series_code: string; bill_count: number; total_scaled: number }>();
      rows.forEach((invoice) => {
        const entry = bySeries.get(invoice.series_code) ?? { series_code: invoice.series_code, bill_count: 0, total_scaled: 0 };
        entry.bill_count += 1;
        entry.total_scaled += invoice.grand_total_scaled;
        bySeries.set(invoice.series_code, entry);
      });
      return {
        daily: [...dailyMap.values()].sort((a, b) => String(b.inv_date_iso).localeCompare(String(a.inv_date_iso))),
        by_series: [...bySeries.values()],
        top_products: [],
        totals: {
          bill_count: rows.length,
          total_scaled: rows.reduce((sum, invoice) => sum + invoice.grand_total_scaled, 0),
          tax_scaled: rows.reduce((sum, invoice) => sum + invoice.tax_amt_scaled, 0),
          discount_scaled: rows.reduce((sum, invoice) => sum + invoice.dis_amt_scaled, 0),
          due_scaled: rows.reduce((sum, invoice) => sum + invoice.due_amt_scaled, 0),
        },
      } as T;
    }
    case "ledger_report": {
      const account = activeParty(db, String(req.account_id));
      const entries = db.ledger
        .filter((entry) => entry.account_id === account.id)
        .sort((a, b) => a.entry_date_iso.localeCompare(b.entry_date_iso) || a.created_at - b.created_at);
      const opening = account.op_bal_dr_scaled - account.op_bal_cr_scaled;
      const movement = entries.reduce((sum, entry) => sum + entry.dr_scaled - entry.cr_scaled, 0);
      return {
        account,
        opening_scaled: opening,
        closing_scaled: opening + movement,
        entries,
      } as T;
    }
    case "window_summary": {
      const today = todayIso();
      const month = today.slice(0, 7);
      const activeBatches = db.batches.filter((batch) => !batch.is_deleted);
      const summary: WindowSummary = {
        products: db.products.filter((product) => !product.is_deleted).length,
        parties: db.parties.filter((party) => party.account_type === "PARTY" && !party.is_deleted).length,
        suppliers: db.parties.filter((party) => party.account_type === "SUPPLIER" && !party.is_deleted).length,
        today_sales_scaled: db.invoices.filter((invoice) => !invoice.is_deleted && !(invoice.series_code === "E" && invoice.converted_to_tax_inv_id) && invoice.inv_date_iso === today).reduce((sum, invoice) => sum + invoice.grand_total_scaled, 0),
        month_sales_scaled: db.invoices.filter((invoice) => !invoice.is_deleted && !(invoice.series_code === "E" && invoice.converted_to_tax_inv_id) && invoice.inv_date_iso.startsWith(month)).reduce((sum, invoice) => sum + invoice.grand_total_scaled, 0),
        low_stock: db.products.filter((product) => product.min_qty > 0 && (productSummary(db, product).total_cur_qty ?? 0) <= product.min_qty).length,
        expiring: activeBatches.filter((batch) => batch.cur_qty > 0 && batch.expiry_sort_key <= expiredWithin(3)).length,
        negative_stock: activeBatches.filter((batch) => batch.cur_qty < 0).length,
        open_bills: db.invoices.filter((invoice) => !invoice.is_deleted && invoice.due_amt_scaled > 0).length,
        receivables_scaled: db.invoices.filter((invoice) => !invoice.is_deleted).reduce((sum, invoice) => sum + Math.max(0, invoice.due_amt_scaled), 0),
        pending_outbox: db.outbox,
        invoices: db.invoices.filter((invoice) => !invoice.is_deleted && !(invoice.series_code === "E" && invoice.converted_to_tax_inv_id)).length,
      };
      return summary as T;
    }
    case "batch_movement_history": {
      const rows = db.invoiceItems
        .filter((item) => item.batch_id === req.batch_id)
        .map((item) => {
          const invoice = db.invoices.find((row) => row.id === item.invoice_id);
          return {
            movement_type: "SALE",
            reference: invoice?.inv_no_display ?? "",
            date_display: invoice?.inv_date_display ?? "",
            qty: -(item.billed_qty + item.free_deal_qty),
            party: invoice?.party_name_snapshot ?? "",
          };
        });
      return { items: rows } as T;
    }
    case "get_sync_status": {
      return {
        connected: db.settings.gdrive_connected === "1",
        device_id: db.settings.device_id,
        device_name: db.settings.device_name,
        client_id_configured: Boolean(db.settings.gdrive_client_id),
        redirect_uri: "http://127.0.0.1:1421/oauth2callback",
        backup_folder: "Saltbook_Backups",
        sync_folder: "Saltbook_Sync",
        auto_backup: db.settings.auto_backup === "1",
        auto_sync: db.settings.auto_sync === "1",
        backup_interval_hours: Number(db.settings.backup_interval_hours),
        sync_interval_secs: Number(db.settings.sync_interval_secs),
        last_backup_at: Number(db.settings.last_backup_at),
        last_sync_at: Number(db.settings.last_sync_at),
        pending_outbox: db.outbox,
        applied_files: db.appliedFiles,
        local_backups: [],
        backups_dir: "browser-preview/backups",
        merchant_vpa: db.settings.merchant_vpa,
        printer_name: "",
        company_name: db.settings.company_name ?? "",
        company_address: db.settings.company_address ?? "",
        company_gst_no: db.settings.company_gst_no ?? "",
        company_dl_no: db.settings.company_dl_no ?? "",
        company_phone: db.settings.company_phone ?? "",
        company_state_code: db.settings.company_state_code ?? "10",
        estimate_next_inv_no: db.series.find((row) => row.series_code === "E")?.next_inv_no ?? 1,
        tax_next_inv_no: db.series.find((row) => row.series_code === "ABC")?.next_inv_no ?? 1,
      } as T;
    }
    case "set_sync_settings": {
      Object.entries(req).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        db.settings[key] = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
      });
      if (req.estimate_next_inv_no) {
        const series = db.series.find((row) => row.series_code === "E");
        if (series) series.next_inv_no = Number(req.estimate_next_inv_no);
      }
      if (req.tax_next_inv_no) {
        const series = db.series.find((row) => row.series_code === "ABC");
        if (series) series.next_inv_no = Number(req.tax_next_inv_no);
      }
      save();
      return { ok: true } as T;
    }
    case "start_gdrive_login":
      error("AUTH", "Google Drive login runs in the desktop app. The browser preview is offline.");
      break;
    case "complete_gdrive_login":
      error("AUTH", "Google Drive login runs in the desktop app.");
      break;
    case "gdrive_disconnect": {
      db.settings.gdrive_connected = "0";
      save();
      return { ok: true } as T;
    }
    case "run_backup_now": {
      db.settings.last_backup_at = String(now());
      save();
      return {
        filename: `saltbook_${todayIso()}.db.zst`,
        local_path: "browser-preview/backups/saltbook.db.zst",
        bytes: 1_248_000,
        uploaded: false,
        pruned: 0,
        message: "Snapshot created locally (browser preview).",
      } as T;
    }
    case "run_delta_sync_now":
      error("AUTH", "Connect Google Drive in the desktop app to sync.");
      break;
    case "list_backups": {
      return { local: [], remote: [], dir: "browser-preview/backups" } as T;
    }
    case "start_lan_sync_server": {
      return { port: Number(req.port ?? 8787), url: `http://192.168.1.20:${Number(req.port ?? 8787)}`, local_url: `http://127.0.0.1:${Number(req.port ?? 8787)}` } as T;
    }
    case "migration_preview":
    case "migration_import": {
      error("UNSUPPORTED", "Legacy file import runs in the desktop app (choose a file from disk).");
      break;
    }
    case "seed_demo_catalog": {
      cache = seedState();
      save();
      return { products: cache.products.length, new_batches: cache.batches.length, parties: 6, suppliers: 4, invoices: 0 } as T;
    }
    default:
      error("UNKNOWN_COMMAND", `The browser preview does not implement '${command}'.`);
  }
}

// Seed a handful of estimates so Bill Modify and the dashboard have content.
function seedInvoices() {
  const db = load();
  if (db.invoices.length > 0) return;
  const parties = db.parties.filter((party) => party.account_type === "PARTY").slice(0, 4);
  const productBatches = db.batches.filter((batch) => batch.cur_qty > 5).slice(0, 12);
  parties.forEach((party, partyIndex) => {
    const items = [0, 1, 2].map((offset) => {
      const batch = productBatches[(partyIndex * 3 + offset) % productBatches.length];
      const product = db.products.find((row) => row.id === batch.product_id);
      return {
        product_id: batch.product_id,
        batch_id: batch.id,
        billed_qty: 2 + offset,
        free_deal_qty: 0,
        tax_inclusive: false,
        mrp_scaled: batch.mrp_scaled,
        rate_scaled: product?.s_rate_scaled ?? batch.s_rate_scaled,
        dis_bps: 1000,
        tax_bps: product?.sale_tax_bps ?? 1200,
      };
    });
    const date = new Date();
    date.setDate(date.getDate() - partyIndex * 2);
    const display = `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
    saveInvoice(db, {
      series_code: "E",
      inv_date_display: display,
      payment_mode: partyIndex % 2 === 0 ? "CASH" : "CREDIT",
      party_id: party.id,
      salesman_name: "R. K. SINGH",
      override_credit_lock: true,
      items,
    });
  });
}

seedInvoices();
