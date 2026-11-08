/** Request/response payloads for the Rust command surface (snake_case). */

import type {
  AccountDetail,
  AccountParty,
  Batch,
  CreditStatus,
  InvoiceDetail,
  LedgerEntry,
  LookupItem,
  Product,
  ProductDetail,
  PurchaseInvoice,
  PurchaseInvoiceItem,
  SalesInvoice,
  SalesInvoiceItem,
  StockAdjustment,
  SyncStatus,
  TickerAlert,
  Voucher,
  WindowSummary,
} from "./database";

export interface ApiErrorPayload {
  code: string;
  message: string;
  field?: string;
}

export interface SearchProductsRequest {
  query?: string;
  limit?: number;
}

export interface SearchProductsResponse {
  items: Product[];
  total_found: number;
  total_products: number;
  elapsed_ms: number;
}

export interface BatchInput {
  id?: string | null;
  batch_no: string;
  expiry_mm_yy: string;
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
  godown_id?: string | null;
  is_provisional?: boolean;
  last_supplier_id?: string | null;
}

export interface ProductSaveRequest {
  id?: string | null;
  pro_code?: number | null;
  name: string;
  group_id?: string | null;
  group_name?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  composition_id?: string | null;
  composition_desc?: string | null;
  pack_unit: number;
  pack_subunit: number;
  pack_form: string;
  case_box_qty: number;
  hsn_code?: string | null;
  drug_schedule: string;
  pur_tax_id?: string | null;
  sale_tax_id?: string | null;
  tin_tax_id?: string | null;
  tout_tax_id?: string | null;
  min_qty: number;
  max_qty: number;
  weight_grams: number;
  batches: BatchInput[];
}

export interface LookupListResponse {
  items: LookupItem[];
}

export interface AccountSearchResponse {
  items: AccountParty[];
  total_found: number;
}

export interface AccountSaveRequest {
  id?: string | null;
  account_type: "PARTY" | "SUPPLIER";
  code?: string | null;
  name: string;
  address_line1?: string | null;
  address_line2?: string | null;
  address_line3?: string | null;
  city?: string | null;
  state?: string | null;
  phone_office?: string | null;
  phone_res?: string | null;
  contact_person?: string | null;
  email?: string | null;
  creation_date?: string | null;
  billing_on_rate: string;
  status: string;
  hq?: string | null;
  mr_name?: string | null;
  linked_company_id?: string | null;
  is_inter_state: boolean;
  gst_no?: string | null;
  pan_aadhar?: string | null;
  dl_no_1?: string | null;
  dl_no_2?: string | null;
  dl_expiry_date?: string | null;
  transport_name?: string | null;
  banker_name?: string | null;
  interest_rate_bps: number;
  cr_limit_scaled: number;
  cr_days: number;
  locking_days: number;
  bills_for_locking: number;
  op_bal_dr_scaled: number;
  op_bal_cr_scaled: number;
}

export interface InvoiceNumberInfo {
  series_code: string;
  is_estimate: boolean;
  inv_no: number;
  inv_no_display: string;
  inv_date_display: string;
  inv_date_iso: string;
}

export interface InvoiceItemRequest {
  product_id: string;
  batch_id: string;
  loose_or_box?: "L" | "B";
  billed_qty: number;
  free_deal_qty?: number;
  deal_str?: string | null;
  tax_inclusive?: boolean;
  mrp_scaled: number;
  rate_scaled: number;
  dis_bps?: number;
  tax_bps?: number | null;
}

export interface InvoiceSaveRequest {
  invoice_id?: string | null;
  series_code: string;
  inv_date_display?: string | null;
  payment_mode: "CASH" | "CREDIT";
  party_id: string;
  salesman_name?: string | null;
  remarks?: string | null;
  is_sale_return?: boolean;
  freight_scaled?: number;
  oth_adj_scaled?: number;
  reclaimed_scaled?: number;
  paid_amt_scaled?: number;
  override_credit_lock?: boolean;
  items: InvoiceItemRequest[];
}

export interface InvoiceListRequest {
  from_iso?: string | null;
  to_iso?: string | null;
  series_code?: string | null;
  payment_mode?: string | null;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface InvoiceListResponse {
  items: SalesInvoice[];
  total_count: number;
  total_amount_scaled: number;
  total_due_scaled: number;
}

export interface FefoResponse {
  items: Batch[];
}

export interface SubstituteProduct {
  id: string;
  pro_code: number;
  name: string;
  pack_form: string;
  pack_unit: number;
  pack_subunit: number;
  company_name: string;
  composition_desc: string;
  cur_qty: number;
  s_rate_scaled: number;
  net_rate_scaled: number;
  mrp_scaled: number;
  margin_scaled: number;
  nearest_expiry: number | null;
}

export interface ProvisionalBatchRequest {
  product_id: string;
  batch_no: string;
  expiry_mm_yy: string;
  mrp_scaled?: number;
  rate_scaled: number;
  qty?: number;
  godown_id?: string | null;
}

export interface ConvertResponse {
  converted: Array<{ from_id: string; to_id: string; from_display: string; to_display: string }>;
}

export interface PrintPayload {
  text: string;
  upi_uri: string;
  qr_svg: string;
  title: string;
  lines: string[];
  totals: string[];
}

export interface PurchaseItemRequest {
  product_id: string;
  batch_id?: string | null;
  batch_no: string;
  expiry_mm_yy: string;
  billed_qty: number;
  free_deal_qty?: number;
  deal_billed?: number;
  deal_free?: number;
  mrp_scaled?: number;
  p_rate_scaled: number;
  dis_bps?: number;
  tax_bps?: number | null;
  s_rate_scaled?: number;
  t_rate_scaled?: number;
}

export interface PurchaseSaveRequest {
  id?: string | null;
  supplier_id: string;
  sup_inv_no?: string | null;
  inv_date_display?: string | null;
  godown_id?: string | null;
  payment_mode: "CASH" | "CREDIT";
  freight_scaled?: number;
  oth_adj_scaled?: number;
  paid_amt_scaled?: number;
  remarks?: string | null;
  override_credit_lock?: boolean;
  items: PurchaseItemRequest[];
}

export interface PurchaseDetail {
  purchase: PurchaseInvoice;
  items: PurchaseInvoiceItem[];
}

export interface PurchaseListResponse {
  items: PurchaseInvoice[];
  total_count: number;
  total_amount_scaled: number;
}

export interface ImportRowRequest {
  supplier_sku?: string;
  product_name?: string | null;
  batch_no: string;
  expiry_mm_yy: string;
  qty: number;
  free_qty?: number;
  p_rate?: string | null;
  p_rate_scaled?: number | null;
  mrp?: string | null;
  mrp_scaled?: number | null;
  s_rate_scaled?: number | null;
  dis_bps?: number | null;
  tax_bps?: number | null;
  deal_billed?: number | null;
  deal_free?: number | null;
}

export interface ImportPurchaseRequest {
  supplier_id: string;
  inv_date_display?: string | null;
  godown_id?: string | null;
  payment_mode?: "CASH" | "CREDIT";
  create_missing_products?: boolean;
  rows: ImportRowRequest[];
}

export interface ImportResult {
  purchase_id: string;
  imported_lines: number;
  aliases_saved: number;
  created_products: number;
  unresolved: string[];
  total_scaled: number;
}

export interface AdjustmentItemRequest {
  product_id: string;
  batch_id: string;
  qty: number;
  rate_scaled?: number;
}

export interface AdjustmentSaveRequest {
  adj_type: string;
  adj_date_display?: string | null;
  godown_id?: string | null;
  to_godown_id?: string | null;
  party_id?: string | null;
  reason?: string | null;
  items: AdjustmentItemRequest[];
}

export interface AdjustmentResult {
  id: string;
  display: string;
  adj_type: string;
  total_value_scaled: number;
  lines: number;
}

export interface VoucherLineRequest {
  account_id?: string | null;
  dr_scaled: number;
  cr_scaled: number;
}

export interface VoucherSaveRequest {
  voucher_type: string;
  voucher_date_display?: string | null;
  account_id?: string | null;
  contra_account_id?: string | null;
  amount_scaled: number;
  payment_mode?: string | null;
  instrument_no?: string | null;
  narration?: string | null;
  lines?: VoucherLineRequest[];
}

export interface VoucherResult {
  id: string;
  voucher_no_display: string;
  voucher_type: string;
  amount_scaled: number;
}

export interface StockQueryRequest {
  query?: string;
  godown_id?: string | null;
  only_in_stock?: boolean;
  expiry_within_months?: number | null;
  limit?: number;
}

export interface StockQueryRow {
  batch_id: string;
  product_id: string;
  batch_no: string;
  expiry_mm_yy: string;
  expiry_sort_key: number;
  cur_qty: number;
  tax_stock_qty: number;
  op_qty: number;
  mrp_scaled: number;
  s_rate_scaled: number;
  t_rate_scaled: number;
  p_rate_scaled: number;
  dis_bps: number;
  net_rate_scaled: number;
  is_provisional: number;
  stock_value_scaled: number;
  godown_code: string;
  product_name: string;
  pro_code: number;
  pack_form: string;
  company_name: string;
}

export interface StockQueryResponse {
  items: StockQueryRow[];
  totals: {
    batch_count: number;
    total_units: number;
    total_tax_units: number;
    total_value_scaled: number;
    negative_batches: number;
    expiring_batches: number;
  };
}

export interface CompositionRow {
  id: string;
  pro_code: number;
  name: string;
  pack_form: string;
  pack_unit: number;
  pack_subunit: number;
  composition_desc: string;
  company_name: string;
  cur_qty: number;
  s_rate_scaled: number;
  mrp_scaled: number;
  nearest_expiry: number | null;
}

export interface SalesReportRequest {
  from_iso?: string | null;
  to_iso?: string | null;
  series_code?: string | null;
}

export interface SalesReportResponse {
  daily: Array<Record<string, unknown>>;
  by_series: Array<Record<string, unknown>>;
  top_products: Array<Record<string, unknown>>;
  totals: Record<string, unknown>;
}

export interface LedgerResponse {
  account: Partial<AccountParty>;
  opening_scaled: number;
  closing_scaled: number;
  entries: LedgerEntry[];
}

export interface TickerResponse {
  items: TickerAlert[];
  threshold_expiry_key: number;
}

export interface LoginStartResponse {
  auth_url: string;
  state: string;
  redirect_uri: string;
}

export interface BackupResult {
  filename: string;
  local_path: string;
  bytes: number;
  uploaded: boolean;
  pruned: number;
  message: string;
}

export interface MigrationPreviewResponse {
  format: string;
  total_rows: number;
  products: number;
  with_batches: number;
  warnings: string[];
  sample: Array<Record<string, unknown>>;
}

export interface MigrationImportResponse {
  imported_products: number;
  imported_batches: number;
  updated_batches: number;
  skipped_rows: number;
  warnings: string[];
}

export interface SyncSettingsRequest {
  auto_backup?: boolean;
  auto_sync?: boolean;
  backup_interval_hours?: number;
  sync_interval_secs?: number;
  merchant_vpa?: string;
  printer_name?: string;
  device_name?: string;
  gdrive_client_id?: string;
  gdrive_redirect_uri?: string;
  gdrive_backup_folder?: string;
  gdrive_sync_folder?: string;
  company_name?: string;
  company_address?: string;
  company_gst_no?: string;
  company_dl_no?: string;
  company_phone?: string;
  company_state_code?: string;
  estimate_next_inv_no?: number;
  tax_next_inv_no?: number;
}

// Re-export table types for convenience in components.
export type {
  AccountDetail,
  AccountParty,
  Batch,
  CreditStatus,
  InvoiceDetail,
  LookupItem,
  Product,
  ProductDetail,
  SalesInvoice,
  SalesInvoiceItem,
  StockAdjustment,
  SyncStatus,
  TickerAlert,
  Voucher,
  WindowSummary,
};
