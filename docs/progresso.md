# Progresso

Legenda: ✅ feito · 🔶 parcial · ⬜ pendente · ⏸️ ADIADO (iOS/iPad, decisão de 22/10/2026 em `docs/decisoes.md`) · 🌐 [VPS] (depende dos serviços no VPS)

## Fase 0 — Fundação e prova de integração

- ✅ O app compila e roda no Linux com o `rslib` (com `rustls`) e o motor do PdfCraft linkados. *(substitui o critério de iOS; Windows fora do escopo desde 23/10/2026)* — devcontainer e CI Linux verdes; app sob Xvfb.
- ⏸️ Compila para iOS (dispositivo e simulador).
- ⏸️ No simulador de iOS, o `rslib` faz login e sincroniza por HTTPS.
- ✅ O `rslib` faz login e sincroniza por HTTPS com um servidor de teste local com certificado de desenvolvimento (TLS). *(verificado na Fase 3)* — `core-anki/tests/sync_server.rs::tls_with_dev_ca_logs_in_and_syncs` contra `https://ankisync-dev-tls:8443/` (Caddy + CA de desenvolvimento de `scripts/ankisync-dev-certs.sh`, servidor oficial `anki==26.9.3`); negativos `tls_without_ca_or_with_untrusted_ca_is_rejected` (sem a CA e com uma CA sem relação → `anki.sync.tlsUntrusted`); app `tests/sync.rs` (login com a CA ok, sem a CA → `anki_sync_tls_untrusted`).
- ✅ Um comando de teste no app abre uma coleção, mostra a árvore de decks, abre um PDF e mostra a página 1. (`/dev/smoke` e `leitor-estudos --smoke`; captura em `docs/capturas/fase-0/dev-smoke.png`)
- 🔶 `/dev/ui` com todos os componentes nos temas claro e escuro — pronto (`docs/capturas/fase-0/dev-ui.png`); aguardando a aprovação visual do usuário.

## Fase 1 — Leitor (PdfCraft embutido) e biblioteca

Critérios reescritos na especificação 1.1 (seção 21). No iPad, os critérios de interface ficam ⏸️ (adiados).

- ✅ A tela de leitura é o PdfCraft sem alterações visuais. Playwright `e2e/bridge/visual.spec.ts`: o retângulo do iframe no app comparado com `/pdfcraft/index.html` sozinho, mesmo PDF e mesmo tamanho: **0 px diferentes** no Chromium (960×776) e no WebKit (1920×1552, DPR 2); imagens e diff em `web/test-results/visual/`. App real: `docs/capturas/fase-1/leitor.png` (livro aberto) e `leitor-vazio.png` (tela inicial do PdfCraft).
- ✅ Destacar, comentar, bookmark, busca, miniaturas e cores de leitura dentro do app; fechar e reabrir mantém tudo e o `book_uid`.
  - Automático (Playwright ponte, Chromium e WebKit): destaque real arrastado no canvas + nota "Nota E2E" + marcador "Marcador E2E" → salvamento automático → os bytes salvos têm `/Annots`, `/Outlines` e `LeitorBookUid` = id → reinício → reabre com o mesmo `book_uid` e na última página. PDF pré-anotado (destaque + sumário) sobrevive a salvar → reiniciar → reabrir. Rust (`app/tests/library.rs`): versão anotada gravada, `AppState` recriado → `book_bytes` iguais, `book_uid` igual, `file_version` 2, posição mantida.
  - App real (Linux, WebKitGTK sob Xvfb, guiado com `xdotool`): rolagem → `pdfcraft:page` → posição p. 4; bookmark pelo painel Bookmarks → `dirty` → salvamento após 10 s → `v2` com `LeitorBookUid`; destaque com a ferramenta de destaque → `v3` com `/Highlight`; miniaturas (painel Pages), busca (`Ctrl+F` "chapter": 1125 resultados, atalho não roubado) e tema escuro do PdfCraft funcionando. Depois de fechar e reabrir: destaque, bookmark "Untitled" p. 4 e tema escuro presentes, aberto na p. 4. `sqlite3`: `book_uid` `0e3233d3…71ee` igual, `file_version` 1 → 2 → 3, `file_hash` novo a cada versão.
  - Manual que falta (Linux com GPU, pelo usuário): digitar uma nota num comentário no app real. Limitação conhecida: preferências do PdfCraft mudadas nos 30 s antes de fechar se perdem (eframe; ver `docs/decisoes.md`).
- ✅ Abrir um livro pela Biblioteca abre no PdfCraft na última página lida. Playwright ponte: livro com posição p. 5 → `pdfcraft:active` com `page` 5; rolar → `positionSet` → recarregar → reabre na última página. Vitest: `openBook` manda `open{id,page}` vindo de `bookOpen`. Rust: `position_set/get` persistem entre reinícios. App real: `/leitor?livro=<uid>` reabre na p. 4 depois de reiniciar.
- ✅ Um PDF de 500 páginas abre e rola no app com desempenho igual ao do PdfCraft web sozinho. PDF de 500 páginas gerado (não versionado); "sozinho" = `web/e2e/bridge/harness.html` (o PdfCraft web num iframe da mesma origem, sem o app), com o iframe do mesmo tamanho do iframe do app (960 × 776); medianas de 3 rodadas depois de 1 de aquecimento; critério app ≤ sozinho × 1,15 + 50 ms.
  - **App real (WebKitGTK 2.50.6 sob Xvfb, Mesa)** — `scripts/perf-real-app.sh` (build debug do app + sonda `LEITOR_BRIDGE_PROBE=perf`; os dois cenários rodam no mesmo webview do app; rolagem com 1200 passos sintéticos de roda no canvas do PdfCraft, da p. 1 à p. 498; tempos de quadro medidos dentro do iframe):

    | medida (mediana) | PdfCraft sozinho | app |
    |---|---|---|
    | open → `active` | 227 ms | 234 ms |
    | rolagem, quadro p50 / p95 | 19 / 22 ms | 18 / 21 ms |
    | quadros longos (> 50 ms) | 0 | 0 |

  - **Playwright WebKit** (`LEITOR_PERF=1 pnpm --dir web e2e:perf`, projeto `perf-webkit`, WebKit 27.2 do Playwright, rolagem de 200 páginas; execução de 22/10/2026 na checagem final):

    | medida (mediana) | PdfCraft sozinho | app |
    |---|---|---|
    | open → `active` | 136 ms | 86 ms |
    | open → quadro estável | 743 ms | 651 ms |
    | rolagem, quadro p50 / p95 | 32 / 35 ms | 33 / 37 ms |
    | quadros longos | 0 | 0 (em execuções anteriores houve picos nos dois lados: ruído do WebKit headless sem GPU) |
    | memória WebAssembly | 21 MB | 25,9 MB |

  - **Playwright Chromium com SwiftShader** (mesmo comando, projeto `perf-chromium`, mesma execução):

    | medida (mediana) | PdfCraft sozinho | app |
    |---|---|---|
    | open → `active` | 229,2 ms | 47,2 ms |
    | open → quadro estável | 538,3 ms | 553,7 ms |
    | rolagem de 200 páginas, quadro p50 / p95 | 16,7 / 33,4 ms | 16,7 / 33,4 ms |
    | quadros longos | 0 | 0 |
    | memória WebAssembly | 18,1 MB | 18,1 MB |
    | heap JS | 9,5 MB | 48,1 MB (o iframe divide o heap com o React e o núcleo simulado) |

  - Ressalvas: no app real a interface veio do Vite (`devUrl`, sem recarga automática) e o núcleo é o build debug otimizado do workspace; o PdfCraft web é o mesmo build release do `trunk` nos dois cenários. A rolagem é sintética (no devcontainer não há `xdotool`). Falta medir num Linux com GPU real e no Windows (WebView2).
  Núcleo: `core-pdf` com 500 páginas geradas (inspect + open + `text_stats(40)` + capa) em 300 ms (release).
- ✅ Sessões de leitura conforme a seção 6.4. `core-store` (`tests/sessions.rs`, 13 testes com `ManualClock`): batimento 30 s, inatividade 2 min fecha na última atividade, parada por aba/livro/segundo plano/fechar, < 1 min descartada, > 12 h dividida, recuperação depois de queda pelo último batimento, troca de livro. App: os comandos dirigem o rastreador. Vitest: início ao ativar, batimento só com o Leitor visível + página visível + livro ativo, motivos de parada. Playwright ponte: sair da aba Leitor dá `readingSessionStop('tab')` e o iframe continua vivo. App real: sessão aberta ao abrir o livro e recuperada (descartada, < 1 min) no reinício seguinte.
- ✅ Um PDF corrompido mostra erro e não derruba o app. `core-pdf`: laço de truncamentos, lixo e zero páginas dão `Err` sem pânico; app: `library_add` de corrompido → `pdf_invalid`, nada copiado; Playwright simulado: toast em pt-BR e o app segue usável; Playwright ponte: bytes que o PdfCraft não abre → `failed{id}` e o aviso com "Abrir no visualizador do sistema".
- ⏸️ Os mesmos critérios de interface no iPad.

Também verificado nesta fase: fork e ponte (testes do fork: 13 `host_bridge` + 7 `stamp`, clippy `-D warnings`, checagem wasm32, `trunk build`); `/pdfcraft/` na mesma origem em dev (plugin do Vite) e no app empacotado (`web/dist/pdfcraft/`); abas Biblioteca | Leitor | Anki com o iframe sempre montado (trocar de aba não gera novo `ready`); `Ctrl+Shift+P` e `Alt+1` funcionam de dentro do PdfCraft e `Ctrl+2` continua do PdfCraft; tons do painel seguem o tema claro/escuro do PdfCraft; migração do banco para o esquema 1.1 (V1 → V2 com dados); "Abrir com" pela linha de comando importa e abre o livro no app real; uma cópia exportada (com `LeitorBookUid`) diferente da versão atual só a substitui depois de "Substituir", e a versão substituída fica guardada (Rust `replacing_with_an_old_copy_keeps_the_replaced_version`, Vitest no `AppShell`). Pendentes: arrastar e soltar e o encaminhamento por instância única no Linux real (sem D-Bus no container) e o primeiro resultado do CI (Linux e Windows).

Checagem final da Fase 1 (22/10/2026), tudo no devcontainer:
- Rust: `cargo fmt --check` e `clippy -D warnings` limpos; `cargo test --workspace` 98 testes (core-anki 9, core-pdf 7 + 16, core-store 3 + 6 + 14 + 10, app 17 + 16). `cargo tree -p core-pdf` sem `pdfcraft-engine` (usa `-render`, `-cos` e `-organize`, este só para ler/gravar o Info).
- Fork (`third_party/pdfcraft`, mudanças ainda não commitadas no `leitor-bridge`): `cargo fmt --check`, clippy `-D warnings` de `pdfcraft-ui-egui` e `pdfcraft-web`, testes (`ui-egui` 540 + 1042 + 3, `pdfcraft-web` 7), `cargo xtask layers` e `cargo xtask assets` ok, checagem `wasm32-unknown-unknown` ok, `trunk build --release` com `docker run --network none` em 50 s (`wasm-opt` version_131 da imagem; nada baixado).
- Web: `pnpm -r lint` ok, Vitest 171 testes (18 arquivos), Playwright simulado 22 (Chromium + WebKit), ponte 20 (Chromium + WebKit; identidade visual 0 px diferentes nos dois), desempenho 2. `pnpm --dir web build` gera `web/dist/pdfcraft/index.html`. YAML do CI e do release válidos.
- Capturas refeitas no app real sob Xvfb (`docs/capturas/fase-1/`: `biblioteca.png`, `leitor.png` = `/leitor?livro=<uid>` com o PDF importado por "Abrir com" na linha de comando, `leitor-vazio.png`, `anki.png`, `dev-smoke.png`); `leitor.png` comparada com a captura do PdfCraft sozinho do teste visual: só muda o que está fora do iframe (abas do app e Painel Anki).

**Aguardando o usuário:**
- Confirmar os atalhos (`Ctrl+1/2/3` só fora do PdfCraft; `Alt+1/2/3` de qualquer lugar) e o ajuste do texto da seção 18 sobre o `invoke` alcançável pelo iframe (ver `docs/decisoes.md`).
- Aprovar visualmente as capturas da Fase 1 e o `/dev/ui` da Fase 0.
- Num Linux com GPU real: digitar uma nota num comentário no app, testar arrastar e soltar e o "Abrir com" com o app já aberto (instância única; no container não há D-Bus), e medir o desempenho do livro de 500 páginas fora do Xvfb.
- Com os livros reais do usuário: conferir a importação e o salvamento automático em PDFs grandes de verdade.
- Primeiro resultado do CI depois do push (o CI que vale é Linux + Web; Windows fora do escopo desde 23/10/2026).

### Medições da Fase 1 (devcontainer, sem GPU: WebGL em software)

Clique na aba Leitor → `pdfcraft:ready` (mediana de 5; o iframe nunca recarrega ao trocar de aba — conferido):

| Ambiente | 1ª abertura | Seguintes |
|---|---|---|
| App release (WebKitGTK, wasm embutido) | 917 ms (745–1170) | 30 ms |
| App debug, cache vazio / cheio | 939 / 1319 ms | 34 ms |
| Chromium (Playwright) | 421 ms | 32 ms |
| WebKit (Playwright) | 1907 ms | 31 ms |

`wasm-opt`: sem otimização 49,5 MB (12,1 MB brotli), 1ª abertura WebKit 2674 ms · `-O3` 41,3 MB (11,8 MB), 2018 ms · `-Oz` 40,6 MB (11,8 MB), 1946–2211 ms. Mantido `-Oz`. Ponte verde nos três níveis.

## Fase 2 — Anki local

Verificado em 23/10/2026 no devcontainer, com a coleção de teste montada em código (`core_anki::fixture`; `seed_fixture` para o app real). No iPad, os critérios de interface ficam ⏸️.

- ✅ Importar cópia da coleção real por `.colpkg` e ver os decks como na captura — **feito com a coleção de teste; aguardando a coleção real do usuário (.colpkg)**. Rust `core-anki/tests/import_export.rs::colpkg_import_replaces_the_collection_after_a_backup`: o `.colpkg` da coleção de teste (`backup_now`) importado noutro serviço → a árvore tem "5000 palavras", "Oxford" (filho "Oxford 3000") e "ROS 2 — Revisão" com contagens não nulas, a mídia veio junto, existe o backup `antes-de-importar-…` e restaurá-lo traz a coleção antiga de volta; `failing_colpkg_leaves_the_old_collection_usable` (29 `.colpkg` ruins: a coleção antiga continua). App `tests/anki.rs::colpkg_import_replaces_the_collection_after_a_backup` (sem permissão de leitura → `anki_path_not_allowed`). Playwright `anki-decks.spec.ts`: menu e arquivo solto na janela → "Substituir a coleção inteira?" → "Tem certeza?" com caixa de confirmação → só então importa (log do núcleo simulado) → a árvore mostra os três decks; cancelar não importa. Captura do app real: `docs/capturas/fase-2/anki.png`.
- ✅ `docs/anki-handlers.md` com a decisão para cada handler especial (32 do `mediasrv.py`) e os 55 métodos expostos. Rust `tests/bridge.rs::docs_parity`: lê o documento e confere que os nomes entre crases = `POST_HANDLERS` ∪ `EXPOSED_METHODS` (87) e que a decisão e a coluna "card" de cada linha batem com o código.
- ✅ Teste de isolamento: de dentro de um card, `invoke` e `POST /_anki/addNote` falham; métodos fora da lista → 403. (a) Rust `bridge.rs::cards_reach_only_the_four_methods` e `wrong_content_type_or_origin_is_forbidden`; (b) app `tests/protocols.rs`: `card_posts_are_limited_to_four_methods`, `card_preflight` (OPTIONS → 403), `options_on_anki_is_forbidden`, `posts_need_the_binary_content_type_and_the_anki_origin` (sem CORS, `Origin` estranho → 403); (c) app real (WebKitGTK sob Xvfb) `scripts/anki-real-app.sh isolation` → PASS: `{"tauri":"undefined","parentInvoke":"blocked","addNote":403,"ankiFetch":"blocked","ipc":"blocked","i18n":200,"mathjax":true,"img":160}` (resultado vindo do `pycmd('probe:…')` do card da coleção de teste); (d) Playwright `anki-study.spec.ts`: `sandbox` exatamente `allow-scripts`, acesso ao `parent` lança erro, `__TAURI_INTERNALS__` indefinido, `addNote`/`importAnkiPackage` → 403 e `i18nResources` → 200.
- ✅ Estudar com áudio, imagens, cloze, MathJax e "digitar resposta"; intervalos iguais aos do Anki desktop. Rust `tests/study.rs` (16): rótulos = `describe_next_states(get_scheduling_states(cid))` para cards novos, em aprendizado e de revisão, e iguais aos padrões do Anki em inglês; botão de play byte a byte; áudio da pergunta não renumerado na resposta; TTS; cloze c1/c2; delimitadores do MathJax; `typeans` com `typeGood/typeBad/typeMissed`; tempo no revlog limitado pela predefinição; desfazer só depois de responder. Vitest: fila de áudio e TTS (`audio.test.ts`). Playwright: imagem e play no iframe, mostrar resposta, 4 rótulos, responder, `Ctrl+Z`, `mjx-container`, digitar resposta + Enter, cloze, `?resposta=1`. App real: sonda com `mathjax=true` e `img=160`; capturas `anki-estudar-nome-5000-20palavras-resposta-1.png` (imagem), `…Matem-C3-A1tica-resposta-1.png` (MathJax), `…Gram-C3-A1tica-3A-3ACloze.png`, `…ROS-202-…png` (digitar resposta). **Manual:** ouvir o áudio e o TTS num computador de verdade.
- ✅ Adicionar, editar, navegar, importar e exportar `.apkg`. Rust `notes.rs` (8: adicionar/ler/atualizar, erros em pt-BR, duplicata só avisa), `browse.rs` (8: sintaxe de busca, ordenação, linhas, mover/tags/suspender/esquecer/excluir, 10 mil cards: busca 8 ms, 100 linhas 1 ms), `import_export.rs` (`.apkg` com mídia → coleção nova mantém notas, cards e mídia; 29 `.apkg` ruins sem pânico), app `anki.rs` (permissões de leitura e gravação). Playwright `anki-editor.spec.ts`, `anki-browse.spec.ts`, `anki-decks.spec.ts` (exportar `.apkg`, importar pelo menu → página `import-anki-package`, "Abrir com" → confirmação → toast). Vitest: campos de código (11.1) e higienização de HTML. Capturas: `anki-adicionar.png`, `anki-navegar*.png`.
- ✅ Opções do deck, estatísticas e informações do card pelas páginas do Anki (SvelteKit do wheel `aqt==26.9.3`, sem rede). `scripts/anki-real-app.sh pages` → PASS (deck-options: i18nResources 200, getDeckConfigsForUpdate 200; graphs: getGraphPreferences 200, graphs 200; card-info: cardStats 200; congrats: congratsInfo 200; change-notetype: getChangeNotetypeInfo 200; import-anki-package: getImportAnkiPackagePresets 204; nenhum 403/404/500 nem violação de CSP). As duas sondas também passaram com `docker run --network none`. Gravações em `core-anki/tests/fixtures/bridge/` (10 métodos + `fixture.colpkg`, 124 KB) usadas pelo `bridge.rs` ("requisições gravadas usadas: i18nResources, getImportAnkiPackagePresets, getNotetypeNames, getChangeNotetypeInfo, cardStats, graphs, getGraphPreferences, congratsInfo, getDeckConfigsForUpdate, deckOptionsReady"). `.deb` release (34,4 MiB) com 204 arquivos `anki-web` (index do SvelteKit, `reviewer.js`, MathJax); o binário release sem rede acha `/usr/lib/Leitor de Estudos/anki-web`. Capturas: `anki-opcoes-deck-5000-palavras.png`, `anki-estatisticas.png`, `anki-info-card-5000-palavras.png`.
- ⏸️ Os mesmos critérios de interface no iPad/iPhone.

Também verificado nesta fase:
- 8.1 `AnkiService` (ator dono do `Collection`): `/_anki` despacha por nome para os traits gerados (`dispatch_is_by_name_never_by_numeric_index`: nenhum `run_service_method`, os 55 nomes com decisão); `setWantsAbort` volta enquanto um trabalho bloqueia o ator e `latestProgress` dá 204 (`abort_and_progress_do_not_wait_for_the_actor`); testes de concorrência e de pânico do serviço seguem verdes.
- 8.1 Backups: `tests/backup.rs` (nomes, rotação 7 diários + 5 antes de importar, `.partial` ignorado, diário uma vez por data local, < 1 s); backup antes de importar `.colpkg`; app `daily_backup_ticker` com relógio falso.
- 9/10.2/11.1/12.6 "Preparar coleção": `collection.rs::prepare_collection_creates_the_five_types_once` (campos e modelos exatos; segunda execução não cria nada e não muda `mtime`/`usn`; esquema não marcado como modificado) e `…_leaves_a_user_type_with_the_same_name_alone`; Playwright: o toast lista os tipos criados e, de novo, "já está preparada".
- 8.2 Decks: Playwright `anki-decks.spec.ts` (todas as ações; recolher persiste depois de recarregar); capturas claro/escuro (simulado) e `anki.png` (app real) conferidas com `docs/referencia/capturas/10-anki-lista-de-decks.png`.
- 8.2 Estudar: Vitest `keys.test.ts` (teclas vindas do iframe do card; atalhos do app repassados), `StudyPage.test.tsx` (contadores, `Ctrl+Z` só depois de responder, "Abrir no livro" chama `leitor.openBook(uid, {page: p-1})`, `shown` adiantado do iframe), `controller.test.ts` (página pedida); Playwright: `E`, `*`, `-`, `@`, "Abrir no livro" → `/leitor`.
- 8.5 "Abrir com"/arrastar: Rust `open_paths` mantém `.apkg`/`.colpkg`; permissão exigida (app); Vitest `openPaths.test.ts` e `AppShell.test.tsx`; Playwright `.apkg` aberto com o app e `.colpkg` solto.
- 18/20 Entradas não confiáveis: laços de pacotes truncados/lixo, corpos protobuf corrompidos para todos os nomes → 500 sem pânico (`garbage_bodies_are_errors_not_panics`), caminhos com `..`, `%2e%2e`, absolutos e `\` → 403/404, `UNTRUSTED_MEDIA_CSP` na mídia, tabela MIME.
- Contrato Rust ↔ TS: `app/tests/contract.rs` grava/confere `web/src/lib/core/__fixtures__/contract.json` e o Vitest `contract.test.ts` confere o núcleo simulado contra ele; `mock.test.ts` confere que o cliente simulado e o Tauri têm as mesmas chaves.
- Sem sincronização nesta fase: nenhuma chamada de sync no código; `no_sync_method_is_exposed`. Testes e scripts só usam pastas temporárias.
- Porta do iOS: `cargo tree -p core-anki` sem tauri/webkit; diálogos, instância única, permissões de arrastar e soltar e ajustes do WebKit atrás de `cfg(desktop)`/`target_os = "linux"` no `app`.

Checagem final da Fase 2 (23/10/2026, devcontainer): Rust `cargo fmt --check` e `clippy -D warnings` limpos, `cargo test --workspace` 221 testes; `pnpm -r lint` ok; Vitest 339 (41 arquivos); Playwright simulado 92, ponte 20 e desempenho 2 (Chromium + WebKit); `tauri build --bundles deb` ok; `anki-real-app.sh isolation` e `pages` PASS (com e sem rede). Corrigido na integração: com o núcleo real, o iframe do card respondia `shown` antes de o React mostrar o card e o `?resposta=1` não abria a resposta (a referência da tela agora muda na hora; teste de regressão no `StudyPage.test.tsx`).

Rechecagem de aceitação depois das correções em paralelo (23/10/2026, devcontainer): `cargo fmt --check` e `clippy --workspace --all-targets -D warnings` limpos; `cargo test --workspace` 224 testes, 0 falhas; `pnpm -r lint` ok; Vitest 345 (41 arquivos); Playwright simulado 92, ponte 20 e desempenho 2 (Chromium + WebKit); `anki-real-app.sh isolation` e `pages` PASS com `docker run --network none`; `cargo tree -p core-anki` sem tauri/webkit/gtk. Nenhum conflito de integração a corrigir. Capturas de `docs/capturas/fase-2/` refeitas com a coleção de teste (13 rotas). O `tauri build` não foi refeito nesta rechecagem (disco do host quase cheio; foram apagados só caches de build regeneráveis do volume `leitor-target`).

**Aguardando o usuário:**
- Importar a cópia real da coleção (`.colpkg`) e conferir os decks (5000 palavras, Oxford, ROS 2 — Revisão) e os números.
- Ouvir o áudio e o TTS dos cards num computador de verdade (no container não há saída de som).
- Aprovar visualmente as capturas da Fase 2 (`docs/capturas/fase-2/` e `web/test-results/screens/anki-*`).
- Dizer se a importação direta de `.apkg` ("Abrir com") deve manter o histórico de revisões (hoje usa as predefinições salvas da coleção).

## Fase 3 — Sincronização do Anki

Verificado em 23/10/2026 no devcontainer, contra o servidor de sync **oficial** do Anki na mesma versão (`python -m anki.syncserver` do `anki==26.9.3`, `compose.dev.yml`, rede `leitor-dev`; HTTP `http://ankisync-dev:8080/` e TLS `https://ankisync-dev-tls:8443/`). Nada fala com o AnkiWeb nem com a coleção real. `scripts/sync-test.sh all` → `RESULT: PASS` (servidor `anki==26.9.3 (26.09.3)`, `core-anki` 10/10 em 5,2 s, app 11/11 em 6,7 s, conferência com o cliente Python oficial), servidor e volume removidos ao final.

- ✅ Login e sync com o servidor local; primeira sync sempre baixa. `sync_server.rs`: `login_ok_and_wrong_password_is_auth_failed`, `review_on_a_appears_on_b` (duas coleções A e B pelo servidor, nos dois sentidos), `first_sync_always_downloads` (resultado `FullDownloaded`, backup `antes-da-sincronizacao-*.colpkg` existe, B igual a A, a nota só local some), `server_empty_first_sync_never_uploads` (o servidor continua vazio); unitários `decide::decision_table` e `never_uploads_automatically_and_first_sync_never_keeps_local_changes` (nenhuma entrada leva a envio automático; não há variante `Upload`). App `tests/sync.rs::login_first_download_and_after_answer_sync` (o deck local é descartado, backup antes, responder um card → sync automática → a revisão chega a outra coleção).
- 🌐 Sync com o servidor no VPS. Conferido localmente com o cliente oficial Python 26.9.3 (`pyclient.py`) e duas coleções A/B; falta o VPS.
- 🌐 Revisar no app → aparece no AnkiMobile/desktop e vice-versa. Conferido localmente com o cliente oficial Python 26.9.3 (`pyclient.py`) e duas coleções A/B; falta o VPS. (`sync-test.sh`: "crosscheck t12: official client downloads the app's collection (revlog: 14)" — a revisão feita pelo cliente Rust aparece no cliente Python; t11: revisão de um cliente Python + imagem vistas por outro.)
- ✅ Sem rede revisa; ao voltar sincroniza sozinho. `sync_server.rs::offline_then_reconnect` (proxy TCP desligado → erro `Offline`, a árvore de decks responde em < 1 s durante a sync que falha; proxy ligado → sync normal, B vê a revisão); app `offline_then_online_retries` (estado `offline` com `nextRetryAt`; `anki_sync_notify('online')` → sincronizado) e `an_unreachable_server_is_reported_without_blocking`; unitários da política (espera 15/30/60/120/300 s); Playwright `anki-sync.spec.ts` ("Sem conexão" → rede volta → "Sincronizado agora").
- ✅ Diálogo de sync completa com backup antes. `sync_server.rs::conflicting_schema_requires_full_sync` (`FullSyncRequired{upload_ok:true, download_ok:true}`, nada é enviado antes do `sync_full`, backup PreSync antes de enviar e antes de baixar); app `full_sync_required_waits_for_the_user_and_never_uploads` (respostas, avisos e três ciclos periódicos sem mudar o servidor; `anki_sync_full('download')` devolve o backup `antes-da-sincronizacao-*`); Vitest `FullSyncDialog.test.tsx` (textos exatos "Baixar do servidor (recomendado se você revisou em outro aparelho)" e "Enviar deste aparelho", enviar pede segunda confirmação que começa em "Cancelar", Enter/Esc nunca enviam); Playwright: diálogo → baixar → backup listado como "Antes da sincronização".

Também verificado nesta fase:
- "Preparar coleção" não força sync completa: `prepare_collection_does_not_force_full_sync` (depois de preparar, a sync de A é normal e B recebe os 5 tipos do app).
- Mídia: `note_with_media_a_to_b` (o arquivo chega idêntico, byte a byte, ao `collection.media` de B). Falha de mídia vai para `mediaError` e nunca derruba a sync da coleção.
- Chave só no chaveiro (seção 18): app `tests/sync.rs` — a hkey fica só no `SecretStore` em `anki-sync:{usuário}@{url}`, e nem a hkey nem a senha aparecem em nenhum arquivo da pasta de dados; `keyring_roundtrip` com o Secret Service real (gnome-keyring) sob `scripts/with-keyring.sh`; `logout_deletes_the_key_and_keeps_the_prefill`; chave recusada pelo servidor → sai e apaga a entrada; o `core-store` não tem chave de segredo.
- AnkiWeb recusado: `endpoint::refuses_ankiweb` (`ankiweb.net` e subdomínios → `anki.sync.ankiWebRefused`), `client::auth_always_has_the_endpoint` e `sync_auth_is_only_built_by_make_auth` (varre o código do crate), app `ankiweb_is_refused_and_nothing_is_stored`, Playwright (mesma mensagem em pt-BR no formulário). `new_endpoint` do servidor só com o mesmo esquema e host (`redirects_must_keep_scheme_and_host`).
- Política de horários (seção 9): `app/src/sync/policy.rs`, 16 testes unitários com horários explícitos nas bordas (4:59 × 5:00 ao abrir, 1:59 × 2:00 na aba Anki, 60 s depois da última resposta re-armado por nova resposta, a cada 15 min, manual sempre), adiamento enquanto o usuário responde e agrupamento de gatilhos; Vitest `SyncTriggers.test.tsx` (avisa `tabEntered` só ao entrar em `/anki`).
- Status no topo: Vitest do formatador e `SyncPill.test.tsx`; Playwright com `lastSyncAt` = agora − 2 min → "Sincronizado há 2 min"; "Sincronizar agora" no balão da pílula e "Sincronizar" na barra dos decks chamam `ankiSync`.
- Configurações → "Anki e sincronização" (endereço, usuário, entrar/sair, certificado): Playwright `anki-sync.spec.ts` no Chromium e no WebKit, com capturas `web/test-results/screens/sync-*.png` (claro/escuro) e tela estreita (390 px, pílula só com ícone); app real `docs/capturas/fase-3/configuracoes-anki.png`.
- Backups `antes-da-sincronizacao-AAAAMMDD-HHMMSS.colpkg` (8.1): `tests/backup.rs::pre_sync_names_and_own_rotation_bucket` (mantém 5, rotação própria) e `pre_sync_backup_is_written_with_its_prefix`.
- Versão 26.9.3: `sync-test.sh` confere `anki==26.9.3` / `26.09.3` no servidor; as dependências do Anki no `Cargo.toml` continuam na tag `26.09.3`.
- Certificado salvo: entrar de novo sem mandar o certificado usa o que está salvo (corrigido na integração; app `tests/sync.rs`, parte TLS).
- Grafo de dependências: um só `reqwest` 0.12 ativo, um `hyper`, um `rustls`, um `libsqlite3-sys` (0.34, via `rusqlite` 0.36), sem `native-tls`/`openssl-sys`; `keyring` 3.6.3 (MIT OR Apache-2.0) só no `app`; `cargo tree -p core-anki` sem tauri/webkit/gtk/keyring.
- Porta do iOS (⏸️ critérios iOS/iPad adiados): o `keyring` usa `apple-native` em macOS/iOS; a tela de configurações é responsiva.
- CI: o job Linux sobe o `compose.dev.yml`, roda `cargo test --workspace` sob `scripts/with-keyring.sh` na rede `leitor-dev` (testes de sync ligados) e a conferência com o `pyclient.py`, e derruba tudo com `down -v`.

Checagem final da Fase 3 (23/10/2026, devcontainer): `cargo fmt --all` e `clippy --workspace --all-targets -D warnings` limpos; `cargo test --workspace` 286 testes, 0 falhas (os 21 de sync contra o servidor só rodam com `LEITOR_SYNC_TEST_URL`); `pnpm -r lint` ok; Vitest 390 (47 arquivos); Playwright simulado 100 + ponte 20 (Chromium + WebKit) e desempenho 2; `scripts/sync-test.sh all` PASS; `ci.yml` validado com `yaml.safe_load` e `actionlint` (sem avisos). Corrigido na integração: a interface e o núcleo simulado usavam códigos de erro `anki.sync.*`, mas o app entrega `anki_sync_*` (snake_case, como os outros comandos), então os erros de login não apareciam no campo certo com o núcleo real; e entrar de novo sem reenviar o certificado apagava o certificado salvo. Capturas do app real em `docs/capturas/fase-3/` (`configuracoes-anki.png`, `anki.png`, `biblioteca.png`).

**Aguardando o usuário:**
- Migrar do AnkiWeb para o servidor no VPS e conferir a sync com o AnkiMobile e o Anki desktop (🌐).
- Aprovar visualmente a pílula, o diálogo de sync completa e a tela de configurações (`web/test-results/screens/sync-*.png`, `docs/capturas/fase-3/`).

## Fase 4 — Anotações e Painel Anki do livro

Verificado em 23/10/2026 no devcontainer, com o build web do fork (ponte nível 2, `bridge: 2`) e a coleção de teste. Fork: `leitor-bridge` sobre `e3f01f24`, mudanças em `crates/ui-egui/src/{host,canvas,lib}.rs`, `apps/pdfcraft-web/src/{main,bridge}.rs` e testes (o SHA entra em `docs/decisoes.md` quando o commit for feito).

- ✅ "Criar card", "Criar cards com IA" e "Definir palavra" no menu da seleção do próprio PdfCraft (`pdfcraft:menu-items`). *(Na 1.1 este critério substitui "destaques, notas, marcadores": esses agora são os do PdfCraft, desde a Fase 1.)* Fork `tests/it/host_bridge.rs` (11 testes novos): itens achados pelo rótulo no menu do botão direito e na barra flutuante só com texto selecionado; clique → `HostEvent::Menu` mantendo a seleção. Playwright `e2e/bridge/phase4.spec.ts` com o build real (Chromium + WebKit): o app manda `pdfcraft:menu-items` depois do `ready` (`card`/`ai`/`define` com os rótulos em pt-BR); depois de arrastar sobre o texto, o PdfCraft manda `pdfcraft:menu-shown` com as três chaves; clicar em "Criar card" na barra e no menu do botão direito → `pdfcraft:menu {key:'card'}` → formulário "Novo card" preenchido; "Criar cards com IA" → aviso; "Definir palavra" → popover.
- ✅ Card Básico e Cloze da seleção, pelo menu do PdfCraft e pelo atalho, com a `Fonte` preenchida. **Atalho decidido (confirmar com o usuário, `docs/decisoes.md`):** `Ctrl+Shift+N` é o "Go to page…" do PdfCraft, então só vale com o foco fora do PdfCraft; `Alt+C` vale em qualquer lugar. Playwright ponte: arrastar → `pdfcraft:selection` com o texto exato e retângulos dentro da página (≤ 2 mensagens durante o arrasto, a última ~300 ms depois do último movimento); `Ctrl+Enter` → `addNote` com Fonte `leitor://livro/<uid>?pagina=1&amp;q=the%20windmill%20was%20finished%20in%20autumn`; Cloze com lacuna `{{c1::windmill}}`; o card aparece em "Cards desta página"; `Alt+C` dentro do iframe e `Ctrl+Shift+N` no painel abrem o formulário; `Ctrl+Shift+N` dentro do PdfCraft não abre. Rust `core-anki` `source_html_literal`/`source_html_round_trips` e `tests/book.rs::source_builder_matches_the_ts_literal_and_round_trips`; o mesmo literal no Vitest `fonte.test.ts`; app `tests/book_panel.rs::book_cards_of_the_fixture`. Vitest `CardForm.test.tsx`; Playwright simulado `book-panel.spec.ts` (botão, menu, `Ctrl+Shift+N`).
- ✅ "Abrir no livro" a partir da aba Anki abre o PdfCraft na página e encontra o trecho (`pdfcraft:goto`). Playwright ponte: depois de adicionar o card, estudar o deck na aba Anki → "Abrir no livro" → `pdfcraft:goto {id, page, find}` → `pdfcraft:found {found:true}` na página certa; também com o trecho quebrado em duas linhas (página 3, cai nas primeiras palavras). Fork: `Goto` → `Found true` com o acerto atual da barra de localizar na página; texto ausente / id desconhecido → `Found false`. Vitest `controller.test.ts` e `StudyPage.test.tsx` (`openBook(uid, {page, find})`). App real: `docs/capturas/fase-4/leitor-livro-book-pagina-37-q-windmill.png` (p. 37, "windmill" destacado na barra de localizar do PdfCraft, 2 de 2).
- ✅ Link `leitor://livro/<uid>?pagina=N&q=…` registrado no sistema (Linux) abre o Leitor na página; segunda instância encaminha. Rust `deep_link.rs` (7 unitários: válidos, inválidos, lixo sem pânico, argv) e `tests/deep_link.rs` (segunda instância com link → exatamente um evento `leitor://deep-link`; links da abertura enfileirados uma vez; arquivos e links não se misturam). Playwright simulado `deep-link.spec.ts` (6: link da abertura e encaminhado → livro na página com `goto`+`find`; livro desconhecido → aviso) e ponte (link → `pdfcraft:found` true). Container com `xdg-utils` (imagem descartável sobre `leitor-dev`, pastas XDG temporárias, `dbus-run-session`): `xdg-mime query default x-scheme-handler/leitor` → `leitor-estudos-handler.desktop` (`MimeType=x-scheme-handler/leitor`, `Exec=… %u`); a segunda instância com `leitor://livro/aaa…?pagina=3&q=windmill` saiu com 0 e o log da primeira mostra exatamente uma linha `deep link page=3`. Windows: entradas de registro do bundler (só no CI). **Manual:** clicar num link `leitor://` no Linux de verdade do usuário.
- ⏸️ Link `leitor://` tocado num card no AnkiMobile do iPad abre o Leitor (iOS/iPad adiado, decisão de 22/10/2026). Porta mantida: o `tauri-plugin-deep-link` também atende iOS e o código só de desktop está atrás de `cfg(desktop)`.
- ✅ Mini-revisão no painel lateral (seção 10.1: um deck por vez, deck atual restaurado, `Ctrl+Z` só desfaz respostas, leitura pausada, um lugar estuda por vez com aviso). Rust `core-anki/tests/mini_review.rs` (9: abrir/trocar/fechar restaura o deck anterior; a aba tomando a sessão vence e fechar não restaura; trocar de deck do livro mantém o deck original; `close_owner`; deck anterior apagado não é restaurado; trocar para o mesmo deck não cria passo de desfazer; deck desconhecido; JSON camelCase) e app `tests/anki.rs` (eventos `anki://study-owner`, `anki_study_close('tab')` não fecha a sessão do painel). Vitest `MiniReview.test.tsx` (10), `useStudySession.test.tsx`, `StudyPage.test.tsx` (aviso de pausa), `sessions.test.ts` (motivo `review`). Playwright simulado `mini-review.spec.ts` (Chromium + WebKit): "Revisar aqui" → card no iframe `sandbox="allow-scripts"` do painel, sessão de leitura parada com `review`, responder + `Ctrl+Z` no painel, estudar na aba Anki → avisos dos dois lados com "Continuar aqui", "Encerrar revisão" → `currentDeckId` restaurado e leitura recomeça. App real: `leitor-livro-book-painel-revisar.png`.

Também verificado nesta fase:
- 10.1 Painel: decks do livro (vocabulário `<pasta>::Livros::<Título>`, `Livros::<Título>` enquanto a pasta não existe; conteúdo em `book.content_deck_id`) com N/A/R iguais à lista de decks; cobertura de vocabulário como marcador ("Ver relatório →" até a Fase 6); "Cards desta página" pelo Fonte. App `tests/book_panel.rs` (6), `core-anki/tests/book.rs` (6; `book_cards` com 10 mil notas ~30 ms), Vitest `BookPanelContent.test.tsx`, Playwright `book-panel.spec.ts` (contagens de "Livros::Animal Farm", card semeado da p. 1, deck de conteúdo escolhido persiste depois de recarregar). App real: `leitor-livro-book.png`.
- 10.2 Formulário: tipos Básico/Cloze/Código · Comando/Código · Programa/Vocabulário (só com uma palavra), deck = último usado no livro, `Ctrl+Enter` adiciona, "Preparar coleção" quando faltam tipos. Vitest `CardForm.test.tsx`, `core-store/tests/prefs.rs` (5) e a migração V2→V3, Playwright (o último deck vem selecionado ao reabrir). App real: `leitor-livro-book-painel-card-trecho-the-windmill-was-finished.png`.
- 10.3 "Criar cards com IA": aviso em pt-BR com link para Configurações → IA (Vitest, Playwright simulado e ponte). App real: `configuracoes-ia.png`.
- 12.7 (parcial) "Definir palavra": lema e, havendo nota na pasta de vocabulário, a definição; o popover avisa que WordNet e IA chegam depois. `core-vocab` (112 casos de lema, 18 de palavra única), `core-anki` `vocab_lookup`, app `vocab_define_word_lemma_and_note` (várias palavras → "Selecione uma só palavra."), Vitest do popover, Playwright ("animals" → "Lema: animal"). App real: `leitor-livro-book-painel-definir-trecho-animals.png`.
- 6.2 Ponte v2 no fork: fork `cargo fmt --check`, `clippy -p pdfcraft-ui-egui -p pdfcraft-web --all-targets -D warnings` limpos; ui-egui 540 (lib) + 1053 (it, eram 1042) + 3 (perf); pdfcraft-web 17 (eram 7); `cargo check --target wasm32-unknown-unknown -p pdfcraft-web` ok; `build-pdfcraft-web.sh` (carimbo inclui as mudanças não commitadas). App Vitest `bridge.test.ts`: toda mensagem nova validada (formas inválidas descartadas, nunca lança); `MIN_BRIDGE = 2` recusa build antigo.
- 5.1 Atalhos: Vitest `keys.test.ts`/`shortcuts.test.ts` (`Ctrl+Shift+N` nunca repassado nem bloqueado dentro do iframe; `Alt+C` repassado; `Ctrl+1/2/3` iguais); auditoria completa dos atalhos do PdfCraft em `docs/tecnico/pdfcraft-api.md` §12.
- Desempenho da Fase 1 mantido (`e2e:perf`, PDF de 500 páginas, critério app ≤ sozinho × 1,15 + 50 ms): última rodada (checagem final): Chromium abrir→ativo 219,1 ms (sozinho 186,4; limite 264), estável 552,1 (495,5; limite 620), rolagem p50/p95 16,7/33,4 ms (iguais), 1 quadro longo (0 sozinho); WebKit abrir→ativo 83 ms (131), estável 646 (689), rolagem 31/35 ms (32/35). Rodadas anteriores parecidas (Chromium 200,3/560 e 214,7/566,4).
- Visual: capturas Playwright claro/escuro e 390 px (`web/test-results/screens/painel-*.png`, `painel-revisao-*.png`) e do app real em `docs/capturas/fase-4/` (livro "Animal Farm" gerado por `scripts/sample-book-pdf.py`, importado por "Abrir com" e coleção de teste com o Fonte apontando para ele: `LEITOR_CAPTURE_PDF` no `scripts/capture.sh`). Corrigido na integração: o popover "Definir palavra" mostrava o anel de foco em volta de tudo (a superfície de popover agora não tem contorno de foco, como o diálogo) e o card da mini-revisão seguia o tema do app, não o do PdfCraft (num PdfCraft claro com o app escuro ficava um card escuro num painel claro).

Checagem final de aceitação da Fase 4, depois das correções em paralelo (23/10/2026, devcontainer, `CARGO_INCREMENTAL=0`): nada quebrou na integração. `cargo fmt --all --check` e `clippy --workspace --all-targets -D warnings` limpos; `cargo test --workspace` 340 testes, 0 falhas; fork: `fmt --check`, `clippy -p pdfcraft-ui-egui -p pdfcraft-web --all-targets -D warnings` limpos, ui-egui 540 + 1053 + 3, pdfcraft-web 17, `cargo check --target wasm32-unknown-unknown -p pdfcraft-web` ok, build web atualizado (carimbo com as mudanças não commitadas); `pnpm -r lint` ok; Vitest 534 (54 arquivos); Playwright simulado 120, ponte 30 duas vezes seguidas e desempenho 2 (Chromium + WebKit). Capturas de `docs/capturas/fase-4/` refeitas do zero com `scripts/capture.sh` (7 rotas, coleção de teste + "Animal Farm" gerado) e conferidas. Observações: `packages/checkers` ainda não tem `package.json` (só `src/`; nada a testar até a Fase 5); `clippy --target wasm32-unknown-unknown` no fork acusa código morto em arquivos que o fork não tocou (`pdfcraft-render`, `ui-egui/{editing,units,updates,recovery,…}.rs`), já presente no upstream — não é critério e não foi mexido.

Checagem final da Fase 4 (23/10/2026, devcontainer, `CARGO_INCREMENTAL=0`): `cargo fmt --all --check` e `clippy --workspace --all-targets -D warnings` limpos; `cargo test --workspace` 337 testes, 0 falhas (os de sync contra o servidor continuam atrás de `LEITOR_SYNC_TEST_URL`); fork (acima) verde; `pnpm -r lint` ok; Vitest 528 (54 arquivos, três rodadas seguidas); Playwright simulado 120, ponte 28 duas vezes seguidas (Chromium + WebKit, build real do fork) e desempenho 2. Corrigido também: um teste do `MiniReview` que dependia de o foco do "Mostrar resposta" (posto no quadro de animação seguinte) chegar antes do foco no PdfCraft. `scripts/capture.sh` ganhou `LEITOR_CAPTURE_PDF` (importa um PDF e troca `{book}` pelo `book_uid`) e `LEITOR_CAPTURE_ARGS`; `seed_fixture` ganhou `--book-uid=`. A imagem `leitor-dev` não foi reconstruída (disco do host quase cheio; o `Dockerfile` já tem `xdg-utils`); a checagem do `xdg-mime` usou uma imagem descartável derivada dela, apagada depois.

**Aguardando o usuário:**
- Confirmar a decisão de atalhos: `Ctrl+Shift+N` só fora do PdfCraft, `Alt+C` em qualquer lugar (`docs/decisoes.md`).
- Clicar num link `leitor://livro/…` no Linux de verdade (registro conferido no container com `xdg-mime`).
- Aprovar visualmente o painel, o formulário, a mini-revisão, o popover e o aviso de IA (`docs/capturas/fase-4/`, `web/test-results/screens/painel-*.png`).

## Fase 5 — Cards de código

- ⬜ Todos os casos do Apêndice B.
- ⬜ Cards do deck "ROS 2 — Revisão" com papel Comando revisados de forma interativa.
- ⬜ Python modo `testes` com tempo limite de 5 s.
- ⬜ C++ `testes` e `saida` com o compilador local no desktop. (runner remoto para iPad ⏸️)
- ⏸️ C++ no iPad pelo runner no VPS.
- ⬜ Importação em lote do exemplo da seção 11.7.

## Fase 6 — Escaneamento de vocabulário

- ⬜ Passo "escolher a pasta de vocabulário" obrigatório.
- ⬜ Mapeamento de campos com os tipos reais do usuário.
- ⬜ Tempos e precisão da seção 12.8 (desktop; iPad ⏸️).
- ⬜ Relatório com cobertura, curva e capítulos.
- ⬜ Deck gerado na pasta de vocabulário, ordem de leitura, `Fonte` na 1ª ocorrência.
- ⬜ "Já sei" e reescanear em segundos.
- ⬜ Realce no PdfCraft pelas marcas da ponte (`pdfcraft:marks`), sublinhando as palavras certas, sem gravar nada no PDF; popover e "Adicionar ao deck do livro".

## Fase 7 — EPUB e OCR

- ⬜ EPUB: abrir, progresso, anotações, cards, escaneamento.
- ⬜ PDF escaneado em inglês passa pelo OCR no núcleo e vira uma nova versão pesquisável; busca, seleção e anotações do PdfCraft e o escaneamento funcionam nela.

## Fase 8 — IA

- ⬜ Anthropic e URL compatível com OpenAI.
- ⬜ Chave no keychain; limite mensal.
- ⬜ Enriquecimento, definição, juiz de código, cards da seleção.
- ⬜ Com IA desligada, tudo funciona.

## Fase 9 — Biblioteca sincronizada e Painel

- ⬜ `library-sync` local entre dois aparelhos.
- ⬜ Painel simulado: envio, reenvio idempotente, offline, 401/429/5xx.
- 🌐 O mesmo no VPS com o Painel de verdade.

## Fase 10 — Acabamento iPad/iPhone

- ⏸️ Toda a fase (adiada).

---

## Registro

- 2026-10-22 — Início. Devcontainer, workspace Cargo e documentação inicial.
- 2026-10-22 — Fase 0: `core-anki` (ator dono da coleção, árvore de decks, estudados hoje), `core-pdf` (fachada PdfCraft: render com temas, palavras UAX #29 com retângulos, busca, cache), `core-store` (esquema completo da seção 14), app Tauri (comandos, protocolo `pdf`, `--smoke`), interface (shell com abas, design system, `/dev/ui`, `/anki`, leitor inicial), scripts de dados, CI Linux/Windows e release. Testes: 53 Rust, 18 Vitest, e2e Playwright (Chromium + WebKit). Revisão adversarial em 4 dimensões; achados corrigidos.
- 2026-10-22 — Fase 1 (especificação 1.1): leitor React, `/doc` e PDF.js removidos; a aba Leitor embute o PdfCraft web (fork `leitor-bridge`: ganchos no `ui-egui` + ponte no `pdfcraft-web`) num iframe em `/pdfcraft/`, com salvamento automático em versões do arquivo, posição e sessões de leitura; Biblioteca nova (importar por diálogo, arrastar e "Abrir com", capas, coleções, busca, "parece escaneado", `LeitorBookUid`); `core-pdf` sem `pdfcraft-engine`; migração V2 do banco; build web no devcontainer (offline) e no CI. Testes: Rust do workspace (núcleo, store, app), fork (`ui-egui` 540 + 1042, `pdfcraft-web` 7), Vitest 162, Playwright 40 (simulado + ponte, Chromium e WebKit) + desempenho. App real sob Xvfb verificado com `xdotool`. **Para o usuário:** (1) atalhos — `Ctrl+1/2/3` só trocam de aba com o foco fora do PdfCraft (dentro dele são zoom do PdfCraft); de qualquer lugar valem `Alt+1/2/3`; isso muda o comportamento da seção 5.1 dentro do leitor; (2) na Fase 4, `Ctrl+Shift+N` (card da seleção) conflita com "Ir para a página…" do PdfCraft.
- 2026-10-22 — Fase 1, checagem final de aceitação: suíte completa verde no devcontainer (Rust 98, fork 1592, Vitest 171, Playwright 22 simulado + 20 ponte + 2 desempenho, Chromium e WebKit); build do PdfCraft web sem rede conferido; capturas da Fase 1 refeitas; números de desempenho atualizados. Mudanças do fork prontas para o commit no `leitor-bridge`.
- 2026-10-22 — Fase 1 (spec 1.1) fechada: PdfCraft embutido (fork `leitor-bridge` `e3f01f24`), ponte, Biblioteca, salvamento automático com versões, sessões de leitura, `core-pdf` sem `pdfcraft-engine`. Suíte: Rust 98, fork 1592, Vitest 179, Playwright simulado 22 + ponte 20 (2×) + desempenho 2. Teste instável do WebKit (download do wasm cancelado no reinício simulado) corrigido: 30/30.
- 2026-10-23 — Fase 2 (Anki local): `core-anki` com ator, decks, "Preparar coleção" (5 tipos do app), estudo com o porte do `reviewer.py`/`sound.py`, notas, navegar, mídia, importar/exportar `.apkg`/`.colpkg`, backups e a ponte `/_anki` por nome; protocolos `anki` (páginas do Anki do wheel 26.9.3, offline) e `card` (iframe `sandbox="allow-scripts"`, só 4 métodos); telas Decks, Estudar, Navegar, Adicionar/Editar e páginas do Anki; coleção de teste em código e gravações das páginas. Suíte: Rust 221, Vitest 339, Playwright 92 + 20 + 2, sondas do app real PASS. Para o usuário: coleção real, áudio/TTS e aprovação visual.
- 2026-10-23 — Fase 2, rechecagem final de aceitação: suíte completa verde (Rust 224, Vitest 345, Playwright 92 + 20 + 2), sondas do app real `isolation`/`pages` PASS sem rede, capturas da Fase 2 refeitas. Pendências do usuário: coleção real (`.colpkg`), ouvir áudio/TTS, aprovação visual.
- 2026-10-23 — Fase 3 (sincronização do Anki): servidor oficial `anki==26.9.3` em `compose.dev.yml` (HTTP + TLS com CA de desenvolvimento, rede `leitor-dev`); cliente do `rslib` atrás do `AnkiService` (login → hkey, sync normal, completa, mídia; checagem de rede fora do ator; AnkiWeb recusado); comandos `anki_sync_*` com a chave no chaveiro do sistema (`keyring`), política de horários em Rust, sem rede com nova tentativa, diálogo de sync completa (nunca envia sozinho, backup antes), primeira sync sempre baixa; pílula no topo, tela Configurações → "Anki e sincronização". Suíte: Rust 282, Vitest 384, Playwright 100 + 20 + 2, `sync-test.sh all` PASS. Critério TLS da Fase 0 fechado. [VPS] pendentes.
- 2026-10-23 — Aceite final da Fase 3 (depois dos últimos ajustes): fmt/clippy limpos, Rust 286, Vitest 390, Playwright 100 + 20 + 2 (Chromium + WebKit), `sync-test.sh all` PASS (servidor `anki==26.9.3`, core-anki 10/10, app 11/11, conferência com o cliente Python oficial), `actionlint` ok; capturas de `docs/capturas/fase-3/` refeitas. Pendentes só os critérios [VPS] (🌐) e os de iOS/iPad (⏸️).
- 2026-10-23 — Aceite final da Fase 4 (painel Anki do livro, cards da seleção, `pdfcraft:goto`, link `leitor://`, mini-revisão; ponte v2 no fork): fmt/clippy limpos, Rust 340, fork 540 + 1053 + 3 + 17, Vitest 534, Playwright 120 + 30 (2×) + 2 (Chromium + WebKit), desempenho dentro do critério da Fase 1; capturas de `docs/capturas/fase-4/` refeitas. Aguardando o usuário: confirmar `Ctrl+Shift+N` fora do PdfCraft + `Alt+C`, clicar num link `leitor://` no Linux dele e aprovar o visual. iPad ⏸️.
