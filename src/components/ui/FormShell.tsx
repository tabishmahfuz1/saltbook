import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { Badge, Button, Kbd, cx } from "./kit";

export interface FormShellProps {
  windowId: string;
  title: string;
  subtitle?: ReactNode;
  mode: "VIEW" | "EDIT" | "NEW";
  dirty?: boolean;
  actions?: ReactNode;
  banner?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  padded?: boolean;
  className?: string;
}

const modeTone = {
  VIEW: "neutral",
  EDIT: "warning",
  NEW: "success",
} as const;

export function FormShell({
  windowId,
  title,
  subtitle,
  mode,
  dirty,
  actions,
  banner,
  children,
  footer,
  padded = true,
  className,
}: FormShellProps) {
  const requestClose = useWorkspaceStore((state) => state.requestClose);
  return (
    <div className={cx("flex h-full min-h-0 flex-col bg-paper", className)}>
      <header className="flex min-h-[46px] items-center justify-between gap-3 border-b border-line bg-[linear-gradient(180deg,#fcfaf4_0%,#f1ebde_100%)] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Badge tone={modeTone[mode]} className="px-2 py-[3px] tracking-[0.14em]">
            {mode === "NEW" ? "NEW" : mode}
          </Badge>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[14px] font-bold leading-tight tracking-[-0.01em] text-navy">{title}</h1>
              {dirty ? (
                <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" /> unsaved
                </span>
              ) : null}
            </div>
            {subtitle ? <div className="truncate text-[10.5px] leading-tight text-inkmut">{subtitle}</div> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          <span className="mx-1 h-5 w-px bg-line" />
          <Button variant="ghost" size="xs" onClick={() => requestClose(windowId)} title="Close (Esc)">
            <X size={13} />
            <span className="hidden md:inline">Close</span>
            <Kbd className="ml-0.5">Esc</Kbd>
          </Button>
        </div>
      </header>
      {banner ? <div className="border-b border-line/70 bg-paper px-3 py-2">{banner}</div> : null}
      <div className={cx("min-h-0 flex-1 overflow-auto", padded && "p-3")}>{children}</div>
      {footer ? (
        <footer className="flex min-h-[30px] items-center justify-between gap-3 border-t border-line bg-parchment/55 px-3 py-1 text-[10px] text-inkmut">
          {footer}
        </footer>
      ) : null}
    </div>
  );
}
