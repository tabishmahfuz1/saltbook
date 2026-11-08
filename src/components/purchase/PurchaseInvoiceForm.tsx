import { useCallback, useEffect, useMemo, useState } from "react";
import { FileSpreadsheet, PackagePlus, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { api, ApiError } from "../../lib/invoke";
import type { AccountParty, PurchaseInvoice } from "../../types/database";
import type { PurchaseItemRequest, PurchaseSaveRequest } from "../../types/ipc";
import {
  addMonthsToKey,
  currentExpiryKey,
  expiryKeyFromMmYy,
  formatMoney,
  formatRate4,
  todayDisplay,
} from "../../lib/format";
import { applyBps, calcNetRate, roundToRupee } from "../../lib/math";
import { useLookups } from "../../hooks/useLookups";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useToastStore } from "../../stores/useToastStore";
import { Badge, Banner, Button, Field, Kbd, Panel, ScaledInput, Select, TextInput, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";
import { PartyLookup } from "../ui/lookups";

interface PurchaseLine {
  key: string;
  product_id: string;
  product_name: string;
  company_name: string;
  pack_form: string;
  batch_no: string;
  expiry_mm_yy: string;
  billed_qty: number;
  free_qty: number;
  deal_billed: number;
  deal_free: number;
  mrp_scaled: number;
  p_rate_scaled: number;
  dis_bps: number;
  tax_bps: number;
  s_rate_scaled: number;
  t_rate_scaled: number;
}

let lineCounter = 0;
function emptyLine(): PurchaseLine {
  lineCounter += 1;
  const expiry = addMonthsToKey(currentExpiryKey(), 12);
  return {
    key: `purchase-line-${Date.now()}-${lineCounter}`,
    product_id: "",
    product_name: "",
    company_name: "",
    pack_form: "",
    batch_no: "",
    expiry_mm_yy: `${String(expiry % 100).padStart(2, "0")}/${String(Math.floor(expiry / 100) % 100).padStart(2, "0")}`,
    billed_qty: 10,
    free_qty: 0,
    deal_billed: 0,
    deal_free: 0,
    mrp_scaled: 0,
    p_rate_scaled: 0,
    dis_bps: 0,
    tax_bps: 0,
    s_rate_scaled: 0,
    t_rate_scaled: 0,
  };
}

function parseDeal(text: string): { billed: number; free: number } {
  const match = text.match(/(\d+)\s*\+\s*(\d+)/);
  if (match) return { billed: Number(match[1]), free: Number(match[2]) };
  const single = text.match(/^\s*(\d+)\s*$/);
  return single ? { billed: Number(single[1]), free: 0 } : { billed: 0, free: 0 };
}

interface Props {
  windowId: string;
  payload: Record<string, unknown>;
}

export function PurchaseInvoiceForm({ windowId }: Props) {
  const { lookups } = useLookups();
  const pushToast = useToastStore((state) => state.push);
  const setDirtyStore = useWorkspaceStore((state) => state.setDirty);
  const openWindow = useWorkspaceStore((state) => state.openWindow);

  const [supplier, setSupplier] = useState<AccountParty | null>(null);
  const [supplierQuery, setSupplierQuery] = useState("");
  const [supInvNo, setSupInvNo] = useState("");
  const [dateDisplay, setDateDisplay] = useState(todayDisplay);
  const [godownId, setGodownId] = useState("");
  const [paymentMode, setPaymentMode] = useState<"CASH" | "CREDIT">("CREDIT");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<PurchaseLine[]>([emptyLine()]);
  const [freight, setFreight] = useState(0);
  const [othAdj, setOthAdj] = useState(0);
  const [paid, setPaid] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [recent, setRecent] = useState<PurchaseInvoice[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);

  const markDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      setDirtyStore(windowId, value);
    },
    [setDirtyStore, windowId],
  );

  useEffect(() => {
    if (!godownId && lookups.godowns.length) {
      setGodownId(lookups.godowns.find((row) => row.is_default === 1)?.id ?? lookups.godowns[0].id);
    }
  }, [lookups.godowns, godownId]);

  const loadRecent = useCallback(async () => {
    try {
      const response = await api.listPurchases({ limit: 8 });
      setRecent(response.items);
    } catch {
      /* non-blocking */
    }
  }, []);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  const updateLine = (index: number, patch: Partial<PurchaseLine>) => {
    setLines((current) => current.map((line, position) => (position === index ? { ...line, ...patch } : line)));
    markDirty(true);
  };

  const lineTotals = useMemo(
    () =>
      lines.map((line) => {
        const gross = line.billed_qty * line.p_rate_scaled;
        const dis = applyBps(gross, line.dis_bps);
        const taxable = gross - dis;
        const tax = applyBps(taxable, line.tax_bps);
        const netRate = calcNetRate(
          line.p_rate_scaled,
          line.deal_billed,
          line.deal_free,
          line.dis_bps,
          line.tax_bps,
        );
        return { gross, dis, taxable, tax, amount: taxable + tax, netRate };
      }),
    [lines],
  );

  const totalGross = lineTotals.reduce((sum, line) => sum + line.gross, 0);
  const totalDis = lineTotals.reduce((sum, line) => sum + line.dis, 0);
  const totalTax = lineTotals.reduce((sum, line) => sum + line.tax, 0);
  const grandBefore = totalGross - totalDis + totalTax + freight + othAdj;
  const grand = roundToRupee(grandBefore);
  const roundoff = grand - grandBefore;
  const paidAmount = paymentMode === "CASH" ? grand : paid;
  const due = grand - paidAmount;

  const addLine = () => {
    setLines((current) => [...current, emptyLine()]);
    markDirty(true);
  };

  const removeLine = (index: number) => {
    setLines((current) => (current.length === 1 ? [emptyLine()] : current.filter((_, position) => position !== index)));
    markDirty(true);
  };

  const resetForm = useCallback(() => {
    setSupplier(null);
    setSupplierQuery("");
    setSupInvNo("");
    setDateDisplay(todayDisplay());
    setLines([emptyLine()]);
    setFreight(0);
    setOthAdj(0);
    setPaid(0);
    setRemarks("");
    setBanner(null);
    setSavedId(null);
    markDirty(false);
  }, [markDirty]);

  const save = useCallback(async () => {
    setBanner(null);
    if (!supplier) {
      setBanner("Select a supplier before saving the purchase.");
      return;
    }
    const valid = lines.filter((line) => line.product_id && line.batch_no.trim() && line.billed_qty > 0);
    if (valid.length === 0) {
      setBanner("Add at least one product line with batch number and quantity.");
      return;
    }
    for (const line of valid) {
      try {
        expiryKeyFromMmYy(line.expiry_mm_yy);
      } catch (error) {
        setBanner(`${line.product_name}: ${error instanceof Error ? error.message : "invalid expiry"}`);
        return;
      }
      if (line.p_rate_scaled <= 0) {
        setBanner(`${line.product_name}: purchase rate must be greater than zero.`);
        return;
      }
    }
    setSaving(true);
    try {
      const request: PurchaseSaveRequest = {
        supplier_id: supplier.id,
        sup_inv_no: supInvNo || null,
        inv_date_display: dateDisplay,
        godown_id: godownId || null,
        payment_mode: paymentMode,
        freight_scaled: freight,
        oth_adj_scaled: othAdj,
        paid_amt_scaled: paid,
        remarks: remarks || null,
        items: valid.map<PurchaseItemRequest>((line) => ({
          product_id: line.product_id,
          batch_no: line.batch_no.trim().toUpperCase(),
          expiry_mm_yy: line.expiry_mm_yy,
          billed_qty: line.billed_qty,
          free_deal_qty: line.free_qty,
          deal_billed: line.deal_billed,
          deal_free: line.deal_free,
          mrp_scaled: line.mrp_scaled,
          p_rate_scaled: line.p_rate_scaled,
          dis_bps: line.dis_bps,
          tax_bps: line.tax_bps,
          s_rate_scaled: line.s_rate_scaled,
          t_rate_scaled: line.t_rate_scaled,
        })),
      };
      const detail = await api.savePurchase(request);
      setSavedId(detail.purchase.id);
      pushToast(`Purchase ${detail.purchase.sup_inv_no} saved · ₹${formatMoney(detail.purchase.grand_total_scaled)}`, "success");
      resetForm();
      loadRecent();
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setBanner(apiError?.message ?? "Unable to save purchase");
    } finally {
      setSaving(false);
    }
  }, [
    dateDisplay,
    freight,
    godownId,
    lines,
    loadRecent,
    othAdj,
    paid,
    paymentMode,
    pushToast,
    remarks,
    resetForm,
    supInvNo,
    supplier,
  ]);

  const { formRef, onKeyDown } = useKeyboardNav({
    windowId,
    onSave: save,
    onEscape: () => false,
    mode: () => "NEW",
    saveEnabled: true,
    editEnabled: false,
  });

  return (
    <FormShell
      windowId={windowId}
      title="Purchase Invoice"
      subtitle="Inward billing · provisional batches are promoted on save"
      mode="NEW"
      dirty={dirty}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={resetForm}>
            <RotateCcw size={12} /> New
          </Button>
          <Button variant="default" size="sm" onClick={() => openWindow("PURCHASE_IMPORT")}>
            <FileSpreadsheet size={12} /> Import file
          </Button>
          <Button variant="primary" size="sm" shortcut="Ctrl+S" onClick={save} disabled={saving}>
            <Save size={12} /> {saving ? "Saving…" : "Save purchase"}
          </Button>
        </>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <>
          <div className="flex items-center gap-3">
            <span>
              Lines: <span className="font-mono font-semibold">{lines.filter((line) => line.product_id).length}</span>
            </span>
            <span>
              Grand: <span className="font-mono font-semibold">₹{formatMoney(grand)}</span>
            </span>
            <span>
              Due: <span className="font-mono font-semibold text-crimson">₹{formatMoney(due)}</span>
            </span>
            {savedId ? <Badge tone="success">last saved</Badge> : <Badge tone="warning">unsaved</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <Kbd>Tab</Kbd> next
            <Kbd>Ctrl+S</Kbd> save
          </div>
        </>
      }
    >
      <div ref={formRef} onKeyDown={onKeyDown} data-window={windowId} className="space-y-3">
        <Panel title="Inward header">
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 md:grid-cols-12">
            <Field label="Supplier" required className="md:col-span-4">
              <PartyLookup
                accountType="SUPPLIER"
                query={supplierQuery}
                onQueryChange={(value) => {
                  setSupplierQuery(value);
                  setSupplier(null);
                  markDirty(true);
                }}
                onSelect={(account) => {
                  setSupplier(account);
                  setSupplierQuery(account.name);
                  markDirty(true);
                }}
                navIndex={1}
              />
            </Field>
            <Field label="Supplier Inv. No" className="md:col-span-2">
              <TextInput
                value={supInvNo}
                data-nav-index={2}
                onChange={(event) => {
                  setSupInvNo(event.target.value.toUpperCase());
                  markDirty(true);
                }}
              />
            </Field>
            <Field label="Date" className="md:col-span-2">
              <TextInput
                mono
                value={dateDisplay}
                data-nav-index={3}
                onChange={(event) => {
                  setDateDisplay(event.target.value);
                  markDirty(true);
                }}
              />
            </Field>
            <Field label="Godown" className="md:col-span-2">
              <Select value={godownId} data-nav-index={4} onChange={(event) => setGodownId(event.target.value)}>
                {lookups.godowns.map((godown) => (
                  <option key={godown.id} value={godown.id}>
                    {godown.code} · {godown.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Mode" className="md:col-span-2">
              <Select
                value={paymentMode}
                data-nav-index={5}
                onChange={(event) => setPaymentMode(event.target.value as "CASH" | "CREDIT")}
              >
                <option value="CREDIT">CREDIT</option>
                <option value="CASH">CASH</option>
              </Select>
            </Field>
            <Field label="Remarks" className="md:col-span-12">
              <TextInput
                value={remarks}
                data-nav-index={6}
                onChange={(event) => {
                  setRemarks(event.target.value);
                  markDirty(true);
                }}
              />
            </Field>
          </div>

          {supplier ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-[3px] border border-line/70 bg-skybg/40 px-3 py-1.5 text-[10px]">
              <span className="font-semibold">{supplier.name}</span>
              <span className="text-inkmut">{supplier.city}</span>
              <span className="font-mono text-[9.5px]">{supplier.gst_no}</span>
              <span className="ml-auto">
                Payable:{" "}
                <span className="font-mono font-semibold text-crimson">₹{formatMoney(Math.abs(supplier.cur_bal_scaled))}</span>
              </span>
            </div>
          ) : null}
        </Panel>

        <Panel
          title="Inward lines"
          subtitle="Batch number + expiry are the reconciliation key; an existing provisional batch is merged"
          right={
            <Button variant="default" size="xs" onClick={addLine}>
              <Plus size={11} /> Add line
            </Button>
          }
          bodyClassName="p-0"
        >
          <div className="max-h-[400px] overflow-auto">
            <table className="w-full min-w-[1280px] text-[11px]">
              <thead>
                <tr className="sticky top-0 z-10 border-b border-line bg-parchment text-[8.5px] uppercase tracking-[0.08em] text-inkmut">
                  <th className="w-[30px] px-1 py-1.5 text-center">#</th>
                  <th className="w-[230px] px-2 py-1.5 text-left">Product</th>
                  <th className="w-[130px] px-2 py-1.5 text-left">Batch no</th>
                  <th className="w-[70px] px-2 py-1.5 text-left">Expiry</th>
                  <th className="w-[58px] px-2 py-1.5 text-right">Qty</th>
                  <th className="w-[54px] px-2 py-1.5 text-right">Free</th>
                  <th className="w-[64px] px-2 py-1.5 text-center">Deal</th>
                  <th className="w-[80px] px-2 py-1.5 text-right">P.Rate</th>
                  <th className="w-[55px] px-2 py-1.5 text-right">Dis%</th>
                  <th className="w-[55px] px-2 py-1.5 text-right">GST%</th>
                  <th className="w-[80px] px-2 py-1.5 text-right">MRP</th>
                  <th className="w-[80px] px-2 py-1.5 text-right">NetRate</th>
                  <th className="w-[88px] px-2 py-1.5 text-right">Amount</th>
                  <th className="w-[30px]" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const calc = lineTotals[index];
                  return (
                    <tr key={line.key} className="border-b border-line/45 bg-white">
                      <td className="px-1 py-1 text-center font-mono text-[9.5px] text-inkmut">{index + 1}</td>
                      <td className="px-2 py-1 align-top">
                        <div className="relative">
                          <ProductCell
                            line={line}
                            navIndex={300 + index * 14}
                            onQueryChange={(value) =>
                              updateLine(index, {
                                product_name: value,
                                product_id: "",
                                batch_no: line.batch_no,
                              })
                            }
                            onSelectProduct={(product) =>
                              updateLine(index, {
                                product_id: product.id,
                                product_name: product.name,
                                company_name: product.company_name ?? "",
                                pack_form: product.pack_form,
                                mrp_scaled: product.mrp_scaled ?? 0,
                                p_rate_scaled: product.p_rate_scaled ?? 0,
                                s_rate_scaled: product.s_rate_scaled ?? 0,
                                t_rate_scaled: product.t_rate_scaled ?? 0,
                                tax_bps: product.pur_tax_bps ?? 0,
                              })
                            }
                          />
                        </div>
                        <div className="mt-0.5 truncate text-[8.5px] text-inkmut">
                          {line.company_name} {line.pack_form ? `· ${line.pack_form}` : ""}
                        </div>
                      </td>
                      <td className="px-2 py-1 align-top">
                        <TextInput
                          mono
                          value={line.batch_no}
                          data-nav-index={300 + index * 14 + 1}
                          className="h-7 px-1.5 uppercase"
                          onChange={(event) => updateLine(index, { batch_no: event.target.value.toUpperCase() })}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <TextInput
                          mono
                          value={line.expiry_mm_yy}
                          data-nav-index={300 + index * 14 + 2}
                          className="h-7 px-1.5"
                          onChange={(event) => updateLine(index, { expiry_mm_yy: event.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <TextInput
                          mono
                          type="number"
                          min={1}
                          align="right"
                          value={line.billed_qty}
                          data-nav-index={300 + index * 14 + 3}
                          className="h-7 px-1.5"
                          onChange={(event) => updateLine(index, { billed_qty: Number(event.target.value) })}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <TextInput
                          mono
                          type="number"
                          min={0}
                          align="right"
                          value={line.free_qty}
                          data-nav-index={300 + index * 14 + 4}
                          className="h-7 px-1.5"
                          onChange={(event) => updateLine(index, { free_qty: Number(event.target.value) })}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <TextInput
                          mono
                          align="center"
                          value={line.deal_billed > 0 ? `${line.deal_billed}+${line.deal_free}` : ""}
                          placeholder="10+4"
                          data-nav-index={300 + index * 14 + 5}
                          className="h-7 px-1 text-[10px]"
                          onChange={(event) => {
                            const parsed = parseDeal(event.target.value);
                            updateLine(index, { deal_billed: parsed.billed, deal_free: parsed.free });
                          }}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <ScaledInput
                          value={line.p_rate_scaled}
                          onValueChange={(value) => updateLine(index, { p_rate_scaled: value })}
                          navIndex={300 + index * 14 + 6}
                          className="h-7 px-1.5"
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <TextInput
                          mono
                          align="right"
                          value={line.dis_bps ? line.dis_bps / 100 : ""}
                          data-nav-index={300 + index * 14 + 7}
                          className="h-7 px-1.5"
                          onChange={(event) =>
                            updateLine(index, { dis_bps: Math.round((Number(event.target.value) || 0) * 100) })
                          }
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <Select
                          value={String(line.tax_bps)}
                          data-nav-index={300 + index * 14 + 8}
                          className="h-7 px-1 text-[10px]"
                          onChange={(event) => updateLine(index, { tax_bps: Number(event.target.value) })}
                        >
                          {lookups.taxPlans.map((plan) => (
                            <option key={plan.id} value={plan.total_bps ?? 0}>
                              {((plan.total_bps ?? 0) / 100).toFixed(0)}%
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-2 py-1 align-top">
                        <ScaledInput
                          value={line.mrp_scaled}
                          onValueChange={(value) => updateLine(index, { mrp_scaled: value })}
                          navIndex={300 + index * 14 + 9}
                          className="h-7 px-1.5"
                        />
                      </td>
                      <td className="px-2 py-1 text-right align-top">
                        <div className="flex h-7 items-center justify-end font-mono text-[10px] text-teal">
                          {formatRate4(calc?.netRate ?? 0)}
                        </div>
                      </td>
                      <td className="px-2 py-1 text-right align-top">
                        <div className="flex h-7 items-center justify-end font-mono text-[10.5px] font-semibold">
                          {formatMoney(calc?.amount ?? 0)}
                        </div>
                      </td>
                      <td className="px-1 py-1 text-center align-top">
                        <button type="button" onClick={() => removeLine(index)} className="mt-1 text-inkmut/60 hover:text-crimson">
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-amberbg/30 px-3 py-1.5 text-[9.5px] text-[#7c5210]">
            <PackagePlus size={12} />
            If this batch was created as provisional during billing, saving merges the inward quantity and clears the
            provisional flag instead of duplicating the lot.
          </div>
        </Panel>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Panel title="Recent inward" bodyClassName="p-0">
            <div className="max-h-[200px] overflow-auto">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th className="text-left">Supplier inv</th>
                    <th className="text-left">Date</th>
                    <th className="text-left">Supplier</th>
                    <th className="text-right">Amount</th>
                    <th className="text-right">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-5 text-center text-[10.5px] text-inkmut">
                        No purchases recorded yet.
                      </td>
                    </tr>
                  ) : (
                    recent.map((purchase) => (
                      <tr key={purchase.id}>
                        <td className="font-mono font-semibold">{purchase.sup_inv_no}</td>
                        <td className="font-mono text-[10px]">{purchase.inv_date_display}</td>
                        <td className="max-w-[220px] truncate">{purchase.supplier_name_snapshot}</td>
                        <td className="text-right font-mono">₹{formatMoney(purchase.grand_total_scaled)}</td>
                        <td className={cx("text-right font-mono", purchase.due_amt_scaled > 0 && "text-crimson")}>
                          ₹{formatMoney(purchase.due_amt_scaled)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Purchase totals" bodyClassName="space-y-1">
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">Gross</span>
              <span className="font-mono">₹{formatMoney(totalGross)}</span>
            </div>
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">Discount</span>
              <span className="font-mono text-crimson">−₹{formatMoney(totalDis)}</span>
            </div>
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">GST</span>
              <span className="font-mono">₹{formatMoney(totalTax)}</span>
            </div>
            <div className="flex items-center gap-4 border-y border-line/60 py-1">
              <label className="flex items-center gap-1.5">
                <span className="text-[8.5px] font-semibold uppercase tracking-[0.1em] text-inkmut">Freight</span>
                <ScaledInput value={freight} onValueChange={(value) => { setFreight(value); markDirty(true); }} navIndex={7} className="h-6 w-[86px] px-1.5 text-[10.5px]" />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-[8.5px] font-semibold uppercase tracking-[0.1em] text-inkmut">Other</span>
                <ScaledInput value={othAdj} onValueChange={(value) => { setOthAdj(value); markDirty(true); }} navIndex={8} className="h-6 w-[86px] px-1.5 text-[10.5px]" />
              </label>
            </div>
            <div className="flex justify-between text-[10.5px]">
              <span className="text-inkmut">Round off</span>
              <span className="font-mono">{formatMoney(roundoff)}</span>
            </div>
            <div className="flex items-baseline justify-between rounded-[3px] bg-navy px-2 py-1.5 text-white">
              <span className="text-[9px] font-bold uppercase tracking-[0.14em]">Grand total</span>
              <span className="font-mono text-[18px] font-bold">₹{formatMoney(grand)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-inkmut">Paid</span>
              <ScaledInput
                value={paymentMode === "CASH" ? grand : paid}
                onValueChange={(value) => { setPaid(value); markDirty(true); }}
                readOnly={paymentMode === "CASH"}
                navIndex={9}
                className="h-6 w-[110px] px-1.5 text-[10.5px]"
              />
            </div>
            <div className="flex justify-between text-[11px] font-semibold">
              <span>Balance due</span>
              <span className="font-mono text-crimson">₹{formatMoney(due)}</span>
            </div>
          </Panel>
        </div>
      </div>
    </FormShell>
  );
}

function ProductCell({
  line,
  navIndex,
  onQueryChange,
  onSelectProduct,
}: {
  line: PurchaseLine;
  navIndex: number;
  onQueryChange: (value: string) => void;
  onSelectProduct: (product: {
    id: string;
    name: string;
    company_name?: string | null;
    pack_form: string;
    mrp_scaled?: number;
    p_rate_scaled?: number;
    s_rate_scaled?: number;
    t_rate_scaled?: number;
    pur_tax_bps?: number;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Array<{
    id: string;
    name: string;
    company_name?: string | null;
    pack_form: string;
    mrp_scaled?: number;
    p_rate_scaled?: number;
    s_rate_scaled?: number;
    t_rate_scaled?: number;
    pur_tax_bps?: number;
    total_cur_qty?: number;
  }>>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .searchProducts({ query: line.product_name, limit: 15 })
        .then((response) => {
          if (!cancelled) setResults(response.items);
        })
        .catch(() => undefined);
    }, 90);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [line.product_name, open]);

  return (
    <div className="relative">
      <TextInput
        value={line.product_name}
        data-nav-index={navIndex}
        placeholder="Product…"
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 130)}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setOpen(true);
        }}
      />
      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1 max-h-[240px] w-[330px] overflow-auto rounded-[3px] border border-line bg-white shadow-pop">
          {results.length === 0 ? (
            <div className="px-2 py-3 text-[10px] text-inkmut">No products found.</div>
          ) : (
            results.map((product) => (
              <button
                key={product.id}
                type="button"
                className="block w-full border-b border-line/40 px-2 py-1 text-left text-[10.5px] last:border-0 hover:bg-skybg"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelectProduct(product);
                  setOpen(false);
                }}
              >
                <span className="font-semibold">{product.name}</span>
                <span className="ml-2 text-[9px] text-inkmut">
                  {product.company_name} · {product.pack_form}
                </span>
                <span className="float-right font-mono text-[9px] text-inkmut">P {formatMoney(product.p_rate_scaled ?? 0)}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
