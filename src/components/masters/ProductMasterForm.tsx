import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Plus, RotateCcw, Save, Search } from "lucide-react";
import { api, ApiError } from "../../lib/invoke";
import type { Batch, Product, ProductDetail } from "../../types/database";
import type { BatchInput, ProductSaveRequest } from "../../types/ipc";
import {
  addMonthsToKey,
  currentExpiryKey,
  expiryKeyFromMmYy,
  formatMoney,
  formatRate4,
} from "../../lib/format";
import { calcNetRate } from "../../lib/math";
import { useLookups } from "../../hooks/useLookups";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useToastStore } from "../../stores/useToastStore";
import { Badge, Button, Field, Kbd, Panel, ScaledInput, Select, TextInput, Banner, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";
import { ProductLookup } from "../ui/lookups";

interface WindowProps {
  windowId: string;
  payload: Record<string, unknown>;
}

interface ProductForm {
  id: string | null;
  pro_code: number;
  name: string;
  group_id: string;
  company_id: string | null;
  company_name: string;
  composition_id: string | null;
  composition_desc: string;
  pack_unit: number;
  pack_subunit: number;
  pack_form: string;
  case_box_qty: number;
  hsn_code: string;
  drug_schedule: string;
  pur_tax_id: string;
  sale_tax_id: string;
  tin_tax_id: string;
  tout_tax_id: string;
  min_qty: number;
  max_qty: number;
  weight_grams: number;
}

interface EditableBatch {
  key: string;
  id?: string;
  batch_no: string;
  expiry_mm_yy: string;
  op_qty: number;
  cur_qty: number;
  tax_stock_qty: number;
  deal_billed: number;
  deal_free: number;
  mrp_scaled: number;
  s_rate_scaled: number;
  t_rate_scaled: number;
  p_rate_scaled: number;
  dis_bps: number;
  godown_id: string;
  is_provisional: number;
}

let rowCounter = 0;
const nextKey = () => {
  rowCounter += 1;
  return `row-${Date.now()}-${rowCounter}`;
};

function blankForm(taxId: string): ProductForm {
  return {
    id: null,
    pro_code: 0,
    name: "",
    group_id: "",
    company_id: null,
    company_name: "",
    composition_id: null,
    composition_desc: "",
    pack_unit: 1,
    pack_subunit: 10,
    pack_form: "TAB",
    case_box_qty: 1,
    hsn_code: "",
    drug_schedule: "OTC",
    pur_tax_id: taxId,
    sale_tax_id: taxId,
    tin_tax_id: taxId,
    tout_tax_id: taxId,
    min_qty: 10,
    max_qty: 100,
    weight_grams: 0,
  };
}

function formFromProduct(product: Product): ProductForm {
  return {
    id: product.id,
    pro_code: product.pro_code,
    name: product.name,
    group_id: product.group_id ?? "",
    company_id: product.company_id,
    company_name: product.company_name ?? "",
    composition_id: product.composition_id,
    composition_desc: product.composition_desc ?? "",
    pack_unit: product.pack_unit,
    pack_subunit: product.pack_subunit,
    pack_form: product.pack_form,
    case_box_qty: product.case_box_qty,
    hsn_code: product.hsn_code ?? "",
    drug_schedule: product.drug_schedule,
    pur_tax_id: product.pur_tax_id ?? "",
    sale_tax_id: product.sale_tax_id ?? "",
    tin_tax_id: product.tin_tax_id ?? "",
    tout_tax_id: product.tout_tax_id ?? "",
    min_qty: product.min_qty,
    max_qty: product.max_qty,
    weight_grams: product.weight_grams,
  };
}

function batchFromRow(batch: Batch): EditableBatch {
  return {
    key: batch.id,
    id: batch.id,
    batch_no: batch.batch_no,
    expiry_mm_yy: batch.expiry_mm_yy,
    op_qty: batch.op_qty,
    cur_qty: batch.cur_qty,
    tax_stock_qty: batch.tax_stock_qty,
    deal_billed: batch.deal_billed,
    deal_free: batch.deal_free,
    mrp_scaled: batch.mrp_scaled,
    s_rate_scaled: batch.s_rate_scaled,
    t_rate_scaled: batch.t_rate_scaled,
    p_rate_scaled: batch.p_rate_scaled,
    dis_bps: batch.dis_bps,
    godown_id: batch.godown_id,
    is_provisional: batch.is_provisional,
  };
}

function blankBatch(godownId: string): EditableBatch {
  const expiry = addMonthsToKey(currentExpiryKey(), 12);
  return {
    key: nextKey(),
    batch_no: "",
    expiry_mm_yy: `${String(expiry % 100).padStart(2, "0")}/${String(Math.floor(expiry / 100) % 100).padStart(2, "0")}`,
    op_qty: 0,
    cur_qty: 0,
    tax_stock_qty: 0,
    deal_billed: 0,
    deal_free: 0,
    mrp_scaled: 0,
    s_rate_scaled: 0,
    t_rate_scaled: 0,
    p_rate_scaled: 0,
    dis_bps: 0,
    godown_id: godownId,
    is_provisional: 0,
  };
}

function parseDeal(text: string): { billed: number; free: number } {
  const match = text.match(/(\d+)\s*\+\s*(\d+)/);
  if (match) return { billed: Number(match[1]), free: Number(match[2]) };
  const single = text.match(/^\s*(\d+)\s*$/);
  if (single) return { billed: Number(single[1]), free: 0 };
  return { billed: 0, free: 0 };
}

export function ProductMasterForm({ windowId, payload }: WindowProps) {
  const { lookups, loading: lookupsLoading } = useLookups();
  const pushToast = useToastStore((state) => state.push);
  const setDirtyStore = useWorkspaceStore((state) => state.setDirty);
  const requestClose = useWorkspaceStore((state) => state.requestClose);

  const defaultTaxId = useMemo(() => {
    return lookups.taxPlans.find((plan) => plan.name === "GST-12")?.id ?? lookups.taxPlans[0]?.id ?? "";
  }, [lookups.taxPlans]);
  const defaultGodownId = useMemo(() => {
    return lookups.godowns.find((godown) => godown.is_default === 1)?.id ?? lookups.godowns[0]?.id ?? "";
  }, [lookups.godowns]);

  const [mode, setMode] = useState<"VIEW" | "EDIT" | "NEW">("VIEW");
  const [form, setForm] = useState<ProductForm>(() => blankForm(""));
  const [batches, setBatches] = useState<EditableBatch[]>([]);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState({ found: 0, total: 0, elapsed: 0 });
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const payloadProCode = Number(payload.pro_code ?? 0);
  const payloadId = String(payload.id ?? "");
  const payloadBatchId = String(payload.batch_id ?? "");

  const markDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      setDirtyStore(windowId, value);
    },
    [setDirtyStore, windowId],
  );

  const readOnly = mode === "VIEW";

  const purTaxBps = useMemo(() => {
    return lookups.taxPlans.find((plan) => plan.id === form.pur_tax_id)?.total_bps ?? 0;
  }, [lookups.taxPlans, form.pur_tax_id]);

  const loadProduct = useCallback(
    async (request: { id?: string; pro_code?: number }) => {
      setLoading(true);
      setBanner(null);
      try {
        const response = await api.getProduct(request);
        setDetail(response);
        setForm(formFromProduct(response.product));
        setBatches(response.batches.map(batchFromRow));
        setQuery(response.product.name);
        setMode("VIEW");
        setFieldErrors({});
        markDirty(false);
      } catch (error) {
        setBanner(error instanceof Error ? error.message : "Unable to load product");
      } finally {
        setLoading(false);
      }
    },
    [markDirty],
  );

  useEffect(() => {
    if (payloadProCode || payloadId) {
      loadProduct({ pro_code: payloadProCode || undefined, id: payloadId || undefined });
    } else if (payload.focus_search) {
      searchRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadProCode, payloadId]);

  useEffect(() => {
    if (!form.pur_tax_id && defaultTaxId && mode !== "VIEW") {
      setForm((current) => ({
        ...current,
        pur_tax_id: defaultTaxId,
        sale_tax_id: current.sale_tax_id || defaultTaxId,
        tin_tax_id: current.tin_tax_id || defaultTaxId,
        tout_tax_id: current.tout_tax_id || defaultTaxId,
      }));
    }
  }, [defaultTaxId, form.pur_tax_id, mode]);

  useEffect(() => {
    if (payloadBatchId && batches.length) {
      const element = document.querySelector<HTMLElement>(`[data-batch="${payloadBatchId}"]`);
      element?.scrollIntoView({ block: "center" });
    }
  }, [payloadBatchId, batches.length]);

  const unlock = useCallback(() => {
    if (!form.id) return;
    setMode("EDIT");
    window.setTimeout(() => searchRef.current?.focus(), 20);
  }, [form.id]);

  const update = (patch: Partial<ProductForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    markDirty(true);
  };

  const updateBatch = (index: number, patch: Partial<EditableBatch>) => {
    setBatches((current) => current.map((batch, position) => (position === index ? { ...batch, ...patch } : batch)));
    markDirty(true);
  };

  const addBatch = () => {
    setBatches((current) => [...current, blankBatch(defaultGodownId)]);
    markDirty(true);
  };

  const save = useCallback(async () => {
    setBanner(null);
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = "Product name is required.";
    if (form.pack_unit <= 0 || form.pack_subunit <= 0) errors.pack_unit = "Pack size must be positive.";
    if (form.pack_form.trim() === "") errors.pack_form = "Choose a pack form.";
    batches.forEach((batch, index) => {
      if (!batch.batch_no.trim()) errors[`batch_${index}`] = "Batch number is required.";
      try {
        expiryKeyFromMmYy(batch.expiry_mm_yy);
      } catch (error) {
        errors[`expiry_${index}`] = error instanceof Error ? error.message : "Invalid expiry";
      }
      if (batch.mrp_scaled < 0 || batch.s_rate_scaled < 0 || batch.p_rate_scaled < 0) {
        errors[`rate_${index}`] = "Rates cannot be negative.";
      }
    });
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setBanner("Please fix the highlighted fields before saving.");
      return;
    }
    setSaving(true);
    try {
      const payloadBatches: BatchInput[] = batches.map((batch) => ({
        id: batch.id ?? null,
        batch_no: batch.batch_no.trim().toUpperCase(),
        expiry_mm_yy: batch.expiry_mm_yy,
        op_qty: batch.op_qty,
        deal_billed: batch.deal_billed,
        deal_free: batch.deal_free,
        cur_qty: batch.cur_qty,
        tax_stock_qty: batch.tax_stock_qty,
        mrp_scaled: batch.mrp_scaled,
        s_rate_scaled: batch.s_rate_scaled,
        t_rate_scaled: batch.t_rate_scaled,
        p_rate_scaled: batch.p_rate_scaled,
        dis_bps: batch.dis_bps,
        godown_id: batch.godown_id || defaultGodownId,
        is_provisional: batch.is_provisional === 1,
      }));
      const request: ProductSaveRequest = {
        id: form.id,
        pro_code: form.pro_code || null,
        name: form.name.trim(),
        group_id: form.group_id || null,
        company_id: form.company_id,
        company_name: form.company_name.trim() || null,
        composition_id: form.composition_id,
        composition_desc: form.composition_desc.trim() || null,
        pack_unit: form.pack_unit,
        pack_subunit: form.pack_subunit,
        pack_form: form.pack_form,
        case_box_qty: form.case_box_qty,
        hsn_code: form.hsn_code.trim() || null,
        drug_schedule: form.drug_schedule,
        pur_tax_id: form.pur_tax_id || null,
        sale_tax_id: form.sale_tax_id || null,
        tin_tax_id: form.tin_tax_id || null,
        tout_tax_id: form.tout_tax_id || null,
        min_qty: form.min_qty,
        max_qty: form.max_qty,
        weight_grams: form.weight_grams,
        batches: payloadBatches,
      };
      const saved = await api.saveProduct(request);
      const refreshed = await api.getProduct({ id: saved.product.id });
      setDetail(refreshed);
      setForm(formFromProduct(refreshed.product));
      setBatches(refreshed.batches.map(batchFromRow));
      setQuery(refreshed.product.name);
      setMode("VIEW");
      markDirty(false);
      setFieldErrors({});
      pushToast(`Saved ${refreshed.product.name}`, "success");
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setBanner(apiError?.message ?? "Unable to save product");
      if (apiError?.field) setFieldErrors({ [apiError.field]: apiError.message });
    } finally {
      setSaving(false);
    }
  }, [batches, defaultGodownId, form, markDirty, pushToast]);

  const newProduct = useCallback(async () => {
    try {
      const next = await api.nextProductCode();
      setForm({ ...blankForm(defaultTaxId), pro_code: next.pro_code });
      setBatches(defaultGodownId ? [blankBatch(defaultGodownId)] : []);
      setDetail(null);
      setQuery("");
      setMode("NEW");
      setBanner(null);
      setFieldErrors({});
      markDirty(false);
      window.setTimeout(() => {
        document.querySelector<HTMLElement>(`[data-window="${windowId}"] [data-nav-index="2"]`)?.focus();
      }, 30);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to start a new product");
    }
  }, [defaultGodownId, defaultTaxId, markDirty]);

  const cancel = () => {
    if (mode === "NEW") {
      requestClose(windowId);
      return;
    }
    if (detail) {
      setForm(formFromProduct(detail.product));
      setBatches(detail.batches.map(batchFromRow));
      setMode("VIEW");
      setFieldErrors({});
      setBanner(null);
      markDirty(false);
    }
  };

  const { formRef, onKeyDown } = useKeyboardNav({
    windowId,
    onSave: save,
    onUnlockEdit: unlock,
    onEscape: () => false,
    mode: () => mode,
    saveEnabled: mode !== "VIEW",
    editEnabled: mode === "VIEW" && Boolean(form.id),
  });

  const packLabel = `${form.pack_unit} x ${form.pack_subunit} ${form.pack_form}`.trim();
  const totalCur = batches.reduce((sum, batch) => sum + batch.cur_qty, 0);
  const totalTax = batches.reduce((sum, batch) => sum + batch.tax_stock_qty, 0);
  const stockValue = batches.reduce((sum, batch) => sum + batch.cur_qty * batch.p_rate_scaled, 0);

  return (
    <FormShell
      windowId={windowId}
      title={mode === "NEW" ? "New Product" : form.name || "Product Master"}
      subtitle={
        form.id
          ? `Pro. Code ${form.pro_code} · ${packLabel} · ${batches.length} batch${batches.length === 1 ? "" : "es"}`
          : "Search the catalogue or create a new SKU"
      }
      mode={mode}
      dirty={dirty}
      actions={
        mode === "VIEW" ? (
          <Button variant="primary" size="sm" shortcut="Ctrl+E" onClick={unlock} disabled={!form.id}>
            Edit
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={cancel}>
              <RotateCcw size={12} /> Cancel
            </Button>
            <Button variant="primary" size="sm" shortcut="Ctrl+S" onClick={save} disabled={saving}>
              <Save size={12} /> {saving ? "Saving…" : "Save"}
            </Button>
          </>
        )
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <>
          <div className="flex items-center gap-3">
            <span>
              Stock: <span className={cx("font-mono font-semibold", totalCur < 0 ? "text-crimson" : "text-ink")}>{totalCur}</span>
            </span>
            <span>
              GST stock: <span className="font-mono font-semibold">{totalTax}</span>
            </span>
            <span>
              Value: <span className="font-mono font-semibold">₹{formatMoney(stockValue)}</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <Kbd>Enter</Kbd> next
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Ctrl+E</Kbd> unlock
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd> close
            </span>
          </div>
        </>
      }
    >
      <div ref={formRef} onKeyDown={onKeyDown} data-window={windowId} className="space-y-3">
        <div className="flex flex-wrap items-end gap-3 rounded-[4px] border border-line bg-white/60 px-3 py-2">
          <div className="w-[430px] max-w-full">
            <Field
              label={
                <span className="flex items-center gap-1">
                  <Search size={10} /> Find product
                </span>
              }
              right={
                <span className="font-mono text-[9px] normal-case tracking-normal text-inkmut">
                  Matches Found: <span className="font-semibold text-ink">{stats.found}</span> / {stats.total} ·{" "}
                  {stats.elapsed.toFixed(1)} ms
                </span>
              }
            >
              <ProductLookup
                query={query}
                onQueryChange={setQuery}
                onSelect={(product) => {
                  void loadProduct({ id: product.id });
                }}
                onStats={(found, total, elapsed) => setStats({ found, total, elapsed })}
                alwaysSearch
                autoFocus
                navIndex={1}
                inputRef={searchRef}
                onEscape={() => searchRef.current?.blur()}
              />
            </Field>
          </div>
          <div className="flex items-center gap-2 pb-0.5">
            <Button variant="default" size="sm" onClick={newProduct}>
              <Plus size={12} /> New Product
            </Button>
            <span className="flex items-center gap-1 text-[9.5px] text-inkmut">
              <Kbd>Ctrl</Kbd>
              <Kbd>E</Kbd> edits instantly
            </span>
            {loading ? <Badge tone="info">Loading…</Badge> : null}
            {detail ? <Badge tone="success">{detail.stats.batch_count} batches on file</Badge> : null}
          </div>
        </div>

        <Panel title="Product identity" subtitle="Header attributes exactly as printed on the master" bodyClassName="space-y-3">
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 md:grid-cols-3">
            <Field label="Name" required error={fieldErrors.name} className="md:col-span-3">
              <TextInput
                value={form.name}
                readOnly={readOnly}
                data-nav-index={2}
                className="uppercase"
                onChange={(event) => update({ name: event.target.value.toUpperCase() })}
              />
            </Field>
            <Field label="Group">
              <Select
                value={form.group_id}
                disabled={readOnly}
                data-nav-index={3}
                onChange={(event) => update({ group_id: event.target.value })}
              >
                <option value="">— none —</option>
                {lookups.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Pro. Code">
              <TextInput
                mono
                type="number"
                value={form.pro_code || ""}
                readOnly={readOnly}
                data-nav-index={4}
                onChange={(event) => update({ pro_code: Number(event.target.value) })}
              />
            </Field>
            <Field label="Pack size" error={fieldErrors.pack_unit} hint="Unit × subunit + pack form">
              <div className="flex items-center gap-1">
                <TextInput
                  mono
                  type="number"
                  min={1}
                  value={form.pack_unit}
                  readOnly={readOnly}
                  data-nav-index={5}
                  onChange={(event) => update({ pack_unit: Number(event.target.value) })}
                />
                <span className="text-[10px] text-inkmut">×</span>
                <TextInput
                  mono
                  type="number"
                  min={1}
                  value={form.pack_subunit}
                  readOnly={readOnly}
                  data-nav-index={6}
                  onChange={(event) => update({ pack_subunit: Number(event.target.value) })}
                />
                <Select
                  value={form.pack_form}
                  disabled={readOnly}
                  data-nav-index={7}
                  className="w-[86px]"
                  onChange={(event) => update({ pack_form: event.target.value })}
                >
                  {lookups.packForms.map((pack) => (
                    <option key={pack.code} value={pack.code}>
                      {pack.code}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            <Field label="C/B (case box qty)">
              <TextInput
                mono
                type="number"
                min={1}
                value={form.case_box_qty}
                readOnly={readOnly}
                data-nav-index={8}
                onChange={(event) => update({ case_box_qty: Number(event.target.value) || 1 })}
              />
            </Field>
            <Field label="Company">
              <TextInput
                list="saltbook-companies"
                value={form.company_name}
                readOnly={readOnly}
                data-nav-index={9}
                onChange={(event) =>
                  update({ company_name: event.target.value.toUpperCase(), company_id: null })
                }
              />
              <datalist id="saltbook-companies">
                {lookups.companies.map((company) => (
                  <option key={company.id} value={company.name} />
                ))}
              </datalist>
            </Field>
            <Field label="HSN code">
              <TextInput
                mono
                value={form.hsn_code}
                readOnly={readOnly}
                data-nav-index={10}
                onChange={(event) => update({ hsn_code: event.target.value })}
              />
            </Field>
            <Field label="Composition" className="md:col-span-2">
              <TextInput
                list="saltbook-compositions"
                value={form.composition_desc}
                readOnly={readOnly}
                data-nav-index={11}
                onChange={(event) =>
                  update({ composition_desc: event.target.value, composition_id: null })
                }
              />
              <datalist id="saltbook-compositions">
                {lookups.compositions.map((composition) => (
                  <option key={composition.id} value={composition.description ?? composition.name} />
                ))}
              </datalist>
            </Field>
            <Field label="Drug schedule">
              <Select
                value={form.drug_schedule}
                disabled={readOnly}
                data-nav-index={12}
                onChange={(event) => update({ drug_schedule: event.target.value })}
              >
                {lookups.schedules.map((schedule) => (
                  <option key={schedule.code} value={schedule.code}>
                    {schedule.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Panel>

        <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
          <Panel title="Tax mapping" subtitle="Purchase, sales, TIN (inward credit) and T.Out (outward trade)">
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  ["Pur Tax", "pur_tax_id", 13],
                  ["Sale Tax", "sale_tax_id", 14],
                  ["TIN Tax", "tin_tax_id", 15],
                  ["T. Out Tax", "tout_tax_id", 16],
                ] as const
              ).map(([label, key, navIndex]) => (
                <Field key={key} label={label}>
                  <Select
                    value={form[key]}
                    disabled={readOnly}
                    data-nav-index={navIndex}
                    onChange={(event) => update({ [key]: event.target.value } as Partial<ProductForm>)}
                  >
                    <option value="">— none —</option>
                    {lookups.taxPlans.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.name} · {((plan.total_bps ?? 0) / 100).toFixed(0)}%
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </Panel>

          <Panel title="Stock policy" subtitle="Reorder thresholds and handling weight">
            <div className="grid grid-cols-3 gap-2">
              <Field label="Min. Qty">
                <TextInput
                  mono
                  type="number"
                  value={form.min_qty}
                  readOnly={readOnly}
                  data-nav-index={17}
                  onChange={(event) => update({ min_qty: Number(event.target.value) })}
                />
              </Field>
              <Field label="Max. Qty">
                <TextInput
                  mono
                  type="number"
                  value={form.max_qty}
                  readOnly={readOnly}
                  data-nav-index={18}
                  onChange={(event) => update({ max_qty: Number(event.target.value) })}
                />
              </Field>
              <Field label="Weight (Kg)">
                <TextInput
                  mono
                  inputMode="decimal"
                  value={form.weight_grams ? (form.weight_grams / 1000).toString() : ""}
                  readOnly={readOnly}
                  data-nav-index={19}
                  onChange={(event) =>
                    update({ weight_grams: Math.round((Number(event.target.value) || 0) * 1000) })
                  }
                />
              </Field>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-line/70 pt-2 text-[10px] text-inkmut">
              <span>Reorder trigger</span>
              <span className="font-mono">{form.min_qty} units</span>
            </div>
          </Panel>
        </div>

        <Panel
          title="Batch grid"
          subtitle="12-column pricing and quantity register · FEFO sorted"
          right={
            mode !== "VIEW" ? (
              <Button variant="default" size="xs" onClick={addBatch}>
                <Plus size={11} /> Add batch
              </Button>
            ) : (
              <Badge tone="neutral">{batches.length} lots</Badge>
            )
          }
          bodyClassName="p-0"
        >
          <div className="max-h-[340px] overflow-auto">
            <table className="w-full min-w-[1180px] border-collapse text-[11px]">
              <thead>
                <tr className="bg-parchment text-[9px] uppercase tracking-[0.08em] text-inkmut">
                  <th className="sticky left-0 z-20 w-[132px] border-b border-line bg-parchment px-2 py-1.5 text-left">Batch</th>
                  <th className="sticky left-[132px] z-20 w-[74px] border-b border-line bg-parchment px-2 py-1.5 text-left">Expiry</th>
                  <th className="sticky left-[206px] z-20 w-[70px] border-b border-line bg-parchment px-2 py-1.5 text-right">CurQty</th>
                  <th className="w-[70px] border-b border-line px-2 py-1.5 text-right">Op.Qty</th>
                  <th className="w-[76px] border-b border-line px-2 py-1.5 text-center">Deal</th>
                  <th className="w-[84px] border-b border-line px-2 py-1.5 text-right">MRP</th>
                  <th className="w-[84px] border-b border-line px-2 py-1.5 text-right">S.Rate</th>
                  <th className="w-[84px] border-b border-line px-2 py-1.5 text-right">T.Rate</th>
                  <th className="w-[84px] border-b border-line px-2 py-1.5 text-right">P.Rate</th>
                  <th className="w-[64px] border-b border-line px-2 py-1.5 text-right">Dis%</th>
                  <th className="w-[86px] border-b border-line px-2 py-1.5 text-right">NetRate</th>
                  <th className="w-[78px] border-b border-line px-2 py-1.5 text-center">Gdn</th>
                </tr>
              </thead>
              <tbody>
                {batches.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-3 py-8 text-center text-[11px] text-inkmut">
                      <Boxes size={18} className="mx-auto mb-1 text-inkmut/40" />
                      No batches on this product yet.
                      {mode !== "VIEW" ? " Use “Add batch” to capture the first lot." : " Press Ctrl+E to add stock."}
                    </td>
                  </tr>
                ) : (
                  batches.map((batch, index) => {
                    const expiryKey = (() => {
                      try {
                        return expiryKeyFromMmYy(batch.expiry_mm_yy);
                      } catch {
                        return 0;
                      }
                    })();
                    const near = expiryKey > 0 && expiryKey <= addMonthsToKey(currentExpiryKey(), 3);
                    const negative = batch.cur_qty < 0;
                    const rowBg = negative ? "bg-crimsonbg" : near ? "bg-amberbg/70" : "bg-white";
                    const netRate = calcNetRate(
                      batch.p_rate_scaled,
                      batch.deal_billed,
                      batch.deal_free,
                      batch.dis_bps,
                      purTaxBps,
                    );
                    return (
                      <tr key={batch.key} data-batch={batch.id} className={cx("border-b border-line/50", rowBg)}>
                        <td className={cx("sticky left-0 z-10 px-2 py-1", negative ? "bg-crimsonbg" : near ? "bg-amberbg" : "bg-white")}>
                          {mode === "VIEW" ? (
                            <span className="font-mono text-[10.5px] font-semibold">{batch.batch_no}</span>
                          ) : (
                            <TextInput
                              mono
                              value={batch.batch_no}
                              data-nav-index={100 + index * 20}
                              className="h-6 px-1.5 text-[10.5px]"
                              onChange={(event) => updateBatch(index, { batch_no: event.target.value.toUpperCase() })}
                            />
                          )}
                          {batch.is_provisional === 1 ? <Badge tone="warning" className="ml-1">PROV</Badge> : null}
                        </td>
                        <td className={cx("sticky left-[132px] z-10 px-2 py-1", negative ? "bg-crimsonbg" : near ? "bg-amberbg" : "bg-white")}>
                          {mode === "VIEW" ? (
                            <span className="flex items-center gap-1">
                              <span className="font-mono text-[10.5px]">{batch.expiry_mm_yy}</span>
                              {near ? <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Within 3 months" /> : null}
                            </span>
                          ) : (
                            <TextInput
                              mono
                              value={batch.expiry_mm_yy}
                              data-nav-index={100 + index * 20 + 1}
                              className="h-6 px-1.5 text-[10.5px]"
                              onChange={(event) => updateBatch(index, { expiry_mm_yy: event.target.value })}
                            />
                          )}
                        </td>
                        <td className={cx("sticky left-[206px] z-10 px-2 py-1 text-right", negative ? "bg-crimsonbg" : near ? "bg-amberbg" : "bg-white")}>
                          {mode === "VIEW" ? (
                            <span className={cx("font-mono text-[11px] font-bold", negative ? "text-crimson" : "text-ink")}>
                              {batch.cur_qty}
                            </span>
                          ) : (
                            <TextInput
                              mono
                              type="number"
                              align="right"
                              value={batch.cur_qty}
                              data-nav-index={100 + index * 20 + 2}
                              className="h-6 px-1.5 text-[10.5px]"
                              onChange={(event) => updateBatch(index, { cur_qty: Number(event.target.value) })}
                            />
                          )}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {mode === "VIEW" ? (
                            <span className="font-mono text-[10.5px] text-inkmut">{batch.op_qty}</span>
                          ) : (
                            <TextInput
                              mono
                              type="number"
                              align="right"
                              value={batch.op_qty}
                              data-nav-index={100 + index * 20 + 3}
                              className="h-6 px-1.5 text-[10.5px]"
                              onChange={(event) => updateBatch(index, { op_qty: Number(event.target.value) })}
                            />
                          )}
                        </td>
                        <td className="px-2 py-1 text-center">
                          {mode === "VIEW" ? (
                            <span className="font-mono text-[10px] text-inkmut">
                              {batch.deal_billed > 0 ? `${batch.deal_billed}+${batch.deal_free}` : "—"}
                            </span>
                          ) : (
                            <TextInput
                              mono
                              align="center"
                              value={batch.deal_billed > 0 ? `${batch.deal_billed}+${batch.deal_free}` : ""}
                              placeholder="10+4"
                              data-nav-index={100 + index * 20 + 4}
                              className="h-6 px-1 text-center text-[10px]"
                              onChange={(event) => {
                                const parsed = parseDeal(event.target.value);
                                updateBatch(index, { deal_billed: parsed.billed, deal_free: parsed.free });
                              }}
                            />
                          )}
                        </td>
                        {(
                          [
                            ["mrp_scaled", 5],
                            ["s_rate_scaled", 6],
                            ["t_rate_scaled", 7],
                            ["p_rate_scaled", 8],
                          ] as const
                        ).map(([key, offset]) => (
                          <td key={key} className="px-2 py-1 text-right">
                            {mode === "VIEW" ? (
                              <span className="font-mono text-[10.5px]">{formatMoney(batch[key])}</span>
                            ) : (
                              <ScaledInput
                                value={batch[key]}
                                onValueChange={(value) => updateBatch(index, { [key]: value } as Partial<EditableBatch>)}
                                navIndex={100 + index * 20 + offset}
                                className="h-6 px-1.5 text-[10.5px]"
                              />
                            )}
                          </td>
                        ))}
                        <td className="px-2 py-1 text-right">
                          {mode === "VIEW" ? (
                            <span className="font-mono text-[10px]">{batch.dis_bps / 100}%</span>
                          ) : (
                            <TextInput
                              mono
                              align="right"
                              inputMode="decimal"
                              value={batch.dis_bps ? batch.dis_bps / 100 : ""}
                              data-nav-index={100 + index * 20 + 9}
                              className="h-6 px-1.5 text-[10.5px]"
                              onChange={(event) =>
                                updateBatch(index, {
                                  dis_bps: Math.round((Number(event.target.value) || 0) * 100),
                                })
                              }
                            />
                          )}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <span className="font-mono text-[10.5px] font-semibold text-teal">{formatRate4(netRate)}</span>
                        </td>
                        <td className="px-2 py-1 text-center">
                          {mode === "VIEW" ? (
                            <span className="font-mono text-[9.5px] uppercase text-inkmut">
                              {lookups.godowns.find((godown) => godown.id === batch.godown_id)?.code ?? "MAIN"}
                            </span>
                          ) : (
                            <Select
                              value={batch.godown_id}
                              data-nav-index={100 + index * 20 + 10}
                              className="h-6 px-1 text-[10px]"
                              onChange={(event) => updateBatch(index, { godown_id: event.target.value })}
                            >
                              {lookups.godowns.map((godown) => (
                                <option key={godown.id} value={godown.id}>
                                  {godown.code}
                                </option>
                              ))}
                            </Select>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-line bg-parchment/50 px-3 py-1.5 text-[9.5px] text-inkmut">
            <span>
              Crimson = negative stock · Amber = expiry within 3 months · NetRate includes purchase GST
            </span>
            <span className="font-mono">{lookupsLoading ? "loading lookups…" : "FEFO order by expiry"}</span>
          </div>
        </Panel>
      </div>
    </FormShell>
  );
}
