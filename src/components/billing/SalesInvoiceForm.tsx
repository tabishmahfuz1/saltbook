import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  FileText,
  Plus,
  Printer,
  RotateCcw,
  Save,
  ShoppingBasket,
  Trash2,
} from "lucide-react";
import { api, ApiError } from "../../lib/invoke";
import type { AccountParty, CreditStatus, SalesInvoice, SalesInvoiceItem } from "../../types/database";
import type { InvoiceNumberInfo, InvoiceSaveRequest, PrintPayload } from "../../types/ipc";
import type { Batch } from "../../types/database";
import type { SubstituteProduct } from "../../types/ipc";
import {
  addMonthsToKey,
  currentExpiryKey,
  expiryKeyFromMmYy,
  formatMoney,
  formatPercent,
  todayDisplay,
} from "../../lib/format";
import { invoiceTotals, lineTotals, type LineTotals } from "../../lib/math";
import { useLookups } from "../../hooks/useLookups";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useToastStore } from "../../stores/useToastStore";
import {
  Badge,
  Banner,
  Button,
  Field,
  Kbd,
  Modal,
  Panel,
  ScaledInput,
  Select,
  TextInput,
  cx,
} from "../ui/kit";
import { FormShell } from "../ui/FormShell";
import { PartyLookup, ProductLookup } from "../ui/lookups";
import { FefoBatchPopover } from "./FefoBatchPopover";
import { SubstituteDrawer } from "./SubstituteDrawer";

interface InvoiceLine {
  key: string;
  product_id: string;
  product_name: string;
  company_name: string;
  composition_desc: string;
  pack_form: string;
  pack_unit: number;
  pack_subunit: number;
  batch_id: string;
  batch_no: string;
  expiry: string;
  cur_qty: number;
  godown_code: string;
  billed_qty: number;
  free_deal_qty: number;
  loose_or_box: "B" | "L";
  mrp_scaled: number;
  rate_scaled: number;
  dis_bps: number;
  tax_bps: number;
  tax_inclusive: boolean;
  deal_str: string;
}

interface FefoState {
  product_id: string;
  product_name: string;
  rowIndex: number;
}

let lineCounter = 0;
function emptyLine(): InvoiceLine {
  lineCounter += 1;
  return {
    key: `line-${Date.now()}-${lineCounter}`,
    product_id: "",
    product_name: "",
    company_name: "",
    composition_desc: "",
    pack_form: "",
    pack_unit: 1,
    pack_subunit: 1,
    batch_id: "",
    batch_no: "",
    expiry: "",
    cur_qty: 0,
    godown_code: "",
    billed_qty: 1,
    free_deal_qty: 0,
    loose_or_box: "B",
    mrp_scaled: 0,
    rate_scaled: 0,
    dis_bps: 0,
    tax_bps: 0,
    tax_inclusive: false,
    deal_str: "",
  };
}

function lineFromItem(item: SalesInvoiceItem): InvoiceLine {
  return {
    key: item.id,
    product_id: item.product_id,
    product_name: item.product_name ?? "",
    company_name: item.company_name ?? "",
    composition_desc: item.composition_desc ?? "",
    pack_form: item.pack_form ?? "",
    pack_unit: 1,
    pack_subunit: 1,
    batch_id: item.batch_id,
    batch_no: item.batch_no ?? "",
    expiry: item.expiry_mm_yy ?? "",
    cur_qty: item.batch_cur_qty ?? 0,
    godown_code: item.godown_code ?? "",
    billed_qty: item.billed_qty,
    free_deal_qty: item.free_deal_qty,
    loose_or_box: item.loose_or_box,
    mrp_scaled: item.mrp_scaled,
    rate_scaled: item.rate_scaled,
    dis_bps: item.dis_bps,
    tax_bps: item.tax_bps,
    tax_inclusive: item.tax_inclusive === 1,
    deal_str: item.deal_str ?? "",
  };
}

interface Props {
  windowId: string;
  payload: Record<string, unknown>;
}

export function SalesInvoiceForm({ windowId, payload }: Props) {
  const { lookups } = useLookups();
  const pushToast = useToastStore((state) => state.push);
  const setDirtyStore = useWorkspaceStore((state) => state.setDirty);

  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [savedInvoice, setSavedInvoice] = useState<SalesInvoice | null>(null);
  const [seriesCode, setSeriesCode] = useState("E");
  const [invoiceInfo, setInvoiceInfo] = useState<InvoiceNumberInfo | null>(null);
  const [dateDisplay, setDateDisplay] = useState(todayDisplay);
  const [paymentMode, setPaymentMode] = useState<"CASH" | "CREDIT">("CASH");
  const [party, setParty] = useState<AccountParty | null>(null);
  const [partyQuery, setPartyQuery] = useState("");
  const [credit, setCredit] = useState<CreditStatus | null>(null);
  const [creditOverride, setCreditOverride] = useState(false);
  const [items, setItems] = useState<InvoiceLine[]>([emptyLine()]);
  const [activeRow, setActiveRow] = useState(0);
  const [fefo, setFefo] = useState<FefoState | null>(null);
  const [provisionalSignal, setProvisionalSignal] = useState(0);
  const [substitutes, setSubstitutes] = useState<{ id: string; name: string } | null>(null);
  const [salesman, setSalesman] = useState("");
  const [remarks, setRemarks] = useState("");
  const [freight, setFreight] = useState(0);
  const [othAdj, setOthAdj] = useState(0);
  const [reclaimed, setReclaimed] = useState(0);
  const [paid, setPaid] = useState(0);
  const [isReturn, setIsReturn] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [printPreview, setPrintPreview] = useState<PrintPayload | null>(null);
  const [printInfo, setPrintInfo] = useState<string | null>(null);

  const payloadInvoiceId = String(payload.invoice_id ?? "");

  const markDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      setDirtyStore(windowId, value);
    },
    [setDirtyStore, windowId],
  );

  const applyInvoice = useCallback(
    (detail: { invoice: SalesInvoice; items: SalesInvoiceItem[]; party: { account: AccountParty } | null }) => {
      setInvoiceId(detail.invoice.id);
      setSavedInvoice(detail.invoice);
      setSeriesCode(detail.invoice.series_code);
      setInvoiceInfo({
        series_code: detail.invoice.series_code,
        is_estimate: detail.invoice.is_estimate === 1,
        inv_no: detail.invoice.inv_no,
        inv_no_display: detail.invoice.inv_no_display,
        inv_date_display: detail.invoice.inv_date_display,
        inv_date_iso: detail.invoice.inv_date_iso,
      });
      setDateDisplay(detail.invoice.inv_date_display);
      setPaymentMode(detail.invoice.payment_mode);
      setParty(detail.party?.account ?? null);
      setPartyQuery(detail.invoice.party_name_snapshot);
      setItems(detail.items.length ? detail.items.map(lineFromItem) : [emptyLine()]);
      setSalesman(detail.invoice.salesman_name ?? "");
      setRemarks(detail.invoice.remarks ?? "");
      setFreight(detail.invoice.freight_scaled);
      setOthAdj(detail.invoice.oth_adj_scaled);
      setReclaimed(detail.invoice.reclaimed_scaled);
      setPaid(detail.invoice.paid_amt_scaled);
      setIsReturn(detail.invoice.is_sale_return === 1);
      setCreditOverride(false);
      setBanner(null);
      setFieldErrors({});
      markDirty(false);
    },
    [markDirty],
  );

  useEffect(() => {
    if (!payloadInvoiceId) return;
    let cancelled = false;
    setLoading(true);
    api
      .getInvoice(payloadInvoiceId)
      .then((detail) => {
        if (!cancelled) applyInvoice(detail);
      })
      .catch((error) => {
        if (!cancelled) setBanner(error instanceof Error ? error.message : "Unable to load invoice");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [payloadInvoiceId, applyInvoice]);

  useEffect(() => {
    if (invoiceId) return;
    let cancelled = false;
    api
      .nextInvoiceNo(seriesCode)
      .then((info) => {
        if (!cancelled) setInvoiceInfo(info);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [seriesCode, invoiceId]);

  const interState = party?.is_inter_state === 1;

  const lineCalcs = useMemo<LineTotals[]>(
    () =>
      items.map((line) =>
        lineTotals({
          qty: line.billed_qty,
          free_qty: line.free_deal_qty,
          rate_scaled: line.rate_scaled,
          dis_bps: line.dis_bps,
          tax_bps: line.tax_bps,
          tax_inclusive: line.tax_inclusive,
          is_inter_state: interState,
        }),
      ),
    [items, interState],
  );

  const totals = useMemo(
    () => invoiceTotals(lineCalcs, freight, othAdj, reclaimed, paid, isReturn),
    [lineCalcs, freight, othAdj, reclaimed, paid, isReturn],
  );

  const shownTotals = useMemo(() => {
    if (paymentMode === "CASH" && !isReturn) {
      return { ...totals, paid_amt_scaled: totals.grand_total_scaled, due_amt_scaled: 0 };
    }
    return totals;
  }, [totals, paymentMode, isReturn]);

  const taxGroups = useMemo(() => {
    const groups = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>();
    items.forEach((line, index) => {
      const calc = lineCalcs[index];
      if (!calc) return;
      const entry = groups.get(line.tax_bps) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      entry.taxable += calc.taxable_amt_scaled;
      entry.cgst += calc.cgst_amt_scaled;
      entry.sgst += calc.sgst_amt_scaled;
      entry.igst += calc.igst_amt_scaled;
      groups.set(line.tax_bps, entry);
    });
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [items, lineCalcs]);

  useEffect(() => {
    if (!party) {
      setCredit(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .creditStatus({
          account_id: party.id,
          new_invoice_scaled: Math.max(0, shownTotals.due_amt_scaled),
          payment_mode: paymentMode,
        })
        .then((status) => {
          if (!cancelled) setCredit(status);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [party, shownTotals.due_amt_scaled, paymentMode]);

  const updateLine = (index: number, patch: Partial<InvoiceLine>) => {
    setItems((current) => current.map((line, position) => (position === index ? { ...line, ...patch } : line)));
    markDirty(true);
  };

  const applyProductToLine = (index: number, product: {
    id: string;
    name: string;
    company_name?: string | null;
    composition_desc?: string | null;
    pack_form: string;
    pack_unit: number;
    pack_subunit: number;
    mrp_scaled?: number;
    s_rate_scaled?: number;
    t_rate_scaled?: number;
    p_rate_scaled?: number;
    sale_tax_bps?: number;
    total_cur_qty?: number;
  }) => {
    const prefer =
      party?.billing_on_rate === "MRP"
        ? product.mrp_scaled
        : party?.billing_on_rate === "T_RATE"
          ? product.t_rate_scaled
          : party?.billing_on_rate === "P_RATE"
            ? product.p_rate_scaled
            : product.s_rate_scaled;
    updateLine(index, {
      product_id: product.id,
      product_name: product.name,
      company_name: product.company_name ?? "",
      composition_desc: product.composition_desc ?? "",
      pack_form: product.pack_form,
      pack_unit: product.pack_unit,
      pack_subunit: product.pack_subunit,
      mrp_scaled: product.mrp_scaled ?? 0,
      rate_scaled: prefer || product.s_rate_scaled || 0,
      tax_bps: product.sale_tax_bps ?? 0,
      batch_id: "",
      batch_no: "",
      expiry: "",
      cur_qty: 0,
      godown_code: "",
    });
    setActiveRow(index);
    if ((product.total_cur_qty ?? 0) <= 0) {
      setFefo(null);
      setSubstitutes({ id: product.id, name: product.name });
    } else {
      setFefo({ product_id: product.id, product_name: product.name, rowIndex: index });
    }
  };

  const handleProductSelect = async (index: number, productId: string) => {
    try {
      const detail = await api.getProduct({ id: productId });
      applyProductToLine(index, {
        id: detail.product.id,
        name: detail.product.name,
        company_name: detail.product.company_name,
        composition_desc: detail.product.composition_desc,
        pack_form: detail.product.pack_form,
        pack_unit: detail.product.pack_unit,
        pack_subunit: detail.product.pack_subunit,
        mrp_scaled: detail.product.mrp_scaled,
        s_rate_scaled: detail.product.s_rate_scaled,
        t_rate_scaled: detail.product.t_rate_scaled,
        p_rate_scaled: detail.product.p_rate_scaled,
        sale_tax_bps: detail.product.sale_tax_bps,
        total_cur_qty: detail.stats.total_cur_qty,
      });
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to load product");
    }
  };

  const handleBatchSelect = (batch: Batch, rateScaled: number) => {
    if (!fefo) return;
    updateLine(fefo.rowIndex, {
      batch_id: batch.id,
      batch_no: batch.batch_no,
      expiry: batch.expiry_mm_yy,
      cur_qty: batch.cur_qty,
      godown_code: batch.godown_code ?? "",
      mrp_scaled: batch.mrp_scaled || 0,
      rate_scaled: rateScaled || batch.s_rate_scaled,
      dis_bps: batch.dis_bps || 0,
      tax_bps: batch.tax_bps ?? 0,
      deal_str: batch.deal_str ?? "",
    });
    const row = fefo.rowIndex;
    setFefo(null);
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-qty="${row}"]`)?.focus();
    }, 20);
  };

  const handleSubstitutePick = async (substitute: SubstituteProduct) => {
    try {
      const detail = await api.getProduct({ id: substitute.id });
      const index = activeRow;
      applyProductToLine(index, {
        id: detail.product.id,
        name: detail.product.name,
        company_name: detail.product.company_name,
        composition_desc: detail.product.composition_desc,
        pack_form: detail.product.pack_form,
        pack_unit: detail.product.pack_unit,
        pack_subunit: detail.product.pack_subunit,
        mrp_scaled: detail.product.mrp_scaled,
        s_rate_scaled: detail.product.s_rate_scaled,
        t_rate_scaled: detail.product.t_rate_scaled,
        p_rate_scaled: detail.product.p_rate_scaled,
        sale_tax_bps: detail.product.sale_tax_bps,
        total_cur_qty: detail.stats.total_cur_qty,
      });
      setSubstitutes(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to apply substitute");
    }
  };

  const addLine = () => {
    setItems((current) => [...current, emptyLine()]);
    markDirty(true);
    const index = items.length;
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-nav-index="${200 + index * 10}"]`)?.focus();
    }, 30);
  };

  const removeLine = (index: number) => {
    setItems((current) => (current.length === 1 ? [emptyLine()] : current.filter((_, position) => position !== index)));
    setFefo(null);
    markDirty(true);
  };

  const save = useCallback(async (): Promise<string | null> => {
    setBanner(null);
    const errors: Record<string, string> = {};
    if (!party) {
      errors.party_id = "Select a party before saving.";
      setFieldErrors(errors);
      setBanner("Select a party before saving.");
      return null;
    }
    const linesToSave = items.filter((line) => line.product_id && line.billed_qty > 0);
    if (linesToSave.length === 0) {
      setBanner("Please add at least one product line item before saving.");
      window.setTimeout(() => {
        document.querySelector<HTMLElement>('[data-nav-index="200"]')?.focus();
      }, 30);
      return null;
    }
    const missingBatch = linesToSave.findIndex((line) => !line.batch_id);
    if (missingBatch >= 0) {
      setBanner(`Select a batch for line ${missingBatch + 1}. Open the batch list to pick stock.`);
      return null;
    }
    if (credit?.locked && !creditOverride && paymentMode === "CREDIT" && !isReturn) {
      setBanner(`${credit.reasons.join(" ")} Use “Override credit lock” to bill anyway.`);
      return null;
    }
    setSaving(true);
    try {
      const request: InvoiceSaveRequest = {
        invoice_id: invoiceId,
        series_code: seriesCode,
        inv_date_display: dateDisplay,
        payment_mode: paymentMode,
        party_id: party.id,
        salesman_name: salesman || null,
        remarks: remarks || null,
        is_sale_return: isReturn,
        freight_scaled: freight,
        oth_adj_scaled: othAdj,
        reclaimed_scaled: reclaimed,
        paid_amt_scaled: paid,
        override_credit_lock: creditOverride,
        items: linesToSave.map((line) => ({
          product_id: line.product_id,
          batch_id: line.batch_id,
          loose_or_box: line.loose_or_box,
          billed_qty: line.billed_qty,
          free_deal_qty: line.free_deal_qty,
          deal_str: line.deal_str || null,
          tax_inclusive: line.tax_inclusive,
          mrp_scaled: line.mrp_scaled,
          rate_scaled: line.rate_scaled,
          dis_bps: line.dis_bps,
          tax_bps: line.tax_bps,
        })),
      };
      const saved = await api.saveInvoice(request);
      applyInvoice(saved);
      setCreditOverride(false);
      pushToast(
        `${saved.invoice.series_code === "E" ? "Estimate" : "Tax invoice"} ${saved.invoice.inv_no_display} saved`,
        "success",
      );
      return saved.invoice.id;
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setBanner(apiError?.message ?? "Unable to save invoice");
      if (apiError?.field) setFieldErrors({ [apiError.field]: apiError.message });
      return null;
    } finally {
      setSaving(false);
    }
  }, [
    applyInvoice,
    credit?.locked,
    credit?.reasons,
    creditOverride,
    dateDisplay,
    freight,
    invoiceId,
    isReturn,
    items,
    othAdj,
    paid,
    party,
    paymentMode,
    pushToast,
    reclaimed,
    remarks,
    salesman,
    seriesCode,
  ]);

  const saveAndPrint = useCallback(async () => {
    const id = await save();
    if (!id) return;
    try {
      const preview = await api.printPayload(id);
      setPrintPreview(preview);
      setPrintInfo(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to build print payload");
    }
  }, [save]);

  const newBill = useCallback(() => {
    setInvoiceId(null);
    setSavedInvoice(null);
    setInvoiceInfo(null);
    setParty(null);
    setPartyQuery("");
    setCredit(null);
    setCreditOverride(false);
    setItems([emptyLine()]);
    setActiveRow(0);
    setSalesman("");
    setRemarks("");
    setFreight(0);
    setOthAdj(0);
    setReclaimed(0);
    setPaid(0);
    setIsReturn(false);
    setDateDisplay(todayDisplay());
    setFefo(null);
    setSubstitutes(null);
    setBanner(null);
    setFieldErrors({});
    markDirty(false);
    window.setTimeout(() => {
      document.querySelector<HTMLElement>('[data-nav-index="200"]')?.focus();
    }, 30);
  }, [markDirty]);

  const activeLine = items[activeRow] ?? items[0];
  const activeCalc = lineCalcs[activeRow];
  const nearActiveExpiry = activeLine?.expiry
    ? (() => {
        try {
          return expiryKeyFromMmYy(activeLine.expiry) <= addMonthsToKey(currentExpiryKey(), 3);
        } catch {
          return false;
        }
      })()
    : false;

  const { formRef, onKeyDown } = useKeyboardNav({
    windowId,
    onSave: save,
    onEscape: () => {
      if (fefo) {
        setFefo(null);
        return true;
      }
      if (substitutes) {
        setSubstitutes(null);
        return true;
      }
      return false;
    },
    onProvisional: () => {
      const line = items[activeRow];
      if (!line?.product_id) {
        setBanner("Pick a product line first, then Alt+B captures a provisional batch.");
        return;
      }
      setFefo({ product_id: line.product_id, product_name: line.product_name, rowIndex: activeRow });
      setProvisionalSignal((current) => current + 1);
    },
    onSubstitutes: () => {
      const line = items[activeRow];
      if (!line?.product_id) {
        setBanner("Pick a product line first to see substitutes.");
        return;
      }
      setSubstitutes({ id: line.product_id, name: line.product_name });
    },
    mode: () => "EDIT",
    saveEnabled: true,
    editEnabled: false,
  });

  const estimate = seriesCode === "E";
  const screenTitle = estimate ? "Estimate" : "Tax Invoice";
  const displayNumber = invoiceInfo?.inv_no_display ?? (invoiceId ? savedInvoice?.inv_no_display : "—");
  const totalQty = items.reduce((sum, line) => sum + line.billed_qty + line.free_deal_qty, 0);

  return (
    <FormShell
      windowId={windowId}
      title={`${screenTitle} ${displayNumber ?? ""}`.trim()}
      subtitle={
        invoiceId
          ? `${dateDisplay} · ${party?.name ?? partyQuery} · ${paymentMode}`
          : "New bill · FEFO batch capture · live GST"
      }
      mode={invoiceId ? "EDIT" : "NEW"}
      dirty={dirty}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={newBill}>
            <RotateCcw size={12} /> New bill
          </Button>
          <Button variant="default" size="sm" onClick={saveAndPrint} disabled={saving}>
            <Printer size={12} /> Print
          </Button>
          <Button variant="primary" size="sm" shortcut="Ctrl+S" onClick={() => void save()} disabled={saving}>
            <Save size={12} /> {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
      banner={
        banner ? (
          <Banner
            tone={credit?.locked && !creditOverride ? "warning" : "danger"}
            onClose={() => setBanner(null)}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{banner}</span>
              <div className="flex gap-2">
                {credit?.locked && !creditOverride ? (
                  <Button
                    variant="accent"
                    size="xs"
                    onClick={() => {
                      setCreditOverride(true);
                      setBanner(null);
                    }}
                  >
                    Override credit lock
                  </Button>
                ) : null}
                {activeLine?.product_id ? (
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() => setSubstitutes({ id: activeLine.product_id, name: activeLine.product_name })}
                  >
                    <ArrowRightLeft size={11} /> Find substitutes
                  </Button>
                ) : null}
              </div>
            </div>
          </Banner>
        ) : undefined
      }
      footer={
        <>
          <div className="flex items-center gap-3">
            <span>
              Lines: <span className="font-mono font-semibold">{items.filter((line) => line.product_id).length}</span>
            </span>
            <span>
              Units: <span className="font-mono font-semibold">{totalQty}</span>
            </span>
            <span>
              Due: <span className={cx("font-mono font-semibold", shownTotals.due_amt_scaled > 0 ? "text-crimson" : "text-teal")}>₹{formatMoney(shownTotals.due_amt_scaled)}</span>
            </span>
            {isReturn ? <Badge tone="danger">SALE RETURN</Badge> : null}
            {invoiceId ? <Badge tone="success">saved</Badge> : <Badge tone="warning">unsaved</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <Kbd>Alt+B</Kbd> provisional
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Ctrl+R</Kbd> substitutes
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Ctrl+S</Kbd> save
            </span>
          </div>
        </>
      }
    >
      <div ref={formRef} onKeyDown={onKeyDown} className="space-y-3">
        <Panel title="Invoice header" subtitle="Series, number, date, mode and party">
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 md:grid-cols-12">
            <Field label="Series" className="md:col-span-2">
              <Select
                value={seriesCode}
                disabled={Boolean(invoiceId)}
                data-nav-index={1}
                onChange={(event) => {
                  setSeriesCode(event.target.value);
                  markDirty(true);
                }}
              >
                {lookups.series.map((series) => (
                  <option key={series.id} value={series.code}>
                    {series.code} · {series.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Inv. No" className="md:col-span-2">
              <div className="flex h-7 items-center rounded-[3px] border border-line bg-parchment/60 px-2 font-mono text-[12px] font-bold text-navy">
                {displayNumber || "—"}
                {invoiceInfo?.is_estimate ? <Badge tone="warning" className="ml-auto">EST</Badge> : <Badge tone="success" className="ml-auto">GST</Badge>}
              </div>
            </Field>
            <Field label="Date" className="md:col-span-2">
              <TextInput
                mono
                value={dateDisplay}
                data-nav-index={2}
                onChange={(event) => {
                  setDateDisplay(event.target.value);
                  markDirty(true);
                }}
              />
            </Field>
            <Field label="Mode" className="md:col-span-2">
              <div className="flex h-7 overflow-hidden rounded-[3px] border border-line">
                {(["CASH", "CREDIT"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    data-nav-index={mode === "CASH" ? 3 : 4}
                    onClick={() => {
                      setPaymentMode(mode);
                      setCreditOverride(false);
                      markDirty(true);
                    }}
                    className={cx(
                      "flex-1 text-[10px] font-bold uppercase tracking-wider",
                      paymentMode === mode
                        ? mode === "CASH"
                          ? "bg-teal text-white"
                          : "bg-accent text-white"
                        : "bg-white text-inkmut hover:bg-parchment",
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Party" required error={fieldErrors.party_id} className="md:col-span-4">
              <PartyLookup
                accountType="PARTY"
                query={partyQuery}
                onQueryChange={(value) => {
                  setPartyQuery(value);
                  setParty(null);
                  setCredit(null);
                  setCreditOverride(false);
                  markDirty(true);
                }}
                onSelect={(account) => {
                  setParty(account);
                  setPartyQuery(account.name);
                  setCreditOverride(false);
                  markDirty(true);
                }}
                navIndex={5}
              />
            </Field>
            <Field label="Salesman" className="md:col-span-3">
              <TextInput
                value={salesman}
                data-nav-index={6}
                onChange={(event) => {
                  setSalesman(event.target.value);
                  markDirty(true);
                }}
              />
            </Field>
            <Field label="Remarks" className="md:col-span-6">
              <TextInput
                value={remarks}
                data-nav-index={7}
                onChange={(event) => {
                  setRemarks(event.target.value);
                  markDirty(true);
                }}
              />
            </Field>
            <Field label="Sale return" className="md:col-span-3">
              <label className="flex h-7 items-center gap-2 rounded-[3px] border border-line bg-white px-2 text-[10.5px]">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-crimson"
                  checked={isReturn}
                  data-nav-index={8}
                  onChange={(event) => {
                    setIsReturn(event.target.checked);
                    markDirty(true);
                  }}
                />
                Reverse stock & ledger
              </label>
            </Field>
          </div>

          {party ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[3px] border border-line/80 bg-skybg/45 px-3 py-1 text-[10px]">
              <span className="font-semibold">{party.name}</span>
              <span className="text-inkmut">{[party.address_line1, party.city, party.state].filter(Boolean).join(", ") || "—"}</span>
              <span className="font-mono text-[9px] text-inkmut">GST {party.gst_no || "—"}</span>
              <span className="font-mono text-[9px] text-inkmut">DL {[party.dl_no_1, party.dl_no_2].filter(Boolean).join(" / ") || "—"}</span>
              <span className="ml-auto flex items-center gap-2">
                <span className="text-[8.5px] uppercase tracking-wider text-inkmut">Cur bal</span>
                <span className={cx("font-mono text-[10.5px] font-semibold", party.cur_bal_scaled > 0 ? "text-crimson" : "text-teal")}>
                  ₹{formatMoney(party.cur_bal_scaled)}
                </span>
                <Badge tone={credit?.locked ? "danger" : "success"} dot>
                  {credit?.locked ? "locked" : "open"}
                </Badge>
                <span className="font-mono text-[9px] text-inkmut">{party.billing_on_rate.replace("_", ".")}</span>
              </span>
            </div>
          ) : null}

          {credit?.locked && !isReturn ? (
            <div className="mt-2 rounded-[3px] border border-[#e6b8b3] bg-crimsonbg/60 px-3 py-2 text-[10.5px] leading-snug text-[#8f1d17]">
              <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wider">Credit locked for CREDIT bills</div>
              {credit.reasons.map((reason) => (
                <div key={reason}>• {reason}</div>
              ))}
              {creditOverride ? (
                <div className="mt-1 font-semibold">Override active — this bill will save and can be reconciled later.</div>
              ) : (
                <button
                  type="button"
                  className="mt-1 font-semibold underline underline-offset-2"
                  onClick={() => setCreditOverride(true)}
                >
                  Override credit lock for this bill
                </button>
              )}
            </div>
          ) : null}
        </Panel>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 rounded-[4px] border border-line bg-[linear-gradient(90deg,#f4efe2,#fbf8f1)] px-3 py-1 text-[9.5px]">
          <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.12em] text-navy">
            <ShoppingBasket size={11} /> Active item
          </span>
          {activeLine?.product_id ? (
            <>
              <span className="font-semibold">{activeLine.product_name}</span>
              <span className="text-inkmut">
                {activeLine.company_name} · {activeLine.pack_form} {activeLine.pack_unit}×{activeLine.pack_subunit}
              </span>
              <span className="truncate text-inkmut">{activeLine.composition_desc || "—"}</span>
              <span className="ml-auto flex items-center gap-2">
                {activeLine.batch_id ? (
                  <Badge tone={nearActiveExpiry ? "warning" : "neutral"}>
                    {activeLine.batch_no} · {activeLine.expiry} · {activeLine.godown_code}
                  </Badge>
                ) : (
                  <Badge tone="danger">no batch</Badge>
                )}
                {activeCalc ? <span className="font-mono text-[11px] font-semibold">₹{formatMoney(activeCalc.net_line_scaled)}</span> : null}
              </span>
            </>
          ) : (
            <span className="text-inkmut">Select a product in a line to see pack, composition and batch context.</span>
          )}
        </div>

        <Panel
          title="Line items"
          subtitle="Enter on product opens FEFO · Alt+B provisional batch · Ctrl+R substitutes"
          right={
            <div className="flex items-center gap-2">
              <Button variant="default" size="xs" onClick={addLine}>
                <Plus size={11} /> Add line
              </Button>
              <Badge tone="neutral">{items.length} rows</Badge>
            </div>
          }
          bodyClassName="relative p-0"
          className="relative"
        >
          <div className="max-h-[280px] overflow-auto">
            <table className="w-full min-w-[1150px] text-[11px]">
              <thead>
                <tr className="sticky top-0 z-10 border-b border-line bg-parchment text-[8.5px] uppercase tracking-[0.08em] text-inkmut">
                  <th className="w-[30px] px-1 py-1.5 text-center">#</th>
                  <th className="w-[250px] px-2 py-1.5 text-left">Product</th>
                  <th className="w-[172px] px-2 py-1.5 text-left">Batch</th>
                  <th className="w-[62px] px-2 py-1.5 text-right">Qty</th>
                  <th className="w-[58px] px-2 py-1.5 text-right">Free</th>
                  <th className="w-[84px] px-2 py-1.5 text-right">Rate</th>
                  <th className="w-[58px] px-2 py-1.5 text-right">Dis%</th>
                  <th className="w-[58px] px-2 py-1.5 text-right">GST</th>
                  <th className="w-[92px] px-2 py-1.5 text-right">Amount</th>
                  <th className="w-[30px]" />
                </tr>
              </thead>
              <tbody>
                {items.map((line, index) => {
                  const calc = lineCalcs[index];
                  const rowNear = (() => {
                    try {
                      return line.expiry ? expiryKeyFromMmYy(line.expiry) <= addMonthsToKey(currentExpiryKey(), 3) : false;
                    } catch {
                      return false;
                    }
                  })();
                  return (
                    <tr
                      key={line.key}
                      className={cx("border-b border-line/45", index === activeRow ? "bg-skybg/70" : "bg-white")}
                      onFocusCapture={() => setActiveRow(index)}
                      onClick={() => setActiveRow(index)}
                    >
                      <td className="px-1 py-1 text-center font-mono text-[9.5px] text-inkmut">{index + 1}</td>
                      <td className="px-2 py-1 align-top">
                        <ProductLookup
                          query={line.product_name}
                          onQueryChange={(value) => {
                            updateLine(index, {
                              product_name: value,
                              product_id: "",
                              batch_id: "",
                              batch_no: "",
                              expiry: "",
                              cur_qty: 0,
                            });
                          }}
                          onSelect={(product) => {
                            void handleProductSelect(index, product.id);
                          }}
                          navIndex={200 + index * 10}
                          placeholder="Product…"
                        />
                        <div className="mt-0.5 truncate text-[8.5px] text-inkmut">
                          {line.company_name || "—"} {line.composition_desc ? `· ${line.composition_desc}` : ""}
                        </div>
                      </td>
                      <td className="px-2 py-1 align-top">
                        <button
                          type="button"
                          disabled={!line.product_id}
                          data-nav-index={200 + index * 10 + 1}
                          onClick={() => {
                            if (!line.product_id) return;
                            setActiveRow(index);
                            setFefo({ product_id: line.product_id, product_name: line.product_name, rowIndex: index });
                          }}
                          className={cx(
                            "w-full rounded-[3px] border px-1.5 py-1 text-left text-[10px] transition",
                            line.batch_id
                              ? rowNear
                                ? "border-amberline bg-amberbg/70 hover:bg-amberbg"
                                : "border-line bg-white hover:bg-parchment"
                              : "border-dashed border-line bg-parchment/40 text-inkmut hover:border-teal hover:text-teal",
                            !line.product_id && "cursor-not-allowed opacity-50",
                          )}
                        >
                          {line.batch_id ? (
                            <>
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-mono font-semibold">{line.batch_no}</span>
                                <span className={cx("font-mono text-[9px]", rowNear ? "text-[#8a5a10]" : "text-inkmut")}>{line.expiry}</span>
                              </div>
                              <div className="flex items-center justify-between text-[9px] text-inkmut">
                                <span>{line.godown_code || "MAIN"}</span>
                                <span className={cx("font-mono", line.cur_qty <= 0 ? "text-crimson" : "")}>{line.cur_qty} on hand</span>
                              </div>
                            </>
                          ) : (
                            <span>Select batch…</span>
                          )}
                        </button>
                      </td>
                      <td className="px-2 py-1 align-top">
                        <TextInput
                          mono
                          type="number"
                          min={1}
                          align="right"
                          value={line.billed_qty}
                          data-nav-index={200 + index * 10 + 2}
                          data-qty={index}
                          className={cx("h-7 px-1.5", line.cur_qty > 0 && line.billed_qty > line.cur_qty ? "border-crimson" : "")}
                          onChange={(event) => updateLine(index, { billed_qty: Number(event.target.value) })}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <TextInput
                          mono
                          type="number"
                          min={0}
                          align="right"
                          value={line.free_deal_qty}
                          data-nav-index={200 + index * 10 + 3}
                          className="h-7 px-1.5"
                          onChange={(event) => updateLine(index, { free_deal_qty: Number(event.target.value) })}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <ScaledInput
                          value={line.rate_scaled}
                          onValueChange={(value) => updateLine(index, { rate_scaled: value })}
                          navIndex={200 + index * 10 + 4}
                          className="h-7 px-1.5"
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <TextInput
                          mono
                          align="right"
                          inputMode="decimal"
                          value={line.dis_bps ? line.dis_bps / 100 : ""}
                          data-nav-index={200 + index * 10 + 5}
                          className="h-7 px-1.5"
                          onChange={(event) =>
                            updateLine(index, { dis_bps: Math.round((Number(event.target.value) || 0) * 100) })
                          }
                        />
                      </td>
                      <td className="px-2 py-1 text-right align-top">
                        <div className="flex h-7 items-center justify-end font-mono text-[10px] text-inkmut">
                          {formatPercent(line.tax_bps)}
                        </div>
                      </td>
                      <td className="px-2 py-1 text-right align-top">
                        <div className="flex h-7 items-center justify-end font-mono text-[11px] font-semibold">
                          {formatMoney(calc?.net_line_scaled ?? 0)}
                        </div>
                      </td>
                      <td className="px-1 py-1 text-center align-top">
                        <button
                          type="button"
                          onClick={() => removeLine(index)}
                          className="mt-1 text-inkmut/60 hover:text-crimson"
                          title="Remove line"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {fefo ? (
            <FefoBatchPopover
              key={`${fefo.product_id}-${fefo.rowIndex}`}
              productId={fefo.product_id}
              productName={fefo.product_name}
              billingOn={party?.billing_on_rate ?? "S_RATE"}
              defaultQty={items[fefo.rowIndex]?.billed_qty ?? 1}
              provisionalSignal={provisionalSignal}
              onSelect={handleBatchSelect}
              onClose={() => setFefo(null)}
              onSubstitutes={() => {
                setFefo(null);
                setSubstitutes({ id: fefo.product_id, name: fefo.product_name });
              }}
            />
          ) : null}

          {substitutes ? (
            <div className="absolute right-2 top-2 z-40 max-h-[430px] w-[560px] overflow-hidden">
              <SubstituteDrawer
                embedded
                productId={substitutes.id}
                productName={substitutes.name}
                onPick={handleSubstitutePick}
                onClose={() => setSubstitutes(null)}
              />
            </div>
          ) : null}
        </Panel>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-[4px] border border-line bg-white/60 px-3 py-1.5">
          {[
            ["Freight", freight, setFreight, 9, false],
            ["Other adj", othAdj, setOthAdj, 10, false],
            ["Reclaimed", reclaimed, setReclaimed, 11, false],
          ].map(([label, value, setter, navIndex, readOnly]) => (
            <label key={String(label)} className="flex items-center gap-1.5">
              <span className="text-[8.5px] font-semibold uppercase tracking-[0.1em] text-inkmut">{String(label)}</span>
              <ScaledInput
                value={Number(value)}
                onValueChange={(next) => {
                  (setter as (value: number) => void)(next);
                  markDirty(true);
                }}
                readOnly={Boolean(readOnly)}
                navIndex={Number(navIndex)}
                className="h-6 w-[92px] px-1.5 text-[10.5px]"
              />
            </label>
          ))}
          <label className="ml-auto flex items-center gap-1.5">
            <span className="text-[8.5px] font-semibold uppercase tracking-[0.1em] text-inkmut">
              {paymentMode === "CASH" ? "Paid (auto)" : "Paid"}
            </span>
            <ScaledInput
              value={paymentMode === "CASH" ? shownTotals.grand_total_scaled : paid}
              onValueChange={(value) => { setPaid(value); markDirty(true); }}
              readOnly={paymentMode === "CASH"}
              navIndex={12}
              className="h-6 w-[100px] px-1.5 text-[10.5px]"
            />
          </label>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Panel title="GST sub-grid" subtitle={interState ? "Inter-state: IGST" : "Intra-state: CGST + SGST"}>
            <table className="ledger-table">
              <thead>
                <tr>
                  <th className="text-left">GST</th>
                  <th className="text-right">Taxable</th>
                  <th className="text-right">CGST</th>
                  <th className="text-right">SGST</th>
                  <th className="text-right">IGST</th>
                </tr>
              </thead>
              <tbody>
                {taxGroups.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-[10.5px] text-inkmut">
                      Add a product line to see the tax split.
                    </td>
                  </tr>
                ) : (
                  taxGroups.map(([bps, group]) => (
                    <tr key={bps}>
                      <td className="font-mono">{formatPercent(bps)}</td>
                      <td className="text-right font-mono">{formatMoney(group.taxable)}</td>
                      <td className="text-right font-mono">{formatMoney(group.cgst)}</td>
                      <td className="text-right font-mono">{formatMoney(group.sgst)}</td>
                      <td className="text-right font-mono">{formatMoney(group.igst)}</td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="text-right font-mono">{formatMoney(taxGroups.reduce((sum, [, group]) => sum + group.taxable, 0))}</td>
                  <td className="text-right font-mono">{formatMoney(taxGroups.reduce((sum, [, group]) => sum + group.cgst, 0))}</td>
                  <td className="text-right font-mono">{formatMoney(taxGroups.reduce((sum, [, group]) => sum + group.sgst, 0))}</td>
                  <td className="text-right font-mono">{formatMoney(taxGroups.reduce((sum, [, group]) => sum + group.igst, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </Panel>

          <Panel title="Totals" bodyClassName="space-y-1">
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">Gross</span>
              <span className="font-mono">₹{formatMoney(shownTotals.gross_total_scaled)}</span>
            </div>
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">Discount ({formatPercent(shownTotals.dis_bps)})</span>
              <span className="font-mono text-crimson">−{formatMoney(Math.abs(shownTotals.dis_amt_scaled))}</span>
            </div>
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">GST</span>
              <span className="font-mono">₹{formatMoney(shownTotals.tax_amt_scaled)}</span>
            </div>
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">Freight</span>
              <span className="font-mono">₹{formatMoney(shownTotals.freight_scaled)}</span>
            </div>
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">Other adjustment</span>
              <span className="font-mono">₹{formatMoney(shownTotals.oth_adj_scaled)}</span>
            </div>
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">Round off</span>
              <span className="font-mono">{formatMoney(shownTotals.roundoff_scaled)}</span>
            </div>
            <div className="flex items-baseline justify-between rounded-[3px] bg-navy px-2 py-1 text-white">
              <span className="text-[9px] font-bold uppercase tracking-[0.14em]">Grand total</span>
              <span className="font-mono text-[16px] font-bold">₹{formatMoney(shownTotals.grand_total_scaled)}</span>
            </div>
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">Paid</span>
              <span className="font-mono">₹{formatMoney(shownTotals.paid_amt_scaled)}</span>
            </div>
            <div className="flex justify-between text-[11px] font-semibold">
              <span>Due</span>
              <span className={cx("font-mono", shownTotals.due_amt_scaled > 0 ? "text-crimson" : "text-teal")}>
                ₹{formatMoney(shownTotals.due_amt_scaled)}
              </span>
            </div>
          </Panel>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border border-line bg-white/40 px-3 py-2 text-[10px] text-inkmut">
          <span className="flex items-center gap-2">
            <FileText size={12} />
            {invoiceId ? "Editing a saved bill — stock and ledger are reversed before re-applying." : "New bill — series number is allocated on save."}
          </span>
          <span className="flex items-center gap-2">
            <span>Enter advances fields</span>
            <Kbd>Esc</Kbd> closes popovers
            <Kbd>Ctrl+S</Kbd> saves
            {loading ? <Badge tone="info">loading…</Badge> : null}
          </span>
        </div>
      </div>

      <Modal
        open={Boolean(printPreview)}
        title="Print preview"
        onClose={() => setPrintPreview(null)}
        width="max-w-3xl"
        footer={
          <>
            <Button variant="default" size="sm" onClick={() => setPrintPreview(null)}>
              Close
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={async () => {
                if (!invoiceId) return;
                try {
                  const result = await api.exportInvoicePdf({ invoice_id: invoiceId });
                  setPrintInfo(`PDF exported to ${result.path}`);
                } catch (error) {
                  setPrintInfo(error instanceof Error ? error.message : "Export failed");
                }
              }}
            >
              Export PDF
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                if (!invoiceId) return;
                try {
                  const result = await api.printInvoice({ invoice_id: invoiceId });
                  setPrintInfo(result.printer ? `Sent to ${result.printer}` : `Spool file: ${result.path}`);
                } catch (error) {
                  setPrintInfo(error instanceof Error ? error.message : "Print failed");
                }
              }}
            >
              Send to printer
            </Button>
          </>
        }
      >
        {printPreview ? (
          <div className="grid gap-3 md:grid-cols-[1fr_180px]">
            <div className="max-h-[420px] overflow-auto rounded-[3px] border border-line bg-white p-3">
              <pre className="whitespace-pre-wrap font-mono text-[10px] leading-[1.45] text-ink">{printPreview.text}</pre>
            </div>
            <div className="space-y-2">
              <div className="rounded-[3px] border border-line bg-white p-2">
                {printPreview.qr_svg ? (
                  <div className="[&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: printPreview.qr_svg }} />
                ) : (
                  <div className="grid h-[140px] place-items-center text-center text-[9px] text-inkmut">
                    UPI QR is rendered by the desktop app
                  </div>
                )}
              </div>
              <div className="rounded-[3px] border border-line bg-parchment/50 p-2 text-[9px] break-all text-inkmut">
                {printPreview.upi_uri}
              </div>
              {printInfo ? <Banner tone="info">{printInfo}</Banner> : null}
            </div>
          </div>
        ) : null}
      </Modal>
    </FormShell>
  );
}
