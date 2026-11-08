import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useWorkspaceStore, type FormController } from "../stores/useWorkspaceStore";

export interface KeyboardNavOptions {
  windowId: string;
  onSave?: () => void | Promise<unknown>;
  onUnlockEdit?: () => void;
  onEscape?: () => boolean;
  onProvisional?: () => void;
  onConvert?: () => void;
  onSubstitutes?: () => void;
  mode?: () => "VIEW" | "EDIT" | "NEW";
  enabled?: boolean;
  saveEnabled?: boolean;
  editEnabled?: boolean;
}

/**
 * Enter advances to the next `[data-nav-index]` control inside the form, never
 * submits it. Esc closes open dropdowns first, then closes the window (respecting
 * the dirty-state confirm). Ctrl+E / Ctrl+S are exposed through the workspace
 * controller so the global keymap can call them.
 */
export function useKeyboardNav(options: KeyboardNavOptions) {
  const formRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef(options);
  latest.current = options;

  const registerController = useWorkspaceStore((state) => state.registerController);
  const unregisterController = useWorkspaceStore((state) => state.unregisterController);
  const requestClose = useWorkspaceStore((state) => state.requestClose);

  useEffect(() => {
    const controller: FormController = {
      save: options.saveEnabled === false ? undefined : () => latest.current.onSave?.(),
      unlockEdit: options.editEnabled === false ? undefined : () => latest.current.onUnlockEdit?.(),
      provisionalBatch: latest.current.onProvisional
        ? () => latest.current.onProvisional?.()
        : undefined,
      convert: latest.current.onConvert ? () => latest.current.onConvert?.() : undefined,
      substitutes: latest.current.onSubstitutes ? () => latest.current.onSubstitutes?.() : undefined,
      escape: () => latest.current.onEscape?.() ?? false,
      mode: () => latest.current.mode?.() ?? "VIEW",
    };
    registerController(options.windowId, controller);
    return () => unregisterController(options.windowId);
  }, [
    options.windowId,
    options.saveEnabled,
    options.editEnabled,
    options.onProvisional,
    options.onConvert,
    options.onSubstitutes,
    registerController,
    unregisterController,
  ]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (latest.current.enabled === false) return;
      const target = event.target as HTMLElement;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        const handled = latest.current.onEscape?.() ?? false;
        if (!handled) requestClose(latest.current.windowId);
        return;
      }

      if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey) return;
      const tag = target.tagName;
      if (tag === "TEXTAREA" || tag === "BUTTON" || tag === "A" || target.dataset.navIgnore === "true") {
        return;
      }
      const container = formRef.current;
      if (!container) return;

      const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-nav-index]")).filter(
        (element) => {
          if (element.hasAttribute("disabled")) return false;
          if ((element as HTMLInputElement).readOnly) return false;
          if (element.offsetParent === null) return false;
          if ((element as HTMLInputElement).type === "hidden") return false;
          return true;
        },
      );
      const currentAttr =
        target.dataset.navIndex ??
        (target.closest("[data-nav-index]") as HTMLElement | null)?.getAttribute("data-nav-index") ??
        "0";
      const current = Number(currentAttr);
      const next = nodes
        .map((element) => ({ element, index: Number(element.dataset.navIndex ?? "0") }))
        .filter((item) => Number.isFinite(item.index) && item.index > current)
        .sort((a, b) => a.index - b.index)[0];

      if (next) {
        event.preventDefault();
        next.element.focus();
        if (typeof (next.element as HTMLInputElement).select === "function") {
          (next.element as HTMLInputElement).select();
        }
      }
    },
    [requestClose],
  );

  return { formRef, onKeyDown };
}
