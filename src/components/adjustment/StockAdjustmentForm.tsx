import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Plus, Save, Trash2 } from "lucide-react";
import { api } from "../../lib/invoke";
import type { AccountParty, Batch } from "../../types/database";
import type { AdjustmentSaveRequest } from "../../types/ipc";
import { formatMoney, todayDisplay } from "../../lib/format";
import { useLookups } from "../../hooks/useLookups";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useToastStore } from "../../stores/useToastStore";
import { Badge, Banner, Button, Field, Panel, ScaledInput, Select, TextInput, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";
import { PartyLookup, ProductLookup } from "../ui/lookups";

interface AdjustmentLine {
  key: string;
  product_id: string;
  product_name: string;
  batch_id: string;
  batch_no: string;
  expiry: string;
  available: number;
  qty: number;
  rate_scaled: number;
  batches: Batch[];
}

let counter = 0;
function blankLine(): AdjustmentLine {
  counter += 1;
  return {
    key: `adj-${Date.now()}-${counter}`,
    product_id: "",
    product_name: "",
    batch_id: "",
    batch_no: "",
    expiry: "",
    available: 0,
    qty: 1,
    rate_scaled: 0,
    batches: [],
  };
}

const FALLBACK_TYPES = [
  { code: "TRANSFER_IN", label: "Transfer In", direction: "IN" },
  { code: "TRANSFER_OUT", label: "Transfer Out", direction: "OUT" },
  { code: "REPLACEMENT_IN", label: "Replacement In", direction: "IN" },
  { code: "REPLACEMENT_OUT", label: "Replacement Out", direction: "OUT" },
  { code: "SAMPLE_ISSUE", label: "Sample Issue", direction: "OUT" },
  { code: "CREDIT_NOTE", label: "Credit Note", direction: "IN" },
  { code: "DEBIT_NOTE", label: "Debit Note", direction: "OUT" },
  { code: "STOCK_SHORTAGE", label: "Stock Shortage", direction: "OUT" },
  { code: "STOCK_SURPLUS", label: "Stock SurPlus", direction: "IN" },
  { code: "BREAKAGE_EXPIRY", label: "Godown -> Breakage / Expiry", direction: "OUT" },
  { code: "GODOWN_TRANSFER", label: "Godown Transfer", direction: "MOVE" },
];

interface Props {
  windowId: string;
  payload: Record<string, unknown>;
}

export function StockAdjustmentForm({ windowId, payload }: Props) {
  const { lookups } = useLookups();
  const pushToast = useToastStore((state) => state.push);
  const [types, setTypes] = useState(FALLBACK_TYPES);
  const [adjType, setAdjType] = useState(String(payload.adj_type ?? "BREAKAGE_EXPIRY"));
  const [dateDisplay, setDateDisplay] = useState(todayDisplay);
  const [godownId, setGodownId] = useState("");
  const [toGodownId, setToGodownId] = useState("");
  const [party, setParty] = useState<AccountParty | null>(null);
  const [partyQuery, setPartyQuery] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<AdjustmentLine[]>([blankLine()]);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<Array<Record<string, unknown>>>([]);

  const direction = types.find((type) => type.code === adjType)?.direction ?? "OUT";
  const needsParty = adjType === "CREDIT_NOTE" || adjType === "DEBIT_NOTE";
  const isMove = direction === "MOVE";

  useEffect(() => {
    api
      .listAdjustmentTypes()
      .then((response) => setTypes(response.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!godownId && lookups.godowns.length) {
      setGodownId(lookups.godowns.find((row) => row.is_default === 1)?.id ?? lookups.godowns[0].id);
    }
    if (!toGodownId && lookups.godowns.length > 1) {
      setToGodownId(lookups.godowns.find((row) => row.id !== godownId)?.id ?? lookups.godowns[0].id);
    }
  }, [lookups.godowns, godownId, toGodownId]);

  const loadRecent = useCallback(async () => {
    try {
      const response = await api.listAdjustments({ limit: 10 });
      setRecent(response.items);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  const updateLine = (index: number, patch: Partial<AdjustmentLine>) => {
    setLines((current) => current.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  };

  const selectProduct = async (index: number, productId: string, productName: string) => {
    updateLine(index, { product_id: productId, product_name: productName, batch_id: "", batches: [] });
    try {
      const response = await api.fefoBatches({ product_id: productId, include_empty: true });
      setLines((current) =>
        current.map((line, position) =>
          position === index
            ? { ...line, product_id: productId, product_name: productName, batches: response.items }
            : line,
        ),
      );
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to load batches");
    }
  };

  const selectBatch = (index: number, batchId: string) => {
    const line = lines[index];
    const batch = line.batches.find((row) => row.id === batchId);
    if (!batch) {
      updateLine(index, { batch_id: "", batch_no: "", expiry: "", available: 0 });
      return;
    }
    updateLine(index, {
      batch_id: batch.id,
      batch_no: batch.batch_no,
      expiry: batch.expiry_mm_yy,
      available: batch.cur_qty,
      rate_scaled: batch.p_rate_scaled || batch.s_rate_scaled,
    });
  };

  const total = useMemo(
    () => lines.reduce((sum, line) => sum + line.qty * line.rate_scaled, 0),
    [lines],
  );

  const save = useCallback(async () => {
    setBanner(null);
    const valid = lines.filter((line) => line.product_id && line.batch_id && line.qty > 0);
    if (valid.length === 0) {
      setBanner("Add at least one product and batch line.");
      return;
    }
    if (isMove && (!toGodownId || toGodownId === godownId)) {
      setBanner("Godown transfer needs a different destination godown.");
      return;
    }
    if (needsParty && !party) {
      setBanner(`${adjType === "CREDIT_NOTE" ? "Credit note" : "Debit note"} needs a party.`);
      return;
    }
    setSaving(true);
    try {
      const request: AdjustmentSaveRequest = {
        adj_type: adjType,
        adj_date_display: dateDisplay,
        godown_id: godownId || null,
        to_godown_id: isMove ? toGodownId : null,
        party_id: needsParty ? party?.id ?? null : null,
        reason: reason || null,
        items: valid.map((line) => ({
          product_id: line.product_id,
          batch_id: line.batch_id,
          qty: line.qty,
          rate_scaled: line.rate_scaled,
        })),
      };
      const result = await api.saveAdjustment(request);
      pushToast(`${result.display} saved · ${result.lines} line(s)`, "success");
      setLines([blankLine()]);
      setReason("");
      setParty(null);
      setPartyQuery("");
      loadRecent();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to save adjustment");
    } finally {
      setSaving(false);
    }
  }, [adjType, dateDisplay, godownId, isMove, lines, loadRecent, needsParty, party, pushToast, reason, toGodownId]);

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
      title="Stock Adjustment"
      subtitle={`${types.find((type) => type.code === adjType)?.label ?? adjType} · ${direction} · ${formatMoney(total)}`}
      mode="NEW"
      dirty={false}
      actions={
        <Button variant="primary" size="sm" shortcut="Ctrl+S" onClick={save} disabled={saving}>
          <Save size={12} /> {saving ? "Saving…" : "Post adjustment"}
        </Button>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <div className="flex items-center gap-3">
          <span>
            Lines: <span className="font-mono font-semibold">{lines.filter((line) => line.batch_id).length}</span>
          </span>
          <span>
            Value: <span className="font-mono font-semibold">₹{formatMoney(total)}</span>
          </span>
          <span className="flex items-center gap-1">
            Direction <Badge tone={direction === "IN" ? "success" : direction === "MOVE" ? "info" : "danger"}>{direction}</Badge>
          </span>
        </div>
      }
    >
      <div ref={formRef} onKeyDown={onKeyDown} data-window={windowId} className="space-y-3">
        <Panel title="Adjustment header">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Field label="Type" className="md:col-span-2">
              <Select value={adjType} data-nav-index={1} onChange={(event) => setAdjType(event.target.value)}>
                {types.map((type) => (
                  <option key={type.code} value={type.code}>
                    {type.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date">
              <TextInput mono value={dateDisplay} data-nav-index={2} onChange={(event) => setDateDisplay(event.target.value)} />
            </Field>
            <Field label="Godown">
              <Select value={godownId} data-nav-index={3} onChange={(event) => setGodownId(event.target.value)}>
                {lookups.godowns.map((godown) => (
                  <option key={godown.id} value={godown.id}>
                    {godown.code} · {godown.name}
                  </option>
                ))}
              </Select>
            </Field>
            {isMove ? (
              <Field label="To godown">
                <Select value={toGodownId} data-nav-index={4} onChange={(event) => setToGodownId(event.target.value)}>
                  {lookups.godowns.map((godown) => (
                    <option key={godown.id} value={godown.id}>
                      {godown.code} · {godown.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Reason">
                <TextInput value={reason} data-nav-index={4} onChange={(event) => setReason(event.target.value)} />
              </Field>
            )}
            {needsParty ? (
              <Field label={adjType === "CREDIT_NOTE" ? "Customer" : "Supplier"} className="md:col-span-2">
                <PartyLookup
                  accountType={adjType === "CREDIT_NOTE" ? "PARTY" : "SUPPLIER"}
                  query={partyQuery}
                  onQueryChange={(value) => {
                    setPartyQuery(value);
                    setParty(null);
                  }}
                  onSelect={(account) => {
                    setParty(account);
                    setPartyQuery(account.name);
                  }}
                  navIndex={5}
                />
              </Field>
            ) : null}
            {isMove ? (
              <Field label="Reason" className="md:col-span-2">
                <TextInput value={reason} data-nav-index={5} onChange={(event) => setReason(event.target.value)} />
              </Field>
            ) : null}
          </div>
          <div className="mt-2 flex items-start gap-2 rounded-[3px] border border-line/70 bg-parchment/40 px-2.5 py-1.5 text-[9.5px] text-inkmut">
            <ArrowLeftRight size={12} className="mt-0.5 shrink-0" />
            {direction === "OUT"
              ? "Outbound adjustments reduce both physical and GST book stock; the batch must have enough units."
              : direction === "MOVE"
                ? "Godown transfer moves the batch between godowns; the destination lot is created with the same pricing."
                : "Inbound adjustments increase physical and GST book stock and are valued at the entered rate."}
          </div>
        </Panel>

        <Panel
          title="Adjustment lines"
          subtitle="Pick a product, then its batch"
          right={
            <Button variant="default" size="xs" onClick={() => setLines((current) => [...current, blankLine()])}>
              <Plus size={11} /> Add line
            </Button>
          }
          bodyClassName="p-0"
        >
          <div className="max-h-[300px] overflow-auto">
            <table className="ledger-table min-w-[900px]">
              <thead>
                <tr>
                  <th className="text-left">Product</th>
                  <th className="text-left">Batch</th>
                  <th className="text-left">Expiry</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={line.key}>
                    <td className="min-w-[240px]">
                      <ProductLookup
                        query={line.product_name}
                        onQueryChange={(value) =>
                          updateLine(index, { product_name: value, product_id: "", batch_id: "", batches: [] })
                        }
                        onSelect={(product) => void selectProduct(index, product.id, product.name)}
                        navIndex={100 + index * 10}
                      />
                    </td>
                    <td className="min-w-[160px]">
                      <Select
                        value={line.batch_id}
                        data-nav-index={100 + index * 10 + 1}
                        onChange={(event) => selectBatch(index, event.target.value)}
                      >
                        <option value="">Select batch…</option>
                        {line.batches.map((batch) => (
                          <option key={batch.id} value={batch.id}>
                            {batch.batch_no} · {batch.expiry_mm_yy} ({batch.cur_qty})
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="font-mono text-[10px]">{line.expiry || "—"}</td>
                    <td className={cx("text-right font-mono", line.available <= 0 && "text-crimson")}>{line.available}</td>
                    <td className="w-[80px]">
                      <TextInput
                        mono
                        type="number"
                        min={1}
                        align="right"
                        value={line.qty}
                        data-nav-index={100 + index * 10 + 2}
                        className="h-7 px-1.5"
                        onChange={(event) => updateLine(index, { qty: Number(event.target.value) })}
                      />
                    </td>
                    <td className="w-[100px]">
                      <ScaledInput
                        value={line.rate_scaled}
                        onValueChange={(value) => updateLine(index, { rate_scaled: value })}
                        navIndex={100 + index * 10 + 3}
                        className="h-7 px-1.5"
                      />
                    </td>
                    <td className="text-right font-mono font-semibold">{formatMoney(line.qty * line.rate_scaled)}</td>
                    <td className="text-center">
                      <button
                        type="button"
                        className="text-inkmut/60 hover:text-crimson"
                        onClick={() =>
                          setLines((current) =>
                            current.length === 1 ? [blankLine()] : current.filter((_, position) => position !== index),
                          )
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Recent adjustments" bodyClassName="p-0">
          <div className="max-h-[220px] overflow-auto">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th className="text-left">Type</th>
                  <th className="text-left">Date</th>
                  <th className="text-left">Godown</th>
                  <th className="text-right">Lines</th>
                  <th className="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-5 text-center text-[10.5px] text-inkmut">
                      No adjustments posted yet.
                    </td>
                  </tr>
                ) : (
                  recent.map((row) => (
                    <tr key={String(row.id)}>
                      <td>{String(row.adj_type ?? "")}</td>
                      <td className="font-mono text-[10px]">{String(row.adj_date_display ?? "")}</td>
                      <td className="font-mono text-[10px]">{String(row.godown_code ?? "")}</td>
                      <td className="text-right font-mono">{String(row.line_count ?? 0)}</td>
                      <td className="text-right font-mono">₹{formatMoney(Number(row.total_value_scaled ?? 0))}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </FormShell>
  );
}
