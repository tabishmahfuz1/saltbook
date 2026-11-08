import { useEffect, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { TopMenuBar } from "./components/layout/TopMenuBar";
import { MdiWorkspace } from "./components/layout/MdiWorkspace";
import { BottomAlertTicker } from "./components/layout/BottomAlertTicker";
import { ConfirmExitModal } from "./components/layout/ConfirmExitModal";
import { StatusBar } from "./components/layout/StatusBar";
import { installGlobalShortcuts, useShortcutsStore } from "./stores/useShortcutsStore";
import { useWorkspaceStore } from "./stores/useWorkspaceStore";
import { useToastStore, type ToastTone } from "./stores/useToastStore";
import { api, isTauriRuntime } from "./lib/invoke";
import { cx } from "./components/ui/kit";

const toneStyles: Record<ToastTone, { box: string; icon: ReactNode }> = {
  success: { box: "border-[#b8d7c9] bg-mintbg text-[#0c5750]", icon: <CheckCircle2 size={14} /> },
  error: { box: "border-[#e6b8b3] bg-crimsonbg text-[#8f1d17]", icon: <AlertCircle size={14} /> },
  warning: { box: "border-amberline bg-amberbg text-[#7c5210]", icon: <AlertCircle size={14} /> },
  info: { box: "border-[#c6d4e6] bg-skybg text-navy", icon: <Info size={14} /> },
};

export default function App() {
  const setBindings = useShortcutsStore((state) => state.setBindings);
  const openWindow = useWorkspaceStore((state) => state.openWindow);
  const pushToast = useToastStore((state) => state.push);
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismiss);

  useEffect(() => {
    const dispose = installGlobalShortcuts();
    return dispose;
  }, []);

  useEffect(() => {
    const backupAndExit = async () => {
      try {
        const result = await api.backupNow();
        pushToast(result.message, result.uploaded ? "success" : "info");
      } catch (error) {
        pushToast(error instanceof Error ? error.message : "Backup before exit failed", "error");
      }
      if (isTauriRuntime()) {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().close();
        } catch {
          /* window close is best-effort */
        }
      }
    };

    const controller = () => {
      const state = useWorkspaceStore.getState();
      return state.activeId ? state.controllers[state.activeId] : undefined;
    };

    setBindings({
      NEW_SALE: () => openWindow("SALES_INVOICE", { mode: "new" }, { singleton: false }),
      BILL_MODIFY: () => openWindow("BILL_MODIFY"),
      PRODUCT: () => openWindow("PRODUCT_MASTER"),
      PARTY: () => openWindow("PARTY_MASTER"),
      SUPPLIER: () => openWindow("SUPPLIER_MASTER"),
      COMPANY: () => openWindow("COMPANY_MASTER"),
      STOCK_QUERY: () => openWindow("STOCK_QUERY"),
      SUBSTITUTES: () => {
        const active = controller();
        if (active?.substitutes) active.substitutes();
        else openWindow("SUBSTITUTE_DRAWER");
      },
      SAVE: () => controller()?.save?.(),
      EDIT: () => controller()?.unlockEdit?.(),
      CONVERT: () => controller()?.convert?.(),
      PROVISIONAL: () => controller()?.provisionalBatch?.(),
      ESCAPE: () => {
        const state = useWorkspaceStore.getState();
        if (state.activeId) state.requestClose(state.activeId);
      },
      BACKUP_EXIT: () => void backupAndExit(),
    });
  }, [openWindow, pushToast, setBindings]);

  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      pushToast(
        event.reason instanceof Error ? event.reason.message : "An unexpected background error occurred",
        "error",
      );
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, [pushToast]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper text-ink">
      <TopMenuBar />
      <MdiWorkspace />
      <BottomAlertTicker />
      <StatusBar />
      <ConfirmExitModal />

      <div className="pointer-events-none fixed bottom-14 right-3 z-[100] flex w-[340px] max-w-[calc(100vw-24px)] flex-col gap-1.5">
        {toasts.map((toast) => {
          const style = toneStyles[toast.tone];
          return (
            <div
              key={toast.id}
              className={cx(
                "pointer-events-auto flex items-start gap-2 rounded-[3px] border px-2.5 py-2 text-[11px] shadow-pop",
                style.box,
              )}
            >
              <span className="mt-[1px] shrink-0">{style.icon}</span>
              <span className="flex-1 leading-snug">{toast.message}</span>
              <button type="button" onClick={() => dismissToast(toast.id)} className="opacity-50 hover:opacity-90">
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
