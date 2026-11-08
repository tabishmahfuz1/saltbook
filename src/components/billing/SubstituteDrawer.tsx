import { useEffect, useState } from "react";
import { ArrowRightLeft, PackageSearch, X } from "lucide-react";
import { api } from "../../lib/invoke";
import type { Product } from "../../types/database";
import type { SubstituteProduct } from "../../types/ipc";
import { expiryDisplayFromKey, formatMoney, formatRate4 } from "../../lib/format";
import { Badge, Banner, Button, cx } from "../ui/kit";
import { ProductLookup } from "../ui/lookups";

interface Props {
  productId?: string;
  productName?: string;
  onPick?: (substitute: SubstituteProduct) => void;
  onClose?: () => void;
  embedded?: boolean;
}

export function SubstituteDrawer({ productId, productName, onPick, onClose, embedded }: Props) {
  const [localProductId, setLocalProductId] = useState(productId ?? "");
  const [localName, setLocalName] = useState(productName ?? "");
  const [query, setQuery] = useState(productName ?? "");
  const [items, setItems] = useState<SubstituteProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (productId) {
      setLocalProductId(productId);
      setLocalName(productName ?? "");
    }
  }, [productId, productName]);

  useEffect(() => {
    if (!localProductId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .substitutes({ product_id: localProductId, limit: 20 })
      .then((response) => {
        if (!cancelled) {
          setItems(response.items);
          setError(null);
        }
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load substitutes");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [localProductId]);

  const chooseProduct = (product: Product) => {
    setLocalProductId(product.id);
    setLocalName(product.name);
    setQuery(product.name);
  };

  return (
    <div className={cx("flex h-full flex-col overflow-hidden bg-white", embedded ? "rounded-[4px] border border-line shadow-window" : "")}>
      <header className="flex items-start justify-between gap-2 border-b border-line bg-[linear-gradient(180deg,#fdf6e7,#f7ead0)] px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-[#7c5210]">
            <ArrowRightLeft size={12} /> Salt substitutes
          </div>
          <div className="mt-0.5 truncate text-[10px] text-inkmut">
            {localName ? `Same composition as ${localName}` : "Search a product to find in-stock alternatives"}
          </div>
        </div>
        {onClose ? (
          <button type="button" onClick={onClose} className="text-inkmut hover:text-ink">
            <X size={13} />
          </button>
        ) : null}
      </header>

      {!productId ? (
        <div className="border-b border-line/70 px-3 py-2">
          <ProductLookup
            query={query}
            onQueryChange={setQuery}
            onSelect={chooseProduct}
            placeholder="Find the out-of-stock product…"
            autoFocus
          />
        </div>
      ) : null}

      {error ? <div className="px-2 pt-2"><Banner tone="danger">{error}</Banner></div> : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="px-3 py-6 text-[11px] text-inkmut">Ranking substitutes by margin…</div>
        ) : !localProductId ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <PackageSearch size={22} className="text-inkmut/40" />
            <p className="text-[11px] text-inkmut">Pick a product above to see margin-ranked alternatives.</p>
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-inkmut">
            No other product with the same composition currently has stock.
          </div>
        ) : (
          <table className="w-full text-[10.5px]">
            <thead>
              <tr className="border-b border-line bg-parchment/50 text-left text-[8.5px] uppercase tracking-wider text-inkmut">
                <th className="px-2 py-1">Substitute</th>
                <th className="px-2 py-1 text-right">Stock</th>
                <th className="px-2 py-1 text-right">S.Rate</th>
                <th className="px-2 py-1 text-right">Net</th>
                <th className="px-2 py-1 text-right">Margin</th>
                <th className="px-2 py-1 text-right">Expiry</th>
                {onPick ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-line/40 last:border-0 hover:bg-parchment/40">
                  <td className="px-2 py-1.5">
                    <div className="font-semibold text-ink">{item.name}</div>
                    <div className="text-[9px] text-inkmut">
                      {item.company_name} · {item.pack_form} {item.pack_unit}×{item.pack_subunit}
                    </div>
                  </td>
                  <td className={cx("px-2 py-1.5 text-right font-mono", item.cur_qty <= 0 ? "text-crimson" : "font-semibold")}>
                    {item.cur_qty}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">{formatMoney(item.s_rate_scaled)}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-inkmut">{formatRate4(item.net_rate_scaled)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Badge tone={item.margin_scaled > 0 ? "success" : "warning"}>
                      ₹{formatMoney(item.margin_scaled)}
                    </Badge>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-[9.5px] text-inkmut">
                    {item.nearest_expiry ? expiryDisplayFromKey(item.nearest_expiry) : "—"}
                  </td>
                  {onPick ? (
                    <td className="px-2 py-1.5 text-right">
                      <Button variant="accent" size="xs" onClick={() => onPick(item)}>
                        Use
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="border-t border-line bg-parchment/50 px-3 py-1.5 text-[9px] text-inkmut">
        Ranked by <span className="font-semibold">(S.Rate − NetRate)</span> descending · in-stock products only
        {onPick ? " · picking opens FEFO batch selection" : !productId ? " · open a bill (Ctrl+A) to apply a substitute" : ""}
      </footer>
    </div>
  );
}
