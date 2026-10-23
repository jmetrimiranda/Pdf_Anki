//! Audio/TTS tags and play buttons (port of `pylib/anki/sound.py` + `qt/aqt/sound.py`).
use std::sync::LazyLock;

use anki_proto::card_rendering::av_tag::Value;
use regex::{Captures, Regex};

use super::types::AvTag;

/// `AV_REF_RE` of `pylib/anki/sound.py:69`.
static AV_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[anki:(play:(.):(\d+))\]").expect("valid regex"));

/// `av_refs_to_play_icons` (`qt/aqt/sound.py:906-921`), byte for byte: `reviewer.css` and user templates style
/// `.replay-button`, `.soundLink` and `.playImage`.
pub fn av_refs_to_play_icons(text: &str) -> String {
    AV_REF
        .replace_all(text, |c: &Captures| {
            format!(
                "\n<a class=\"replay-button soundLink\" href=# onclick=\"pycmd('{}'); return false;\" draggable=\"false\">\n    <svg class=\"playImage\" viewBox=\"0 0 64 64\" version=\"1.1\">\n        <circle cx=\"32\" cy=\"32\" r=\"29\" />\n        <path d=\"M56.502,32.301l-37.502,20.101l0.329,-40.804l37.173,20.703Z\" />\n    </svg>\n</a>",
                &c[1]
            )
        })
        .into_owned()
}

/// `strip_av_refs` (`pylib/anki/sound.py:72`), used when the play buttons are hidden.
pub fn strip_av_refs(text: &str) -> String {
    AV_REF.replace_all(text, "").into_owned()
}

/// Proto tags → ours. Sound files keep only their base name (`template.py:93-96`); an unsafe name becomes an
/// empty file name (kept, so the `[anki:play:…:N]` indices still line up) that the host never plays.
pub fn convert_tags(tags: Vec<anki_proto::card_rendering::AvTag>) -> Vec<AvTag> {
    tags.into_iter()
        .filter_map(|t| t.value)
        .map(|v| match v {
            Value::SoundOrVideo(name) => AvTag::Sound {
                file: safe_basename(&name),
            },
            Value::Tts(tts) => AvTag::Tts {
                text: tts.field_text,
                lang: tts.lang,
                voices: tts.voices,
                speed: if tts.speed.is_finite() && tts.speed > 0.0 {
                    tts.speed
                } else {
                    1.0
                },
            },
        })
        .collect()
}

/// `os.path.basename`, also splitting on `\` (Windows names), rejecting `.`/`..`/empty names and control chars.
pub fn safe_basename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if base.is_empty() || base == "." || base == ".." || base.chars().any(char::is_control) {
        return String::new();
    }
    base.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basenames() {
        assert_eq!(safe_basename("a/b/c.mp3"), "c.mp3");
        assert_eq!(safe_basename("..\\x.wav"), "x.wav");
        assert_eq!(safe_basename(".."), "");
        assert_eq!(safe_basename("a/.."), "");
        assert_eq!(safe_basename("dir/"), "");
        assert_eq!(safe_basename("som legal.mp3"), "som legal.mp3");
    }

    #[test]
    fn play_icons_and_strip() {
        let html = av_refs_to_play_icons("x[anki:play:q:0]y");
        assert!(html.starts_with(
            "x\n<a class=\"replay-button soundLink\" href=# onclick=\"pycmd('play:q:0');"
        ));
        assert!(html.ends_with("</a>y"));
        assert_eq!(strip_av_refs("x[anki:play:a:12]y"), "xy");
    }
}
