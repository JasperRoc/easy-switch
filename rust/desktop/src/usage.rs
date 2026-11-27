use axum::body::Body;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::mpsc::{self, SyncSender},
    time::Instant,
};

const MAX_FRAME: usize = 64 * 1024;
const MAX_DAILY_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct Ledger(SyncSender<Entry>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    schema: u8,
    at: u64,
    client: String,
    provider: String,
    model: String,
    account: bool,
    image: bool,
    status: u16,
    outcome: &'static str,
    duration_ms: u64,
    first_token_ms: Option<u64>,
    input: Option<u64>,
    output: Option<u64>,
    cached: Option<u64>,
    cache_write: Option<u64>,
    cache_write_long: Option<u64>,
}
impl Ledger {
    pub fn new(root: PathBuf) -> Self {
        let (tx, rx) = mpsc::sync_channel::<Entry>(256);
        std::thread::spawn(move || {
            let directory = root.join("usage");
            let mut day = String::new();
            for entry in rx {
                let date = chrono::DateTime::from_timestamp_millis(entry.at as i64)
                    .unwrap_or_default()
                    .format("%Y-%m-%d")
                    .to_string();
                let result = (|| -> anyhow::Result<()> {
                    fs::create_dir_all(&directory)?;
                    if date != day {
                        let cutoff = (chrono::Utc::now() - chrono::Duration::days(30))
                            .format("%Y-%m-%d")
                            .to_string();
                        for file in fs::read_dir(&directory)?.flatten() {
                            let name = file.file_name().to_string_lossy().into_owned();
                            if name.is_ascii()
                                && name.len() == 16
                                && name.ends_with(".jsonl")
                                && name[..10] < cutoff[..]
                            {
                                let _ = fs::remove_file(file.path());
                            }
                        }
                        day = date.clone();
                    }
                    let file = directory.join(format!("{date}.jsonl"));
                    if fs::metadata(&file).is_ok_and(|m| m.len() >= MAX_DAILY_BYTES) {
                        return Ok(());
                    }
                    let mut options = OpenOptions::new();
                    options.append(true).create(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    let mut file = options.open(file)?;
                    let mut data = serde_json::to_vec(&entry)?;
                    data.push(b'\n');
                    file.write_all(&data)?;
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("fluid usage recording: {error}");
                }
            }
        });
        Self(tx)
    }
    pub fn begin(
        &self,
        claude: bool,
        provider: &str,
        model: &str,
        account: bool,
        sse: bool,
    ) -> Meter {
        Meter {
            ledger: self.clone(),
            started: Instant::now(),
            entry: Entry {
                schema: 2,
                at: crate::store::epoch_ms(),
                client: if claude { "claude" } else { "codex" }.into(),
                provider: provider.into(),
                model: model.chars().take(200).collect(),
                account,
                image: !claude && !sse,
                status: 502,
                outcome: "failed",
                duration_ms: 0,
                first_token_ms: None,
                input: None,
                output: None,
                cached: None,
                cache_write: None,
                cache_write_long: None,
            },
            sse,
            line: Vec::new(),
            line_data: false,
            event: String::new(),
            data: Projection::default(),
            completed: false,
            ended: false,
            failed: false,
        }
    }
}

pub struct Meter {
    ledger: Ledger,
    started: Instant,
    entry: Entry,
    sse: bool,
    line: Vec<u8>,
    line_data: bool,
    event: String,
    data: Projection,
    completed: bool,
    ended: bool,
    failed: bool,
}
// Project metadata without retaining output arrays or large text/encrypted strings.
// State is incremental across transport chunks; retained JSON stays bounded.
#[derive(Default)]
struct Projection {
    bytes: Vec<u8>,
    text: Vec<u8>,
    in_string: bool,
    escaped: bool,
    long_string: bool,
    arrays: usize,
    overflow: bool,
}
impl Projection {
    fn push(&mut self, bytes: &[u8]) {
        if self.bytes.len() + bytes.len() <= MAX_FRAME {
            self.bytes.extend_from_slice(bytes);
        } else {
            self.overflow = true;
            self.bytes.clear();
        }
    }
    fn feed(&mut self, byte: u8) {
        if self.overflow {
            return;
        }
        if self.in_string {
            if !self.escaped && byte == b'"' {
                self.in_string = false;
                if self.arrays == 0 {
                    if self.long_string {
                        self.push(b"\"\"");
                    } else {
                        let mut text = std::mem::take(&mut self.text);
                        text.push(b'"');
                        self.push(&text);
                    }
                }
                self.text.clear();
            } else {
                if self.arrays == 0 && !self.long_string {
                    if self.text.len() < 512 {
                        self.text.push(byte);
                    } else {
                        self.long_string = true;
                        self.text.clear();
                    }
                }
                self.escaped = !self.escaped && byte == b'\\';
            }
        } else if byte == b'"' {
            self.in_string = true;
            self.escaped = false;
            self.long_string = false;
            if self.arrays == 0 {
                self.text.push(byte);
            }
        } else if byte == b'[' {
            if self.arrays == 0 {
                self.push(b"[]");
            }
            self.arrays = self.arrays.saturating_add(1);
        } else if byte == b']' && self.arrays > 0 {
            self.arrays -= 1;
        } else if self.arrays == 0 {
            self.push(&[byte]);
        }
    }
}
fn number(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}
impl Meter {
    pub fn failed(&mut self) {
        self.failed = true;
    }
    pub fn status(&mut self, status: u16) {
        self.entry.status = status;
    }
    fn value(&mut self, value: Value) {
        let message = value
            .get("response")
            .or_else(|| value.get("message"))
            .unwrap_or(&value);
        let kind = value["type"].as_str().unwrap_or(&self.event);
        if message.get("error").is_some_and(|v| !v.is_null())
            || matches!(kind, "error" | "response.failed")
        {
            self.failed = true;
        }
        if matches!(
            kind,
            "response.completed" | "response.incomplete" | "message_stop"
        ) {
            self.completed = true;
        }
        let token = matches!(
            kind,
            "response.output_text.delta"
                | "response.reasoning_summary_text.delta"
                | "response.function_call_arguments.delta"
                | "content_block_delta"
        );
        if token && self.entry.first_token_ms.is_none() {
            self.entry.first_token_ms = Some(self.started.elapsed().as_millis() as u64);
        }
        if let Some(model) = message["model"].as_str() {
            self.entry.model = model.chars().take(200).collect();
        }
        let Some(usage) = message
            .get("usage")
            .or_else(|| value.get("usage"))
            .filter(|v| v.is_object())
        else {
            return;
        };
        let get = |key: &str| number(&usage[key]);
        let cached = [
            get("cache_read_input_tokens"),
            number(&usage["input_tokens_details"]["cached_tokens"]),
            number(&usage["prompt_tokens_details"]["cached_tokens"]),
            get("prompt_cache_hit_tokens"),
        ]
        .into_iter()
        .flatten()
        .max();
        if let Some(value) = cached {
            self.entry.cached = Some(value);
        }
        if let Some(value) = get("cache_creation_input_tokens")
            .or_else(|| number(&usage["input_tokens_details"]["cache_write_tokens"]))
        {
            self.entry.cache_write = Some(value);
        }
        if let Some(value) =
            number(&usage["cache_creation"]["ephemeral_1h_input_tokens"]).or_else(|| {
                number(
                    &usage["input_tokens_details"]["cache_write_tokens_details"]["ttl_12h_tokens"],
                )
            })
        {
            self.entry.cache_write_long = Some(value);
        }
        if let Some(value) = get("input_tokens").or_else(|| get("prompt_tokens")) {
            self.entry.input = Some(value);
        }
        if let Some(value) = get("output_tokens").or_else(|| get("completion_tokens")) {
            self.entry.output = Some(value);
        }
    }
    fn frame(&mut self) {
        if !self.data.overflow {
            if let Ok(value) = serde_json::from_slice(&self.data.bytes) {
                self.value(value);
            }
        }
        self.data = Projection::default();
        self.event.clear();
    }
    fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if !self.sse {
                self.data.feed(byte);
                continue;
            }
            if byte == b'\n' {
                if self.line.last() == Some(&b'\r') {
                    self.line.pop();
                }
                if self.line.is_empty() && !self.line_data {
                    self.frame();
                } else if !self.line_data {
                    if let Some(value) = self.line.strip_prefix(b"event:") {
                        self.event = String::from_utf8_lossy(value).trim().to_owned();
                    }
                }
                if self.line_data {
                    self.data.feed(b'\n');
                }
                self.line.clear();
                self.line_data = false;
            } else if self.line_data {
                self.data.feed(byte);
            } else if self.line.len() < 512 {
                self.line.push(byte);
                if self.line == b"data:" {
                    self.line_data = true;
                    if !self.data.bytes.is_empty() {
                        self.data.feed(b'\n');
                    }
                }
            }
        }
    }
    fn end(&mut self) {
        if !self.line_data {
            if let Some(value) = self.line.strip_prefix(b"event:") {
                self.event = String::from_utf8_lossy(value).trim().to_owned();
            }
        }
        self.frame();
        if !self.sse {
            self.completed = true;
        }
        self.ended = true;
    }
    pub fn wrap(mut self, body: Body, status: u16) -> Body {
        self.status(status);
        Body::from_stream(futures_util::stream::unfold(
            (body.into_data_stream(), self),
            |(mut source, mut meter)| async move {
                match source.next().await {
                    Some(chunk) => {
                        if let Ok(bytes) = &chunk {
                            meter.feed(bytes);
                        } else {
                            meter.failed = true;
                        }
                        Some((chunk, (source, meter)))
                    }
                    None => {
                        meter.end();
                        drop(meter);
                        None
                    }
                }
            },
        ))
    }
}
impl Drop for Meter {
    fn drop(&mut self) {
        self.entry.duration_ms = self.started.elapsed().as_millis() as u64;
        self.entry.outcome =
            if !self.failed && self.completed && (200..300).contains(&self.entry.status) {
                "success"
            } else if !self.failed && !self.ended && (200..300).contains(&self.entry.status) {
                "cancelled"
            } else if self.failed || !(200..300).contains(&self.entry.status) {
                "failed"
            } else {
                "unknown"
            };
        let entry = Entry {
            schema: self.entry.schema,
            at: self.entry.at,
            client: self.entry.client.clone(),
            provider: self.entry.provider.clone(),
            model: self.entry.model.clone(),
            account: self.entry.account,
            image: self.entry.image,
            status: self.entry.status,
            outcome: self.entry.outcome,
            duration_ms: self.entry.duration_ms,
            first_token_ms: self.entry.first_token_ms,
            input: self.entry.input,
            output: self.entry.output,
            cached: self.entry.cached,
            cache_write: self.entry.cache_write,
            cache_write_long: self.entry.cache_write_long,
        };
        let _ = self.ledger.0.try_send(entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn large_completion_preserves_usage_and_forwards_every_byte() {
        let (tx, rx) = mpsc::sync_channel(2);
        let ledger = Ledger(tx);
        let large = "x\\\"\\\\".repeat(MAX_FRAME);
        let value = serde_json::json!({"type":"response.completed","response":{
            "model":"gpt-6.1-sol","output":[{"encrypted_content":large}],
            "usage":{"input_tokens":90000,"output_tokens":2000,"input_tokens_details":{"cached_tokens":80000}}
        }});
        let bytes = format!("event: response.completed\r\ndata: {}\r\n\r\n", value);
        let source = futures_util::stream::iter(
            bytes
                .as_bytes()
                .chunks(37)
                .map(|chunk| Ok::<_, std::io::Error>(axum::body::Bytes::copy_from_slice(chunk)))
                .collect::<Vec<_>>(),
        );
        let body = ledger
            .begin(false, "alias", "model", false, true)
            .wrap(Body::from_stream(source), 200);
        assert_eq!(
            &axum::body::to_bytes(body, 4 * 1024 * 1024).await.unwrap()[..],
            bytes.as_bytes()
        );
        let entry = rx.recv().unwrap();
        assert_eq!(entry.outcome, "success");
        assert_eq!(entry.input, Some(90000));
        assert_eq!(entry.output, Some(2000));
        assert_eq!(entry.cached, Some(80000));
    }
    #[test]
    fn termination_distinguishes_explicit_success_failure_unknown_and_cancellation() {
        let (tx, rx) = mpsc::sync_channel(8);
        let ledger = Ledger(tx);
        for (bytes, end, outcome) in [
            ("event: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}", true, "success"),
            ("data: {\"type\":\"response.completed\"}\n\n", false, "success"),
            ("event: error\ndata: {\"error\":{\"message\":\"rejected\"}}\n\n", true, "failed"),
            ("data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n", true, "unknown"),
            ("data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n", false, "cancelled"),
        ] {
            let mut meter = ledger.begin(false, "alias", "model", false, true);
            meter.status(200); meter.feed(bytes.as_bytes());
            if end { meter.end(); }
            assert!(meter.data.bytes.len() <= MAX_FRAME);
            drop(meter); assert_eq!(rx.recv().unwrap().outcome, outcome);
        }
    }
    #[tokio::test]
    async fn streams_are_unchanged_and_claude_delta_merges_start_usage() {
        let (tx, rx) = mpsc::sync_channel(2);
        let ledger = Ledger(tx);
        let bytes = b"data: {\"type\":\"message_start\",\"message\":{\"model\":\"deepseek\",\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":90,\"cache_creation_input_tokens\":40,\"cache_creation\":{\"ephemeral_1h_input_tokens\":30}}}}\r\n\r\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":20}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
        let source = futures_util::stream::iter(
            bytes
                .chunks(7)
                .map(|c| Ok::<_, std::io::Error>(axum::body::Bytes::copy_from_slice(c)))
                .collect::<Vec<_>>(),
        );
        let body = ledger
            .begin(true, "alias", "model", false, true)
            .wrap(Body::from_stream(source), 200);
        assert_eq!(&axum::body::to_bytes(body, 10000).await.unwrap()[..], bytes);
        let entry = rx.recv().unwrap();
        assert_eq!(entry.input, Some(10));
        assert_eq!(entry.cached, Some(90));
        assert_eq!(entry.cache_write, Some(40));
        assert_eq!(entry.cache_write_long, Some(30));
        assert_eq!(entry.output, Some(20));
        assert_eq!(entry.outcome, "success");
    }
    #[test]
    fn openai_cache_is_not_subtracted_during_capture_and_large_frames_are_bounded() {
        let (tx, rx) = mpsc::sync_channel(2);
        let ledger = Ledger(tx);
        let mut meter = ledger.begin(false, "alias", "model", false, true);
        meter.status(200);
        meter.feed(&vec![b'x'; MAX_FRAME + 20]);
        meter.feed(b"\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":5,\"input_tokens_details\":{\"cached_tokens\":80,\"cache_write_tokens\":10,\"cache_write_tokens_details\":{\"ttl_12h_tokens\":5}}}}}\n\n");
        assert!(meter.line.len() <= 512);
        assert_eq!(meter.entry.input, Some(100));
        assert_eq!(meter.entry.cached, Some(80));
        assert_eq!(meter.entry.cache_write, Some(10));
        assert_eq!(meter.entry.cache_write_long, Some(5));
        drop(meter);
        assert_eq!(rx.recv().unwrap().output, Some(5));
    }
}
