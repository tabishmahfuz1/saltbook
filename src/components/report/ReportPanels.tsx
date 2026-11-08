import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../../lib/invoke";
import type { AccountParty } from "../../types/database";
import type { CompositionRow, LedgerResponse, SalesReportResponse } from "../../types/ipc";
import { datePresets, expiryDisplayFromKey, formatMoney } from "../../lib/format";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { Badge, Banner, Button, Field, Panel, Stat, TextInput, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";
import { PartyLookup } from "../ui/lookups";

interface WindowProps {
  windowId: string;
  payload: Record<string, unknown>;
}

export function CompositionQuery({ windowId }: WindowProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CompositionRow[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.compositionQuery({ query, limit: 300 });
      setItems(response.items);
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to query compositions");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(load, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  useKeyboardNav({ windowId, onEscape: () => false, mode: () => "VIEW", saveEnabled: false, editEnabled: false });

  const groups = useMemo(() => {
    const map = new Map<string, CompositionRow[]>();
    items.forEach((item) => {
      const key = item.composition_desc || "(No composition)";
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return [...map.entries()];
  }, [items]);

  return (
    <FormShell
      windowId={windowId}
      title="Composition Query"
      subtitle="Every SKU sharing a salt composition, with stock and margin context"
      mode="VIEW"
      dirty={false}
      actions={
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={<span>{items.length} products · {groups.length} compositions</span>}
    >
      <div className="space-y-3">
        <Panel>
          <Field label="Search product, salt composition or company">
            <TextInput value={query} data-nav-index={1} onChange={(event) => setQuery(event.target.value)} />
          </Field>
        </Panel>
        <Panel bodyClassName="p-0">
          <div className="max-h-[560px] overflow-auto">
            <table className="ledger-table min-w-[900px]">
              <thead>
                <tr>
                  <th className="text-left">Product</th>
                  <th className="text-left">Company</th>
                  <th className="text-right">Stock</th>
                  <th className="text-right">S.Rate</th>
                  <th className="text-right">MRP</th>
                  <th className="text-right">Nearest expiry</th>
                </tr>
              </thead>
              <tbody>
                {groups.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-[10.5px] text-inkmut">
                      No products match.
                    </td>
                  </tr>
                ) : (
                  groups.map(([composition, products]) => (
                    <Fragment key={composition}>
                      <tr>
                        <td colSpan={6} className="bg-parchment/70 py-1 text-[9.5px] font-bold uppercase tracking-[0.1em] text-navy">
                          {composition}
                          <Badge tone="neutral" className="ml-2">{products.length}</Badge>
                        </td>
                      </tr>
                      {products.map((product) => (
                        <tr key={product.id}>
                          <td>
                            <div className="font-semibold">{product.name}</div>
                            <div className="text-[9px] text-inkmut">#{product.pro_code} · {product.pack_form} {product.pack_unit}×{product.pack_subunit}</div>
                          </td>
                          <td>{product.company_name || "—"}</td>
                          <td className={cx("text-right font-mono", product.cur_qty < 0 ? "text-crimson" : "")}>{product.cur_qty}</td>
                          <td className="text-right font-mono">{formatMoney(product.s_rate_scaled)}</td>
                          <td className="text-right font-mono">{formatMoney(product.mrp_scaled)}</td>
                          <td className="text-right font-mono text-[10px]">
                            {product.nearest_expiry ? expiryDisplayFromKey(product.nearest_expiry) : "—"}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
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

export function SalesReport({ windowId }: WindowProps) {
  const presets = useMemo(() => datePresets(), []);
  const [preset, setPreset] = useState("month");
  const [fromIso, setFromIso] = useState(presets[3].from);
  const [toIso, setToIso] = useState(presets[3].to);
  const [response, setResponse] = useState<SalesReportResponse | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (preset === "custom") return;
    const found = presets.find((entry) => entry.key === preset);
    if (found) {
      setFromIso(found.from);
      setToIso(found.to);
    }
  }, [preset, presets]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.salesReport({ from_iso: fromIso || null, to_iso: toIso || null });
      setResponse(data);
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to build sales report");
    } finally {
      setLoading(false);
    }
  }, [fromIso, toIso]);

  useEffect(() => {
    load();
  }, [load]);

  useKeyboardNav({ windowId, onEscape: () => false, mode: () => "VIEW", saveEnabled: false, editEnabled: false });

  const totals = response?.totals ?? {};

  return (
    <FormShell
      windowId={windowId}
      title="Sales Report"
      subtitle={`${fromIso} → ${toIso}`}
      mode="VIEW"
      dirty={false}
      actions={
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <span>
          {Number(totals.bill_count ?? 0)} bills · ₹{formatMoney(Number(totals.total_scaled ?? 0))} · due ₹
          {formatMoney(Number(totals.due_scaled ?? 0))}
        </span>
      }
    >
      <div className="space-y-3">
        <Panel>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-wrap gap-1">
              {presets.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => setPreset(entry.key)}
                  className={cx(
                    "rounded-[3px] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider",
                    preset === entry.key ? "border-navy bg-navy text-white" : "border-line bg-white text-inkmut hover:bg-parchment",
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <Field label="From (YYYY-MM-DD)">
              <TextInput
                mono
                value={fromIso}
                data-nav-index={1}
                className="w-[130px]"
                onChange={(event) => {
                  setPreset("custom");
                  setFromIso(event.target.value);
                }}
              />
            </Field>
            <Field label="To (YYYY-MM-DD)">
              <TextInput
                mono
                value={toIso}
                data-nav-index={2}
                className="w-[130px]"
                onChange={(event) => {
                  setPreset("custom");
                  setToIso(event.target.value);
                }}
              />
            </Field>
          </div>
        </Panel>

        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <Stat label="Bills" value={Number(totals.bill_count ?? 0)} />
          <Stat label="Sales" value={`₹${formatMoney(Number(totals.total_scaled ?? 0))}`} tone="good" />
          <Stat label="GST" value={`₹${formatMoney(Number(totals.tax_scaled ?? 0))}`} />
          <Stat label="Discount" value={`₹${formatMoney(Number(totals.discount_scaled ?? 0))}`} />
          <Stat label="Outstanding" value={`₹${formatMoney(Number(totals.due_scaled ?? 0))}`} tone="warn" />
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Panel title="Daily register" bodyClassName="p-0">
            <div className="max-h-[380px] overflow-auto">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th className="text-left">Date</th>
                    <th className="text-center">Series</th>
                    <th className="text-right">Bills</th>
                    <th className="text-right">Gross</th>
                    <th className="text-right">GST</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(response?.daily ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-[10.5px] text-inkmut">
                        No bills in this range.
                      </td>
                    </tr>
                  ) : (
                    (response?.daily ?? []).map((row, index) => (
                      <tr key={`${String(row.inv_date_iso)}-${String(row.series_code)}-${index}`}>
                        <td className="font-mono text-[10px]">{String(row.inv_date_display ?? row.inv_date_iso)}</td>
                        <td className="text-center">
                          <Badge tone={String(row.series_code) === "E" ? "warning" : "success"}>{String(row.series_code)}</Badge>
                        </td>
                        <td className="text-right font-mono">{Number(row.bill_count ?? 0)}</td>
                        <td className="text-right font-mono">₹{formatMoney(Number(row.gross_scaled ?? 0))}</td>
                        <td className="text-right font-mono">₹{formatMoney(Number(row.tax_scaled ?? 0))}</td>
                        <td className="text-right font-mono font-semibold">₹{formatMoney(Number(row.total_scaled ?? 0))}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="space-y-3">
            <Panel title="By series">
              {(response?.by_series ?? []).map((row) => (
                <div key={String(row.series_code)} className="flex items-center justify-between border-b border-line/50 py-1 text-[10.5px] last:border-0">
                  <Badge tone={String(row.series_code) === "E" ? "warning" : "success"}>{String(row.series_code)}</Badge>
                  <span className="font-mono">{Number(row.bill_count ?? 0)} bills</span>
                  <span className="font-mono font-semibold">₹{formatMoney(Number(row.total_scaled ?? 0))}</span>
                </div>
              ))}
              {(response?.by_series ?? []).length === 0 ? <div className="text-[10px] text-inkmut">No data</div> : null}
            </Panel>
            <Panel title="Top products">
              {(response?.top_products ?? []).map((row, index) => (
                <div key={`${String(row.pro_code)}-${index}`} className="border-b border-line/50 py-1 text-[10px] last:border-0">
                  <div className="truncate font-semibold">{String(row.product_name ?? "")}</div>
                  <div className="flex justify-between font-mono text-[9.5px] text-inkmut">
                    <span>{Number(row.qty ?? 0)} units</span>
                    <span>₹{formatMoney(Number(row.amount_scaled ?? 0))}</span>
                  </div>
                </div>
              ))}
              {(response?.top_products ?? []).length === 0 ? (
                <div className="text-[10px] text-inkmut">Top products appear once bills are saved.</div>
              ) : null}
            </Panel>
          </div>
        </div>
      </div>
    </FormShell>
  );
}

export function LedgerReport({ windowId }: WindowProps) {
  const [accountType, setAccountType] = useState<"PARTY" | "SUPPLIER">("PARTY");
  const [account, setAccount] = useState<AccountParty | null>(null);
  const [query, setQuery] = useState("");
  const [fromIso, setFromIso] = useState("");
  const [toIso, setToIso] = useState("");
  const [response, setResponse] = useState<LedgerResponse | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!account) {
      setResponse(null);
      return;
    }
    try {
      const data = await api.ledger({ account_id: account.id, from_iso: fromIso || undefined, to_iso: toIso || undefined });
      setResponse(data);
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to load ledger");
    }
  }, [account, fromIso, toIso]);

  useEffect(() => {
    load();
  }, [load]);

  useKeyboardNav({ windowId, onEscape: () => false, mode: () => "VIEW", saveEnabled: false, editEnabled: false });

  let running = response?.opening_scaled ?? 0;

  return (
    <FormShell
      windowId={windowId}
      title="Ledger Statement"
      subtitle={account ? `${account.name} · ${account.code}` : "Choose a party or supplier"}
      mode="VIEW"
      dirty={false}
      footer={
        response ? (
          <div className="flex items-center gap-4">
            <span>Opening: <span className="font-mono">₹{formatMoney(response.opening_scaled)}</span></span>
            <span>Closing: <span className="font-mono font-semibold">₹{formatMoney(response.closing_scaled)}</span></span>
            <span className="text-inkmut">{response.entries.length} entries</span>
          </div>
        ) : (
          <span>Select an account</span>
        )
      }
    >
      <div className="space-y-3">
        <Panel>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
            <Field label="Account type">
              <div className="flex h-7 overflow-hidden rounded-[3px] border border-line">
                {(["PARTY", "SUPPLIER"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      setAccountType(type);
                      setAccount(null);
                      setQuery("");
                      setResponse(null);
                    }}
                    className={cx(
                      "flex-1 text-[10px] font-bold uppercase tracking-wider",
                      accountType === type ? "bg-navy text-white" : "bg-white text-inkmut hover:bg-parchment",
                    )}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Account" className="md:col-span-2">
              <PartyLookup
                accountType={accountType}
                query={query}
                onQueryChange={(value) => {
                  setQuery(value);
                  setAccount(null);
                }}
                onSelect={(selected) => {
                  setAccount(selected);
                  setQuery(selected.name);
                }}
                navIndex={1}
              />
            </Field>
            <Field label="From (optional)">
              <TextInput mono value={fromIso} data-nav-index={2} onChange={(event) => setFromIso(event.target.value)} />
            </Field>
            <Field label="To (optional)">
              <TextInput mono value={toIso} data-nav-index={3} onChange={(event) => setToIso(event.target.value)} />
            </Field>
          </div>
        </Panel>

        {banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : null}

        <Panel bodyClassName="p-0">
          <div className="max-h-[520px] overflow-auto">
            <table className="ledger-table min-w-[760px]">
              <thead>
                <tr>
                  <th className="text-left">Date</th>
                  <th className="text-left">Type</th>
                  <th className="text-left">Reference</th>
                  <th className="text-left">Narration</th>
                  <th className="text-right">Debit</th>
                  <th className="text-right">Credit</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {response ? (
                  <>
                    <tr>
                      <td colSpan={6} className="text-[10px] font-semibold uppercase tracking-wider text-inkmut">
                        Opening balance
                      </td>
                      <td className="text-right font-mono font-semibold">₹{formatMoney(response.opening_scaled)}</td>
                    </tr>
                    {response.entries.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-6 text-center text-[10.5px] text-inkmut">
                          No ledger entries in this range.
                        </td>
                      </tr>
                    ) : (
                      response.entries.map((entry, index) => {
                        running += entry.dr_scaled - entry.cr_scaled;
                        return (
                          <tr key={`${entry.ref_no}-${index}`}>
                            <td className="font-mono text-[10px]">{entry.entry_date_iso}</td>
                            <td className="text-[10px]">{entry.entry_type}</td>
                            <td className="font-mono text-[10px]">{entry.ref_no ?? "—"}</td>
                            <td className="max-w-[260px] truncate text-[10px] text-inkmut">{entry.narration ?? ""}</td>
                            <td className="text-right font-mono">₹{formatMoney(entry.dr_scaled)}</td>
                            <td className="text-right font-mono">₹{formatMoney(entry.cr_scaled)}</td>
                            <td className={cx("text-right font-mono font-semibold", running > 0 ? "text-crimson" : "text-teal")}>
                              ₹{formatMoney(running)}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </>
                ) : (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-[10.5px] text-inkmut">
                      Pick an account to open its statement.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </FormShell>
  );
}
