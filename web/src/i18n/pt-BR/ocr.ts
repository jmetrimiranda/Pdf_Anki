// pt-BR strings of text recognition (spec 6.6 "parece escaneado", 7.2 OCR) and of the library's EPUB items
// (format badge, import hints). Keys start with `ocr.`.
export const ocrMessages = {
  'ocr.action': 'Reconhecer texto',
  'ocr.title': 'Reconhecer texto',
  'ocr.body':
    'O reconhecimento de texto (OCR) lê livros escaneados em inglês. Ele reconhece o alfabeto latino sem acentos: livros em português não ficam corretos.',
  'ocr.estimate': 'Leva alguns segundos por página — cerca de {n} min para este livro.',
  'ocr.estimateShort': 'Leva alguns segundos por página — menos de 1 min para este livro.',
  'ocr.versionNote':
    'O app salva uma nova versão do PDF com o texto reconhecido. O livro continua o mesmo, com as anotações, o progresso e os cards.',
  'ocr.backgroundNote': 'Você pode continuar lendo enquanto isso.',
  'ocr.notPdf': 'O reconhecimento de texto só funciona em PDFs escaneados.',
  'ocr.unavailable': 'Os modelos de reconhecimento de texto (OCR) não estão instalados. Reinstale o app.',
  'ocr.start': 'Reconhecer texto',
  'ocr.startFailed': 'Não foi possível iniciar o reconhecimento de texto: {mensagem}',

  'ocr.scanned': 'Parece escaneado',
  'ocr.scannedHint': 'Sem texto selecionável. Use “Reconhecer texto” para buscar, selecionar e escanear o vocabulário.',
  'ocr.panelScanned': 'Este livro parece escaneado.',
  'ocr.panelScannedHint': 'Reconheça o texto para buscar, selecionar e escanear o vocabulário.',

  'ocr.progressLabel': 'Progresso do reconhecimento de texto',
  'ocr.queued': 'Na fila',
  'ocr.queuedHint': 'Começa quando o reconhecimento do livro anterior terminar.',
  'ocr.starting': 'Preparando o reconhecimento…',
  'ocr.page': 'Reconhecendo texto… página {n} de {total}',
  'ocr.writing': 'Salvando a nova versão…',
  'ocr.cancel': 'Cancelar',
  'ocr.cancelLabel': 'Cancelar o reconhecimento de texto de {titulo}',
  'ocr.done': 'Texto reconhecido: agora dá para buscar, selecionar e escanear o vocabulário deste livro.',
  'ocr.failed': 'O reconhecimento de texto falhou: {mensagem}',
  'ocr.failedShort': 'O reconhecimento de texto falhou.',
  'ocr.cancelled': 'Reconhecimento de texto cancelado. Nada mudou no livro.',

  'ocr.library.epub': 'EPUB',
  'ocr.library.formatLabel': 'Formato: {formato}',
  'ocr.library.emptyHint': 'Adicione um PDF ou EPUB do seu computador ou arraste o arquivo para esta janela.',
  'ocr.library.dropHint': 'Arquivos PDF e EPUB são copiados para a pasta do app.',
  'ocr.library.percentRead': '{pct}% lido',
  'ocr.library.unsupported': 'Formato não suportado. A biblioteca aceita arquivos PDF e EPUB.',
} as const;
