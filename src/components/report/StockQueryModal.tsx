import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FilterX, RefreshCw } from "lucide-react";
import { api } from "../../lib/invoke";
import type { StockQueryResponse, StockQueryRow } from "../../types/ipc";
import { formatMoney, formatRate4, formatQty } from "../../lib/format";
import { useLookups } from "../../hooks/useLookups";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { Badge, Banner, Button, Field, Panel, Select, TextInput, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";

interface Props {
  windowId: string;
  payload: Record<string, unknown>;
}

export function StockQueryModal({ windowId, payload }: Props) {
  const { lookups } = useLookups();
  const [query, setQuery] = useState(String(payload.query ?? ""));
  const [godownId, setGodownId] = useState("");
  const [onlyInStock, setOnlyInStock] = useState(!payload.negative_only);
  const [expiryMonths, setExpiryMonths] = useState(String(payload.expiry_within_months ?? ""));
  const [negativeOnly, setNegativeOnly] = useState(Boolean(payload.negative_only));
  const [response, setResponse] = useState<StockQueryResponse | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.stockQuery({
        query,
        godown_id: godownId || null,
        only_in_stock: onlyInStock,
        expiry_within_months: expiryMonths ? Number(expiryMonths) : null,
        limit: 500,
      });
      setResponse(data);
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to run stock query");
    } finally {
      setLoading(false);
    }
  }, [query, godownId, onlyInStock, expiryMonths]);

  useEffect(() => {
    const timer = window.setTimeout(load, 160);
    return () => window.clearTimeout(timer);
  }, [load]);

  const rows = useMemo(() => {
    const items = response?.items ?? [];
    return negativeOnly ? items.filter((row) => row.cur_qty < 0) : items;
  }, [response, negativeOnly]);

  useKeyboardNav({
    windowId,
    onEscape: () => false,
    mode: () => "VIEW",
    saveEnabled: false,
    editEnabled: false,
  });

  const exportCsv = () => {
    const header = "Product,Batch,Expiry,Stock,GST Stock,MRP,S.Rate,P.Rate,Value,Godown\n";
    const body = rows
      .map((row) =>
        [
          `"${row.product_name.replace(/"/g, '""')}"`,
          row.batch_no,
          row.expiry_mm_yy,
          row.cur_qty,
          row.tax_stock_qty,
          formatMoney(row.mrp_scaled),
          formatMoney(row.s_rate_scaled),
          formatMoney(row.p_rate_scaled),
          formatMoney(row.stock_value_scaled),
          row.godown_code,
        ].join(","),
      )
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "saltbook-stock-query.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <FormShell
      windowId={windowId}
      title="Stock Query"
      subtitle="Batch-level physical and GST book stock across godowns"
      mode="VIEW"
      dirty={false}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={exportCsv}>
            <Download size={12} /> CSV
          </Button>
          <Button variant="default" size="sm" onClick={load} disabled={loading}>
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        </>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        response ? (
          <div className="flex flex-wrap items-center gap-4">
            <span>
              Batches: <span className="font-mono font-semibold text-ink">{response.totals.batch_count}</span>
            </span>
            <span>
              Units: <span className="font-mono font-semibold text-ink">{formatQty(response.totals.total_units)}</span>
            </span>
            <span>
              Value: <span className="font-mono font-semibold text-ink">₹{formatMoney(response.totals.total_value_scaled)}</span>
            </span>
            {response.totals.negative_batches > 0 ? <Badge tone="danger">{response.totals.negative_batches} negative</Badge> : null}
            {response.totals.expiring_batches > 0 ? <Badge tone="warning">{response.totals.expiring_batches} expiring</Badge> : null}
            {negativeOnly ? <Badge tone="danger">negative filter</Badge> : null}
          </div>
        ) : (
          <span>Run a query</span>
        )
      }
    >
      <div className="space-y-3">
        <Panel>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
            <Field label="Search product / batch / code" className="md:col-span-2">
              <TextInput value={query} data-nav-index={1} onChange={(event) => setQuery(event.target.value)} />
            </Field>
            <Field label="Godown">
              <Select value={godownId} data-nav-index={2} onChange={(event) => setGodownId(event.target.value)}>
                <option value="">All godowns</option>
                {lookups.godowns.map((godown) => (
                  <option key={godown.id} value={godown.id}>
                    {godown.code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Expiry within">
              <Select value={expiryMonths} data-nav-index={3} onChange={(event) => setExpiryMonths(event.target.value)}>
                <option value="">Any expiry</option>
                <option value="1">1 month</option>
                <option value="3">3 months</option>
                <option value="6">6 months</option>
                <option value="12">12 months</option>
              </Select>
            </Field>
            <Field label="Options">
              <div className="flex h-7 flex-wrap items-center gap-3 rounded-[3px] border border-line bg-white px-2 text-[10px]">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={onlyInStock}
                    data-nav-index={4}
                    onChange={(event) => setOnlyInStock(event.target.checked)}
                    className="h-3 w-3 accent-teal"
                  />
                  In stock only
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={negativeOnly}
                    data-nav-index={5}
                    onChange={(event) => setNegativeOnly(event.target.checked)}
                    className="h-3 w-3 accent-crimson"
                  />
                  Negative
                </label>
              </div>
            </Field>
          </div>
          {query || godownId || expiryMonths || negativeOnly || !onlyInStock ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setGodownId("");
                setExpiryMonths("");
                setNegativeOnly(false);
                setOnlyInStock(true);
              }}
              className="mt-2 inline-flex items-center gap-1 text-[9.5px] font-semibold text-inkmut hover:text-ink"
            >
              <FilterX size={11} /> Reset filters
            </button>
          ) : null}
        </Panel>

        <Panel bodyClassName="p-0">
          <div className="max-h-[540px] overflow-auto">
            <table className="ledger-table min-w-[1000px]">
              <thead>
                <tr>
                  <th className="text-left">Product</th>
                  <th className="text-left">Batch</th>
                  <th className="text-left">Expiry</th>
                  <th className="text-right">Stock</th>
                  <th className="text-right">GST stock</th>
                  <th className="text-right">MRP</th>
                  <th className="text-right">S.Rate</th>
                  <th className="text-right">P.Rate</th>
                  <th className="text-right">NetRate</th>
                  <th className="text-right">Value</th>
                  <th className="text-center">Gdn</th>
                </tr>
              </thead>
              <tbody>
                {loading && !response ? (
                  <tr>
                    <td colSpan={11} className="py-8 text-center text-[10.5px] text-inkmut">
                      Running query…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-8 text-center text-[10.5px] text-inkmut">
                      No batches match these filters.
                    </td>
                  </tr>
                ) : (
                  rows.map((row: StockQueryRow) => {
                    const expiring = isNearExpiry(row.expiry_sort_key);
                    return (
                      <tr key={row.batch_id}>
                        <td>
                          <div className="font-semibold">{row.product_name}</div>
                          <div className="text-[9px] text-inkmut">
                            #{row.pro_code} · {row.company_name} · {row.pack_form}
                          </div>
                        </td>
                        <td className="font-mono">{row.batch_no}</td>
                        <td className={cx("font-mono text-[10px]", expiring && "font-bold text-[#8a5a10]")}>
                          {row.expiry_mm_yy}
                          {expiring ? <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent" /> : null}
                        </td>
                        <td className={cx("text-right font-mono font-semibold", row.cur_qty < 0 ? "text-crimson" : "")}>
                          {row.cur_qty}
                        </td>
                        <td className="text-right font-mono text-[10px] text-inkmut">{row.tax_stock_qty}</td>
                        <td className="text-right font-mono text-[10px]">{formatMoney(row.mrp_scaled)}</td>
                        <td className="text-right font-mono text-[10px]">{formatMoney(row.s_rate_scaled)}</td>
                        <td className="text-right font-mono text-[10px]">{formatMoney(row.p_rate_scaled)}</td>
                        <td className="text-right font-mono text-[10px] text-teal">{formatRate4(row.net_rate_scaled)}</td>
                        <td className="text-right font-mono text-[10px]">₹{formatMoney(row.stock_value_scaled)}</td>
                        <td className="text-center font-mono text-[9.5px] uppercase text-inkmut">{row.godown_code}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="flex items-center gap-2 text-[9.5px] text-inkmut">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" /> amber expiry is within 3 months
          <span className="ml-3 h-1.5 w-1.5 rounded-full bg-crimson" /> crimson is negative stock
          <span className="ml-auto">Source: batch register</span>
        </div>
      </div>
    </FormShell>
  );
}

function isNearExpiry(expiryKey: number): boolean {
  const now = new Date();
  const current = now.getFullYear() * 100 + now.getMonth() + 1;
  const total = Math.floor(current / 100) * 12 + (current % 100) + 2;
  const threshold = Math.floor(total / 12) * 100 + (total % 12) + 1;
  return expiryKey <= threshold;
}
