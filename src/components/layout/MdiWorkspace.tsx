import { X } from "lucide-react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { WINDOW_COMPONENTS } from "../../lib/windowRegistry";
import { Dashboard } from "./Dashboard";
import { cx } from "../ui/kit";

export function MdiWorkspace() {
  const windows = useWorkspaceStore((state) => state.windows);
  const activeId = useWorkspaceStore((state) => state.activeId);
  const focusWindow = useWorkspaceStore((state) => state.focusWindow);
  const requestClose = useWorkspaceStore((state) => state.requestClose);
  const dirty = useWorkspaceStore((state) => state.dirty);

  if (windows.length === 0) {
    return (
      <main className="min-h-0 flex-1 overflow-auto bg-mdi-grid">
        <Dashboard />
      </main>
    );
  }

  const active = windows.find((window) => window.id === activeId) ?? windows[windows.length - 1];
  const Component = WINDOW_COMPONENTS[active.kind];

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-mdi-grid">
      <div className="flex h-8 shrink-0 items-stretch gap-0 overflow-x-auto border-b border-line bg-[#e5dece] px-1">
        {windows.map((window) => {
          const isActive = window.id === active.id;
          return (
            <div
              key={window.id}
              role="button"
              tabIndex={0}
              onClick={() => focusWindow(window.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") focusWindow(window.id);
              }}
              className={cx(
                "group relative flex max-w-[260px] shrink-0 items-center gap-1.5 border-r border-line/60 px-2.5 text-left transition",
                isActive
                  ? "bg-paper text-ink shadow-[inset_0_2px_0_#0f6b63]"
                  : "bg-[#e5dece] text-inkmut hover:bg-[#ece6d8]",
              )}
            >
              <span
                className={cx(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  isActive ? "bg-teal" : dirty[window.id] ? "bg-accent" : "bg-inkmut/40",
                )}
              />
              <span className="truncate text-[10.5px] font-semibold">{window.title}</span>
              {dirty[window.id] ? <span className="text-[10px] font-bold text-accent">*</span> : null}
              <button
                type="button"
                aria-label={`Close ${window.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  requestClose(window.id);
                }}
                className="ml-1 grid h-4 w-4 place-items-center rounded-[2px] text-inkmut/50 hover:bg-crimsonbg hover:text-crimson"
              >
                <X size={10} />
              </button>
            </div>
          );
        })}
        <div className="ml-auto flex shrink-0 items-center px-2 text-[8.5px] uppercase tracking-[0.14em] text-inkmut/60">
          {windows.length} window{windows.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Component windowId={active.id} payload={active.payload} />
      </div>
    </main>
  );
}
