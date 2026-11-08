import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileSearch, FolderOpen, HardDriveDownload, Sparkles } from "lucide-react";
import { api, isTauriRuntime } from "../../lib/invoke";
import type { MigrationImportResponse, MigrationPreviewResponse } from "../../types/ipc";
import { useLookups } from "../../hooks/useLookups";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useToastStore } from "../../stores/useToastStore";
import { Badge, Banner, Button, Field, Panel, Select, TextInput } from "../ui/kit";
import { FormShell } from "../ui/FormShell";

interface Props {
  windowId: string;
  payload: Record<string, unknown>;
}

export function SolviMigrationWizard({ windowId }: Props) {
  const { lookups } = useLookups();
  const pushToast = useToastStore((state) => state.push);
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<MigrationPreviewResponse | null>(null);
  const [result, setResult] = useState<MigrationImportResponse | null>(null);
  const [createMissing, setCreateMissing] = useState(true);
  const [godownId, setGodownId] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const browse = async () => {
    if (!isTauriRuntime()) {
      setBanner("The file picker is available in the desktop app. In the browser preview, type a path.");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "Legacy data", extensions: ["db", "sqlite", "csv", "json", "xlsx", "xls", "dbf"] },
        ],
      });
      if (typeof selected === "string") {
        setPath(selected);
        setPreview(null);
        setResult(null);
      }
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to open file picker");
    }
  };

  const runPreview = async () => {
    if (!path.trim()) {
      setBanner("Choose a legacy file first.");
      return;
    }
    setBusy(true);
    setBanner(null);
    setResult(null);
    try {
      const data = await api.migrationPreview(path.trim());
      setPreview(data);
      pushToast(`Detected ${data.format} · ${data.total_rows} rows`, "info");
    } catch (error) {
      setPreview(null);
      setBanner(error instanceof Error ? error.message : "Unable to read the legacy file");
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setBanner(null);
    try {
      const data = await api.migrationImport({
        path: path.trim(),
        create_missing_products: createMissing,
        godown_id: godownId || undefined,
      });
      setResult(data);
      pushToast(`Imported ${data.imported_products} products and ${data.imported_batches} batches`, "success");
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  useKeyboardNav({ windowId, onEscape: () => false, mode: () => "EDIT", saveEnabled: false, editEnabled: false });

  const sample = preview?.sample ?? [];

  return (
    <FormShell
      windowId={windowId}
      title="SOLVI Migration Wizard"
      subtitle="One-click import of legacy product, batch and party exports"
      mode="EDIT"
      dirty={false}
      actions={
        <>
          <Button variant="default" size="sm" onClick={runPreview} disabled={busy}>
            <FileSearch size={12} /> Preview
          </Button>
          <Button variant="primary" size="sm" onClick={runImport} disabled={busy || !preview}>
            <HardDriveDownload size={12} /> {busy ? "Working…" : "Import"}
          </Button>
        </>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <div className="flex items-center gap-3">
          <span>Supported: SQLite .db, CSV, JSON, XLSX, DBF</span>
          <span className="text-inkmut">Access .mdb → export to CSV first</span>
        </div>
      }
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-3">
          <Panel title="1. Choose the legacy file">
            <div className="flex items-end gap-2">
              <Field label="File path" className="flex-1">
                <TextInput
                  mono
                  value={path}
                  placeholder="/Users/…/SOLVI/solvi_products.db"
                  data-nav-index={1}
                  onChange={(event) => {
                    setPath(event.target.value);
                    setPreview(null);
                    setResult(null);
                  }}
                />
              </Field>
              <Button variant="default" size="sm" onClick={browse}>
                <FolderOpen size={12} /> Browse
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {[".db", ".csv", ".json", ".xlsx", ".dbf"].map((extension) => (
                <Badge key={extension} tone="neutral">
                  {extension}
                </Badge>
              ))}
            </div>
          </Panel>

          {preview ? (
            <>
              <Panel title="2. Preview" subtitle={`${preview.format} · ${preview.total_rows} rows · ${preview.products} named products`}>
                <div className="mb-2 flex flex-wrap gap-2">
                  <Badge tone="info">{preview.products} products</Badge>
                  <Badge tone="success">{preview.with_batches} rows with batch/expiry</Badge>
                  {preview.warnings.length ? <Badge tone="warning">{preview.warnings.length} warnings</Badge> : null}
                </div>
                <div className="max-h-[300px] overflow-auto rounded-[3px] border border-line">
                  <table className="ledger-table min-w-[820px]">
                    <thead>
                      <tr>
                        <th className="text-left">Name</th>
                        <th className="text-left">Company</th>
                        <th className="text-left">Composition</th>
                        <th className="text-center">Pack</th>
                        <th className="text-right">MRP</th>
                        <th className="text-right">P.Rate</th>
                        <th className="text-left">Batch</th>
                        <th className="text-left">Expiry</th>
                        <th className="text-right">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sample.map((row, index) => (
                        <tr key={index}>
                          <td className="max-w-[240px] truncate font-semibold">{String(row.name ?? "")}</td>
                          <td>{String(row.company ?? "—")}</td>
                          <td className="max-w-[200px] truncate text-[10px] text-inkmut">{String(row.composition ?? "—")}</td>
                          <td className="text-center">{String(row.pack_form ?? "—")}</td>
                          <td className="text-right font-mono">{String(row.mrp ?? "—")}</td>
                          <td className="text-right font-mono">{String(row.p_rate ?? "—")}</td>
                          <td className="font-mono text-[10px]">{String(row.batch_no ?? "—")}</td>
                          <td className="font-mono text-[10px]">{String(row.expiry ?? "—")}</td>
                          <td className="text-right font-mono">{String(row.qty ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.warnings.length ? (
                  <div className="mt-2 max-h-[100px] overflow-auto rounded-[3px] border border-amberline bg-amberbg/60 px-2 py-1.5 text-[9.5px] text-[#7c5210]">
                    {preview.warnings.map((warning) => (
                      <div key={warning}>• {warning}</div>
                    ))}
                  </div>
                ) : null}
              </Panel>

              <Panel title="3. Import options">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="flex h-7 items-center gap-2 rounded-[3px] border border-line bg-white px-2 text-[10.5px]">
                    <input
                      type="checkbox"
                      checked={createMissing}
                      data-nav-index={2}
                      onChange={(event) => setCreateMissing(event.target.checked)}
                      className="h-3 w-3 accent-teal"
                    />
                    Create products missing from the master
                  </label>
                  <Field label="Opening stock godown">
                    <Select value={godownId} data-nav-index={3} onChange={(event) => setGodownId(event.target.value)}>
                      <option value="">Default godown</option>
                      {lookups.godowns.map((godown) => (
                        <option key={godown.id} value={godown.id}>
                          {godown.code} · {godown.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="mt-2 text-[9.5px] leading-relaxed text-inkmut">
                  Common legacy typos are repaired during import (“VAIL” → “VIAL”, “SYPUP” → “SYRUP”). Expiry is
                  normalised from MM/YY, YYYY-MM, YYYYMM and DD/MM/YYYY.
                </div>
              </Panel>
            </>
          ) : (
            <Panel title="What gets imported">
              <div className="grid gap-2 text-[10.5px] text-inkmut md:grid-cols-2">
                <div className="rounded-[3px] border border-line bg-white/50 px-2 py-1.5">
                  Products: name, company, composition, pack form, HSN, tax plan
                </div>
                <div className="rounded-[3px] border border-line bg-white/50 px-2 py-1.5">
                  Batches: batch no, expiry, quantity, MRP, purchase/sale rates
                </div>
                <div className="rounded-[3px] border border-line bg-white/50 px-2 py-1.5">
                  Aliases: supplier SKU names stay attached to the resolved product
                </div>
                <div className="rounded-[3px] border border-line bg-white/50 px-2 py-1.5">
                  Outbox: every imported batch is queued for the cloud delta log
                </div>
              </div>
            </Panel>
          )}

          {result ? (
            <div className="rounded-[4px] border border-[#bcd9cb] bg-mintbg/60 px-3 py-3">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-teal">
                <CheckCircle2 size={13} /> Migration complete
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] md:grid-cols-4">
                <div>
                  <div className="text-[8.5px] uppercase text-inkmut">Products</div>
                  <div className="font-mono text-[15px] font-semibold">{result.imported_products}</div>
                </div>
                <div>
                  <div className="text-[8.5px] uppercase text-inkmut">New batches</div>
                  <div className="font-mono text-[15px] font-semibold">{result.imported_batches}</div>
                </div>
                <div>
                  <div className="text-[8.5px] uppercase text-inkmut">Updated</div>
                  <div className="font-mono text-[15px] font-semibold">{result.updated_batches}</div>
                </div>
                <div>
                  <div className="text-[8.5px] uppercase text-inkmut">Skipped</div>
                  <div className="font-mono text-[15px] font-semibold">{result.skipped_rows}</div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <aside className="space-y-3">
          <div className="rounded-[4px] border border-amberline bg-amberbg/50 px-3 py-2 text-[9.5px] leading-relaxed text-[#7c5210]">
            <div className="mb-1 flex items-center gap-1 font-bold uppercase tracking-wider">
              <AlertTriangle size={11} /> Run a backup first
            </div>
            Migration writes products and batches. Create a snapshot from Setup → Google Drive Sync before importing a
            large legacy file.
          </div>

          <Panel title="Typical legacy tables">
            <ul className="space-y-1 text-[10px] text-inkmut">
              <li>• SQLite: a table containing “prod” or a `name` column.</li>
              <li>• CSV/XLSX: header row mapped by column name.</li>
              <li>• JSON: array of objects (or a `products` array).</li>
              <li>• DBF: dBase III fixed-width records.</li>
            </ul>
          </Panel>

          <Panel title="Repairs applied">
            <div className="flex flex-wrap gap-1">
              {["VAIL → VIAL", "SYPUP → SYRUP", "SYRP → SYRUP", "TABS → TAB", "CAPS → CAP"].map((repair) => (
                <Badge key={repair} tone="neutral">
                  {repair}
                </Badge>
              ))}
            </div>
            <p className="mt-2 text-[9px] leading-relaxed text-inkmut">
              Expiry values become the FEFO sort key, so legacy stock immediately participates in batch selection.
            </p>
          </Panel>

          <div className="rounded-[4px] border border-line bg-white/50 px-3 py-2 text-[9px] leading-relaxed text-inkmut">
            <Sparkles size={11} className="mr-1 inline text-accent" />
            The wizard is idempotent by product name + batch number, so a corrected file can be imported again without
            duplicating lots.
          </div>
        </aside>
      </div>
    </FormShell>
  );
}
