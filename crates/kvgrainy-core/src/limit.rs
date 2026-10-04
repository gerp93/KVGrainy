/// Parse a size like `500kb`, `1.5mb`, `2048` or `12b` into bytes.
pub fn parse_size_limit(text: &str) -> Result<u64, String> {
    let value = text.trim().to_lowercase();
    if value.is_empty() {
        return Err("size limit cannot be empty".into());
    }
    let (number, multiplier) = if let Some(n) = value.strip_suffix("mb") {
        (n, 1024.0 * 1024.0)
    } else if let Some(n) = value.strip_suffix("kb") {
        (n, 1024.0)
    } else if let Some(n) = value.strip_suffix('b') {
        (n, 1.0)
    } else {
        (value.as_str(), 1.0)
    };
    let parsed: f64 = number
        .trim()
        .parse()
        .map_err(|_| format!("invalid size limit '{text}'"))?;
    let bytes = (parsed * multiplier) as u64;
    if !parsed.is_finite() || bytes == 0 {
        return Err("size limit must be greater than zero".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_units() {
        assert_eq!(parse_size_limit("500kb"), Ok(500 * 1024));
        assert_eq!(parse_size_limit("1.5mb"), Ok(1_572_864));
        assert_eq!(parse_size_limit("2048"), Ok(2048));
        assert_eq!(parse_size_limit(" 12 B "), Ok(12));
    }

    #[test]
    fn rejects_bad_input() {
        for bad in ["", "abc", "-10kb", "0", "kb"] {
            assert!(parse_size_limit(bad).is_err(), "{bad}");
        }
    }
}
