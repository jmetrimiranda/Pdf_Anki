// The Leitor tab (spec 6): PdfCraft web embedded in a same-origin iframe, the bridge, autosave, progress and
// reading sessions. Contract used by the shell:
//   <LeitorHost />            rendered once inside <main>; mounts the iframe lazily and never unmounts it
//   leitor.openBook(uid, {page?, find?})  go to /leitor and open the book in PdfCraft at its last page, or at `page`
//                             (0-based) finding `find` there (pdfcraft:goto)
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
  FoundResult,
  LeitorSelection,
  LeitorSnapshot,
  MenuShown,
  PanelRequest,
  PanelRequestKind,
  PanelSelection,
} from './controller';
export type { FlushReason } from './autosave';
