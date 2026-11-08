//! Statutory field validation shared by master-data commands.

use crate::error::{AppError, AppResult};

fn base36_value(c: char) -> Option<u32> {
    match c {
        '0'..='9' => Some(c as u32 - '0' as u32),
        'A'..='Z' | 'a'..='z' => Some(c.to_ascii_uppercase() as u32 - 'A' as u32 + 10),
        _ => None,
    }
}

fn base36_char(value: u32) -> char {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    ALPHABET[(value % 36) as usize] as char
}

/// GSTIN check character for the first 14 characters.
pub fn gstin_check_digit(first14: &str) -> AppResult<char> {
    if first14.len() != 14 {
        return Err(AppError::validation_field(
            "GSTIN must contain exactly 15 characters.",
            "gst_no",
        ));
    }
    let mut sum: u32 = 0;
    for (index, ch) in first14.chars().enumerate() {
        let value = base36_value(ch).ok_or_else(|| {
            AppError::validation_field("GSTIN contains an invalid character.", "gst_no")
        })?;
        let factor = if index % 2 == 0 { 1 } else { 2 };
        let product = value * factor;
        sum += product / 36 + product % 36;
    }
    Ok(base36_char((36 - sum % 36) % 36))
}

/// Validate a 15-character GSTIN, including the mod-36 checksum.
pub fn validate_gstin(raw: &str) -> AppResult<()> {
    let gstin = raw.trim().to_ascii_uppercase();
    if gstin.is_empty() {
        return Ok(());
    }
    if gstin.len() != 15 {
        return Err(AppError::validation_field(
            "GSTIN must contain exactly 15 characters.",
            "gst_no",
        ));
    }
    let bytes = gstin.as_bytes();
    if !bytes[0..2].iter().all(|b| b.is_ascii_digit()) {
        return Err(AppError::validation_field(
            "GSTIN must start with a two-digit state code.",
            "gst_no",
        ));
    }
    let state: u32 = gstin[0..2].parse().unwrap_or(0);
    if !(1..=38).contains(&state) && state != 97 && state != 99 {
        return Err(AppError::validation_field(
            "GSTIN state code must be 01-38 (97/99 for UN bodies).",
            "gst_no",
        ));
    }
    let pan = &gstin[2..12];
    if !pan.chars().enumerate().all(|(i, c)| match i {
        0..=4 => c.is_ascii_uppercase(),
        5..=8 => c.is_ascii_digit(),
        _ => c.is_ascii_uppercase(),
    }) {
        return Err(AppError::validation_field(
            "GSTIN characters 3-12 must be a valid PAN (ABCDE1234F).",
            "gst_no",
        ));
    }
    if !gstin.as_bytes()[12].is_ascii_digit() {
        return Err(AppError::validation_field(
            "GSTIN entity number (13th character) must be a digit.",
            "gst_no",
        ));
    }
    if gstin.as_bytes()[13] != b'Z' {
        return Err(AppError::validation_field(
            "GSTIN's 14th character must be 'Z' by default.",
            "gst_no",
        ));
    }
    let expected = gstin_check_digit(&gstin[0..14])?;
    let actual = gstin.chars().nth(14).unwrap_or(' ');
    if expected != actual {
        return Err(AppError::validation_field(
            format!("GSTIN checksum failed (expected '{expected}' as the last character)."),
            "gst_no",
        ));
    }
    Ok(())
}

/// Build a valid GSTIN from state + PAN (used by demo seeds and importers).
pub fn build_gstin(state_code: &str, pan: &str) -> AppResult<String> {
    let first14 = format!("{state_code}{pan}1Z").to_ascii_uppercase();
    if first14.len() != 14 {
        return Err(AppError::validation("Cannot build GSTIN: PAN must be 10 characters."));
    }
    let check = gstin_check_digit(&first14)?;
    Ok(format!("{first14}{check}"))
}

pub fn validate_pan(raw: &str) -> AppResult<()> {
    let pan = raw.trim().to_ascii_uppercase();
    if pan.is_empty() {
        return Ok(());
    }
    if pan.len() != 10 {
        return Err(AppError::validation_field("PAN must contain 10 characters.", "pan_aadhar"));
    }
    let valid = pan.chars().enumerate().all(|(i, c)| match i {
        0..=4 => c.is_ascii_uppercase(),
        5..=8 => c.is_ascii_digit(),
        9 => c.is_ascii_uppercase(),
        _ => false,
    });
    if !valid {
        return Err(AppError::validation_field(
            "PAN format must be ABCDE1234F.",
            "pan_aadhar",
        ));
    }
    Ok(())
}

pub fn validate_phone(raw: &str) -> AppResult<()> {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if !raw.trim().is_empty() && (digits.len() < 6 || digits.len() > 15) {
        return Err(AppError::validation_field(
            "Phone number must contain 6-15 digits.",
            "phone",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_gstin_passes_checksum() {
        assert!(validate_gstin("27AAPFU0939F1ZV").is_ok());
    }

    #[test]
    fn built_gstins_validate_and_corruption_fails() {
        let gstin = build_gstin("10", "ABCDE1234F").unwrap();
        assert_eq!(gstin.len(), 15);
        assert!(validate_gstin(&gstin).is_ok());

        let mut chars: Vec<char> = gstin.chars().collect();
        let last = chars[14];
        chars[14] = if last == 'A' { 'B' } else { 'A' };
        let broken: String = chars.into_iter().collect();
        assert!(validate_gstin(&broken).is_err());
    }

    #[test]
    fn rejects_short_or_malformed_gstin() {
        assert!(validate_gstin("27AAPFU0939F1Z").is_err());
        assert!(validate_gstin("XXAAPFU0939F1ZV").is_err());
        assert!(validate_gstin("27aapfu0939f1zv").is_ok());
        assert!(validate_gstin("").is_ok());
    }

    #[test]
    fn pan_and_phone_rules() {
        assert!(validate_pan("ABCDE1234F").is_ok());
        assert!(validate_pan("ABCD1234F").is_err());
        assert!(validate_phone("9876543210").is_ok());
        assert!(validate_phone("12").is_err());
    }
}
