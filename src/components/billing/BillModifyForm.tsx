import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  CalendarDays,
  FileEdit,
  Printer,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api } from "../../lib/invoke";
import type { SalesInvoice } from "../../types/database";
import type { InvoiceListResponse } from "../../types/ipc";
import { datePresets, formatMoney } from "../../lib/format";
import { useLookups } from "../../hooks/useLookups";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useToastStore } from "../../stores/useToastStore";
import { Badge, Banner, Button, Field, Kbd, Modal, Panel, Select, TextInput, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";

interface Props {
  windowId: string;
  payload: Record<string, unknown>;
}

export function BillModifyForm({ windowId, payload }: Props) {
  const { lookups } = useLookups();
  const pushToast = useToastStore((state) => state.push);
  const openWindow = useWorkspaceStore((state) => state.openWindow);

  const [preset, setPreset] = useState("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [series, setSeries] = useState("");
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<InvoiceListResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SalesInvoice | null>(null);

  const dueOnly = Boolean(payload.due_only);
  const registerMode = Boolean(payload.register);
  const presets = useMemo(() => datePresets(), []);

  const range = useMemo(() => {
    if (preset === "custom") {
      return { from: customFrom || null, to: customTo || null };
    }
    const found = presets.find((entry) => entry.key === preset) ?? presets[3];
    return { from: found.from, to: found.to };
  }, [preset, customFrom, customTo, presets]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listInvoices({
        from_iso: range.from,
        to_iso: range.to,
        series_code: series || null,
        query,
        limit: 200,
      });
      setResponse(data);
      setSelected((current) => current.filter((id) => data.items.some((invoice) => invoice.id === id)));
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to load invoices");
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, series, query]);

  useEffect(() => {
    const timer = window.setTimeout(load, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  const invoices = useMemo(() => {
    const items = response?.items ?? [];
    return dueOnly ? items.filter((invoice) => invoice.due_amt_scaled > 0) : items;
  }, [response, dueOnly]);

  const selectedInvoices = invoices.filter((invoice) => selected.includes(invoice.id));
  const convertible = selectedInvoices.filter(
    (invoice) => invoice.series_code === "E" && !invoice.converted_to_tax_inv_id,
  );

  const openInvoice = (invoice: SalesInvoice) => {
    openWindow(
      "SALES_INVOICE",
      { invoice_id: invoice.id, mode: "edit" },
      {
        singleton: false,
        title: `${invoice.series_code === "E" ? "Estimate" : "Tax Invoice"} — ${invoice.inv_no_display}`,
      },
    );
  };

  const convert = useCallback(async () => {
    if (convertible.length === 0) {
      setBanner("Select at least one unconverted estimate (Series E) to convert to a GST invoice.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.convertEstimates(convertible.map((invoice) => invoice.id));
      pushToast(
        `${result.converted.length} estimate(s) converted · ${result.converted.map((row) => row.to_display).join(", ")}`,
        "success",
      );
      setSelected([]);
      await load();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Conversion failed");
    } finally {
      setBusy(false);
    }
  }, [convertible, load, pushToast]);

  const remove = useCallback(async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.deleteInvoice(deleteTarget.id);
      pushToast(`Deleted ${deleteTarget.inv_no_display}`, "success");
      setDeleteTarget(null);
      setSelected([]);
      await load();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Delete failed");
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  }, [deleteTarget, load, pushToast]);

  useKeyboardNav({
    windowId,
    onConvert: convert,
    onEscape: () => false,
    mode: () => "EDIT",
    saveEnabled: false,
    editEnabled: false,
  });

  const allSelected = invoices.length > 0 && selected.length === invoices.length;

  return (
    <FormShell
      windowId={windowId}
      title={registerMode ? "Sales Register" : "Bill Modify"}
      subtitle={`${dueOnly ? "Open credit bills · " : ""}${range.from ?? "—"} → ${range.to ?? "—"} · auto-loaded`}
      mode="EDIT"
      dirty={false}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => openWindow("SALES_INVOICE", { mode: "new" }, { singleton: false })}>
            <FileEdit size={12} /> New bill
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={selectedInvoices.length !== 1}
            onClick={() => selectedInvoices[0] && openInvoice(selectedInvoices[0])}
          >
            <Printer size={12} /> Open
          </Button>
          <Button
            variant="default"
            size="sm"
            className="text-crimson"
            disabled={selectedInvoices.length !== 1}
            onClick={() => setDeleteTarget(selectedInvoices[0] ?? null)}
          >
            <Trash2 size={12} /> Delete
          </Button>
          <Button variant="accent" size="sm" shortcut="Ctrl+M" onClick={convert} disabled={busy || convertible.length === 0}>
            <ArrowRightLeft size={12} /> Convert to GST
          </Button>
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        </>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <>
          <div className="flex items-center gap-4">
            <span>
              Tot Recd: <span className="font-mono font-bold text-ink">{response?.total_count ?? 0}</span>
            </span>
            <span>
              Amount: <span className="font-mono font-bold text-ink">₹{formatMoney(response?.total_amount_scaled ?? 0)}</span>
            </span>
            <span>
              Due: <span className="font-mono font-bold text-crimson">₹{formatMoney(response?.total_due_scaled ?? 0)}</span>
            </span>
            <span className="text-inkmut">
              Selected: {selected.length} · convertible: {convertible.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <Kbd>Ctrl+M</Kbd> convert
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Ctrl+D</Kbd> reopen register
            </span>
          </div>
        </>
      }
    >
      <div className="space-y-3">
        <Panel bodyClassName="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-wrap gap-1">
              {presets.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => setPreset(entry.key)}
                  className={cx(
                    "inline-flex items-center gap-1 rounded-[3px] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider",
                    preset === entry.key
                      ? "border-navy bg-navy text-white"
                      : "border-line bg-white text-inkmut hover:bg-parchment",
                  )}
                >
                  <CalendarDays size={10} />
                  {entry.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPreset("custom")}
                className={cx(
                  "rounded-[3px] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider",
                  preset === "custom" ? "border-navy bg-navy text-white" : "border-line bg-white text-inkmut hover:bg-parchment",
                )}
              >
                Custom range
              </button>
            </div>
            {preset === "custom" ? (
              <div className="flex items-end gap-2">
                <Field label="From (YYYY-MM-DD)">
                  <TextInput
                    mono
                    value={customFrom}
                    data-nav-index={3}
                    className="w-[130px]"
                    onChange={(event) => setCustomFrom(event.target.value)}
                  />
                </Field>
                <Field label="To (YYYY-MM-DD)">
                  <TextInput
                    mono
                    value={customTo}
                    data-nav-index={4}
                    className="w-[130px]"
                    onChange={(event) => setCustomTo(event.target.value)}
                  />
                </Field>
                <Button variant="default" size="sm" onClick={load}>
                  Apply
                </Button>
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-2 md:grid-cols-[160px_minmax(0,1fr)_auto]">
            <Field label="Series">
              <Select value={series} data-nav-index={1} onChange={(event) => setSeries(event.target.value)}>
                <option value="">All series</option>
                {lookups.series.map((row) => (
                  <option key={row.id} value={row.code}>
                    {row.code} · {row.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Inv. No / Party" hint="Live debounced filter across invoice number and party name">
              <TextInput
                value={query}
                placeholder="e.g. E728 or HIND MEDICAL"
                data-nav-index={2}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
            <div className="flex items-end gap-2 pb-0.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setSeries("");
                  setPreset("month");
                }}
              >
                Clear
              </Button>
              {loading ? <Badge tone="info">Loading…</Badge> : null}
            </div>
          </div>
        </Panel>

        <Panel
          title="Invoice register"
          subtitle="Click rows to select · double-click to open · estimates can be converted with Ctrl+M"
          bodyClassName="p-0"
        >
          <div className="max-h-[520px] overflow-auto">
            <table className="ledger-table min-w-[980px]">
              <thead>
                <tr>
                  <th className="w-[28px]">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(event) =>
                        setSelected(event.target.checked ? invoices.map((invoice) => invoice.id) : [])
                      }
                      className="h-3 w-3 accent-teal"
                    />
                  </th>
                  <th className="text-left">Inv. No</th>
                  <th className="text-left">Date</th>
                  <th className="text-left">Party</th>
                  <th className="text-center">Series</th>
                  <th className="text-center">Mode</th>
                  <th className="text-right">Items</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Due</th>
                  <th className="text-center">Status</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-10 text-center text-[11px] text-inkmut">
                      No bills match this window. Pick another date preset or series.
                    </td>
                  </tr>
                ) : (
                  invoices.map((invoice) => {
                    const checked = selected.includes(invoice.id);
                    const converted = Boolean(invoice.converted_to_tax_inv_id);
                    return (
                      <tr
                        key={invoice.id}
                        className={cx(checked && "is-active")}
                        onClick={() =>
                          setSelected((current) =>
                            current.includes(invoice.id)
                              ? current.filter((id) => id !== invoice.id)
                              : [...current, invoice.id],
                          )
                        }
                        onDoubleClick={() => openInvoice(invoice)}
                      >
                        <td className="text-center">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => undefined}
                            className="h-3 w-3 accent-teal"
                          />
                        </td>
                        <td className="font-mono font-semibold">{invoice.inv_no_display}</td>
                        <td className="font-mono text-[10.5px]">{invoice.inv_date_display}</td>
                        <td className="max-w-[260px] truncate">{invoice.party_name_snapshot}</td>
                        <td className="text-center">
                          <Badge tone={invoice.series_code === "E" ? "warning" : "success"}>{invoice.series_code}</Badge>
                        </td>
                        <td className="text-center">
                          <span className={cx("text-[9.5px] font-semibold uppercase", invoice.payment_mode === "CREDIT" ? "text-accent" : "text-teal")}>
                            {invoice.payment_mode}
                          </span>
                        </td>
                        <td className="text-right font-mono">{invoice.item_count ?? 0}</td>
                        <td className="text-right font-mono font-semibold">₹{formatMoney(invoice.grand_total_scaled)}</td>
                        <td className={cx("text-right font-mono", invoice.due_amt_scaled > 0 ? "text-crimson" : "text-inkmut")}>
                          ₹{formatMoney(invoice.due_amt_scaled)}
                        </td>
                        <td className="text-center">
                          {converted ? (
                            <Badge tone="info">Converted</Badge>
                          ) : invoice.series_code === "E" ? (
                            <Badge tone="warning">Estimate</Badge>
                          ) : (
                            <Badge tone="success">GST</Badge>
                          )}
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            className="text-[10px] font-semibold text-navy underline underline-offset-2 hover:text-teal"
                            onClick={(event) => {
                              event.stopPropagation();
                              openInvoice(invoice);
                            }}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="grid gap-3 md:grid-cols-3">
          <Panel title="Conversion rules">
            <ul className="space-y-1 text-[10px] leading-relaxed text-inkmut">
              <li>• Series E estimates convert into Series ABC GST invoices.</li>
              <li>• Physical stock is untouched; only GST book stock is deducted.</li>
              <li>• The estimate keeps a link to its converted invoice for audit.</li>
            </ul>
          </Panel>
          <Panel title="Selection">
            <div className="text-[10.5px] text-inkmut">
              <div>
                Selected bills: <span className="font-mono font-semibold text-ink">{selected.length}</span>
              </div>
              <div>
                Convertible estimates: <span className="font-mono font-semibold text-ink">{convertible.length}</span>
              </div>
              <div className="mt-2 text-[9.5px]">Use Ctrl+M to convert every selected estimate in one atomic pass.</div>
            </div>
          </Panel>
          <Panel title="Quick tip">
            <p className="text-[10px] leading-relaxed text-inkmut">
              Double-click any row to open it in the billing screen. Editing reverses the old stock and ledger effect,
              then re-applies the new bill.
            </p>
          </Panel>
        </div>
      </div>

      <Modal
        open={Boolean(deleteTarget)}
        title="Delete invoice"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="default" size="sm" onClick={() => setDeleteTarget(null)}>
              Keep
            </Button>
            <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
              Delete & restore stock
            </Button>
          </>
        }
      >
        <p className="text-[12px]">
          Delete <span className="font-semibold">{deleteTarget?.inv_no_display}</span> for{" "}
          {deleteTarget?.party_name_snapshot}?
        </p>
        <p className="mt-1 text-[10.5px] text-inkmut">
          Stock and the party ledger will be reversed. The record is soft-deleted and queued for sync.
        </p>
      </Modal>
    </FormShell>
  );
}
