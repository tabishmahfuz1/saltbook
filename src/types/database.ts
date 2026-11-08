/** TypeScript mirrors of the SQLite tables (all money in micro-rupees). */

export type Id = string;

export interface Product {
  id: Id;
  pro_code: number;
  name: string;
  group_id: string | null;
  group_name?: string | null;
  company_id: string | null;
  company_name?: string | null;
  composition_id: string | null;
  composition_desc?: string | null;
  pack_unit: number;
  pack_subunit: number;
  pack_form: string;
  case_box_qty: number;
  hsn_code: string | null;
  drug_schedule: string;
  pur_tax_id: string | null;
  pur_tax_name?: string | null;
  pur_tax_bps?: number;
  sale_tax_id: string | null;
  sale_tax_name?: string | null;
  sale_tax_bps?: number;
  tin_tax_id: string | null;
  tin_tax_name?: string | null;
  tin_tax_bps?: number;
  tout_tax_id: string | null;
  tout_tax_name?: string | null;
  tout_tax_bps?: number;
  min_qty: number;
  max_qty: number;
  weight_grams: number;
  total_cur_qty?: number;
  total_tax_qty?: number;
  mrp_scaled?: number;
  s_rate_scaled?: number;
  t_rate_scaled?: number;
  p_rate_scaled?: number;
  batch_count?: number;
  updated_at: number;
  is_deleted: number;
}

export interface Batch {
  id: Id;
  product_id: Id;
  batch_no: string;
  expiry_mm_yy: string;
  expiry_sort_key: number;
  op_qty: number;
  deal_billed: number;
  deal_free: number;
  cur_qty: number;
  tax_stock_qty: number;
  mrp_scaled: number;
  s_rate_scaled: number;
  t_rate_scaled: number;
  p_rate_scaled: number;
  dis_bps: number;
  net_rate_scaled: number;
  godown_id: Id;
  godown_code?: string;
  godown_name?: string;
  is_provisional: number;
  last_supplier_id?: string | null;
  updated_at: number;
  is_deleted: number;
  /** server-computed display helpers */
  expiry_display?: string;
  deal_str?: string;
  is_near_expiry?: boolean;
  is_expired?: boolean;
  is_negative?: boolean;
  product_name?: string;
  pack_form?: string;
  tax_bps?: number;
  available_qty?: number;
}

export interface AccountParty {
  id: Id;
  account_type: "PARTY" | "SUPPLIER";
  code: string;
  name: string;
  address_line1: string | null;
  address_line2: string | null;
  address_line3: string | null;
  city: string | null;
  state: string | null;
  phone_office: string | null;
  phone_res: string | null;
  contact_person: string | null;
  email: string | null;
  creation_date: string;
  billing_on_rate: string;
  status: string;
  hq: string | null;
  mr_name: string | null;
  linked_company_id: string | null;
  linked_company_name?: string | null;
  is_inter_state: number;
  gst_no: string | null;
  pan_aadhar: string | null;
  dl_no_1: string | null;
  dl_no_2: string | null;
  dl_expiry_date: string | null;
  transport_name: string | null;
  banker_name: string | null;
  interest_rate_bps: number;
  cr_limit_scaled: number;
  cr_days: number;
  locking_days: number;
  bills_for_locking: number;
  op_bal_dr_scaled: number;
  op_bal_cr_scaled: number;
  cur_bal_scaled: number;
  updated_at: number;
  is_deleted: number;
  open_bills?: number;
}

export interface SalesInvoice {
  id: Id;
  series_id: Id;
  series_code: string;
  series_name?: string;
  is_estimate?: number;
  inv_no: number;
  inv_no_display: string;
  inv_date_iso: string;
  inv_date_display: string;
  payment_mode: "CASH" | "CREDIT";
  party_id: Id | null;
  party_name_snapshot: string;
  city_snapshot: string | null;
  salesman_name: string | null;
  remarks: string | null;
  is_sale_return: number;
  reclaimed_scaled: number;
  gross_total_scaled: number;
  tax_amt_scaled: number;
  dis_amt_scaled: number;
  dis_bps: number;
  freight_scaled: number;
  oth_adj_scaled: number;
  roundoff_scaled: number;
  grand_total_scaled: number;
  paid_amt_scaled: number;
  due_amt_scaled: number;
  converted_to_tax_inv_id: string | null;
  updated_at: number;
  is_deleted: number;
  item_count?: number;
}

export interface SalesInvoiceItem {
  id: Id;
  invoice_id: Id;
  row_order: number;
  product_id: Id;
  batch_id: Id;
  loose_or_box: "L" | "B";
  billed_qty: number;
  free_deal_qty: number;
  deal_str: string | null;
  tax_inclusive: number;
  mrp_scaled: number;
  rate_scaled: number;
  dis_bps: number;
  dis_rs_scaled: number;
  taxable_amt_scaled: number;
  tax_bps: number;
  cgst_amt_scaled: number;
  sgst_amt_scaled: number;
  igst_amt_scaled: number;
  net_unit_rate_scaled: number;
  line_amount_scaled: number;
  updated_at: number;
  // joined
  product_name?: string;
  pro_code?: number;
  pack_form?: string;
  batch_no?: string;
  expiry_mm_yy?: string;
  batch_cur_qty?: number;
  batch_tax_qty?: number;
  godown_code?: string;
  company_name?: string;
  composition_desc?: string;
}

export interface PurchaseInvoice {
  id: Id;
  sup_inv_no: string | null;
  inv_date_iso: string;
  inv_date_display: string;
  supplier_id: Id | null;
  supplier_name_snapshot: string;
  godown_id: Id;
  godown_code?: string;
  payment_mode: "CASH" | "CREDIT";
  gross_total_scaled: number;
  dis_amt_scaled: number;
  tax_amt_scaled: number;
  freight_scaled: number;
  oth_adj_scaled: number;
  roundoff_scaled: number;
  grand_total_scaled: number;
  paid_amt_scaled: number;
  due_amt_scaled: number;
  remarks: string | null;
  item_count?: number;
  updated_at: number;
  is_deleted: number;
}

export interface PurchaseInvoiceItem {
  id: Id;
  purchase_id: Id;
  row_order: number;
  product_id: Id;
  batch_id: Id;
  batch_no: string;
  expiry_mm_yy: string;
  expiry_sort_key: number;
  billed_qty: number;
  free_deal_qty: number;
  deal_billed: number;
  deal_free: number;
  mrp_scaled: number;
  p_rate_scaled: number;
  dis_bps: number;
  tax_bps: number;
  net_rate_scaled: number;
  taxable_amt_scaled: number;
  tax_amt_scaled: number;
  line_amount_scaled: number;
  product_name?: string;
  pro_code?: number;
  pack_form?: string;
  company_name?: string;
  updated_at: number;
}

export interface StockAdjustment {
  id: Id;
  adj_type: string;
  adj_date_iso: string;
  adj_date_display: string;
  godown_id: Id;
  godown_code?: string;
  to_godown_id: Id | null;
  to_godown_code?: string;
  party_id: Id | null;
  party_name?: string | null;
  reason: string | null;
  total_value_scaled: number;
  line_count?: number;
  updated_at: number;
  is_deleted: number;
}

export interface Voucher {
  id: Id;
  voucher_type: string;
  voucher_no: number;
  voucher_no_display: string;
  voucher_date_iso: string;
  voucher_date_display: string;
  account_id: Id | null;
  account_name?: string;
  contra_account_id: Id | null;
  contra_account_name?: string | null;
  amount_scaled: number;
  payment_mode: string | null;
  instrument_no: string | null;
  narration: string | null;
  updated_at: number;
  is_deleted: number;
}

export interface LedgerEntry {
  entry_date_iso: string;
  entry_type: string;
  ref_no: string | null;
  dr_scaled: number;
  cr_scaled: number;
  narration: string | null;
  created_at: number;
}

export interface TickerAlert {
  batch_id: Id;
  product_id: Id;
  batch_no: string;
  expiry_mm_yy: string;
  expiry_sort_key: number;
  cur_qty: number;
  godown_code: string;
  product_name: string;
  pro_code: number;
  pack_form: string;
  days_to_expiry: number;
  severity: "EXPIRED" | "CRITICAL" | "WARNING" | "NEGATIVE" | "INFO";
  label: string;
}

export interface LookupItem {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  cgst_bps?: number;
  sgst_bps?: number;
  igst_bps?: number;
  total_bps?: number;
  is_default?: number;
  is_estimate?: number;
  next_inv_no?: number;
}

export interface CreditStatus {
  locked: boolean;
  reasons: string[];
  credit_limit_scaled: number;
  outstanding_scaled: number;
  available_scaled: number;
  overdue_count: number;
  overdue_amount_scaled: number;
  locking_days: number;
  bills_for_locking: number;
}

export interface ProductDetail {
  product: Product;
  batches: Batch[];
  stats: {
    batch_count: number;
    total_cur_qty: number;
    total_tax_qty: number;
    stock_value_scaled: number;
  };
}

export interface InvoiceDetail {
  invoice: SalesInvoice;
  items: SalesInvoiceItem[];
  party: { account: AccountParty; credit: CreditStatus; recent: SalesInvoice[] } | null;
}

export interface AccountDetail {
  account: AccountParty;
  credit: CreditStatus;
  recent: Array<Record<string, unknown>>;
}

export interface WindowSummary {
  products: number;
  parties: number;
  suppliers: number;
  today_sales_scaled: number;
  month_sales_scaled: number;
  low_stock: number;
  expiring: number;
  negative_stock: number;
  open_bills: number;
  receivables_scaled: number;
  pending_outbox: number;
  invoices: number;
}

export interface SyncStatus {
  connected: boolean;
  device_id: string;
  device_name: string;
  client_id_configured: boolean;
  redirect_uri: string;
  backup_folder: string;
  sync_folder: string;
  auto_backup: boolean;
  auto_sync: boolean;
  backup_interval_hours: number;
  sync_interval_secs: number;
  last_backup_at: number;
  last_sync_at: number;
  pending_outbox: number;
  applied_files: number;
  local_backups: Array<{ filename: string; path: string; bytes: number; modified_at: number }>;
  backups_dir: string;
  merchant_vpa: string;
  printer_name: string;
  company_name: string;
  company_address: string;
  company_gst_no: string;
  company_dl_no: string;
  company_phone: string;
  company_state_code: string;
  estimate_next_inv_no: number;
  tax_next_inv_no: number;
}
