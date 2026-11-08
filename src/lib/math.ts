/**
 * Deterministic micro-rupee maths, mirrored 1:1 with
 * `src-tauri/src/services/calc_engine.rs`. Integer arithmetic only.
 */

export const SCALE = 10_000;
export const BPS = 10_000;

export function roundHalfUp(n: number, d: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) {
    throw new Error(`Invalid rounding: ${n}/${d}`);
  }
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  return sign * Math.floor((abs * 2 + d) / (2 * d));
}

export function mulDiv(a: number, b: number, d: number): number {
  return roundHalfUp(a * b, d);
}

/** Apply basis points to a scaled amount. */
export function applyBps(amountScaled: number, bps: number): number {
  return mulDiv(amountScaled, bps, BPS);
}

/** Round a scaled amount to the nearest whole rupee. */
export function roundToRupee(scaled: number): number {
  return mulDiv(scaled, 1, SCALE) * SCALE;
}

/** Purchase NetRate, inclusive of purchase GST, at 4 decimals. */
export function calcNetRate(
  pRateScaled: number,
  dealBilled: number,
  dealFree: number,
  disBps: number,
  taxBps: number,
): number {
  const totalDeal = dealBilled + dealFree;
  const rateAfterDis =
    dealBilled > 0 && totalDeal > 0
      ? mulDiv(mulDiv(pRateScaled, BPS - disBps, BPS), dealBilled, totalDeal)
      : mulDiv(pRateScaled, BPS - disBps, BPS);
  return mulDiv(rateAfterDis, BPS + taxBps, BPS);
}

export interface LineInput {
  qty: number;
  free_qty?: number;
  rate_scaled: number;
  dis_bps: number;
  tax_bps: number;
  tax_inclusive?: boolean;
  is_inter_state?: boolean;
}

export interface LineTotals {
  gross_scaled: number;
  dis_amt_scaled: number;
  taxable_amt_scaled: number;
  tax_amt_scaled: number;
  cgst_amt_scaled: number;
  sgst_amt_scaled: number;
  igst_amt_scaled: number;
  net_line_scaled: number;
  net_unit_rate_scaled: number;
}

export function lineTotals(input: LineInput): LineTotals {
  const gross = input.qty * input.rate_scaled;
  const disAmt = applyBps(gross, input.dis_bps);
  const afterDis = gross - disAmt;

  let taxable: number;
  let tax: number;
  let netLine: number;
  if (input.tax_inclusive) {
    taxable = mulDiv(afterDis, BPS, BPS + input.tax_bps);
    tax = afterDis - taxable;
    netLine = afterDis;
  } else {
    taxable = afterDis;
    tax = applyBps(afterDis, input.tax_bps);
    netLine = afterDis + tax;
  }

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (input.is_inter_state) {
    igst = tax;
  } else {
    cgst = mulDiv(tax, 1, 2);
    sgst = tax - cgst;
  }

  const netUnit = input.qty !== 0 ? mulDiv(netLine, 1, Math.abs(input.qty)) : input.rate_scaled;

  return {
    gross_scaled: gross,
    dis_amt_scaled: disAmt,
    taxable_amt_scaled: taxable,
    tax_amt_scaled: tax,
    cgst_amt_scaled: cgst,
    sgst_amt_scaled: sgst,
    igst_amt_scaled: igst,
    net_line_scaled: netLine,
    net_unit_rate_scaled: netUnit,
  };
}

export interface InvoiceTotals {
  gross_total_scaled: number;
  dis_amt_scaled: number;
  tax_amt_scaled: number;
  freight_scaled: number;
  oth_adj_scaled: number;
  reclaimed_scaled: number;
  roundoff_scaled: number;
  grand_total_scaled: number;
  paid_amt_scaled: number;
  due_amt_scaled: number;
  dis_bps: number;
}

export function invoiceTotals(
  lines: LineTotals[],
  freightScaled: number,
  othAdjScaled: number,
  reclaimedScaled: number,
  paidAmtScaled: number,
  isSaleReturn: boolean,
): InvoiceTotals {
  const sign = isSaleReturn ? -1 : 1;
  const gross = lines.reduce((sum, line) => sum + line.gross_scaled, 0);
  const dis = lines.reduce((sum, line) => sum + line.dis_amt_scaled, 0);
  const tax = lines.reduce((sum, line) => sum + line.tax_amt_scaled, 0);
  const net = lines.reduce((sum, line) => sum + line.net_line_scaled, 0);

  const grandBefore = net + freightScaled + othAdjScaled - reclaimedScaled;
  const rounded = roundToRupee(grandBefore);
  const roundoff = rounded - grandBefore;
  const grand = rounded * sign;
  const paid = isSaleReturn ? 0 : paidAmtScaled;
  const due = grand - paid;
  const disBps = gross !== 0 ? mulDiv(dis, BPS, gross) : 0;

  return {
    gross_total_scaled: gross * sign,
    dis_amt_scaled: dis * sign,
    tax_amt_scaled: tax * sign,
    freight_scaled: freightScaled * sign,
    oth_adj_scaled: othAdjScaled * sign,
    reclaimed_scaled: reclaimedScaled * sign,
    roundoff_scaled: roundoff * sign,
    grand_total_scaled: grand,
    paid_amt_scaled: paid,
    due_amt_scaled: due,
    dis_bps: disBps,
  };
}
