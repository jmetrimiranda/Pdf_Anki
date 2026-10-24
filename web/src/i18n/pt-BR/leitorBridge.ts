// pt-BR strings of the Leitor bridge v2 (spec 5.1, 6.2, 10.2): the items the app adds to PdfCraft's own selection
// menu, "Abrir no livro"/deep link notices and the shortcut notes. Keys start with `leitor.` or `shortcuts.`.
export const leitorBridgeMessages = {
  'leitor.menu.card': 'Criar card',
  'leitor.menu.ai': 'Criar cards com IA',
  'leitor.menu.define': 'Definir palavra',

  'leitor.gotoNotFound': 'O trecho não foi encontrado na página {pagina}.',
  'leitor.deepLinkUnknownBook': 'Este livro não está na Biblioteca deste computador.',
  'leitor.deepLinkFailed': 'Não foi possível abrir o link do livro.',

  'reader.reloadedAfterOcr': 'O livro foi reaberto com o texto reconhecido.',

  'shortcuts.cardFromSelectionNote':
    'Dentro do leitor, Ctrl+Shift+N é o “Ir para a página” do PdfCraft: lá use Alt+C ou o item “Criar card” do menu da seleção. Alt+C funciona em qualquer lugar.',
} as const;
