import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, Wallet } from "lucide-react";
import { api } from "../../lib/invoke";
import type { AccountParty } from "../../types/database";
import type { VoucherSaveRequest } from "../../types/ipc";
import { formatMoney, todayDisplay } from "../../lib/format";
import { useKeyboardNav } from "../../hooks/useKeyboardNav";
import { useToastStore } from "../../stores/useToastStore";
import { Badge, Banner, Button, Field, Panel, ScaledInput, Select, TextInput, cx } from "../ui/kit";
import { FormShell } from "../ui/FormShell";
import { PartyLookup } from "../ui/lookups";

const FALLBACK_TYPES = [
  { code: "RECEIPT", label: "Receipts", prefix: "RCP" },
  { code: "PAYMENT", label: "Payments", prefix: "PAY" },
  { code: "CONTRA", label: "Contra", prefix: "CON" },
  { code: "JOURNAL", label: "Journal", prefix: "JRN" },
  { code: "PAYSLIP", label: "PaySlip", prefix: "PSL" },
];

interface JournalLine {
  key: string;
  accountType: "PARTY" | "SUPPLIER";
  account: AccountParty | null;
  query: string;
  dr_scaled: number;
  cr_scaled: number;
}

let counter = 0;
function blankJournalLine(): JournalLine {
  counter += 1;
  return {
    key: `journal-${Date.now()}-${counter}`,
    accountType: "PARTY",
    account: null,
    query: "",
    dr_scaled: 0,
    cr_scaled: 0,
  };
}

interface Props {
  windowId: string;
  payload: Record<string, unknown>;
}

export function VoucherEntryForm({ windowId, payload }: Props) {
  const pushToast = useToastStore((state) => state.push);
  const [types, setTypes] = useState(FALLBACK_TYPES);
  const [voucherType, setVoucherType] = useState(String(payload.voucher_type ?? "RECEIPT"));
  const [dateDisplay, setDateDisplay] = useState(todayDisplay);
  const [account, setAccount] = useState<AccountParty | null>(null);
  const [accountQuery, setAccountQuery] = useState("");
  const [contra, setContra] = useState<AccountParty | null>(null);
  const [contraQuery, setContraQuery] = useState("");
  const [amount, setAmount] = useState(0);
  const [paymentMode, setPaymentMode] = useState("CASH");
  const [instrument, setInstrument] = useState("");
  const [narration, setNarration] = useState("");
  const [journal, setJournal] = useState<JournalLine[]>([blankJournalLine(), blankJournalLine()]);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<Array<Record<string, unknown>>>([]);

  const isJournal = voucherType === "JOURNAL";
  const isReceipt = voucherType === "RECEIPT";
  const isPayment = voucherType === "PAYMENT";
  const accountType: "PARTY" | "SUPPLIER" = isPayment ? "SUPPLIER" : "PARTY";

  useEffect(() => {
    api
      .listVoucherTypes()
      .then((response) => setTypes(response.items))
      .catch(() => undefined);
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const response = await api.listVouchers({ limit: 10 });
      setRecent(response.items);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  const journalTotals = useMemo(() => {
    const dr = journal.reduce((sum, line) => sum + line.dr_scaled, 0);
    const cr = journal.reduce((sum, line) => sum + line.cr_scaled, 0);
    return { dr, cr, balanced: dr === cr && dr > 0 };
  }, [journal]);

  const reset = () => {
    setAmount(0);
    setInstrument("");
    setNarration("");
    setJournal([blankJournalLine(), blankJournalLine()]);
    setAccount(null);
    setAccountQuery("");
    setContra(null);
    setContraQuery("");
  };

  const save = useCallback(async () => {
    setBanner(null);
    if (isJournal) {
      if (journal.some((line) => !line.account) || !journalTotals.balanced) {
        setBanner("Every journal line needs an account and debits must equal credits.");
        return;
      }
    } else {
      if (amount <= 0) {
        setBanner("Amount must be greater than zero.");
        return;
      }
      if ((isReceipt || isPayment) && !account) {
        setBanner(isReceipt ? "Select the customer receiving from." : "Select the supplier paying to.");
        return;
      }
    }
    setSaving(true);
    try {
      const request: VoucherSaveRequest = {
        voucher_type: voucherType,
        voucher_date_display: dateDisplay,
        account_id: isJournal ? null : account?.id ?? null,
        contra_account_id: contra?.id ?? null,
        amount_scaled: isJournal ? journalTotals.dr : amount,
        payment_mode: isJournal ? null : paymentMode,
        instrument_no: instrument || null,
        narration: narration || null,
        lines: isJournal
          ? journal.map((line) => ({
              account_id: line.account?.id ?? null,
              dr_scaled: line.dr_scaled,
              cr_scaled: line.cr_scaled,
            }))
          : [],
      };
      const result = await api.saveVoucher(request);
      pushToast(`${result.voucher_no_display} posted · ₹${formatMoney(result.amount_scaled)}`, "success");
      reset();
      loadRecent();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to post voucher");
    } finally {
      setSaving(false);
    }
  }, [
    account,
    amount,
    contra,
    dateDisplay,
    instrument,
    isJournal,
    isPayment,
    isReceipt,
    journal,
    journalTotals,
    loadRecent,
    narration,
    paymentMode,
    pushToast,
    voucherType,
  ]);

  const { formRef, onKeyDown } = useKeyboardNav({
    windowId,
    onSave: save,
    onEscape: () => false,
    mode: () => "NEW",
    saveEnabled: true,
    editEnabled: false,
  });

  return (
    <FormShell
      windowId={windowId}
      title="Voucher Entry"
      subtitle={`${types.find((type) => type.code === voucherType)?.label ?? voucherType} · ${dateDisplay}`}
      mode="NEW"
      dirty={false}
      actions={
        <Button variant="primary" size="sm" shortcut="Ctrl+S" onClick={save} disabled={saving}>
          <Save size={12} /> {saving ? "Posting…" : "Post voucher"}
        </Button>
      }
      banner={banner ? <Banner tone="danger" onClose={() => setBanner(null)}>{banner}</Banner> : undefined}
      footer={
        <div className="flex items-center gap-3">
          <span>
            Amount: <span className="font-mono font-semibold">₹{formatMoney(isJournal ? journalTotals.dr : amount)}</span>
          </span>
          {isJournal ? (
            <span className={cx("font-semibold", journalTotals.balanced ? "text-teal" : "text-crimson")}>
              Dr {formatMoney(journalTotals.dr)} / Cr {formatMoney(journalTotals.cr)}
            </span>
          ) : null}
          <span className="text-inkmut">Party balances update on posting</span>
        </div>
      }
    >
      <div ref={formRef} onKeyDown={onKeyDown} data-window={windowId} className="space-y-3">
        <Panel title="Voucher header">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
            <Field label="Type" className="md:col-span-2">
              <Select
                value={voucherType}
                data-nav-index={1}
                onChange={(event) => {
                  setVoucherType(event.target.value);
                  reset();
                }}
              >
                {types.map((type) => (
                  <option key={type.code} value={type.code}>
                    {type.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date">
              <TextInput mono value={dateDisplay} data-nav-index={2} onChange={(event) => setDateDisplay(event.target.value)} />
            </Field>
            {!isJournal ? (
              <>
                <Field label={isReceipt ? "Customer" : isPayment ? "Supplier" : "Account"} className="md:col-span-2">
                  <PartyLookup
                    accountType={accountType}
                    query={accountQuery}
                    onQueryChange={(value) => {
                      setAccountQuery(value);
                      setAccount(null);
                    }}
                    onSelect={(selected) => {
                      setAccount(selected);
                      setAccountQuery(selected.name);
                    }}
                    navIndex={3}
                  />
                </Field>
                <Field label={isReceipt ? "Received in" : "Paid from"}>
                  <PartyLookup
                    accountType="PARTY"
                    query={contraQuery}
                    onQueryChange={(value) => {
                      setContraQuery(value);
                      setContra(null);
                    }}
                    onSelect={(selected) => {
                      setContra(selected);
                      setContraQuery(selected.name);
                    }}
                    placeholder="Cash / bank account…"
                    navIndex={4}
                  />
                </Field>
                <Field label="Amount">
                  <ScaledInput value={amount} onValueChange={setAmount} navIndex={5} />
                </Field>
                <Field label="Mode">
                  <Select value={paymentMode} data-nav-index={6} onChange={(event) => setPaymentMode(event.target.value)}>
                    <option value="CASH">CASH</option>
                    <option value="UPI">UPI</option>
                    <option value="CHEQUE">CHEQUE</option>
                    <option value="BANK">BANK</option>
                  </Select>
                </Field>
                <Field label="Instrument / UTR">
                  <TextInput value={instrument} data-nav-index={7} onChange={(event) => setInstrument(event.target.value)} />
                </Field>
              </>
            ) : null}
            <Field label="Narration" className={isJournal ? "md:col-span-4" : "md:col-span-2"}>
              <TextInput value={narration} data-nav-index={8} onChange={(event) => setNarration(event.target.value)} />
            </Field>
          </div>
        </Panel>

        {isJournal ? (
          <Panel
            title="Journal lines"
            subtitle="Double-entry: debits must equal credits"
            right={
              <Button variant="default" size="xs" onClick={() => setJournal((current) => [...current, blankJournalLine()])}>
                <Plus size={11} /> Add line
              </Button>
            }
            bodyClassName="p-0"
          >
            <table className="ledger-table min-w-[760px]">
              <thead>
                <tr>
                  <th className="w-[90px]">Type</th>
                  <th className="text-left">Account</th>
                  <th className="text-right">Debit</th>
                  <th className="text-right">Credit</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {journal.map((line, index) => (
                  <tr key={line.key}>
                    <td>
                      <Select
                        value={line.accountType}
                        className="h-6 text-[10px]"
                        data-nav-index={200 + index * 10}
                        onChange={(event) =>
                          setJournal((current) =>
                            current.map((row, position) =>
                              position === index
                                ? {
                                    ...row,
                                    accountType: event.target.value as "PARTY" | "SUPPLIER",
                                    account: null,
                                    query: "",
                                  }
                                : row,
                            ),
                          )
                        }
                      >
                        <option value="PARTY">Party</option>
                        <option value="SUPPLIER">Supplier</option>
                      </Select>
                    </td>
                    <td className="min-w-[260px]">
                      <PartyLookup
                        accountType={line.accountType}
                        query={line.query}
                        onQueryChange={(value) =>
                          setJournal((current) =>
                            current.map((row, position) =>
                              position === index ? { ...row, query: value, account: null } : row,
                            ),
                          )
                        }
                        onSelect={(selected) =>
                          setJournal((current) =>
                            current.map((row, position) =>
                              position === index ? { ...row, account: selected, query: selected.name } : row,
                            ),
                          )
                        }
                        navIndex={200 + index * 10 + 1}
                      />
                    </td>
                    <td className="w-[120px]">
                      <ScaledInput
                        value={line.dr_scaled}
                        onValueChange={(value) =>
                          setJournal((current) =>
                            current.map((row, position) =>
                              position === index ? { ...row, dr_scaled: value, cr_scaled: value ? 0 : row.cr_scaled } : row,
                            ),
                          )
                        }
                        navIndex={200 + index * 10 + 2}
                        className="h-6 px-1.5"
                      />
                    </td>
                    <td className="w-[120px]">
                      <ScaledInput
                        value={line.cr_scaled}
                        onValueChange={(value) =>
                          setJournal((current) =>
                            current.map((row, position) =>
                              position === index ? { ...row, cr_scaled: value, dr_scaled: value ? 0 : row.dr_scaled } : row,
                            ),
                          )
                        }
                        navIndex={200 + index * 10 + 3}
                        className="h-6 px-1.5"
                      />
                    </td>
                    <td className="text-center">
                      <button
                        type="button"
                        className="text-inkmut/60 hover:text-crimson"
                        onClick={() =>
                          setJournal((current) =>
                            current.length <= 2 ? current : current.filter((_, position) => position !== index),
                          )
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Total</td>
                  <td className="text-right font-mono">{formatMoney(journalTotals.dr)}</td>
                  <td className="text-right font-mono">{formatMoney(journalTotals.cr)}</td>
                  <td className="text-center">
                    <Badge tone={journalTotals.balanced ? "success" : "danger"}>
                      {journalTotals.balanced ? "balanced" : "imbalance"}
                    </Badge>
                  </td>
                </tr>
              </tfoot>
            </table>
          </Panel>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <Panel title="Posting preview">
              <div className="flex items-center gap-2 text-[11px]">
                <Wallet size={14} className="text-teal" />
                {isReceipt ? "Party Dr / Cash Cr" : isPayment ? "Party Cr / Cash Dr" : "Balance sheet transfer"}
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-inkmut">
                {isReceipt
                  ? "A receipt credits the customer ledger and reduces their outstanding balance."
                  : isPayment
                    ? "A payment debits the supplier ledger and reduces the payable."
                    : "Contra and payslip vouchers move funds without touching a debtor ledger."}
              </p>
            </Panel>
            <Panel title="Ledger impact">
              <div className="flex justify-between text-[10.5px]">
                <span className="text-inkmut">Party</span>
                <span>{account?.name ?? "—"}</span>
              </div>
              <div className="flex justify-between text-[10.5px]">
                <span className="text-inkmut">Current balance</span>
                <span className={cx("font-mono", (account?.cur_bal_scaled ?? 0) > 0 ? "text-crimson" : "text-teal")}>
                  ₹{formatMoney(account?.cur_bal_scaled ?? 0)}
                </span>
              </div>
              <div className="flex justify-between text-[10.5px]">
                <span className="text-inkmut">Amount</span>
                <span className="font-mono">₹{formatMoney(amount)}</span>
              </div>
            </Panel>
            <Panel title="After posting">
              <div className="flex justify-between text-[10.5px]">
                <span className="text-inkmut">New balance</span>
                <span className="font-mono font-semibold">
                  ₹
                  {formatMoney(
                    account
                      ? account.cur_bal_scaled + (isReceipt ? -amount : isPayment ? amount : 0)
                      : 0,
                  )}
                </span>
              </div>
              <p className="mt-1 text-[9px] text-inkmut">The account ledger receives a matching Dr/Cr entry.</p>
            </Panel>
          </div>
        )}

        <Panel title="Recent vouchers" bodyClassName="p-0">
          <div className="max-h-[220px] overflow-auto">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th className="text-left">No.</th>
                  <th className="text-left">Date</th>
                  <th className="text-left">Type</th>
                  <th className="text-left">Account</th>
                  <th className="text-right">Amount</th>
                  <th className="text-left">Narration</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-5 text-center text-[10.5px] text-inkmut">
                      No vouchers posted yet.
                    </td>
                  </tr>
                ) : (
                  recent.map((row) => (
                    <tr key={String(row.id)}>
                      <td className="font-mono font-semibold">{String(row.voucher_no_display ?? "")}</td>
                      <td className="font-mono text-[10px]">{String(row.voucher_date_display ?? "")}</td>
                      <td>{String(row.voucher_type ?? "")}</td>
                      <td className="max-w-[240px] truncate">{String(row.account_name ?? "")}</td>
                      <td className="text-right font-mono">₹{formatMoney(Number(row.amount_scaled ?? 0))}</td>
                      <td className="max-w-[240px] truncate text-[10px] text-inkmut">{String(row.narration ?? "")}</td>
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
