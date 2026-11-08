import { create } from "zustand";
import { api } from "../lib/invoke";
import type { TickerAlert } from "../types/database";

interface TickerState {
  alerts: TickerAlert[];
  loading: boolean;
  error: string | null;
  paused: boolean;
  menu: { alert: TickerAlert; x: number; y: number } | null;
  refresh: () => Promise<void>;
  setPaused: (paused: boolean) => void;
  openMenu: (alert: TickerAlert, x: number, y: number) => void;
  closeMenu: () => void;
}

export const useTickerStore = create<TickerState>((set) => ({
  alerts: [],
  loading: false,
  error: null,
  paused: false,
  menu: null,
  refresh: async () => {
    set({ loading: true });
    try {
      const response = await api.ticker({ limit: 60 });
      set({ alerts: response.items, loading: false, error: null });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Unable to load alerts" });
    }
  },
  setPaused: (paused) => set({ paused }),
  openMenu: (alert, x, y) => set({ menu: { alert, x, y }, paused: true }),
  closeMenu: () => set({ menu: null, paused: false }),
}));
