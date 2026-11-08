import { useEffect, useRef } from "react";
import { AlertTriangle, BellRing, Pause, Play, PackageMinus, X } from "lucide-react";
import { useTickerStore } from "../../stores/useTickerStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { cx } from "../ui/kit";
import { formatQty } from "../../lib/format";

const severityStyles: Record<string, { dot: string; text: string }> = {
  EXPIRED: { dot: "bg-crimson", text: "text-crimson" },
  NEGATIVE: { dot: "bg-crimson", text: "text-crimson" },
  CRITICAL: { dot: "bg-accent", text: "text-[#8a5a10]" },
  WARNING: { dot: "bg-amber-400", text: "text-[#8a5a10]" },
  INFO: { dot: "bg-teal", text: "text-teal" },
};

export function BottomAlertTicker() {
  const alerts = useTickerStore((state) => state.alerts);
  const loading = useTickerStore((state) => state.loading);
  const paused = useTickerStore((state) => state.paused);
  const setPaused = useTickerStore((state) => state.setPaused);
  const refresh = useTickerStore((state) => state.refresh);
  const menu = useTickerStore((state) => state.menu);
  const openMenu = useTickerStore((state) => state.openMenu);
  const closeMenu = useTickerStore((state) => state.closeMenu);
  const openWindow = useWorkspaceStore((state) => state.openWindow);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 90_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!menu) return;
    const handler = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) closeMenu();
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", esc);
    };
  }, [menu, closeMenu]);

  const chips = alerts.length > 0 ? [...alerts, ...alerts] : [];

  return (
    <div className="relative z-20 flex h-[34px] shrink-0 items-stretch border-t border-navydeep/40 bg-[#16263c]">
      <div className="flex shrink-0 items-center gap-1.5 border-r border-white/10 bg-accent/90 px-2.5 text-white">
        <BellRing size={12} />
        <span className="text-[9px] font-bold uppercase tracking-[0.16em]">Near expiry</span>
        <span className="rounded-[2px] bg-black/20 px-1 font-mono text-[9px]">{alerts.length}</span>
      </div>
      <div
        className="relative min-w-0 flex-1 overflow-hidden"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {loading && alerts.length === 0 ? (
          <div className="flex h-full items-center px-3 text-[10px] uppercase tracking-widest text-white/40">
            Reading batch expiry register…
          </div>
        ) : alerts.length === 0 ? (
          <div className="flex h-full items-center gap-2 px-3 text-[10px] uppercase tracking-widest text-white/40">
            <span className="h-1.5 w-1.5 rounded-full bg-[#5eead4]" /> No near-expiry or negative-stock batches
          </div>
        ) : (
          <div
            className={cx(
              "ticker-track flex h-full w-max items-center gap-0 whitespace-nowrap",
              paused && "ticker-paused",
            )}
          >
            {chips.map((alert, index) => {
              const style = severityStyles[alert.severity] ?? severityStyles.INFO;
              return (
                <button
                  key={`${alert.batch_id}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openMenu(alert, event.clientX, event.clientY);
                  }}
                  className="group flex h-full items-center gap-2 border-r border-white/[0.07] px-3 text-left hover:bg-white/[0.07]"
                  title="Click for actions"
                >
                  <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} />
                  <span className="text-[10.5px] font-medium text-white/80 group-hover:text-white">
                    {alert.product_name}
                  </span>
                  <span className="font-mono text-[9.5px] text-white/45">
                    {alert.batch_no} · {alert.expiry_mm_yy}
                  </span>
                  <span className={cx("font-mono text-[9.5px]", alert.severity === "EXPIRED" || alert.severity === "NEGATIVE" ? "text-[#fca5a5]" : "text-[#fcd34d]")}>
                    {alert.severity === "EXPIRED"
                      ? "EXPIRED"
                      : alert.severity === "NEGATIVE"
                        ? `NEG ${alert.cur_qty}`
                        : `${alert.days_to_expiry}d`}
                  </span>
                  <span className="font-mono text-[9.5px] text-white/35">
                    {formatQty(alert.cur_qty)} on hand
                  </span>
                  <span className="h-1 w-px bg-white/10" />
                </button>
              );
            })}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setPaused(!paused)}
        className="grid w-8 shrink-0 place-items-center border-l border-white/10 text-white/40 hover:bg-white/5 hover:text-white"
        title={paused ? "Resume ticker" : "Pause ticker"}
      >
        {paused ? <Play size={11} /> : <Pause size={11} />}
      </button>

      {menu ? (
        <div
          ref={menuRef}
          className="fixed z-[80] w-[310px] overflow-hidden rounded-[4px] border border-line bg-white shadow-window"
          style={{
            left: Math.min(menu.x, window.innerWidth - 330),
            top: Math.max(10, menu.y - 168),
          }}
        >
          <div className="flex items-start justify-between gap-2 border-b border-line bg-parchment/70 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-[11.5px] font-bold text-navy">{menu.alert.product_name}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[9.5px] text-inkmut">
                <AlertTriangle size={10} />
                Batch {menu.alert.batch_no} · Exp {menu.alert.expiry_mm_yy} · {menu.alert.godown_code}
              </div>
            </div>
            <button type="button" onClick={closeMenu} className="text-inkmut hover:text-ink">
              <X size={12} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2 border-b border-line/70 px-3 py-2 text-center">
            <div>
              <div className="text-[8.5px] uppercase tracking-wider text-inkmut">On hand</div>
              <div className="font-mono text-[13px] font-semibold">{menu.alert.cur_qty}</div>
            </div>
            <div>
              <div className="text-[8.5px] uppercase tracking-wider text-inkmut">Days</div>
              <div className="font-mono text-[13px] font-semibold">{menu.alert.days_to_expiry}</div>
            </div>
            <div>
              <div className="text-[8.5px] uppercase tracking-wider text-inkmut">Severity</div>
              <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">{menu.alert.severity}</div>
            </div>
          </div>
          <div className="p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-[11px] hover:bg-skybg"
              onClick={() => {
                openWindow("PRODUCT_MASTER", { pro_code: menu.alert.pro_code, batch_id: menu.alert.batch_id });
                closeMenu();
              }}
            >
              <PackageMinus size={12} className="text-inkmut" />
              Open in Product Master
              <span className="ml-auto font-mono text-[9px] text-inkmut">Ctrl+P</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-[11px] hover:bg-crimsonbg"
              onClick={() => {
                openWindow("STOCK_ADJUSTMENT", {
                  adj_type: "BREAKAGE_EXPIRY",
                  product_id: menu.alert.product_id,
                  batch_id: menu.alert.batch_id,
                });
                closeMenu();
              }}
            >
              <AlertTriangle size={12} className="text-crimson" />
              Write off in Breakage / Expiry
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
