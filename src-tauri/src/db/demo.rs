//! Development demo catalog.
//!
//! This seeder mirrors the sample data from the SRD (MONOCEF 500 VIAL, batch
//! MPG242952, HIND MEDICAL - BARH, ...) and adds a realistic spread of stock,
//! expiries and credit terms so every screen has something to show.
//!
//! Demo rows are intentionally *not* written to `sync_outbox`: they are local
//! development fixtures, and two PCs seeding independently must not diverge.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::db::{current_expiry_key, expiry_display_from_key, new_id, now_ms};
use crate::error::AppResult;
use crate::services::calc_engine::{calc_net_rate, parse_scaled, tax_plan_total_bps};
use crate::services::validation::build_gstin;

#[derive(Debug, Default, Clone, Copy)]
pub struct DemoCounts {
    pub products: i64,
    pub batches: i64,
    pub parties: i64,
    pub suppliers: i64,
    pub invoices: i64,
}

struct DemoProduct {
    code: i64,
    name: &'static str,
    company: &'static str,
    composition: &'static str,
    form: &'static str,
    unit: i64,
    sub: i64,
    mrp: &'static str,
    s_rate: &'static str,
    t_rate: &'static str,
    p_rate: &'static str,
    dis_bps: i64,
    tax: &'static str,
    hsn: &'static str,
    schedule: &'static str,
}

const DEMO_PRODUCTS: &[DemoProduct] = &[
    DemoProduct { code: 249, name: "MONOCEF 500 VIAL", company: "CIPLA", composition: "Ceftriaxone 500mg", form: "INJ", unit: 1, sub: 1, mrp: "285.00", s_rate: "228.00", t_rate: "199.50", p_rate: "142.50", dis_bps: 800, tax: "GST-5", hsn: "30042019", schedule: "H" },
    DemoProduct { code: 250, name: "MONOCEF 250 VIAL", company: "CIPLA", composition: "Ceftriaxone 250mg", form: "INJ", unit: 1, sub: 1, mrp: "168.00", s_rate: "134.40", t_rate: "117.60", p_rate: "84.00", dis_bps: 800, tax: "GST-5", hsn: "30042019", schedule: "H" },
    DemoProduct { code: 118, name: "ALBOSLID-P", company: "MANKIND", composition: "Albendazole 400mg + Ivermectin 6mg", form: "TAB", unit: 1, sub: 1, mrp: "95.00", s_rate: "76.00", t_rate: "66.50", p_rate: "47.50", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 304, name: "ALMOX-500", company: "ALKEM", composition: "Amoxicillin 500mg", form: "CAP", unit: 1, sub: 10, mrp: "210.00", s_rate: "168.00", t_rate: "147.00", p_rate: "105.00", dis_bps: 1000, tax: "GST-12", hsn: "30041020", schedule: "H" },
    DemoProduct { code: 102, name: "AMBRODIL PLUS SYP", company: "CIPLA", composition: "Ambroxol 30mg + Guaiphenesin 50mg + Terbutaline 1.25mg", form: "SYP", unit: 1, sub: 1, mrp: "142.00", s_rate: "113.60", t_rate: "99.40", p_rate: "71.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 88, name: "MONO AZI 500 MG TAB", company: "CIPLA", composition: "Azithromycin 500mg", form: "TAB", unit: 1, sub: 3, mrp: "330.00", s_rate: "264.00", t_rate: "231.00", p_rate: "165.00", dis_bps: 1000, tax: "GST-12", hsn: "30042019", schedule: "H" },
    DemoProduct { code: 415, name: "CALPOL 650", company: "SUN PHARMA", composition: "Paracetamol 650mg", form: "TAB", unit: 1, sub: 15, mrp: "62.00", s_rate: "49.60", t_rate: "43.40", p_rate: "31.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 512, name: "PAN-D CAP", company: "ALKEM", composition: "Pantoprazole 40mg + Domperidone 30mg", form: "CAP", unit: 1, sub: 15, mrp: "245.00", s_rate: "196.00", t_rate: "171.50", p_rate: "122.50", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 603, name: "GLYCOMET 500", company: "USV", composition: "Metformin 500mg", form: "TAB", unit: 1, sub: 20, mrp: "48.00", s_rate: "38.40", t_rate: "33.60", p_rate: "24.00", dis_bps: 1000, tax: "GST-5", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 701, name: "TELMA 40", company: "GLENMARK", composition: "Telmisartan 40mg", form: "TAB", unit: 1, sub: 15, mrp: "128.00", s_rate: "102.40", t_rate: "89.60", p_rate: "64.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 702, name: "ATORVA 10", company: "ZYDUS", composition: "Atorvastatin 10mg", form: "TAB", unit: 1, sub: 15, mrp: "156.00", s_rate: "124.80", t_rate: "109.20", p_rate: "78.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 803, name: "MONTECIP-LC", company: "CIPLA", composition: "Montelukast 10mg + Levocetirizine 5mg", form: "TAB", unit: 1, sub: 10, mrp: "185.00", s_rate: "148.00", t_rate: "129.50", p_rate: "92.50", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 411, name: "DICLOMOL", company: "MICRO LABS", composition: "Diclofenac 50mg + Paracetamol 325mg", form: "TAB", unit: 1, sub: 10, mrp: "72.00", s_rate: "57.60", t_rate: "50.40", p_rate: "36.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 513, name: "TAXIM-O 200", company: "ALKEM", composition: "Cefixime 200mg", form: "TAB", unit: 1, sub: 10, mrp: "420.00", s_rate: "336.00", t_rate: "294.00", p_rate: "210.00", dis_bps: 1000, tax: "GST-12", hsn: "30042019", schedule: "H" },
    DemoProduct { code: 514, name: "OFLOX-OZ", company: "CIPLA", composition: "Ofloxacin 200mg + Ornidazole 500mg", form: "TAB", unit: 1, sub: 10, mrp: "190.00", s_rate: "152.00", t_rate: "133.00", p_rate: "95.00", dis_bps: 1000, tax: "GST-12", hsn: "30042019", schedule: "H" },
    DemoProduct { code: 515, name: "ACILOC 150", company: "ZYDUS", composition: "Ranitidine 150mg", form: "TAB", unit: 1, sub: 20, mrp: "38.00", s_rate: "30.40", t_rate: "26.60", p_rate: "19.00", dis_bps: 1000, tax: "GST-5", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 614, name: "UPRISE D3 60K", company: "ALKEM", composition: "Vitamin D3 60000 IU", form: "CAP", unit: 1, sub: 4, mrp: "220.00", s_rate: "176.00", t_rate: "154.00", p_rate: "110.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 615, name: "FEFOL", company: "ZYDUS", composition: "Iron + Folic Acid", form: "TAB", unit: 1, sub: 30, mrp: "108.00", s_rate: "86.40", t_rate: "75.60", p_rate: "54.00", dis_bps: 1000, tax: "GST-5", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 616, name: "ALERID 10", company: "CIPLA", composition: "Cetirizine 10mg", form: "TAB", unit: 1, sub: 10, mrp: "42.00", s_rate: "33.60", t_rate: "29.40", p_rate: "21.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 617, name: "ASCORIL LS SYP", company: "GLENMARK", composition: "Terbutaline + Bromhexine + Guaiphenesin", form: "SYP", unit: 1, sub: 1, mrp: "158.00", s_rate: "126.40", t_rate: "110.60", p_rate: "79.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 618, name: "LANTUS SOLOSTAR", company: "ABBOTT", composition: "Insulin Glargine 100IU", form: "INJ", unit: 1, sub: 1, mrp: "1180.00", s_rate: "944.00", t_rate: "826.00", p_rate: "590.00", dis_bps: 500, tax: "GST-5", hsn: "30043190", schedule: "COLD_CHAIN" },
    DemoProduct { code: 619, name: "ASTHALIN INHALER", company: "CIPLA", composition: "Salbutamol 100mcg", form: "GEN", unit: 1, sub: 1, mrp: "285.00", s_rate: "228.00", t_rate: "199.50", p_rate: "142.50", dis_bps: 800, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 620, name: "WYSOLONE 100", company: "ZYDUS", composition: "Hydrocortisone 100mg", form: "INJ", unit: 1, sub: 1, mrp: "96.00", s_rate: "76.80", t_rate: "67.20", p_rate: "48.00", dis_bps: 800, tax: "GST-5", hsn: "30043290", schedule: "H" },
    DemoProduct { code: 621, name: "DEXA 4", company: "INTAS", composition: "Dexamethasone 4mg", form: "INJ", unit: 1, sub: 1, mrp: "38.00", s_rate: "30.40", t_rate: "26.60", p_rate: "19.00", dis_bps: 800, tax: "GST-5", hsn: "30043290", schedule: "H" },
    DemoProduct { code: 622, name: "EMESET 4", company: "CIPLA", composition: "Ondansetron 4mg", form: "TAB", unit: 1, sub: 10, mrp: "78.00", s_rate: "62.40", t_rate: "54.60", p_rate: "39.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 623, name: "TRAMAZAC 50", company: "ZYDUS", composition: "Tramadol 50mg", form: "CAP", unit: 1, sub: 10, mrp: "165.00", s_rate: "132.00", t_rate: "115.50", p_rate: "82.50", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "X" },
    DemoProduct { code: 624, name: "ENGERIX-B", company: "GLAXO", composition: "Hepatitis B Vaccine", form: "INJ", unit: 1, sub: 1, mrp: "395.00", s_rate: "316.00", t_rate: "276.50", p_rate: "197.50", dis_bps: 500, tax: "GST-5", hsn: "30024190", schedule: "COLD_CHAIN" },
    DemoProduct { code: 625, name: "ORS POWDER", company: "CIPLA", composition: "ORS Powder", form: "GEN", unit: 1, sub: 1, mrp: "22.00", s_rate: "17.60", t_rate: "15.40", p_rate: "11.00", dis_bps: 1000, tax: "GST-5", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 626, name: "ZINCOVIT", company: "MANKIND", composition: "Zinc 20mg", form: "TAB", unit: 1, sub: 15, mrp: "68.00", s_rate: "54.40", t_rate: "47.60", p_rate: "34.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 627, name: "SHELCAL 500", company: "TORRENT", composition: "Calcium + Vitamin D3", form: "TAB", unit: 1, sub: 15, mrp: "145.00", s_rate: "116.00", t_rate: "101.50", p_rate: "72.50", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 628, name: "AUGMENTIN 625", company: "GLAXO", composition: "Amoxicillin 500mg + Clavulanic 125mg", form: "TAB", unit: 1, sub: 10, mrp: "385.00", s_rate: "308.00", t_rate: "269.50", p_rate: "192.50", dis_bps: 1000, tax: "GST-12", hsn: "30041020", schedule: "H" },
    DemoProduct { code: 629, name: "CROCIN 500", company: "GLAXO", composition: "Paracetamol 500mg", form: "TAB", unit: 1, sub: 15, mrp: "32.00", s_rate: "25.60", t_rate: "22.40", p_rate: "16.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 630, name: "ZERODOL SP", company: "INTAS", composition: "Aceclofenac 100mg + Paracetamol 325mg", form: "TAB", unit: 1, sub: 10, mrp: "168.00", s_rate: "134.40", t_rate: "117.60", p_rate: "84.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 631, name: "CLOPIVAS 75", company: "SUN PHARMA", composition: "Clopidogrel 75mg", form: "TAB", unit: 1, sub: 15, mrp: "210.00", s_rate: "168.00", t_rate: "147.00", p_rate: "105.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 632, name: "METXL 25", company: "TORRENT", composition: "Metoprolol 25mg", form: "TAB", unit: 1, sub: 15, mrp: "92.00", s_rate: "73.60", t_rate: "64.40", p_rate: "46.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 633, name: "ROSUVA 10", company: "SUN PHARMA", composition: "Rosuvastatin 10mg", form: "TAB", unit: 1, sub: 15, mrp: "248.00", s_rate: "198.40", t_rate: "173.60", p_rate: "124.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 634, name: "THYRONORM 50", company: "ABBOTT", composition: "Thyroxine 50mcg", form: "TAB", unit: 1, sub: 120, mrp: "175.00", s_rate: "140.00", t_rate: "122.50", p_rate: "87.50", dis_bps: 1000, tax: "GST-5", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 635, name: "BETADINE OINT", company: "ABBOTT", composition: "Povidone Iodine 5%", form: "OINT", unit: 1, sub: 1, mrp: "68.00", s_rate: "54.40", t_rate: "47.60", p_rate: "34.00", dis_bps: 800, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 636, name: "MOXIKIND EYE DROP", company: "MANKIND", composition: "Moxifloxacin 0.5%", form: "DROP", unit: 1, sub: 1, mrp: "112.00", s_rate: "89.60", t_rate: "78.40", p_rate: "56.00", dis_bps: 800, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 637, name: "ALDIGA 4MG", company: "INTAS", composition: "Deflazacort 4mg", form: "TAB", unit: 1, sub: 10, mrp: "156.00", s_rate: "124.80", t_rate: "109.20", p_rate: "78.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 638, name: "CIPCAL 500", company: "CIPLA", composition: "Calcium Carbonate 500mg", form: "TAB", unit: 1, sub: 15, mrp: "96.00", s_rate: "76.80", t_rate: "67.20", p_rate: "48.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 639, name: "FOLVITE", company: "GLAXO", composition: "Folic Acid 5mg", form: "TAB", unit: 1, sub: 30, mrp: "48.00", s_rate: "38.40", t_rate: "33.60", p_rate: "24.00", dis_bps: 1000, tax: "GST-5", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 640, name: "LASIX 40", company: "ABBOTT", composition: "Furosemide 40mg", form: "TAB", unit: 1, sub: 15, mrp: "42.00", s_rate: "33.60", t_rate: "29.40", p_rate: "21.00", dis_bps: 1000, tax: "GST-5", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 641, name: "ECOSPRIN 75", company: "USV", composition: "Aspirin 75mg", form: "TAB", unit: 1, sub: 14, mrp: "28.00", s_rate: "22.40", t_rate: "19.60", p_rate: "14.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 642, name: "AMLOR 5", company: "ABBOTT", composition: "Amlodipine 5mg", form: "TAB", unit: 1, sub: 15, mrp: "78.00", s_rate: "62.40", t_rate: "54.60", p_rate: "39.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 643, name: "SUCRAFIL 1000", company: "ABBOTT", composition: "Sucralfate 1000mg", form: "TAB", unit: 1, sub: 10, mrp: "188.00", s_rate: "150.40", t_rate: "131.60", p_rate: "94.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "H" },
    DemoProduct { code: 644, name: "LEVOCET 5", company: "CIPLA", composition: "Levocetirizine 5mg", form: "TAB", unit: 1, sub: 10, mrp: "58.00", s_rate: "46.40", t_rate: "40.60", p_rate: "29.00", dis_bps: 1000, tax: "GST-12", hsn: "30049099", schedule: "OTC" },
    DemoProduct { code: 645, name: "NS 0.9% 500ML", company: "CIPLA", composition: "Sodium Chloride 0.9%", form: "GEN", unit: 1, sub: 1, mrp: "38.00", s_rate: "30.40", t_rate: "26.60", p_rate: "19.00", dis_bps: 500, tax: "GST-5", hsn: "30049099", schedule: "OTC" },
];

const DEMO_COMPANIES: &[(&str, &str)] = &[
    ("CIPLA", "CIPLA"),
    ("ALKEM", "ALKEM"),
    ("MANKIND", "MANKIND"),
    ("SUN PHARMA", "SUN"),
    ("MICRO LABS", "MICRO"),
    ("ABBOTT", "ABBOTT"),
    ("ZYDUS", "ZYDUS"),
    ("TORRENT", "TORRENT"),
    ("INTAS", "INTAS"),
    ("GLENMARK", "GLENMARK"),
    ("USV", "USV"),
    ("GLAXO", "GLAXO"),
];

const DEMO_PARTIES: &[(&str, &str, &str, &str, &str, &str, i64, i64, i64, i64, &str)] = &[
    ("C001", "HIND MEDICAL - BARH", "BARH", "ABCDE1234F", "9876543210", "48,250.00", 500_000, 30, 15, 2, "S_RATE"),
    ("C002", "ARADHYA PHARMA - BARH", "BARH", "PQRSX5678K", "9835012345", "18,760.00", 300_000, 21, 15, 1, "T_RATE"),
    ("C003", "SANJAY MEDICO - PATNA", "PATNA", "LMNOP4321Q", "9431011223", "92,500.00", 750_000, 45, 30, 3, "S_RATE"),
    ("C004", "SHREE BALAJI MEDICAL - PATNA", "PATNA", "RSTUV8765W", "9110022334", "0.00", 250_000, 30, 0, 0, "MRP"),
    ("C005", "KUMAR MEDICO - BAKHTIYARPUR", "BAKHTIYARPUR", "GHIJK1122L", "9934455667", "6,400.00", 150_000, 21, 15, 1, "S_RATE"),
    ("C006", "JAI MAA DURGA PHARMA - BEGUSARAI", "BEGUSARAI", "WXYZA7766B", "9709988776", "21,300.00", 400_000, 30, 21, 2, "T_RATE"),
    ("C007", "VARDHMAN MEDICAL - HAJIPUR", "HAJIPUR", "BCDEG5566H", "9001122334", "0.00", 200_000, 15, 0, 0, "S_RATE"),
    ("C008", "MAA LAXMI MEDICO - NAWADA", "NAWADA", "JKLMN2233P", "9856677889", "3,800.00", 120_000, 30, 15, 1, "S_RATE"),
];

const DEMO_SUPPLIERS: &[(&str, &str, &str, &str, &str, &str, &str)] = &[
    ("S001", "MEDPLUS DISTRIBUTORS - PATNA", "PATNA", "MDPST4455A", "CIPLA", "1,25,000.00", "9112233445"),
    ("S002", "CIPLA C&F AGENCY - PATNA", "PATNA", "CIPCF7788B", "CIPLA", "82,500.00", "9223344556"),
    ("S003", "ALKEM AGENCY - MUZAFFARPUR", "MUZAFFARPUR", "ALKMA9900C", "ALKEM", "46,200.00", "9334455667"),
    ("S004", "MANKIND DISTRIBUTOR - PATNA", "PATNA", "MNKND1122D", "MANKIND", "31,750.00", "9445566778"),
    ("S005", "SUN PHARMA C&F - PATNA", "PATNA", "SUNCF3344E", "SUN PHARMA", "64,800.00", "9556677889"),
    ("S006", "MICRO LABS AGENCY - PATNA", "PATNA", "MCRLB5566F", "MICRO LABS", "18,400.00", "9667788990"),
];

fn add_months(key: i64, months: i64) -> i64 {
    let year = key / 100;
    let month = key % 100;
    let total = year * 12 + (month - 1) + months;
    let new_year = total.div_euclid(12);
    let new_month = total.rem_euclid(12) + 1;
    new_year * 100 + new_month
}

fn batch_prefix(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(3)
        .collect::<String>()
        .to_ascii_uppercase()
}

fn ensure_company(tx: &Transaction, code: &str, name: &str, short: &str, now: i64) -> AppResult<String> {
    if let Some(id) = tx
        .query_row("SELECT id FROM companies WHERE code = ?1", params![code], |r| r.get::<_, String>(0))
        .optional()?
    {
        return Ok(id);
    }
    let id = new_id();
    tx.execute(
        "INSERT INTO companies (id, code, name, short_name, updated_at, is_deleted) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        params![id, code, name, short, now],
    )?;
    Ok(id)
}

fn ensure_group(tx: &Transaction, code: &str, name: &str, now: i64) -> AppResult<String> {
    if let Some(id) = tx
        .query_row("SELECT id FROM product_groups WHERE code = ?1", params![code], |r| r.get::<_, String>(0))
        .optional()?
    {
        return Ok(id);
    }
    let id = new_id();
    tx.execute(
        "INSERT INTO product_groups (id, code, name, updated_at, is_deleted) VALUES (?1, ?2, ?3, ?4, 0)",
        params![id, code, name, now],
    )?;
    Ok(id)
}

fn ensure_composition(tx: &Transaction, code: &str, description: &str, now: i64) -> AppResult<String> {
    if let Some(id) = tx
        .query_row("SELECT id FROM compositions WHERE code = ?1", params![code], |r| r.get::<_, String>(0))
        .optional()?
    {
        return Ok(id);
    }
    let id = new_id();
    tx.execute(
        "INSERT INTO compositions (id, code, description, updated_at, is_deleted) VALUES (?1, ?2, ?3, ?4, 0)",
        params![id, code, description, now],
    )?;
    Ok(id)
}

/// Seed products, batches, customers and suppliers. Safe to call repeatedly.
pub fn seed_masters(conn: &mut Connection) -> AppResult<DemoCounts> {
    let now = now_ms();
    let current_key = current_expiry_key();
    let tx = conn.transaction()?;

    // Lookups -----------------------------------------------------------------
    let mut company_ids: HashMap<&str, String> = HashMap::new();
    for (code, name) in DEMO_COMPANIES {
        company_ids.insert(code, ensure_company(&tx, code, name, name, now)?);
    }
    let mut group_ids: HashMap<&str, String> = HashMap::new();
    let groups = [
        ("ANTIBIOTICS", "Antibiotics"),
        ("ANALGESICS", "Analgesics"),
        ("GASTRO", "Gastro Intestinal"),
        ("CARDIAC", "Cardiac / Diabetic"),
        ("RESPIRATORY", "Respiratory"),
        ("VITAMINS", "Vitamins & Supplements"),
        ("DERMA", "Derma / Ointments"),
        ("INJECTABLES", "Injectables & Vaccines"),
    ];
    for (code, name) in groups {
        group_ids.insert(code, ensure_group(&tx, code, name, now)?);
    }

    let tax_plans: HashMap<String, (String, i64)> = {
        let mut stmt = tx.prepare("SELECT id, name, cgst_bps, sgst_bps, igst_bps FROM tax_plans")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                (r.get::<_, String>(0)?, tax_plan_total_bps(r.get(2)?, r.get(3)?, r.get(4)?)),
            ))
        })?;
        rows.collect::<Result<_, _>>()?
    };

    let godown_id: String =
        tx.query_row("SELECT id FROM godowns WHERE code = 'MAIN'", [], |r| r.get(0))?;

    // Suppliers ---------------------------------------------------------------
    let mut supplier_ids: Vec<String> = Vec::new();
    let mut supplier_ids_by_code: HashMap<&str, String> = HashMap::new();
    for (code, name, city, pan, company, opening_cr, phone) in DEMO_SUPPLIERS {
        let existing: Option<String> = tx
            .query_row("SELECT id FROM accounts_parties WHERE code = ?1", params![code], |r| r.get(0))
            .optional()?;
        let id = match existing {
            Some(id) => id,
            None => {
                let id = new_id();
                let gstin = build_gstin("10", pan)?;
                let opening = parse_scaled(opening_cr)?;
                tx.execute(
                    "INSERT INTO accounts_parties
                     (id, account_type, code, name, address_line1, city, state, phone_office, creation_date,
                      billing_on_rate, status, linked_company_id, is_inter_state, gst_no, pan_aadhar,
                      cr_limit_scaled, cr_days, locking_days, bills_for_locking,
                      op_bal_dr_scaled, op_bal_cr_scaled, cur_bal_scaled, updated_at, is_deleted)
                     VALUES (?1,'SUPPLIER',?2,?3,?4,?5,'BIHAR',?6,'01/04/2024','P_RATE','ACTIVE',?7,0,?8,?9,
                             0,0,0,0,0,?10,?11,?12,0)",
                    params![
                        id, code, name, name, city, phone,
                        company_ids.get(company).cloned(),
                        gstin, pan, opening, -opening, now
                    ],
                )?;
                id
            }
        };
        supplier_ids.push(id.clone());
        supplier_ids_by_code.insert(code, id);
    }

    // Customers ---------------------------------------------------------------
    for (code, name, city, pan, phone, opening_dr, limit, cr_days, locking_days, bills_for_locking, billing_on) in DEMO_PARTIES {
        let exists: Option<String> = tx
            .query_row("SELECT id FROM accounts_parties WHERE code = ?1", params![code], |r| r.get(0))
            .optional()?;
        if exists.is_none() {
            let id = new_id();
            let gstin = build_gstin("10", pan)?;
            let opening = parse_scaled(opening_dr)?;
            tx.execute(
                "INSERT INTO accounts_parties
                 (id, account_type, code, name, address_line1, city, state, phone_office, contact_person, creation_date,
                  billing_on_rate, status, is_inter_state, gst_no, pan_aadhar, dl_no_1, dl_no_2,
                  cr_limit_scaled, cr_days, locking_days, bills_for_locking,
                  op_bal_dr_scaled, op_bal_cr_scaled, cur_bal_scaled, updated_at, is_deleted)
                 VALUES (?1,'PARTY',?2,?3,?4,?5,'BIHAR',?6,'MR. VERMA','01/04/2024',?7,'ACTIVE',0,?8,?9,'BR-20B/1234','BR-21B/5678',
                         ?10,?11,?12,?13,?14,0,?14,?15,0)",
                params![
                    id, code, name, name, city, phone, billing_on, gstin, pan,
                    (*limit as i64) * 10_000, cr_days, locking_days, bills_for_locking, opening, now
                ],
            )?;
        }
    }

    // Products & batches ------------------------------------------------------
    let mut product_ids: Vec<String> = Vec::new();
    let mut product_id_by_code: HashMap<i64, String> = HashMap::new();
    for product in DEMO_PRODUCTS {
        let existing: Option<String> = tx
            .query_row("SELECT id FROM products WHERE pro_code = ?1", params![product.code], |r| r.get(0))
            .optional()?;
        let id = match existing {
            Some(id) => id,
            None => {
                let id = new_id();
                let comp_id = ensure_composition(
                    &tx,
                    &format!("CMP{:03}", DEMO_PRODUCTS.iter().position(|p| p.code == product.code).unwrap_or(0) + 1),
                    product.composition,
                    now,
                )?;
                let group_code = match product.form {
                    "INJ" | "DROP" => "INJECTABLES",
                    "OINT" => "DERMA",
                    "SYP" => "RESPIRATORY",
                    _ => match product.code % 4 {
                        0 => "CARDIAC",
                        1 => "ANTIBIOTICS",
                        2 => "ANALGESICS",
                        _ => "VITAMINS",
                    },
                };
                let (sale_tax_id, _) = tax_plans
                    .get(product.tax)
                    .cloned()
                    .unwrap_or_else(|| tax_plans["GST-12"].clone());
                tx.execute(
                    "INSERT INTO products
                     (id, pro_code, name, group_id, pack_unit, pack_subunit, pack_form, case_box_qty,
                      composition_id, company_id, hsn_code, drug_schedule,
                      pur_tax_id, sale_tax_id, tin_tax_id, tout_tax_id,
                      min_qty, max_qty, weight_grams, updated_at, is_deleted)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13,?13,?13,?14,?15,?16,?17,0)",
                    params![
                        id, product.code, product.name,
                        group_ids.get(group_code).cloned(),
                        product.unit, product.sub, product.form,
                        (product.code % 10).max(1),
                        comp_id,
                        company_ids.get(product.company).cloned(),
                        product.hsn, product.schedule,
                        sale_tax_id,
                        (product.code % 40) + 10,
                        (product.code % 400) + 200,
                        (product.code % 500) + 20,
                        now
                    ],
                )?;
                id
            }
        };
        product_ids.push(id.clone());
        product_id_by_code.insert(product.code, id);
    }

    // Batches: three lots per product, with SRD fixtures pinned to real values.
    let mut batch_count = 0i64;
    for (index, product) in DEMO_PRODUCTS.iter().enumerate() {
        let product_id = &product_id_by_code[&product.code];
        let (tax_id, tax_bps) = tax_plans
            .get(product.tax)
            .cloned()
            .unwrap_or_else(|| tax_plans["GST-12"].clone());
        let _ = tax_id;
        let p_rate = parse_scaled(product.p_rate)?;
        let mrp = parse_scaled(product.mrp)?;
        let s_rate = parse_scaled(product.s_rate)?;
        let t_rate = parse_scaled(product.t_rate)?;

        let mut lots: Vec<(String, i64, i64)> = Vec::new();
        match product.code {
            249 => {
                lots.push(("MPG242952".to_string(), 202603, 128));
                lots.push(("MPG242953".to_string(), add_months(current_key, 9), -299));
                lots.push(("MPG242954".to_string(), add_months(current_key, 20), 64));
            }
            118 => {
                lots.push(("GB1716014".to_string(), add_months(current_key, 2), 45));
                lots.push(("GB1716015".to_string(), add_months(current_key, 15), 90));
            }
            304 => {
                lots.push(("MBU1024".to_string(), add_months(current_key, 11), 210));
                lots.push(("MBU1025".to_string(), add_months(current_key, 23), 380));
            }
            _ => {
                let base = (product.code * 7 % 180 + 20) as i64;
                for lot in 0..3i64 {
                    let expiry = add_months(current_key, 1 + lot * 13 + (index as i64 % 3));
                    let qty = (base / (lot + 1)).max(3);
                    let batch_no = format!("{}{}{:02}", batch_prefix(product.name), product.code % 100, lot + 1);
                    lots.push((batch_no, expiry, qty));
                }
            }
        }

        for (lot_index, (batch_no, expiry_key, qty)) in lots.iter().enumerate() {
            let exists: Option<String> = tx
                .query_row(
                    "SELECT id FROM batches WHERE product_id = ?1 AND batch_no = ?2 AND godown_id = ?3",
                    params![product_id, batch_no, godown_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_some() {
                continue;
            }
            let (deal_billed, deal_free) = if product.code % 5 == 0 {
                (10i64, 4i64)
            } else if product.code % 3 == 0 {
                (10, 1)
            } else {
                (0, 0)
            };
            let net_rate = calc_net_rate(p_rate, deal_billed, deal_free, product.dis_bps, tax_bps);
            let tax_qty = if product.code % 11 == 0 { 0 } else { *qty };
            let supplier_id = supplier_ids
                .get(lot_index % supplier_ids.len().max(1))
                .cloned();
            tx.execute(
                "INSERT INTO batches
                 (id, product_id, batch_no, expiry_mm_yy, expiry_sort_key, op_qty, deal_billed, deal_free,
                  cur_qty, tax_stock_qty, mrp_scaled, s_rate_scaled, t_rate_scaled, p_rate_scaled,
                  dis_bps, net_rate_scaled, godown_id, is_provisional, last_supplier_id,
                  updated_at, is_deleted)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,0,?18,?19,0)",
                params![
                    new_id(),
                    product_id,
                    batch_no,
                    expiry_display_from_key(*expiry_key),
                    expiry_key,
                    qty,
                    deal_billed,
                    deal_free,
                    qty,
                    tax_qty,
                    mrp,
                    s_rate,
                    t_rate,
                    p_rate,
                    product.dis_bps,
                    net_rate,
                    godown_id,
                    supplier_id,
                    now
                ],
            )?;
            batch_count += 1;
        }
    }

    // Supplier SKU aliases so the CSV importer has something to resolve.
    if let (Some(supplier), Some(monocef)) = (
        supplier_ids_by_code.get("S001"),
        product_id_by_code.get(&249),
    ) {
        for (alias, product) in [("MONOCEF 500", monocef), ("MONOCEF INJ 500", monocef)] {
            tx.execute(
                "INSERT OR IGNORE INTO supplier_sku_aliases (id, supplier_id, alias_name, product_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![new_id(), supplier, alias, product, now],
            )?;
        }
    }

    let counts = DemoCounts {
        products: tx.query_row("SELECT COUNT(*) FROM products", [], |r| r.get(0))?,
        batches: batch_count,
        parties: tx.query_row("SELECT COUNT(*) FROM accounts_parties WHERE account_type='PARTY'", [], |r| r.get(0))?,
        suppliers: tx.query_row("SELECT COUNT(*) FROM accounts_parties WHERE account_type='SUPPLIER'", [], |r| r.get(0))?,
        invoices: 0,
    };

    tx.commit()?;
    let _ = product_ids;
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_demo_catalog_idempotently() {
        let db = crate::db::Db::open_memory().unwrap();
        let mut conn = db.lock().unwrap();
        let first = seed_masters(&mut conn).unwrap();
        assert!(first.products >= 48, "expected demo products, got {}", first.products);
        assert!(first.batches > 100);
        assert_eq!(first.parties, 8);
        assert_eq!(first.suppliers, 6);
        let second = seed_masters(&mut conn).unwrap();
        assert_eq!(first.products, second.products);
        assert_eq!(second.batches, 0, "second pass must not duplicate batches");

        let name: String = conn
            .query_row("SELECT name FROM products WHERE pro_code = 249", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "MONOCEF 500 VIAL");
        let batch: (i64, i64) = conn
            .query_row(
                "SELECT expiry_sort_key, cur_qty FROM batches WHERE batch_no = 'MPG242952'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(batch, (202603, 128));
    }

    #[test]
    fn demo_gstins_are_valid() {
        let db = crate::db::Db::open_memory().unwrap();
        let mut conn = db.lock().unwrap();
        seed_masters(&mut conn).unwrap();
        let gstin: String = conn
            .query_row("SELECT gst_no FROM accounts_parties WHERE code = 'C001'", [], |r| r.get(0))
            .unwrap();
        crate::services::validation::validate_gstin(&gstin).unwrap();
    }
}
