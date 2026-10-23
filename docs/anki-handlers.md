# Ponte `/_anki/` — decisão por método

As páginas web do Anki (opções do deck, estatísticas, informações do card, importação, trocar tipo de nota,
oclusão de imagem, "parabéns") e os cards falam com o núcleo por `POST /_anki/<método>`, com o corpo em protobuf.
No Anki desktop quem atende é o `qt/aqt/mediasrv.py` (tag `26.09.3`, linhas 1131-1348). No Leitor quem atende é a
ponte do `core-anki` (`src-tauri/crates/core-anki/src/bridge/`), que não sabe nada de HTTP: o crate `app` transforma
as requisições dos protocolos `anki` e `card` num `PostRequest` e devolve o `PostReply`.

Este arquivo é conferido por um teste (`tests/bridge.rs`, `docs_parity`): os nomes entre crases das duas tabelas têm
de ser exatamente os de `POST_HANDLERS` e `EXPOSED_METHODS`, e as colunas "Decisão" e "Permitido no card" têm de bater
com o código.

## Regras gerais

- **Onde roda.** Os métodos "repassar ao backend" são despachados **pelo nome** para o método do trait de serviço
  gerado pelo `rslib` (`anki::services::<Serviço>::<método>`), executado no ator que possui a coleção
  (`AnkiService::call`). Não usamos índices numéricos de serviço/método (ver `docs/decisoes.md`). As chamadas pesadas
  das páginas (`computeFsrsParams`, `computeOptimalRetention`, `simulateFsrs*`, `evaluateParamsLegacy`, `graphs`)
  também passam pelo ator, mas a resposta é aguardada de forma assíncrona e não trava o runtime.
- **`Content-Type`.** Tem de ser exatamente `application/binary` (como no Anki); qualquer outro valor, inclusive com
  parâmetros (`application/binary; charset=…`) ou ausente, recebe **403**.
- **Dois chamadores.**
  - **Página** (protocolo `anki`): o cabeçalho `Origin`, quando existe, tem de ser `anki://localhost` ou
    `http://anki.localhost` (Windows); outra origem recebe **403**. Nome conhecido é atendido conforme as tabelas;
    nome desconhecido recebe **404**.
  - **Card** (protocolo `card`): só os quatro métodos marcados "sim" na coluna "Permitido no card"
    (`getSchedulingStatesWithContext`, `setSchedulingStates`, `i18nResources`, `congratsInfo`). Qualquer outro nome,
    inclusive um que não existe, recebe **403** (nunca 404), para um card não descobrir o que existe.
- **Tamanho.** Corpo acima de 64 MiB recebe **413**.
- **Respostas.** Saída vazia → **204** (`text/plain`, corpo vazio); saída com bytes → **200**
  `application/binary`. Erro do `rslib` → **500** com a mensagem traduzida (pt-BR) no corpo; a interrupção pedida
  pelo usuário devolve o texto `Interrupted`, que o cliente TypeScript do Anki trata à parte (`500: Interrupted`).
  Corpo que não decodifica (bytes aleatórios, protobuf truncado) → **500** com a mensagem, nunca pânico.
- **`Anki-Op-Changes`.** Quando a página manda esse cabeçalho com `1`, `2` ou `3` e a chamada deu certo, a saída é
  lida como `OpChanges`, `OpChangesOnly` ou `NestedOpChanges` e, se alguma marca de mudança estiver ligada, a ponte
  emite o evento `Changed` para as outras telas se atualizarem (equivale ao `on_op_finished` do desktop).
- **Eventos.** A ponte avisa o app por eventos (`BridgeEvent`): `close`, `ready`, `importDone`, `searchInBrowser`,
  `changed`, `openLink` e `error`; o app os repassa à interface no evento `anki://page`.
- **Limitação conhecida: progresso.** O ator possui o `Collection` (não o `Backend`), então `latestProgress` devolve
  sempre um progresso vazio (a barra das páginas fica indeterminada). `setWantsAbort` é atendido fora do ator, pela
  flag compartilhada `want_abort`, e funciona mesmo com uma operação longa ocupando o ator.

## Tabela 1 — os 32 handlers especiais (`post_handler_list`, `mediasrv.py:1131-1164`)

| # | Método | O que o Anki desktop faz | Decisão | Permitido no card | Observação |
|---|---|---|---|---|---|
| 1 | `congratsInfo` | Volta a janela principal para a visão geral se ainda há cards e devolve `congrats_info` do backend. | repassar ao backend | sim | `SchedulerService::congrats_info`; usa o deck atual (o app chama `set_current_deck` antes de abrir a página). |
| 2 | `getDeckConfigsForUpdate` | Chama o backend direto. | repassar ao backend | não | `DeckConfigService::get_deck_configs_for_update`. |
| 3 | `updateDeckConfigs` | Roda a operação em segundo plano com diálogo de progresso e responde vazio na hora; fecha as opções no sucesso (exceto "otimizar todos"). | implementar no app | não | Responde 204 na hora e roda `DeckConfigService::update_deck_configs` no ator numa thread; no sucesso emite `Changed` e, se o modo não for `COMPUTE_ALL_PARAMS`, `Close`; na falha emite `Error` com a mensagem. |
| 4 | `getSchedulingStatesWithContext` | Devolve os estados de agendamento do card mostrado no revisor. | implementar no app | sim | `FrontendService` não existe no `rslib`; vem de `Study::states_with_context()`. Sem card em estudo: 500 "Nenhum card em estudo.". |
| 5 | `setSchedulingStates` | Troca os estados do revisor se a chave da sessão confere. | implementar no app | sim | `Study::set_states`; chave errada ou card antigo é ignorado (204), como no Python. |
| 6 | `changeNotetype` | Repassa ao diálogo aberto, que confirma a mudança de esquema, acrescenta os ids das notas e troca o tipo. | implementar no app | não | Os ids vêm do app (`Bridge::set_change_notetype_notes`, a confirmação é feita pela interface antes de abrir a página); sem ids: 500. Depois `NotetypesService::change_notetype`, eventos `Changed` + `Close`. |
| 7 | `importDone` | Deixa o diálogo de importação não modal. | implementar no app | não | 204 + eventos `ImportDone` e `Changed` (a importação muda a coleção). |
| 8 | `importDialogRequireClose` | Fecha o diálogo de importação. | implementar no app | não | Evento `Close` (botão OK da caixa de erro das páginas de importação). |
| 9 | `searchInBrowser` | Abre o Navegador com o `SearchNode`. | implementar no app | não | `SearchService::build_search_string` no ator e evento `SearchInBrowser` com o texto; o app abre a tela Navegar. |
| 10 | `deckOptionsRequireClose` | Fecha à força as opções do deck. | implementar no app | não | Evento `Close`. |
| 11 | `deckOptionsReady` | Marca o diálogo como pronto (a partir daí fechar pergunta à página). | implementar no app | não | Evento `Ready`. |
| 12 | `getProfileConfigJson` | Lê uma chave do perfil. | 404 | não | Só o editor do Anki usa; não servimos a rota `editor`. |
| 13 | `setProfileConfigJson` | Grava uma chave do perfil. | 404 | não | Só o editor (cores dos botões). |
| 14 | `getMetaJson` | Lê do armazenamento global do perfil. | 404 | não | Só o editor. |
| 15 | `setMetaJson` | Grava no armazenamento global do perfil. | 404 | não | Só o editor. |
| 16 | `getConfigJson` | Lê uma chave da configuração da coleção; chave ausente devolve JSON `null`. | implementar no app | não | Envolve `ConfigService::get_config_json`; `NotFound` vira `Json{json:"null"}` (o backend daria erro). Usado por `preferences`. |
| 17 | `convertPastedImage` | Recodifica uma imagem colada com o `QImage`. | 404 | não | Só o editor; o nosso editor trata imagem colada sozinho. |
| 18 | `openFilePicker` | Abre o diálogo de arquivo nativo. | 404 | não | Só o editor chama. |
| 19 | `openMedia` | Abre a mídia no visualizador do sistema. | 404 | não | Só o editor. |
| 20 | `showInMediaFolder` | Mostra o arquivo no gerenciador de arquivos. | 404 | não | Só o editor. |
| 21 | `recordAudio` | Grava áudio pelo Qt. | 404 | não | Só o editor. |
| 22 | `playFile` | Toca uma mídia pelo player do Anki. | 404 | não | Só o editor; os cards tocam áudio pelo app (seção 8.4). |
| 23 | `readClipboard` | Lê a área de transferência do Qt. | 404 | não | Só o editor. |
| 24 | `writeClipboard` | Escreve na área de transferência. | 404 | não | Só o editor. |
| 25 | `closeAddCards` | Fecha "Adicionar" se o usuário descarta. | 404 | não | Não reaproveitamos o editor do Anki. |
| 26 | `closeEditCurrent` | Fecha "Editar atual". | 404 | não | Não reaproveitamos o editor do Anki. |
| 27 | `openLink` | Abre um link no navegador externo. | implementar no app | não | Evento `OpenLink` só para `http://`/`https://`; outros esquemas são ignorados (204). |
| 28 | `askUser` | Diálogo sim/não. | 404 | não | Só o editor. |
| 29 | `showMessageBox` | Caixa de mensagem. | 404 | não | Só o editor. |
| 30 | `openFieldsDialog` | Abre o diálogo de campos a partir do editor. | 404 | não | Só o editor. |
| 31 | `openCardsDialog` | Abre o layout dos cards a partir do editor. | 404 | não | Só o editor. |
| 32 | `saveCustomColours` | Grava a paleta de cores do `QColorDialog`. | implementar no app | não | Não faz nada e responde 204: a oclusão de imagem chama a cada troca de cor e um 404 viraria `alert()`. |

## Tabela 2 — os 55 métodos expostos (`exposed_backend_list`, `mediasrv.py:1167-1238`)

O serviço é o do `.proto` (conferido em `proto/anki/*.proto`), não o comentário do Python: `getDeckNames`/`getDeck`
são de `DecksService`, `getFieldNames` e `updateNotetype` de `NotetypesService`, `setWantsAbort` de
`CollectionService` e `addMediaFromUrl` de `BackendMediaService`.

Coluna "Requisição do teste": o teste usa a requisição **gravada** das páginas reais
(`tests/fixtures/bridge/<método>.bin`, produzida por `scripts/record-anki-posts.sh`) quando ela existe e, senão, uma
requisição **montada** com prost sobre a coleção de teste (`core_anki::fixture`).

| Método | Serviço proto | Decisão | Permitido no card | Requisição do teste (gravada / montada) |
|---|---|---|---|---|
| `latestProgress` | `CollectionService` | implementar no app | não | montada (vazia); atendido fora do ator, devolve progresso vazio (204) |
| `getCustomColours` | `CollectionService` | repassar ao backend | não | gravada se houver, senão montada (vazia) |
| `getDeckNames` | `DecksService` | repassar ao backend | não | gravada se houver, senão montada |
| `getDeck` | `DecksService` | repassar ao backend | não | gravada se houver, senão montada (deck da coleção de teste) |
| `i18nResources` | `I18nService` | repassar ao backend | sim | gravada se houver, senão montada (módulos do revisor) |
| `getCsvMetadata` | `ImportExportService` | repassar ao backend | não | gravada se houver, senão montada (CSV temporário) |
| `getImportAnkiPackagePresets` | `ImportExportService` | repassar ao backend | não | gravada se houver, senão montada (vazia) |
| `importCsv` | `ImportExportService` | repassar ao backend | não | gravada se houver, senão montada (CSV temporário) |
| `importAnkiPackage` | `ImportExportService` | repassar ao backend | não | gravada se houver, senão montada (`.apkg` exportado da coleção de teste) |
| `importJsonFile` | `ImportExportService` | repassar ao backend | não | gravada se houver, senão montada (JSON temporário) |
| `importJsonString` | `ImportExportService` | repassar ao backend | não | gravada se houver, senão montada |
| `getFieldNames` | `NotetypesService` | repassar ao backend | não | gravada se houver, senão montada |
| `getNote` | `NotesService` | repassar ao backend | não | gravada se houver, senão montada |
| `newNote` | `NotesService` | repassar ao backend | não | gravada se houver, senão montada |
| `noteFieldsCheck` | `NotesService` | repassar ao backend | não | gravada se houver, senão montada |
| `defaultsForAdding` | `NotesService` | repassar ao backend | não | gravada se houver, senão montada |
| `defaultDeckForNotetype` | `NotesService` | repassar ao backend | não | gravada se houver, senão montada |
| `addNote` | `NotesService` | repassar ao backend | não | gravada se houver, senão montada |
| `updateNotes` | `NotesService` | repassar ao backend | não | gravada se houver, senão montada |
| `updateNotetype` | `NotetypesService` | repassar ao backend | não | gravada se houver, senão montada |
| `getNotetype` | `NotetypesService` | repassar ao backend | não | gravada se houver, senão montada |
| `getNotetypeNames` | `NotetypesService` | repassar ao backend | não | gravada se houver, senão montada (vazia) |
| `getChangeNotetypeInfo` | `NotetypesService` | repassar ao backend | não | gravada se houver, senão montada |
| `getClozeFieldOrds` | `NotetypesService` | repassar ao backend | não | gravada se houver, senão montada |
| `cardStats` | `StatsService` | repassar ao backend | não | gravada se houver, senão montada |
| `getReviewLogs` | `StatsService` | repassar ao backend | não | gravada se houver, senão montada |
| `graphs` | `StatsService` | repassar ao backend | não | gravada se houver, senão montada |
| `getGraphPreferences` | `StatsService` | repassar ao backend | não | gravada se houver, senão montada (vazia) |
| `setGraphPreferences` | `StatsService` | repassar ao backend | não | gravada se houver, senão montada |
| `completeTag` | `TagsService` | repassar ao backend | não | gravada se houver, senão montada |
| `getImageForOcclusion` | `ImageOcclusionService` | repassar ao backend | não | gravada se houver, senão montada (imagem temporária) |
| `addImageOcclusionNote` | `ImageOcclusionService` | repassar ao backend | não | gravada se houver, senão montada |
| `getImageOcclusionNote` | `ImageOcclusionService` | repassar ao backend | não | gravada se houver, senão montada |
| `updateImageOcclusionNote` | `ImageOcclusionService` | repassar ao backend | não | gravada se houver, senão montada |
| `getImageOcclusionFields` | `ImageOcclusionService` | repassar ao backend | não | gravada se houver, senão montada |
| `computeFsrsParams` | `SchedulerService` | repassar ao backend | não | gravada se houver, senão montada |
| `computeOptimalRetention` | `SchedulerService` | repassar ao backend | não | gravada se houver, senão montada |
| `setWantsAbort` | `CollectionService` | implementar no app | não | montada (vazia); atendido fora do ator (`AnkiService::request_abort`) |
| `evaluateParamsLegacy` | `SchedulerService` | repassar ao backend | não | gravada se houver, senão montada |
| `getOptimalRetentionParameters` | `SchedulerService` | repassar ao backend | não | gravada se houver, senão montada |
| `simulateFsrsReview` | `SchedulerService` | repassar ao backend | não | gravada se houver, senão montada |
| `simulateFsrsWorkload` | `SchedulerService` | repassar ao backend | não | gravada se houver, senão montada |
| `getIgnoredBeforeCount` | `DeckConfigService` | repassar ao backend | não | gravada se houver, senão montada |
| `getRetentionWorkload` | `DeckConfigService` | repassar ao backend | não | gravada se houver, senão montada |
| `encodeIriPaths` | `CardRenderingService` | repassar ao backend | não | gravada se houver, senão montada |
| `decodeIriPaths` | `CardRenderingService` | repassar ao backend | não | gravada se houver, senão montada |
| `htmlToTextLine` | `CardRenderingService` | repassar ao backend | não | gravada se houver, senão montada |
| `setConfigJson` | `ConfigService` | repassar ao backend | não | gravada se houver, senão montada |
| `getConfigBool` | `ConfigService` | repassar ao backend | não | gravada se houver, senão montada |
| `addMediaFile` | `MediaService` | repassar ao backend | não | gravada se houver, senão montada |
| `addMediaFromPath` | `MediaService` | repassar ao backend | não | gravada se houver, senão montada (arquivo temporário) |
| `addMediaFromUrl` | `BackendMediaService` | 404 | não | montada; só existe no `Backend` (o ator possui o `Collection`) e só o editor usa |
| `getAbsoluteMediaPath` | `MediaService` | repassar ao backend | não | gravada se houver, senão montada |
| `extractMediaFiles` | `MediaService` | repassar ao backend | não | gravada se houver, senão montada |
| `getCard` | `CardsService` | repassar ao backend | não | gravada se houver, senão montada |

## Qualquer outro nome

Página: **404**. Card: **403**.

## Segurança

`importAnkiPackage`, `importCsv`, `importJsonFile`, `addMediaFromPath` e `getAbsoluteMediaPath` recebem caminhos do
sistema de arquivos vindos da página. Por isso só a origem `anki` (código do próprio Anki, embutido no app) pode
chamá-los; HTML de decks roda na origem `card`, que só alcança os quatro métodos marcados acima.
