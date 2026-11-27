use axum::body::{Body, Bytes};
use futures_util::{stream, Stream, StreamExt};
use serde_json::Value;
use std::{collections::VecDeque, io};

const MAX_PREAMBLE: usize = 64 * 1024;

#[derive(Default)]
struct Preamble {
    bytes: usize,
    record: Vec<u8>,
    suffix: u8,
    first: bool,
}
enum Decision {
    More,
    Accept,
    Reject(Value, bool),
}

impl Preamble {
    fn inspect(&mut self, bytes: &[u8], claude: bool) -> Decision {
        for &byte in bytes.iter().take(MAX_PREAMBLE - self.bytes) {
            self.bytes += 1;
            self.record.push(byte);
            self.suffix = match (byte, self.suffix) {
                (b'\n', 1 | 2) => {
                    let decision = frame(&self.record, !self.first, claude);
                    self.first = true;
                    self.record.clear();
                    match decision {
                        Decision::More => 0,
                        decision => return decision,
                    }
                }
                (b'\n', _) => 1,
                (b'\r', 1) => 2,
                _ => 0,
            };
        }
        if self.bytes >= MAX_PREAMBLE {
            Decision::Accept
        } else {
            Decision::More
        }
    }
}

fn frame(mut bytes: &[u8], first: bool, claude: bool) -> Decision {
    if first {
        bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    }
    let mut event_type = "";
    let mut data = Vec::new();
    let mut lines = 0;
    for line in bytes.split(|b| *b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(content) = line.strip_prefix(b"data:") {
            if lines > 0 {
                data.push(b'\n');
            }
            data.extend_from_slice(content.strip_prefix(b" ").unwrap_or(content));
            lines += 1;
        } else if let Some(content) = line.strip_prefix(b"event:") {
            event_type = std::str::from_utf8(content).unwrap_or_default().trim();
        }
    }
    if data.is_empty() {
        return if event_type.is_empty() {
            Decision::More
        } else {
            Decision::Accept
        };
    }
    let Ok(event) = serde_json::from_slice::<Value>(&data) else {
        return Decision::Accept;
    };
    if event["response"]["output"]
        .as_array()
        .is_some_and(|items| !items.is_empty())
        || event["message"]["content"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    {
        return Decision::Accept;
    }
    let kind = event["type"].as_str().unwrap_or(event_type);
    if matches!(kind, "error" | "response.failed") {
        let error = event
            .get("error")
            .or_else(|| event["response"].get("error"))
            .cloned()
            .unwrap_or_else(|| event.clone());
        return Decision::Reject(error, super::gateway::capacity(&event.to_string()));
    }
    if if claude {
        matches!(kind, "ping" | "message_start")
    } else {
        matches!(
            kind,
            "response.created" | "response.in_progress" | "response.queued"
        )
    } {
        Decision::More
    } else {
        Decision::Accept
    }
}

pub struct Startup {
    pub body: Body,
    pub error: Option<Value>,
    pub capacity: bool,
}

pub async fn inspect(
    response: reqwest::Response,
    claude: bool,
    guess: bool,
) -> Result<Option<Startup>, io::Error> {
    let mut source = Box::pin(response.bytes_stream());
    let mut held = VecDeque::new();
    let mut parser = Preamble::default();
    let mut error = None;
    let mut capacity = false;
    let mut prefix = Vec::new();
    let mut identified = !guess;
    while let Some(chunk) = source.next().await {
        let chunk = chunk.map_err(io::Error::other)?;
        let decision = parser.inspect(&chunk, claude);
        if !identified {
            prefix.extend_from_slice(&chunk[..chunk.len().min(16384 - prefix.len())]);
            let first = String::from_utf8_lossy(&prefix);
            let first = first.trim_start_matches('\u{feff}').trim_start();
            let fields = ["data:", "event:", "id:", "retry:", ":"];
            identified = fields.iter().any(|field| first.starts_with(field));
            if !identified
                && (prefix.len() >= 16384 || !fields.iter().any(|field| field.starts_with(first)))
            {
                return Ok(None);
            }
        }
        held.push_back(chunk);
        match decision {
            Decision::More => {}
            Decision::Accept if identified => break,
            Decision::Accept => return Ok(None),
            Decision::Reject(value, overloaded) => {
                error = Some(value);
                capacity = overloaded;
                break;
            }
        }
    }
    if !identified {
        return Ok(None);
    }
    let body = body_from(
        stream::iter(held.into_iter().map(Ok::<_, io::Error>))
            .chain(source.map(|result| result.map_err(io::Error::other))),
    );
    Ok(Some(Startup {
        body,
        error,
        capacity,
    }))
}
pub fn body_from(stream: impl Stream<Item = Result<Bytes, io::Error>> + Send + 'static) -> Body {
    Body::from_stream(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_rejection_is_only_detected_before_output() {
        let mut parser = Preamble::default();
        assert!(matches!(
            parser.inspect(b"data: {\"type\":\"response.created\"}\r\n\r", false),
            Decision::More
        ));
        assert!(matches!(
            parser.inspect(
                b"\nevent: error\ndata: {\"code\":\"model_at_capacity\"}\n\n",
                false
            ),
            Decision::Reject(_, true)
        ));
        let mut parser = Preamble::default();
        assert!(matches!(parser.inspect(b"data: {\"type\":\"response.output_item.added\"}\n\ndata: {\"type\":\"response.failed\"}\n\n", false), Decision::Accept));
    }
}
