import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import clsx from "clsx";
import { X } from "lucide-react";
import { inputMoney, parseScaled } from "../../lib/format";

export const cx = clsx;

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex items-center rounded-[3px] border border-line/80 bg-white/70 px-1.5 py-[1px] font-mono text-[9px] font-semibold uppercase tracking-wide text-inkmut shadow-[0_1px_0_rgba(27,26,23,.08)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

type ButtonVariant = "primary" | "default" | "ghost" | "danger" | "accent" | "subtle";
type ButtonSize = "xs" | "sm" | "md";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-navy text-white border-navy hover:bg-navydeep hover:border-navydeep",
  accent: "bg-accent text-white border-accent hover:bg-[#96611a] hover:border-[#96611a]",
  default: "bg-white text-ink border-line hover:bg-parchment",
  subtle: "bg-parchment text-ink border-line hover:bg-[#e7dfcd]",
  ghost: "bg-transparent text-inkmut border-transparent hover:bg-parchment hover:text-ink",
  danger: "bg-crimson text-white border-crimson hover:bg-[#991717]",
};

const buttonSizes: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-[10px] gap-1",
  sm: "h-7 px-2.5 text-[11px] gap-1.5",
  md: "h-8 px-3 text-xs gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shortcut?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "sm", shortcut, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        "inline-flex select-none items-center justify-center rounded-[3px] border font-semibold tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/40 disabled:cursor-not-allowed disabled:opacity-45",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {children}
      {shortcut ? <Kbd className="ml-1 border-current/20 bg-white/15 text-current">{shortcut}</Kbd> : null}
    </button>
  );
});

export const inputClass =
  "h-7 w-full rounded-[3px] border border-line bg-white px-2 text-[12px] text-ink outline-none transition placeholder:text-inkmut/45 focus:border-teal focus:ring-2 focus:ring-teal/15 disabled:bg-parchment disabled:text-inkmut read-only:border-line/70 read-only:bg-parchment/55 read-only:text-ink aria-[invalid=true]:border-crimson";

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  align?: "left" | "right" | "center";
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { mono, align = "left", className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        inputClass,
        mono && "font-mono tabular-nums text-[11.5px]",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cx(inputClass, "cursor-pointer appearance-none bg-[length:10px] bg-[right_6px_center] bg-no-repeat pr-6", className)}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%235d5a50' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
        }}
        {...props}
      >
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cx(inputClass, "h-auto min-h-[54px] resize-y py-1.5 leading-snug", className)}
        {...props}
      />
    );
  },
);

export interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  right?: ReactNode;
}

export function Field({ label, children, hint, error, required, className, right }: FieldProps) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 flex min-h-[14px] items-center justify-between gap-2">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-inkmut">
          {label}
          {required ? <span className="ml-0.5 text-crimson">*</span> : null}
        </span>
        {right}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-[10px] font-medium leading-tight text-crimson">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[10px] leading-tight text-inkmut/80">{hint}</span>
      ) : null}
    </label>
  );
}

export function ScaledInput({
  value,
  onValueChange,
  decimals = 2,
  disabled,
  readOnly,
  className,
  navIndex,
  onBlur,
  placeholder,
  mono = true,
}: {
  value: number;
  onValueChange: (scaled: number) => void;
  decimals?: 2 | 4;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  navIndex?: number;
  onBlur?: () => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const [text, setText] = useState(() => inputMoney(value, decimals));
  useEffect(() => {
    const parsed = (() => {
      try {
        return parseScaled(text);
      } catch {
        return null;
      }
    })();
    if (parsed !== value) {
      setText(inputMoney(value, decimals));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, decimals]);

  return (
    <TextInput
      value={text}
      mono={mono}
      align="right"
      inputMode="decimal"
      placeholder={placeholder ?? "0.00"}
      disabled={disabled}
      readOnly={readOnly}
      className={className}
      data-nav-index={navIndex}
      onBlur={onBlur}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        try {
          onValueChange(parseScaled(next));
        } catch {
          /* keep the partial text until it is valid */
        }
      }}
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
  dot,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info" | "accent";
  className?: string;
  dot?: boolean;
}) {
  const tones: Record<string, string> = {
    neutral: "border-line bg-parchment text-inkmut",
    success: "border-[#bfd8cd] bg-mintbg text-teal",
    warning: "border-amberline bg-amberbg text-[#8a5a10]",
    danger: "border-[#ecc4bf] bg-crimsonbg text-crimson",
    info: "border-[#c6d4e6] bg-skybg text-navy",
    accent: "border-amberline bg-[#f7ead0] text-[#8a5a10]",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-[1px] text-[9.5px] font-semibold uppercase tracking-wide",
        tones[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function Banner({
  tone = "danger",
  children,
  onClose,
  className,
}: {
  tone?: "danger" | "warning" | "success" | "info";
  children: ReactNode;
  onClose?: () => void;
  className?: string;
}) {
  const tones: Record<string, string> = {
    danger: "border-[#e6b8b3] bg-crimsonbg text-[#8f1d17]",
    warning: "border-amberline bg-amberbg text-[#7c5210]",
    success: "border-[#b8d7c9] bg-mintbg text-[#0c5750]",
    info: "border-[#c6d4e6] bg-skybg text-navy",
  };
  return (
    <div
      role="alert"
      className={cx(
        "flex items-start gap-2 rounded-[3px] border px-2.5 py-2 text-[11.5px] leading-snug",
        tones[tone],
        className,
      )}
    >
      <div className="flex-1">{children}</div>
      {onClose ? (
        <button type="button" onClick={onClose} className="mt-[1px] opacity-60 hover:opacity-100">
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

export function SectionHeader({
  title,
  subtitle,
  right,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex items-end justify-between gap-3 border-b border-line/80 pb-1.5", className)}>
      <div>
        <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-navy">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-[10px] text-inkmut">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx("rounded-[4px] border border-line bg-white/55", className)}>
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-line/80 px-3 py-2">
          <div>
            <h3 className="text-[10.5px] font-bold uppercase tracking-[0.11em] text-navy">{title}</h3>
            {subtitle ? <p className="mt-0.5 text-[10px] text-inkmut">{subtitle}</p> : null}
          </div>
          {right}
        </header>
      ) : null}
      <div className={cx("p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon ? <div className="mb-1 text-inkmut/45">{icon}</div> : null}
      <p className="text-[12px] font-semibold text-ink">{title}</p>
      {description ? <p className="max-w-sm text-[11px] leading-relaxed text-inkmut">{description}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[11px] text-inkmut">
      <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-line border-t-teal" />
      {label ?? "Loading…"}
    </span>
  );
}

export function Modal({
  open,
  title,
  children,
  onClose,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  width?: string;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-navydeep/40 p-4 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx("w-full overflow-hidden rounded-[4px] border border-line bg-paper shadow-window", width)}
      >
        <header className="flex items-center justify-between border-b border-line bg-navy px-3 py-2 text-white">
          <h2 id={titleId} className="text-[11px] font-bold uppercase tracking-[0.12em]">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="opacity-70 hover:opacity-100">
            <X size={14} />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-auto p-3">{children}</div>
        {footer ? <footer className="flex justify-end gap-2 border-t border-line bg-parchment/60 px-3 py-2">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
  icon?: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "border-line bg-white/70",
    good: "border-[#bcd9cb] bg-mintbg/60",
    warn: "border-amberline bg-amberbg/60",
    bad: "border-[#e8c2bd] bg-crimsonbg/50",
  };
  return (
    <div className={cx("rounded-[4px] border px-3 py-2.5", tones[tone])}>
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-inkmut">{label}</span>
        {icon ? <span className="text-inkmut/60">{icon}</span> : null}
      </div>
      <div className="mt-1 font-mono text-[19px] font-semibold leading-none tracking-tight text-ink">{value}</div>
      {sub ? <div className="mt-1 text-[10px] text-inkmut">{sub}</div> : null}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx("h-px w-full bg-line/70", className)} />;
}

export function InlineError({ children }: { children: ReactNode }) {
  return <span className="text-[10px] font-medium text-crimson">{children}</span>;
}
