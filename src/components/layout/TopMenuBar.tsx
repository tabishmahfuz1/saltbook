import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  Bell,
  Boxes,
  ChartNoAxesColumnIncreasing,
  CircleDollarSign,
  CloudUpload,
  FileSpreadsheet,
  HardDriveDownload,
  PackageSearch,
  Receipt,
  Search,
  Settings2,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Wallet,
} from "lucide-react";
import { useWorkspaceStore, type WindowKind } from "../../stores/useWorkspaceStore";
import { useShortcutsStore } from "../../stores/useShortcutsStore";
import { useToastStore } from "../../stores/useToastStore";
import { api } from "../../lib/invoke";
import { Badge, Kbd, cx } from "../ui/kit";

interface MenuItem {
  label: string;
  shortcut?: string;
  icon?: ReactNode;
  onSelect?: () => void;
  divider?: boolean;
  hint?: string;
}

interface MenuDef {
  key: string;
  label: string;
  mnemonic: string;
  items: MenuItem[];
}

export function TopMenuBar() {
  const openWindow = useWorkspaceStore((state) => state.openWindow);
  const windows = useWorkspaceStore((state) => state.windows);
  const activeId = useWorkspaceStore((state) => state.activeId);
  const focusWindow = useWorkspaceStore((state) => state.focusWindow);
  const closeAll = useWorkspaceStore((state) => state.closeAll);
  const dirty = useWorkspaceStore((state) => state.dirty);
  const activeMenu = useShortcutsStore((state) => state.activeMenu);
  const setActiveMenu = useShortcutsStore((state) => state.setActiveMenu);
  const pushToast = useToastStore((state) => state.push);
  const navRef = useRef<HTMLDivElement | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [deviceName, setDeviceName] = useState("FRONT DESK");
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const status = await api.syncStatus();
        if (cancelled) return;
        setDeviceName(status.device_name || "FRONT DESK");
        setConnected(status.connected);
        setPending(status.pending_outbox);
      } catch {
        /* offline preview keeps defaults */
      }
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(event.target as Node)) setActiveMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [setActiveMenu]);

  const open = (kind: WindowKind, payload: Record<string, unknown> = {}, singleton = true) => {
    openWindow(kind, payload, { singleton });
    setActiveMenu(null);
  };

  const backupNow = async () => {
    try {
      const result = await api.backupNow();
      pushToast(result.message, result.uploaded ? "success" : "info");
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Backup failed", "error");
    }
    setActiveMenu(null);
  };

  const menus: MenuDef[] = useMemo(
    () => [
      {
        key: "setup",
        label: "Setup",
        mnemonic: "S",
        items: [
          { label: "Product Master", shortcut: "Ctrl+P", icon: <Boxes size={13} />, onSelect: () => open("PRODUCT_MASTER") },
          { label: "Party Master", shortcut: "Ctrl+Y", icon: <CircleDollarSign size={13} />, onSelect: () => open("PARTY_MASTER") },
          { label: "Supplier Master", shortcut: "Ctrl+S", icon: <ShoppingCart size={13} />, onSelect: () => open("SUPPLIER_MASTER") },
          { label: "Company & Lookups", shortcut: "Ctrl+L", icon: <Settings2 size={13} />, onSelect: () => open("COMPANY_MASTER") },
          { label: "", divider: true },
          { label: "Google Drive Sync", icon: <CloudUpload size={13} />, onSelect: () => open("GDRIVE_SYNC") },
          { label: "SOLVI Migration Wizard", icon: <HardDriveDownload size={13} />, onSelect: () => open("SOLVI_MIGRATION") },
          {
            label: "Load Demo Catalog",
            icon: <Sparkles size={13} />,
            hint: "dev",
            onSelect: () => {
              setActiveMenu(null);
              api
                .seedDemo()
                .then((result) => pushToast(`Demo catalog ready: ${result.products} products`, "success"))
                .catch((error) => pushToast(error instanceof Error ? error.message : "Seed failed", "error"));
            },
          },
        ],
      },
      {
        key: "purchase",
        label: "Purchase",
        mnemonic: "P",
        items: [
          { label: "Purchase Invoice", icon: <Receipt size={13} />, onSelect: () => open("PURCHASE_INVOICE", {}, false) },
          { label: "Import Supplier File", icon: <FileSpreadsheet size={13} />, onSelect: () => open("PURCHASE_IMPORT") },
          { label: "Purchase Register", icon: <Archive size={13} />, onSelect: () => open("PURCHASE_REGISTER") },
        ],
      },
      {
        key: "sale",
        label: "Sale",
        mnemonic: "A",
        items: [
          { label: "New Sale / Estimate", shortcut: "Ctrl+A", icon: <Receipt size={13} />, onSelect: () => open("SALES_INVOICE", { mode: "new" }, false) },
          { label: "Bill Modify", shortcut: "Ctrl+D", icon: <SlidersHorizontal size={13} />, onSelect: () => open("BILL_MODIFY") },
          { label: "Sales Register", icon: <Archive size={13} />, onSelect: () => open("SALES_REGISTER", { register: true }) },
          { label: "", divider: true },
          { label: "Salt Substitutes", shortcut: "Ctrl+R", icon: <PackageSearch size={13} />, onSelect: () => open("SUBSTITUTE_DRAWER") },
        ],
      },
      {
        key: "adjustment",
        label: "Adjustment",
        mnemonic: "J",
        items: [
          { label: "Breakage / Expiry", icon: <Archive size={13} />, onSelect: () => open("STOCK_ADJUSTMENT", { adj_type: "BREAKAGE_EXPIRY" }) },
          { label: "Godown Transfer", onSelect: () => open("STOCK_ADJUSTMENT", { adj_type: "GODOWN_TRANSFER" }) },
          { label: "Stock SurPlus", onSelect: () => open("STOCK_ADJUSTMENT", { adj_type: "STOCK_SURPLUS" }) },
          { label: "Stock Shortage", onSelect: () => open("STOCK_ADJUSTMENT", { adj_type: "STOCK_SHORTAGE" }) },
          { label: "Sample Issue", onSelect: () => open("STOCK_ADJUSTMENT", { adj_type: "SAMPLE_ISSUE" }) },
          { label: "", divider: true },
          { label: "Credit Note", onSelect: () => open("STOCK_ADJUSTMENT", { adj_type: "CREDIT_NOTE" }) },
          { label: "Debit Note", onSelect: () => open("STOCK_ADJUSTMENT", { adj_type: "DEBIT_NOTE" }) },
          { label: "", divider: true },
          { label: "Adjustment Register", onSelect: () => open("ADJUSTMENT_REGISTER") },
        ],
      },
      {
        key: "accounts",
        label: "Accounts",
        mnemonic: "C",
        items: [
          { label: "Receipts", shortcut: "RCP", icon: <Wallet size={13} />, onSelect: () => open("VOUCHER_ENTRY", { voucher_type: "RECEIPT" }) },
          { label: "Payments", onSelect: () => open("VOUCHER_ENTRY", { voucher_type: "PAYMENT" }) },
          { label: "Contra", onSelect: () => open("VOUCHER_ENTRY", { voucher_type: "CONTRA" }) },
          { label: "Journal", onSelect: () => open("VOUCHER_ENTRY", { voucher_type: "JOURNAL" }) },
          { label: "PaySlip", onSelect: () => open("VOUCHER_ENTRY", { voucher_type: "PAYSLIP" }) },
          { label: "", divider: true },
          { label: "Voucher Register", onSelect: () => open("VOUCHER_REGISTER") },
        ],
      },
      {
        key: "window",
        label: "Window",
        mnemonic: "W",
        items: [
          ...(windows.length === 0
            ? [{ label: "No windows open", hint: "empty" }]
            : windows.map((window) => ({
                label: `${window.title}${window.id === activeId ? " ●" : ""}${dirty[window.id] ? " *" : ""}`,
                hint: window.kind,
                onSelect: () => {
                  focusWindow(window.id);
                  setActiveMenu(null);
                },
              }))),
          { label: "", divider: true },
          { label: "Close All Windows", onSelect: () => { closeAll(); setActiveMenu(null); } },
        ],
      },
      {
        key: "report",
        label: "Report",
        mnemonic: "R",
        items: [
          { label: "Stock Query", shortcut: "Ctrl+Q", icon: <PackageSearch size={13} />, onSelect: () => open("STOCK_QUERY") },
          { label: "Composition Query", onSelect: () => open("COMPOSITION_QUERY") },
          { label: "Sales Report", icon: <ChartNoAxesColumnIncreasing size={13} />, onSelect: () => open("SALES_REPORT") },
          { label: "Ledger Statement", icon: <Archive size={13} />, onSelect: () => open("LEDGER_REPORT") },
        ],
      },
      {
        key: "alert",
        label: "Alert & Reminder",
        mnemonic: "L",
        items: [
          { label: "Near Expiry Stock", icon: <Bell size={13} />, onSelect: () => open("STOCK_QUERY", { expiry_within_months: 3 }) },
          { label: "Negative Stock", onSelect: () => open("STOCK_QUERY", { negative_only: true }) },
          { label: "Open Credit Bills", onSelect: () => open("SALES_REGISTER", { due_only: true }) },
          { label: "", divider: true },
          { label: "Backup Now", shortcut: "F9", icon: <CloudUpload size={13} />, onSelect: backupNow },
        ],
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windows, activeId, dirty, pushToast],
  );

  const activeMenuDef = menus.find((menu) => menu.key === activeMenu);

  return (
    <header className="relative z-30 shrink-0 select-none">
      <div className="bg-header-sheen text-white">
        <div className="flex h-12 items-center justify-between gap-4 px-3">
          <div className="flex items-center gap-3">
            <div className="relative grid h-8 w-8 place-items-center rounded-[4px] border border-white/25 bg-white/10 shadow-inner">
              <span className="text-[15px] font-black leading-none tracking-tight">S</span>
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-navy" />
            </div>
            <div className="leading-none">
              <div className="flex items-baseline gap-2">
                <span className="text-[17px] font-black tracking-[0.14em]">SALTBOOK</span>
                <span className="hidden text-[8px] font-semibold uppercase tracking-[0.22em] text-white/45 sm:inline">
                  Pharma ERP
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[8.5px] uppercase tracking-[0.16em] text-white/50">
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#5eead4]" /> SQLite WAL · offline ready
                </span>
                <span className="hidden md:inline">·</span>
                <span className="hidden md:inline">{pending} queued</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => open("PRODUCT_MASTER", { focus_search: true })}
            className="hidden min-w-0 flex-1 items-center gap-2 rounded-[3px] border border-white/15 bg-white/[0.06] px-2.5 py-1.5 text-left text-[11px] text-white/55 transition hover:border-white/30 hover:bg-white/10 hover:text-white/80 md:flex"
          >
            <Search size={13} className="shrink-0" />
            <span className="truncate">Search medicines, salts, companies…</span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <Kbd className="border-white/20 bg-white/10 text-white/70">Ctrl</Kbd>
              <Kbd className="border-white/20 bg-white/10 text-white/70">P</Kbd>
            </span>
          </button>

          <div className="flex items-center gap-3 text-right">
            <div className="hidden leading-tight sm:block">
              <div className="text-[10.5px] font-semibold tracking-wide">{deviceName}</div>
              <div className="text-[8.5px] uppercase tracking-[0.16em] text-white/50">
                {clock.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" })} ·{" "}
                {clock.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
            <span
              className={cx(
                "inline-flex items-center gap-1.5 rounded-[3px] border px-2 py-1 text-[9px] font-semibold uppercase tracking-wider",
                connected
                  ? "border-[#5eead4]/40 bg-[#5eead4]/10 text-[#99f6e4]"
                  : "border-white/20 bg-white/5 text-white/60",
              )}
            >
              <span className={cx("h-1.5 w-1.5 rounded-full", connected ? "bg-[#5eead4]" : "bg-white/40")} />
              {connected ? "Drive linked" : "Local only"}
            </span>
            <button
              type="button"
              onClick={backupNow}
              title="Backup now"
              className="grid h-7 w-7 place-items-center rounded-[3px] border border-white/15 bg-white/5 text-white/65 hover:bg-white/10 hover:text-white"
            >
              <CloudUpload size={13} />
            </button>
          </div>
        </div>
      </div>

      <div ref={navRef} className="border-b border-navydeep/40 bg-navydeep text-white/80">
        <div className="flex h-8 items-stretch">
          {menus.map((menu) => (
            <button
              key={menu.key}
              type="button"
              onClick={() => {
                setActiveMenu(activeMenu === menu.key ? null : menu.key);
              }}
              onMouseEnter={() => {
                if (activeMenu && activeMenu !== menu.key) setActiveMenu(menu.key);
              }}
              className={cx(
                "px-3 text-[10.5px] font-semibold uppercase tracking-[0.1em] transition",
                activeMenu === menu.key
                  ? "bg-paper text-navy"
                  : "text-white/70 hover:bg-white/10 hover:text-white",
              )}
            >
              <MenuLabel label={menu.label} mnemonic={menu.mnemonic} />
            </button>
          ))}
          <div className="ml-auto flex items-center gap-3 px-3 text-[9px] uppercase tracking-[0.14em] text-white/35">
            <span className="hidden lg:inline">Alt + underlined key to open menus</span>
            <span className="hidden items-center gap-1 lg:flex">
              <Kbd className="border-white/15 bg-white/5 text-white/60">Enter</Kbd> next field
            </span>
            <span className="hidden items-center gap-1 xl:flex">
              <Kbd className="border-white/15 bg-white/5 text-white/60">Esc</Kbd> back
            </span>
          </div>
        </div>

        {activeMenuDef ? (
          <div className="absolute left-0 top-full z-40 w-[286px] border-r border-line bg-paper text-ink shadow-window">
            <div className="border-b border-line bg-parchment/70 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.16em] text-inkmut">
              {activeMenuDef.label}
            </div>
            <div className="py-1">
              {activeMenuDef.items.map((item, index) =>
                item.divider ? (
                  <div key={`divider-${index}`} className="mx-2 my-1 h-px bg-line/70" />
                ) : (
                  <button
                    key={`${item.label}-${index}`}
                    type="button"
                    disabled={!item.onSelect}
                    onClick={() => item.onSelect?.()}
                    className={cx(
                      "flex w-full items-center gap-2 px-3 py-[7px] text-left text-[11.5px]",
                      item.onSelect ? "hover:bg-skybg" : "cursor-default text-inkmut/60",
                    )}
                  >
                    <span className="grid w-4 place-items-center text-inkmut/70">{item.icon}</span>
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.hint ? <Badge tone="neutral">{item.hint}</Badge> : null}
                    {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
                  </button>
                ),
              )}
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function MenuLabel({ label, mnemonic }: { label: string; mnemonic: string }) {
  const index = label.toLowerCase().indexOf(mnemonic.toLowerCase());
  if (index < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, index)}
      <span className="underline decoration-accent decoration-2 underline-offset-[3px]">{label[index]}</span>
      {label.slice(index + 1)}
    </>
  );
}

