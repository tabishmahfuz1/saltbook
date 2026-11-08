//! Printing: raw ESC/P for dot-matrix, A4 PDF export and UPI QR rendering.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// A rendered invoice, independent of the source module.
#[derive(Debug, Clone)]
pub struct PrintDoc {
    pub title: String,
    pub lines: Vec<String>,
    pub totals: Vec<String>,
    pub upi_uri: String,
}

pub struct SpoolResult {
    pub path: String,
    pub printer: String,
}

fn center(text: &str, width: usize) -> String {
    let len = text.chars().count();
    if len >= width {
        return text.chars().take(width).collect();
    }
    let left = (width - len) / 2;
    format!("{}{}", " ".repeat(left), text)
}

/// Human-readable preview of the ESC/P receipt.
pub fn esc_p_text(doc: &PrintDoc) -> String {
    let width = 40;
    let mut out = String::new();
    out.push_str(&center(&doc.title, width));
    out.push_str("\r\n");
    out.push_str(&"-".repeat(width));
    out.push_str("\r\n");
    for line in &doc.lines {
        for wrapped in wrap(&line, width) {
            out.push_str(&wrapped);
            out.push_str("\r\n");
        }
    }
    out.push_str(&"-".repeat(width));
    out.push_str("\r\n");
    for line in &doc.totals {
        out.push_str(line);
        out.push_str("\r\n");
    }
    for wrapped in wrap(&format!("UPI: {}", doc.upi_uri), width) {
        out.push_str(&wrapped);
        out.push_str("\r\n");
    }
    out.push_str("\r\n\r\n");
    out
}

fn wrap(line: &str, width: usize) -> Vec<String> {
    if line.chars().count() <= width {
        return vec![line.to_string()];
    }
    let mut result = Vec::new();
    let mut current = String::new();
    for word in line.split(' ') {
        let word_len = word.chars().count();
        if word_len > width {
            if !current.is_empty() {
                result.push(current.trim_end().to_string());
                current = String::new();
            }
            let chars: Vec<char> = word.chars().collect();
            let mut index = 0;
            while index < chars.len() {
                let end = (index + width).min(chars.len());
                result.push(chars[index..end].iter().collect());
                index = end;
            }
            continue;
        }
        if current.chars().count() + word_len + 1 > width && !current.is_empty() {
            result.push(current.trim_end().to_string());
            current = String::new();
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

/// Raw ESC/P bytes for an Epson-compatible dot-matrix printer.
pub fn esc_p_bytes(doc: &PrintDoc, width: usize) -> Vec<u8> {
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(b"\x1b@"); // initialise
    bytes.extend_from_slice(b"\x1b!\x00"); // pica
    for line in esc_p_text(doc).split("\r\n") {
        if line.is_empty() {
            bytes.extend_from_slice(b"\r\n");
            continue;
        }
        bytes.extend_from_slice(line.as_bytes());
        bytes.extend_from_slice(b"\r\n");
    }
    bytes.extend_from_slice(b"\x1b\x64\x03"); // feed 3 lines
    bytes.extend_from_slice(b"\x1d\x56\x00"); // cut (no-op on most dot matrix)
    let _ = width;
    bytes
}

/// Render the UPI payment URI as an inline SVG QR code.
pub fn qr_svg(uri: &str) -> String {
    match qrcode::QrCode::new(uri.as_bytes()) {
        Ok(code) => code
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(140, 140)
            .dark_color(qrcode::render::svg::Color("#12233a"))
            .light_color(qrcode::render::svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}


/// Send raw bytes to a Windows print queue using the spooler's RAW datatype.
/// This is what makes ESC/P work with dot-matrix drivers on Windows.
#[cfg(windows)]
fn send_raw_to_printer(printer: &str, bytes: &[u8]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1W,
    };

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let printer_name = wide(printer);
    let doc_name = wide("Saltbook Invoice");
    let datatype = wide("RAW");
    unsafe {
        let mut handle: HANDLE = std::ptr::null_mut();
        if OpenPrinterW(printer_name.as_ptr(), &mut handle, std::ptr::null()) == 0 {
            return Err("OpenPrinter failed. Check the Windows printer queue name.".into());
        }
        let info = DOC_INFO_1W {
            pDocName: doc_name.as_ptr() as *mut u16,
            pOutputFile: std::ptr::null_mut(),
            pDatatype: datatype.as_ptr() as *mut u16,
        };
        if StartDocPrinterW(handle, 1, &info) == 0 {
            ClosePrinter(handle);
            return Err("StartDocPrinter failed.".into());
        }
        if StartPagePrinter(handle) == 0 {
            EndDocPrinter(handle);
            ClosePrinter(handle);
            return Err("StartPagePrinter failed.".into());
        }
        let mut written = 0u32;
        let ok = WritePrinter(
            handle,
            bytes.as_ptr() as *const core::ffi::c_void,
            bytes.len() as u32,
            &mut written,
        );
        EndPagePrinter(handle);
        EndDocPrinter(handle);
        ClosePrinter(handle);
        if ok == 0 || written as usize != bytes.len() {
            Err("Raw write to the printer failed.".into())
        } else {
            Ok(())
        }
    }
}

fn temp_dir() -> PathBuf {
    std::env::temp_dir().join("saltbook-print")
}

/// Write the ESC/P stream to a spool file and, when a printer is named, send it
/// with `lp -o raw`. The spool path is always returned so the operator can
/// retry manually.
pub fn write_spool(printer: &str, bytes: &[u8]) -> AppResult<SpoolResult> {
    let dir = temp_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("saltbook_{}.prn", chrono::Utc::now().timestamp_millis()));
    let mut file = std::fs::File::create(&path)?;
    file.write_all(bytes)?;
    file.flush()?;

    let mut sent_to = String::new();
    if !printer.trim().is_empty() {
        #[cfg(windows)]
        {
            match send_raw_to_printer(printer.trim(), bytes) {
                Ok(()) => sent_to = printer.trim().to_string(),
                Err(err) => eprintln!("[saltbook] raw print failed: {err}"),
            }
        }
        #[cfg(not(windows))]
        {
            let status = std::process::Command::new("lp")
                .arg("-d")
                .arg(printer.trim())
                .arg("-o")
                .arg("raw")
                .arg(&path)
                .status();
            if let Ok(status) = status {
                if status.success() {
                    sent_to = printer.trim().to_string();
                }
            }
        }
    }
    Ok(SpoolResult { path: path.to_string_lossy().to_string(), printer: sent_to })
}

/// Minimal, dependency-free PDF 1.4 writer (A4, Helvetica, 10pt).
pub fn pdf_bytes(doc: &PrintDoc) -> Vec<u8> {
    let mut text_ops = String::new();
    let mut y = 800.0f32;
    fn escape(text: &str) -> String {
        text.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)")
    }
    text_ops.push_str(&format!(
        "BT /F1 12 Tf 50 {y} Td ({}) Tj ET\n",
        escape(&doc.title)
    ));
    y -= 18.0;
    for line in &doc.lines {
        text_ops.push_str(&format!(
            "BT /F1 9 Tf 50 {y} Td ({}) Tj ET\n",
            escape(line)
        ));
        y -= 12.0;
        if y < 60.0 {
            break;
        }
    }
    y -= 6.0;
    for line in &doc.totals {
        text_ops.push_str(&format!(
            "BT /F1 10 Tf 380 {y} Td ({}) Tj ET\n",
            escape(line)
        ));
        y -= 14.0;
    }
    text_ops.push_str(&format!(
        "BT /F1 7 Tf 50 {y} Td ({}) Tj ET\n",
        escape(&doc.upi_uri)
    ));

    let objects: Vec<String> = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
        format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            text_ops.len(),
            text_ops
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];

    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets: Vec<usize> = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{}\nendobj\n", index + 1, object));
    }
    let xref_offset = pdf.len();
    pdf.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
    pdf.push_str("0000000000 65535 f \n");
    for offset in &offsets {
        pdf.push_str(&format!("{:010} 00000 n \n", offset));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
        objects.len() + 1,
        xref_offset
    ));
    pdf.into_bytes()
}

/// Export the invoice as a PDF. When `dest` is a directory or empty, a unique
/// filename is generated inside it.
pub fn write_pdf(doc: &PrintDoc, dest: Option<&str>) -> AppResult<String> {
    let path: PathBuf = match dest.map(|d| d.trim()).filter(|d| !d.is_empty()) {
        Some(dest) => {
            let candidate = Path::new(dest);
            if candidate.is_dir() {
                candidate.join(format!(
                    "saltbook_{}.pdf",
                    chrono::Utc::now().format("%Y%m%d_%H%M%S")
                ))
            } else {
                candidate.to_path_buf()
            }
        }
        None => {
            let dir = temp_dir();
            std::fs::create_dir_all(&dir)?;
            dir.join(format!(
                "saltbook_{}.pdf",
                chrono::Utc::now().format("%Y%m%d_%H%M%S")
            ))
        }
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, pdf_bytes(doc))?;
    Ok(path.to_string_lossy().to_string())
}

pub fn ensure_doc(doc: &PrintDoc) -> AppResult<()> {
    if doc.lines.is_empty() {
        return Err(AppError::validation("Nothing to print."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> PrintDoc {
        PrintDoc {
            title: "TAX INVOICE".into(),
            lines: vec![
                "SALTBOOK PHARMACEUTICALS".into(),
                "PARTY: HIND MEDICAL - BARH".into(),
                format!("{}", "A very long line that should wrap across the narrow receipt width when printed"),
            ],
            totals: vec!["GRAND TOTAL     2,745.37".into()],
            upi_uri: "upi://pay?pa=saltbook@upi&am=2745.37&cu=INR".into(),
        }
    }

    #[test]
    fn esc_p_has_init_and_preview_contains_title() {
        let doc = sample();
        let bytes = esc_p_bytes(&doc, 40);
        assert!(bytes.starts_with(b"\x1b@"));
        assert!(bytes.windows(3).any(|w| w == b"\x1d\x56\x00"));
        let text = esc_p_text(&doc);
        assert!(text.contains("TAX INVOICE"));
        assert!(text.contains("GRAND TOTAL"));
    }

    #[test]
    fn long_lines_wrap_at_receipt_width() {
        let text = esc_p_text(&sample());
        for line in text.split("\r\n") {
            assert!(
                line.chars().count() <= 40,
                "line too wide: {line:?} ({} chars)",
                line.chars().count()
            );
        }
    }

    #[test]
    fn pdf_is_well_formed() {
        let bytes = pdf_bytes(&sample());
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("%PDF-1.4"));
        assert!(text.trim_end().ends_with("%%EOF"));
        assert!(text.contains("xref"));
        assert!(text.contains("TAX INVOICE"));
    }

    #[test]
    fn qr_svg_renders_paths() {
        let svg = qr_svg("upi://pay?pa=saltbook@upi&am=100&cu=INR");
        assert!(svg.contains("<svg"));
        assert!(svg.contains("<path"));
    }
}
