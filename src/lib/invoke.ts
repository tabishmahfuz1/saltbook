/** Typed invoke wrapper with a browser mock fallback for design preview. */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AccountDetail, Batch, LookupItem, ProductDetail, SyncStatus } from "../types/database";
import type {
  AccountSaveRequest,
  AccountSearchResponse,
  AdjustmentResult,
  AdjustmentSaveRequest,
  BackupResult,
  CompositionRow,
  ConvertResponse,
  FefoResponse,
  ImportPurchaseRequest,
  ImportResult,
  InvoiceDetail,
  InvoiceListRequest,
  InvoiceListResponse,
  InvoiceNumberInfo,
  InvoiceSaveRequest,
  LedgerResponse,
  LoginStartResponse,
  LookupListResponse,
  MigrationImportResponse,
  MigrationPreviewResponse,
  PrintPayload,
  ProductSaveRequest,
  ProvisionalBatchRequest,
  PurchaseDetail,
  PurchaseListResponse,
  PurchaseSaveRequest,
  SalesReportRequest,
  SalesReportResponse,
  SearchProductsRequest,
  SearchProductsResponse,
  StockQueryRequest,
  StockQueryResponse,
  SubstituteProduct,
  SyncSettingsRequest,
  TickerResponse,
  VoucherResult,
  VoucherSaveRequest,
} from "../types/ipc";
import { mockInvoke } from "./mockBackend";

export class ApiError extends Error {
  code: string;
  field?: string;

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.field = field;
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: string; message?: string; field?: string };
    if (candidate.message) {
      return new ApiError(candidate.code ?? "APP", candidate.message, candidate.field);
    }
  }
  if (error instanceof Error) {
    return new ApiError("CLIENT", error.message);
  }
  return new ApiError("CLIENT", String(error));
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    if (isTauriRuntime()) {
      return await tauriInvoke<T>(command, args);
    }
    return await mockInvoke<T>(command, args);
  } catch (error) {
    throw toApiError(error);
  }
}

export interface LookupSaveRequest {
  kind: string;
  id?: string | null;
  code?: string | null;
  name?: string | null;
  description?: string | null;
  is_default?: boolean;
}

export const api = {
  // Products & lookups ------------------------------------------------------
  searchProducts: (req: SearchProductsRequest) =>
    call<SearchProductsResponse>("search_products", { req }),
  getProduct: (req: { id?: string; pro_code?: number }) => call<ProductDetail>("get_product", { req }),
  nextProductCode: () => call<{ pro_code: number }>("next_product_code"),
  saveProduct: (req: ProductSaveRequest) => call<ProductDetail>("save_product", { req }),
  deleteProduct: (id: string) => call<{ ok: boolean }>("delete_product", { req: { id } }),
  listLookups: (kind: string) => call<LookupListResponse>("list_lookups", { req: { kind } }),
  saveLookup: (req: LookupSaveRequest) =>
    call<{ id: string; name: string }>("save_lookup", { req }),

  // Parties & suppliers -----------------------------------------------------
  searchAccounts: (req: { account_type: "PARTY" | "SUPPLIER"; query?: string; limit?: number }) =>
    call<AccountSearchResponse>("search_accounts", { req }),
  getAccount: (req: { id?: string; code?: string }) => call<AccountDetail>("get_account", { req }),
  saveAccount: (req: AccountSaveRequest) => call<AccountDetail>("save_account", { req }),
  nextAccountCode: (account_type: "PARTY" | "SUPPLIER") =>
    call<{ code: string }>("next_account_code", { req: { account_type } }),
  creditStatus: (req: { account_id: string; new_invoice_scaled?: number; payment_mode?: string }) =>
    call<import("../types/database").CreditStatus>("account_credit_status", { req }),

  // Sales -------------------------------------------------------------------
  nextInvoiceNo: (series_code: string) =>
    call<InvoiceNumberInfo>("next_invoice_no", { req: { series_code } }),
  saveInvoice: (req: InvoiceSaveRequest) => call<InvoiceDetail>("save_invoice", { req }),
  getInvoice: (invoice_id: string) => call<InvoiceDetail>("get_invoice", { req: { invoice_id } }),
  listInvoices: (req: InvoiceListRequest) => call<InvoiceListResponse>("list_invoices", { req }),
  fefoBatches: (req: { product_id: string; include_empty?: boolean; godown_id?: string }) =>
    call<FefoResponse>("fefo_batches", { req }),
  substitutes: (req: { product_id: string; limit?: number }) =>
    call<{ items: SubstituteProduct[] }>("substitutes", { req }),
  createProvisionalBatch: (req: ProvisionalBatchRequest) =>
    call<{ batch: Batch }>("create_provisional_batch", { req }),
  convertEstimates: (invoice_ids: string[], inv_date_display?: string) =>
    call<ConvertResponse>("convert_estimates_to_tax", { req: { invoice_ids, inv_date_display } }),
  deleteInvoice: (invoice_id: string) => call<{ ok: boolean }>("delete_invoice", { req: { invoice_id } }),
  printPayload: (invoice_id: string) =>
    call<PrintPayload>("invoice_print_payload", { req: { invoice_id } }),
  printInvoice: (req: { invoice_id: string; printer?: string }) =>
    call<{ path: string; bytes: number; printer: string }>("print_invoice", { req }),
  exportInvoicePdf: (req: { invoice_id: string; dest_path?: string }) =>
    call<{ path: string }>("export_invoice_pdf", { req }),

  // Purchases ---------------------------------------------------------------
  savePurchase: (req: PurchaseSaveRequest) => call<PurchaseDetail>("save_purchase", { req }),
  getPurchase: (purchase_id: string) => call<PurchaseDetail>("get_purchase", { req: { purchase_id } }),
  listPurchases: (req: { query?: string; from_iso?: string; to_iso?: string; limit?: number }) =>
    call<PurchaseListResponse>("list_purchases", { req }),
  importPurchaseRows: (req: ImportPurchaseRequest) =>
    call<ImportResult>("import_purchase_rows", { req }),
  saveSkuAlias: (req: { supplier_id: string; alias_name: string; product_id: string }) =>
    call<{ ok: boolean }>("save_sku_alias", { req }),
  listSkuAliases: (supplier_id: string) =>
    call<{ items: Array<Record<string, unknown>> }>("list_sku_aliases", { req: { supplier_id } }),

  // Adjustments & accounts --------------------------------------------------
  listAdjustmentTypes: () =>
    call<{ items: Array<{ code: string; label: string; direction: string }> }>("list_adjustment_types"),
  listVoucherTypes: () =>
    call<{ items: Array<{ code: string; label: string; prefix: string }> }>("list_voucher_types"),
  saveAdjustment: (req: AdjustmentSaveRequest) =>
    call<AdjustmentResult>("save_adjustment", { req }),
  listAdjustments: (req: { limit?: number; adj_type?: string } = {}) =>
    call<{ items: Array<Record<string, unknown>> }>("list_adjustments", { req }),
  saveVoucher: (req: VoucherSaveRequest) => call<VoucherResult>("save_voucher", { req }),
  listVouchers: (req: { limit?: number; voucher_type?: string; account_id?: string } = {}) =>
    call<{ items: Array<Record<string, unknown>> }>("list_vouchers", { req }),

  // Reports -----------------------------------------------------------------
  ticker: (req: { limit?: number; months_ahead?: number } = {}) =>
    call<TickerResponse>("get_ticker_alerts", { req }),
  stockQuery: (req: StockQueryRequest) => call<StockQueryResponse>("stock_query", { req }),
  compositionQuery: (req: { query?: string; limit?: number }) =>
    call<{ items: CompositionRow[] }>("composition_query", { req }),
  salesReport: (req: SalesReportRequest) => call<SalesReportResponse>("sales_report", { req }),
  ledger: (req: { account_id: string; from_iso?: string; to_iso?: string; limit?: number }) =>
    call<LedgerResponse>("ledger_report", { req }),
  summary: () => call<import("../types/database").WindowSummary>("window_summary"),
  batchHistory: (batch_id: string) =>
    call<{ items: Array<Record<string, unknown>> }>("batch_movement_history", { req: { batch_id } }),

  // Sync, backup, migration -------------------------------------------------
  syncStatus: () => call<SyncStatus>("get_sync_status"),
  saveSyncSettings: (req: SyncSettingsRequest) =>
    call<{ ok: boolean }>("set_sync_settings", { req }),
  startLogin: (req: { client_id?: string; redirect_uri?: string } = {}) =>
    call<LoginStartResponse>("start_gdrive_login", { req }),
  completeLogin: (req: { code: string; state?: string }) =>
    call<{ connected: boolean; has_refresh_token: boolean }>("complete_gdrive_login", { req }),
  disconnectDrive: () => call<{ ok: boolean }>("gdrive_disconnect"),
  backupNow: () => call<BackupResult>("run_backup_now"),
  syncNow: () =>
    call<{ pushed: number; uploaded_file: string | null; files_pulled: number; rows_applied: number }>(
      "run_delta_sync_now",
    ),
  listBackups: () =>
    call<{ local: Array<Record<string, unknown>>; remote: Array<Record<string, unknown>>; dir: string }>(
      "list_backups",
    ),
  startLanServer: (port: number) =>
    call<{ port: number; url: string; local_url: string }>("start_lan_sync_server", { req: { port } }),
  migrationPreview: (path: string) =>
    call<MigrationPreviewResponse>("migration_preview", { req: { path } }),
  migrationImport: (req: { path: string; create_missing_products?: boolean; godown_id?: string }) =>
    call<MigrationImportResponse>("migration_import", { req }),

  // Dev ---------------------------------------------------------------------
  seedDemo: () =>
    call<{ products: number; new_batches: number; parties: number; suppliers: number; invoices: number }>(
      "seed_demo_catalog",
    ),
};

export type LookupKind = "groups" | "companies" | "compositions" | "tax_plans" | "godowns" | "series";

export type { LookupItem };
