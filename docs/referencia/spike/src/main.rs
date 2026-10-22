//! Spike: one binary linking Anki's Rust core (rslib) and PdfCraft's renderer.
use std::sync::Arc;

use anki::collection::CollectionBuilder;
use anki::prelude::*;
use anki::scheduler::answering::{CardAnswer, Rating};
use anki_proto::import_export::{ExportAnkiPackageOptions, ImportAnkiPackageOptions};
use pdfcraft_render::{PageRenderer, RenderConfig, RenderRequest, text::TextFilter};

fn main() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join("spike-leitor-anki");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;

    // --- Anki: create a collection, add a vocabulary note, export a deck as .apkg
    let mut col_a = CollectionBuilder::new(dir.join("a.anki2")).with_desktop_media_paths().build()?;
    let deck = col_a.get_or_create_normal_deck("Vocabulário::Livros::Teste")?;
    let basic = col_a.get_notetype_by_name("Basic")?.ok_or_else(|| anyhow::anyhow!("no Basic"))?;
    let mut note = basic.new_note();
    note.set_field(0, "windmill")?;
    note.set_field(1, "moinho de vento")?;
    col_a.add_note(&mut note, deck.id)?;
    let apkg = dir.join("vocab.apkg");
    let exported = col_a.export_apkg(&apkg, ExportAnkiPackageOptions { with_scheduling: true, with_deck_configs: true, with_media: true, legacy: false }, "deck:Vocabulário", None)?;
    println!("anki: exported {exported} note(s) to {}", apkg.display());

    // --- Anki: import that .apkg into a fresh collection, study one card, check the revlog
    let mut col_b = CollectionBuilder::new(dir.join("b.anki2")).with_desktop_media_paths().build()?;
    let log = col_b.import_apkg(&apkg, ImportAnkiPackageOptions { merge_notetypes: true, with_scheduling: true, with_deck_configs: true, ..Default::default() })?;
    println!("anki: imported {} new note(s)", log.output.new.len());
    let did = col_b.get_deck_id("Vocabulário::Livros::Teste")?.ok_or_else(|| anyhow::anyhow!("deck missing after import"))?;
    col_b.set_current_deck(did)?;
    let tree = col_b.deck_tree(Some(TimestampSecs::now()))?;
    println!("anki: deck tree root children = {}", tree.children.len());
    let queued = col_b.get_queued_cards(5, false)?;
    println!("anki: queue new={} learn={} review={}", queued.new_count, queued.learning_count, queued.review_count);
    let q = queued.cards.first().ok_or_else(|| anyhow::anyhow!("empty queue"))?.clone();
    let rendered = col_b.render_existing_card(q.card.id(), false, false)?;
    println!("anki: front html = {:?}", rendered.question());
    let mut answer = CardAnswer {
        card_id: q.card.id(),
        current_state: q.states.current,
        new_state: q.states.good,
        rating: Rating::Good,
        answered_at: TimestampMillis::now(),
        milliseconds_taken: 4200,
        custom_data: None,
        from_queue: true,
    };
    col_b.answer_card(&mut answer)?;
    let revlog: u32 = col_b.storage.db().query_row("select count(*) from revlog", [], |r| r.get(0))?;
    let time_ms: u32 = col_b.storage.db().query_row("select sum(time) from revlog", [], |r| r.get(0))?;
    println!("anki: revlog rows = {revlog}, time = {time_ms} ms");

    // --- PdfCraft: render page 1 to PNG and pull positioned words from the text layer
    let pdf_path = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: spike <file.pdf>"))?;
    let bytes = Arc::new(std::fs::read(&pdf_path)?);
    let mut renderer = PageRenderer::new(bytes, RenderConfig::default());
    println!("pdf: {} page(s)", renderer.page_count());
    let page = renderer.render(RenderRequest { page: 0, scale: 2.0, ..Default::default() });
    if let Some(err) = &page.error { anyhow::bail!("render failed: {err}"); }
    let words = page.rgba.into_words();
    let mut rgba = Vec::with_capacity(words.len() * 4);
    for w in words { rgba.extend_from_slice(&w.to_ne_bytes()); }
    let out = dir.join("page1.png");
    let mut enc = png::Encoder::new(std::io::BufWriter::new(std::fs::File::create(&out)?), page.width, page.height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header()?.write_image_data(&rgba)?;
    println!("pdf: rendered {}x{} in {} ms -> {}", page.width, page.height, page.millis, out.display());
    let text = renderer.filtered_text(0, TextFilter::default()).map_err(|e| anyhow::anyhow!(e))?;
    let mut i = 0;
    let mut shown = 0;
    while i < text.glyphs.len() && shown < 8 {
        if let Some((a, b)) = text.word_at(i) {
            let word = text.text_of(a..b);
            if word.trim().chars().any(char::is_alphabetic) {
                let r = text.line_rects(a..b);
                println!("pdf: word {:?} at {:?}", word.trim(), r.first());
                shown += 1;
            }
            i = b.max(i + 1);
        } else { i += 1; }
    }
    println!("pdf: page text chars = {}", text.plain_text().len());
    Ok(())
}
