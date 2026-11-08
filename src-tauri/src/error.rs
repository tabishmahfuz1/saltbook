use std::fmt;

/// Serializable application error.
///
/// Every Tauri command returns `Result<T, AppError>`, which serializes to
/// `{ code, message, field? }` so the UI can render an inline banner instead of
/// an OS alert box (Guardrail 7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub field: Option<String>,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into(), field: None }
    }

    pub fn with_field(code: &str, message: impl Into<String>, field: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into(), field: Some(field.into()) }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new("VALIDATION", message)
    }

    pub fn validation_field(message: impl Into<String>, field: impl Into<String>) -> Self {
        Self::with_field("VALIDATION", message, field)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", message)
    }

    pub fn duplicate(message: impl Into<String>) -> Self {
        Self::new("DUPLICATE", message)
    }

    pub fn db(message: impl Into<String>) -> Self {
        Self::new("DB", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.field {
            Some(field) => write!(f, "{} [{}]: {} (field: {})", self.code, "error", self.message, field),
            None => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for AppError {}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AppError", if self.field.is_some() { 3 } else { 2 })?;
        state.serialize_field("code", &self.code)?;
        state.serialize_field("message", &self.message)?;
        if let Some(field) = &self.field {
            state.serialize_field("field", field)?;
        }
        state.end()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        match &err {
            rusqlite::Error::SqliteFailure(e, msg) => {
                let text = msg.clone().unwrap_or_else(|| e.to_string());
                if text.contains("UNIQUE constraint failed") {
                    AppError::duplicate(text)
                } else if text.contains("FOREIGN KEY constraint failed") {
                    AppError::validation("This record references a record that does not exist.")
                } else {
                    AppError::db(text)
                }
            }
            _ => AppError::db(err.to_string()),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::internal(format!("JSON error: {err}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::new("IO", err.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        AppError::new("NETWORK", err.to_string())
    }
}

impl From<csv::Error> for AppError {
    fn from(err: csv::Error) -> Self {
        AppError::validation(format!("CSV parse error: {err}"))
    }
}

impl From<uuid::Error> for AppError {
    fn from(err: uuid::Error) -> Self {
        AppError::internal(format!("UUID error: {err}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
