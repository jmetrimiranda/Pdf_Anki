//! Size-limited LRU of encoded page images (spec 6.2: in-memory cache, 256 MB on desktop).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use crate::types::{DocHandle, ReadingTheme, RenderReq};

/// Default budget of the page image cache on desktop.
pub const DEFAULT_PAGE_CACHE_BYTES: usize = 256 * 1024 * 1024;

/// Everything that changes the bytes of a render. Floats are keyed by their bits, so only
/// identical requests hit (the web client rounds scale and tile before building URLs).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PageKey {
    doc: DocHandle,
    page: usize,
    scale: u32,
    tile: Option<[u32; 4]>,
    theme: ReadingTheme,
    preview: bool,
}

impl PageKey {
    pub(crate) fn new(doc: DocHandle, req: &RenderReq) -> Self {
        Self {
            doc,
            page: req.page,
            scale: req.scale.to_bits(),
            tile: req.tile.map(|t| t.map(f32::to_bits)),
            theme: req.theme,
            preview: req.preview,
        }
    }
}

pub(crate) struct PageCache {
    budget: usize,
    used: usize,
    tick: u64,
    entries: HashMap<PageKey, (Arc<Vec<u8>>, u64)>,
    /// Last use → key; the first entry is the least recently used.
    order: BTreeMap<u64, PageKey>,
}

impl PageCache {
    pub(crate) fn new(budget: usize) -> Self {
        Self {
            budget,
            used: 0,
            tick: 0,
            entries: HashMap::new(),
            order: BTreeMap::new(),
        }
    }

    pub(crate) fn get(&mut self, key: &PageKey) -> Option<Arc<Vec<u8>>> {
        self.tick += 1;
        let (png, stamp) = self.entries.get_mut(key)?;
        self.order.remove(stamp);
        *stamp = self.tick;
        self.order.insert(self.tick, *key);
        Some(png.clone())
    }

    pub(crate) fn insert(&mut self, key: PageKey, png: Arc<Vec<u8>>) {
        self.remove(&key);
        if png.len() > self.budget {
            return;
        }
        self.tick += 1;
        self.used += png.len();
        self.entries.insert(key, (png, self.tick));
        self.order.insert(self.tick, key);
        self.shrink();
    }

    /// Drops every image of `doc`.
    pub(crate) fn evict_doc(&mut self, doc: DocHandle) {
        let keys: Vec<_> = self
            .entries
            .keys()
            .filter(|k| k.doc == doc)
            .copied()
            .collect();
        for key in keys {
            self.remove(&key);
        }
    }

    pub(crate) fn set_budget(&mut self, budget: usize) {
        self.budget = budget;
        self.shrink();
    }

    pub(crate) fn used_bytes(&self) -> usize {
        self.used
    }

    fn shrink(&mut self) {
        while self.used > self.budget {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            if let Some((png, _)) = self.entries.remove(&oldest) {
                self.used -= png.len();
            }
        }
    }

    fn remove(&mut self, key: &PageKey) {
        if let Some((png, stamp)) = self.entries.remove(key) {
            self.order.remove(&stamp);
            self.used -= png.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(doc: u64, page: usize) -> PageKey {
        PageKey::new(DocHandle(doc), &RenderReq::page(page, 1.0))
    }

    fn png(len: usize) -> Arc<Vec<u8>> {
        Arc::new(vec![0; len])
    }

    #[test]
    fn evicts_least_recently_used_within_budget() {
        let mut c = PageCache::new(30);
        c.insert(key(1, 0), png(10));
        c.insert(key(1, 1), png(10));
        c.insert(key(1, 2), png(10));
        assert!(c.get(&key(1, 0)).is_some());
        c.insert(key(1, 3), png(10));
        assert!(
            c.get(&key(1, 1)).is_none(),
            "page 1 was the least recently used"
        );
        assert!(c.get(&key(1, 0)).is_some());
        assert!(c.get(&key(1, 2)).is_some());
        assert!(c.get(&key(1, 3)).is_some());
        assert_eq!(c.used_bytes(), 30);
    }

    #[test]
    fn replaces_and_skips_oversized() {
        let mut c = PageCache::new(30);
        c.insert(key(1, 0), png(10));
        c.insert(key(1, 0), png(20));
        assert_eq!(c.used_bytes(), 20);
        c.insert(key(1, 1), png(31));
        assert!(c.get(&key(1, 1)).is_none());
        assert_eq!(c.used_bytes(), 20);
    }

    #[test]
    fn keys_differ_by_every_render_parameter() {
        let base = RenderReq::page(0, 1.0);
        let doc = DocHandle(1);
        let variants = [
            RenderReq { scale: 2.0, ..base },
            RenderReq {
                tile: Some([0.0, 0.0, 10.0, 10.0]),
                ..base
            },
            RenderReq {
                theme: ReadingTheme::Dark,
                ..base
            },
            RenderReq {
                preview: true,
                ..base
            },
        ];
        for v in variants {
            assert_ne!(PageKey::new(doc, &base), PageKey::new(doc, &v), "{v:?}");
        }
    }

    #[test]
    fn evicts_a_closed_document_and_shrinks_with_the_budget() {
        let mut c = PageCache::new(100);
        c.insert(key(1, 0), png(10));
        c.insert(key(2, 0), png(10));
        c.insert(key(1, 1), png(10));
        c.evict_doc(DocHandle(1));
        assert_eq!(c.used_bytes(), 10);
        assert!(c.get(&key(2, 0)).is_some());
        c.set_budget(5);
        assert_eq!(c.used_bytes(), 0);
    }
}
