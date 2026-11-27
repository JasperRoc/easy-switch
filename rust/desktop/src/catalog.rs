use crate::{
    gateway::Gateway,
    store::{codex_auth, Provider, State},
};
use anyhow::{anyhow, Context, Result};
use indexmap::IndexMap;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, OnceCell};

#[derive(Clone, Default)]
pub struct Catalog(
    Arc<Mutex<HashMap<String, Entry>>>,
    Arc<Mutex<()>>,
    Arc<Mutex<Option<(String, Instant, Vec<Value>)>>>,
);

#[derive(Clone)]
struct Entry {
    expires: Instant,
    response: Arc<OnceCell<(Vec<Value>, bool)>>,
}

const MAX_SAVED_AGE: u64 = 24 * 60 * 60 * 1000;
const MAX_ENTRIES: usize = 256;

fn key(alias: &str, provider: &Provider, version: Option<&str>, claude: bool) -> String {
    let mut hash = Sha256::new();
    match provider {
        Provider::Api {
            api_key,
            base_url,
            models,
            ..
        } => {
            hash.update(api_key);
            hash.update([0]);
            hash.update(base_url);
            if let Some(models) = models {
                hash.update([1]);
                for item in models {
                    hash.update(&item.id);
                    hash.update([0]);
                    hash.update(&item.label);
                    hash.update([0]);
                }
            }
        }
        Provider::Account { home, models, .. } => {
            hash.update(home.to_string_lossy().as_bytes());
            hash.update([0]);
            if !claude {
                hash.update(version.unwrap_or_default());
            }
            hash.update([0]);
            if let Ok(data) =
                std::fs::read(home.join(if claude { "oauth.json" } else { "auth.json" }))
            {
                hash.update(data);
            }
            if let Some(models) = models {
                hash.update([1]);
                for item in models {
                    hash.update(&item.id);
                    hash.update([0]);
                    hash.update(&item.label);
                    hash.update([0]);
                }
            }
        }
    }
    format!(
        "{}:{alias}:{:x}",
        if claude { 'a' } else { 'o' },
        hash.finalize()
    )
}

impl Catalog {
    async fn metadata(&self, gateway: &Gateway, version: Option<&str>) -> Vec<Value> {
        let mut cache = self.2.lock().await;
        let version = version.unwrap_or_default();
        if let Some((key, until, models)) = &*cache {
            if key == version && *until > Instant::now() {
                return models.clone();
            }
        }
        let models = gateway
            .worker
            .call("codex-metadata", Value::Null, Value::Null)
            .await
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        let ttl = if models.is_empty() { 60 } else { 300 };
        *cache = Some((
            version.to_owned(),
            Instant::now() + Duration::from_secs(ttl),
            models.clone(),
        ));
        models
    }

    pub async fn provider(
        &self,
        gateway: &Gateway,
        alias: &str,
        provider: &Provider,
        version: Option<&str>,
        claude: bool,
    ) -> (Vec<Value>, bool) {
        let key = key(alias, provider, version, claude);
        let response = {
            let mut cache = self.0.lock().await;
            let now = Instant::now();
            cache.retain(|_, entry| entry.expires > now);
            if cache.len() >= MAX_ENTRIES && !cache.contains_key(&key) {
                if let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, entry)| entry.expires)
                    .map(|(key, _)| key.clone())
                {
                    cache.remove(&oldest);
                }
            }
            cache
                .entry(key.clone())
                .or_insert_with(|| Entry {
                    expires: now + Duration::from_secs(60),
                    response: Arc::default(),
                })
                .response
                .clone()
        };
        response
            .get_or_init(|| async {
                let found = gateway.discover(provider, version, claude).await;
                let known = found.is_ok() || provider.models().is_some();
                if let Ok(models) = &found {
                    if !claude {
                        self.remember(gateway, &key, models).await;
                    }
                }
                let mut live = match found {
                    Ok(models) => models,
                    Err(_) if !claude => self.last_observed(gateway, &key).await,
                    Err(_) => Vec::new(),
                };
                if let Some(models) = provider.models() {
                    live = models
                        .iter()
                        .map(|entry| {
                            let id_key = if claude { "id" } else { "slug" };
                            let mut item = live
                                .iter()
                                .find(|item| item[id_key] == entry.id)
                                .cloned()
                                .unwrap_or_else(|| json!({}));
                            item[id_key] = json!(entry.id);
                            item["display_name"] = json!(entry.label);
                            item
                        })
                        .collect();
                }
                if let Provider::Api { mappings, .. } = provider {
                    if claude {
                        for role in ["fable", "opus", "sonnet", "haiku", "default", "subagent"] {
                            let Some(id) =
                                mappings.get(role).map(|id| super::gateway::model_name(id))
                            else {
                                continue;
                            };
                            if !live.iter().any(|model| model["id"] == id) {
                                live.push(json!({"id":id, "display_name":id}));
                            }
                        }
                        if let Some(model) = mappings
                            .get("default")
                            .map(|id| super::gateway::model_name(id))
                        {
                            live.sort_by_key(|entry| entry["id"] != model);
                        }
                    }
                }
                (live, known)
            })
            .await
            .clone()
    }
    async fn last_observed(&self, gateway: &Gateway, key: &str) -> Vec<Value> {
        let _lock = self.1.lock().await;
        let Ok(value) =
            crate::store::read::<Value>(&gateway.root.join("native-model-catalog.json"))
        else {
            return Vec::new();
        };
        let now = crate::store::epoch_ms();
        let item = &value[key];
        if item["at"]
            .as_u64()
            .is_some_and(|at| now.saturating_sub(at) < MAX_SAVED_AGE)
        {
            return item["models"].as_array().cloned().unwrap_or_default();
        }
        Vec::new()
    }
    async fn remember(&self, gateway: &Gateway, key: &str, models: &[Value]) {
        let _lock = self.1.lock().await;
        let file = gateway.root.join("native-model-catalog.json");
        let mut data =
            crate::store::read::<serde_json::Map<String, Value>>(&file).unwrap_or_default();
        let now = crate::store::epoch_ms();
        data.retain(|_, entry| {
            entry["at"]
                .as_u64()
                .is_some_and(|at| now.saturating_sub(at) < MAX_SAVED_AGE)
        });
        if data.len() >= MAX_ENTRIES {
            if let Some(oldest) = data
                .iter()
                .min_by_key(|(_, entry)| entry["at"].as_u64())
                .map(|(key, _)| key.clone())
            {
                data.shift_remove(&oldest);
            }
        }
        data.insert(key.to_owned(), json!({"at":now,"models":models}));
        let _ = crate::store::atomic(&file, &Value::Object(data));
    }
    pub async fn supports(
        &self,
        alias: &str,
        provider: &Provider,
        model: &str,
        version: Option<&str>,
    ) -> bool {
        if let Some(models) = provider.models() {
            return models.iter().any(|entry| entry.id == model);
        }
        if provider.is_account() && version.is_none() {
            return true;
        }
        self.0
            .lock()
            .await
            .get(&key(alias, provider, version, false))
            .filter(|entry| entry.expires > Instant::now())
            .and_then(|entry| entry.response.get())
            .is_none_or(|(models, known)| !known || models.iter().any(|item| item["slug"] == model))
    }
}

impl Gateway {
    pub async fn discover(
        &self,
        provider: &Provider,
        version: Option<&str>,
        claude: bool,
    ) -> Result<Vec<Value>> {
        if claude {
            let (base, headers) = self.claude_headers(provider, None).await?;
            let client = self.client();
            let candidates = if provider.is_account() {
                vec![format!("{base}/v1/models")]
            } else {
                vec![
                    format!("{base}/v1/models"),
                    format!("{base}/models"),
                    format!("{}/models", base.trim_end_matches("/anthropic")),
                ]
            };
            let mut items = IndexMap::<String, Value>::new();
            for url in candidates {
                let mut cursor = None::<String>;
                let mut seen = std::collections::HashSet::new();
                loop {
                    let mut request = client
                        .get(&url)
                        .headers(headers.clone())
                        .timeout(Duration::from_secs(8));
                    if let Some(cursor) = &cursor {
                        request = request.query(&[("after_id", cursor)]);
                    }
                    let response = request.send().await?;
                    if cursor.is_none() && matches!(response.status().as_u16(), 404 | 405) {
                        break;
                    }
                    let value: Value = response.error_for_status()?.json().await?;
                    for model in value["data"].as_array().context("Invalid Claude catalog")? {
                        if let Some(id) = model["id"].as_str() {
                            items.entry(id.to_owned()).or_insert_with(|| model.clone());
                        }
                    }
                    if value["has_more"] != true {
                        return Ok(items.into_values().collect());
                    }
                    cursor = value["last_id"].as_str().map(str::to_owned);
                    if cursor.as_ref().is_none_or(|id| !seen.insert(id.clone())) || seen.len() >= 20
                    {
                        return Err(anyhow!("Invalid Claude catalog pagination."));
                    }
                }
            }
            return Err(anyhow!("Unable to read Claude catalog."));
        }
        let (request, field) = match provider {
            Provider::Api {
                api_key, base_url, ..
            } => (
                self.client()
                    .get(format!("{base_url}/models"))
                    .bearer_auth(api_key),
                "data",
            ),
            Provider::Account { home, .. } => {
                let version = version.context("Codex client version is unknown.")?;
                let auth = codex_auth(home)?;
                (
                    self.client()
                        .get(self.codex_endpoint("models"))
                        .query(&[("client_version", version)])
                        .bearer_auth(auth.tokens.access_token)
                        .header("chatgpt-account-id", auth.tokens.account_id)
                        .header("originator", "codex_cli_rs"),
                    "models",
                )
            }
        };
        let value: Value = request
            .timeout(Duration::from_secs(8))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let models = value[field].as_array().context("Invalid Codex catalog")?;
        Ok(models
            .iter()
            .filter_map(|model| {
                let id = model[if field == "data" { "id" } else { "slug" }].as_str()?;
                if id.is_empty()
                    || matches!(model["visibility"].as_str(), Some("hide" | "none"))
                    || image_only(id)
                    || model["output_modalities"]
                        .as_array()
                        .is_some_and(|items| !items.contains(&json!("text")))
                {
                    return None;
                }
                let mut item = model.clone();
                item["slug"] = json!(id);
                item["display_name"] = json!(model["display_name"].as_str().unwrap_or(id));
                Some(item)
            })
            .collect())
    }
}

fn image_only(id: &str) -> bool {
    let name = id
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(id)
        .to_ascii_lowercase();
    ["gpt-image", "chatgpt-image", "dall-e"]
        .iter()
        .any(|prefix| {
            name.strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(['-', '.']))
        })
}

fn digits(id: &str) -> Vec<u64> {
    id.strip_prefix("gpt-")
        .and_then(|id| id.split('-').next())
        .and_then(|part| {
            part.split('.')
                .map(str::parse::<u64>)
                .collect::<Result<Vec<_>, _>>()
                .ok()
        })
        .unwrap_or_default()
}

// /models from an API relay is not necessarily a complete Codex ModelInfo.
// Normalize before merging so null or partial fields cannot poison the union.
fn codex_metadata(value: &Value) -> Value {
    let mut fields = value.as_object().cloned().unwrap_or_default();
    fields.retain(|key, value| {
        !value.is_null()
            || matches!(
                key.as_str(),
                "default_reasoning_level" | "auto_compact_token_limit"
            )
    });
    for key in [
        "display_name",
        "description",
        "base_instructions",
        "default_reasoning_level",
    ] {
        if fields
            .get(key)
            .is_some_and(|value| !value.is_null() && !value.is_string())
        {
            fields.remove(key);
        }
    }
    for key in [
        "context_window",
        "max_context_window",
        "auto_compact_token_limit",
        "effective_context_window_percent",
        "priority",
    ] {
        if fields
            .get(key)
            .is_some_and(|value| !value.is_null() && value.as_i64().is_none())
        {
            fields.remove(key);
        }
    }
    for key in [
        "support_verbosity",
        "supports_parallel_tool_calls",
        "supports_reasoning_summaries",
        "supports_reasoning_summary_parameter",
        "supports_image_detail_original",
        "include_skills_usage_instructions",
        "include_plugin_usage_instructions",
        "include_apps_usage_instructions",
        "supports_search_tool",
        "supports_experimental_context",
        "use_responses_lite",
        "supports_reasoning_effort_updates",
        "node_repl_auto_review_required",
        "node_repl_disabled",
    ] {
        if fields.get(key).is_some_and(|value| !value.is_boolean()) {
            fields.remove(key);
        }
    }
    for (key, allowed) in [
        (
            "shell_type",
            &[
                "shell_command",
                "unified_exec",
                "default",
                "local",
                "disabled",
            ][..],
        ),
        ("visibility", &["list", "hide", "none"][..]),
        (
            "default_reasoning_summary",
            &["auto", "concise", "detailed", "none"][..],
        ),
        ("default_verbosity", &["low", "medium", "high"][..]),
        ("apply_patch_tool_type", &["freeform"][..]),
        ("web_search_tool_type", &["text", "text_and_image"][..]),
    ] {
        if fields
            .get(key)
            .is_some_and(|value| value.as_str().is_none_or(|text| !allowed.contains(&text)))
        {
            fields.remove(key);
        }
    }
    for key in [
        "experimental_supported_tools",
        "additional_speed_tiers",
        "input_modalities",
    ] {
        if let Some(items) = fields.get_mut(key).and_then(Value::as_array_mut) {
            items.retain(|item| {
                item.as_str().is_some_and(|text| {
                    key != "input_modalities" || ["text", "image", "audio"].contains(&text)
                })
            });
        } else {
            fields.remove(key);
        }
    }
    if fields.get("truncation_policy").is_some_and(|policy| {
        !matches!(policy["mode"].as_str(), Some("tokens" | "bytes"))
            || policy["limit"].as_u64().is_none()
    }) {
        fields.remove("truncation_policy");
    }
    fields.remove("supported_reasoning_levels");
    if let Some(levels) = value["supported_reasoning_levels"].as_array() {
        let mut seen = std::collections::HashSet::new();
        let normalized: Vec<_> = levels
            .iter()
            .filter_map(|item| {
                let effort = item.as_str().or_else(|| item["effort"].as_str())?;
                if effort.trim().is_empty() || !seen.insert(effort) {
                    return None;
                }
                Some(json!({"effort": effort, "description": item.get("description").and_then(Value::as_str).unwrap_or(effort)}))
            })
            .collect();
        if !normalized.is_empty() || levels.is_empty() {
            fields.insert("supported_reasoning_levels".into(), json!(normalized));
        }
    }
    Value::Object(fields)
}

static METADATA: OnceLock<HashMap<String, Value>> = OnceLock::new();

pub async fn codex_union(gateway: &Gateway, state: &State, version: Option<&str>) -> Value {
    let mut metadata = METADATA
        .get_or_init(|| {
            let source: Value =
                serde_json::from_str(include_str!("../../../src/codex-model-metadata.json"))
                    .unwrap();
            source["models"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|entry| Some((entry["slug"].as_str()?.to_owned(), entry.clone())))
                .collect()
        })
        .clone();
    let fetched = futures_util::future::join_all(state.ordered().into_iter().filter_map(|alias| {
        state.providers.get(alias).map(|provider| async move {
            (
                alias,
                provider,
                provider.is_account(),
                gateway
                    .catalog
                    .provider(gateway, alias, provider, version, false)
                    .await
                    .0,
            )
        })
    }))
    .await;
    if fetched.iter().any(|(_, _, _, models)| {
        models.iter().any(|model| {
            codex_metadata(model)
                .get("supported_reasoning_levels")
                .is_none()
        })
    }) {
        for model in gateway.catalog.metadata(gateway, version).await {
            let Some(id) = model["slug"].as_str() else {
                continue;
            };
            let entry = metadata.entry(id.to_owned()).or_insert_with(|| json!({}));
            if let Some(fields) = model.as_object() {
                entry.as_object_mut().unwrap().extend(fields.clone());
            }
        }
    }
    let mut models = IndexMap::<String, (Value, bool)>::new();
    let mut context_sources = HashMap::new();
    for (alias, provider, account, entries) in fetched {
        for item in entries {
            let Some(id) = item["slug"].as_str() else {
                continue;
            };
            if image_only(id) {
                continue;
            }
            let mut model = json!({"base_instructions": "Help the user with their coding tasks.", "supported_reasoning_levels": [],
                "shell_type": "shell_command", "support_verbosity": false, "truncation_policy": {"mode": "tokens", "limit": 10000},
                "experimental_supported_tools": [], "visibility": "list", "supported_in_api": true, "upgrade": null});
            if let Some(reference) = metadata.get(id) {
                model
                    .as_object_mut()
                    .unwrap()
                    .extend(codex_metadata(reference).as_object().unwrap().clone());
            }
            model
                .as_object_mut()
                .unwrap()
                .extend(codex_metadata(&item).as_object().unwrap().clone());
            if let Some(levels) = model["supported_reasoning_levels"].as_array() {
                if !levels
                    .iter()
                    .any(|level| level["effort"] == model["default_reasoning_level"])
                {
                    model["default_reasoning_level"] = levels
                        .first()
                        .map(|level| level["effort"].clone())
                        .unwrap_or(Value::Null);
                }
            }
            if matches!(model["visibility"].as_str(), Some("hide" | "none")) {
                continue;
            }
            model["supported_in_api"] = json!(true);
            model["upgrade"] = Value::Null;
            let active = state.active.as_deref() == Some(alias);
            if active || !context_sources.contains_key(id) {
                context_sources.insert(id.to_owned(), provider.context(id));
            }
            if let Some((present, existing_account)) = models.get_mut(id) {
                if account && !*existing_account {
                    if present["display_name"] != id {
                        model["display_name"] = present["display_name"].clone();
                    }
                    *present = model;
                    *existing_account = true;
                }
            } else {
                models.insert(id.to_owned(), (model, account));
            }
        }
    }
    let mut models: Vec<_> = models.into_iter().collect();
    models.sort_by(|(left, (a, _)), (right, (b, _))| {
        let priority = |id: &str, model: &Value| {
            metadata
                .get(id)
                .and_then(|m| m["priority"].as_u64())
                .or(model["priority"].as_u64())
                .unwrap_or(u64::MAX)
        };
        digits(right)
            .cmp(&digits(left))
            .then_with(|| priority(left, a).cmp(&priority(right, b)))
            .then(left.cmp(right))
    });
    json!({"models": models.into_iter().enumerate().map(|(priority, (id, (mut model, _)))| {
        if let Some(Some(context)) = context_sources.get(&id) {
            if let Some(window) = context.window {
                let limit = model["max_context_window"].as_u64().unwrap_or(window);
                model["context_window"] = json!(window.min(limit));
            }
            if let Some(compact) = context.compact {
                model["auto_compact_token_limit"] = json!(compact);
            }
        }
        model["priority"] = json!(priority); model
    }).collect::<Vec<_>>()})
}

pub fn route_id(id: &str) -> String {
    if [
        "claude-fable-",
        "claude-opus-",
        "claude-sonnet-",
        "claude-haiku-",
    ]
    .iter()
    .any(|prefix| id.starts_with(prefix))
    {
        id.to_owned()
    } else {
        format!(
            "claude-fluid-es-{}",
            &format!("{:x}", Sha256::digest(id.as_bytes()))[..16]
        )
    }
}

pub fn matches_route(id: &str, route: &str) -> bool {
    let current = route_id(id);
    current == route
        || current
            .strip_prefix("claude-fluid-")
            .is_some_and(|suffix| route.strip_prefix("claude-sonnet-5-") == Some(suffix))
}
