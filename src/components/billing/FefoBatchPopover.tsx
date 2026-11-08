import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CalendarClock, Plus, X } from "lucide-react";
import { api } from "../../lib/invoke";
import type { Batch } from "../../types/database";
import { formatMoney, formatRate4, parseScaled } from "../../lib/format";
import { addMonthsToKey, currentExpiryKey } from "../../lib/format";
import { Badge, Banner, Button, Field, Kbd, TextInput, cx } from "../ui/kit";

interface Props {
  productId: string;
  productName: string;
  billingOn: string;
  defaultQty: number;
  provisionalSignal: number;
  onSelect: (batch: Batch, rateScaled: number) => void;
  onClose: () => void;
  onSubstitutes: () => void;
}

function pickRate(batch: Batch, billingOn: string): number {
  if (billingOn === "MRP") return batch.mrp_scaled;
  if (billingOn === "T_RATE") return batch.t_rate_scaled;
  if (billingOn === "P_RATE") return batch.p_rate_scaled;
  return batch.s_rate_scaled;
}

export function FefoBatchPopover({
  productId,
  productName,
  billingOn,
  defaultQty,
  provisionalSignal,
  onSelect,
  onClose,
  onSubstitutes,
}: Props) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [provisionalOpen, setProvisionalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    batch_no: "",
    expiry_mm_yy: "",
    mrp: "",
    rate: "",
    qty: Math.max(1, defaultQty),
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .fefoBatches({ product_id: productId })
      .then((response) => {
        if (cancelled) return;
        setBatches(response.items);
        setActive(0);
        setError(null);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load batches");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  useEffect(() => {
    if (provisionalSignal > 0) {
      setProvisionalOpen(true);
      const expiry = addMonthsToKey(currentExpiryKey(), 12);
      setForm({
        batch_no: "",
        expiry_mm_yy: `${String(expiry % 100).padStart(2, "0")}/${String(Math.floor(expiry / 100) % 100).padStart(2, "0")}`,
        mrp: "",
        rate: "",
        qty: Math.max(1, defaultQty),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provisionalSignal]);

  const totalStock = useMemo(() => batches.reduce((sum, batch) => sum + batch.cur_qty, 0), [batches]);

  const select = (batch: Batch) => {
    onSelect(batch, pickRate(batch, billingOn));
  };

  const createProvisional = async () => {
    setError(null);
    if (!form.batch_no.trim()) {
      setError("Batch number is required.");
      return;
    }
    setSaving(true);
    try {
      const response = await api.createProvisionalBatch({
        product_id: productId,
        batch_no: form.batch_no.trim().toUpperCase(),
        expiry_mm_yy: form.expiry_mm_yy,
        mrp_scaled: parseScaled(form.mrp || "0"),
        rate_scaled: parseScaled(form.rate || "0"),
        qty: Number(form.qty) || 0,
      });
      onSelect(response.batch, parseScaled(form.rate || "0") || response.batch.s_rate_scaled);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create provisional batch");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="absolute right-2 top-2 z-40 w-[500px] overflow-hidden rounded-[4px] border border-line bg-white shadow-window"
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((current) => Math.min(batches.length - 1, current + 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((current) => Math.max(0, current - 1));
        } else if (event.key === "Enter" && batches[active]) {
          event.preventDefault();
          select(batches[active]);
        }
      }}
    >
      <div className="flex items-start justify-between gap-2 border-b border-line bg-parchment/70 px-3 py-2">
        <div>
          <div className="text-[11.5px] font-bold text-navy">{productName}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[9.5px] uppercase tracking-wider text-inkmut">
            <CalendarClock size={10} /> FEFO · earliest expiry first · {totalStock} units
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="xs" onClick={onClose}>
            <X size={12} />
          </Button>
        </div>
      </div>

      {error ? <div className="px-2 pt-2"><Banner tone="danger">{error}</Banner></div> : null}

      <div className="max-h-[260px] overflow-auto">
        {loading ? (
          <div className="px-3 py-6 text-[11px] text-inkmut">Reading batches…</div>
        ) : batches.length === 0 ? (
          <div className="px-3 py-6">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-crimson">
              <AlertTriangle size={13} /> No batch has stock for this product.
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-inkmut">
              Add a provisional batch if the strip in your hand is not on file, or pick a salt substitute with stock.
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="accent" size="xs" onClick={() => setProvisionalOpen(true)}>
                <Plus size={11} /> Provisional batch <Kbd className="ml-1">Alt+B</Kbd>
              </Button>
              <Button variant="default" size="xs" onClick={onSubstitutes}>
                Substitutes <Kbd className="ml-1">Ctrl+R</Kbd>
              </Button>
            </div>
          </div>
        ) : (
          <table className="w-full text-[10.5px]">
            <thead>
              <tr className="border-b border-line bg-parchment/40 text-left text-[8.5px] uppercase tracking-wider text-inkmut">
                <th className="px-2 py-1">Batch</th>
                <th className="px-2 py-1">Expiry</th>
                <th className="px-2 py-1 text-right">Qty</th>
                <th className="px-2 py-1 text-right">MRP</th>
                <th className="px-2 py-1 text-right">S.Rate</th>
                <th className="px-2 py-1 text-right">Net</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {batches.map((batch, index) => {
                const near = batch.expiry_sort_key <= addMonthsToKey(currentExpiryKey(), 3);
                return (
                  <tr
                    key={batch.id}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => select(batch)}
                    className={cx(
                      "cursor-pointer border-b border-line/40 last:border-0",
                      index === active ? "bg-skybg" : "hover:bg-parchment/50",
                    )}
                  >
                    <td className="px-2 py-1">
                      <span className="font-mono font-semibold">{batch.batch_no}</span>
                      {batch.is_provisional === 1 ? <Badge tone="warning" className="ml-1">PROV</Badge> : null}
                    </td>
                    <td className="px-2 py-1">
                      <span className={cx("font-mono", near ? "font-bold text-[#8a5a10]" : "text-inkmut")}>
                        {batch.expiry_mm_yy}
                      </span>
                      {near ? <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent" /> : null}
                    </td>
                    <td className={cx("px-2 py-1 text-right font-mono font-semibold", batch.cur_qty < 0 ? "text-crimson" : "")}>
                      {batch.cur_qty}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{formatMoney(batch.mrp_scaled)}</td>
                    <td className="px-2 py-1 text-right font-mono">{formatMoney(batch.s_rate_scaled)}</td>
                    <td className="px-2 py-1 text-right font-mono text-teal">{formatRate4(batch.net_rate_scaled)}</td>
                    <td className="px-1 text-inkmut">
                      <ArrowRight size={11} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {provisionalOpen ? (
        <div className="border-t border-line bg-amberbg/40 px-2.5 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-[#8a5a10]">
              Provisional batch · Alt+B
            </span>
            <button type="button" onClick={() => setProvisionalOpen(false)} className="text-inkmut hover:text-ink">
              <X size={11} />
            </button>
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            <Field label="Batch no" className="col-span-2">
              <TextInput
                mono
                value={form.batch_no}
                className="h-6 px-1.5 text-[10.5px]"
                onChange={(event) => setForm((current) => ({ ...current, batch_no: event.target.value.toUpperCase() }))}
              />
            </Field>
            <Field label="Expiry">
              <TextInput
                mono
                value={form.expiry_mm_yy}
                className="h-6 px-1.5 text-[10.5px]"
                onChange={(event) => setForm((current) => ({ ...current, expiry_mm_yy: event.target.value }))}
              />
            </Field>
            <Field label="MRP">
              <TextInput
                mono
                align="right"
                value={form.mrp}
                className="h-6 px-1.5 text-[10.5px]"
                onChange={(event) => setForm((current) => ({ ...current, mrp: event.target.value }))}
              />
            </Field>
            <Field label="Rate">
              <TextInput
                mono
                align="right"
                value={form.rate}
                className="h-6 px-1.5 text-[10.5px]"
                onChange={(event) => setForm((current) => ({ ...current, rate: event.target.value }))}
              />
            </Field>
            <Field label="Qty">
              <TextInput
                mono
                align="right"
                value={form.qty}
                className="h-6 px-1.5 text-[10.5px]"
                onChange={(event) => setForm((current) => ({ ...current, qty: Number(event.target.value) }))}
              />
            </Field>
            <div className="col-span-4 flex items-end">
              <Button variant="accent" size="xs" onClick={createProvisional} disabled={saving}>
                <Plus size={11} /> {saving ? "Creating…" : "Create & select"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-line bg-parchment/50 px-2.5 py-1.5">
        <div className="flex items-center gap-2">
          <Button variant="default" size="xs" onClick={() => setProvisionalOpen((current) => !current)}>
            <Plus size={11} /> Provisional <Kbd className="ml-1">Alt+B</Kbd>
          </Button>
          <Button variant="ghost" size="xs" onClick={onSubstitutes}>
            Substitutes <Kbd className="ml-1">Ctrl+R</Kbd>
          </Button>
        </div>
        <span className="flex items-center gap-1 text-[9px] text-inkmut">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <Kbd>Enter</Kbd> pick
        </span>
      </div>
    </div>
  );
}
