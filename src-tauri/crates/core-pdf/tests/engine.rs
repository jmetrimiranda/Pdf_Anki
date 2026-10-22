//! End-to-end tests of `PdfcraftEngine` on real files: the spike's sample plus PDFs built here.

use std::sync::Arc;

use core_pdf::{
    DocHandle, DocumentEngine, PdfError, PdfcraftEngine, ReadingTheme, Rect, RenderReq, SearchOpts,
};

const SAMPLE: &[u8] = include_bytes!("fixtures/sample.pdf");

fn engine() -> PdfcraftEngine {
    PdfcraftEngine::with_render_threads(2)
}

fn open(engine: &PdfcraftEngine, bytes: &[u8]) -> DocHandle {
    match engine.open(Arc::new(bytes.to_vec()), None) {
        Ok(h) => h,
        Err(e) => panic!("open failed: {e:?}"),
    }
}

// ---------------------------------------------------------------- fixture builder

struct PageSpec {
    media: [f32; 4],
    rotate: i32,
    crop: Option<[f32; 4]>,
    content: String,
}

impl PageSpec {
    fn text(x: f32, y: f32, s: &str) -> Self {
        Self {
            media: [0.0, 0.0, 300.0, 200.0],
            rotate: 0,
            crop: None,
            content: format!("BT /F1 18 Tf {x} {y} Td ({s}) Tj ET"),
        }
    }
}

/// A bookmark: title, target page, children.
struct Mark(&'static str, usize, Vec<Mark>);

/// UTF-16BE text string, so titles can hold any character.
fn pdf_text(s: &str) -> String {
    let mut hex = String::from("<FEFF");
    for u in s.encode_utf16() {
        hex.push_str(&format!("{u:04X}"));
    }
    hex.push('>');
    hex
}

/// A minimal, valid PDF (classic xref) with Helvetica text pages and an optional outline.
fn build_pdf(pages: &[PageSpec], outline: &[Mark]) -> Vec<u8> {
    // 1 catalog, 2 page tree, 3 font, then (page, content) pairs, then the outline.
    let page_obj = |i: usize| 4 + 2 * i;
    let mut objs: Vec<String> = Vec::new();
    let outline_root = 4 + 2 * pages.len();
    let catalog = if outline.is_empty() {
        "<< /Type /Catalog /Pages 2 0 R >>".to_string()
    } else {
        format!("<< /Type /Catalog /Pages 2 0 R /Outlines {outline_root} 0 R >>")
    };
    objs.push(catalog);
    let kids: Vec<String> = (0..pages.len())
        .map(|i| format!("{} 0 R", page_obj(i)))
        .collect();
    objs.push(format!(
        "<< /Type /Pages /Kids [{}] /Count {} >>",
        kids.join(" "),
        pages.len()
    ));
    objs.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into(),
    );
    for (i, p) in pages.iter().enumerate() {
        let [a, b, c, d] = p.media;
        let crop = p
            .crop
            .map(|[a, b, c, d]| format!(" /CropBox [{a} {b} {c} {d}]"))
            .unwrap_or_default();
        objs.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [{a} {b} {c} {d}]{crop} /Rotate {} /Contents {} 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
            p.rotate,
            page_obj(i) + 1
        ));
        objs.push(format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            p.content.len(),
            p.content
        ));
    }
    if !outline.is_empty() {
        // Number every mark depth-first, after the outline root.
        fn count(marks: &[Mark]) -> usize {
            marks.iter().map(|m| 1 + count(&m.2)).sum()
        }
        fn emit(
            marks: &[Mark],
            parent: usize,
            next: &mut usize,
            out: &mut Vec<(usize, String)>,
            page_obj: &dyn Fn(usize) -> usize,
        ) -> Vec<usize> {
            let ids: Vec<usize> = marks
                .iter()
                .map(|m| {
                    let id = *next;
                    *next += 1 + count(&m.2);
                    id
                })
                .collect();
            for (k, m) in marks.iter().enumerate() {
                let mut d = format!(
                    "<< /Title {} /Parent {parent} 0 R /Dest [{} 0 R /Fit]",
                    pdf_text(m.0),
                    page_obj(m.1)
                );
                if k > 0 {
                    d.push_str(&format!(" /Prev {} 0 R", ids[k - 1]));
                }
                if k + 1 < ids.len() {
                    d.push_str(&format!(" /Next {} 0 R", ids[k + 1]));
                }
                let mut child_next = ids[k] + 1;
                let children = emit(&m.2, ids[k], &mut child_next, out, page_obj);
                if let (Some(f), Some(l)) = (children.first(), children.last()) {
                    d.push_str(&format!(
                        " /First {f} 0 R /Last {l} 0 R /Count {}",
                        children.len()
                    ));
                }
                d.push_str(" >>");
                out.push((ids[k], d));
            }
            ids
        }
        let mut items = Vec::new();
        let mut next = outline_root + 1;
        let top = emit(outline, outline_root, &mut next, &mut items, &page_obj);
        objs.push(format!(
            "<< /Type /Outlines /First {} 0 R /Last {} 0 R /Count {} >>",
            top[0],
            top[top.len() - 1],
            count(outline)
        ));
        items.sort_by_key(|(id, _)| *id);
        objs.extend(items.into_iter().map(|(_, d)| d));
    }

    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objs.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).as_bytes());
    for o in offsets {
        out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objs.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// Three pages: plain, `/Rotate 90`, and an offset `/CropBox`; with a two-level outline.
fn book() -> Vec<u8> {
    let plain = PageSpec::text(20.0, 100.0, "Hello world from page one");
    let rotated = PageSpec {
        rotate: 90,
        ..PageSpec::text(20.0, 100.0, "Rotated words here")
    };
    let cropped = PageSpec {
        crop: Some([50.0, 50.0, 250.0, 150.0]),
        ..PageSpec::text(60.0, 100.0, "Cropped text")
    };
    build_pdf(
        &[plain, rotated, cropped],
        &[
            Mark("Capítulo 1", 0, vec![Mark("Seção 1.1", 1, vec![])]),
            Mark("Capítulo 2", 2, vec![]),
        ],
    )
}

fn protected(user: &str, owner: &str) -> Vec<u8> {
    let plain = build_pdf(&[PageSpec::text(20.0, 100.0, "Secret page")], &[]);
    let mut doc = pdfcraft_cos::Document::open(Arc::new(plain)).expect("fixture parses");
    doc.set_encryption(&pdfcraft_cos::NewEncryption {
        algorithm: pdfcraft_cos::Algorithm::Aes256,
        user_password: user,
        owner_password: owner,
        permissions: -1,
        encrypt_metadata: true,
        seed: [7; 32],
    })
    .expect("encrypts");
    pdfcraft_cos::write_full(&doc, &Default::default()).expect("writes")
}

fn inside(r: &Rect, width: f32, height: f32) -> bool {
    const EPS: f32 = 0.5;
    r[0] >= -EPS
        && r[1] >= -EPS
        && r[2] > 0.0
        && r[3] > 0.0
        && r[0] + r[2] <= width + EPS
        && r[1] + r[3] <= height + EPS
}

fn rgb_at(r: &core_pdf::Rendered, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * r.width + x) * 4) as usize;
    [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2]]
}

// ---------------------------------------------------------------- sample.pdf

#[test]
fn sample_opens_with_page_size_in_points() {
    let e = engine();
    let h = open(&e, SAMPLE);
    let info = e.info(h).expect("info");
    assert_eq!(info.doc_id, h.to_string());
    assert_eq!(info.page_count, 1);
    assert!(
        (info.pages[0].width - 595.2756).abs() < 0.01
            && (info.pages[0].height - 841.8898).abs() < 0.01,
        "{:?}",
        info.pages[0]
    );
    assert_eq!(info.title.as_deref(), Some("untitled"));
    assert_eq!(info.author.as_deref(), Some("anonymous"));
    assert!(e.outline(h).expect("outline").is_empty());
}

#[test]
fn sample_renders_at_scale_two_and_encodes_png() {
    let e = engine();
    let h = open(&e, SAMPLE);
    let r = e.render(h, RenderReq::page(0, 2.0)).expect("render");
    assert_eq!((r.width, r.height), (1191, 1684));
    assert_eq!(r.rgba.len(), 1191 * 1684 * 4);
    assert_eq!(
        rgb_at(&r, 0, 0),
        [255, 255, 255],
        "light theme keeps a white page"
    );
    assert!(
        r.rgba.chunks_exact(4).any(|p| p[0] < 128),
        "some dark text was drawn"
    );

    let png = e.render_png(h, RenderReq::page(0, 0.5)).expect("png");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let hgt = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    assert_eq!((w, hgt), (298, 421));
}

#[test]
fn page_images_are_cached_until_the_document_closes() {
    let e = engine();
    let h = open(&e, SAMPLE);
    let req = RenderReq::page(0, 0.5);
    let first = e.render_png(h, req).expect("png");
    let cached = e.page_cache_bytes();
    assert_eq!(cached, first.len());
    assert_eq!(e.render_png(h, req).expect("png again"), first);
    assert_eq!(e.page_cache_bytes(), cached, "a hit adds nothing");
    let dark = RenderReq {
        theme: ReadingTheme::Dark,
        ..req
    };
    assert_ne!(e.render_png(h, dark).expect("dark"), first);
    assert!(e.page_cache_bytes() > cached);

    e.close(h);
    assert_eq!(e.page_cache_bytes(), 0);
    assert!(matches!(
        e.render_png(h, req),
        Err(PdfError::UnknownDocument)
    ));

    // A budget of 0 disables the cache.
    let h = open(&e, SAMPLE);
    e.set_page_cache_bytes(0);
    e.render_png(h, req).expect("png");
    assert_eq!(e.page_cache_bytes(), 0);
}

#[test]
fn sample_tile_is_rendered_in_device_pixels() {
    let e = engine();
    let h = open(&e, SAMPLE);
    let req = RenderReq {
        tile: Some([100.0, 100.0, 100.0, 50.0]),
        ..RenderReq::page(0, 2.0)
    };
    let r = e.render(h, req).expect("tile");
    assert_eq!((r.width, r.height), (200, 100));
}

#[test]
fn sample_words_have_rects_and_offsets() {
    let e = engine();
    let h = open(&e, SAMPLE);
    let pw = e.page_words(h, 0).expect("words");
    assert!(!pw.words.is_empty());
    assert!((pw.width - 595.2756).abs() < 0.01);
    // Offsets are UTF-16 code units, like JS `text.slice(start, end)`.
    let units: Vec<u16> = pw.text.encode_utf16().collect();
    for (n, w) in pw.words.iter().enumerate() {
        assert_eq!(w.index, n);
        assert_eq!(String::from_utf16_lossy(&units[w.start..w.end]), w.text);
        assert!(!w.rects.is_empty(), "{w:?}");
        assert!(
            w.rects.iter().all(|r| inside(r, pw.width, pw.height)),
            "{w:?}"
        );
    }
    let summary: Vec<String> = pw
        .words
        .iter()
        .take(12)
        .map(|w| {
            let r = w.rects[0];
            format!(
                "{} {:?} [{:.0} {:.0} {:.0} {:.0}]",
                w.index, w.text, r[0], r[1], r[2], r[3]
            )
        })
        .collect();
    insta::assert_snapshot!("sample_first_words", summary.join("\n"));
}

#[test]
fn sample_search_finds_a_known_word_case_insensitively() {
    let e = engine();
    let h = open(&e, SAMPLE);
    let pw = e.page_words(h, 0).expect("words");
    let word = pw
        .words
        .iter()
        .find(|w| w.text.chars().count() >= 5)
        .expect("a long word")
        .text
        .clone();
    let hits = e
        .search(h, &word.to_uppercase(), SearchOpts::default())
        .expect("search");
    assert!(!hits.is_empty(), "{word}");
    let hit = &hits[0];
    assert_eq!(hit.page, 0);
    assert!(
        hit.context.to_lowercase().contains(&word.to_lowercase()),
        "{hit:?}"
    );
    assert!(hit.rects.iter().all(|r| inside(r, pw.width, pw.height)));
    assert!(
        e.search(h, "zzzz-not-there", SearchOpts::default())
            .expect("search")
            .is_empty()
    );
    assert!(
        e.search(h, "   ", SearchOpts::default())
            .expect("search")
            .is_empty()
    );
}

#[test]
fn themes_change_the_page_colours() {
    let e = engine();
    let h = open(&e, SAMPLE);
    let render = |theme| {
        e.render(
            h,
            RenderReq {
                theme,
                ..RenderReq::page(0, 0.5)
            },
        )
        .expect("render")
    };
    let (light, sepia, dark) = (
        render(ReadingTheme::Light),
        render(ReadingTheme::Sepia),
        render(ReadingTheme::Dark),
    );
    assert_eq!(rgb_at(&light, 0, 0), [0xff, 0xff, 0xff]);
    assert_eq!(rgb_at(&sepia, 0, 0), [0xf4, 0xec, 0xd8]);
    assert_eq!(rgb_at(&dark, 0, 0), [0x1e, 0x1e, 0x1e]);
    assert_ne!(light.rgba, sepia.rgba);
    assert_ne!(sepia.rgba, dark.rgba);
    // Text turns light in the dark theme instead of disappearing.
    assert!(dark.rgba.chunks_exact(4).any(|p| p[0] > 0x80));
}

#[test]
fn concurrent_renders_from_many_threads() {
    let e = Arc::new(engine());
    let h = open(&e, SAMPLE);
    let threads: Vec<_> = (0..12)
        .map(|i| {
            let e = e.clone();
            std::thread::spawn(move || {
                let theme = [ReadingTheme::Light, ReadingTheme::Sepia, ReadingTheme::Dark][i % 3];
                let scale = 0.5 + (i % 4) as f32 * 0.25;
                let r = e.render(
                    h,
                    RenderReq {
                        theme,
                        ..RenderReq::page(0, scale)
                    },
                )?;
                let words = e.page_words(h, 0)?;
                Ok::<_, PdfError>((r.width, words.words.len()))
            })
        })
        .collect();
    for t in threads {
        let (width, words) = t.join().expect("no panic").expect("render ok");
        assert!(width > 0 && words > 0);
    }
}

// ---------------------------------------------------------------- generated fixtures

#[test]
fn rotated_and_cropped_pages_use_view_space() {
    let e = engine();
    let h = open(&e, &book());
    let info = e.info(h).expect("info");
    assert_eq!(info.page_count, 3);
    let sizes: Vec<(f32, f32)> = info.pages.iter().map(|p| (p.width, p.height)).collect();
    assert_eq!(sizes, [(300.0, 200.0), (200.0, 300.0), (200.0, 100.0)]);

    let rotated = e.page_words(h, 1).expect("words");
    assert_eq!((rotated.width, rotated.height), (200.0, 300.0));
    let texts: Vec<&str> = rotated.words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(texts, ["Rotated", "words", "here"]);
    for w in &rotated.words {
        assert!(w.rects.iter().all(|r| inside(r, 200.0, 300.0)), "{w:?}");
        // Turned 90° clockwise, the line runs down the page: taller than wide.
        assert!(w.rects.iter().all(|r| r[3] > r[2]), "{w:?}");
    }

    let cropped = e.page_words(h, 2).expect("words");
    let texts: Vec<&str> = cropped.words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(texts, ["Cropped", "text"]);
    // The text starts at x = 60 in user space, 10 pt right of the crop's left edge.
    let first = cropped.words[0].rects[0];
    assert!((first[0] - 10.0).abs() < 2.0, "{first:?}");
    assert!(
        cropped
            .words
            .iter()
            .all(|w| w.rects.iter().all(|r| inside(r, 200.0, 100.0)))
    );

    let r = e
        .render(h, RenderReq::page(1, 1.0))
        .expect("render rotated");
    assert_eq!((r.width, r.height), (200, 300));
}

#[test]
fn outline_has_zero_based_pages_and_nesting() {
    let e = engine();
    let h = open(&e, &book());
    let outline = e.outline(h).expect("outline");
    let json = serde_json::to_value(&outline).expect("json");
    assert_eq!(
        json,
        serde_json::json!([
            { "title": "Capítulo 1", "page": 0, "children": [{ "title": "Seção 1.1", "page": 1, "children": [] }] },
            { "title": "Capítulo 2", "page": 2, "children": [] },
        ])
    );
}

#[test]
fn search_spans_pages() {
    let e = engine();
    let h = open(&e, &book());
    let hits = e.search(h, "TEXT", SearchOpts::default()).expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].page, 2);
    assert_eq!(hits[0].context, "Cropped text");
    let words = e
        .search(
            h,
            "o",
            SearchOpts {
                limit: 3,
                ..SearchOpts::default()
            },
        )
        .expect("search");
    assert_eq!(words.len(), 3, "limit respected");
    let exact = e
        .search(
            h,
            "rotated",
            SearchOpts {
                case_sensitive: true,
                ..SearchOpts::default()
            },
        )
        .expect("search");
    assert!(exact.is_empty());
}

#[test]
fn passwords() {
    let bytes = Arc::new(protected("leitor", "dono"));
    let e = engine();
    assert_eq!(
        e.open(bytes.clone(), None).err(),
        Some(PdfError::NeedsPassword)
    );
    assert_eq!(
        e.open(bytes.clone(), Some("errada")).err(),
        Some(PdfError::WrongPassword)
    );
    for pw in ["leitor", "dono"] {
        let h = e
            .open(bytes.clone(), Some(pw))
            .unwrap_or_else(|err| panic!("{pw}: {err:?}"));
        let words = e.page_words(h, 0).expect("words");
        assert_eq!(words.text, "Secret page", "{pw}");
        e.render(h, RenderReq::page(0, 1.0)).expect("render");
    }
}

// ---------------------------------------------------------------- errors and robustness

#[test]
fn garbage_and_empty_input_are_errors() {
    let e = engine();
    for bytes in [
        &b""[..],
        b"not a pdf at all",
        b"%PDF-1.7\n%%EOF\n",
        &[0xffu8; 4096][..],
    ] {
        let err = e
            .open(Arc::new(bytes.to_vec()), None)
            .expect_err("must fail");
        assert!(
            matches!(err, PdfError::Invalid(_) | PdfError::Unsupported(_)),
            "{err:?}"
        );
        assert_eq!(err.http_status(), 422);
    }
}

#[test]
fn truncated_files_never_panic() {
    let e = engine();
    assert!(e.open(Arc::new(SAMPLE[..300].to_vec()), None).is_err());
    let book = book();
    for source in [SAMPLE, &book[..]] {
        for cut in (0..source.len()).step_by(29) {
            let Ok(h) = e.open(Arc::new(source[..cut].to_vec()), None) else {
                continue;
            };
            // A recovered file may render or fail per page, but must answer.
            let _ = e.render(h, RenderReq::page(0, 0.25));
            let _ = e.page_words(h, 0);
            let _ = e.search(h, "e", SearchOpts::default());
            e.close(h);
        }
    }
}

#[test]
fn bad_requests_are_typed_errors() {
    let e = engine();
    let h = open(&e, SAMPLE);
    assert_eq!(
        e.page_words(h, 5).err(),
        Some(PdfError::PageOutOfRange { page: 5, count: 1 })
    );
    assert_eq!(
        e.render(h, RenderReq::page(1, 1.0))
            .err()
            .map(|e| e.http_status()),
        Some(404)
    );
    for scale in [0.0, -1.0, f32::NAN, f32::INFINITY, 1000.0] {
        assert!(
            matches!(
                e.render(h, RenderReq::page(0, scale)),
                Err(PdfError::InvalidRequest(_))
            ),
            "{scale}"
        );
    }
    let off_page = RenderReq {
        tile: Some([5000.0, 0.0, 10.0, 10.0]),
        ..RenderReq::page(0, 1.0)
    };
    assert!(matches!(
        e.render(h, off_page),
        Err(PdfError::InvalidRequest(_))
    ));
    // 500 pt at scale 10 is 5000 px: refused rather than silently cropped to 4096.
    let oversized = RenderReq {
        tile: Some([0.0, 0.0, 500.0, 100.0]),
        ..RenderReq::page(0, 10.0)
    };
    assert!(matches!(
        e.render(h, oversized),
        Err(PdfError::InvalidRequest(_))
    ));
    assert_eq!(
        e.export_annotated(h, &[]).err().map(|e| e.code()),
        Some("notImplemented")
    );

    e.close(h);
    assert_eq!(e.info(h).err(), Some(PdfError::UnknownDocument));
    assert_eq!(
        e.render(h, RenderReq::page(0, 1.0)).err(),
        Some(PdfError::UnknownDocument)
    );
    assert!(e.open_documents().is_empty());
}

#[test]
fn protocol_query_and_contract_shapes() {
    let req =
        RenderReq::from_query(3, "escala=2.5&bloco=10%2C20,30,40&tema=escuro").expect("query");
    assert_eq!(
        req,
        RenderReq {
            page: 3,
            scale: 2.5,
            tile: Some([10.0, 20.0, 30.0, 40.0]),
            theme: ReadingTheme::Dark,
            preview: false
        }
    );
    assert!(RenderReq::from_query(0, "tema=roxo").is_err());
    assert!(RenderReq::from_query(0, "bloco=1,2,3").is_err());
    assert!(RenderReq::from_query(0, "escala=x").is_err());

    let e = engine();
    let h = open(&e, SAMPLE);
    let info = serde_json::to_value(e.info(h).expect("info")).expect("json");
    for key in ["docId", "pageCount", "pages", "title", "author"] {
        assert!(info.get(key).is_some(), "{key} in {info}");
    }
    let words = serde_json::to_value(e.page_words(h, 0).expect("words")).expect("json");
    assert!(
        words["words"][0]["rects"][0]
            .as_array()
            .is_some_and(|r| r.len() == 4)
    );
    let err = serde_json::to_value(PdfError::WrongPassword).expect("json");
    assert_eq!(
        err,
        serde_json::json!({ "code": "wrongPassword", "message": "Senha incorreta." })
    );
    assert_eq!(
        serde_json::to_value(ReadingTheme::Sepia).expect("json"),
        "sepia"
    );
}
