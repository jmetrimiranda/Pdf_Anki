//! Table of contents: EPUB 3 nav (`<nav epub:type="toc">`) first, then the EPUB 2 NCX, else a
//! fallback with one item per linear section (spec 7.1; docs/tecnico/epub.md).

use std::collections::HashMap;

use crate::path::resolve;
use crate::xml::Element;
use crate::{Section, TocItem};

pub const MAX_DEPTH: usize = 32;
pub const MAX_ITEMS: usize = 10_000;

struct Builder<'a> {
    /// zip path → section index.
    sections: &'a HashMap<String, u32>,
    base: &'a str,
    count: usize,
}

impl Builder<'_> {
    fn item(&mut self, title: String, href: Option<&str>, children: Vec<TocItem>) -> TocItem {
        let resolved = href.and_then(|h| resolve(self.base, h));
        let (href, fragment) = match resolved {
            Some(h) => (h.path, h.fragment),
            None => (String::new(), None),
        };
        let own = (!href.is_empty())
            .then(|| self.sections.get(&href).copied())
            .flatten();
        // A heading without a link (`<span>`) covers its first linked child.
        let section = own.or_else(|| first_section(&children));
        TocItem {
            title,
            href,
            fragment,
            section,
            children,
        }
    }

    fn full(&self) -> bool {
        self.count >= MAX_ITEMS
    }
}

fn first_section(items: &[TocItem]) -> Option<u32> {
    items
        .iter()
        .find_map(|i| i.section.or_else(|| first_section(&i.children)))
}

/// EPUB 3 navigation document: the first `<nav>` whose `epub:type` contains `toc`.
pub(crate) fn from_nav(
    tree: &Element,
    nav_path: &str,
    sections: &HashMap<String, u32>,
) -> Vec<TocItem> {
    let Some(nav) = tree.find(&|e| {
        e.is("nav")
            && e.attr("epub:type")
                .is_some_and(|t| t.split_whitespace().any(|t| t == "toc"))
    }) else {
        return Vec::new();
    };
    let Some(ol) = nav.find_named("ol") else {
        return Vec::new();
    };
    let mut b = Builder {
        sections,
        base: nav_path,
        count: 0,
    };
    nav_list(&mut b, ol, 0)
}

fn nav_list(b: &mut Builder<'_>, ol: &Element, depth: usize) -> Vec<TocItem> {
    let mut items = Vec::new();
    if depth >= MAX_DEPTH {
        return items;
    }
    for li in ol.children_named("li") {
        if b.full() {
            break;
        }
        b.count += 1;
        let link = li.child("a").or_else(|| li.child("span"));
        let title = link
            .map(|a| a.text())
            .filter(|t| !t.is_empty())
            .or_else(|| {
                link.and_then(|a| a.attr("title"))
                    .map(crate::xml::collapse_ws)
            })
            .unwrap_or_default();
        let href = link.filter(|a| a.is("a")).and_then(|a| a.attr("href"));
        let children = li
            .child("ol")
            .map(|c| nav_list(b, c, depth + 1))
            .unwrap_or_default();
        items.push(b.item(title, href, children));
    }
    items
}

/// EPUB 2 NCX: `navMap/navPoint` (nested).
pub(crate) fn from_ncx(
    tree: &Element,
    ncx_path: &str,
    sections: &HashMap<String, u32>,
) -> Vec<TocItem> {
    let Some(map) = tree.find_named("navMap") else {
        return Vec::new();
    };
    let mut b = Builder {
        sections,
        base: ncx_path,
        count: 0,
    };
    ncx_list(&mut b, map, 0)
}

fn ncx_list(b: &mut Builder<'_>, parent: &Element, depth: usize) -> Vec<TocItem> {
    let mut items = Vec::new();
    if depth >= MAX_DEPTH {
        return items;
    }
    for point in parent.children_named("navPoint") {
        if b.full() {
            break;
        }
        b.count += 1;
        let title = point
            .child("navLabel")
            .map(Element::text)
            .unwrap_or_default();
        let href = point.child("content").and_then(|c| c.attr("src"));
        let children = ncx_list(b, point, depth + 1);
        items.push(b.item(title, href, children));
    }
    items
}

/// Gives untitled items a readable label (`Seção N`) and drops untitled, unlinked leaves.
pub(crate) fn tidy(items: Vec<TocItem>) -> Vec<TocItem> {
    items
        .into_iter()
        .filter_map(|mut item| {
            item.children = tidy(std::mem::take(&mut item.children));
            if item.title.is_empty() {
                if item.section.is_none() && item.children.is_empty() {
                    return None;
                }
                item.title = match item.section {
                    Some(s) => fallback_title(s),
                    None => "Sem título".to_owned(),
                };
            }
            Some(item)
        })
        .collect()
}

pub(crate) fn fallback_title(section: u32) -> String {
    format!("Seção {}", section + 1)
}

/// One item per linear section (all sections when none is linear); `heading` gives its label.
pub(crate) fn fallback(
    sections: &[Section],
    heading: &mut dyn FnMut(&Section) -> Option<String>,
) -> Vec<TocItem> {
    let any_linear = sections.iter().any(|s| s.linear);
    sections
        .iter()
        .filter(|s| s.linear || !any_linear)
        .take(MAX_ITEMS)
        .map(|s| TocItem {
            title: heading(s).unwrap_or_else(|| fallback_title(s.index)),
            href: s.href.clone(),
            fragment: None,
            section: Some(s.index),
            children: Vec::new(),
        })
        .collect()
}

/// For each section, the deepest TOC item covering it: the item with the greatest section ≤ it.
/// Among items starting in the same section, one pointing at the file itself (no `#fragment`)
/// wins over fragments further down the file, then the deeper one, then the first in order.
pub(crate) fn section_labels(toc: &[TocItem], section_count: usize) -> Vec<Option<String>> {
    struct Entry<'a> {
        section: u32,
        rank: (bool, usize),
        order: usize,
        title: &'a str,
    }
    fn walk<'a>(items: &'a [TocItem], depth: usize, flat: &mut Vec<Entry<'a>>) {
        for item in items {
            if let Some(section) = item.section {
                let order = flat.len();
                flat.push(Entry {
                    section,
                    rank: (item.fragment.is_none(), depth),
                    order,
                    title: &item.title,
                });
            }
            walk(&item.children, depth + 1, flat);
        }
    }
    let mut flat = Vec::new();
    walk(toc, 0, &mut flat);
    let mut best: HashMap<u32, &Entry<'_>> = HashMap::new();
    for e in &flat {
        let better = best
            .get(&e.section)
            .is_none_or(|b| e.rank > b.rank || (e.rank == b.rank && e.order < b.order));
        if better {
            best.insert(e.section, e);
        }
    }
    let mut labels = Vec::with_capacity(section_count);
    let mut current: Option<String> = None;
    for s in 0..section_count as u32 {
        if let Some(e) = best.get(&s) {
            current = Some(e.title.to_owned());
        }
        labels.push(current.clone());
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: &str, section: Option<u32>, children: Vec<TocItem>) -> TocItem {
        TocItem {
            title: title.into(),
            href: String::new(),
            fragment: None,
            section,
            children,
        }
    }

    #[test]
    fn labels_pick_the_deepest_covering_item() {
        let toc = vec![
            item(
                "Part I",
                Some(1),
                vec![item("Ch 1", Some(1), vec![]), item("Ch 2", Some(3), vec![])],
            ),
            item(
                "Part II",
                Some(5),
                vec![
                    item("Ch 3a", Some(6), vec![]),
                    item("Ch 3b", Some(6), vec![]),
                ],
            ),
        ];
        let labels = section_labels(&toc, 8);
        let got: Vec<Option<&str>> = labels.iter().map(|l| l.as_deref()).collect();
        assert_eq!(
            got,
            [
                None,
                Some("Ch 1"),
                Some("Ch 1"),
                Some("Ch 2"),
                Some("Ch 2"),
                Some("Part II"),
                Some("Ch 3a"),
                Some("Ch 3a")
            ]
        );
    }

    #[test]
    fn tidy_names_untitled_items() {
        let toc = tidy(vec![
            item("", Some(2), vec![]),
            item("", None, vec![]),
            item("A", None, vec![]),
        ]);
        assert_eq!(toc.len(), 2);
        assert_eq!(toc[0].title, "Seção 3");
    }
}
