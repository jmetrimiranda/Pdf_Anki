// pt-BR strings of the library sync between devices (spec 16, Fase 9a): the card in Configurações → Anki e
// sincronização and the "Baixar" of the library. Keys start with `librarySync.`.
export const librarySyncMessages = {
  'librarySync.title': 'Biblioteca entre aparelhos',
  'librarySync.hint':
    'Livros, posição de leitura, destaques e anotações de EPUB, palavras marcadas e respostas extras dos cards de código vão para o seu servidor e voltam nos outros PCs. Os cards e as revisões vão pela sincronização do Anki, acima.',
  'librarySync.url': 'Servidor da biblioteca',
  'librarySync.urlPlaceholder': 'https://leitor-sync.seu-dominio.com',
  'librarySync.user': 'Usuário da biblioteca',
  'librarySync.password': 'Senha da biblioteca',
  'librarySync.device': 'Nome deste aparelho',
  'librarySync.deviceHint': 'Aparece no servidor e no nome das cópias de conflito.',
  'librarySync.connect': 'Conectar este aparelho',
  'librarySync.connected': 'Aparelho conectado. A primeira sincronização só baixa: nada do servidor é sobrescrito.',
  'librarySync.empty': 'Preencha o endereço, o usuário e a senha.',
  'librarySync.as': '{usuario} em {servidor} · este aparelho: {aparelho}',
  'librarySync.never': 'Ainda não sincronizou.',
  'librarySync.now': 'Sincronizar agora',
  'librarySync.running': 'Sincronizando…',
  'librarySync.disconnect': 'Desconectar',
  'librarySync.disconnected': 'Aparelho desconectado do servidor da biblioteca.',
  'librarySync.done': 'Biblioteca sincronizada.',
  'librarySync.stage.files': 'Enviando livros',
  'librarySync.stage.pull': 'Recebendo mudanças',
  'librarySync.stage.push': 'Enviando mudanças',
  'librarySync.stage.download': 'Baixando livro',
  'librarySync.conflicts':
    'Livros mudados em dois aparelhos ao mesmo tempo: a versão daqui foi guardada como cópia (nada se perde):',
  'librarySync.when': 'Sincroniza ao abrir o app, ao fechar um livro e a cada 5 minutos.',

  'librarySync.download': 'Baixar',
  'librarySync.downloadLabel': 'Baixar "{titulo}" do servidor',
  'librarySync.notHere': 'No servidor',
  'librarySync.downloading': 'Baixando "{titulo}"…',
  'librarySync.downloaded': '"{titulo}" baixado.',
} as const;
