import { create } from "zustand";

export type WindowKind =
  | "PRODUCT_MASTER"
  | "PARTY_MASTER"
  | "SUPPLIER_MASTER"
  | "COMPANY_MASTER"
  | "SALES_INVOICE"
  | "BILL_MODIFY"
  | "SALES_REGISTER"
  | "SUBSTITUTE_DRAWER"
  | "STOCK_QUERY"
  | "COMPOSITION_QUERY"
  | "SALES_REPORT"
  | "LEDGER_REPORT"
  | "PURCHASE_INVOICE"
  | "PURCHASE_IMPORT"
  | "PURCHASE_REGISTER"
  | "STOCK_ADJUSTMENT"
  | "ADJUSTMENT_REGISTER"
  | "VOUCHER_ENTRY"
  | "VOUCHER_REGISTER"
  | "GDRIVE_SYNC"
  | "SOLVI_MIGRATION";

export const WINDOW_META: Record<WindowKind, { title: string; shortcut?: string; group: string }> = {
  PRODUCT_MASTER: { title: "Product Master", shortcut: "Ctrl+P", group: "Setup" },
  PARTY_MASTER: { title: "Party Master", shortcut: "Ctrl+Y", group: "Setup" },
  SUPPLIER_MASTER: { title: "Supplier Master", shortcut: "Ctrl+S", group: "Setup" },
  COMPANY_MASTER: { title: "Company & Lookups", shortcut: "Ctrl+L", group: "Setup" },
  SALES_INVOICE: { title: "Sale / Estimate Invoice", shortcut: "Ctrl+A", group: "Sale" },
  BILL_MODIFY: { title: "Bill Modify", shortcut: "Ctrl+D", group: "Sale" },
  SALES_REGISTER: { title: "Sales Register", group: "Sale" },
  SUBSTITUTE_DRAWER: { title: "Salt Substitutes", shortcut: "Ctrl+R", group: "Sale" },
  STOCK_QUERY: { title: "Stock Query", shortcut: "Ctrl+Q", group: "Report" },
  COMPOSITION_QUERY: { title: "Composition Query", group: "Report" },
  SALES_REPORT: { title: "Sales Report", group: "Report" },
  LEDGER_REPORT: { title: "Ledger Statement", group: "Report" },
  PURCHASE_INVOICE: { title: "Purchase Invoice", group: "Purchase" },
  PURCHASE_IMPORT: { title: "Import Supplier File", group: "Purchase" },
  PURCHASE_REGISTER: { title: "Purchase Register", group: "Purchase" },
  STOCK_ADJUSTMENT: { title: "Stock Adjustment", group: "Adjustment" },
  ADJUSTMENT_REGISTER: { title: "Adjustment Register", group: "Adjustment" },
  VOUCHER_ENTRY: { title: "Voucher Entry", group: "Accounts" },
  VOUCHER_REGISTER: { title: "Voucher Register", group: "Accounts" },
  GDRIVE_SYNC: { title: "Google Drive Sync", group: "Setup" },
  SOLVI_MIGRATION: { title: "SOLVI Migration Wizard", group: "Setup" },
};

export interface WorkspaceWindow {
  id: string;
  kind: WindowKind;
  title: string;
  subtitle?: string;
  payload: Record<string, unknown>;
  openedAt: number;
}

export interface FormController {
  save?: () => void | Promise<unknown>;
  unlockEdit?: () => void;
  escape?: () => boolean;
  provisionalBatch?: () => void;
  convert?: () => void;
  addItem?: () => void;
  substitutes?: () => void;
  mode?: () => "VIEW" | "EDIT" | "NEW";
}

interface WorkspaceState {
  windows: WorkspaceWindow[];
  activeId: string | null;
  dirty: Record<string, boolean>;
  controllers: Record<string, FormController>;
  confirmExitId: string | null;
  lastClosed: WorkspaceWindow | null;
  openWindow: (
    kind: WindowKind,
    payload?: Record<string, unknown>,
    options?: { singleton?: boolean; title?: string; subtitle?: string },
  ) => string;
  closeWindow: (id: string) => void;
  requestClose: (id: string) => void;
  focusWindow: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  updateWindow: (id: string, patch: Partial<WorkspaceWindow>) => void;
  registerController: (id: string, controller: FormController) => void;
  unregisterController: (id: string) => void;
  setConfirmExit: (id: string | null) => void;
  closeAll: () => void;
  activeWindow: () => WorkspaceWindow | null;
  isActiveDirty: () => boolean;
}

let windowCounter = 0;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  windows: [],
  activeId: null,
  dirty: {},
  controllers: {},
  confirmExitId: null,
  lastClosed: null,

  openWindow: (kind, payload = {}, options = {}) => {
    const singleton = options.singleton ?? true;
    if (singleton) {
      const existing = get().windows.find((window) => window.kind === kind);
      if (existing) {
        set((state) => ({
          windows: state.windows.map((window) =>
            window.id === existing.id
              ? {
                  ...window,
                  payload: { ...window.payload, ...payload },
                  title: options.title ?? window.title,
                  subtitle: options.subtitle ?? window.subtitle,
                }
              : window,
          ),
          activeId: existing.id,
        }));
        return existing.id;
      }
    }
    windowCounter += 1;
    const id = `win-${Date.now()}-${windowCounter}`;
    const meta = WINDOW_META[kind];
    const window: WorkspaceWindow = {
      id,
      kind,
      title: options.title ?? meta.title,
      subtitle: options.subtitle,
      payload,
      openedAt: Date.now(),
    };
    set((state) => ({ windows: [...state.windows, window], activeId: id }));
    return id;
  },

  closeWindow: (id) =>
    set((state) => {
      const windows = state.windows.filter((window) => window.id !== id);
      const dirty = { ...state.dirty };
      delete dirty[id];
      const controllers = { ...state.controllers };
      delete controllers[id];
      const activeId = state.activeId === id ? (windows[windows.length - 1]?.id ?? null) : state.activeId;
      return {
        windows,
        activeId,
        dirty,
        controllers,
        confirmExitId: state.confirmExitId === id ? null : state.confirmExitId,
        lastClosed: state.windows.find((window) => window.id === id) ?? state.lastClosed,
      };
    }),

  requestClose: (id) => {
    if (get().dirty[id]) {
      set({ confirmExitId: id });
      return;
    }
    get().closeWindow(id);
  },

  focusWindow: (id) => set({ activeId: id }),

  setDirty: (id, dirty) =>
    set((state) => ({ dirty: { ...state.dirty, [id]: dirty } })),

  updateWindow: (id, patch) =>
    set((state) => ({
      windows: state.windows.map((window) => (window.id === id ? { ...window, ...patch } : window)),
    })),

  registerController: (id, controller) =>
    set((state) => ({ controllers: { ...state.controllers, [id]: controller } })),

  unregisterController: (id) =>
    set((state) => {
      const controllers = { ...state.controllers };
      delete controllers[id];
      return { controllers };
    }),

  setConfirmExit: (id) => set({ confirmExitId: id }),

  closeAll: () => set({ windows: [], activeId: null, dirty: {}, controllers: {}, confirmExitId: null }),

  activeWindow: () => {
    const { windows, activeId } = get();
    return windows.find((window) => window.id === activeId) ?? null;
  },

  isActiveDirty: () => {
    const id = get().activeId;
    return id ? Boolean(get().dirty[id]) : false;
  },
}));
