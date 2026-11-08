# Deploying Saltbook on a shop PC

Saltbook is a single-user desktop application. There is no server and no cloud
dependency: the shop's data lives in one SQLite file on the PC, and Google Drive
is optional backup/sync.

> Do **not** use `npm run dev` for real billing — that is the browser preview with
> an in-memory mock. Use a packaged build (`npm run tauri:build`) or `npm run tauri:dev`
> for a trial run against the real SQLite database.

## 1. Build the installer

Tauri must be built on the target OS. For a Windows shop PC, build on Windows
10/11 (or a Windows CI runner); cross-compiling from macOS is not supported.

### Windows build machine

Install:

1. **Node.js 20 LTS** (includes npm).
2. **Rust** via <https://rustup.rs> with the MSVC toolchain:
   `rustup default stable-msvc`.
3. **Visual Studio 2022 Build Tools** with “Desktop development with C++”.
4. **WebView2 Evergreen Runtime** (preinstalled on current Windows 10/11; the
   installer will bootstrap it if missing).

Then, in the repository:

```powershell
npm ci
npm run tauri:build
```

Artifacts:

```text
src-tauri\target\release\bundle\msi\Saltbook_0.1.0_x64_en-US.msi
src-tauri\target\release\bundle\nsis\Saltbook_0.1.0_x64-setup.exe
```

The NSIS `.exe` is the easiest to hand to a shop. The MSI is better for managed
deployment.

### macOS (if the shop uses a Mac)

```bash
npm ci
npm run tauri:build
# src-tauri/target/release/bundle/dmg/*.dmg
# src-tauri/target/release/bundle/macos/Saltbook.app
```

Unsigned macOS builds need right-click → Open the first time, or `xattr -dr
com.apple.quarantine /Applications/Saltbook.app`.

### Code signing

The current config produces **unsigned** installers. Windows SmartScreen will show
“Windows protected your PC” → **More info → Run anyway**. For a professional
install, sign the NSIS/MSI with a code-signing certificate (Tauri supports
`bundle.windows.certificateThumbprint` / `signCommand`). macOS notarization is
similarly optional.

## 2. Install on the shop PC

Minimum: Windows 10/11 64-bit, 4 GB RAM, 500 MB free disk, 1366×768 display
(the window minimum is 1120×700; 1440×900 or larger is recommended).

1. Copy the installer to the PC and run it.
2. If SmartScreen appears: More info → Run anyway.
3. Launch **Saltbook**.
4. A **release build starts with an empty database** (demo data is only seeded in
   development builds). Use **Setup → Load Demo Catalog** only for training.
5. Open **Setup → Google Drive Sync → Company profile** and set:
   company name, address, GSTIN, DL number, phone, state code, and the **next
   estimate / tax invoice numbers**. These print on every invoice and drive
   IGST vs CGST/SGST.
6. Set the **merchant UPI VPA** and the **dot-matrix printer queue** in the same
   panel, then **Save settings**.

## 3. Where the data lives

The app-data directory is keyed by the bundle identifier `com.saltbook.app`:

| OS | Database | Backups |
| --- | --- | --- |
| Windows | `%APPDATA%\com.saltbook.app\saltbook.db` | `%APPDATA%\com.saltbook.app\backups\` |
| macOS | `~/Library/Application Support/com.saltbook.app/saltbook.db` | `.../backups/` |
| Linux | `~/.local/share/com.saltbook.app/saltbook.db` | `.../backups/` |

The SQLite database uses WAL mode (`saltbook.db-wal`, `saltbook.db-shm` appear
beside it). **Back up while the app is closed**, or use the in-app snapshot which
is consistent even while running.

## 4. Backups and restore

- **Manual:** Setup → Google Drive Sync → Backup now. Creates a zstd-compressed
  `VACUUM INTO` snapshot in the local `backups/` folder and uploads it to
  `/Saltbook_Backups/` when Drive is connected.
- **Automatic:** every 2 hours when Auto backup is enabled. F9 runs a backup
  before exit.
- **Retention:** Drive backups older than 30 days are pruned.

Restore on a new PC:

1. Close Saltbook.
2. Decompress the chosen `saltbook_<timestamp>.db.zst`
   (macOS/Linux: `zstd -d file.db.zst -o saltbook.db`; Windows: 7-Zip/Zstandard).
3. Replace `%APPDATA%\com.saltbook.app\saltbook.db` (remove `-wal`/`-shm` first).
4. Start Saltbook and verify the company profile, invoice numbers and stock.

## 5. Google Drive (optional)

1. Google Cloud Console → Credentials → **OAuth client ID → Desktop app**.
2. Add `http://127.0.0.1:1421/oauth2callback` as a redirect URI.
3. In Saltbook: Setup → Google Drive Sync → paste the client ID → Connect.
4. Approve in the browser, copy the `code=` value from the redirected URL and
   paste it into the panel → Complete.
5. Turn on Auto backup (and Auto delta sync only if there are multiple PCs).

Tokens are stored in the local SQLite settings, not in the cloud.

## 6. Dot-matrix / invoice printing

- Enter the exact **Windows printer queue name** (Settings → Printers & scanners)
  in the Company/Invoice defaults panel. Raw ESC/P bytes are sent with the
  Windows spooler `RAW` datatype, so the printer driver must pass raw data
  through (Generic/Text Only or an Epson ESC/P driver works).
- Use **Print** in the billing screen to preview, then **Send to printer**.
  If the printer does not respond, the raw spool file is kept under the OS temp
  directory and its path is shown.
- On macOS/Linux the same screen uses `lp -d <queue> -o raw` (CUPS).
- **Export PDF** always works and can be printed through the normal OS driver.
- For a Windows queue, avoid “Microsoft Print to PDF” for the dot-matrix path.

## 7. First-day setup checklist

- [ ] Company profile, GSTIN, DL, state code saved.
- [ ] Estimate and tax invoice starting numbers set (they increment on save).
- [ ] Godown `MAIN` exists (seeded automatically).
- [ ] Suppliers and customers entered (or imported).
- [ ] Opening stock via **Purchase → Purchase Invoice** or the CSV importer.
- [ ] Product tax plans and sale/purchase rates verified.
- [ ] Credit limits and locking days set per party.
- [ ] Printer tested with a real estimate and a GST invoice.
- [ ] UPI QR checked (merchant VPA).
- [ ] Google Drive connected and a backup restored on a spare machine at least once.
- [ ] Staff trained on `Enter` / `Esc` / `Ctrl+E` / `Ctrl+S` / `Ctrl+A` / `F9`.

## 8. Multi-PC use

Delta sync is designed for a few PCs, not a hosted multi-tenant server:

- Provision every additional PC from a **Google Drive snapshot of the first PC**
  so godowns, tax plans and invoice series IDs match.
- Invoice numbering is per-device. Use one billing station per series, or give
  each counter its own series code.
- Turn on **Auto delta sync** only after the snapshot restore.

## 9. Updating

1. Back up from the old version.
2. Close Saltbook.
3. Install the new version over the old one (same bundle identifier).
4. The database in the app-data directory is preserved and migrated on start.

There is no auto-updater configured yet; updates are manual installers.

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Blank window / WebView2 error | Install the WebView2 Evergreen Runtime. |
| “Windows protected your PC” | More info → Run anyway (or code-sign the installer). |
| Printer prints nothing | Check the queue name, use a Generic/Text Only or ESC/P driver; the spool file path is shown. |
| GSTIN rejected | 15 characters, valid state code, PAN block and mod-36 check digit. |
| Credit bill blocked | Credit limit / locking days reached; use “Override credit lock” or collect payment. |
| Drive login fails | Redirect URI must match exactly; the OAuth client must be “Desktop app”; paste a fresh code. |
| Data looks wrong after sync | Restore the latest Drive snapshot on both PCs and re-enable sync. |

For developer build/test commands see [README.md](README.md).
