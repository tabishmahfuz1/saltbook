import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, Factory, FlaskConical, Plus, Save, Warehouse } from "lucide-react";
import { api } from "../../lib/invoke";
import type { SyncStatus } from "../../types/database";
import type { LookupItem } from "../../types/database";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useToastStore } from "../../stores/useToastStore";
import { Badge, Banner, Button, Field, Panel, Select, TextInput, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";

type TabKey = "companies" | "groups" | "compositions" | "godowns" | "tax_plans" | "series";

const TABS: Array<{ key: TabKey; label: string; editable: boolean; icon: React.ReactNode }> = [
  { key: "companies", label: "Companies", editable: true, icon: <Building2 size={12} /> },
  { key: "groups", label: "Product Groups", editable: true, icon: <Factory size={12} /> },
  { key: "compositions", label: "Compositions", editable: true, icon: <FlaskConical size={12} /> },
  { key: "godowns", label: "Godowns", editable: true, icon: <Warehouse size={12} /> },
  { key: "tax_plans", label: "Tax Plans", editable: false, icon: <Building2 size={12} /> },
  { key: "series", label: "Invoice Series", editable: false, icon: <Building2 size={12} /> },
];

export const CompanyCompositionForms = CompanyMasterForm;

export function CompanyMasterForm({
  windowId,
}: {
  windowId: string;
  payload: Record<string, unknown>;
}) {
  const [tab, setTab] = useState<TabKey>("companies");
  const [items, setItems] = useState<Record<string, LookupItem[]>>({});
  const [selected, setSelected] = useState<LookupItem | null>(null);
  const [draft, setDraft] = useState({ code: "", name: "", description: "" });
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<SyncStatus | null>(null);
  const pushToast = useToastStore((state) => state.push);

  const tabDef = TABS.find((item) => item.key === tab)!;

  const reload = useCallback(async (kind: TabKey) => {
    const response = await api.listLookups(kind);
    setItems((current) => ({ ...current, [kind]: response.items }));
  }, []);

  useEffect(() => {
    api.syncStatus().then(setProfile).catch(() => undefined);
  }, []);

  useEffect(() => {
    (Object.keys(items).length === 0 ? (["companies", "groups", "compositions", "godowns", "tax_plans", "series"] as TabKey[]) : [tab]).forEach(
      (kind) => {
        reload(kind).catch(() => undefined);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const rows = items[tab] ?? [];

  const select = (row: LookupItem) => {
    setSelected(row);
    setDraft({
      code: row.code,
      name: row.description ? String(row.description) : row.name,
      description: row.description ? String(row.description) : "",
    });
  };

  const addNew = () => {
    setSelected(null);
    setDraft({ code: "", name: "", description: "" });
  };

  const save = async () => {
    if (!tabDef.editable) return;
    if (!draft.name.trim()) {
      setBanner("Name is required.");
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      await api.saveLookup({
        kind: tab,
        id: selected?.id ?? null,
        code: draft.code || null,
        name: draft.name.trim(),
        description: tab === "compositions" ? draft.name.trim() : draft.description.trim(),
        is_default: tab === "godowns" ? Boolean((selected as { is_default?: number } | null)?.is_default) : undefined,
      });
      await reload(tab);
      pushToast(`${tabDef.label.slice(0, -1) || tabDef.label} saved`, "success");
      setSelected(null);
      setDraft({ code: "", name: "", description: "" });
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to save lookup");
    } finally {
      setSaving(false);
    }
  };

  const { formRef, onKeyDown } = useKeyboardNav({
    windowId,
    onEscape: () => false,
    mode: () => "EDIT",
    saveEnabled: false,
    editEnabled: false,
  });

  const summary = useMemo(() => {
    const counts = Object.entries(items).map(([key, value]) => ({ key, count: value.length }));
    return counts;
  }, [items]);

  return (
    <FormShell
      windowId={windowId}
      title="Company & Lookup Master"
      subtitle="Companies, groups, compositions, godowns, tax plans and invoice series"
      mode="EDIT"
      dirty={false}
      footer={
        <span>
          {rows.length} {tabDef.label.toLowerCase()} · changes are written to the sync outbox
        </span>
      }
    >
      <div ref={formRef} onKeyDown={onKeyDown} className="grid gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setTab(item.key);
                  setSelected(null);
                  setDraft({ code: "", name: "", description: "" });
                  setBanner(null);
                }}
                className={cx(
                  "inline-flex items-center gap-1 rounded-[3px] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider",
                  tab === item.key
                    ? "border-navy bg-navy text-white"
                    : "border-line bg-white text-inkmut hover:bg-parchment",
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>

          <Panel bodyClassName="p-0" title={`${tabDef.label} (${rows.length})`}>
            <div className="max-h-[560px] overflow-auto">
              {rows.length === 0 ? (
                <div className="px-3 py-6 text-[11px] text-inkmut">Nothing here yet.</div>
              ) : (
                rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => select(row)}
                    className={cx(
                      "flex w-full items-center justify-between gap-2 border-b border-line/50 px-3 py-1.5 text-left last:border-0 hover:bg-parchment/60",
                      selected?.id === row.id && "bg-skybg",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] font-semibold">{row.name}</span>
                      <span className="block font-mono text-[9px] uppercase text-inkmut">{row.code}</span>
                    </span>
                    {tab === "godowns" && row.is_default ? <Badge tone="success">default</Badge> : null}
                    {tab === "tax_plans" ? (
                      <span className="font-mono text-[10px] text-inkmut">{((row.total_bps ?? 0) / 100).toFixed(0)}%</span>
                    ) : null}
                    {tab === "series" ? (
                      <span className="font-mono text-[10px] text-inkmut">next {row.next_inv_no}</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </Panel>
          <div className="flex flex-wrap gap-2 text-[9px] text-inkmut">
            {summary.map((entry) => (
              <span key={entry.key} className="rounded border border-line bg-white/60 px-1.5 py-0.5">
                {entry.key.replace("_", " ")}: <span className="font-mono">{entry.count}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          {banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : null}
          {tabDef.editable ? (
            <Panel
              title={selected ? `Edit ${tabDef.label.slice(0, -1)}` : `New ${tabDef.label.slice(0, -1)}`}
              right={
                <div className="flex gap-2">
                  <Button variant="default" size="xs" onClick={addNew}>
                    <Plus size={11} /> New
                  </Button>
                  <Button variant="primary" size="xs" onClick={save} disabled={saving}>
                    <Save size={11} /> {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
              }
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Code" hint="Unique short code, auto-generated when blank">
                  <TextInput
                    mono
                    value={draft.code}
                    onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value.toUpperCase() }))}
                    data-nav-index={1}
                  />
                </Field>
                <Field label={tab === "compositions" ? "Description" : "Name"} required>
                  <TextInput
                    value={draft.name}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    data-nav-index={2}
                  />
                </Field>
                {tab === "companies" ? (
                  <Field label="Short name" className="md:col-span-2">
                    <TextInput
                      value={draft.description}
                      onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                      data-nav-index={3}
                    />
                  </Field>
                ) : null}
                {tab === "godowns" ? (
                  <Field label="Default godown" className="md:col-span-2">
                    <Select value={selected?.is_default ? "1" : "0"} disabled data-nav-index={3}>
                      <option value="0">Secondary godown</option>
                      <option value="1">Default for new batches</option>
                    </Select>
                  </Field>
                ) : null}
              </div>
            </Panel>
          ) : (
            <Panel title={tabDef.label} subtitle="Maintained by the engine and sync layer">
              <div className="max-h-[520px] overflow-auto">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th className="text-left">Code</th>
                      <th className="text-left">Name</th>
                      {tab === "tax_plans" ? (
                        <>
                          <th className="text-right">CGST</th>
                          <th className="text-right">SGST</th>
                          <th className="text-right">IGST</th>
                        </>
                      ) : (
                        <>
                          <th className="text-right">Estimate?</th>
                          <th className="text-right">Next No.</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td className="font-mono">{row.code}</td>
                        <td>{row.name}</td>
                        {tab === "tax_plans" ? (
                          <>
                            <td className="text-right font-mono">{((row.cgst_bps ?? 0) / 100).toFixed(2)}%</td>
                            <td className="text-right font-mono">{((row.sgst_bps ?? 0) / 100).toFixed(2)}%</td>
                            <td className="text-right font-mono">{((row.igst_bps ?? 0) / 100).toFixed(2)}%</td>
                          </>
                        ) : (
                          <>
                            <td className="text-right">{row.is_estimate ? "Yes" : "No"}</td>
                            <td className="text-right font-mono">{row.next_inv_no}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <Panel title="Company profile" subtitle="Edited in Setup → Google Drive Sync → Company profile">
            <div className="grid grid-cols-1 gap-2 text-[11px] md:grid-cols-2">
              <div className="flex justify-between border-b border-line/60 py-1">
                <span className="text-inkmut">Company</span>
                <span className="font-semibold">{profile?.company_name || "—"}</span>
              </div>
              <div className="flex justify-between border-b border-line/60 py-1">
                <span className="text-inkmut">GSTIN</span>
                <span className="font-mono">{profile?.company_gst_no || "—"}</span>
              </div>
              <div className="flex justify-between border-b border-line/60 py-1">
                <span className="text-inkmut">DL No.</span>
                <span className="font-mono">{profile?.company_dl_no || "—"}</span>
              </div>
              <div className="flex justify-between border-b border-line/60 py-1">
                <span className="text-inkmut">State code</span>
                <span className="font-mono">{profile?.company_state_code || "—"}</span>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </FormShell>
  );
}
