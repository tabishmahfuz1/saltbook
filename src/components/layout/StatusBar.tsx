import { useEffect, useState } from "react";
import { api } from "../../lib/invoke";
import type { WindowSummary } from "../../types/database";
import { formatMoney } from "../../lib/format";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { cx } from "../ui/kit";

function Item({
  label,
  value,
  tone = "neutral",
  title,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn" | "bad" | "good";
  title?: string;
}) {
  const tones = {
    neutral: "text-ink",
    warn: "text-[#8a5a10]",
    bad: "text-crimson",
    good: "text-teal",
  };
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" title={title}>
      <span className="text-[8.5px] font-semibold uppercase tracking-[0.12em] text-inkmut/80">{label}</span>
      <span className={cx("font-mono text-[10.5px] font-semibold tabular-nums", tones[tone])}>{value}</span>
    </span>
  );
}

export function StatusBar() {
  const [summary, setSummary] = useState<WindowSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const windows = useWorkspaceStore((state) => state.windows);
  const activeId = useWorkspaceStore((state) => state.activeId);
  const dirty = useWorkspaceStore((state) => state.dirty);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.summary();
        if (!cancelled) {
          setSummary(data);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "offline");
      }
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const active = windows.find((window) => window.id === activeId);

  return (
    <footer className="flex h-[26px] shrink-0 items-center justify-between gap-4 border-t border-line bg-[#e9e3d4] px-3 text-[10px] text-inkmut">
      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-[0.14em] text-teal">
          <span className="h-1.5 w-1.5 rounded-full bg-teal" />
          {error ? "Offline" : "Ready"}
        </span>
        <span className="h-3 w-px bg-line" />
        {summary ? (
          <>
            <Item label="Products" value={String(summary.products)} />
            <Item label="Parties" value={String(summary.parties)} />
            <Item label="Suppliers" value={String(summary.suppliers)} />
            <Item label="Today" value={`₹${formatMoney(summary.today_sales_scaled)}`} tone="good" />
            <Item label="Month" value={`₹${formatMoney(summary.month_sales_scaled)}`} />
            <Item label="Receivable" value={`₹${formatMoney(summary.receivables_scaled)}`} tone={summary.receivables_scaled > 0 ? "warn" : "neutral"} />
            <Item label="Low" value={String(summary.low_stock)} tone={summary.low_stock > 0 ? "warn" : "neutral"} />
            <Item label="Expiry" value={String(summary.expiring)} tone={summary.expiring > 0 ? "warn" : "neutral"} />
            <Item label="Negative" value={String(summary.negative_stock)} tone={summary.negative_stock > 0 ? "bad" : "neutral"} />
            <Item label="Queue" value={String(summary.pending_outbox)} />
          </>
        ) : (
          <span className="text-[9.5px] uppercase tracking-wider text-inkmut/60">Loading register totals…</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {active ? (
          <span className="flex items-center gap-1.5">
            <span className="text-[8.5px] uppercase tracking-[0.12em] text-inkmut/70">Window</span>
            <span className="max-w-[220px] truncate font-semibold text-ink">{active.title}</span>
            {dirty[active.id] ? <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Unsaved changes" /> : null}
          </span>
        ) : (
          <span className="text-[8.5px] uppercase tracking-[0.12em] text-inkmut/60">Command centre</span>
        )}
        <span className="hidden items-center gap-1 text-[8.5px] uppercase tracking-wider text-inkmut/60 lg:flex">
          <kbd className="rounded border border-line bg-white/60 px-1 font-mono text-[8px]">Enter</kbd> Next
          <kbd className="ml-1 rounded border border-line bg-white/60 px-1 font-mono text-[8px]">Esc</kbd> Back
          <kbd className="ml-1 rounded border border-line bg-white/60 px-1 font-mono text-[8px]">Ctrl+E</kbd> Edit
          <kbd className="ml-1 rounded border border-line bg-white/60 px-1 font-mono text-[8px]">F9</kbd> Backup
        </span>
      </div>
    </footer>
  );
}
