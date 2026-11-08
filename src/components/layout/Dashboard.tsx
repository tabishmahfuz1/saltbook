import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CloudUpload,
  FileEdit,
  PackageSearch,
  ReceiptText,
  ShoppingCart,
  Sparkles,
  Users,
  Warehouse,
} from "lucide-react";
import { api, isTauriRuntime } from "../../lib/invoke";
import type { SalesInvoice, WindowSummary } from "../../types/database";
import { formatMoney, relativeTime } from "../../lib/format";
import { useTickerStore } from "../../stores/useTickerStore";
import { useWorkspaceStore, type WindowKind } from "../../stores/useWorkspaceStore";
import { useToastStore } from "../../stores/useToastStore";
import { Badge, Button, Kbd, Stat, cx } from "../ui/kit";

const quickActions: Array<{
  label: string;
  description: string;
  shortcut: string;
  icon: ReactNode;
  kind: WindowKind;
  payload?: Record<string, unknown>;
}> = [
  { label: "New Sale / Estimate", description: "Ctrl+A billing engine", shortcut: "Ctrl+A", icon: <ReceiptText size={15} />, kind: "SALES_INVOICE", payload: { mode: "new" } },
  { label: "Bill Modify", description: "Reopen and convert bills", shortcut: "Ctrl+D", icon: <FileEdit size={15} />, kind: "BILL_MODIFY" },
  { label: "Product Master", description: "FTS search and batch grid", shortcut: "Ctrl+P", icon: <Boxes size={15} />, kind: "PRODUCT_MASTER" },
  { label: "Purchase Invoice", description: "Inward and provisional merge", shortcut: "P", icon: <ShoppingCart size={15} />, kind: "PURCHASE_INVOICE" },
  { label: "Stock Query", description: "Batch-level stock and value", shortcut: "Ctrl+Q", icon: <PackageSearch size={15} />, kind: "STOCK_QUERY" },
  { label: "Google Drive Sync", description: "Snapshot and delta health", shortcut: "", icon: <CloudUpload size={15} />, kind: "GDRIVE_SYNC" },
];

export function Dashboard() {
  const openWindow = useWorkspaceStore((state) => state.openWindow);
  const alerts = useTickerStore((state) => state.alerts);
  const refreshTicker = useTickerStore((state) => state.refresh);
  const pushToast = useToastStore((state) => state.push);
  const [summary, setSummary] = useState<WindowSummary | null>(null);
  const [recent, setRecent] = useState<SalesInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [summaryData, invoices] = await Promise.all([api.summary(), api.listInvoices({ limit: 7 })]);
      setSummary(summaryData);
      setRecent(invoices.items);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to read the register");
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const seedDemo = async () => {
    setSeeding(true);
    try {
      const result = await api.seedDemo();
      pushToast(`Demo catalogue ready: ${result.products} products`, "success");
      await load();
      await refreshTicker();
    } catch (seedError) {
      pushToast(seedError instanceof Error ? seedError.message : "Unable to seed demo data", "error");
    } finally {
      setSeeding(false);
    }
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });

  return (
    <div className="min-h-full bg-mdi-grid p-3 md:p-4">
      <div className="mx-auto max-w-[1500px] space-y-3">
        <section className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-inkmut">
              <span className="h-1.5 w-1.5 rounded-full bg-teal" />
              Command centre · {today}
            </div>
            <h1 className="mt-1 text-[24px] font-bold leading-none tracking-[-0.02em] text-navy">
              {greeting}, <span className="text-teal">{isTauriRuntime() ? "Front Desk" : "Preview"}</span>
            </h1>
            <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-inkmut">
              {summary
                ? `${summary.products} SKUs on file · ${summary.parties} customers · ${summary.open_bills} open credit bills · ${summary.pending_outbox} queued changes.`
                : "Reading the local register…"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {summary && summary.products === 0 ? (
              <Button variant="accent" size="md" onClick={seedDemo} disabled={seeding}>
                <Sparkles size={13} /> {seeding ? "Seeding…" : "Load demo catalogue"}
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="md"
              shortcut="Ctrl+A"
              onClick={() => openWindow("SALES_INVOICE", { mode: "new" }, { singleton: false })}
            >
              <ReceiptText size={14} /> New Sale / Estimate
            </Button>
            <Button variant="default" size="md" shortcut="Ctrl+D" onClick={() => openWindow("BILL_MODIFY")}>
              <FileEdit size={14} /> Bill Modify
            </Button>
          </div>
        </section>

        {error ? (
          <div className="rounded-[4px] border border-[#e6b8b3] bg-crimsonbg px-3 py-2 text-[11px] text-[#8f1d17]">
            {error}
          </div>
        ) : null}

        <section className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Today's sales" value={`₹${formatMoney(summary?.today_sales_scaled ?? 0)}`} sub="Cash + credit" tone="good" />
          <Stat label="This month" value={`₹${formatMoney(summary?.month_sales_scaled ?? 0)}`} sub={`${summary?.invoices ?? 0} invoices`} />
          <Stat
            label="Receivables"
            value={`₹${formatMoney(summary?.receivables_scaled ?? 0)}`}
            sub={`${summary?.open_bills ?? 0} open bills`}
            tone={(summary?.receivables_scaled ?? 0) > 0 ? "warn" : "neutral"}
          />
          <Stat label="Low stock" value={summary?.low_stock ?? 0} sub="At or below Min Qty" tone={(summary?.low_stock ?? 0) > 0 ? "warn" : "neutral"} />
          <Stat label="Near expiry" value={summary?.expiring ?? 0} sub="Within 3 months" tone={(summary?.expiring ?? 0) > 0 ? "warn" : "neutral"} />
          <Stat
            label="Sync queue"
            value={summary?.pending_outbox ?? 0}
            sub={summary?.negative_stock ? `${summary.negative_stock} negative batches` : "Outbox ready"}
            tone={(summary?.negative_stock ?? 0) > 0 ? "bad" : "neutral"}
          />
        </section>

        <section className="grid gap-3 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <div className="overflow-hidden rounded-[4px] border border-line bg-white/70">
              <header className="flex items-center justify-between border-b border-line bg-parchment/60 px-3 py-2">
                <div>
                  <h2 className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-navy">Recent bills</h2>
                  <p className="text-[9.5px] text-inkmut">Latest estimates and GST invoices</p>
                </div>
                <Button variant="ghost" size="xs" onClick={() => openWindow("SALES_REGISTER", { register: true })}>
                  Sales register <ArrowUpRight size={11} />
                </Button>
              </header>
              <div className="max-h-[300px] overflow-auto">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th className="text-left">Inv. No</th>
                      <th className="text-left">Date</th>
                      <th className="text-left">Party</th>
                      <th className="text-center">Series</th>
                      <th className="text-right">Amount</th>
                      <th className="text-right">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-[10.5px] text-inkmut">
                          No bills yet. Press Ctrl+A to start the first sale.
                        </td>
                      </tr>
                    ) : (
                      recent.map((invoice) => (
                        <tr
                          key={invoice.id}
                          className="cursor-pointer"
                          onClick={() =>
                            openWindow(
                              "SALES_INVOICE",
                              { invoice_id: invoice.id, mode: "edit" },
                              {
                                singleton: false,
                                title: `${invoice.series_code === "E" ? "Estimate" : "Tax Invoice"} — ${invoice.inv_no_display}`,
                              },
                            )
                          }
                        >
                          <td className="font-mono font-semibold text-navy">{invoice.inv_no_display}</td>
                          <td className="font-mono text-[10px]">{invoice.inv_date_display}</td>
                          <td className="max-w-[240px] truncate">{invoice.party_name_snapshot}</td>
                          <td className="text-center">
                            <Badge tone={invoice.series_code === "E" ? "warning" : "success"}>{invoice.series_code}</Badge>
                          </td>
                          <td className="text-right font-mono font-semibold">₹{formatMoney(invoice.grand_total_scaled)}</td>
                          <td className={cx("text-right font-mono", invoice.due_amt_scaled > 0 ? "text-crimson" : "text-inkmut")}>
                            ₹{formatMoney(invoice.due_amt_scaled)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => openWindow(action.kind, action.payload ?? {}, { singleton: action.kind !== "SALES_INVOICE" && action.kind !== "PURCHASE_INVOICE" })}
                  className="group flex items-start gap-2 rounded-[4px] border border-line bg-white/60 px-3 py-2.5 text-left transition hover:-translate-y-[1px] hover:border-teal/50 hover:bg-white hover:shadow-[0_6px_16px_-12px_rgba(18,35,58,.6)]"
                >
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[3px] border border-line bg-parchment/70 text-navy group-hover:border-teal/30 group-hover:bg-mintbg group-hover:text-teal">
                    {action.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-ink">
                      {action.label}
                      {action.shortcut ? <Kbd className="ml-0.5">{action.shortcut}</Kbd> : null}
                    </span>
                    <span className="mt-0.5 block truncate text-[9.5px] text-inkmut">{action.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="overflow-hidden rounded-[4px] border border-line bg-white/70">
              <header className="flex items-center justify-between border-b border-line bg-parchment/60 px-3 py-2">
                <div>
                  <h2 className="flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-[0.12em] text-navy">
                    <AlertTriangle size={12} className="text-accent" /> Expiry watchlist
                  </h2>
                  <p className="text-[9.5px] text-inkmut">FEFO pressure and negative stock</p>
                </div>
                <Badge tone={alerts.length ? "warning" : "success"}>{alerts.length}</Badge>
              </header>
              <div className="max-h-[264px] overflow-auto">
                {alerts.length === 0 ? (
                  <div className="px-3 py-8 text-center text-[10.5px] text-inkmut">No near-expiry or negative batches.</div>
                ) : (
                  alerts.slice(0, 8).map((alert) => (
                    <button
                      key={alert.batch_id}
                      type="button"
                      onClick={() => openWindow("PRODUCT_MASTER", { pro_code: alert.pro_code, batch_id: alert.batch_id })}
                      className="flex w-full items-center gap-2 border-b border-line/50 px-3 py-1.5 text-left last:border-0 hover:bg-parchment/50"
                    >
                      <span
                        className={cx(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          alert.severity === "EXPIRED" || alert.severity === "NEGATIVE"
                            ? "bg-crimson"
                            : alert.severity === "CRITICAL"
                              ? "bg-accent"
                              : "bg-amber-400",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[10.5px] font-semibold">{alert.product_name}</span>
                        <span className="block font-mono text-[9px] text-inkmut">
                          {alert.batch_no} · {alert.expiry_mm_yy} · {alert.cur_qty} units
                        </span>
                      </span>
                      <span
                        className={cx(
                          "shrink-0 font-mono text-[9.5px] font-semibold",
                          alert.severity === "EXPIRED" || alert.severity === "NEGATIVE" ? "text-crimson" : "text-[#8a5a10]",
                        )}
                      >
                        {alert.severity === "EXPIRED"
                          ? "EXPIRED"
                          : alert.severity === "NEGATIVE"
                            ? "NEG"
                            : `${alert.days_to_expiry}d`}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-[4px] border border-line bg-white/60 px-3 py-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-navy">Operations</h2>
                <span className="flex items-center gap-1 text-[9px] text-inkmut">
                  <span className="h-1.5 w-1.5 rounded-full bg-teal" /> SQLite WAL
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px]">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-inkmut">
                    <Users size={11} /> Customers
                  </span>
                  <span className="font-mono font-semibold">{summary?.parties ?? 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-inkmut">
                    <ShoppingCart size={11} /> Suppliers
                  </span>
                  <span className="font-mono font-semibold">{summary?.suppliers ?? 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-inkmut">
                    <Warehouse size={11} /> Batches
                  </span>
                  <span className="font-mono font-semibold">{summary?.negative_stock ? `${summary.negative_stock} neg` : "healthy"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-inkmut">
                    <CloudUpload size={11} /> Queue
                  </span>
                  <span className="font-mono font-semibold">{summary?.pending_outbox ?? 0}</span>
                </div>
              </div>
              <div className="mt-2 border-t border-line/70 pt-1.5 text-[9px] text-inkmut">
                Last local write {relativeTime(Date.now())} · every mutation appends to the sync outbox.
              </div>
            </div>

            <div className="rounded-[4px] border border-line bg-[linear-gradient(135deg,#fbf5e8,#f3ecdc)] px-3 py-2.5">
              <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-[#7c5210]">Keyboard first</div>
              <div className="mt-1.5 grid grid-cols-2 gap-y-1 text-[9.5px] text-inkmut">
                <span className="flex items-center gap-1"><Kbd>Enter</Kbd> next field</span>
                <span className="flex items-center gap-1"><Kbd>Esc</Kbd> back / close</span>
                <span className="flex items-center gap-1"><Kbd>Ctrl+E</Kbd> unlock edit</span>
                <span className="flex items-center gap-1"><Kbd>F9</Kbd> backup + exit</span>
                <span className="flex items-center gap-1"><Kbd>Alt+B</Kbd> provisional</span>
                <span className="flex items-center gap-1"><Kbd>Ctrl+R</Kbd> substitutes</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
