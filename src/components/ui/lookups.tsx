import { useEffect, useRef, useState, type Ref } from "react";
import { api } from "../../lib/invoke";
import type { AccountParty, Product } from "../../types/database";
import { formatMoney } from "../../lib/format";
import { Badge, Kbd, Spinner, TextInput, cx } from "./kit";

export interface ProductLookupProps {
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (product: Product) => void;
  navIndex?: number;
  autoFocus?: boolean;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  onEscape?: () => void;
  inputRef?: Ref<HTMLInputElement>;
  alwaysSearch?: boolean;
  onStats?: (found: number, total: number, elapsed: number) => void;
}

export function ProductLookup({
  query,
  onQueryChange,
  onSelect,
  navIndex,
  autoFocus,
  placeholder = "Type product name or code…",
  disabled,
  readOnly,
  className,
  onEscape,
  inputRef,
  alwaysSearch,
  onStats,
}: ProductLookupProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Product[]>([]);
  const [totalFound, setTotalFound] = useState(0);
  const [totalProducts, setTotalProducts] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const localRef = useRef<HTMLInputElement | null>(null);
  const statsRef = useRef(onStats);
  statsRef.current = onStats;

  useEffect(() => {
    if (!open && !alwaysSearch) return;
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.searchProducts({ query, limit: 30 });
        if (cancelled) return;
        setItems(response.items);
        setTotalFound(response.total_found);
        setTotalProducts(response.total_products);
        setElapsed(response.elapsed_ms);
        setActive(0);
        setError(null);
        statsRef.current?.(response.total_found, response.total_products, response.elapsed_ms);
      } catch (searchError) {
        if (!cancelled) setError(searchError instanceof Error ? searchError.message : "Search failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open, alwaysSearch]);

  const choose = (product: Product) => {
    onSelect(product);
    setOpen(false);
  };

  return (
    <div className={cx("relative", className)}>
      <TextInput
        ref={(element) => {
          localRef.current = element;
          if (typeof inputRef === "function") inputRef(element);
          else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = element;
        }}
        value={query}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        data-nav-index={navIndex}
        className="pr-16"
        onFocus={() => {
          if (!disabled && !readOnly && query.trim().length > 0) setOpen(true);
        }}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setOpen(true);
          setItems([]);
          setActive(0);
          setLoading(true);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 140)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((current) => Math.min(items.length - 1, current + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter") {
            if (open && items[active]) {
              event.preventDefault();
              choose(items[active]);
            }
          } else if (event.key === "Escape") {
            if (open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              onEscape?.();
            }
          }
        }}
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-semibold uppercase tracking-wider text-inkmut/70">
        {totalProducts ? `${totalFound}/${totalProducts}` : "F2"}
      </span>

      {open ? (
        <div className="absolute left-0 right-0 z-40 mt-1 overflow-hidden rounded-[4px] border border-line bg-white shadow-pop">
          <div className="flex items-center justify-between border-b border-line/70 bg-parchment/60 px-2 py-1 text-[9.5px] font-semibold uppercase tracking-wider text-inkmut">
            <span>
              Matches found: <span className="font-mono text-ink">{totalFound}</span> / {totalProducts}
            </span>
            <span className="font-mono text-[9px] text-inkmut/70">{elapsed.toFixed(1)} ms</span>
          </div>
          <div className="max-h-[320px] overflow-auto">
            {loading && items.length === 0 ? (
              <div className="px-3 py-4">
                <Spinner label="Searching catalogue…" />
              </div>
            ) : items.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-inkmut">
                {error ?? "No products match this search."}
              </div>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-line/60 text-left text-[9px] uppercase tracking-wider text-inkmut">
                    <th className="px-2 py-1 font-semibold">Name</th>
                    <th className="w-[84px] px-2 py-1 font-semibold">Pack</th>
                    <th className="w-[74px] px-2 py-1 text-right font-semibold">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr
                      key={item.id}
                      className={cx(
                        "cursor-pointer border-b border-line/40 last:border-0",
                        index === active ? "bg-skybg" : "hover:bg-parchment/60",
                      )}
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        choose(item);
                      }}
                    >
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-ink">{item.name}</span>
                          {item.pack_form ? <Badge tone="neutral">{item.pack_form}</Badge> : null}
                        </div>
                        <div className="text-[9.5px] text-inkmut">
                          {item.company_name ?? "—"} · {item.composition_desc ?? "—"}
                        </div>
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] text-inkmut">
                        {item.pack_unit} x {item.pack_subunit}
                      </td>
                      <td
                        className={cx(
                          "px-2 py-1 text-right font-mono text-[10.5px]",
                          (item.total_cur_qty ?? 0) < 0 ? "font-bold text-crimson" : "text-ink",
                        )}
                      >
                        {item.total_cur_qty ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-line/70 bg-parchment/40 px-2 py-1 text-[9px] text-inkmut">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Enter</Kbd> select
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd> dismiss
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface PartyLookupProps {
  accountType: "PARTY" | "SUPPLIER";
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (account: AccountParty) => void;
  navIndex?: number;
  autoFocus?: boolean;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  onEscape?: () => void;
}

export function PartyLookup({
  accountType,
  query,
  onQueryChange,
  onSelect,
  navIndex,
  autoFocus,
  placeholder = accountType === "PARTY" ? "Search customer…" : "Search supplier…",
  disabled,
  readOnly,
  className,
  onEscape,
}: PartyLookupProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AccountParty[]>([]);
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.searchAccounts({ account_type: accountType, query, limit: 25 });
        if (cancelled) return;
        setItems(response.items);
        setTotal(response.total_found);
        setActive(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open, accountType]);

  const choose = (account: AccountParty) => {
    onSelect(account);
    setOpen(false);
  };

  return (
    <div className={cx("relative", className)}>
      <TextInput
        value={query}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        data-nav-index={navIndex}
        onFocus={() => {
          if (!disabled && !readOnly) setOpen(true);
        }}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setOpen(true);
          setItems([]);
          setActive(0);
          setLoading(true);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 140)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((current) => Math.min(items.length - 1, current + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter" && open && items[active]) {
            event.preventDefault();
            choose(items[active]);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            onEscape?.();
          }
        }}
      />
      {open ? (
        <div className="absolute left-0 right-0 z-40 mt-1 overflow-hidden rounded-[4px] border border-line bg-white shadow-pop">
          <div className="flex items-center justify-between border-b border-line/70 bg-parchment/60 px-2 py-1 text-[9.5px] font-semibold uppercase tracking-wider text-inkmut">
            <span>{accountType === "PARTY" ? "Customers" : "Suppliers"}</span>
            <span className="font-mono">{total} found</span>
          </div>
          <div className="max-h-[300px] overflow-auto">
            {loading && items.length === 0 ? (
              <div className="px-3 py-4">
                <Spinner label="Searching accounts…" />
              </div>
            ) : items.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-inkmut">No accounts found.</div>
            ) : (
              items.map((item, index) => {
                const balance = item.cur_bal_scaled;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={cx(
                      "flex w-full items-center justify-between gap-2 border-b border-line/40 px-2 py-1.5 text-left last:border-0",
                      index === active ? "bg-skybg" : "hover:bg-parchment/60",
                    )}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(item);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] font-semibold text-ink">{item.name}</span>
                      <span className="block truncate text-[9.5px] text-inkmut">
                        {item.code} · {item.city ?? "—"}
                        {item.gst_no ? ` · ${item.gst_no}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {(item.open_bills ?? 0) > 0 ? <Badge tone="warning">{item.open_bills} bills</Badge> : null}
                      <span
                        className={cx(
                          "font-mono text-[10.5px]",
                          balance > 0 ? "text-crimson" : balance < 0 ? "text-teal" : "text-inkmut",
                        )}
                      >
                        {formatMoney(balance)}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
