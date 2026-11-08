import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { Button, Kbd } from "../ui/kit";

export function ConfirmExitModal() {
  const confirmExitId = useWorkspaceStore((state) => state.confirmExitId);
  const windows = useWorkspaceStore((state) => state.windows);
  const closeWindow = useWorkspaceStore((state) => state.closeWindow);
  const setConfirmExit = useWorkspaceStore((state) => state.setConfirmExit);

  const target = windows.find((window) => window.id === confirmExitId);

  useEffect(() => {
    if (!confirmExitId) return;
    const handler = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "y") {
        event.preventDefault();
        closeWindow(confirmExitId);
      } else if (key === "n" || event.key === "Escape") {
        event.preventDefault();
        setConfirmExit(null);
        window.setTimeout(() => {
          const first = document.querySelector<HTMLElement>("[data-nav-index]");
          first?.focus();
        }, 10);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [confirmExitId, closeWindow, setConfirmExit]);

  if (!confirmExitId || !target) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-navydeep/45 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-[420px] overflow-hidden rounded-[4px] border border-line bg-paper shadow-window">
        <div className="flex items-center gap-2 border-b border-line bg-amberbg px-3 py-2.5">
          <AlertTriangle size={15} className="text-accent" />
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#7c5210]">Unsaved changes</h2>
        </div>
        <div className="px-4 py-4">
          <p className="text-[12px] leading-relaxed text-ink">
            Unsaved changes detected in <span className="font-semibold">{target.title}</span>.
          </p>
          <p className="mt-1 text-[12px] text-inkmut">Discard changes and exit? (Y/N)</p>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line bg-parchment/60 px-3 py-2">
          <span className="text-[9.5px] uppercase tracking-wider text-inkmut">
            Keyboard: <span className="font-semibold">Y</span> discard · <span className="font-semibold">N</span> stay
          </span>
          <div className="flex gap-2">
            <Button variant="default" size="sm" onClick={() => setConfirmExit(null)}>
              Keep editing <Kbd className="ml-1">N</Kbd>
            </Button>
            <Button variant="danger" size="sm" onClick={() => closeWindow(confirmExitId)}>
              Discard & exit <Kbd className="ml-1 border-white/30 bg-white/15 text-white">Y</Kbd>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
