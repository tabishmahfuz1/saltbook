import { useCallback, useEffect, useState } from "react";
import {
  CloudUpload,
  Copy,
  ExternalLink,
  HardDrive,
  Link2,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Unlink,
} from "lucide-react";
import { api, isTauriRuntime } from "../../lib/invoke";
import type { SyncStatus } from "../../types/database";
import { bytesLabel, relativeTime } from "../../lib/format";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useToastStore } from "../../stores/useToastStore";
import { Banner, Button, Field, Panel, TextInput, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";

interface Props {
  windowId: string;
  payload: Record<string, unknown>;
}

export function GoogleDriveSyncPanel({ windowId }: Props) {
  const pushToast = useToastStore((state) => state.push);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [form, setForm] = useState({
    clientId: "",
    redirectUri: "",
    deviceName: "",
    merchantVpa: "",
    printerName: "",
    autoBackup: true,
    autoSync: false,
    backupHours: "2",
    syncSeconds: "60",
    backupFolder: "Saltbook_Backups",
    syncFolder: "Saltbook_Sync",
    companyName: "",
    companyAddress: "",
    companyGst: "",
    companyDl: "",
    companyPhone: "",
    companyStateCode: "10",
    nextEstimate: "728",
    nextTax: "3",
  });
  const [authUrl, setAuthUrl] = useState("");
  const [oauthState, setOauthState] = useState("");
  const [code, setCode] = useState("");
  const [lanPort, setLanPort] = useState("8787");
  const [lanUrl, setLanUrl] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState<{ local: Array<Record<string, unknown>>; remote: Array<Record<string, unknown>>; dir: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.syncStatus();
      setStatus(data);
      setForm({
        clientId: data.client_id_configured ? "configured" : "",
        redirectUri: data.redirect_uri,
        deviceName: data.device_name,
        merchantVpa: data.merchant_vpa,
        printerName: data.printer_name,
        autoBackup: data.auto_backup,
        autoSync: data.auto_sync,
        backupHours: String(data.backup_interval_hours),
        syncSeconds: String(data.sync_interval_secs),
        backupFolder: data.backup_folder,
        syncFolder: data.sync_folder,
        companyName: data.company_name,
        companyAddress: data.company_address,
        companyGst: data.company_gst_no,
        companyDl: data.company_dl_no,
        companyPhone: data.company_phone,
        companyStateCode: data.company_state_code || "10",
        nextEstimate: String(data.estimate_next_inv_no || 1),
        nextTax: String(data.tax_next_inv_no || 1),
      });
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to read sync status");
    }
  }, []);

  const loadBackups = useCallback(async () => {
    try {
      setBackups(await api.listBackups());
    } catch {
      /* optional */
    }
  }, []);

  useEffect(() => {
    load();
    loadBackups();
  }, [load, loadBackups]);

  const saveSettings = async () => {
    setBusy(true);
    try {
      await api.saveSyncSettings({
        auto_backup: form.autoBackup,
        auto_sync: form.autoSync,
        backup_interval_hours: Number(form.backupHours) || 2,
        sync_interval_secs: Number(form.syncSeconds) || 60,
        merchant_vpa: form.merchantVpa,
        printer_name: form.printerName,
        device_name: form.deviceName,
        gdrive_redirect_uri: form.redirectUri,
        gdrive_backup_folder: form.backupFolder,
        gdrive_sync_folder: form.syncFolder,
        company_name: form.companyName,
        company_address: form.companyAddress,
        company_gst_no: form.companyGst,
        company_dl_no: form.companyDl,
        company_phone: form.companyPhone,
        company_state_code: form.companyStateCode,
        estimate_next_inv_no: Number(form.nextEstimate) || 1,
        tax_next_inv_no: Number(form.nextTax) || 1,
        ...(form.clientId && form.clientId !== "configured" ? { gdrive_client_id: form.clientId } : {}),
      });
      pushToast("Sync settings saved", "success");
      await load();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to save settings");
    } finally {
      setBusy(false);
    }
  };

  const startLogin = async () => {
    setBusy(true);
    setBanner(null);
    try {
      const response = await api.startLogin({ client_id: form.clientId === "configured" ? undefined : form.clientId });
      setAuthUrl(response.auth_url);
      setOauthState(response.state);
      try {
        window.open(response.auth_url, "_blank", "noopener");
      } catch {
        /* the URL stays copyable */
      }
      setInfo("Google sign-in opened. After approving, copy the 'code' value from the redirected URL and paste it below.");
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to start Google login");
    } finally {
      setBusy(false);
    }
  };

  const completeLogin = async () => {
    if (!code.trim()) {
      setBanner("Paste the authorization code from Google.");
      return;
    }
    setBusy(true);
    try {
      await api.completeLogin({ code: code.trim(), state: oauthState || undefined });
      setCode("");
      setAuthUrl("");
      setInfo("Google Drive linked. Backups will upload to your Drive folder.");
      pushToast("Google Drive connected", "success");
      await load();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      await api.disconnectDrive();
      pushToast("Google Drive disconnected", "info");
      await load();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Disconnect failed");
    }
  };

  const backupNow = async () => {
    setBusy(true);
    try {
      const result = await api.backupNow();
      setInfo(result.message);
      pushToast(result.message, result.uploaded ? "success" : "info");
      await loadBackups();
      await load();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Backup failed");
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const result = await api.syncNow();
      setInfo(`Pushed ${result.pushed} row(s), pulled ${result.files_pulled} file(s), applied ${result.rows_applied} row(s).`);
      await load();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  };

  const startLan = async () => {
    try {
      const result = await api.startLanServer(Number(lanPort) || 8787);
      setLanUrl(result.url);
      pushToast(`LAN diagnostics listening on ${result.url}`, "success");
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to start LAN server");
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast("Copied to clipboard", "info");
    } catch {
      setBanner("Clipboard is not available.");
    }
  };

  useKeyboardNav({ windowId, onEscape: () => false, mode: () => "EDIT", saveEnabled: false, editEnabled: false });

  return (
    <FormShell
      windowId={windowId}
      title="Google Drive Sync"
      subtitle="Zero-cost atomic snapshots and optional multi-PC delta sync"
      mode="EDIT"
      dirty={false}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={load} disabled={busy}>
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={saveSettings} disabled={busy}>
            Save settings
          </Button>
        </>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        status ? (
          <div className="flex flex-wrap items-center gap-4">
            <span>Last backup: <span className="font-semibold text-ink">{relativeTime(status.last_backup_at)}</span></span>
            <span>Last sync: <span className="font-semibold text-ink">{relativeTime(status.last_sync_at)}</span></span>
            <span>Queued changes: <span className="font-mono font-semibold text-ink">{status.pending_outbox}</span></span>
            <span className="text-inkmut">Applied delta files: {status.applied_files}</span>
          </div>
        ) : (
          <span>Reading sync state…</span>
        )
      }
    >
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-4">
            <div className={cx("rounded-[4px] border px-3 py-2", status?.connected ? "border-[#bcd9cb] bg-mintbg/60" : "border-line bg-white/60")}>
              <div className="text-[8.5px] uppercase tracking-wider text-inkmut">Drive</div>
              <div className="mt-1 flex items-center gap-1.5 text-[12px] font-semibold">
                {status?.connected ? <ShieldCheck size={13} className="text-teal" /> : <Unlink size={13} className="text-inkmut" />}
                {status?.connected ? "Linked" : "Not linked"}
              </div>
            </div>
            <div className="rounded-[4px] border border-line bg-white/60 px-3 py-2">
              <div className="text-[8.5px] uppercase tracking-wider text-inkmut">Outbox</div>
              <div className="mt-1 font-mono text-[16px] font-semibold">{status?.pending_outbox ?? 0}</div>
            </div>
            <div className="rounded-[4px] border border-line bg-white/60 px-3 py-2">
              <div className="text-[8.5px] uppercase tracking-wider text-inkmut">Backups</div>
              <div className="mt-1 font-mono text-[16px] font-semibold">{status?.local_backups.length ?? 0}</div>
            </div>
            <div className="rounded-[4px] border border-line bg-white/60 px-3 py-2">
              <div className="text-[8.5px] uppercase tracking-wider text-inkmut">Device</div>
              <div className="mt-1 truncate font-mono text-[10px]">{status?.device_id.slice(0, 18) ?? "—"}</div>
            </div>
          </div>

          <Panel title="OAuth (PKCE)" subtitle="Desktop OAuth client · no client secret is stored">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="OAuth Client ID" hint="Google Cloud Console → Credentials → Desktop app">
                <TextInput
                  mono
                  value={form.clientId}
                  placeholder="1234567890-xxxx.apps.googleusercontent.com"
                  data-nav-index={1}
                  onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))}
                />
              </Field>
              <Field label="Redirect URI" hint="Register this exact URI on the OAuth client">
                <TextInput
                  mono
                  value={form.redirectUri}
                  data-nav-index={2}
                  onChange={(event) => setForm((current) => ({ ...current, redirectUri: event.target.value }))}
                />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" onClick={startLogin} disabled={busy}>
                <Link2 size={12} /> {status?.connected ? "Reconnect Google Drive" : "Connect Google Drive"}
              </Button>
              {status?.connected ? (
                <Button variant="default" size="sm" onClick={disconnect}>
                  <Unlink size={12} /> Disconnect
                </Button>
              ) : null}
              <span className="text-[9.5px] text-inkmut">
                Scope: drive.file · tokens live only in this device's SQLite settings
              </span>
            </div>

            {authUrl ? (
              <div className="mt-2 space-y-2 rounded-[3px] border border-line bg-parchment/40 p-2">
                <div className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-inkmut">
                  <ExternalLink size={11} /> 1. Approve in Google
                </div>
                <div className="flex gap-1">
                  <TextInput mono readOnly value={authUrl} className="text-[9px]" />
                  <Button variant="default" size="sm" onClick={() => copy(authUrl)}>
                    <Copy size={11} />
                  </Button>
                </div>
                <div className="text-[9px] font-bold uppercase tracking-wider text-inkmut">2. Paste the code</div>
                <div className="flex gap-1">
                  <TextInput
                    mono
                    value={code}
                    placeholder="4/0AX4XfWh…"
                    data-nav-index={3}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <Button variant="accent" size="sm" onClick={completeLogin} disabled={busy}>
                    Complete
                  </Button>
                </div>
              </div>
            ) : null}
          </Panel>

          <Panel title="Automation" subtitle="2-hourly snapshots and 60-second delta sync by default">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <label className="flex h-7 items-center gap-2 rounded-[3px] border border-line bg-white px-2 text-[10.5px]">
                <input
                  type="checkbox"
                  checked={form.autoBackup}
                  data-nav-index={4}
                  onChange={(event) => setForm((current) => ({ ...current, autoBackup: event.target.checked }))}
                  className="h-3 w-3 accent-teal"
                />
                Auto backup
              </label>
              <label className="flex h-7 items-center gap-2 rounded-[3px] border border-line bg-white px-2 text-[10.5px]">
                <input
                  type="checkbox"
                  checked={form.autoSync}
                  data-nav-index={5}
                  onChange={(event) => setForm((current) => ({ ...current, autoSync: event.target.checked }))}
                  className="h-3 w-3 accent-teal"
                />
                Auto delta sync
              </label>
              <Field label="Backup every (hours)">
                <TextInput
                  mono
                  type="number"
                  value={form.backupHours}
                  data-nav-index={6}
                  onChange={(event) => setForm((current) => ({ ...current, backupHours: event.target.value }))}
                />
              </Field>
              <Field label="Sync every (seconds)">
                <TextInput
                  mono
                  type="number"
                  value={form.syncSeconds}
                  data-nav-index={7}
                  onChange={(event) => setForm((current) => ({ ...current, syncSeconds: event.target.value }))}
                />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={backupNow} disabled={busy}>
                <CloudUpload size={12} /> Backup now
              </Button>
              <Button variant="default" size="sm" onClick={syncNow} disabled={busy}>
                <RefreshCw size={12} /> Sync now
              </Button>
              <span className="text-[9.5px] text-inkmut">
                F9 runs a safe backup check before exit.
              </span>
            </div>
          </Panel>

          <Panel title="Local backup archive" bodyClassName="p-0">
            <div className="max-h-[220px] overflow-auto">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th className="text-left">File</th>
                    <th className="text-right">Size</th>
                    <th className="text-left">Modified</th>
                  </tr>
                </thead>
                <tbody>
                  {(backups?.local ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-5 text-center text-[10.5px] text-inkmut">
                        No local snapshots yet. Run “Backup now”.
                      </td>
                    </tr>
                  ) : (
                    (backups?.local ?? []).map((backup) => (
                      <tr key={String(backup.filename)}>
                        <td className="font-mono text-[10px]">{String(backup.filename)}</td>
                        <td className="text-right font-mono text-[10px]">{bytesLabel(Number(backup.bytes ?? 0))}</td>
                        <td className="font-mono text-[10px]">{relativeTime(Number(backup.modified_at ?? 0))}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line bg-parchment/40 px-3 py-1.5 text-[9px] break-all text-inkmut">
              <HardDrive size={10} className="mr-1 inline" /> {status?.backups_dir ?? backups?.dir ?? "app data / backups"}
            </div>
          </Panel>
        </div>

        <aside className="space-y-3">
          <Panel title="Machine identity" bodyClassName="space-y-2">
            <Field label="Device name">
              <TextInput value={form.deviceName} data-nav-index={8} onChange={(event) => setForm((current) => ({ ...current, deviceName: event.target.value }))} />
            </Field>
            <div className="text-[9px] leading-snug text-inkmut">
              Device ID <span className="font-mono">{status?.device_id ?? "—"}</span>
            </div>
          </Panel>

          <Panel title="Company profile" subtitle="Printed on every invoice · GST state drives IGST" bodyClassName="space-y-2">
            <Field label="Company name">
              <TextInput
                value={form.companyName}
                data-nav-index={14}
                onChange={(event) => setForm((current) => ({ ...current, companyName: event.target.value }))}
              />
            </Field>
            <Field label="Address">
              <TextInput
                value={form.companyAddress}
                data-nav-index={15}
                onChange={(event) => setForm((current) => ({ ...current, companyAddress: event.target.value }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="GSTIN">
                <TextInput
                  mono
                  value={form.companyGst}
                  data-nav-index={16}
                  onChange={(event) => setForm((current) => ({ ...current, companyGst: event.target.value.toUpperCase() }))}
                />
              </Field>
              <Field label="DL No.">
                <TextInput
                  mono
                  value={form.companyDl}
                  data-nav-index={17}
                  onChange={(event) => setForm((current) => ({ ...current, companyDl: event.target.value.toUpperCase() }))}
                />
              </Field>
              <Field label="Phone">
                <TextInput
                  mono
                  value={form.companyPhone}
                  data-nav-index={18}
                  onChange={(event) => setForm((current) => ({ ...current, companyPhone: event.target.value }))}
                />
              </Field>
              <Field label="State code" hint="10 = Bihar">
                <TextInput
                  mono
                  value={form.companyStateCode}
                  data-nav-index={19}
                  onChange={(event) => setForm((current) => ({ ...current, companyStateCode: event.target.value }))}
                />
              </Field>
              <Field label="Next estimate no">
                <TextInput
                  mono
                  type="number"
                  value={form.nextEstimate}
                  data-nav-index={20}
                  onChange={(event) => setForm((current) => ({ ...current, nextEstimate: event.target.value }))}
                />
              </Field>
              <Field label="Next tax invoice no">
                <TextInput
                  mono
                  type="number"
                  value={form.nextTax}
                  data-nav-index={21}
                  onChange={(event) => setForm((current) => ({ ...current, nextTax: event.target.value }))}
                />
              </Field>
            </div>
          </Panel>

          <Panel title="Invoice & print defaults" bodyClassName="space-y-2">
            <Field label="Merchant UPI VPA" hint="Printed as a dynamic QR on every invoice">
              <TextInput mono value={form.merchantVpa} data-nav-index={9} onChange={(event) => setForm((current) => ({ ...current, merchantVpa: event.target.value }))} />
            </Field>
            <Field label="Dot-matrix printer" hint="Windows queue name or lp destination">
              <TextInput mono value={form.printerName} data-nav-index={10} onChange={(event) => setForm((current) => ({ ...current, printerName: event.target.value }))} />
            </Field>
            <Field label="Backup folder (Drive)">
              <TextInput mono value={form.backupFolder} data-nav-index={11} onChange={(event) => setForm((current) => ({ ...current, backupFolder: event.target.value }))} />
            </Field>
            <Field label="Sync folder (Drive)">
              <TextInput mono value={form.syncFolder} data-nav-index={12} onChange={(event) => setForm((current) => ({ ...current, syncFolder: event.target.value }))} />
            </Field>
          </Panel>

          <Panel title="LAN diagnostics" subtitle="Read-only Axum endpoint for same-network checks">
            <div className="flex items-end gap-2">
              <Field label="Port">
                <TextInput mono value={lanPort} data-nav-index={13} onChange={(event) => setLanPort(event.target.value)} />
              </Field>
              <Button variant="default" size="sm" onClick={startLan}>
                <ServerCog size={12} /> Start
              </Button>
            </div>
            {lanUrl ? (
              <div className="mt-2 rounded-[3px] border border-line bg-parchment/50 px-2 py-1.5 text-[9px]">
                <div className="font-mono">{lanUrl}/health</div>
                <div className="font-mono">{lanUrl}/outbox</div>
              </div>
            ) : (
              <p className="mt-2 text-[9px] leading-relaxed text-inkmut">
                Google Drive is the primary transport; the LAN server exposes health and pending outbox for on-site
                troubleshooting.
              </p>
            )}
          </Panel>

          {info ? <Banner tone="success">{info}</Banner> : null}

          <div className="rounded-[4px] border border-line bg-white/50 px-3 py-2 text-[9px] leading-relaxed text-inkmut">
            <div className="mb-1 font-bold uppercase tracking-wider text-navy">Backup safety</div>
            Snapshots use SQLite <span className="font-mono">VACUUM INTO</span>, zstd level 6, and 30-day Drive retention.
            Writes continue to be safe while a snapshot is created.
            {!isTauriRuntime() ? " (Browser preview: files are not actually written.)" : ""}
          </div>
        </aside>
      </div>
    </FormShell>
  );
}
