//! The spine step of an EPUB CFI (`epubcfi(/6/N[id]!…)`): N/2 − 1 is the spine itemref position.

/// Maximum accepted CFI length in bytes.
pub const MAX_CFI_LEN: usize = 4096;

/// `epubcfi(` … `)`, at most 4096 bytes, no control characters. Syntax only; the steps are not
/// checked against a book.
pub fn is_valid_cfi(cfi: &str) -> bool {
    cfi.len() <= MAX_CFI_LEN
        && cfi.len() > "epubcfi()".len()
        && cfi.starts_with("epubcfi(")
        && cfi.ends_with(')')
        && !cfi.chars().any(char::is_control)
}

/// Parses one `/<even integer>` step with an optional `[assertion]` (`^` escapes); returns the
/// integer and the rest.
fn step(s: &str) -> Option<(u32, &str)> {
    let s = s.strip_prefix('/')?;
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let n: u32 = s[..digits].parse().ok()?;
    let mut rest = &s[digits..];
    if let Some(after) = rest.strip_prefix('[') {
        let mut escaped = false;
        let mut end = None;
        for (i, c) in after.char_indices() {
            match c {
                _ if escaped => escaped = false,
                '^' => escaped = true,
                ']' => {
                    end = Some(i);
                    break;
                }
                _ => {}
            }
        }
        rest = &after[end? + 1..];
    }
    Some((n, rest))
}

/// The spine position addressed by a CFI: `epubcfi(/6/N[id]!…)` → `N/2 − 1`. The package step
/// (`/6` when the spine is the package's third element) must be even; N must be even and ≥ 2.
/// The second step must end the path, be an indirection (`!`) or start a range (`,`).
/// `None` for anything malformed.
pub fn section_of_cfi(cfi: &str) -> Option<u32> {
    if !is_valid_cfi(cfi) {
        return None;
    }
    let inner = &cfi["epubcfi(".len()..cfi.len() - 1];
    let (spine, rest) = step(inner)?;
    let (n, rest) = step(rest)?;
    if spine == 0 || spine % 2 != 0 || n < 2 || n % 2 != 0 {
        return None;
    }
    if !(rest.is_empty() || rest.starts_with('!') || rest.starts_with(',')) {
        return None;
    }
    Some(n / 2 - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spine_steps() {
        let cases: &[(&str, Option<u32>)] = &[
            ("epubcfi(/6/2!/4/2/1:0)", Some(0)),
            (
                "epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/3:10)",
                Some(1),
            ),
            (
                "epubcfi(/6/14[xchapter_001]!/4/2/2/2[c001s0000]/1:0)",
                Some(6),
            ),
            ("epubcfi(/6/8[a^]b]!/4/2)", Some(3)),
            ("epubcfi(/6/10!/4,/2/1:0,/3/1:5)", Some(4)),
            ("epubcfi(/6/12)", Some(5)),
            ("epubcfi(/8/2!/2)", Some(0)),
            ("epubcfi(/6/3!/4)", None),
            ("epubcfi(/6/0!/4)", None),
            ("epubcfi(/5/2!/4)", None),
            ("epubcfi(/6/2/4!/4)", None),
            ("epubcfi(/6)", None),
            ("epubcfi()", None),
            ("epubcfi(/6/4[unterminated!/2)", None),
            ("/6/4!/2", None),
            ("epubcfi(/6/4!/2", None),
            ("garbage", None),
            ("epubcfi(/6/99999999999!/2)", None),
            ("epubcfi(/6/4!/2\u{0})", None),
        ];
        for (cfi, want) in cases {
            assert_eq!(section_of_cfi(cfi), *want, "{cfi}");
        }
        let long = format!("epubcfi(/6/4!{})", "/2".repeat(3000));
        assert!(!is_valid_cfi(&long));
        assert_eq!(section_of_cfi(&long), None);
    }
}
