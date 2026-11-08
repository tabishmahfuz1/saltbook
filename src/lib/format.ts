/** Formatting helpers: Indian currency, expiry MM/YY, GSTIN checksum, dates. */

import { SCALE } from "./math";

export function parseScaled(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return 0;
  const cleaned = String(input).replace(/[,\s₹]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return 0;
  const negative = cleaned.startsWith("-");
  const body = cleaned.replace(/^[-+]/, "");
  const [whole = "0", frac = ""] = body.split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) {
    throw new Error(`'${input}' is not a valid amount.`);
  }
  const padded = (frac + "0000").slice(0, 4);
  const value = Number(whole || 0) * SCALE + Number(padded);
  return negative ? -value : value;
}

export function formatMoney(scaled: number): string {
  const negative = scaled < 0;
  const abs = Math.abs(Math.round(scaled));
  let whole = Math.floor(abs / SCALE);
  let frac = Math.round(((abs % SCALE) * 100) / SCALE);
  if (frac >= 100) {
    whole += 1;
    frac = 0;
  }
  const digits = groupIndian(whole);
  return `${negative ? "-" : ""}${digits}.${String(frac).padStart(2, "0")}`;
}

export function groupIndian(value: number | string): string {
  const digits = String(Math.trunc(Number(value)));
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);
  groups.push(last3);
  return groups.join(",");
}

export function formatRate4(scaled: number): string {
  const negative = scaled < 0;
  const abs = Math.abs(Math.round(scaled));
  const whole = Math.floor(abs / SCALE);
  const frac = abs % SCALE;
  return `${negative ? "-" : ""}${whole}.${String(frac).padStart(4, "0")}`;
}

export function formatQty(qty: number): string {
  return new Intl.NumberFormat("en-IN").format(qty);
}

/** Value for a 2dp money <input>. */
export function inputMoney(scaled: number, decimals = 2): string {
  if (!scaled) return "";
  const negative = scaled < 0;
  const abs = Math.abs(scaled);
  const whole = Math.floor(abs / SCALE);
  if (decimals === 4) {
    const frac = abs % SCALE;
    return `${negative ? "-" : ""}${whole}.${String(frac).padStart(4, "0")}`;
  }
  const cents = Math.round(abs / 100);
  const frac = cents % 100;
  return `${negative ? "-" : ""}${Math.floor(cents / 100)}.${String(frac).padStart(2, "0")}`;
}

export function formatPercent(bps: number): string {
  const value = bps / 100;
  return `${value.toFixed(2).replace(/\.00$/, "")}%`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function todayDisplay(): string {
  return isoToDisplay(todayIso());
}

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function isoToDisplay(iso: string): string {
  const [year, month, day] = iso.split("-");
  if (!year || !month || !day) return iso;
  return `${day}/${month}/${year}`;
}

export function displayToIso(display: string): string {
  const parts = display.trim().split("/");
  if (parts.length !== 3) throw new Error("Date must be DD/MM/YYYY.");
  const [day, month, year] = parts;
  if (day.length !== 2 || month.length !== 2 || year.length !== 4) {
    throw new Error("Date must be DD/MM/YYYY.");
  }
  return `${year}-${month}-${day}`;
}

export function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function startOfMonthIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
}

export interface DatePreset {
  key: string;
  label: string;
  from: string;
  to: string;
}

export function datePresets(): DatePreset[] {
  const today = todayIso();
  const yesterday = addDaysIso(today, -1);
  return [
    { key: "today", label: "Today", from: today, to: today },
    { key: "yesterday", label: "Yesterday", from: yesterday, to: yesterday },
    { key: "last7", label: "Last 7 Days", from: addDaysIso(today, -6), to: today },
    { key: "month", label: "This Month", from: startOfMonthIso(), to: today },
  ];
}

// ---------------------------------------------------------------------------
// Expiry MM/YY
// ---------------------------------------------------------------------------

export function expiryKeyFromMmYy(input: string): number {
  const parts = input.trim().split(/[/\-\s]+/).filter(Boolean);
  if (parts.length !== 2) throw new Error("Expiry must be in MM/YY format, e.g. 03/26.");
  const month = Number(parts[0]);
  const yearInput = Number(parts[1]);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Expiry month must be 01-12.");
  }
  const year = yearInput < 100 ? 2000 + yearInput : yearInput;
  if (!Number.isInteger(year) || year < 1990 || year > 2100) {
    throw new Error("Expiry year is out of range.");
  }
  return year * 100 + month;
}

export function expiryDisplayFromKey(key: number): string {
  return `${pad(key % 100)}/${pad(Math.floor(key / 100) % 100)}`;
}

export function currentExpiryKey(): number {
  const now = new Date();
  return now.getFullYear() * 100 + now.getMonth() + 1;
}

export function addMonthsToKey(key: number, months: number): number {
  const year = Math.floor(key / 100);
  const month = key % 100;
  const total = year * 12 + (month - 1) + months;
  const newYear = Math.floor(total / 12);
  const newMonth = ((total % 12) + 12) % 12;
  return newYear * 100 + newMonth + 1;
}

export function expiryEndDate(key: number): Date | null {
  const year = Math.floor(key / 100);
  const month = key % 100;
  if (month < 1 || month > 12) return null;
  return new Date(year, month, 0, 12, 0, 0);
}

export function daysToExpiry(key: number): number {
  const end = expiryEndDate(key);
  if (!end) return 0;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.round((end.getTime() - today.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Statutory identifiers
// ---------------------------------------------------------------------------

const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function base36Value(char: string): number {
  return BASE36.indexOf(char.toUpperCase());
}

export function gstinCheckDigit(first14: string): string {
  if (first14.length !== 14) throw new Error("GSTIN must contain exactly 15 characters.");
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    const value = base36Value(first14[index]);
    if (value < 0) throw new Error("GSTIN contains an invalid character.");
    const product = value * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return BASE36[(36 - (sum % 36)) % 36];
}

export function validateGstin(raw: string): string | null {
  const gstin = raw.trim().toUpperCase();
  if (!gstin) return null;
  if (gstin.length !== 15) return "GSTIN must contain exactly 15 characters.";
  if (!/^\d{2}/.test(gstin)) return "GSTIN must start with a two-digit state code.";
  const state = Number(gstin.slice(0, 2));
  if (!((state >= 1 && state <= 38) || state === 97 || state === 99)) {
    return "GSTIN state code must be 01-38 (97/99 for UN bodies).";
  }
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(gstin.slice(2, 12))) {
    return "GSTIN characters 3-12 must be a valid PAN (ABCDE1234F).";
  }
  if (!/\d/.test(gstin[12])) return "GSTIN entity number (13th character) must be a digit.";
  if (gstin[13] !== "Z") return "GSTIN's 14th character must be 'Z' by default.";
  try {
    const expected = gstinCheckDigit(gstin.slice(0, 14));
    if (expected !== gstin[14]) {
      return `GSTIN checksum failed (expected '${expected}' as the last character).`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid GSTIN.";
  }
  return null;
}

export function buildGstin(stateCode: string, pan: string): string {
  const first14 = `${stateCode}${pan.toUpperCase()}1Z`;
  return `${first14}${gstinCheckDigit(first14)}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function shortDate(iso: string): string {
  const display = isoToDisplay(iso);
  return display.slice(0, 5);
}

export function relativeTime(epochMs: number): string {
  if (!epochMs) return "never";
  const diff = Date.now() - epochMs;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
