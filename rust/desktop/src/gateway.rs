use crate::{
    catalog::{self, Catalog},
    store::{self, Provider, State},
    stream,
    worker::{Worker, WorkerPaths},
};
use anyhow::{bail, Context, Result};
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::Request,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::Response,
};
use futures_util::StreamExt;
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock, RwLock,
    },
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

macro_rules! matches_regex {
    ($pattern:literal, $text:expr) => {{
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| Regex::new($pattern).expect("static rejection pattern"))
            .is_match($text)
    }};
}

fn error_object(value: &Value) -> &Value {
    value["response"]
        .get("error")
        .or_else(|| value.get("error"))
        .unwrap_or(value)
}
fn message(text: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        let error = error_object(&value);
        if let Some(message) = error.as_str() {
            return message.into();
        }
        return [
            &error["code"],
            &error["type"],
            &error["message"],
            &value["detail"],
        ]
        .into_iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    }
    text.to_owned()
}
fn recoverable(status: u16, text: &str) -> bool {
    matches!(status, 401 | 402 | 403 | 429)
        && !matches_regex!(
            r"(?i)content[_ -]?(?:policy|filter)|safety|moderation|refusal|refused|unsupported_country|(?:country|region|territory).*(?:not supported|not allowed)|(?:organization|workspace|admin|security) policy|内容安全|内容政策|地区.{0,20}不支持",
            &message(text)
        )
}
fn model_denied(status: u16, text: &str) -> bool {
    if !matches!(status, 400 | 403 | 404 | 422) {
        return false;
    }
    let text = message(text);
    !matches_regex!(
        r"(?i)policy|safety|moderation|content_filter|refusal",
        &text
    ) && matches_regex!(
        r"(?i)\b(?:model_not_found|model_not_supported|unsupported_model|model_access_denied|model_permission_denied|model_not_available)\b|\bmodel\b.{0,160}\b(?:does not exist|not found|not (?:supported|available|accessible|enabled|allowed|permitted)|access denied|permission denied)\b|\b(?:do not|don't|does not|doesn't) have access to (?:the )?(?:requested )?model\b|\bnot (?:allowed|authorized|permitted) to (?:access|use) (?:the )?(?:requested )?model\b|模型.{0,100}(?:不(?:支持|存在|可用)|无(?:权限|访问权限))|(?:无权|无权限|没有权限|不支持).{0,50}模型",
        &text
    )
}
fn context_denied(status: u16, text: &str) -> bool {
    matches!(status, 400 | 404 | 422)
        && matches_regex!(
            r"(?i)invalid_encrypted_content|encrypted.*(?:invalid|decrypt|different|mismatch)|(?:invalid|decrypt|mismatch).*encrypted|compaction.*(?:invalid|unsupported|not supported)|(?:item|reference).*(?:not found|does not exist)",
            text
        )
}
pub fn capacity(text: &str) -> bool {
    matches_regex!(
        r"(?i)\b(?:overloaded_error|server_overloaded|model_overloaded|model_at_capacity)\b|\b(?:selected |requested )?model is at capacity\b|\b(?:server|model) (?:is )?(?:currently )?overloaded\b|\bflex capacity unavailable\b",
        &message(text)
    )
}
fn image_denied(status: u16, text: &str) -> bool {
    matches!(status, 400 | 403 | 404 | 405 | 501)
        && !matches_regex!(
            r"(?i)policy|safety|moderation|content_filter|refusal",
            &message(text)
        )
        && (matches!(status, 404 | 405 | 501)
            || matches_regex!(
                r"(?i)\b(?:image_generation_not_supported|image_generation_unavailable|unsupported_plan|plan_not_supported|feature_not_available|model_not_found)\b|\b(?:image generation|imagegen|gpt-image[\w.-]*)\b.*\b(?:not (?:available|supported|enabled|allowed)|requires? (?:a )?(?:paid|plus|pro)|upgrade|free plan)\b|\b(?:free plan|your plan|subscription)\b.*\b(?:does not support|not support|not (?:available|eligible|entitled))\b",
                &message(text)
            ))
}
fn account_image_fallback(status: u16, text: &str) -> bool {
    recoverable(403, text)
        && (image_denied(status, text) || status == 403)
        && !matches!(rejection(text), 401 | 402 | 429)
        && !matches_regex!(
            r"(?i)\b(?:image_generation_limit|rate_limit|usage_limit|insufficient_quota|quota|credits?)(?:\b|_)",
            text
        )
}
fn rejection(text: &str) -> u16 {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        let error = error_object(&value);
        let status = [&error["status"], &error["status_code"]]
            .into_iter()
            .find_map(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
            .unwrap_or_default() as u16;
        if matches!(status, 401 | 402 | 403 | 429 | 500 | 502 | 503 | 504 | 529) {
            return status;
        }
        for code in [&error["code"], &error["type"]]
            .into_iter()
            .filter_map(Value::as_str)
        {
            match code.to_ascii_lowercase().as_str() {
                "authentication_error" | "invalid_api_key" => return 401,
                "permission_error" | "forbidden" | "access_denied" => return 403,
                "rate_limit_error"
                | "rate_limit_exceeded"
                | "rate_limit_reached"
                | "usage_limit_reached"
                | "insufficient_quota" => return 429,
                "insufficient_credits"
                | "insufficient_balance"
                | "credits_exhausted"
                | "billing_hard_limit_reached" => return 402,
                "server_error" | "internal_server_error" => return 500,
                "service_unavailable" => return 503,
                _ => {}
            }
        }
    }
    if matches_regex!(
        r"(?i)\b(?:usage|rate)[ _-]?limit (?:reached|exceeded)|\b(?:hit|reached|exceeded) (?:your |the )?(?:usage |rate )?limit\b|\b(?:quota|credits?|balance) (?:exhausted|depleted|exceeded)|\binsufficient (?:quota|credits?|balance)\b|额度.{0,20}(?:耗尽|用尽|用完|不足)|余额不足",
        &message(text)
    ) {
        429
    } else {
        0
    }
}

#[derive(Default)]
struct Cooling {
    manual: u64,
    until: HashMap<(String, String), Instant>,
}
impl Cooling {
    fn update(&mut self, generation: u64) {
        if self.manual != generation {
            self.until.clear();
            self.manual = generation;
        }
        self.until.retain(|_, until| *until > Instant::now());
    }
    fn blocked(&self, alias: &str, model: &str) -> bool {
        self.until.contains_key(&(alias.into(), String::new()))
            || self.until.contains_key(&(alias.into(), model.into()))
    }
    fn block(&mut self, alias: &str, model: &str) {
        if self.until.len() >= 256 {
            if let Some(old) = self
                .until
                .iter()
                .min_by_key(|(_, expiry)| **expiry)
                .map(|(key, _)| key.clone())
            {
                self.until.remove(&old);
            }
        }
        self.until.insert(
            (alias.into(), model.into()),
            Instant::now() + Duration::from_secs(60),
        );
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Desktop,
    Service,
}

pub struct Gateway {
    pub root: PathBuf,
    usage: crate::usage::Ledger,
    client: RwLock<reqwest::Client>,
    mode: Mode,
    pub catalog: Catalog,
    pub worker: Worker,
    pub paths: WorkerPaths,
    pub version: RwLock<Option<String>>,
    installed_version: tokio::sync::Mutex<Option<(Instant, Option<String>)>>,
    pub active: AtomicUsize,
    active_claude: AtomicUsize,
    pub enabled: AtomicBool,
    pub stop: CancellationToken,
    codex_requests: Mutex<CancellationToken>,
    claude_requests: Mutex<CancellationToken>,
    codex_cooling: Mutex<Cooling>,
    claude_cooling: Mutex<Cooling>,
    image_cooling: Mutex<Cooling>,
    claude_refresh: tokio::sync::Mutex<()>,
    reauth: Option<Box<dyn Fn(&str, &str) + Send + Sync>>,
}

impl Gateway {
    pub fn new(
        root: PathBuf,
        worker: Worker,
        paths: WorkerPaths,
        mode: Mode,
        reauth: Option<Box<dyn Fn(&str, &str) + Send + Sync>>,
    ) -> Result<Self> {
        let settings = store::read::<Value>(&root.join("network.json")).unwrap_or_default();
        Ok(Self {
            usage: crate::usage::Ledger::new(root.clone()),
            root,
            client: RwLock::new(Self::http_client(&settings)?),
            mode,
            catalog: Catalog::default(),
            worker,
            paths,
            version: RwLock::new(None),
            installed_version: tokio::sync::Mutex::new(None),
            active: AtomicUsize::new(0),
            active_claude: AtomicUsize::new(0),
            enabled: AtomicBool::new(false),
            stop: CancellationToken::new(),
            codex_requests: Mutex::new(CancellationToken::new()),
            claude_requests: Mutex::new(CancellationToken::new()),
            codex_cooling: Mutex::default(),
            claude_cooling: Mutex::default(),
            image_cooling: Mutex::default(),
            claude_refresh: tokio::sync::Mutex::new(()),
            reauth,
        })
    }
    pub(crate) fn client(&self) -> reqwest::Client {
        self.client.read().unwrap().clone()
    }
    #[cfg(feature = "desktop")]
    pub fn set_network(&self, settings: &Value) -> Result<()> {
        *self.client.write().unwrap() = Self::http_client(settings)?;
        Ok(())
    }
    fn http_client(settings: &Value) -> Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("fluid/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(3);
        if settings.is_object() {
            builder = builder.no_proxy();
            let bypass = reqwest::NoProxy::from_string(&format!(
                "{},localhost,127.0.0.1,::1",
                settings["noProxy"].as_str().unwrap_or_default()
            ));
            for (key, scheme) in [("httpProxy", "http"), ("httpsProxy", "https")] {
                if let Some(url) = settings[key].as_str().filter(|value| !value.is_empty()) {
                    let proxy = if scheme == "http" {
                        reqwest::Proxy::http(url)?
                    } else {
                        reqwest::Proxy::https(url)?
                    };
                    builder = builder.proxy(proxy.no_proxy(bypass.clone()));
                }
            }
        }
        Ok(builder.build()?)
    }
    pub async fn listen(self: Arc<Self>, listener: TcpListener) -> Result<()> {
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let cancel = self.stop.clone();
        axum::serve(
            listener,
            axum::Router::new().fallback(move |req| serve(self.clone(), req)),
        )
        .with_graceful_shutdown(async move { cancel.cancelled().await })
        .await?;
        Ok(())
    }
    pub fn context(&self) -> Value {
        let total = self.active.load(Ordering::Relaxed);
        let claude = self.active_claude.load(Ordering::Relaxed);
        json!({"version": self.version.read().unwrap().as_deref(), "activeRequests": total,
            "claudeRequests": claude, "codexRequests": total.saturating_sub(claude)})
    }
    pub fn cancel_routes(&self, claude: bool) {
        let mutex = if claude {
            &self.claude_requests
        } else {
            &self.codex_requests
        };
        let mut token = mutex.lock().unwrap();
        token.cancel();
        *token = CancellationToken::new();
    }
    pub(crate) fn codex_endpoint(&self, route: &str) -> String {
        format!("https://chatgpt.com/backend-api/codex/{route}")
    }

    async fn installed_version(&self) -> Option<String> {
        let mut cache = self.installed_version.lock().await;
        if let Some((until, version)) = &*cache {
            if *until > Instant::now() {
                return version.clone();
            }
        }
        let version = self
            .worker
            .call("installed-version", Value::Null, Value::Null)
            .await
            .ok()
            .and_then(|value| value.as_str().map(ToOwned::to_owned));
        *cache = Some((Instant::now() + Duration::from_secs(60), version.clone()));
        version
    }

    pub(crate) async fn claude_headers(
        &self,
        provider: &Provider,
        incoming: Option<&HeaderMap>,
    ) -> Result<(String, HeaderMap)> {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        if let Some(incoming) = incoming {
            for (key, value) in incoming {
                let name = key.as_str();
                if ["user-agent", "x-app", "accept"].contains(&name)
                    || ["anthropic-", "x-stainless-", "x-claude-code-"]
                        .iter()
                        .any(|prefix| name.starts_with(prefix))
                {
                    headers.insert(key.clone(), value.clone());
                }
            }
        }
        let base = match provider {
            Provider::Api {
                api_key, base_url, ..
            } => {
                headers.insert("x-api-key", HeaderValue::from_str(api_key)?);
                headers.insert(
                    header::AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {api_key}"))?,
                );
                base_url
                    .trim_end_matches('/')
                    .trim_end_matches("/v1")
                    .to_owned()
            }
            Provider::Account { home, .. } => {
                let (mut auth, file) = (store::claude_auth(home)?, home.join("oauth.json"));
                if auth
                    .expires_at
                    .is_some_and(|t| t <= store::epoch_ms() + 60_000)
                {
                    let _guard = self.claude_refresh.lock().await;
                    auth = store::claude_auth(home)?;
                    if auth
                        .expires_at
                        .is_some_and(|t| t <= store::epoch_ms() + 60_000)
                    {
                        let refresh = auth
                            .refresh_token
                            .as_deref()
                            .context("Claude sign-in required.")?;
                        let response = self.client().post("https://platform.claude.com/v1/oauth/token").timeout(Duration::from_secs(15))
                            .json(&json!({"grant_type": "refresh_token", "refresh_token": refresh, "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"}))
                            .send().await?.error_for_status()?.json::<Value>().await?;
                        let current = store::claude_auth(home)?;
                        if current.access_token == auth.access_token {
                            auth = current;
                            auth.access_token = response["access_token"]
                                .as_str()
                                .context("Invalid Claude credentials.")?
                                .into();
                            if let Some(token) = response["refresh_token"].as_str() {
                                auth.refresh_token = Some(token.into());
                            }
                            auth.expires_at = Some(
                                store::epoch_ms().saturating_add(
                                    response["expires_in"]
                                        .as_u64()
                                        .context("Invalid Claude credentials.")?
                                        .saturating_mul(1000),
                                ),
                            );
                            store::atomic(&file, &serde_json::to_value(&auth)?)?;
                        } else {
                            auth = current;
                        }
                    }
                }
                headers.insert(
                    header::AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {}", auth.access_token))?,
                );
                let mut beta = header_text(&headers, "anthropic-beta")
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>();
                if !beta.iter().any(|s| s == "oauth-2025-04-20") {
                    beta.push("oauth-2025-04-20".into());
                }
                headers.insert("anthropic-beta", HeaderValue::from_str(&beta.join(","))?);
                "https://api.anthropic.com".to_owned()
            }
        };
        Ok((base, headers))
    }
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}
fn version(value: &str) -> Option<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(r"^([0-9]{1,4}(?:\.[0-9]{1,4}){2})(?:-[\w.-]+)?(?:\+[\w.-]+)?$").unwrap()
        })
        .captures(value)
        .map(|m| m[1].to_owned())
}
fn request_version(headers: &HeaderMap) -> Option<String> {
    let ua = header_text(headers, "user-agent");
    let origin = header_text(headers, "originator");
    let (family, candidate) = ua.split_once('/')?;
    if (!origin.is_empty() && family == origin) || family.to_ascii_lowercase().starts_with("codex")
    {
        return version(candidate.split_whitespace().next()?);
    }
    None
}
fn authorized(headers: &HeaderMap, token: &str, claude: bool) -> bool {
    let alternate = header_text(
        headers,
        if claude {
            "x-api-key"
        } else {
            "x-fluid-token"
        },
    );
    let primary = header_text(headers, "authorization")
        .strip_prefix("Bearer ")
        .unwrap_or_default();
    let supplied = if (claude && !primary.is_empty()) || alternate.is_empty() {
        primary
    } else {
        alternate
    };
    !supplied.is_empty() && supplied.as_bytes().ct_eq(token.as_bytes()).into()
}
fn json_response(status: u16, value: Value) -> Response {
    response(
        status,
        "application/json",
        Body::from(value.to_string()),
        None,
        None,
    )
}
fn error(status: u16, message: impl Into<String>, claude: bool) -> Response {
    if claude {
        json_response(
            status,
            json!({"type": "error", "error": {"type": "api_error", "message": message.into()}}),
        )
    } else {
        json_response(
            status,
            json!({"error": {"message": message.into(), "type": "switch_proxy_error"}}),
        )
    }
}
fn response(
    status: u16,
    content_type: &str,
    body: Body,
    alias: Option<&str>,
    upstream: Option<&HeaderMap>,
) -> Response {
    let mut out = Response::new(body);
    *out.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = out.headers_mut();
    if let Ok(value) = HeaderValue::from_str(content_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-switch-service", HeaderValue::from_static("fluid"));
    if let Some(alias) = alias.and_then(|name| HeaderValue::from_str(name).ok()) {
        headers.insert("x-switch-alias", alias);
    }
    if let Some(upstream) = upstream {
        for (key, value) in upstream {
            if matches!(
                key.as_str(),
                "retry-after"
                    | "request-id"
                    | "x-request-id"
                    | "x-codex-imagegen-request-id"
                    | "x-switch-image-route"
            ) || key.as_str().starts_with("anthropic-ratelimit-")
            {
                headers.insert(key.clone(), value.clone());
            }
        }
    }
    out
}

struct Active(Arc<Gateway>, bool);
impl Drop for Active {
    fn drop(&mut self) {
        if self.1 {
            self.0.active_claude.fetch_sub(1, Ordering::Relaxed);
        }
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}

pub async fn serve(gateway: Arc<Gateway>, req: Request) -> Response {
    let claude = req.uri().path().starts_with("/claude/")
        || req.uri().path().starts_with("/claude-desktop/");
    let token = if claude {
        &gateway.claude_requests
    } else {
        &gateway.codex_requests
    }
    .lock()
    .unwrap()
    .clone();
    let cancelled = token.clone();
    let active = if req.method() == Method::POST {
        gateway.active.fetch_add(1, Ordering::Relaxed);
        if claude {
            gateway.active_claude.fetch_add(1, Ordering::Relaxed);
        }
        Some(Active(gateway.clone(), claude))
    } else {
        None
    };
    let answer = tokio::select! {
        _ = token.cancelled() => error(503, "Routing is stopped.", claude),
        result = handle(&gateway, req, claude) => result.unwrap_or_else(|_| error(502, "Routing failed. Check the provider configuration and connection.", claude)),
    };
    let (parts, body) = answer.into_parts();
    let stream = body.into_data_stream();
    let body = Body::from_stream(futures_util::stream::unfold(
        (stream, cancelled, active),
        |(mut stream, stop, active)| async {
            let data = tokio::select! {
                _ = stop.cancelled() => return None,
                data = stream.next() => data?,
            };
            Some((data, (stream, stop, active)))
        },
    ));
    Response::from_parts(parts, body)
}

async fn handle(gateway: &Gateway, req: Request, claude: bool) -> Result<Response> {
    let root = if claude {
        gateway.root.join("claude")
    } else {
        gateway.root.clone()
    };
    let state = State::load(&root)?;
    let (parts, body) = req.into_parts();
    if !authorized(&parts.headers, &state.token, claude) {
        return Ok(error(401, "A local fluid token is required.", claude));
    }
    if parts.headers.contains_key(header::UPGRADE) {
        return Ok(error(
            426,
            "Use HTTP streaming for fluid routing.",
            claude,
        ));
    }
    let route = match parts.uri.path() {
        "/images/generations" | "/v1/v1/images/generations" | "/codex/v1/images/generations" => {
            "/v1/images/generations"
        }
        "/images/edits" | "/v1/v1/images/edits" | "/codex/v1/images/edits" => "/v1/images/edits",
        path => path,
    };
    if parts.method == Method::GET && route == "/health" {
        return Ok(json_response(
            200,
            json!({"service": "fluid", "active": state.active}),
        ));
    }
    let configured = match (gateway.mode, claude) {
        (Mode::Service, false) => true,
        (Mode::Service, true) => gateway.root.join("claude-session.json").is_file(),
        (Mode::Desktop, false) => gateway.root.join("desktop-session.json").is_file(),
        (Mode::Desktop, true) => {
            gateway.root.join("claude-session.json").is_file()
                || gateway.root.join("claude-desktop-session.json").is_file()
        }
    };
    if !gateway.enabled.load(Ordering::Acquire) || !configured {
        return Ok(error(
            503,
            "Routing is stopped. Reload the client to use its restored connection.",
            claude,
        ));
    }
    if claude {
        return claude_request(gateway, root, state, parts, body).await;
    }
    let mut queried = request_version(&parts.headers);
    {
        if let Some(query) = parts.uri.query() {
            if let Some(value) = reqwest::Url::parse(&format!("http://localhost/?{query}"))
                .ok()
                .and_then(|url| {
                    url.query_pairs().find_map(|(key, value)| {
                        if key == "client_version" {
                            version(&value)
                        } else {
                            None
                        }
                    })
                })
            {
                queried = Some(value);
            }
        }
    }
    if parts.method == Method::GET && route == "/v1/models" {
        if let Some(value) = &queried {
            *gateway.version.write().unwrap() = Some(value.clone());
        }
        if queried.is_none()
            && state
                .providers
                .values()
                .any(|p| p.enabled() && p.is_account())
        {
            queried = gateway.installed_version().await;
        }
        return Ok(json_response(
            200,
            catalog::codex_union(gateway, &state, queried.as_deref()).await,
        ));
    }
    let image = matches!(route, "/v1/images/generations" | "/v1/images/edits");
    if parts.method != Method::POST
        || (!image && !matches!(route, "/v1/responses" | "/v1/responses/compact"))
    {
        return Ok(error(
            404,
            "Only Responses, compaction, and image requests are supported.",
            false,
        ));
    }
    if let Some(value) = &queried {
        *gateway.version.write().unwrap() = Some(value.clone());
    }
    let raw = match to_bytes(body, 32 * 1024 * 1024).await {
        Ok(raw) => raw,
        Err(_) => return Ok(error(413, "Request exceeds 32 MiB.", false)),
    };
    let forwarded_route = match parts.uri.query() {
        Some(query) if image => format!("{route}?{query}"),
        _ => route.to_owned(),
    };
    codex_request(
        gateway,
        &root,
        state,
        &forwarded_route,
        &parts.headers,
        raw,
        image,
        queried,
    )
    .await
}

async fn text(response: reqwest::Response) -> String {
    let mut stream = response.bytes_stream();
    let mut collected = Vec::new();
    while let Some(Ok(chunk)) = stream.next().await {
        let remaining = 65536 - collected.len();
        collected.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
        if collected.len() == 65536 {
            break;
        }
    }
    String::from_utf8_lossy(&collected).into_owned()
}

struct Attempt {
    status: u16,
    headers: HeaderMap,
    body: Option<Body>,
    message: String,
    frame: Option<Value>,
    capacity: bool,
    invalid_stream: bool,
}
impl Attempt {
    fn failure(status: u16, message: String) -> Self {
        Self {
            status,
            headers: HeaderMap::new(),
            body: None,
            message,
            frame: None,
            capacity: false,
            invalid_stream: false,
        }
    }
    async fn receive(
        upstream: reqwest::Response,
        claude: bool,
        image: bool,
        meter: &mut Option<crate::usage::Meter>,
    ) -> Self {
        let status = upstream.status().as_u16();
        let mut answer = Self::failure(status, String::new());
        answer.headers = upstream.headers().clone();
        if let Some(meter) = meter.as_mut() {
            meter.status(status);
        }
        if !(200..300).contains(&status) {
            answer.message = text(upstream).await;
            answer.capacity = capacity(&answer.message);
            return answer;
        }
        let content = header_text(&answer.headers, "content-type")
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let need_sse = content == "text/event-stream" || !claude && !image;
        if need_sse {
            if content != "text/event-stream" && !content.is_empty() {
                answer.invalid_stream = true;
                return answer;
            }
            match stream::inspect(upstream, claude, content.is_empty()).await {
                Ok(Some(startup)) => {
                    answer.body = Some(startup.body);
                    answer.frame = startup.error;
                    answer.capacity = startup.capacity;
                }
                Ok(None) => answer.invalid_stream = true,
                Err(_) => answer.status = 502,
            }
        } else if content == "application/json" || claude && content.is_empty() {
            answer.body = Some(Body::from_stream(
                upstream
                    .bytes_stream()
                    .map(|result| result.map_err(io::Error::other)),
            ));
        } else {
            answer.invalid_stream = true;
        }
        if answer.invalid_stream {
            if let Some(meter) = meter.as_mut() {
                meter.failed();
            }
        }
        if let Some(body) = answer.body.take() {
            answer.body = Some(if let Some(mut meter) = meter.take() {
                if answer.frame.is_some() {
                    meter.failed();
                }
                meter.wrap(body, status)
            } else {
                body
            });
        }
        answer
    }
    fn text(&self) -> String {
        self.frame
            .as_ref()
            .map(Value::to_string)
            .unwrap_or_else(|| self.message.clone())
    }
    fn success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

const SUMMARY: &str = "Create a concise continuation summary of this conversation. Preserve the user’s goal, constraints and instructions, completed changes, file paths, tool results, unresolved issues and next steps. Do not perform new work or call tools. Return only the summary.";
const CHECKPOINT: &str = "fluid:v1:";

fn input_with_context(input: &mut Value, token: &str) -> Result<()> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};
    let Some(items) = input.as_array_mut() else {
        return Ok(());
    };
    let ids: HashMap<_, _> = items
        .iter()
        .filter(|item| item["type"] != "item_reference")
        .filter_map(|item| Some((item["id"].as_str()?.to_owned(), item.clone())))
        .collect();
    let references: HashSet<_> = items
        .iter()
        .filter(|item| item["type"] == "item_reference")
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .filter(|id| ids.contains_key(id))
        .collect();
    let mut output = Vec::with_capacity(items.len());
    let mut seen = HashSet::new();
    for mut item in std::mem::take(items) {
        if let Some(id) = item["id"].as_str().filter(|id| references.contains(*id)) {
            if !seen.insert(id.to_owned()) {
                continue;
            }
            if item["type"] == "item_reference" {
                item = ids[id].clone();
            }
        }
        if matches!(
            item["type"].as_str(),
            Some("compaction" | "compaction_summary")
        ) {
            if let Some(encrypted) = item["encrypted_content"]
                .as_str()
                .and_then(|s| s.strip_prefix(CHECKPOINT))
            {
                let data = URL_SAFE_NO_PAD.decode(encrypted)?;
                if data.len() < 28 {
                    bail!("Invalid checkpoint");
                }
                let cipher = Aes256Gcm::new_from_slice(&Sha256::digest(token)).unwrap();
                let mut body = data[28..].to_vec();
                body.extend_from_slice(&data[12..28]);
                let summary = cipher
                    .decrypt(aes_gcm::Nonce::from_slice(&data[..12]), body.as_ref())
                    .map_err(|_| anyhow::anyhow!("Invalid checkpoint"))?;
                item = json!({"type": "message", "role": "assistant", "content": [{"type": "output_text","text": String::from_utf8(summary)?}]});
            }
        }
        if item["type"] != "reasoning" {
            output.push(item);
        }
    }
    *items = output;
    Ok(())
}

async fn compact_result(
    body: Body,
    token: &str,
    standalone: bool,
    alias: &str,
) -> Result<Response> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};
    let bytes = to_bytes(body, 4 * 1024 * 1024).await?;
    let text = std::str::from_utf8(&bytes)?.replace("\r\n", "\n");
    let mut completed = None;
    let mut delta = String::new();
    for frame in text.split("\n\n") {
        let data = frame
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let event: Value = serde_json::from_str(&data)?;
        match event["type"].as_str().unwrap_or_default() {
            "error" | "response.failed" | "response.incomplete" => {
                bail!("Compaction was not completed.")
            }
            "response.output_text.delta" => {
                delta.push_str(event["delta"].as_str().unwrap_or_default())
            }
            "response.completed" => completed = event.get("response").cloned(),
            _ => {}
        }
    }
    let completed = completed.context("Compaction stream ended before completion.")?;
    let mut outputs = Vec::new();
    if let Some(items) = completed["output"].as_array() {
        for item in items {
            match item["type"].as_str() {
                Some("message") => {
                    if let Some(content) = item["content"].as_array() {
                        outputs.extend(
                            content
                                .iter()
                                .filter(|block| block["type"] == "output_text")
                                .filter_map(|block| block["text"].as_str()),
                        );
                    }
                }
                Some("reasoning") => {}
                _ => bail!("Compaction returned a tool call instead of a summary."),
            }
        }
    }
    let summary = if outputs.is_empty() {
        delta
    } else {
        outputs.join("\n")
    };
    if summary.trim().is_empty() {
        bail!("Compaction returned no readable summary.");
    }
    let nonce = uuid::Uuid::new_v4();
    let nonce = &nonce.as_bytes()[..12];
    let encrypted = Aes256Gcm::new_from_slice(&Sha256::digest(token))
        .unwrap()
        .encrypt(aes_gcm::Nonce::from_slice(nonce), summary.as_bytes())
        .map_err(|_| anyhow::anyhow!("Compaction encryption failed."))?;
    let split = encrypted.len() - 16;
    let content = [nonce, &encrypted[split..], &encrypted[..split]].concat();
    let id = format!("cmp_{}", uuid::Uuid::new_v4().simple());
    let item = json!({"type":"compaction","id":id,"encrypted_content":format!("{CHECKPOINT}{}", URL_SAFE_NO_PAD.encode(content))});
    let mut result = json!({"id":id,"object":"response.compaction","created_at":store::epoch_ms()/1000,"output":[item]});
    if let Some(usage) = completed.get("usage") {
        result["usage"] = usage.clone();
    }
    if standalone {
        return Ok(response(
            200,
            "application/json",
            Body::from(result.to_string()),
            Some(alias),
            None,
        ));
    }
    result["status"] = json!("completed");
    let item = json!({"type":"response.output_item.done","output_index":0,"item":item});
    let finished = json!({"type":"response.completed","response":result});
    let frames = format!("event: response.output_item.done\ndata: {item}\n\nevent: response.completed\ndata: {finished}\n\n");
    Ok(response(
        200,
        "text/event-stream",
        Body::from(frames),
        Some(alias),
        None,
    ))
}

async fn codex_request(
    gateway: &Gateway,
    root: &Path,
    mut state: State,
    route: &str,
    incoming: &HeaderMap,
    raw: Bytes,
    image: bool,
    version: Option<String>,
) -> Result<Response> {
    let compact = route.ends_with("/compact");
    let content_type = incoming
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("application/json");
    let mime = content_type.split(';').next().unwrap_or_default().trim();
    if image && !matches!(mime, "application/json" | "multipart/form-data") {
        return Ok(error(
            400,
            "Image requests must use JSON or multipart/form-data.",
            false,
        ));
    }
    let mut payload = if image {
        Value::Null
    } else {
        match serde_json::from_slice::<Value>(&raw) {
            Ok(value) if value.is_object() => value,
            _ => return Ok(error(400, "Invalid JSON request.", false)),
        }
    };
    if !image {
        if !payload["previous_response_id"].is_null() || !payload["conversation"].is_null() {
            return Ok(error(400, "A complete input history is required.", false));
        }
        if !payload["input"].is_array() && !payload["input"].is_string() {
            return Ok(error(400, "Missing input.", false));
        }
        if input_with_context(&mut payload["input"], &state.token).is_err() {
            return Ok(error(
                400,
                "The local compaction checkpoint could not be decoded.",
                false,
            ));
        }
        payload["store"] = json!(false);
        payload["stream"] = json!(true);
    }
    let summary = compact
        || payload["input"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["type"] == "compaction_trigger")
        });
    if summary {
        if let Some(text) = payload["input"].as_str() {
            payload["input"] = json!([{"role":"user","content":text}]);
        }
        let input = payload["input"].as_array_mut().unwrap();
        input.retain(|item| item["type"] != "compaction_trigger");
        input.push(json!({"role":"user","content":SUMMARY}));
        for key in ["tools", "tool_choice", "context_management"] {
            payload.as_object_mut().unwrap().shift_remove(key);
        }
    }
    let model = payload["model"].as_str().unwrap_or_default().to_owned();
    let checked_version = version.as_deref();
    let Some(mut alias) = state
        .active
        .clone()
        .filter(|name| state.providers.get(name).is_some_and(Provider::enabled))
    else {
        return Ok(error(409, "Add and select a provider first.", false));
    };
    let cooling = if image {
        &gateway.image_cooling
    } else {
        &gateway.codex_cooling
    };
    cooling.lock().unwrap().update(state.manual_generation);
    let mut attempted = Vec::<String>::new();
    let mut image_failures = Vec::new();
    let mut model_routing = false;
    let mut fallback_status = None;
    let mut last = None;
    if image
        && state
            .providers
            .values()
            .any(|p| p.enabled() && p.is_account())
    {
        if let Some(next) = backup(
            gateway,
            &state,
            cooling,
            &attempted,
            &model,
            checked_version,
            true,
        )
        .await
        {
            alias = next;
        } else {
            return Ok(error(
                429,
                "No saved image provider is available. Check the account sign-in or quota.",
                false,
            ));
        }
    } else if !image {
        let model_key = if state.providers[&alias].is_account() {
            format!("{model}@{}", checked_version.unwrap_or_default())
        } else {
            model.clone()
        };
        let blocked = cooling
            .lock()
            .unwrap()
            .until
            .contains_key(&(alias.clone(), model_key));
        if !model.is_empty()
            && (blocked
                || !gateway
                    .catalog
                    .supports(&alias, &state.providers[&alias], &model, checked_version)
                    .await)
        {
            model_routing = true;
            let Some(next) = backup(
                gateway,
                &state,
                cooling,
                &attempted,
                &model,
                checked_version,
                false,
            )
            .await
            else {
                return Ok(error(
                    400,
                    format!("No configured provider lists {model}."),
                    false,
                ));
            };
            alias = next;
        }
    }
    let client = gateway.client();
    for _ in 0..state.providers.len() + 2 {
        if let Ok(latest) = State::load(root) {
            if !latest.providers.get(&alias).is_some_and(Provider::enabled) {
                if let Some(next) = backup(
                    gateway,
                    &latest,
                    cooling,
                    &attempted,
                    &model,
                    checked_version,
                    image,
                )
                .await
                {
                    state = latest;
                    alias = next;
                    continue;
                }
                break;
            }
        }
        let Some(provider) = state.providers.get(&alias) else {
            break;
        };
        attempted.push(alias.clone());
        let upstream_route = if compact {
            "responses"
        } else {
            route.trim_start_matches("/v1/")
        };
        let (url, auth) = match provider {
            Provider::Api {
                base_url, api_key, ..
            } => (
                format!("{base_url}/{upstream_route}"),
                Some((api_key.clone(), None)),
            ),
            Provider::Account { home, .. } => (
                gateway.codex_endpoint(upstream_route),
                store::codex_auth(home)
                    .ok()
                    .map(|auth| (auth.tokens.access_token, Some(auth.tokens.account_id))),
            ),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(if image {
                content_type
            } else {
                "application/json"
            })?,
        );
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static(if image {
                "application/json"
            } else {
                "text/event-stream"
            }),
        );
        if image {
            for name in [
                "originator",
                "user-agent",
                "x-codex-image-turn-id",
                "x-codex-turn-metadata",
            ] {
                if let Some(value) = incoming.get(name) {
                    headers.insert(name, value.clone());
                }
            }
        }
        if provider.is_account() {
            headers
                .entry("originator")
                .or_insert(HeaderValue::from_static("codex_cli_rs"));
            headers.insert(
                "openai-beta",
                HeaderValue::from_static("responses=experimental"),
            );
        }
        let body = if image {
            raw.clone()
        } else {
            let account_instructions = provider.is_account() && payload["instructions"].is_null();
            if account_instructions {
                let original = payload
                    .as_object_mut()
                    .unwrap()
                    .insert("instructions".into(), json!(""));
                let bytes = serde_json::to_vec(&payload)?;
                if let Some(original) = original {
                    payload["instructions"] = original;
                } else {
                    payload
                        .as_object_mut()
                        .unwrap()
                        .shift_remove("instructions");
                }
                Bytes::from(bytes)
            } else {
                Bytes::from(serde_json::to_vec(&payload)?)
            }
        };
        let mut meter = None;
        let mut answer = if !image
            && !model.is_empty()
            && !gateway
                .catalog
                .supports(&alias, provider, &model, checked_version)
                .await
        {
            Attempt::failure(400, json!({"error":{"code":"model_not_found","message":"This provider does not list the selected model."}}).to_string())
        } else if let Some((key, account)) = auth {
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {key}"))?,
            );
            if let Some(account) = account {
                headers.insert("chatgpt-account-id", HeaderValue::from_str(&account)?);
            }
            meter = Some(
                gateway
                    .usage
                    .begin(false, &alias, &model, provider.is_account(), !image),
            );
            match client
                .post(url)
                .headers(headers.clone())
                .body(body)
                .send()
                .await
            {
                Ok(response) => Attempt::receive(response, false, image, &mut meter).await,
                Err(_) => Attempt::failure(502, String::new()),
            }
        } else {
            Attempt::failure(401, String::new())
        };

        let mut image_route = false;
        if image
            && provider.is_account()
            && mime == "application/json"
            && account_image_fallback(answer.status, &answer.message)
        {
            headers.remove("openai-beta");
            let url = format!("https://chatgpt.com/backend-api/wham/{upstream_route}");
            answer = match client
                .post(url)
                .headers(headers)
                .body(raw.clone())
                .send()
                .await
            {
                Ok(response) => Attempt::receive(response, false, true, &mut meter).await,
                Err(_) => Attempt::failure(502, String::new()),
            };
            image_route = true;
        }
        let mut submitted = false;
        if gateway.mode == Mode::Desktop
            && image
            && provider.is_account()
            && account_image_fallback(answer.status, &answer.message)
        {
            let Provider::Account { home, .. } = provider else {
                unreachable!()
            };
            if let Some(page) = crate::images::generate(
                gateway,
                home,
                route.split('?').next().unwrap_or(route),
                &raw,
                content_type,
                header_text(incoming, "x-codex-image-turn-id"),
            )
            .await
            {
                submitted = page.submitted;
                if !(200..300).contains(&page.status) {
                    image_failures.push(format!("{alias}: {}", message(&page.message)));
                }
                if let Some(meter) = meter.as_mut() {
                    meter.status(page.status);
                }
                answer = Attempt::failure(page.status, page.message);
                answer.headers = page.headers;
                answer.body = page.body.map(|body| {
                    if let Some(meter) = meter.take() {
                        meter.wrap(body, page.status)
                    } else {
                        body
                    }
                });
                image_route = true;
            }
        }
        if image_route {
            answer.headers.insert(
                "x-switch-image-route",
                HeaderValue::from_static("chatgpt-account"),
            );
        }
        if answer.invalid_stream {
            return Ok(error(
                502,
                "The upstream did not return a valid Responses stream.",
                false,
            ));
        }
        let detail = answer.text();
        let rejected = rejection(&detail);
        let inspected_status = if answer.success() && answer.frame.is_some() {
            400
        } else {
            answer.status
        };
        let model_error = !image && model_denied(inspected_status, &detail);
        let context_error = !image && context_denied(inspected_status, &detail);
        let image_error = image
            && image_denied(
                if answer.success() && answer.frame.is_some() {
                    403
                } else {
                    answer.status
                },
                &detail,
            );
        if answer.success() && !answer.capacity && answer.frame.is_none() {
            let output = answer.body.unwrap_or_else(Body::empty);
            let result = if summary {
                compact_result(output, &state.token, compact, &alias).await?
            } else {
                let content = if image
                    && !header_text(&answer.headers, "content-type")
                        .starts_with("text/event-stream")
                {
                    "application/json"
                } else {
                    "text/event-stream"
                };
                response(
                    answer.status,
                    content,
                    output,
                    Some(&alias),
                    Some(&answer.headers),
                )
            };
            if let (Some(status), Some(from)) = (fallback_status, state.active.as_deref()) {
                if !image && !model_routing && alias != from {
                    let _ = store::fallback(root, state.generation, from, &alias, status);
                }
            }
            return Ok(result);
        }
        let status = if answer.capacity {
            503
        } else if answer.success() {
            if rejected != 0 {
                rejected
            } else if image_error {
                403
            } else {
                400
            }
        } else if matches!(answer.status, 400 | 422 | 500 | 502 | 503 | 504 | 529)
            && matches!(rejected, 401 | 402 | 403 | 429)
        {
            rejected
        } else {
            answer.status
        };
        if answer.capacity && answer.success() && !image {
            return Ok(response(
                200,
                "text/event-stream",
                answer.body.unwrap_or_else(Body::empty),
                Some(&alias),
                Some(&answer.headers),
            ));
        }
        if model_error || context_error {
            model_routing = true;
        }
        if !submitted
            && (recoverable(status, &detail)
                || model_error
                || context_error
                || image_error
                || image
                    && (answer.capacity
                        || matches!(status, 500 | 502 | 503 | 504 | 529)
                            && recoverable(403, &detail)))
        {
            if !context_error {
                let key = if model_error && provider.is_account() {
                    format!("{model}@{}", checked_version.unwrap_or_default())
                } else if model_error {
                    model.clone()
                } else {
                    String::new()
                };
                cooling.lock().unwrap().block(&alias, &key);
            }
            let latest = State::load(root).unwrap_or_else(|_| state.clone());
            let changed = latest.generation != state.generation;
            let candidate = if changed && !image {
                latest.active.clone().filter(|name| {
                    !attempted.contains(name)
                        && latest.providers.get(name).is_some_and(Provider::enabled)
                })
            } else {
                backup(
                    gateway,
                    &state,
                    cooling,
                    &attempted,
                    &model,
                    checked_version,
                    image,
                )
                .await
            };
            if let Some(next) = candidate {
                if !image {
                    state = latest;
                    fallback_status = (!changed).then_some(status);
                }
                alias = next;
                continue;
            }
        }
        if status == 401 {
            if let Provider::Account { home, .. } = provider {
                if !recoverable(401, &detail) {
                    return Ok(error(401, "The upstream rejected this request.", false));
                }
                let prompt = gateway
                    .worker
                    .call(
                        "auth-required",
                        json!({"client":"codex","alias":alias,"accountHome":home}),
                        gateway.context(),
                    )
                    .await
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_else(|| {
                        "The saved Codex subscription needs sign-in in fluid.".into()
                    });
                if let Some(show) = &gateway.reauth {
                    if prompt.contains("https://auth.openai.com/codex/device") {
                        show("codex", &alias);
                    }
                }
                return Ok(error(401, prompt, false));
            }
        }
        let note = if image {
            let mut note = format!(
                "Image upstream {alias} returned HTTP {status}. Tried: {}.",
                attempted.join(" → ")
            );
            if !image_failures.is_empty() {
                note.push(' ');
                note.push_str(&image_failures.join("; "));
            }
            note
        } else if model_error {
            format!("No backup provider can use {model}.")
        } else if context_error {
            "The upstream could not read this legacy checkpoint. The original context has been preserved.".to_owned()
        } else {
            format!(
                "Upstream {alias} returned HTTP {status}. Tried: {}.",
                attempted.join(" → ")
            )
        };
        let mut result = error(status, note, false);
        if let Some(value) = answer.headers.get("retry-after") {
            result.headers_mut().insert("retry-after", value.clone());
        }
        if image {
            for key in ["x-codex-imagegen-request-id", "x-switch-image-route"] {
                if let Some(value) = answer.headers.get(key) {
                    result.headers_mut().insert(key, value.clone());
                }
            }
            result
                .headers_mut()
                .insert("x-switch-alias", HeaderValue::from_str(&alias)?);
        }
        last = Some(result);
        break;
    }
    Ok(last.unwrap_or_else(|| error(502, "No available provider.", false)))
}

async fn backup(
    gateway: &Gateway,
    state: &State,
    cooling: &Mutex<Cooling>,
    attempted: &[String],
    model: &str,
    version: Option<&str>,
    image: bool,
) -> Option<String> {
    let mut order = state.ordered();
    if image {
        order.sort_by_key(|alias| {
            !state
                .providers
                .get(*alias)
                .is_some_and(Provider::is_account)
        });
    }
    for alias in order {
        if attempted.iter().any(|name| name == alias) {
            continue;
        }
        let Some(provider) = state.providers.get(alias) else {
            continue;
        };
        let key = if provider.is_account() && !image {
            format!("{model}@{}", version.unwrap_or_default())
        } else {
            model.to_owned()
        };
        if cooling.lock().unwrap().blocked(alias, &key) || !provider.usable(false) {
            continue;
        }
        if image
            || model.is_empty()
            || gateway
                .catalog
                .supports(alias, provider, model, version)
                .await
        {
            return Some(alias.into());
        }
    }
    None
}

const CLAUDE_FAMILIES: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];
fn family(model: &str) -> Option<&'static str> {
    let model = model.to_ascii_lowercase();
    CLAUDE_FAMILIES.into_iter().find(|name| {
        model == *name || model.starts_with("claude-") && model.split('-').any(|part| part == *name)
    })
}
pub(crate) fn model_name(model: &str) -> &str {
    if model.to_ascii_lowercase().ends_with("[1m]") {
        &model[..model.len() - 4]
    } else {
        model
    }
}
fn claude_model<'a>(
    provider: &'a Provider,
    model: &'a str,
    models: &'a [Value],
    headers: &HeaderMap,
    desktop: bool,
) -> &'a str {
    let role = family(model);
    let mut mapped = None;
    if let Provider::Api { mappings, .. } = provider {
        if role.is_some() || model.to_ascii_lowercase().starts_with("claude-") {
            mapped = role.and_then(|family| mappings.get(family));
            if mapped.is_none()
                && (headers.contains_key("x-claude-code-agent-id") || role == Some("haiku"))
            {
                mapped = mappings.get("subagent");
            }
            mapped = mapped.or_else(|| mappings.get("default"));
        }
        if desktop && (model.is_empty() || model == "default") {
            mapped = mappings.get("default");
        }
    }
    if let Some(mapped) = mapped {
        return model_name(mapped);
    }
    if desktop && (model.is_empty() || model == "default") {
        return models
            .first()
            .and_then(|item| item["id"].as_str())
            .unwrap_or(model);
    }
    if desktop && !model.starts_with("claude-") {
        if let Some(role) = role {
            return models
                .iter()
                .filter_map(|item| item["id"].as_str())
                .find(|id| family(id) == Some(role))
                .unwrap_or(model);
        }
    }
    model
}
type ClaudeCatalog = HashMap<String, (Vec<Value>, bool)>;
async fn claude_catalog(gateway: &Gateway, state: &State, headers: &HeaderMap) -> ClaudeCatalog {
    futures_util::future::join_all(state.ordered().into_iter().filter_map(|alias| {
        state.providers.get(alias).map(|provider| async move {
            (
                alias.to_owned(),
                gateway
                    .catalog
                    .provider(gateway, alias, provider, None, true, Some(headers))
                    .await,
            )
        })
    }))
    .await
    .into_iter()
    .collect()
}

async fn claude_request(
    gateway: &Gateway,
    root: PathBuf,
    mut state: State,
    parts: axum::http::request::Parts,
    body: Body,
) -> Result<Response> {
    let path = parts.uri.path();
    let desktop = path.starts_with("/claude-desktop/");
    let target = path
        .strip_prefix(if desktop {
            "/claude-desktop"
        } else {
            "/claude"
        })
        .unwrap();
    let is_catalog = parts.method == Method::GET && target == "/v1/models";
    if !is_catalog
        && (parts.method != Method::POST
            || !matches!(target, "/v1/messages" | "/v1/messages/count_tokens"))
    {
        return Ok(error(
            404,
            "Only Anthropic Messages, token counting and model discovery are supported.",
            true,
        ));
    }
    if !state
        .active
        .as_ref()
        .is_some_and(|alias| state.providers.get(alias).is_some_and(Provider::enabled))
    {
        return Ok(error(409, "Add a Claude Code provider first.", true));
    }
    if is_catalog {
        let catalog = claude_catalog(gateway, &state, &parts.headers).await;
        let mut all = indexmap::IndexMap::new();
        for alias in state.ordered() {
            if let Some((models, _)) = catalog.get(alias) {
                for item in models {
                    let Some(id) = item["id"].as_str() else {
                        continue;
                    };
                    let route = catalog::route_id(id);
                    all.entry(route.clone()).or_insert_with(|| {
                        let description: String = format!("fluid · {id}").chars().take(100).collect();
                        let mut model = item.clone();
                        model.as_object_mut().unwrap().extend(json!({"id":route,"type":"model","display_name":item["display_name"].as_str().unwrap_or(id),
                            "created_at":"2024-01-01T00:00:00Z","description":description}).as_object().unwrap().clone());
                        model
                    });
                }
            }
        }
        if all.is_empty() && catalog.values().all(|(_, known)| !known) {
            return Ok(error(503, "fluid could not read any configured Claude model catalog. Check provider authentication and model-list permissions.", true));
        }
        let data: Vec<_> = all.into_values().collect();
        return Ok(json_response(
            200,
            json!({"first_id":data.first().map(|model| &model["id"]),"last_id":data.last().map(|model| &model["id"]),"data":data,"has_more":false}),
        ));
    }
    let raw = match to_bytes(body, 32 * 1024 * 1024).await {
        Ok(raw) => raw,
        Err(_) => return Ok(error(413, "Request exceeds 32 MiB.", true)),
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(&raw) else {
        return Ok(error(400, "Invalid Messages request.", true));
    };
    if !payload["messages"].is_array() {
        return Ok(error(400, "A complete Messages history is required.", true));
    }
    let requested = model_name(payload["model"].as_str().unwrap_or_default()).to_owned();
    let synthetic = matches_regex!(r"-es-[a-f0-9]{16}$", &requested);
    let catalog = if desktop || synthetic {
        claude_catalog(gateway, &state, &parts.headers).await
    } else {
        HashMap::new()
    };
    let mut explicit = if synthetic {
        let found = catalog
            .values()
            .flat_map(|(models, _)| models)
            .filter_map(|item| item["id"].as_str())
            .find(|id| catalog::matches_route(id, &requested));
        let Some(found) = found else {
            return Ok(error(400, "The selected model is no longer in any configured catalog. Refresh the model list.", true));
        };
        Some(found.to_owned())
    } else if !requested.is_empty()
        && requested != "default"
        && !requested.to_ascii_lowercase().starts_with("claude-")
        && family(&requested).is_none()
    {
        Some(requested.clone())
    } else {
        None
    };
    let forwarded_path = parts
        .uri
        .query()
        .map(|query| format!("{target}?{query}"))
        .unwrap_or_else(|| target.to_owned());
    let mut alias = state.active.clone().unwrap();
    let mut attempts = Vec::<Value>::new();
    let mut attempted = HashSet::new();
    gateway
        .claude_cooling
        .lock()
        .unwrap()
        .update(state.manual_generation);
    for _ in 0..state.providers.len() + 2 {
        if let Ok(latest) = State::load(&root) {
            if !latest.providers.get(&alias).is_some_and(Provider::enabled) {
                let next = latest
                    .ordered()
                    .into_iter()
                    .find(|name| !attempted.contains(*name))
                    .map(str::to_owned);
                if let Some(next) = next {
                    state = latest;
                    alias = next;
                    continue;
                }
                break;
            }
        }
        let Some(provider) = state.providers.get(&alias) else {
            break;
        };
        attempted.insert(alias.clone());
        let entry = catalog.get(&alias);
        let model = explicit.clone().unwrap_or_else(|| {
            claude_model(
                provider,
                &requested,
                entry.map(|e| e.0.as_slice()).unwrap_or_default(),
                &parts.headers,
                desktop,
            )
            .to_owned()
        });
        if desktop && (requested.is_empty() || requested == "default") {
            explicit = Some(model.clone());
        }
        let unsupported = if let Some((models, known)) = entry {
            !models.iter().any(|item| item["id"] == model)
                && (*known || provider.is_account() && !model.starts_with("claude-"))
        } else {
            provider.is_account() && !model.starts_with("claude-")
        };
        let blocked = gateway
            .claude_cooling
            .lock()
            .unwrap()
            .blocked(&alias, &model);
        let mut meter = None;
        let (answer, secrets) = if unsupported {
            (Attempt::failure(400, json!({"error":{"code":"model_not_found","message":"This provider does not list the selected model."}}).to_string()), None)
        } else if blocked {
            (
                Attempt::failure(
                    429,
                    "This provider is cooling down after an upstream rejection.".into(),
                ),
                None,
            )
        } else {
            match gateway.claude_headers(provider, Some(&parts.headers)).await {
                Ok((base, headers)) => {
                    let secret = header_text(&headers, "authorization")
                        .strip_prefix("Bearer ")
                        .map(str::to_owned);
                    payload["model"] = json!(model);
                    if target == "/v1/messages" {
                        meter = Some(gateway.usage.begin(
                            true,
                            &alias,
                            &model,
                            provider.is_account(),
                            payload["stream"] == true,
                        ));
                    }
                    let result = match gateway
                        .client()
                        .post(format!("{base}{forwarded_path}"))
                        .headers(headers)
                        .json(&payload)
                        .send()
                        .await
                    {
                        Ok(response) => Attempt::receive(response, true, false, &mut meter).await,
                        Err(_) => Attempt::failure(
                            502,
                            "The upstream connection failed before any response was accepted."
                                .into(),
                        ),
                    };
                    (result, secret)
                }
                Err(error)
                    if error.downcast_ref::<reqwest::Error>().is_some_and(|error| {
                        error
                            .status()
                            .is_none_or(|status| !matches!(status.as_u16(), 400 | 401))
                    }) =>
                {
                    (
                        Attempt::failure(
                            502,
                            "Unable to refresh Claude credentials. Check the connection or proxy."
                                .into(),
                        ),
                        None,
                    )
                }
                Err(_) => (
                    Attempt::failure(
                        401,
                        "The saved Claude subscription needs sign-in in fluid.".into(),
                    ),
                    None,
                ),
            }
        };
        if answer.invalid_stream {
            return Ok(error(
                502,
                "The upstream did not return an Anthropic response.",
                true,
            ));
        }
        let detail = answer.text();
        let reject = rejection(&detail);
        if answer.success() && !answer.capacity && answer.frame.is_none() {
            if let Some(from) = state.active.as_deref().filter(|from| *from != alias) {
                let status = attempts
                    .last()
                    .and_then(|v| v["status"].as_u64())
                    .unwrap_or(400) as u16;
                if store::fallback(&root, state.generation, from, &alias, status).unwrap_or(false)
                    && (provider.has_contexts()
                        || state
                            .providers
                            .get(from)
                            .is_some_and(Provider::has_contexts))
                {
                    let worker = gateway.worker.clone();
                    tokio::spawn(async move {
                        if let Err(error) = worker
                            .call("sync-claude-context", Value::Null, Value::Null)
                            .await
                        {
                            eprintln!("fluid could not sync Claude Code context settings: {error:#}");
                        }
                    });
                }
            }
            return Ok(response(
                200,
                if header_text(&answer.headers, "content-type").is_empty() {
                    "application/json"
                } else {
                    header_text(&answer.headers, "content-type")
                },
                answer.body.unwrap_or_else(Body::empty),
                Some(&alias),
                Some(&answer.headers),
            ));
        }
        let status = if matches!(reject, 401 | 402 | 403 | 429) {
            reject
        } else if answer.capacity {
            503
        } else if answer.frame.is_some() {
            if reject != 0 {
                reject
            } else if model_denied(400, &detail) || detail.contains("invalid_request_error") {
                400
            } else {
                502
            }
        } else {
            answer.status
        };
        let safe_text = if let Ok(json) = serde_json::from_str::<Value>(&detail) {
            error_object(&json)["message"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        } else {
            String::new()
        };
        let safe_text = [&state.token, secrets.as_ref().unwrap_or(&state.token)]
            .into_iter()
            .filter(|v| !v.is_empty())
            .fold(safe_text, |value, token| value.replace(token, "[redacted]"));
        static REDACT: OnceLock<Regex> = OnceLock::new();
        let safe_text: String = REDACT
            .get_or_init(|| Regex::new(r#"(?i)Bearer\s+[^\s"',]+|\bsk-[\w-]+"#).unwrap())
            .replace_all(&safe_text, "[redacted]")
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(500)
            .collect();
        let mut failure =
            json!({"provider":alias,"model":model,"status":status,"message":safe_text});
        if unsupported {
            failure["skipped"] = json!(true);
        }
        attempts.push(failure);
        if recoverable(status, &detail) || model_denied(status, &detail) {
            gateway.claude_cooling.lock().unwrap().block(
                &alias,
                if matches!(status, 401 | 402) {
                    ""
                } else {
                    &model
                },
            );
            let latest = State::load(&root).unwrap_or_else(|_| state.clone());
            let next = if state.generation != latest.generation {
                latest.active.clone().filter(|name| {
                    !attempted.contains(name)
                        && latest.providers.get(name).is_some_and(Provider::enabled)
                })
            } else {
                let cooling = gateway.claude_cooling.lock().unwrap();
                state
                    .ordered()
                    .into_iter()
                    .find(|name| {
                        !attempted.contains(*name)
                            && state.providers.get(*name).is_some_and(|provider| {
                                let models = catalog
                                    .get(*name)
                                    .map(|entry| entry.0.as_slice())
                                    .unwrap_or_default();
                                let next_model = explicit.as_deref().unwrap_or_else(|| {
                                    claude_model(
                                        provider,
                                        &requested,
                                        models,
                                        &parts.headers,
                                        desktop,
                                    )
                                });
                                !cooling.blocked(name, next_model)
                            })
                    })
                    .map(str::to_owned)
            };
            if let Some(next) = next {
                state = latest;
                alias = next;
                continue;
            }
        }
        if gateway.mode == Mode::Desktop
            && status == 401
            && provider.is_account()
            && recoverable(status, &detail)
        {
            let worker = gateway.worker.clone();
            let context = gateway.context();
            let payload = json!({"client":"claude","alias":alias});
            if worker.call("auth-required", payload, context).await.is_ok() {
                if let Some(show) = &gateway.reauth {
                    show("claude", &alias);
                }
            }
        }
        let cause = attempts
            .iter()
            .rev()
            .find(|item| item["skipped"] != true)
            .unwrap_or_else(|| attempts.last().unwrap());
        let actual = cause["status"].as_u64().unwrap_or(502) as u16;
        let client_status = if desktop && matches!(actual, 401 | 402) {
            502
        } else {
            actual
        };
        let tried = attempts
            .iter()
            .map(|item| {
                let state = if item["skipped"] == true {
                    "skipped".to_owned()
                } else {
                    format!("HTTP {}", item["status"])
                };
                let message = item["message"]
                    .as_str()
                    .filter(|message| !message.is_empty())
                    .map(|message| format!(": {message}"))
                    .unwrap_or_default();
                format!(
                    "{} ({state}{message})",
                    item["provider"].as_str().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join(" → ");
        let mut result = json_response(
            client_status,
            json!({"type":"error","error":{"type":"api_error","message":
            format!("fluid could not complete the request for model {model}. Tried: {tried}"),"code":"upstreams_unavailable","model":model,"attempts":attempts}}),
        );
        if let Some(value) = answer.headers.get("retry-after") {
            result.headers_mut().insert("retry-after", value.clone());
        }
        return Ok(result);
    }
    Ok(error(502, "No available Claude provider.", true))
}
