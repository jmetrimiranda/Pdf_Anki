//! Ranges of the book (spec 12.1 step 2, "Trecho") and chapters (12.4). Pages are 0-based in data and 1-based in
//! what the user types and reads.

use serde::{Deserialize, Serialize};

use crate::RangeError;
use crate::naming::slug;

/// Most items (pages or intervals) a page list may have.
pub const MAX_RANGE_ITEMS: usize = 100;
/// Longest outline label (titles joined with " + ") before it is cut with "…".
const LABEL_MAX_CHARS: usize = 60;

/// What the user chose in the "Trecho" step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RangeSpec {
    /// "Livro inteiro".
    All,
    /// "Por bookmarks/sumário": ids of [`OutlineRangeItem`]s ("0.2.1").
    Outline { ids: Vec<String> },
    /// "Páginas": the text as typed ("21-45, 60, 72-80").
    Pages { text: String },
}

/// Kind of a resolved range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RangeKind {
    All,
    Outline,
    Pages,
}

/// An outline item as `core-pdf` reads it (page 0-based, `None` when it points nowhere in the book).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineNode {
    pub title: String,
    pub page: Option<u32>,
    #[serde(default)]
    pub children: Vec<OutlineNode>,
}

/// An outline item with its page range (the "Trecho" tree).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineRangeItem {
    /// Index path, e.g. "0.2.1".
    pub id: String,
    pub title: String,
    pub page: Option<u32>,
    /// First and last page (0-based, inclusive); `None` when the item has no page (not selectable).
    pub start_page: Option<u32>,
    pub end_page: Option<u32>,
    pub children: Vec<OutlineRangeItem>,
}

/// A range ready for scanning and naming.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRange {
    pub kind: RangeKind,
    /// Sorted, merged, 0-based inclusive page intervals.
    pub pages: Vec<[u32; 2]>,
    /// Short name: "Cap 3", "Cap 3 + Cap 5", "p. 21-45, 60". `None` for the whole book.
    pub label: Option<String>,
    /// Header text: "Livro inteiro", "Cap 3 (p. 21–45)", "p. 21–45, 60, 72–80".
    pub display: String,
    /// Tag slug: "cap-3", "p-21-45-60-72-80".
    pub slug: Option<String>,
    /// Subdeck name ("Cap 3", "p. 21-45").
    pub subdeck: Option<String>,
    /// Selected outline ids (outline ranges).
    pub items: Vec<String>,
    /// Normalized page text ("21-45, 60, 72-80") for page ranges.
    pub text: Option<String>,
}

impl ResolvedRange {
    /// The whole book.
    pub fn all(page_count: u32) -> ResolvedRange {
        ResolvedRange {
            kind: RangeKind::All,
            pages: if page_count == 0 {
                Vec::new()
            } else {
                vec![[0, page_count - 1]]
            },
            label: None,
            display: "Livro inteiro".to_string(),
            slug: None,
            subdeck: None,
            items: Vec::new(),
            text: None,
        }
    }

    /// Whether a 0-based page is inside the range.
    pub fn contains(&self, page: u32) -> bool {
        self.pages.iter().any(|[a, b]| (*a..=*b).contains(&page))
    }

    /// Number of pages in the range.
    pub fn page_count(&self) -> u32 {
        self.pages
            .iter()
            .map(|[a, b]| b.saturating_sub(*a).saturating_add(1))
            .fold(0u32, u32::saturating_add)
    }
}

/// A chapter for per-chapter coverage and subdecks (12.4, 12.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    /// 1-based.
    pub index: u32,
    pub label: String,
    pub start_page: u32,
    pub end_page: u32,
}

fn parse_page(s: &str) -> Result<u32, RangeError> {
    let t = s.trim();
    if t.is_empty() || !t.chars().all(|c| c.is_ascii_digit()) {
        return Err(RangeError::NotANumber(t.to_string()));
    }
    let n: u32 = t
        .parse()
        .map_err(|_| RangeError::NotANumber(t.to_string()))?;
    if n == 0 {
        return Err(RangeError::Zero);
    }
    Ok(n)
}

/// Parses a page list typed by the user: one page (`37`), an interval (`21-45`, en/em dashes accepted) or a list
/// (`21-45, 60, 72-80`; commas or semicolons, any spaces). Returns sorted, merged, 0-based inclusive intervals.
pub fn parse_pages(text: &str, page_count: u32) -> Result<Vec<[u32; 2]>, RangeError> {
    if page_count == 0 {
        return Err(RangeError::EmptyBook);
    }
    let norm: String = text
        .chars()
        .map(|c| match c {
            '–' | '—' | '−' | '‐' | '‑' => '-',
            ';' => ',',
            c => c,
        })
        .collect();
    let items: Vec<&str> = norm
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if items.is_empty() {
        return Err(RangeError::Empty);
    }
    if items.len() > MAX_RANGE_ITEMS {
        return Err(RangeError::TooMany(MAX_RANGE_ITEMS));
    }
    let mut out: Vec<[u32; 2]> = Vec::with_capacity(items.len());
    for item in items {
        let (a, b) = match item.split_once('-') {
            None => {
                let p = parse_page(item)?;
                (p, p)
            }
            Some((a, b)) => {
                if a.trim().is_empty() || b.trim().is_empty() {
                    if b.contains('-') {
                        return Err(RangeError::NotANumber(item.to_string()));
                    }
                    return Err(RangeError::OpenEnded(item.to_string()));
                }
                if b.contains('-') {
                    return Err(RangeError::NotANumber(item.to_string()));
                }
                let (a, b) = (parse_page(a)?, parse_page(b)?);
                if a > b {
                    return Err(RangeError::Reversed { from: a, to: b });
                }
                (a, b)
            }
        };
        for p in [a, b] {
            if p > page_count {
                return Err(RangeError::BeyondEnd {
                    page: p,
                    count: page_count,
                });
            }
        }
        out.push([a - 1, b - 1]);
    }
    Ok(merge(out))
}

/// Sorts and merges overlapping or adjacent intervals.
pub(crate) fn merge(mut v: Vec<[u32; 2]>) -> Vec<[u32; 2]> {
    v.sort_unstable();
    let mut out: Vec<[u32; 2]> = Vec::with_capacity(v.len());
    for [a, b] in v {
        match out.last_mut() {
            Some(last) if a <= last[1].saturating_add(1) => last[1] = last[1].max(b),
            _ => out.push([a, b]),
        }
    }
    out
}

struct Flat<'a> {
    id: String,
    depth: usize,
    node: &'a OutlineNode,
}

fn flatten<'a>(nodes: &'a [OutlineNode], prefix: &str, depth: usize, out: &mut Vec<Flat<'a>>) {
    for (i, n) in nodes.iter().enumerate() {
        let id = if prefix.is_empty() {
            i.to_string()
        } else {
            format!("{prefix}.{i}")
        };
        out.push(Flat {
            id: id.clone(),
            depth,
            node: n,
        });
        // Malicious outlines can be deep; the reader already bounds them, but stay safe.
        if depth < 64 {
            flatten(&n.children, &id, depth + 1, out);
        }
    }
}

/// The (start, end) of each flattened item, by the rule of spec 12.1 step 2: from its page to the page before the
/// first following item (in document order) at the same level or above whose page is after it; the last one to
/// the end of the book. Only the very next item at the same level or above ends the range on its own page (two
/// bookmarks on one page); later items with the same or an earlier page are skipped, because PdfCraft appends the
/// bookmarks the user creates at the end of the root level, whatever their page.
fn flat_ranges(flat: &[Flat], page_count: u32) -> Vec<Option<(u32, u32)>> {
    let last = page_count.saturating_sub(1);
    (0..flat.len())
        .map(|i| {
            let start = flat[i].node.page?;
            if page_count == 0 || start > last {
                return None;
            }
            let depth = flat[i].depth;
            let mut end = last;
            let mut first = true;
            for f in &flat[i + 1..] {
                if f.depth > depth {
                    continue;
                }
                match f.node.page {
                    Some(p) if p > start && p <= last => {
                        end = p - 1;
                        break;
                    }
                    Some(p) if p == start && first => {
                        end = start;
                        break;
                    }
                    _ => {}
                }
                first = false;
            }
            Some((start, end))
        })
        .collect()
}

/// A selected outline item as saved with a scan, so a rescan finds it again after the outline changed
/// ([`rematch_outline_items`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineAnchor {
    /// Index path when the scan ran ("0.2.1").
    pub id: String,
    /// Cleaned title.
    pub title: String,
    /// 0-based page.
    pub page: u32,
}

/// The anchors of the selected items of an outline range (empty for other ranges).
pub fn outline_anchors(range: &ResolvedRange, outline: &[OutlineNode]) -> Vec<OutlineAnchor> {
    if range.kind != RangeKind::Outline {
        return Vec::new();
    }
    let mut flat = Vec::new();
    flatten(outline, "", 0, &mut flat);
    range
        .items
        .iter()
        .filter_map(|id| {
            let f = flat.iter().find(|f| f.id == *id)?;
            Some(OutlineAnchor {
                id: id.clone(),
                title: clean_title(&f.node.title),
                page: f.node.page?,
            })
        })
        .collect()
}

/// The current ids of saved outline items: the same id when it still has the same title and page, otherwise the
/// first item in document order with that title and page (bookmarks added, removed or moved). An item that is
/// gone is an error ([`RangeError::UnknownItem`]): a rescan never scans another item in its place.
pub fn rematch_outline_items(
    anchors: &[OutlineAnchor],
    outline: &[OutlineNode],
) -> Result<Vec<String>, RangeError> {
    if anchors.is_empty() {
        return Err(RangeError::NoItems);
    }
    let mut flat = Vec::new();
    flatten(outline, "", 0, &mut flat);
    let matches = |f: &Flat, a: &OutlineAnchor| {
        f.node.page == Some(a.page) && clean_title(&f.node.title) == a.title
    };
    anchors
        .iter()
        .map(|a| {
            flat.iter()
                .find(|f| f.id == a.id && matches(f, a))
                .or_else(|| flat.iter().find(|f| matches(f, a)))
                .map(|f| f.id.clone())
                .ok_or_else(|| RangeError::UnknownItem(a.title.clone()))
        })
        .collect()
}

/// The outline as a tree of selectable items with their page ranges.
pub fn outline_ranges(outline: &[OutlineNode], page_count: u32) -> Vec<OutlineRangeItem> {
    let mut flat = Vec::new();
    flatten(outline, "", 0, &mut flat);
    let ranges = flat_ranges(&flat, page_count);
    let mut iter = flat.iter().zip(ranges).peekable();
    let mut roots = Vec::new();
    build_tree(&mut iter, 0, &mut roots);
    roots
}

fn build_tree<'a, I>(
    iter: &mut std::iter::Peekable<I>,
    depth: usize,
    out: &mut Vec<OutlineRangeItem>,
) where
    I: Iterator<Item = (&'a Flat<'a>, Option<(u32, u32)>)>,
{
    while let Some((f, _)) = iter.peek() {
        if f.depth < depth {
            return;
        }
        let Some((f, range)) = iter.next() else {
            return;
        };
        let mut item = OutlineRangeItem {
            id: f.id.clone(),
            title: clean_title(&f.node.title),
            page: f.node.page,
            start_page: range.map(|r| r.0),
            end_page: range.map(|r| r.1),
            children: Vec::new(),
        };
        build_tree(iter, f.depth + 1, &mut item.children);
        out.push(item);
    }
}

fn clean_title(t: &str) -> String {
    let s: String = t
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        "(sem título)".to_string()
    } else {
        s
    }
}

/// Pages for display: "21–45, 60, 72–80" (1-based, `dash` between bounds).
fn pages_text(pages: &[[u32; 2]], dash: &str) -> String {
    pages
        .iter()
        .map(|[a, b]| {
            if a == b {
                format!("{}", a + 1)
            } else {
                format!("{}{dash}{}", a + 1, b + 1)
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out = out.trim_end().to_string();
    out.push('…');
    out
}

fn subdeck_of(label: &str) -> String {
    label.replace("::", ":").trim().to_string()
}

/// Resolves the chosen range against the outline and the page count.
pub fn resolve_range(
    spec: &RangeSpec,
    outline: &[OutlineNode],
    page_count: u32,
) -> Result<ResolvedRange, RangeError> {
    if page_count == 0 {
        return Err(RangeError::EmptyBook);
    }
    match spec {
        RangeSpec::All => Ok(ResolvedRange::all(page_count)),
        RangeSpec::Pages { text } => {
            let pages = parse_pages(text, page_count)?;
            let norm = pages_text(&pages, "-");
            let label = format!("p. {norm}");
            Ok(ResolvedRange {
                kind: RangeKind::Pages,
                display: format!("p. {}", pages_text(&pages, "–")),
                slug: Some(slug(&label)),
                subdeck: Some(subdeck_of(&label)),
                label: Some(label),
                items: Vec::new(),
                text: Some(norm),
                pages,
            })
        }
        RangeSpec::Outline { ids } => {
            if ids.is_empty() {
                return Err(RangeError::NoItems);
            }
            if ids.len() > MAX_RANGE_ITEMS * 10 {
                return Err(RangeError::TooMany(MAX_RANGE_ITEMS * 10));
            }
            let mut flat = Vec::new();
            flatten(outline, "", 0, &mut flat);
            let ranges = flat_ranges(&flat, page_count);
            let mut chosen: Vec<usize> = Vec::new();
            for id in ids {
                let Some(i) = flat.iter().position(|f| f.id == *id) else {
                    return Err(RangeError::UnknownItem(id.clone()));
                };
                if ranges[i].is_none() {
                    return Err(RangeError::ItemWithoutPage(clean_title(
                        &flat[i].node.title,
                    )));
                }
                if !chosen.contains(&i) {
                    chosen.push(i);
                }
            }
            chosen.sort_unstable();
            let pages = merge(
                chosen
                    .iter()
                    .filter_map(|i| ranges[*i].map(|(a, b)| [a, b]))
                    .collect(),
            );
            // Titles of the selected items whose ancestors are not selected (children are inside them).
            let titles: Vec<String> = chosen
                .iter()
                .filter(|i| {
                    let id = &flat[**i].id;
                    !chosen.iter().any(|j| {
                        let other = &flat[*j].id;
                        other != id && id.starts_with(&format!("{other}."))
                    })
                })
                .map(|i| clean_title(&flat[*i].node.title))
                .collect();
            let label = cut(&titles.join(" + "), LABEL_MAX_CHARS);
            Ok(ResolvedRange {
                kind: RangeKind::Outline,
                display: format!("{label} (p. {})", pages_text(&pages, "–")),
                slug: Some(slug(&label)),
                subdeck: Some(subdeck_of(&label)),
                label: Some(label),
                items: chosen.iter().map(|i| flat[*i].id.clone()).collect(),
                text: None,
                pages,
            })
        }
    }
}

/// Chapters for the coverage per chapter (12.4) and the per-chapter subdecks (12.6): the top-level outline items
/// with a page, in document order, each one after the previous chapter (a top-level item whose page is not after
/// the previous chapter is skipped: PdfCraft appends the bookmarks the user creates at the end of the root level,
/// so they never renumber or split the chapters before them); or blocks of 20 pages ("p. 1–20") without an outline.
pub fn chapters(outline: &[OutlineNode], page_count: u32) -> Vec<Chapter> {
    if page_count == 0 {
        return Vec::new();
    }
    let last = page_count - 1;
    let mut tops: Vec<(String, u32)> = Vec::new();
    for n in outline {
        let Some(p) = n.page.filter(|p| *p <= last) else {
            continue;
        };
        if tops.last().is_none_or(|(_, prev)| p > *prev) {
            tops.push((clean_title(&n.title), p));
        }
    }
    if tops.is_empty() {
        let mut out = Vec::new();
        let mut start = 0u32;
        let mut index = 1u32;
        while start <= last {
            let end = start.saturating_add(19).min(last);
            out.push(Chapter {
                index,
                label: format!("p. {}–{}", start + 1, end + 1),
                start_page: start,
                end_page: end,
            });
            index += 1;
            match end.checked_add(1) {
                Some(s) => start = s,
                None => break,
            }
        }
        return out;
    }
    let n = tops.len();
    tops.iter()
        .enumerate()
        .map(|(i, (title, p))| {
            let end = if i + 1 < n { tops[i + 1].1 - 1 } else { last };
            Chapter {
                index: i as u32 + 1,
                label: title.clone(),
                start_page: *p,
                end_page: end,
            }
        })
        .collect()
}

/// The chapter containing a page.
pub(crate) fn chapter_of(chapters: &[Chapter], page: u32) -> Option<u32> {
    chapters
        .iter()
        .find(|c| (c.start_page..=c.end_page).contains(&page))
        .map(|c| c.index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(title: &str, page: Option<u32>, children: Vec<OutlineNode>) -> OutlineNode {
        OutlineNode {
            title: title.to_string(),
            page,
            children,
        }
    }

    #[test]
    fn parses_pages() {
        assert_eq!(parse_pages("37", 300), Ok(vec![[36, 36]]));
        assert_eq!(parse_pages("21-45", 300), Ok(vec![[20, 44]]));
        assert_eq!(
            parse_pages("21-45, 60, 72-80", 300),
            Ok(vec![[20, 44], [59, 59], [71, 79]])
        );
        assert_eq!(
            parse_pages(" 72 – 80 ,21—45;60 ", 300),
            Ok(vec![[20, 44], [59, 59], [71, 79]])
        );
        assert_eq!(parse_pages("10-20, 15-30, 31", 300), Ok(vec![[9, 30]]));
        assert_eq!(parse_pages("5, 5, 5", 300), Ok(vec![[4, 4]]));
        assert_eq!(parse_pages("300", 300), Ok(vec![[299, 299]]));
    }

    #[test]
    fn rejects_bad_pages() {
        assert_eq!(parse_pages("", 300), Err(RangeError::Empty));
        assert_eq!(parse_pages(" , ,", 300), Err(RangeError::Empty));
        assert_eq!(
            parse_pages("abc", 300),
            Err(RangeError::NotANumber("abc".into()))
        );
        assert_eq!(
            parse_pages("1.5", 300),
            Err(RangeError::NotANumber("1.5".into()))
        );
        assert_eq!(parse_pages("0", 300), Err(RangeError::Zero));
        assert_eq!(parse_pages("0-5", 300), Err(RangeError::Zero));
        assert_eq!(
            parse_pages("45-21", 300),
            Err(RangeError::Reversed { from: 45, to: 21 })
        );
        assert_eq!(
            parse_pages("21-", 300),
            Err(RangeError::OpenEnded("21-".into()))
        );
        assert_eq!(
            parse_pages("-21", 300),
            Err(RangeError::OpenEnded("-21".into()))
        );
        assert_eq!(
            parse_pages("1-2-3", 300),
            Err(RangeError::NotANumber("1-2-3".into()))
        );
        assert_eq!(
            parse_pages("-5", 300),
            Err(RangeError::OpenEnded("-5".into()))
        );
        assert_eq!(
            parse_pages("99999999999999", 300),
            Err(RangeError::NotANumber("99999999999999".into()))
        );
        let e = parse_pages("400", 300).expect_err("beyond");
        assert_eq!(
            e,
            RangeError::BeyondEnd {
                page: 400,
                count: 300
            }
        );
        assert_eq!(
            e.to_string(),
            "A página 400 não existe (o livro tem 300 páginas)."
        );
        let many = (1..=101)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(parse_pages(&many, 300), Err(RangeError::TooMany(100)));
        assert_eq!(parse_pages("1", 0), Err(RangeError::EmptyBook));
    }

    fn sample_outline() -> Vec<OutlineNode> {
        vec![
            node("Chapter One", Some(0), vec![]),
            node(
                "Chapter Two",
                Some(10),
                vec![
                    node("Part A", Some(10), vec![]),
                    node("Part B", Some(14), vec![]),
                ],
            ),
            node("Chapter Three", Some(20), vec![node("Lost", None, vec![])]),
            node("Chapter Four", Some(30), vec![]),
        ]
    }

    #[test]
    fn outline_rule() {
        let items = outline_ranges(&sample_outline(), 40);
        let r = |it: &OutlineRangeItem| (it.id.clone(), it.start_page, it.end_page);
        assert_eq!(r(&items[0]), ("0".into(), Some(0), Some(9)));
        assert_eq!(r(&items[1]), ("1".into(), Some(10), Some(19)));
        // Same page as the next item (its first child is deeper, so it does not count): Part A → next sibling p14.
        assert_eq!(r(&items[1].children[0]), ("1.0".into(), Some(10), Some(13)));
        // Part B ends before the next item at a higher level (Chapter Three).
        assert_eq!(r(&items[1].children[1]), ("1.1".into(), Some(14), Some(19)));
        assert_eq!(r(&items[2].children[0]), ("2.0".into(), None, None));
        assert_eq!(r(&items[3]), ("3".into(), Some(30), Some(39)));
    }

    #[test]
    fn outline_rule_edge_cases() {
        // Next sibling on the same page → one page; unsorted following items: the first later page wins and items
        // with an earlier page are skipped.
        let outline = vec![
            node("A", Some(5), vec![]),
            node("B", Some(5), vec![]),
            node("C", Some(30), vec![]),
            node("D", Some(12), vec![]),
            node("E", Some(2), vec![]),
        ];
        let items = outline_ranges(&outline, 50);
        let r: Vec<(Option<u32>, Option<u32>)> =
            items.iter().map(|i| (i.start_page, i.end_page)).collect();
        assert_eq!(
            r,
            vec![
                (Some(5), Some(5)),
                (Some(5), Some(29)),
                (Some(30), Some(49)),
                (Some(12), Some(49)),
                (Some(2), Some(49)),
            ]
        );
        // Pages beyond the book are unselectable; an empty outline is fine.
        let items = outline_ranges(&[node("X", Some(99), vec![])], 10);
        assert_eq!(items[0].start_page, None);
        assert!(outline_ranges(&[], 10).is_empty());
    }

    /// PdfCraft's "New bookmark" appends a root item at the end, on the page being read.
    fn outline_with_user_bookmarks() -> Vec<OutlineNode> {
        let mut o = sample_outline();
        o.push(node("Minha nota", Some(20), vec![])); // first page of Chapter Three
        o.push(node("Meio do cap. 2", Some(15), vec![])); // middle of Chapter Two
        o
    }

    #[test]
    fn user_bookmarks_do_not_cut_chapters() {
        let items = outline_ranges(&outline_with_user_bookmarks(), 40);
        let r = |it: &OutlineRangeItem| (it.title.clone(), it.start_page, it.end_page);
        assert_eq!(r(&items[1]), ("Chapter Two".into(), Some(10), Some(19)));
        assert_eq!(
            r(&items[1].children[1]),
            ("Part B".into(), Some(14), Some(19))
        );
        assert_eq!(r(&items[2]), ("Chapter Three".into(), Some(20), Some(29)));
        assert_eq!(r(&items[3]), ("Chapter Four".into(), Some(30), Some(39)));
        // The bookmarks themselves: the last items, to the end of the book.
        assert_eq!(r(&items[4]), ("Minha nota".into(), Some(20), Some(39)));
        assert_eq!(r(&items[5]), ("Meio do cap. 2".into(), Some(15), Some(39)));

        // Chapters keep their numbers and pages.
        let before = chapters(&sample_outline(), 40);
        let after = chapters(&outline_with_user_bookmarks(), 40);
        assert_eq!(before, after);
        // A bookmark after the last chapter's page is a new last chapter: earlier numbers don't move.
        let mut late = sample_outline();
        late.push(node("Epílogo", Some(35), vec![]));
        let c = chapters(&late, 40);
        assert_eq!(c.len(), 5);
        assert_eq!(&c[..3], &before[..3]);
        assert_eq!((c[3].start_page, c[3].end_page), (30, 34));
        assert_eq!((c[4].index, c[4].start_page), (5, 35));
    }

    #[test]
    fn outline_anchors_follow_the_items() {
        let outline = sample_outline();
        let range = resolve_range(
            &RangeSpec::Outline {
                ids: vec!["2".into(), "1.1".into()],
            },
            &outline,
            40,
        )
        .expect("range");
        let anchors = outline_anchors(&range, &outline);
        assert_eq!(
            anchors,
            vec![
                OutlineAnchor {
                    id: "1.1".into(),
                    title: "Part B".into(),
                    page: 14
                },
                OutlineAnchor {
                    id: "2".into(),
                    title: "Chapter Three".into(),
                    page: 20
                },
            ]
        );
        // Unchanged outline (and appended bookmarks): the same ids.
        assert_eq!(
            rematch_outline_items(&anchors, &outline_with_user_bookmarks()),
            Ok(vec!["1.1".to_string(), "2".to_string()])
        );
        // A bookmark inserted before them: found by title and page.
        let mut moved = sample_outline();
        moved.insert(0, node("Nota", Some(0), vec![]));
        assert_eq!(
            rematch_outline_items(&anchors, &moved),
            Ok(vec!["2.1".to_string(), "3".to_string()])
        );
        // An item deleted: an error, never another item in its place.
        let mut gone = sample_outline();
        gone.remove(2);
        assert_eq!(
            rematch_outline_items(&anchors, &gone),
            Err(RangeError::UnknownItem("Chapter Three".into()))
        );
        // Renamed in place: also gone.
        let mut renamed = sample_outline();
        renamed[2].title = "Capítulo 3".into();
        assert!(rematch_outline_items(&anchors, &renamed).is_err());
        assert!(outline_anchors(&ResolvedRange::all(40), &outline).is_empty());
        assert_eq!(
            rematch_outline_items(&[], &outline),
            Err(RangeError::NoItems)
        );
    }

    #[test]
    fn resolves_ranges() {
        let outline = sample_outline();
        let all = resolve_range(&RangeSpec::All, &outline, 40).expect("all");
        assert_eq!(all.pages, vec![[0, 39]]);
        assert_eq!(all.display, "Livro inteiro");
        assert_eq!(all.slug, None);

        let ch = resolve_range(
            &RangeSpec::Outline {
                ids: vec!["1".into(), "1.1".into()],
            },
            &outline,
            40,
        )
        .expect("outline");
        assert_eq!(ch.pages, vec![[10, 19]]);
        assert_eq!(ch.label.as_deref(), Some("Chapter Two"));
        assert_eq!(ch.display, "Chapter Two (p. 11–20)");
        assert_eq!(ch.slug.as_deref(), Some("chapter-two"));
        assert_eq!(ch.items, vec!["1".to_string(), "1.1".to_string()]);

        let two = resolve_range(
            &RangeSpec::Outline {
                ids: vec!["3".into(), "0".into()],
            },
            &outline,
            40,
        )
        .expect("two");
        assert_eq!(two.pages, vec![[0, 9], [30, 39]]);
        assert_eq!(two.label.as_deref(), Some("Chapter One + Chapter Four"));
        assert_eq!(two.display, "Chapter One + Chapter Four (p. 1–10, 31–40)");

        let p = resolve_range(
            &RangeSpec::Pages {
                text: "72-80,21–45, 60".into(),
            },
            &outline,
            300,
        )
        .expect("pages");
        assert_eq!(p.label.as_deref(), Some("p. 21-45, 60, 72-80"));
        assert_eq!(p.display, "p. 21–45, 60, 72–80");
        assert_eq!(p.slug.as_deref(), Some("p-21-45-60-72-80"));
        assert_eq!(p.subdeck.as_deref(), Some("p. 21-45, 60, 72-80"));
        assert_eq!(p.text.as_deref(), Some("21-45, 60, 72-80"));
        assert_eq!(p.page_count(), 25 + 1 + 9);

        assert_eq!(
            resolve_range(&RangeSpec::Outline { ids: vec![] }, &outline, 40),
            Err(RangeError::NoItems)
        );
        assert!(matches!(
            resolve_range(
                &RangeSpec::Outline {
                    ids: vec!["9".into()]
                },
                &outline,
                40
            ),
            Err(RangeError::UnknownItem(_))
        ));
        assert!(matches!(
            resolve_range(
                &RangeSpec::Outline {
                    ids: vec!["2.0".into()]
                },
                &outline,
                40
            ),
            Err(RangeError::ItemWithoutPage(_))
        ));
        let long = vec![
            node(&"Very long chapter title ".repeat(5), Some(0), vec![]),
            node("::x", Some(3), vec![]),
        ];
        let r = resolve_range(
            &RangeSpec::Outline {
                ids: vec!["0".into(), "1".into()],
            },
            &long,
            10,
        )
        .expect("long");
        assert_eq!(r.label.as_ref().map(|l| l.chars().count()), Some(60));
        assert!(r.label.as_deref().is_some_and(|l| l.ends_with('…')));
        assert!(!r.subdeck.as_deref().unwrap_or("").contains("::"));
    }

    #[test]
    fn chapter_blocks() {
        let c = chapters(&sample_outline(), 40);
        assert_eq!(c.len(), 4);
        assert_eq!((c[1].index, c[1].start_page, c[1].end_page), (2, 10, 19));
        assert_eq!(c[3].end_page, 39);
        let blocks = chapters(&[], 45);
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].label, "p. 1–20");
        assert_eq!(blocks[2].label, "p. 41–45");
        assert!(chapters(&[], 0).is_empty());
        assert_eq!(chapter_of(&c, 12), Some(2));
    }
}
