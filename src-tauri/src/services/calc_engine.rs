//! Deterministic billing, GST and purchase net-rate mathematics.
//!
//! All money is `i64` micro-rupees (scaled x 10,000). All percentages are basis
//! points (`100` = 1.00%). No floating point is used anywhere in this module.

use crate::error::{AppError, AppResult};

pub const SCALE: i64 = 10_000;
pub const BPS: i64 = 10_000;

/// Round half-up (away from zero on the .5 boundary) for `n / d` with `d > 0`.
pub fn round_half_up(n: i128, d: i128) -> i128 {
    debug_assert!(d > 0);
    let (sign, abs) = if n < 0 { (-1, -n) } else { (1, n) };
    let q = (abs * 2 + d) / (2 * d);
    sign * q
}

fn clamp_i64(v: i128) -> i64 {
    if v > i64::MAX as i128 {
        i64::MAX
    } else if v < i64::MIN as i128 {
        i64::MIN
    } else {
        v as i64
    }
}

fn mul_div(a: i64, b: i64, d: i64) -> i64 {
    clamp_i64(round_half_up(a as i128 * b as i128, d as i128))
}

/// Apply a basis-point rate to a scaled amount: `amount * bps / 10000`.
pub fn apply_bps(amount_scaled: i64, bps: i64) -> i64 {
    mul_div(amount_scaled, bps, BPS)
}

/// Parse a human money/rate string into micro-rupees.
/// Accepts `"1,234.56"`, `"₹28.4233"`, `"-299"` and empty strings (=> 0).
pub fn parse_scaled(input: &str) -> AppResult<i64> {
    let cleaned: String = input
        .chars()
        .filter(|c| !matches!(c, ',' | '₹' | ' ' | '\u{00a0}'))
        .collect();
    if cleaned.is_empty() || cleaned == "-" || cleaned == "." {
        return Ok(0);
    }
    let negative = cleaned.starts_with('-');
    let body = cleaned.trim_start_matches(['-', '+']);
    let mut parts = body.splitn(2, '.');
    let whole = parts.next().unwrap_or("0");
    let frac = parts.next().unwrap_or("");
    if !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::validation_field(
            format!("'{input}' is not a valid amount."),
            "amount",
        ));
    }
    if frac.len() > 4 {
        return Err(AppError::validation_field(
            "Amounts support at most 4 decimal places.",
            "amount",
        ));
    }
    let whole_val: i128 = if whole.is_empty() { 0 } else { whole.parse::<i128>().unwrap_or(0) };
    let frac_padded = format!("{frac:0<4}");
    let frac_val: i128 = if frac_padded.is_empty() { 0 } else { frac_padded.parse::<i128>().unwrap_or(0) };
    let total = whole_val * SCALE as i128 + frac_val;
    Ok(clamp_i64(if negative { -total } else { total }))
}

/// Format micro-rupees with two decimals, e.g. `1234567800 -> "1,23,456.78"`.
/// Indian digit grouping is used because this string is printed on invoices.
pub fn format_money(scaled: i64) -> String {
    let negative = scaled < 0;
    let abs = (scaled as i128).abs();
    let whole = (abs / SCALE as i128) as u128;
    let frac = round_half_up((abs % SCALE as i128) * 100, SCALE as i128) as u128;
    let (whole, frac) = if frac >= 100 { (whole + 1, 0) } else { (whole, frac) };
    let mut digits = whole.to_string();
    if digits.len() > 3 {
        let last3 = digits.split_off(digits.len() - 3);
        let mut groups: Vec<String> = Vec::new();
        let mut rest = digits;
        while rest.len() > 2 {
            let split = rest.len() - 2;
            groups.insert(0, rest.split_off(split));
        }
        if !rest.is_empty() {
            groups.insert(0, rest);
        }
        groups.push(last3);
        digits = groups.join(",");
    }
    format!("{}{}.{:02}", if negative { "-" } else { "" }, digits, frac)
}

/// Format micro-rupees with four decimals (for NetRate columns).
pub fn format_rate4(scaled: i64) -> String {
    let negative = scaled < 0;
    let abs = (scaled as i128).abs();
    let whole = abs / SCALE as i128;
    let frac = abs % SCALE as i128;
    format!(
        "{}{}.{:04}",
        if negative { "-" } else { "" },
        whole,
        frac
    )
}

/// Format scaled quantity (plain integer).
pub fn format_qty(qty: i64) -> String {
    qty.to_string()
}

/// Round a scaled amount to the nearest whole rupee, returned in micro-rupees.
pub fn round_to_rupee(scaled: i64) -> i64 {
    mul_div(scaled, 1, SCALE) * SCALE
}

/// Purchase NetRate (SRD §4.1), inclusive of purchase GST, 4-decimal precision.
pub fn calc_net_rate(
    p_rate_scaled: i64,
    deal_billed: i64,
    deal_free: i64,
    dis_bps: i64,
    tax_bps: i64,
) -> i64 {
    let total_deal = deal_billed + deal_free;
    let rate_after_dis = if deal_billed > 0 && total_deal > 0 {
        // P * (1 - d/100) * B/(B+F)
        mul_div(mul_div(p_rate_scaled, BPS - dis_bps, BPS), deal_billed, total_deal)
    } else {
        mul_div(p_rate_scaled, BPS - dis_bps, BPS)
    };
    // NetRate = RateAfterDis * (1 + t/100), rounded to 4 decimals
    mul_div(rate_after_dis, BPS + tax_bps, BPS)
}

#[derive(Debug, Clone, Copy)]
pub struct LineInput {
    pub qty: i64,
    pub free_qty: i64,
    pub rate_scaled: i64,
    pub dis_bps: i64,
    pub tax_bps: i64,
    pub tax_inclusive: bool,
    pub is_inter_state: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LineTotals {
    pub gross_scaled: i64,
    pub dis_amt_scaled: i64,
    pub taxable_amt_scaled: i64,
    pub tax_amt_scaled: i64,
    pub cgst_amt_scaled: i64,
    pub sgst_amt_scaled: i64,
    pub igst_amt_scaled: i64,
    pub net_line_scaled: i64,
    pub net_unit_rate_scaled: i64,
}

/// Sales invoice line mathematics (SRD §4.2).
pub fn line_totals(input: LineInput) -> LineTotals {
    let gross = clamp_i64(input.qty as i128 * input.rate_scaled as i128);
    let dis_amt = apply_bps(gross, input.dis_bps);
    let after_dis = gross - dis_amt;

    let (taxable, tax, net_line) = if input.tax_inclusive {
        let taxable = mul_div(after_dis, BPS, BPS + input.tax_bps);
        let tax = after_dis - taxable;
        (taxable, tax, after_dis)
    } else {
        let tax = apply_bps(after_dis, input.tax_bps);
        (after_dis, tax, after_dis + tax)
    };

    let (cgst, sgst, igst) = if input.is_inter_state {
        (0, 0, tax)
    } else {
        let cgst = mul_div(tax, 1, 2);
        (cgst, tax - cgst, 0)
    };

    let net_unit = if input.qty != 0 { mul_div(net_line, 1, input.qty.abs()) } else { input.rate_scaled };

    LineTotals {
        gross_scaled: gross,
        dis_amt_scaled: dis_amt,
        taxable_amt_scaled: taxable,
        tax_amt_scaled: tax,
        cgst_amt_scaled: cgst,
        sgst_amt_scaled: sgst,
        igst_amt_scaled: igst,
        net_line_scaled: net_line,
        net_unit_rate_scaled: net_unit,
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InvoiceTotals {
    pub gross_total_scaled: i64,
    pub dis_amt_scaled: i64,
    pub tax_amt_scaled: i64,
    pub freight_scaled: i64,
    pub oth_adj_scaled: i64,
    pub reclaimed_scaled: i64,
    pub roundoff_scaled: i64,
    pub grand_total_scaled: i64,
    pub paid_amt_scaled: i64,
    pub due_amt_scaled: i64,
    pub dis_bps: i64,
}

/// Aggregate invoice totals. Freight and other adjustments land on the grand
/// total (not taxable value); the invoice is rounded to the nearest rupee.
pub fn invoice_totals(
    lines: &[LineTotals],
    freight_scaled: i64,
    oth_adj_scaled: i64,
    reclaimed_scaled: i64,
    paid_amt_scaled: i64,
    is_sale_return: bool,
) -> InvoiceTotals {
    let sign: i64 = if is_sale_return { -1 } else { 1 };
    let gross: i64 = lines.iter().map(|l| l.gross_scaled).sum();
    let dis: i64 = lines.iter().map(|l| l.dis_amt_scaled).sum();
    let tax: i64 = lines.iter().map(|l| l.tax_amt_scaled).sum();
    let net: i64 = lines.iter().map(|l| l.net_line_scaled).sum();

    let grand_before = net + freight_scaled + oth_adj_scaled - reclaimed_scaled;
    let rounded = round_to_rupee(grand_before);
    let roundoff = rounded - grand_before;
    let grand = rounded * sign;
    let paid = if is_sale_return { 0 } else { paid_amt_scaled };
    let due = grand - paid;

    let dis_bps = if gross != 0 { mul_div(dis, BPS, gross) } else { 0 };

    InvoiceTotals {
        gross_total_scaled: gross * sign,
        dis_amt_scaled: dis * sign,
        tax_amt_scaled: tax * sign,
        freight_scaled: freight_scaled * sign,
        oth_adj_scaled: oth_adj_scaled * sign,
        reclaimed_scaled: reclaimed_scaled * sign,
        roundoff_scaled: roundoff * sign,
        grand_total_scaled: grand,
        paid_amt_scaled: paid,
        due_amt_scaled: due,
        dis_bps,
    }
}

/// Total GST rate of a tax plan, in basis points (CGST + SGST == IGST for a
/// well-formed plan).
pub fn tax_plan_total_bps(cgst_bps: i64, sgst_bps: i64, igst_bps: i64) -> i64 {
    if cgst_bps + sgst_bps > 0 {
        cgst_bps + sgst_bps
    } else {
        igst_bps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_money_strings() {
        assert_eq!(parse_scaled("28.4233").unwrap(), 284_233);
        assert_eq!(parse_scaled("₹1,234.56").unwrap(), 12_345_600);
        assert_eq!(parse_scaled("-299").unwrap(), -2_990_000);
        assert_eq!(parse_scaled("").unwrap(), 0);
        assert_eq!(parse_scaled("0.5").unwrap(), 5_000);
        assert!(parse_scaled("12.34567").is_err());
        assert!(parse_scaled("abc").is_err());
    }

    #[test]
    fn formats_indian_grouping() {
        assert_eq!(format_money(12_345_600), "1,234.56");
        assert_eq!(format_money(123_456_780_000), "1,23,45,678.00");
        assert_eq!(format_money(-2_990_000), "-299.00");
        assert_eq!(format_money(284_233), "28.42");
        assert_eq!(format_rate4(284_233), "28.4233");
        assert_eq!(format_rate4(690_000), "69.0000");
    }

    #[test]
    fn net_rate_follows_deal_and_discount_formula() {
        // P = 100.00, Deal 10+4, Dis 8%, Purchase GST 5%
        let p = parse_scaled("100").unwrap();
        let net = calc_net_rate(p, 10, 4, 800, 500);
        assert_eq!(format_rate4(net), "69.0000");
        assert_eq!(net, 690_000);
    }

    #[test]
    fn net_rate_without_deal() {
        let p = parse_scaled("28.4233").unwrap();
        let net = calc_net_rate(p, 0, 0, 0, 500);
        // 28.4233 * 1.05 = 29.844465 -> 29.8445 (4dp)
        assert_eq!(format_rate4(net), "29.8445");
    }

    #[test]
    fn exclusive_line_math_and_gst_split() {
        let t = line_totals(LineInput {
            qty: 10,
            free_qty: 0,
            rate_scaled: parse_scaled("28.42").unwrap(),
            dis_bps: 800,
            tax_bps: 500,
            tax_inclusive: false,
            is_inter_state: false,
        });
        assert_eq!(t.gross_scaled, 2_842_000);
        assert_eq!(t.dis_amt_scaled, 227_360);
        assert_eq!(t.taxable_amt_scaled, 2_614_640);
        assert_eq!(t.tax_amt_scaled, 130_732);
        assert_eq!(t.net_line_scaled, 2_745_372);
        assert_eq!(t.cgst_amt_scaled, 65_366);
        assert_eq!(t.sgst_amt_scaled, 65_366);
        assert_eq!(t.igst_amt_scaled, 0);
        assert_eq!(t.net_unit_rate_scaled, 274_537);
    }

    #[test]
    fn inter_state_line_puts_everything_in_igst() {
        let t = line_totals(LineInput {
            qty: 1,
            free_qty: 0,
            rate_scaled: parse_scaled("100").unwrap(),
            dis_bps: 0,
            tax_bps: 1200,
            tax_inclusive: false,
            is_inter_state: true,
        });
        assert_eq!(t.tax_amt_scaled, 120_000);
        assert_eq!(t.igst_amt_scaled, 120_000);
        assert_eq!(t.cgst_amt_scaled, 0);
        assert_eq!(t.sgst_amt_scaled, 0);
    }

    #[test]
    fn inclusive_line_math() {
        let t = line_totals(LineInput {
            qty: 1,
            free_qty: 0,
            rate_scaled: parse_scaled("105").unwrap(),
            dis_bps: 0,
            tax_bps: 500,
            tax_inclusive: true,
            is_inter_state: false,
        });
        assert_eq!(t.net_line_scaled, 1_050_000);
        assert_eq!(t.taxable_amt_scaled, 1_000_000);
        assert_eq!(t.tax_amt_scaled, 50_000);
        assert_eq!(t.cgst_amt_scaled, 25_000);
    }

    #[test]
    fn invoice_rounding_to_nearest_rupee() {
        let lines = vec![line_totals(LineInput {
            qty: 3,
            free_qty: 0,
            rate_scaled: parse_scaled("10.33").unwrap(),
            dis_bps: 0,
            tax_bps: 0,
            tax_inclusive: false,
            is_inter_state: false,
        })];
        // 30.99 -> 31.00, roundoff +0.01
        let t = invoice_totals(&lines, 0, 0, 0, 0, false);
        assert_eq!(t.grand_total_scaled, 310_000);
        assert_eq!(t.roundoff_scaled, 100);
        assert_eq!(t.due_amt_scaled, 310_000);
    }

    #[test]
    fn sale_return_negates_totals() {
        let lines = vec![line_totals(LineInput {
            qty: 2,
            free_qty: 0,
            rate_scaled: parse_scaled("100").unwrap(),
            dis_bps: 0,
            tax_bps: 500,
            tax_inclusive: false,
            is_inter_state: false,
        })];
        let t = invoice_totals(&lines, 0, 0, 0, 0, true);
        assert_eq!(t.grand_total_scaled, -2_100_000);
        assert_eq!(t.tax_amt_scaled, -100_000);
        assert_eq!(t.paid_amt_scaled, 0);
    }

    #[test]
    fn rounding_handles_half_up_and_negatives() {
        assert_eq!(round_half_up(5, 2), 3);
        assert_eq!(round_half_up(-5, 2), -3);
        assert_eq!(round_to_rupee(15_000), 20_000);
        assert_eq!(round_to_rupee(-15_000), -20_000);
        assert_eq!(round_to_rupee(1_050_000), 1_050_000);
    }
}
