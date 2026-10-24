// The Leitor tab (spec 6): PdfCraft web embedded in a same-origin iframe, the bridge, autosave, progress and
// reading sessions. Contract used by the shell:
//   <LeitorHost />            rendered once inside <main>; mounts the iframe lazily and never unmounts it
//   leitor.openBook(uid, {page?, find?, cfi?})  go to /leitor and open the book at its last place, or at `page`
//                             (0-based; an EPUB's section) / `cfi` (EPUB) finding `find` there. PDFs open in
//                             PdfCraft, EPUBs in the EPUB reader (spec 7.1); the snapshot's `front` says which shows
//   leitor.showFront(front)   "Voltar aos PDFs" / back to the EPUB (the other reader stays loaded)
//   leitor.reloadPdfcraftBook(uid)  after OCR: save, recreate PdfCraft and reopen its books (spec 7.2)
//   leitor.togglePanel()      show/hide the "Painel Anki do livro" (Ctrl+Shift+P)
//   leitor.flushSaves(reason) save every book with edits now; true when all were stored
//   leitor.requestCardFromSelection(via)  "Card da seleção": opens the panel with the form (PanelRequest kind 'card')
//   leitor.onPanelRequest(cb) the panel's listener (PdfCraft menu items, shortcuts); returns unsubscribe
//   leitor.setReviewing(on)   the panel's mini-review is open: reading session paused (reason 'review')
//   useLeitorState()          snapshot of the tab's state (active book, page, status, selection, found…)
//   useLeitorSelector(sel, eq) a slice of it (re-renders only when the slice changes)
export { LeitorHost } from './LeitorHost';
export { leitor, useLeitorSelector, useLeitorState } from './instance';
export type {
  EpubDrawer,
  EpubFront,
  EpubLocation,
  EpubSelectionInfo,
  EpubState,
  FoundResult,
  LeitorFront,
  OpenOptions,
  LeitorSelection,
  LeitorSnapshot,
  MenuShown,
  PanelRequest,
  PanelRequestKind,
  PanelSelection,
} from './controller';
export type { FlushReason } from './autosave';
