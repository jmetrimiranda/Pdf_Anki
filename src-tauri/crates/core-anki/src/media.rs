//! Images pasted or dropped into the note editor (docs/PROJETO.md 8.2 Adicionar/Editar).

use anki::collection::Collection;

use crate::error::{Error, Result};

/// Largest file the editor may add to the media folder.
pub const MAX_MEDIA_BYTES: usize = 50 * 1024 * 1024;

/// Extensions the editor accepts (lowercase).
pub const ALLOWED_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"];

const DEFAULT_NAME: &str = "imagem.png";

/// Adds an image to the collection's media folder and returns the final file name to put in
/// `<img src="…">`. Anki keeps the name when the same bytes are already there and appends a hash
/// when a different file has that name.
pub fn add(col: &mut Collection, name: &str, bytes: &[u8]) -> Result<String> {
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(Error::TooLarge);
    }
    let name = sanitize_name(name);
    let ext = extension(&name).unwrap_or_default();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(Error::InvalidInput(format!(
            "só imagens podem ser coladas no editor (PNG, JPG, GIF, WebP, AVIF ou SVG), não “.{ext}”."
        )));
    }
    let media = col.media()?;
    let added = media.add_file(&name, bytes)?;
    Ok(added.into_owned())
}

/// Basename only, without control characters or path separators; `imagem.png` when nothing is
/// left.
pub fn sanitize_name(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    let base = base.trim().trim_start_matches('.').trim();
    if base.is_empty() {
        return DEFAULT_NAME.into();
    }
    base.to_string()
}

fn extension(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty() && !ext.is_empty()).then(|| ext.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_name("../x.png"), "x.png");
        assert_eq!(sanitize_name("..\\..\\a b.JPG"), "a b.JPG");
        assert_eq!(sanitize_name("a\u{0}\nb.png"), "ab.png");
        assert_eq!(sanitize_name(""), DEFAULT_NAME);
        assert_eq!(sanitize_name("dir/"), DEFAULT_NAME);
        assert_eq!(sanitize_name("..."), DEFAULT_NAME);
        assert_eq!(sanitize_name(".hidden.png"), "hidden.png");
    }
}
