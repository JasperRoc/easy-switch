use crate::gateway::Gateway;
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub struct PageImage {
    pub status: u16,
    pub message: String,
    pub headers: HeaderMap,
    pub body: Option<Body>,
    pub submitted: bool,
}

#[derive(Clone)]
struct ResultEntry {
    key: String,
    response: Value,
    valid_until: Instant,
}
static RESULTS: OnceLock<Mutex<VecDeque<ResultEntry>>> = OnceLock::new();
static SINGLE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

pub async fn generate(
    gateway: &Gateway,
    home: &Path,
    route: &str,
    raw: &[u8],
    mime: &str,
    turn: &str,
) -> Option<PageImage> {
    let results = RESULTS.get_or_init(Mutex::default);
    let key = if turn.is_empty() || turn.len() > 200 {
        None
    } else {
        let mut hash = Sha256::new();
        hash.update(home.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update(turn.as_bytes());
        hash.update(route.as_bytes());
        hash.update(raw);
        Some(format!("{:x}", hash.finalize()))
    };
    if let Some(key) = key.as_deref() {
        let mut cache = results.lock().unwrap();
        cache.retain(|entry| entry.valid_until > Instant::now());
        if let Some(entry) = cache.iter().find(|entry| entry.key == key) {
            return decode(&entry.response);
        }
    }
    let permit = match SINGLE.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            return decode(
                &json!({"status": 409, "submitted": false, "body": {"error": {"message": "An account image request is already running."}}}),
            )
        }
    };
    let request = json!({"accountHome": home, "route": route, "contentType": mime, "raw": STANDARD.encode(raw)});
    // Keep a submitted generation alive across local client disconnects. A
    // repeat request can reuse its result without creating a second image.
    let paths = gateway.paths.clone();
    let future = async move {
        let _permit = permit;
        let value = paths.once("account-image", request).await.ok()?;
        if let Some(key) = key.filter(|_| !matches!(value["status"].as_u64(), Some(401 | 409))) {
            let mut cache = results.lock().unwrap();
            let valid_until =
                Instant::now() + Duration::from_secs(if value["status"] == 200 { 600 } else { 60 });
            cache.push_back(ResultEntry {
                key,
                response: value.clone(),
                valid_until,
            });
            while cache.len() > 2 {
                cache.pop_front();
            }
        }
        Some(value)
    };
    let result = tokio::spawn(future).await.ok()??;
    decode(&result)
}
fn decode(value: &Value) -> Option<PageImage> {
    let status = value["status"].as_u64()? as u16;
    let body = value.get("body")?;
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    let success = (200..300).contains(&status);
    Some(PageImage {
        status,
        submitted: value["submitted"].as_bool().unwrap_or(false),
        headers,
        message: if success {
            String::new()
        } else {
            body.to_string()
        },
        body: success.then(|| Body::from(body.to_string())),
    })
}
