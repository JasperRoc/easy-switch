use anyhow::{bail, Context, Result};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ModelContext {
    pub window: Option<u64>,
    pub compact: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Provider {
    Api {
        #[serde(default)]
        enabled: Option<bool>,
        #[serde(rename = "apiKey")]
        api_key: String,
        #[serde(rename = "baseUrl")]
        base_url: String,
        #[serde(rename = "claudeModels", default)]
        mappings: HashMap<String, String>,
        #[serde(rename = "modelCatalog", default)]
        models: Option<Vec<ModelEntry>>,
        #[serde(rename = "modelContexts", default)]
        contexts: HashMap<String, ModelContext>,
    },
    Account {
        #[serde(default)]
        enabled: Option<bool>,
        #[serde(rename = "accountHome")]
        home: PathBuf,
        #[serde(rename = "modelCatalog", default)]
        models: Option<Vec<ModelEntry>>,
        #[serde(rename = "modelContexts", default)]
        contexts: HashMap<String, ModelContext>,
    },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub token: String,
    pub active: Option<String>,
    pub order: Option<Vec<String>>,
    pub providers: IndexMap<String, Provider>,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub manual_generation: u64,
}
impl State {
    pub fn load(root: &Path) -> Result<Self> {
        read(&root.join("state.json"))
    }
    pub fn ordered(&self) -> Vec<&str> {
        if let Some(order) = &self.order {
            return order
                .iter()
                .map(String::as_str)
                .filter(|alias| self.providers.get(*alias).is_some_and(Provider::enabled))
                .collect();
        }
        self.providers
            .iter()
            .filter(|(_, provider)| provider.enabled())
            .map(|(alias, _)| alias.as_str())
            .collect()
    }
}

impl Provider {
    pub fn enabled(&self) -> bool {
        match self {
            Self::Api { enabled, .. } | Self::Account { enabled, .. } => *enabled != Some(false),
        }
    }
    pub fn models(&self) -> Option<&[ModelEntry]> {
        match self {
            Self::Api { models, .. } | Self::Account { models, .. } => models.as_deref(),
        }
    }
    pub fn has_contexts(&self) -> bool {
        match self {
            Self::Api { contexts, .. } | Self::Account { contexts, .. } => !contexts.is_empty(),
        }
    }
    pub fn context(&self, model: &str) -> Option<&ModelContext> {
        match self {
            Self::Api { contexts, .. } | Self::Account { contexts, .. } => contexts.get(model),
        }
    }
    pub fn is_account(&self) -> bool {
        matches!(self, Self::Account { .. })
    }
    pub fn usable(&self, claude: bool) -> bool {
        if !self.enabled() {
            return false;
        }
        match self {
            Self::Api {
                api_key, base_url, ..
            } => !api_key.is_empty() && !base_url.is_empty(),
            Self::Account { home, .. } if claude => claude_auth(home).is_ok(),
            Self::Account { home, .. } => codex_auth(home).is_ok(),
        }
    }
}

#[derive(Clone, Deserialize)]
pub struct CodexAuth {
    pub tokens: CodexTokens,
}
#[derive(Clone, Deserialize)]
pub struct CodexTokens {
    pub access_token: String,
    pub account_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuth {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
    #[serde(flatten)]
    pub fields: serde_json::Map<String, Value>,
}

pub fn codex_auth(home: &Path) -> Result<CodexAuth> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let auth: CodexAuth =
        read(&home.join("auth.json")).context("Codex subscription needs sign-in.")?;
    let expires = auth
        .tokens
        .access_token
        .split('.')
        .nth(1)
        .and_then(|part| URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|claims| claims["exp"].as_u64());
    if auth.tokens.account_id.is_empty()
        || auth.tokens.access_token.is_empty()
        || expires.is_some_and(|exp| exp <= epoch_ms() / 1000)
    {
        bail!("Codex subscription needs sign-in.");
    }
    Ok(auth)
}
pub fn claude_auth(home: &Path) -> Result<ClaudeAuth> {
    let auth: ClaudeAuth =
        read(&home.join("oauth.json")).context("Claude subscription needs sign-in.")?;
    if auth.access_token.is_empty() {
        bail!("Claude subscription needs sign-in.");
    }
    Ok(auth)
}
pub fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn read<T: serde::de::DeserializeOwned>(file: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&fs::read(file)?)?)
}
pub fn atomic(file: &Path, value: &Value) -> Result<()> {
    let tmp = file.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let write = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut stream = options.open(&tmp)?;
        serde_json::to_writer_pretty(&mut stream, value)?;
        stream.write_all(b"\n")?;
        drop(stream);
        fs::rename(&tmp, file)?;
        Ok(())
    })();
    if write.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write
}

struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn locked(root: &Path, change: impl FnOnce(&mut Value) -> Result<bool>) -> Result<bool> {
    let lock = root.join("write.lock");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .context("Provider configuration is busy.")?;
    let _lock = Lock(lock);
    let file = root.join("state.json");
    let mut state = read(&file)?;
    let changed = change(&mut state)?;
    if changed {
        atomic(&file, &state)?;
    }
    Ok(changed)
}
#[cfg(feature = "desktop")]
pub fn select(root: &Path, alias: &str) -> Result<()> {
    locked(root, |state| {
        if state["providers"].get(alias).is_none() || state["providers"][alias]["enabled"] == false
        {
            bail!("Unknown provider.");
        }
        state["active"] = json!(alias);
        state["generation"] = json!(state["generation"]
            .as_u64()
            .unwrap_or_default()
            .saturating_add(1));
        state["manualGeneration"] = json!(state["manualGeneration"]
            .as_u64()
            .unwrap_or_default()
            .saturating_add(1));
        state["reason"] = json!("manual");
        Ok(true)
    })?;
    Ok(())
}
pub fn fallback(root: &Path, generation: u64, from: &str, to: &str, status: u16) -> Result<bool> {
    locked(root, |state| {
        if state["generation"].as_u64().unwrap_or_default() != generation
            || state["active"].as_str() != Some(from)
            || state["providers"].get(to).is_none()
            || state["providers"][to]["enabled"] == false
        {
            return Ok(false);
        }
        state["active"] = json!(to);
        state["generation"] = json!(generation.saturating_add(1));
        state["reason"] = json!("failover");
        state["lastFailover"] = json!({"from": from, "to": to, "status": status, "at": chrono::Utc::now().to_rfc3339()});
        Ok(true)
    })
}
