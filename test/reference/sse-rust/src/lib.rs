// The host copies at most 64 KiB of startup bytes into this memory. It calls
// the exports synchronously, so no two streams borrow the scratch space at once.
const LIMIT: usize = 64 * 1024;
static mut CHUNK: [u8; LIMIT] = [0; LIMIT];
static mut RECORD: [u8; LIMIT] = [0; LIMIT];
static mut DATA: [u8; LIMIT] = [0; LIMIT];

#[no_mangle]
pub extern "C" fn chunk_buffer() -> *mut u8 {
    core::ptr::addr_of_mut!(CHUNK).cast()
}

#[no_mangle]
pub extern "C" fn record_buffer() -> *mut u8 {
    core::ptr::addr_of_mut!(RECORD).cast()
}

#[no_mangle]
pub extern "C" fn data_buffer() -> *mut u8 {
    core::ptr::addr_of_mut!(DATA).cast()
}

fn record_end(bytes: &[u8], start: usize, mut suffix: u8) -> i32 {
    for (index, byte) in bytes.iter().enumerate().skip(start) {
        suffix = match (*byte, suffix) {
            (b'\n', 1 | 2) => return (index + 1) as i32,
            (b'\n', _) => 1,
            (b'\r', 1) => 2,
            _ => 0,
        };
    }
    // Keep the delimiter prefix when a line break spans two network chunks.
    -1 - i32::from(suffix)
}

#[no_mangle]
pub extern "C" fn scan(length: usize, start: usize, suffix: u8) -> i32 {
    let length = length.min(LIMIT);
    let bytes = unsafe { core::slice::from_raw_parts(chunk_buffer(), length) };
    record_end(bytes, start, suffix)
}

fn data_lines(bytes: &[u8], output: &mut [u8], first: bool) -> (usize, bool) {
    let mut read = if first && bytes.starts_with(b"\xef\xbb\xbf") { 3 } else { 0 };
    let mut written = 0;
    let mut has_event = false;
    let mut has_data = false;
    while read < bytes.len() {
        let next = bytes[read..].iter().position(|&byte| byte == b'\n').map(|offset| read + offset);
        let mut end = next.unwrap_or(bytes.len());
        if next.is_some() && end > read && bytes[end - 1] == b'\r' {
            end -= 1;
        }
        let line = &bytes[read..end];
        if line.starts_with(b"data:") {
            let data = read + if line.get(5) == Some(&b' ') { 6 } else { 5 };
            if has_data {
                output[written] = b'\n';
                written += 1;
            }
            output[written..written + end - data].copy_from_slice(&bytes[data..end]);
            written += end - data;
            has_data = true;
        } else if line.starts_with(b"event:") {
            has_event = true;
        }
        read = next.map_or(bytes.len(), |index| index + 1);
    }
    (written, has_event)
}

#[no_mangle]
pub extern "C" fn extract_data(length: usize, first: bool) -> i32 {
    let length = length.min(LIMIT);
    let record = unsafe { core::slice::from_raw_parts(record_buffer(), length) };
    let output = unsafe { core::slice::from_raw_parts_mut(data_buffer(), length) };
    let (written, has_event) = data_lines(record, output, first);
    if written == 0 && has_event { -1 } else { written as i32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_boundaries_across_crlf_and_lf_chunks() {
        assert_eq!(record_end(b"event: ping\r\n\r", 0, 0), -3);
        assert_eq!(record_end(b"\nevent: error\n\n", 0, 2), 1);
        assert_eq!(record_end(b"\nevent: error\n\n", 1, 0), 15);
        assert_eq!(record_end(b"\n", 0, 1), 1);
        assert_eq!(record_end(b"\n\r\r\n", 0, 0), -2);
    }

    #[test]
    fn joins_only_data_lines_and_preserves_empty_lines_and_spaces() {
        let record = b"\xef\xbb\xbfdata:\r\n: comment\r\nevent: error\ndata:  {\ndata: }";
        let mut output = [0; 64];
        let (length, has_event) = data_lines(record, &mut output, true);
        assert!(has_event);
        assert_eq!(&output[..length], b"\n {\n}");
    }
}
