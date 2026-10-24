// pt-BR strings of EPUB books around the reader (spec 7.1, 10, 12): the Leitor tab switching between the EPUB reader
// and PdfCraft, the book panel's chapter wording, and the vocabulary scan by chapters / EPUB table of contents.
// Keys start with `epub.`, `bookPanel.chapter` or `vocab.chapter`.
export const epubMessages = {
  'epub.backToPdfs': 'Voltar aos PDFs',
  'epub.backToPdfsHint': 'Mostrar os PDFs abertos no PdfCraft (o EPUB continua aberto)',
  'epub.openFailed': 'Não foi possível abrir o EPUB {titulo}.',

  'bookPanel.chapterCards': 'Cards deste capítulo (cap. {n})',
  'bookPanel.chapterCardsEmpty': 'Nenhum card deste capítulo ainda.',

  'vocab.chapter.outline': 'Por sumário',
  'vocab.chapter.ranges': 'Capítulos',
  'vocab.chapter.rangesHint': 'Um capítulo (3), um intervalo (2-4) ou uma lista (2-4, 7), na ordem do livro.',
  'vocab.chapter.allHint': 'O livro todo: {n} capítulos.',
  'vocab.chapter.outlineTree': 'Sumário do livro',
  'vocab.chapter.outlineHint': 'Marcar um item inclui os itens dentro dele; vários itens podem ser marcados.',
  'vocab.chapter.noOutline': 'Este EPUB não tem sumário.',
  'vocab.chapter.noOutlineHint': 'Escolha os capítulos pelo número, na ordem do livro.',
  'vocab.chapter.useRanges': 'Escolher capítulos',
  'vocab.chapter.itemRange': 'cap. {de}–{ate}',
  'vocab.chapter.itemNone': 'sem capítulo',
  'vocab.chapter.resolved': '{trecho} · {n} capítulos',
  'vocab.chapter.resolvedOne': '{trecho} · 1 capítulo',
  'vocab.chapter.short': 'cap. {n}',
  'vocab.chapter.scanUnits': '{feito} de {total} capítulos',
  'vocab.chapter.first': '1º cap.',
  'vocab.chapter.open': 'Abrir “{palavra}” no livro, cap. {n}',
} as const;
