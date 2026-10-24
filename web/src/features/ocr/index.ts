// Text recognition (spec 6.6, 7.2). Contract used by the other features:
//   <OcrPanelNotice uid />   book panel: "Este livro parece escaneado." + "Reconhecer texto", or the job's progress;
//                            renders null for EPUBs, books with text and no book
//   <OcrDialog book onClose /> the "Reconhecer texto" dialog (English-only notice, estimate, start)
//   <OcrProgress state title onCancel /> compact progress line with "Cancelar"
//   useOcrJob(uid, {enabled}) one book's job: state, start (flushes PdfCraft's saves first), cancel, resume on mount
//   ocrEligible(book)        PDF without text, or whose last OCR failed / is running
//   /biblioteca?ocr=<uid>    opens the dialog for that book (LibraryPage)
export { OcrDialog, ocrEstimateText } from './OcrDialog';
export { OcrPanelNotice } from './OcrPanelNotice';
export { OcrProgress, ocrProgressText } from './OcrProgress';
export { DEFAULT_MS_PER_PAGE, estimateMinutes, msPerPage, ocrStore, type OcrJobState, type OcrPhase } from './store';
export { ocrBusy, ocrEligible, ocrInfoKey, useOcrJob, type OcrJob } from './useOcrJob';
