//! Google Drive atomic snapshot backup.
//!
//! Flow: `VACUUM INTO` a consistent SQLite copy, compress it with zstd level 6,
//! then upload to `/Saltbook_Backups/` on Google Drive. Backups older than 30
//! days are pruned. OAuth uses PKCE so no client secret ships with the app.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use rand::distributions::Alphanumeric;
use rand::Rng;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

pub const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
pub const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";
pub const UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3";
pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
pub const BACKUP_RETENTION_DAYS: i64 = 30;

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

fn base64_url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn pkce_pair() -> Pkce {
    let verifier: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64_url(&digest);
    Pkce { verifier, challenge }
}

pub fn random_state() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect()
}

pub fn auth_url(client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> String {
    format!(
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent&state={}",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(DRIVE_SCOPE),
        urlencoding::encode(challenge),
        urlencoding::encode(state)
    )
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: i64,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
}

fn http_client() -> AppResult<Client> {
    Client::builder()
        .timeout(Duration::from_secs(90))
        .user_agent("Saltbook/0.1")
        .build()
        .map_err(AppError::from)
}

pub fn exchange_code(
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> AppResult<TokenSet> {
    let response = http_client()?
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id),
            ("code", code.trim()),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ])
        .send()?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(AppError::new(
            "AUTH",
            format!("Google token exchange failed ({status}): {body}"),
        ));
    }
    Ok(response.json::<TokenSet>()?)
}

pub fn refresh_access_token(client_id: &str, refresh_token: &str) -> AppResult<TokenSet> {
    let response = http_client()?
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(AppError::new(
            "AUTH",
            format!("Google token refresh failed ({status}): {body}"),
        ));
    }
    Ok(response.json::<TokenSet>()?)
}

// ---------------------------------------------------------------------------
// Drive REST client
// ---------------------------------------------------------------------------

pub struct GDriveClient {
    http: Client,
    token: String,
}

impl GDriveClient {
    pub fn new(token: impl Into<String>) -> AppResult<Self> {
        Ok(Self { http: http_client()?, token: token.into() })
    }

    fn get(&self, url: &str) -> AppResult<reqwest::blocking::Response> {
        Ok(self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .send()?
            .error_for_status()?)
    }

    pub fn ensure_folder(&self, name: &str) -> AppResult<String> {
        let query = format!(
            "name = '{}' and mimeType = '{}' and trashed = false",
            name.replace('\'', "\\'"),
            FOLDER_MIME
        );
        let url = format!(
            "{DRIVE_API}/files?q={}&fields=files(id,name)&spaces=drive&pageSize=10",
            urlencoding::encode(&query)
        );
        let body: Value = self.get(&url)?.json()?;
        if let Some(id) = body["files"]
            .as_array()
            .and_then(|files| files.first())
            .and_then(|file| file["id"].as_str())
        {
            return Ok(id.to_string());
        }
        let response = self
            .http
            .post(format!("{DRIVE_API}/files?fields=id,name"))
            .bearer_auth(&self.token)
            .json(&json!({ "name": name, "mimeType": FOLDER_MIME }))
            .send()?
            .error_for_status()?;
        let created: Value = response.json()?;
        created["id"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::new("SYNC", "Google Drive did not return a folder id."))
    }

    /// Find or create a folder inside a specific parent folder.
    pub fn ensure_child_folder(&self, name: &str, parent_id: &str) -> AppResult<String> {
        let query = format!(
            "name = '{}' and mimeType = '{}' and trashed = false and '{}' in parents",
            name.replace('\'', "\\'"),
            FOLDER_MIME,
            parent_id.replace('\'', "\\'")
        );
        let url = format!(
            "{DRIVE_API}/files?q={}&fields=files(id,name)&spaces=drive&pageSize=10",
            urlencoding::encode(&query)
        );
        let body: Value = self.get(&url)?.json()?;
        if let Some(id) = body["files"]
            .as_array()
            .and_then(|files| files.first())
            .and_then(|file| file["id"].as_str())
        {
            return Ok(id.to_string());
        }
        let created: Value = self
            .http
            .post(format!("{DRIVE_API}/files?fields=id,name"))
            .bearer_auth(&self.token)
            .json(&json!({ "name": name, "mimeType": FOLDER_MIME, "parents": [parent_id] }))
            .send()?
            .error_for_status()?
            .json()?;
        created["id"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::new("SYNC", "Google Drive did not return a folder id."))
    }

    pub fn list_files(&self, query: &str) -> AppResult<Vec<Value>> {
        let url = format!(
            "{DRIVE_API}/files?q={}&fields=files(id,name,size,createdTime,modifiedTime)&spaces=drive&pageSize=1000",
            urlencoding::encode(query)
        );
        let body: Value = self.get(&url)?.json()?;
        Ok(body["files"].as_array().cloned().unwrap_or_default())
    }

    /// Upload bytes as a new file inside `parent_id`. Uses a two-step media
    /// upload followed by a metadata patch (Drive accepts this without a
    /// multipart/related body builder).
    pub fn upload_file(
        &self,
        name: &str,
        bytes: &[u8],
        parent_id: &str,
        mime: &str,
    ) -> AppResult<Value> {
        let response = self
            .http
            .post(format!("{UPLOAD_API}/files?uploadType=media&fields=id,name,size"))
            .bearer_auth(&self.token)
            .header("Content-Type", mime)
            .body(bytes.to_vec())
            .send()?
            .error_for_status()?;
        let created: Value = response.json()?;
        let file_id = created["id"]
            .as_str()
            .ok_or_else(|| AppError::new("SYNC", "Google Drive did not return a file id."))?;
        let updated: Value = self
            .http
            .patch(format!("{DRIVE_API}/files/{file_id}?fields=id,name,size"))
            .bearer_auth(&self.token)
            .json(&json!({ "name": name }))
            .query(&[("addParents", parent_id)])
            .send()?
            .error_for_status()?
            .json()?;
        Ok(updated)
    }

    pub fn download_file(&self, file_id: &str) -> AppResult<Vec<u8>> {
        let mut response = self.get(&format!("{DRIVE_API}/files/{file_id}?alt=media"))?;
        let mut buffer = Vec::new();
        response.read_to_end(&mut buffer)?;
        Ok(buffer)
    }

    pub fn delete_file(&self, file_id: &str) -> AppResult<()> {
        self.http
            .delete(format!("{DRIVE_API}/files/{file_id}"))
            .bearer_auth(&self.token)
            .send()?
            .error_for_status()?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Snapshot creation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct BackupOutcome {
    pub filename: String,
    pub local_path: String,
    pub bytes: usize,
    pub uploaded: bool,
    pub file_id: Option<String>,
    pub pruned: usize,
}

/// Create `<out_dir>/saltbook_<timestamp>.db.zst` via VACUUM INTO + zstd(6).
pub fn create_snapshot_file(conn: &rusqlite::Connection, out_dir: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(out_dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f").to_string();
    let raw_path = out_dir.join(format!(".snapshot_{stamp}.db"));
    let escaped = raw_path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}'"))?;
    let raw = std::fs::read(&raw_path)?;
    let compressed = zstd::encode_all(&raw[..], 6)?;
    let final_path = out_dir.join(format!("saltbook_{stamp}.db.zst"));
    std::fs::write(&final_path, &compressed)?;
    let _ = std::fs::remove_file(&raw_path);
    Ok(final_path)
}

pub fn create_atomic_backup(
    conn: &rusqlite::Connection,
    out_dir: &Path,
    uploader: Option<&GDriveClient>,
    folder_name: &str,
) -> AppResult<BackupOutcome> {
    let path = create_snapshot_file(conn, out_dir)?;
    let bytes = std::fs::read(&path)?;
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "saltbook.db.zst".to_string());
    let mut outcome = BackupOutcome {
        filename,
        local_path: path.to_string_lossy().to_string(),
        bytes: bytes.len(),
        uploaded: false,
        file_id: None,
        pruned: 0,
    };
    if let Some(client) = uploader {
        let folder_id = client.ensure_folder(folder_name)?;
        let uploaded = client.upload_file(&outcome.filename, &bytes, &folder_id, "application/zstd")?;
        outcome.uploaded = true;
        outcome.file_id = uploaded["id"].as_str().map(|s| s.to_string());
        outcome.pruned = prune_old_backups(client, &folder_id, BACKUP_RETENTION_DAYS)?;
    }
    Ok(outcome)
}

/// Delete Drive backups older than `days`. Returns the number deleted.
pub fn prune_old_backups(client: &GDriveClient, folder_id: &str, days: i64) -> AppResult<usize> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days);
    let query = format!(
        "'{}' in parents and trashed = false and name contains '.db.zst'",
        folder_id.replace('\'', "\\'")
    );
    let files = client.list_files(&query)?;
    let mut deleted = 0;
    for file in files {
        let Some(created) = file["createdTime"].as_str() else {
            continue;
        };
        let Ok(created) = chrono::DateTime::parse_from_rfc3339(created) else {
            continue;
        };
        if created.with_timezone(&chrono::Utc) < cutoff {
            if let Some(id) = file["id"].as_str() {
                if client.delete_file(id).is_ok() {
                    deleted += 1;
                }
            }
        }
    }
    Ok(deleted)
}

/// Local backup inventory for the settings panel.
pub fn list_local_backups(out_dir: &Path) -> Vec<Value> {
    let mut items = Vec::new();
    let Ok(entries) = std::fs::read_dir(out_dir) else {
        return items;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("zst") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        items.push(json!({
            "filename": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            "path": path.to_string_lossy(),
            "bytes": metadata.len(),
            "modified_at": metadata.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        }));
    }
    items.sort_by(|a, b| {
        b["modified_at"].as_i64().unwrap_or(0).cmp(&a["modified_at"].as_i64().unwrap_or(0))
    });
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_base64url() {
        let pair = pkce_pair();
        assert_eq!(pair.verifier.len(), 64);
        let digest = Sha256::digest(pair.verifier.as_bytes());
        assert_eq!(pair.challenge, base64_url(&digest));
        assert!(!pair.challenge.contains('='));
        assert!(!pair.challenge.contains('+'));
        assert!(!pair.challenge.contains('/'));
    }

    #[test]
    fn auth_url_contains_required_parameters() {
        let url = auth_url("client-123", "http://127.0.0.1:1421/cb", "state-xyz", "challenge-abc");
        assert!(url.contains("client_id=client-123"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("state=state-xyz"));
    }

    #[test]
    fn snapshot_is_a_valid_sqlite_file_after_zstd_roundtrip() {
        let dir = std::env::temp_dir().join(format!("saltbook-snapshot-{}", crate::db::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("source.db");
        let db = crate::db::Db::open(&db_path).unwrap();
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "INSERT INTO product_groups (id, code, name, updated_at) VALUES ('g1','G1','TEST',1)",
                [],
            )
            .unwrap();
        }
        let conn = db.lock().unwrap();
        let snapshot = create_snapshot_file(&conn, &dir).unwrap();
        let compressed = std::fs::read(&snapshot).unwrap();
        let decoded = zstd::decode_all(&compressed[..]).unwrap();
        assert!(decoded.starts_with(b"SQLite format 3\0"));
        let outcome = create_atomic_backup(&conn, &dir, None, "Saltbook_Backups").unwrap();
        assert!(outcome.bytes > 0);
        assert!(!outcome.uploaded);
        assert!(list_local_backups(&dir).len() >= 2);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
