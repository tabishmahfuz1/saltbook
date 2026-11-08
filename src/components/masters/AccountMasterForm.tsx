import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, CircleDollarSign, RotateCcw, Save, Search, ShieldAlert } from "lucide-react";
import { api, ApiError } from "../../lib/invoke";
import type { AccountDetail, AccountParty } from "../../types/database";
import type { AccountSaveRequest } from "../../types/ipc";
import { formatMoney, todayDisplay, validateGstin } from "../../lib/format";
import { useLookups } from "../../hooks/useLookups";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useToastStore } from "../../stores/useToastStore";
import { Badge, Banner, Button, Field, Kbd, Panel, ScaledInput, Select, TextInput, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";
import { PartyLookup } from "../ui/lookups";

interface AccountForm {
  id: string | null;
  code: string;
  name: string;
  status: string;
  creation_date: string;
  address_line1: string;
  address_line2: string;
  address_line3: string;
  city: string;
  state: string;
  phone_office: string;
  phone_res: string;
  contact_person: string;
  email: string;
  billing_on_rate: string;
  hq: string;
  mr_name: string;
  linked_company_id: string;
  gst_no: string;
  pan_aadhar: string;
  is_inter_state: boolean;
  dl_no_1: string;
  dl_no_2: string;
  dl_expiry_date: string;
  transport_name: string;
  banker_name: string;
  interest_rate_bps: number;
  cr_limit_scaled: number;
  cr_days: number;
  locking_days: number;
  bills_for_locking: number;
  op_bal_dr_scaled: number;
  op_bal_cr_scaled: number;
}

function blankAccount(code: string): AccountForm {
  return {
    id: null,
    code,
    name: "",
    status: "ACTIVE",
    creation_date: todayDisplay(),
    address_line1: "",
    address_line2: "",
    address_line3: "",
    city: "",
    state: "BIHAR",
    phone_office: "",
    phone_res: "",
    contact_person: "",
    email: "",
    billing_on_rate: "S_RATE",
    hq: "",
    mr_name: "",
    linked_company_id: "",
    gst_no: "",
    pan_aadhar: "",
    is_inter_state: false,
    dl_no_1: "",
    dl_no_2: "",
    dl_expiry_date: "",
    transport_name: "",
    banker_name: "",
    interest_rate_bps: 0,
    cr_limit_scaled: 0,
    cr_days: 30,
    locking_days: 15,
    bills_for_locking: 1,
    op_bal_dr_scaled: 0,
    op_bal_cr_scaled: 0,
  };
}

function fromAccount(account: AccountParty): AccountForm {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    status: account.status,
    creation_date: account.creation_date,
    address_line1: account.address_line1 ?? "",
    address_line2: account.address_line2 ?? "",
    address_line3: account.address_line3 ?? "",
    city: account.city ?? "",
    state: account.state ?? "BIHAR",
    phone_office: account.phone_office ?? "",
    phone_res: account.phone_res ?? "",
    contact_person: account.contact_person ?? "",
    email: account.email ?? "",
    billing_on_rate: account.billing_on_rate,
    hq: account.hq ?? "",
    mr_name: account.mr_name ?? "",
    linked_company_id: account.linked_company_id ?? "",
    gst_no: account.gst_no ?? "",
    pan_aadhar: account.pan_aadhar ?? "",
    is_inter_state: account.is_inter_state === 1,
    dl_no_1: account.dl_no_1 ?? "",
    dl_no_2: account.dl_no_2 ?? "",
    dl_expiry_date: account.dl_expiry_date ?? "",
    transport_name: account.transport_name ?? "",
    banker_name: account.banker_name ?? "",
    interest_rate_bps: account.interest_rate_bps,
    cr_limit_scaled: account.cr_limit_scaled,
    cr_days: account.cr_days,
    locking_days: account.locking_days,
    bills_for_locking: account.bills_for_locking,
    op_bal_dr_scaled: account.op_bal_dr_scaled,
    op_bal_cr_scaled: account.op_bal_cr_scaled,
  };
}

export interface AccountMasterProps {
  windowId: string;
  payload: Record<string, unknown>;
  accountType: "PARTY" | "SUPPLIER";
}

export function AccountMasterForm({ windowId, payload, accountType }: AccountMasterProps) {
  const { lookups } = useLookups();
  const pushToast = useToastStore((state) => state.push);
  const setDirtyStore = useWorkspaceStore((state) => state.setDirty);
  const requestClose = useWorkspaceStore((state) => state.requestClose);

  const [mode, setMode] = useState<"VIEW" | "EDIT" | "NEW">("VIEW");
  const [form, setForm] = useState<AccountForm>(() => blankAccount(""));
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [query, setQuery] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const payloadId = String(payload.id ?? "");
  const payloadCode = String(payload.code ?? "");

  const readOnly = mode === "VIEW";
  const isParty = accountType === "PARTY";

  const markDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      setDirtyStore(windowId, value);
    },
    [setDirtyStore, windowId],
  );

  const loadAccount = useCallback(
    async (request: { id?: string; code?: string }) => {
      setLoading(true);
      setBanner(null);
      try {
        const response = await api.getAccount(request);
        setDetail(response);
        setForm(fromAccount(response.account));
        setQuery(response.account.name);
        setMode("VIEW");
        setFieldErrors({});
        markDirty(false);
      } catch (error) {
        setBanner(error instanceof Error ? error.message : "Unable to load account");
      } finally {
        setLoading(false);
      }
    },
    [markDirty],
  );

  useEffect(() => {
    if (payloadId || payloadCode) {
      loadAccount({ id: payloadId || undefined, code: payloadCode || undefined });
    }
  }, [payloadId, payloadCode, loadAccount]);

  const unlock = useCallback(() => {
    if (!form.id) return;
    setMode("EDIT");
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-window="${windowId}"] [data-nav-index="1"]`)?.focus();
    }, 20);
  }, [form.id, windowId]);

  const update = (patch: Partial<AccountForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    markDirty(true);
  };

  const save = useCallback(async () => {
    setBanner(null);
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = "Name is required.";
    const gstError = validateGstin(form.gst_no);
    if (gstError) errors.gst_no = gstError;
    if (form.op_bal_dr_scaled !== 0 && form.op_bal_cr_scaled !== 0) {
      errors.op_bal = "Opening balance cannot be both Dr and Cr.";
    }
    if (form.pan_aadhar && !/^[A-Z]{5}\d{4}[A-Z]$/.test(form.pan_aadhar.trim().toUpperCase())) {
      errors.pan_aadhar = "PAN must be ABCDE1234F.";
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setBanner("Please fix the highlighted fields before saving.");
      return;
    }
    setSaving(true);
    try {
      const request: AccountSaveRequest = {
        id: form.id,
        account_type: accountType,
        code: form.code || null,
        name: form.name.trim(),
        address_line1: form.address_line1 || null,
        address_line2: form.address_line2 || null,
        address_line3: form.address_line3 || null,
        city: form.city || null,
        state: form.state || null,
        phone_office: form.phone_office || null,
        phone_res: form.phone_res || null,
        contact_person: form.contact_person || null,
        email: form.email || null,
        creation_date: form.creation_date || null,
        billing_on_rate: form.billing_on_rate,
        status: form.status,
        hq: form.hq || null,
        mr_name: form.mr_name || null,
        linked_company_id: form.linked_company_id || null,
        is_inter_state: form.is_inter_state,
        gst_no: form.gst_no.trim().toUpperCase() || null,
        pan_aadhar: form.pan_aadhar.trim().toUpperCase() || null,
        dl_no_1: form.dl_no_1 || null,
        dl_no_2: form.dl_no_2 || null,
        dl_expiry_date: form.dl_expiry_date || null,
        transport_name: form.transport_name || null,
        banker_name: form.banker_name || null,
        interest_rate_bps: form.interest_rate_bps,
        cr_limit_scaled: form.cr_limit_scaled,
        cr_days: form.cr_days,
        locking_days: form.locking_days,
        bills_for_locking: form.bills_for_locking,
        op_bal_dr_scaled: form.op_bal_dr_scaled,
        op_bal_cr_scaled: form.op_bal_cr_scaled,
      };
      const saved = await api.saveAccount(request);
      const refreshed = await api.getAccount({ id: saved.account.id });
      setDetail(refreshed);
      setForm(fromAccount(refreshed.account));
      setQuery(refreshed.account.name);
      setMode("VIEW");
      setFieldErrors({});
      markDirty(false);
      pushToast(`Saved ${refreshed.account.name}`, "success");
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setBanner(apiError?.message ?? "Unable to save account");
      if (apiError?.field) setFieldErrors({ [apiError.field]: apiError.message });
    } finally {
      setSaving(false);
    }
  }, [accountType, form, markDirty, pushToast]);

  const newAccount = useCallback(async () => {
    try {
      const next = await api.nextAccountCode(accountType);
      setForm({ ...blankAccount(next.code), is_inter_state: false });
      setDetail(null);
      setQuery("");
      setMode("NEW");
      setBanner(null);
      setFieldErrors({});
      markDirty(false);
      window.setTimeout(() => {
        document.querySelector<HTMLElement>(`[data-window="${windowId}"] [data-nav-index="1"]`)?.focus();
      }, 30);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to start a new account");
    }
  }, [accountType, markDirty, windowId]);

  const cancel = () => {
    if (mode === "NEW") {
      requestClose(windowId);
      return;
    }
    if (detail) {
      setForm(fromAccount(detail.account));
      setMode("VIEW");
      setFieldErrors({});
      setBanner(null);
      markDirty(false);
    }
  };

  const { formRef, onKeyDown } = useKeyboardNav({
    windowId,
    onSave: save,
    onUnlockEdit: unlock,
    onEscape: () => false,
    mode: () => mode,
    saveEnabled: mode !== "VIEW",
    editEnabled: mode === "VIEW" && Boolean(form.id),
  });

  const credit = detail?.credit;
  const lockTone = credit?.locked ? "danger" : "success";
  const label = isParty ? "Party" : "Supplier";
  const recent = useMemo(() => detail?.recent ?? [], [detail]);

  return (
    <FormShell
      windowId={windowId}
      title={mode === "NEW" ? `New ${label}` : form.name || `${label} Master`}
      subtitle={
        form.id
          ? `${form.code} · ${form.city || "—"} · ${form.gst_no || "no GSTIN"} · ${form.billing_on_rate.replace("_", ".")}`
          : `Search ${isParty ? "customers" : "suppliers"} or create a new account`
      }
      mode={mode}
      dirty={dirty}
      actions={
        mode === "VIEW" ? (
          <Button variant="primary" size="sm" shortcut="Ctrl+E" onClick={unlock} disabled={!form.id}>
            Edit
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={cancel}>
              <RotateCcw size={12} /> Cancel
            </Button>
            <Button variant="primary" size="sm" shortcut="Ctrl+S" onClick={save} disabled={saving}>
              <Save size={12} /> {saving ? "Saving…" : "Save"}
            </Button>
          </>
        )
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <>
          <div className="flex items-center gap-3">
            <span>
              Outstanding:{" "}
              <span className={cx("font-mono font-semibold", (detail?.account.cur_bal_scaled ?? 0) > 0 ? "text-crimson" : "text-teal")}>
                ₹{formatMoney(detail?.account.cur_bal_scaled ?? 0)}
              </span>
            </span>
            <span>
              Credit limit: <span className="font-mono font-semibold">₹{formatMoney(form.cr_limit_scaled)}</span>
            </span>
            {credit?.overdue_count ? (
              <span className="text-crimson">{credit.overdue_count} overdue bill(s)</span>
            ) : (
              <span className="text-teal">No overdue bills</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <Kbd>Ctrl+E</Kbd> unlock
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd> close
            </span>
          </div>
        </>
      }
    >
      <div ref={formRef} onKeyDown={onKeyDown} data-window={windowId} className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3 rounded-[4px] border border-line bg-white/60 px-3 py-2">
            <div className="w-[430px] max-w-full">
              <Field
                label={
                  <span className="flex items-center gap-1">
                    <Search size={10} /> Find {label.toLowerCase()}
                  </span>
                }
              >
                <PartyLookup
                  accountType={accountType}
                  query={query}
                  onQueryChange={setQuery}
                  onSelect={(account) => {
                    void loadAccount({ id: account.id });
                  }}
                  autoFocus
                  navIndex={1}
                />
              </Field>
            </div>
            <div className="flex items-center gap-2 pb-0.5">
              <Button variant="default" size="sm" onClick={newAccount}>
                New {label}
              </Button>
              {loading ? <Badge tone="info">Loading…</Badge> : null}
              {detail ? (
                <Badge tone={lockTone} dot>
                  {credit?.locked ? "Credit locked" : "Credit open"}
                </Badge>
              ) : null}
            </div>
          </div>

          <Panel title={`${label} identity`}>
            <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 md:grid-cols-4">
              <Field label="Account code" error={fieldErrors.code}>
                <TextInput
                  mono
                  value={form.code}
                  readOnly={readOnly}
                  data-nav-index={2}
                  onChange={(event) => update({ code: event.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="Name" required error={fieldErrors.name} className="md:col-span-2">
                <TextInput
                  value={form.name}
                  readOnly={readOnly}
                  data-nav-index={3}
                  className="uppercase"
                  onChange={(event) => update({ name: event.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="Status">
                <Select
                  value={form.status}
                  disabled={readOnly}
                  data-nav-index={4}
                  onChange={(event) => update({ status: event.target.value })}
                >
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INACTIVE">INACTIVE</option>
                </Select>
              </Field>
              <Field label="Address line 1" className="md:col-span-2">
                <TextInput
                  value={form.address_line1}
                  readOnly={readOnly}
                  data-nav-index={5}
                  onChange={(event) => update({ address_line1: event.target.value })}
                />
              </Field>
              <Field label="Address line 2">
                <TextInput
                  value={form.address_line2}
                  readOnly={readOnly}
                  data-nav-index={6}
                  onChange={(event) => update({ address_line2: event.target.value })}
                />
              </Field>
              <Field label="Address line 3">
                <TextInput
                  value={form.address_line3}
                  readOnly={readOnly}
                  data-nav-index={7}
                  onChange={(event) => update({ address_line3: event.target.value })}
                />
              </Field>
              <Field label="City">
                <TextInput
                  value={form.city}
                  readOnly={readOnly}
                  data-nav-index={8}
                  onChange={(event) => update({ city: event.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="State">
                <TextInput
                  value={form.state}
                  readOnly={readOnly}
                  data-nav-index={9}
                  onChange={(event) => update({ state: event.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="Phone (office)">
                <TextInput
                  mono
                  value={form.phone_office}
                  readOnly={readOnly}
                  data-nav-index={10}
                  onChange={(event) => update({ phone_office: event.target.value })}
                />
              </Field>
              <Field label="Phone (res)">
                <TextInput
                  mono
                  value={form.phone_res}
                  readOnly={readOnly}
                  data-nav-index={11}
                  onChange={(event) => update({ phone_res: event.target.value })}
                />
              </Field>
              <Field label="Contact person">
                <TextInput
                  value={form.contact_person}
                  readOnly={readOnly}
                  data-nav-index={12}
                  onChange={(event) => update({ contact_person: event.target.value })}
                />
              </Field>
              <Field label="Email">
                <TextInput
                  value={form.email}
                  readOnly={readOnly}
                  data-nav-index={13}
                  onChange={(event) => update({ email: event.target.value })}
                />
              </Field>
              <Field label="Billing on">
                <Select
                  value={form.billing_on_rate}
                  disabled={readOnly}
                  data-nav-index={14}
                  onChange={(event) => update({ billing_on_rate: event.target.value })}
                >
                  <option value="S_RATE">S.Rate</option>
                  <option value="T_RATE">T.Rate</option>
                  <option value="MRP">MRP</option>
                  <option value="P_RATE">P.Rate</option>
                </Select>
              </Field>
              <Field label="Creation date">
                <TextInput
                  mono
                  value={form.creation_date}
                  readOnly={readOnly}
                  data-nav-index={15}
                  onChange={(event) => update({ creation_date: event.target.value })}
                />
              </Field>
            </div>
          </Panel>

          <Panel title="Statutory details" subtitle="GSTIN is validated with the mod-36 checksum before saving">
            <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 md:grid-cols-4">
              <Field label="GST No." error={fieldErrors.gst_no} className="md:col-span-2">
                <TextInput
                  mono
                  value={form.gst_no}
                  readOnly={readOnly}
                  maxLength={15}
                  data-nav-index={16}
                  className="uppercase"
                  onChange={(event) => update({ gst_no: event.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="PAN / Aadhar" error={fieldErrors.pan_aadhar}>
                <TextInput
                  mono
                  value={form.pan_aadhar}
                  readOnly={readOnly}
                  maxLength={10}
                  data-nav-index={17}
                  className="uppercase"
                  onChange={(event) => update({ pan_aadhar: event.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="Inter State Operation">
                <label className="flex h-7 items-center gap-2 rounded-[3px] border border-line bg-white px-2 text-[11px]">
                  <input
                    type="checkbox"
                    checked={form.is_inter_state}
                    disabled={readOnly}
                    data-nav-index={18}
                    onChange={(event) => update({ is_inter_state: event.target.checked })}
                    className="h-3 w-3 accent-teal"
                  />
                  {form.is_inter_state ? "IGST applies" : "CGST + SGST"}
                </label>
              </Field>
              <Field label="DL No. 1">
                <TextInput
                  value={form.dl_no_1}
                  readOnly={readOnly}
                  data-nav-index={19}
                  onChange={(event) => update({ dl_no_1: event.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="DL No. 2">
                <TextInput
                  value={form.dl_no_2}
                  readOnly={readOnly}
                  data-nav-index={20}
                  onChange={(event) => update({ dl_no_2: event.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="DL expiry">
                <TextInput
                  mono
                  value={form.dl_expiry_date}
                  readOnly={readOnly}
                  placeholder="DD/MM/YYYY"
                  data-nav-index={21}
                  onChange={(event) => update({ dl_expiry_date: event.target.value })}
                />
              </Field>
              <Field label="Transport">
                <TextInput
                  value={form.transport_name}
                  readOnly={readOnly}
                  data-nav-index={22}
                  onChange={(event) => update({ transport_name: event.target.value })}
                />
              </Field>
              <Field label="Banker">
                <TextInput
                  value={form.banker_name}
                  readOnly={readOnly}
                  data-nav-index={23}
                  onChange={(event) => update({ banker_name: event.target.value })}
                />
              </Field>
              {!isParty ? (
                <Field label="Linked company" className="md:col-span-2">
                  <Select
                    value={form.linked_company_id}
                    disabled={readOnly}
                    data-nav-index={24}
                    onChange={(event) => update({ linked_company_id: event.target.value })}
                  >
                    <option value="">— none —</option>
                    {lookups.companies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <>
                  <Field label="HQ">
                    <TextInput
                      value={form.hq}
                      readOnly={readOnly}
                      data-nav-index={24}
                      onChange={(event) => update({ hq: event.target.value })}
                    />
                  </Field>
                  <Field label="MR name">
                    <TextInput
                      value={form.mr_name}
                      readOnly={readOnly}
                      data-nav-index={25}
                      onChange={(event) => update({ mr_name: event.target.value })}
                    />
                  </Field>
                </>
              )}
            </div>
          </Panel>

          <div className="grid gap-3 md:grid-cols-[1.4fr_1fr]">
            <Panel title="Credit control" subtitle="Locking applies to CREDIT invoices only">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cr Limit (₹)">
                  <ScaledInput
                    value={form.cr_limit_scaled}
                    onValueChange={(value) => update({ cr_limit_scaled: value })}
                    readOnly={readOnly}
                    navIndex={26}
                  />
                </Field>
                <Field label="Cr Days">
                  <TextInput
                    mono
                    type="number"
                    value={form.cr_days}
                    readOnly={readOnly}
                    data-nav-index={27}
                    onChange={(event) => update({ cr_days: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Locking Days">
                  <TextInput
                    mono
                    type="number"
                    value={form.locking_days}
                    readOnly={readOnly}
                    data-nav-index={28}
                    onChange={(event) => update({ locking_days: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Bills For Locking">
                  <TextInput
                    mono
                    type="number"
                    value={form.bills_for_locking}
                    readOnly={readOnly}
                    data-nav-index={29}
                    onChange={(event) => update({ bills_for_locking: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Interest rate %">
                  <TextInput
                    mono
                    inputMode="decimal"
                    value={form.interest_rate_bps ? form.interest_rate_bps / 100 : ""}
                    readOnly={readOnly}
                    data-nav-index={30}
                    onChange={(event) =>
                      update({ interest_rate_bps: Math.round((Number(event.target.value) || 0) * 100) })
                    }
                  />
                </Field>
              </div>
            </Panel>

            <Panel title="Opening balance" subtitle="Enter Dr OR Cr, never both" bodyClassName="space-y-2">
              <Field label="Op. Bal (Dr)" error={fieldErrors.op_bal}>
                <ScaledInput
                  value={form.op_bal_dr_scaled}
                  onValueChange={(value) => update({ op_bal_dr_scaled: value, op_bal_cr_scaled: value ? 0 : form.op_bal_cr_scaled })}
                  readOnly={readOnly}
                  navIndex={31}
                />
              </Field>
              <Field label="Op. Bal (Cr)">
                <ScaledInput
                  value={form.op_bal_cr_scaled}
                  onValueChange={(value) => update({ op_bal_cr_scaled: value, op_bal_dr_scaled: value ? 0 : form.op_bal_dr_scaled })}
                  readOnly={readOnly}
                  navIndex={32}
                />
              </Field>
              <div className="flex items-center justify-between border-t border-line/70 pt-2 text-[10px] text-inkmut">
                <span>Current balance</span>
                <span className={cx("font-mono font-semibold", (detail?.account.cur_bal_scaled ?? 0) > 0 ? "text-crimson" : "text-teal")}>
                  ₹{formatMoney(detail?.account.cur_bal_scaled ?? 0)}
                </span>
              </div>
            </Panel>
          </div>
        </div>

        <aside className="space-y-3">
          <div className={cx("rounded-[4px] border px-3 py-3", credit?.locked ? "border-[#e6b8b3] bg-crimsonbg/60" : "border-[#bcd9cb] bg-mintbg/50")}>
            <div className="flex items-center gap-1.5">
              {credit?.locked ? <ShieldAlert size={14} className="text-crimson" /> : <BadgeCheck size={14} className="text-teal" />}
              <span className="text-[10px] font-bold uppercase tracking-[0.12em]">
                {credit?.locked ? "Credit locked" : "Credit available"}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <div className="text-[8.5px] uppercase tracking-wider text-inkmut">Limit</div>
                <div className="font-mono text-[13px] font-semibold">₹{formatMoney(credit?.credit_limit_scaled ?? 0)}</div>
              </div>
              <div>
                <div className="text-[8.5px] uppercase tracking-wider text-inkmut">Outstanding</div>
                <div className="font-mono text-[13px] font-semibold">₹{formatMoney(credit?.outstanding_scaled ?? 0)}</div>
              </div>
              <div>
                <div className="text-[8.5px] uppercase tracking-wider text-inkmut">Available</div>
                <div className="font-mono text-[13px] font-semibold text-teal">₹{formatMoney(credit?.available_scaled ?? 0)}</div>
              </div>
              <div>
                <div className="text-[8.5px] uppercase tracking-wider text-inkmut">Overdue</div>
                <div className={cx("font-mono text-[13px] font-semibold", (credit?.overdue_count ?? 0) > 0 ? "text-crimson" : "text-ink")}>
                  {credit?.overdue_count ?? 0} bills
                </div>
              </div>
            </div>
            {credit?.reasons?.length ? (
              <ul className="mt-2 space-y-1 border-t border-current/10 pt-2 text-[10px] leading-snug">
                {credit.reasons.map((reason) => (
                  <li key={reason}>• {reason}</li>
                ))}
              </ul>
            ) : null}
          </div>

          <Panel title="Account summary" bodyClassName="space-y-1.5 text-[10.5px]">
            <div className="flex justify-between">
              <span className="text-inkmut">Type</span>
              <Badge tone={isParty ? "info" : "accent"}>{accountType}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-inkmut">Code</span>
              <span className="font-mono font-semibold">{form.code || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-inkmut">City</span>
              <span>{form.city || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-inkmut">GSTIN</span>
              <span className="font-mono text-[9.5px]">{form.gst_no || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-inkmut">Billing</span>
              <span>{form.billing_on_rate.replace("_", ".")}</span>
            </div>
          </Panel>

          <Panel title={isParty ? "Recent bills" : "Recent purchases"} bodyClassName="p-0">
            {recent.length === 0 ? (
              <div className="px-3 py-4 text-[10.5px] text-inkmut">No transactions yet.</div>
            ) : (
              <div className="max-h-[260px] overflow-auto">
                {recent.map((row, index) => {
                  const reference = String(row.inv_no_display ?? row.sup_inv_no ?? "—");
                  const amount = Number(row.grand_total_scaled ?? 0);
                  const due = Number(row.due_amt_scaled ?? 0);
                  return (
                    <div
                      key={`${reference}-${index}`}
                      className="flex items-center justify-between gap-2 border-b border-line/50 px-3 py-1.5 last:border-0"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[10.5px] font-semibold">{reference}</div>
                        <div className="text-[9px] text-inkmut">{String(row.inv_date_display ?? "")}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-[10.5px]">₹{formatMoney(amount)}</div>
                        {due > 0 ? <div className="text-[9px] text-crimson">due ₹{formatMoney(due)}</div> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <div className="rounded-[4px] border border-line bg-white/50 px-3 py-2 text-[9.5px] leading-relaxed text-inkmut">
            <div className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wider text-navy">
              <CircleDollarSign size={11} /> Credit rule
            </div>
            A CREDIT bill is blocked when outstanding plus the new bill exceeds the limit, or when unpaid bills older
            than the locking window reach the “Bills for locking” threshold.
          </div>
        </aside>
      </div>
    </FormShell>
  );
}
