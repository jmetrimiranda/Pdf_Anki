// The Leitor tab (spec 6): PdfCraft web embedded in a same-origin iframe, the bridge, autosave, progress and
// reading sessions. Contract used by the shell:
//   <LeitorHost />            rendered once inside <main>; mounts the iframe lazily and never unmounts it
//   leitor.openBook(uid)      go to /leitor and open the book in PdfCraft at its last page
//   leitor.togglePanel()      show/hide the "Painel Anki do livro" (Ctrl+Shift+P)
//   leitor.flushSaves(reason) save every book with edits now; true when all were stored
//   useLeitorState()          snapshot of the tab's state (active book, page, status…)
export { LeitorHost } from './LeitorHost';
export { leitor, useLeitorState } from './instance';
export type { LeitorSnapshot } from './controller';
export type { FlushReason } from './autosave';
