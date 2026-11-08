import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../../lib/invoke";
import type { PurchaseInvoice } from "../../types/database";
import { formatMoney } from "../../lib/format";
import { Badge, Banner, Button, Field, Panel, Select, TextInput } from "../ui/kit";
import { FormShell } from "../ui/FormShell";

interface WindowProps {
  windowId: string;
  payload: Record<string, unknown>;
}

export function PurchaseRegister({ windowId }: WindowProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PurchaseInvoice[]>([]);
  const [totals, setTotals] = useState({ count: 0, amount: 0 });
  const [banner, setBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.listPurchases({ query, limit: 200 });
      setItems(response.items);
      setTotals({ count: response.total_count, amount: response.total_amount_scaled });
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to load purchases");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(load, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <FormShell
      windowId={windowId}
      title="Purchase Register"
      subtitle="Inward invoices with supplier and payment mode"
      mode="EDIT"
      dirty={false}
      actions={
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <span>
          {totals.count} purchases · ₹{formatMoney(totals.amount)}
        </span>
      }
    >
      <div className="space-y-3">
        <Panel>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_260px]">
            <Field label="Search supplier / invoice no">
              <TextInput value={query} data-nav-index={1} onChange={(event) => setQuery(event.target.value)} />
            </Field>
            <Field label="Rows loaded">
              <div className="flex h-7 items-center font-mono text-[11px] text-inkmut">{items.length}</div>
            </Field>
          </div>
        </Panel>
        <Panel bodyClassName="p-0">
          <div className="max-h-[560px] overflow-auto">
            <table className="ledger-table min-w-[900px]">
              <thead>
                <tr>
                  <th className="text-left">Supplier inv</th>
                  <th className="text-left">Date</th>
                  <th className="text-left">Supplier</th>
                  <th className="text-left">Godown</th>
                  <th className="text-center">Mode</th>
                  <th className="text-right">Lines</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Due</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-[10.5px] text-inkmut">
                      No purchases match.
                    </td>
                  </tr>
                ) : (
                  items.map((purchase) => (
                    <tr key={purchase.id}>
                      <td className="font-mono font-semibold">{purchase.sup_inv_no}</td>
                      <td className="font-mono text-[10px]">{purchase.inv_date_display}</td>
                      <td className="max-w-[280px] truncate">{purchase.supplier_name_snapshot}</td>
                      <td className="font-mono text-[10px]">{purchase.godown_code ?? "MAIN"}</td>
                      <td className="text-center">
                        <Badge tone={purchase.payment_mode === "CREDIT" ? "accent" : "success"}>{purchase.payment_mode}</Badge>
                      </td>
                      <td className="text-right font-mono">{purchase.item_count ?? 0}</td>
                      <td className="text-right font-mono font-semibold">₹{formatMoney(purchase.grand_total_scaled)}</td>
                      <td className="text-right font-mono text-crimson">₹{formatMoney(purchase.due_amt_scaled)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </FormShell>
  );
}

export function AdjustmentRegister({ windowId }: WindowProps) {
  const [type, setType] = useState("");
  const [types, setTypes] = useState<Array<{ code: string; label: string }>>([]);
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    api.listAdjustmentTypes().then((response) => setTypes(response.items)).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await api.listAdjustments({ adj_type: type || undefined, limit: 100 });
      setItems(response.items);
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to load adjustments");
    }
  }, [type]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <FormShell
      windowId={windowId}
      title="Adjustment Register"
      subtitle="Breakage, transfers, shortages, surplus and notes"
      mode="EDIT"
      dirty={false}
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={<span>{items.length} adjustments</span>}
    >
      <div className="space-y-3">
        <Panel>
          <Field label="Type">
            <Select value={type} data-nav-index={1} onChange={(event) => setType(event.target.value)}>
              <option value="">All adjustments</option>
              {types.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Field>
        </Panel>
        <Panel bodyClassName="p-0">
          <div className="max-h-[560px] overflow-auto">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th className="text-left">Type</th>
                  <th className="text-left">Date</th>
                  <th className="text-left">Godown</th>
                  <th className="text-left">Party</th>
                  <th className="text-right">Lines</th>
                  <th className="text-right">Value</th>
                  <th className="text-left">Reason</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-[10.5px] text-inkmut">
                      No adjustments recorded.
                    </td>
                  </tr>
                ) : (
                  items.map((row) => (
                    <tr key={String(row.id)}>
                      <td>{String(row.adj_type ?? "")}</td>
                      <td className="font-mono text-[10px]">{String(row.adj_date_display ?? "")}</td>
                      <td className="font-mono text-[10px]">{String(row.godown_code ?? "")}</td>
                      <td className="max-w-[220px] truncate">{String(row.party_name ?? "—")}</td>
                      <td className="text-right font-mono">{String(row.line_count ?? 0)}</td>
                      <td className="text-right font-mono">₹{formatMoney(Number(row.total_value_scaled ?? 0))}</td>
                      <td className="max-w-[260px] truncate text-[10px] text-inkmut">{String(row.reason ?? "")}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </FormShell>
  );
}

export function VoucherRegister({ windowId, payload }: WindowProps) {
  const [type, setType] = useState(String(payload.voucher_type ?? ""));
  const [types, setTypes] = useState<Array<{ code: string; label: string }>>([]);
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    api.listVoucherTypes().then((response) => setTypes(response.items)).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await api.listVouchers({ voucher_type: type || undefined, limit: 100 });
      setItems(response.items);
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to load vouchers");
    }
  }, [type]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => items.reduce((sum, row) => sum + Number(row.amount_scaled ?? 0), 0), [items]);

  return (
    <FormShell
      windowId={windowId}
      title="Voucher Register"
      subtitle="Receipts, payments, contra, journal and payslip"
      mode="EDIT"
      dirty={false}
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <span>
          {items.length} vouchers · ₹{formatMoney(totals)}
        </span>
      }
    >
      <div className="space-y-3">
        <Panel>
          <Field label="Type">
            <Select value={type} data-nav-index={1} onChange={(event) => setType(event.target.value)}>
              <option value="">All vouchers</option>
              {types.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Field>
        </Panel>
        <Panel bodyClassName="p-0">
          <div className="max-h-[560px] overflow-auto">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th className="text-left">No.</th>
                  <th className="text-left">Date</th>
                  <th className="text-left">Type</th>
                  <th className="text-left">Account</th>
                  <th className="text-right">Amount</th>
                  <th className="text-left">Mode</th>
                  <th className="text-left">Narration</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-[10.5px] text-inkmut">
                      No vouchers recorded.
                    </td>
                  </tr>
                ) : (
                  items.map((row) => (
                    <tr key={String(row.id)}>
                      <td className="font-mono font-semibold">{String(row.voucher_no_display ?? "")}</td>
                      <td className="font-mono text-[10px]">{String(row.voucher_date_display ?? "")}</td>
                      <td>{String(row.voucher_type ?? "")}</td>
                      <td className="max-w-[240px] truncate">{String(row.account_name ?? "")}</td>
                      <td className="text-right font-mono">₹{formatMoney(Number(row.amount_scaled ?? 0))}</td>
                      <td className="text-[10px]">{String(row.payment_mode ?? "")}</td>
                      <td className="max-w-[260px] truncate text-[10px] text-inkmut">{String(row.narration ?? "")}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </FormShell>
  );
}
