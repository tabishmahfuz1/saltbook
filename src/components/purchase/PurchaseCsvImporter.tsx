import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, FileJson, FileSpreadsheet, UploadCloud } from "lucide-react";
import { api } from "../../lib/invoke";
import type { AccountParty } from "../../types/database";
import type { ImportResult, ImportRowRequest } from "../../types/ipc";
import { formatMoney, parseScaled, todayDisplay } from "../../lib/format";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useToastStore } from "../../stores/useToastStore";
import { Badge, Banner, Button, Field, Panel, Select, TextInput, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";
import { PartyLookup } from "../ui/lookups";

type RawRow = Record<string, string>;

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.trim());
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

function normalizeKey(input: string): string {
  return input.trim().toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ");
}

function value(row: RawRow, keys: string[]): string {
  for (const key of keys) {
    const found = row[key];
    if (found && found.trim()) return found.trim();
  }
  return "";
}

function percentToBps(text: string): number | undefined {
  if (!text) return undefined;
  const numeric = Number(text.replace("%", "").trim());
  if (!Number.isFinite(numeric)) return undefined;
  return Math.round(numeric * 100);
}

function toRows(records: RawRow[]): { rows: ImportRowRequest[]; skipped: string[] } {
  const rows: ImportRowRequest[] = [];
  const skipped: string[] = [];
  records.forEach((record, index) => {
    const supplierSku = value(record, ["supplier sku", "sku", "item code", "item", "product", "name", "description"]);
    const productName = value(record, ["product name", "product", "name", "description"]);
    const batchNo = value(record, ["batch no", "batch", "batch no.", "batchno"]);
    const expiry = value(record, ["expiry", "exp", "expiry date", "exp date"]);
    const qtyText = value(record, ["qty", "quantity", "billed qty", "stock"]);
    const rateText = value(record, ["p rate", "p.rate", "purchase rate", "prate", "rate", "cost"]);
    if (!supplierSku && !productName) {
      skipped.push(`Row ${index + 2}: no product name/SKU`);
      return;
    }
    if (!batchNo || !expiry) {
      skipped.push(`Row ${index + 2}: batch or expiry missing`);
      return;
    }
    const qty = Number(qtyText || 0);
    if (!qty || qty <= 0) {
      skipped.push(`Row ${index + 2}: quantity is missing`);
      return;
    }
    let pRate = 0;
    try {
      pRate = parseScaled(rateText);
    } catch {
      skipped.push(`Row ${index + 2}: invalid purchase rate '${rateText}'`);
      return;
    }
    if (pRate <= 0) {
      skipped.push(`Row ${index + 2}: purchase rate is missing`);
      return;
    }
    const row: ImportRowRequest = {
      supplier_sku: supplierSku || productName,
      product_name: productName || null,
      batch_no: batchNo,
      expiry_mm_yy: expiry,
      qty,
      free_qty: Number(value(record, ["free", "free qty", "scheme", "free deal"]) || 0),
      p_rate: rateText,
      p_rate_scaled: pRate,
      mrp: value(record, ["mrp"]) || null,
      dis_bps: percentToBps(value(record, ["dis%", "discount", "dis"])),
      tax_bps: percentToBps(value(record, ["gst%", "tax%", "gst", "tax"])),
      deal_billed: Number(value(record, ["deal billed", "deal"]) || 0) || undefined,
      deal_free: Number(value(record, ["deal free", "free scheme"]) || 0) || undefined,
    };
    rows.push(row);
  });
  return { rows, skipped };
}

interface Props {
  windowId: string;
  payload: Record<string, unknown>;
}

export function PurchaseCsvImporter({ windowId }: Props) {
  const pushToast = useToastStore((state) => state.push);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [supplier, setSupplier] = useState<AccountParty | null>(null);
  const [supplierQuery, setSupplierQuery] = useState("");
  const [dateDisplay, setDateDisplay] = useState(todayDisplay);
  const [paymentMode, setPaymentMode] = useState<"CASH" | "CREDIT">("CREDIT");
  const [createMissing, setCreateMissing] = useState(true);
  const [rows, setRows] = useState<ImportRowRequest[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [aliases, setAliases] = useState<Array<Record<string, unknown>>>([]);

  const loadAliases = useCallback(async (supplierId: string) => {
    try {
      const response = await api.listSkuAliases(supplierId);
      setAliases(response.items);
    } catch {
      setAliases([]);
    }
  }, []);

  useEffect(() => {
    if (supplier) loadAliases(supplier.id);
  }, [supplier, loadAliases]);

  const handleFile = async (file: File) => {
    setBanner(null);
    setResult(null);
    setFileName(file.name);
    const text = await file.text();
    try {
      if (file.name.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(text) as unknown;
        const list = Array.isArray(parsed)
          ? parsed
          : (parsed as { rows?: unknown[] }).rows ?? (parsed as { products?: unknown[] }).products ?? [];
        if (!Array.isArray(list)) throw new Error("JSON must contain an array of rows.");
        const records: RawRow[] = list.map((entry) => {
          const record: RawRow = {};
          if (entry && typeof entry === "object") {
            Object.entries(entry as Record<string, unknown>).forEach(([key, item]) => {
              record[normalizeKey(key)] = String(item ?? "");
            });
          }
          return record;
        });
        const mapped = toRows(records);
        setRows(mapped.rows);
        setSkipped(mapped.skipped);
        setFormat("JSON");
      } else {
        const table = parseCsv(text);
        if (table.length < 2) throw new Error("The file has no data rows.");
        const headers = (table[0] ?? []).map(normalizeKey);
        const records: RawRow[] = table.slice(1).map((line) => {
          const record: RawRow = {};
          headers.forEach((header, index) => {
            record[header] = line[index] ?? "";
          });
          return record;
        });
        const mapped = toRows(records);
        setRows(mapped.rows);
        setSkipped(mapped.skipped);
        setFormat("CSV");
      }
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to parse file");
      setRows([]);
      setSkipped([]);
      setFormat(null);
    }
  };

  const runImport = async () => {
    setBanner(null);
    if (!supplier) {
      setBanner("Select the supplier this file belongs to.");
      return;
    }
    if (rows.length === 0) {
      setBanner("Load a CSV or JSON file with at least one valid row.");
      return;
    }
    setImporting(true);
    try {
      const response = await api.importPurchaseRows({
        supplier_id: supplier.id,
        inv_date_display: dateDisplay,
        payment_mode: paymentMode,
        create_missing_products: createMissing,
        rows,
      });
      setResult(response);
      pushToast(`${response.imported_lines} line(s) imported into a purchase invoice`, "success");
      loadAliases(supplier.id);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  useKeyboardNav({
    windowId,
    onEscape: () => false,
    mode: () => "EDIT",
    saveEnabled: false,
    editEnabled: false,
  });

  const preview = useMemo(() => rows.slice(0, 12), [rows]);

  return (
    <FormShell
      windowId={windowId}
      title="Import Supplier File"
      subtitle="Drag a CSV or JSON purchase file · supplier SKU aliases resolve automatically"
      mode="EDIT"
      dirty={rows.length > 0}
      actions={
        <Button variant="primary" size="sm" onClick={runImport} disabled={importing || rows.length === 0}>
          <UploadCloud size={12} /> {importing ? "Importing…" : `Import ${rows.length} rows`}
        </Button>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <div className="flex items-center gap-3">
          <span>
            Rows ready: <span className="font-mono font-semibold">{rows.length}</span>
          </span>
          <span>
            Skipped: <span className="font-mono font-semibold">{skipped.length}</span>
          </span>
          <span>
            Aliases on file: <span className="font-mono font-semibold">{aliases.length}</span>
          </span>
        </div>
      }
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <Panel title="Import settings">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field label="Supplier" required className="md:col-span-2">
                <PartyLookup
                  accountType="SUPPLIER"
                  query={supplierQuery}
                  onQueryChange={(value) => {
                    setSupplierQuery(value);
                    setSupplier(null);
                  }}
                  onSelect={(account) => {
                    setSupplier(account);
                    setSupplierQuery(account.name);
                  }}
                  navIndex={1}
                />
              </Field>
              <Field label="Invoice date">
                <TextInput
                  mono
                  value={dateDisplay}
                  data-nav-index={2}
                  onChange={(event) => setDateDisplay(event.target.value)}
                />
              </Field>
              <Field label="Payment mode">
                <Select
                  value={paymentMode}
                  data-nav-index={3}
                  onChange={(event) => setPaymentMode(event.target.value as "CASH" | "CREDIT")}
                >
                  <option value="CREDIT">CREDIT</option>
                  <option value="CASH">CASH</option>
                </Select>
              </Field>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[10.5px]">
              <input
                type="checkbox"
                checked={createMissing}
                onChange={(event) => setCreateMissing(event.target.checked)}
                className="h-3 w-3 accent-teal"
              />
              Create products that do not exist yet (name from supplier file)
            </label>
          </Panel>

          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
            onClick={() => fileInput.current?.click()}
            className={cx(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[4px] border-2 border-dashed px-6 py-10 text-center transition",
              dragging ? "border-teal bg-mintbg/40" : "border-line bg-white/50 hover:border-teal/60 hover:bg-mintbg/20",
            )}
          >
            <UploadCloud size={24} className="text-inkmut/50" />
            <div className="text-[12px] font-semibold text-navy">
              {fileName ? fileName : "Drop supplier CSV / JSON here"}
            </div>
            <div className="text-[10px] text-inkmut">
              {fileName
                ? `${rows.length} valid rows · ${skipped.length} skipped · ${format ?? "unknown"} format`
                : "or click to choose a file · XLSX is supported by the SOLVI migration wizard"}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.json,text/csv,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                event.target.value = "";
              }}
            />
          </div>

          {skipped.length ? (
            <Panel title="Skipped rows" bodyClassName="max-h-[140px] overflow-auto">
              <ul className="space-y-0.5 text-[10px] text-crimson">
                {skipped.map((reason) => (
                  <li key={reason}>• {reason}</li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel title="Preview" subtitle={rows.length ? `First ${preview.length} of ${rows.length} rows` : "Load a file to preview"} bodyClassName="p-0">
            <div className="max-h-[320px] overflow-auto">
              <table className="ledger-table min-w-[760px]">
                <thead>
                  <tr>
                    <th className="text-left">Supplier SKU</th>
                    <th className="text-left">Batch</th>
                    <th className="text-left">Expiry</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Free</th>
                    <th className="text-right">P.Rate</th>
                    <th className="text-right">MRP</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-[10.5px] text-inkmut">
                        No rows loaded.
                      </td>
                    </tr>
                  ) : (
                    preview.map((row, index) => (
                      <tr key={`${row.supplier_sku}-${index}`}>
                        <td className="max-w-[280px] truncate">{row.supplier_sku || row.product_name}</td>
                        <td className="font-mono">{row.batch_no}</td>
                        <td className="font-mono">{row.expiry_mm_yy}</td>
                        <td className="text-right font-mono">{row.qty}</td>
                        <td className="text-right font-mono">{row.free_qty ?? 0}</td>
                        <td className="text-right font-mono">{formatMoney(row.p_rate_scaled ?? 0)}</td>
                        <td className="text-right font-mono">{row.mrp ? formatMoney(parseScaled(row.mrp)) : "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        <aside className="space-y-3">
          {result ? (
            <div className="rounded-[4px] border border-[#bcd9cb] bg-mintbg/60 px-3 py-3">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-teal">
                <CheckCircle2 size={13} /> Import complete
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  <div className="text-[8.5px] uppercase text-inkmut">Lines</div>
                  <div className="font-mono text-[14px] font-semibold">{result.imported_lines}</div>
                </div>
                <div>
                  <div className="text-[8.5px] uppercase text-inkmut">Value</div>
                  <div className="font-mono text-[14px] font-semibold">₹{formatMoney(result.total_scaled)}</div>
                </div>
                <div>
                  <div className="text-[8.5px] uppercase text-inkmut">Aliases</div>
                  <div className="font-mono text-[14px] font-semibold">{result.aliases_saved}</div>
                </div>
                <div>
                  <div className="text-[8.5px] uppercase text-inkmut">New products</div>
                  <div className="font-mono text-[14px] font-semibold">{result.created_products}</div>
                </div>
              </div>
              {result.unresolved.length ? (
                <div className="mt-2 border-t border-current/10 pt-2 text-[9.5px]">
                  Unresolved: {result.unresolved.join(", ")}
                </div>
              ) : null}
            </div>
          ) : (
            <Panel title="How resolution works">
              <ol className="list-decimal space-y-1 pl-3 text-[10px] leading-relaxed text-inkmut">
                <li>Supplier SKU is matched against saved aliases for this supplier.</li>
                <li>Otherwise the exact product name is matched.</li>
                <li>If allowed, a new product is created and the SKU is remembered as an alias.</li>
                <li>All rows become one inward purchase invoice with provisional merge.</li>
              </ol>
            </Panel>
          )}

          <Panel title="Supplier aliases" bodyClassName="p-0">
            <div className="max-h-[260px] overflow-auto">
              {aliases.length === 0 ? (
                <div className="px-3 py-4 text-[10px] text-inkmut">No aliases recorded yet.</div>
              ) : (
                aliases.map((alias) => (
                  <div key={String(alias.id)} className="border-b border-line/50 px-3 py-1.5 last:border-0">
                    <div className="font-mono text-[10px] font-semibold">{String(alias.alias_name)}</div>
                    <div className="text-[9px] text-inkmut">
                      {String(alias.product_name ?? "")} · #{String(alias.pro_code ?? "")}
                    </div>
                  </div>
                ))
              )}
            </div>
          </Panel>

          <Panel title="Expected columns">
            <div className="flex flex-wrap gap-1">
              {["NAME", "BATCH", "EXPIRY", "QTY", "FREE", "P.RATE", "MRP", "DIS%", "GST%"].map((column) => (
                <Badge key={column} tone="neutral">
                  {column}
                </Badge>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-1 text-[9.5px] text-inkmut">
              <FileSpreadsheet size={11} /> CSV / JSON now · <FileJson size={11} /> e-invoice JSON accepted
            </div>
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1 text-[9.5px] font-semibold text-navy underline underline-offset-2"
              onClick={() => {
                const header = "NAME,BATCH,EXPIRY,QTY,FREE,P.RATE,MRP,DIS%,GST%\n";
                const blob = new Blob([header], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "saltbook-purchase-template.csv";
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download size={11} /> Download template
            </button>
          </Panel>
        </aside>
      </div>
    </FormShell>
  );
}
