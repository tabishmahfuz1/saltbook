import { create } from "zustand";
import { useWorkspaceStore } from "./useWorkspaceStore";

export type ShortcutAction =
  | "NEW_SALE"
  | "BILL_MODIFY"
  | "PRODUCT"
  | "PARTY"
  | "SUPPLIER"
  | "COMPANY"
  | "STOCK_QUERY"
  | "SUBSTITUTES"
  | "EDIT"
  | "SAVE"
  | "CONVERT"
  | "PROVISIONAL"
  | "BACKUP_EXIT"
  | "ESCAPE";

interface ShortcutsState {
  bindings: Partial<Record<ShortcutAction, () => void>>;
  activeMenu: string | null;
  setBindings: (bindings: Partial<Record<ShortcutAction, () => void>>) => void;
  setActiveMenu: (menu: string | null) => void;
}

export const useShortcutsStore = create<ShortcutsState>((set) => ({
  bindings: {},
  activeMenu: null,
  setBindings: (bindings) => set({ bindings }),
  setActiveMenu: (activeMenu) => set({ activeMenu }),
}));

const MENU_KEYS: Record<string, string> = {
  s: "setup",
  p: "purchase",
  a: "sale",
  j: "adjustment",
  c: "accounts",
  w: "window",
  r: "report",
  l: "alert",
};

function run(action: ShortcutAction) {
  const binding = useShortcutsStore.getState().bindings[action];
  if (binding) binding();
}

function controllerForActive() {
  const state = useWorkspaceStore.getState();
  if (!state.activeId) return undefined;
  return state.controllers[state.activeId];
}

/**
 * Global SOLVI-classic keymap. Installed once by <App />.
 */
export function installGlobalShortcuts(): () => void {
  const handler = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    const shortcuts = useShortcutsStore.getState();

    if (event.altKey && !mod && !event.shiftKey) {
      const menu = MENU_KEYS[key];
      if (menu) {
        event.preventDefault();
        shortcuts.setActiveMenu(shortcuts.activeMenu === menu ? null : menu);
        return;
      }
      if (key === "b") {
        const controller = controllerForActive();
        if (controller?.provisionalBatch) {
          event.preventDefault();
          run("PROVISIONAL");
        }
        return;
      }
    }

    if (mod) {
      if (key === "s") {
        event.preventDefault();
        const controller = controllerForActive();
        if (controller?.save) run("SAVE");
        else run("SUPPLIER");
        return;
      }
      if (key === "e") {
        event.preventDefault();
        const controller = controllerForActive();
        if (controller?.unlockEdit) run("EDIT");
        return;
      }
      if (key === "m") {
        event.preventDefault();
        const controller = controllerForActive();
        if (controller?.convert) run("CONVERT");
        else run("BILL_MODIFY");
        return;
      }
      const map: Record<string, ShortcutAction> = {
        a: "NEW_SALE",
        d: "BILL_MODIFY",
        p: "PRODUCT",
        y: "PARTY",
        l: "COMPANY",
        q: "STOCK_QUERY",
        r: "SUBSTITUTES",
      };
      const action = map[key];
      if (action) {
        event.preventDefault();
        run(action);
      }
      return;
    }

    if (event.key === "F9") {
      event.preventDefault();
      run("BACKUP_EXIT");
      return;
    }

    if (event.key === "Escape") {
      if (shortcuts.activeMenu) {
        event.preventDefault();
        shortcuts.setActiveMenu(null);
        return;
      }
      if (useWorkspaceStore.getState().confirmExitId) return;
      const controller = controllerForActive();
      if (controller?.escape?.()) {
        event.preventDefault();
        return;
      }
      if (useWorkspaceStore.getState().activeId) {
        event.preventDefault();
        run("ESCAPE");
      }
    }
  };

  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}
