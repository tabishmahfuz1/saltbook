import type { ComponentType } from "react";
import type { WindowKind } from "../stores/useWorkspaceStore";
import { ProductMasterForm } from "../components/masters/ProductMasterForm";
import { PartyMasterForm } from "../components/masters/PartyMasterForm";
import { SupplierMasterForm } from "../components/masters/SupplierMasterForm";
import { CompanyMasterForm } from "../components/masters/CompanyCompositionForms";
import { SalesInvoiceForm } from "../components/billing/SalesInvoiceForm";
import { BillModifyForm } from "../components/billing/BillModifyForm";
import { SubstituteDrawer } from "../components/billing/SubstituteDrawer";
import { PurchaseInvoiceForm } from "../components/purchase/PurchaseInvoiceForm";
import { PurchaseCsvImporter } from "../components/purchase/PurchaseCsvImporter";
import { StockAdjustmentForm } from "../components/adjustment/StockAdjustmentForm";
import { VoucherEntryForm } from "../components/accounts/VoucherEntryForm";
import { StockQueryModal } from "../components/report/StockQueryModal";
import { CompositionQuery, LedgerReport, SalesReport } from "../components/report/ReportPanels";
import {
  AdjustmentRegister,
  PurchaseRegister,
  VoucherRegister,
} from "../components/registers/Registers";
import { GoogleDriveSyncPanel } from "../components/settings/GoogleDriveSyncPanel";
import { SolviMigrationWizard } from "../components/settings/SolviMigrationWizard";
import { FormShell } from "../components/ui/FormShell";

export interface WindowComponentProps {
  windowId: string;
  payload: Record<string, unknown>;
}

function SubstituteWindow({ windowId }: WindowComponentProps) {
  return (
    <FormShell
      windowId={windowId}
      title="Salt Substitutes"
      subtitle="Margin-ranked in-stock alternatives by composition"
      mode="VIEW"
      dirty={false}
      footer={<span>Open a bill (Ctrl+A) to apply a substitute directly to a line.</span>}
    >
      <div className="h-[520px]">
        <SubstituteDrawer />
      </div>
    </FormShell>
  );
}

export const WINDOW_COMPONENTS: Record<WindowKind, ComponentType<WindowComponentProps>> = {
  PRODUCT_MASTER: ProductMasterForm,
  PARTY_MASTER: PartyMasterForm,
  SUPPLIER_MASTER: SupplierMasterForm,
  COMPANY_MASTER: CompanyMasterForm,
  SALES_INVOICE: SalesInvoiceForm,
  BILL_MODIFY: BillModifyForm,
  SALES_REGISTER: BillModifyForm,
  SUBSTITUTE_DRAWER: SubstituteWindow,
  STOCK_QUERY: StockQueryModal,
  COMPOSITION_QUERY: CompositionQuery,
  SALES_REPORT: SalesReport,
  LEDGER_REPORT: LedgerReport,
  PURCHASE_INVOICE: PurchaseInvoiceForm,
  PURCHASE_IMPORT: PurchaseCsvImporter,
  PURCHASE_REGISTER: PurchaseRegister,
  STOCK_ADJUSTMENT: StockAdjustmentForm,
  ADJUSTMENT_REGISTER: AdjustmentRegister,
  VOUCHER_ENTRY: VoucherEntryForm,
  VOUCHER_REGISTER: VoucherRegister,
  GDRIVE_SYNC: GoogleDriveSyncPanel,
  SOLVI_MIGRATION: SolviMigrationWizard,
};
