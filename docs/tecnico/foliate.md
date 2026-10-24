# Leitor de EPUB: foliate-js

Spec: 7.1 (EPUB), 4 (destaques em EPUB com a aparência do PdfCraft; movimento ≤ 150 ms, desligado com
`prefers-reduced-motion`), 12.7 (marcas de vocabulário), 18 (segurança), 20 e 21 (Fase 7).

O EPUB não abre no PdfCraft. O leitor de EPUB é um componente do app (`web/src/features/epub/`) que o pacote do
Leitor (W2) monta na mesma aba "Leitor". Por baixo está o [foliate-js](https://github.com/johnfactotum/foliate-js),
sem modificações.

## Versão fixada e licenças

| O quê | Versão | Licença | Onde |
|---|---|---|---|
| foliate-js | commit `78914aef4466eb960965702401634c2cb348e9b1` (2026-05-01; o projeto não tem releases) | MIT (`LICENSE`: "Copyright (c) 2022 John Factotum") | `web/vendor/foliate-js/` |
| zip.js (bundle `vendor/zip.js` do foliate) | 2.8.22 (`package-lock.json` do commit) | BSD-3-Clause (Gildas Lormeau) | `web/vendor/foliate-js/vendor/zip.js` + `LICENSE.zip.js` |
| fflate (bundle `vendor/fflate.js` do foliate) | 0.8.2 | MIT (Arjun Barrett) | `web/vendor/foliate-js/vendor/fflate.js` + `LICENSE.fflate` |

Todas compatíveis com a AGPL-3.0 do app; os créditos aparecem em Configurações → Sobre
(`web/src/features/settings/AboutSettings.tsx`, versões em `web/src/features/epub/version.ts`).

`scripts/fetch-foliate.sh` baixa o tarball do commit no GitHub (SHA-256
`4878cd5f04073af5046ea543da73a963a7f9e1a4b30ddc63ac86cea5adf02f38`) e os pacotes npm de zip.js e fflate (só para
copiar o `LICENSE`, já que os bundles minificados não trazem o texto da licença), confere tudo por SHA-256 e copia
**só** este subconjunto, sem alterar nada:

`view.js`, `epub.js`, `epubcfi.js`, `paginator.js`, `fixed-layout.js`, `overlayer.js`, `progress.js`,
`text-walker.js`, `search.js`, `vendor/zip.js`, `vendor/fflate.js`, `LICENSE`, `vendor/LICENSE.zip.js`,
`vendor/LICENSE.fflate` (≈ 230 KB, versionados: o app e o CI funcionam offline).

`footnotes.js` não entra (nada do que usamos o importa). `vendor/pdfjs` (13 MB), `pdf.js`, `mobi.js`, `fb2.js`,
`comic-book.js`, `tts.js`, `ui/`, `reader.*` também não. `scripts/fetch-foliate.sh --check` confere a cópia
versionada contra os hashes fixados (sem rede) e falha se faltar, sobrar ou mudar algum arquivo. Os hashes de cada
arquivo estão no próprio script e em `web/vendor/foliate-js/README.leitor.md`.

## Como entra no build

- `@foliate/<arquivo>.js` é um alias do Vite para `web/vendor/foliate-js/` (bloco `foliate()` em
  `web/vite.config.ts`). Os tipos do que usamos estão em `web/src/features/epub/foliate.d.ts`.
- `view.js` importa sob demanda os formatos que não embarcamos (`./pdf.js`, `./mobi.js`, `./fb2.js`,
  `./comic-book.js`, `./tts.js`). O plugin resolve esses especificadores, quando importados de dentro de
  `web/vendor/foliate-js/`, para um módulo que lança `unsupported format`. Assim o build não falha pelos arquivos
  ausentes e não inclui nada deles (nem o pdf.js).
- Não usamos o `makeBook` do `view.js`. `loader.ts` monta o livro com `new EPUB(loader).init()` sobre o `vendor/zip.js`
  (`configure({ useWebWorkers: false })`; a descompressão usa o `DecompressionStream` nativo) e passa o objeto para
  `view.open(book)`.
- Todo o foliate é carregado sob demanda (`import()` na primeira abertura de EPUB), num chunk à parte.

## APIs usadas (do commit fixado)

| API | Uso |
|---|---|
| `new EPUB({ loadText, loadBlob, getSize }).init()` (`epub.js`) | Lê `container.xml`, OPF, nav (EPUB 3) ou NCX (EPUB 2). Expõe `sections`, `toc` (`{label, href, subitems}`), `metadata`, `rendition`, `transformTarget`, `resolveCFI`, `resolveHref`, `splitTOCHref`, `getCover` |
| `book.transformTarget` → eventos `load` (`detail.allow`) e `data` (`detail.data`, `detail.type`) | Bloquear scripts e sanitizar cada recurso antes de virar URL `blob:` (ver Segurança) |
| `<foliate-view>`: `open(book)`, `goTo(cfi \| índice \| href)`, `select(cfi)`, `next()`, `prev()`, `goLeft()`, `goRight()`, `getCFI(index, range)`, `resolveCFI(cfi)`, `search({query, index?})`, `clearSearch()`, `lastLocation`, `close()` | Abrir, navegar, posição em CFI, busca |
| Eventos do view: `relocate` (`{fraction, section, tocItem, cfi, range}`), `load` (`{doc, index}`), `create-overlay` (`{index}`), `show-annotation` (`{value, index, range}`), `external-link` (cancelável) | Progresso e posição, ligar ouvintes no documento da seção, desenhar marcas, clique numa marca, links externos |
| `view.renderer` (`<foliate-paginator>` ou `<foliate-fxl>`): atributos `flow="paginated"`, `max-column-count="2"`, `max-inline-size`, `gap`, `margin`; `setStyles(css)`; `getContents()` (`[{index, doc, overlayer}]`); `focusView()` | Paginação reflow (1 coluna em janela estreita, até 2 em larga), tema/letra/espaçamento, acesso ao `Overlayer` da seção |
| `Overlayer` (`overlayer.js`): `add(key, range, draw, opts)`, `remove(key)`, `hitTest({x, y})`, `element` | Destaques, sublinhados, notas e marcas de vocabulário. Usamos funções de desenho próprias (`palette.ts`), não `Overlayer.highlight`/`underline` |
| `CFI.compare` (`epubcfi.js`) | Ordem de leitura das anotações (`annotations.ts`) |

Observações do código fixado:

- O evento `relocate` do view **não** repassa o `reason` do paginator. Por isso, o esmaecimento da virada de página é
  disparado pela própria sessão (`turn()`), não pelo motivo do relocate.
- Sem o atributo `animated`, o paginator vira a página na hora e mantém a navegação travada por 100 ms. Com
  `animated`, a animação é de 300 ms (passa do limite de 150 ms da spec 4). Então não usamos `animated`; o app faz um
  esmaecimento de 120 ms (`element.animate`), desligado com `prefers-reduced-motion`.
- O overlay do foliate é um `<svg>` dentro de shadow roots **fechados**. Os testes usam os ganchos
  `window.__epubReader` (só em dev/mock) e os iframes das seções (`page.frames()`, URLs `blob:`).
- `Range`s criados no iframe da seção são de outro realm: `instanceof Range` no app dá falso; o código testa por forma.

## Segurança (requisito)

O paginator (`paginator.js:244`) e o fixed layout (`fixed-layout.js:86`) põem as seções em iframes com
`sandbox="allow-same-origin allow-scripts"` (o WebKit precisa de `allow-scripts` para os eventos). Então o
documento de uma seção é **same-origin com o app**: um script do EPUB alcançaria a janela do app e o Tauri. Defesas:

1. **Sanitização antes de carregar** (`web/src/features/epub/sanitize.ts`, ligada em `loader.ts` no
   `transformTarget`, antes de `view.open`). Para todo recurso (X)HTML, SVG e CSS:
   - remove `<script>` (inclusive SVG e dentro de `<foreignObject>`), `<iframe>`, `<frame>`, `<frameset>`,
     `<object>`, `<embed>`, `<applet>`, `<base>`, `<portal>`, `<template>`, `<noscript>`, `<meta http-equiv>`,
     `<link rel=import|preload|prefetch|prerender|modulepreload|…>`. Em XHTML/SVG, o elemento removido vira um
     marcador vazio e inerte, para não deslocar os CFIs do resto;
   - remove todo atributo `on*`, `srcdoc`, `ping`, `action`, `formaction` e `http-equiv`;
   - remove `<set>`/`<animate*>` do SVG que mexem em `href` ou em eventos;
   - neutraliza URLs `javascript:`, `vbscript:` e `data:` que não sejam imagem ou fonte, em `href`, `src`,
     `xlink:href`, `action`, `formaction`, `poster`, `data` e afins;
   - bloqueia recursos remotos (`http(s):`, `//`, `ftp:`, `file:`, `ws:`…) em `src`, `srcset`, `poster`, folhas de
     estilo, `url()` e `@import` do CSS. Não há rede nem rastreio.
   - Itens do manifesto com tipo de script não carregam (`load` → `allow = false`, `data` → vazio). Um XHTML que não
     se pode interpretar vira um documento vazio (nunca o texto original).
2. **Links**: o foliate intercepta os cliques em `<a href>`. Links internos navegam no livro. Links `http(s)` externos
   abrem um diálogo de confirmação e depois o navegador do sistema (`@tauri-apps/plugin-opener`, `openUrl`). Outros
   esquemas são ignorados.
3. **CSP de produção** (segunda camada): `script-src 'self' 'wasm-unsafe-eval'` sem `unsafe-inline` nem `blob:`.
   Os documentos `blob:` herdam a política. O EPUB precisa de `frame-src blob:`, `style-src blob:` e
   `font-src blob:` (`img-src` já tem `blob:`); essas entradas são do pacote do app (R3, `tauri.conf.json`).
4. **Entrada não confiável**: `loader.ts` recusa zips inválidos ou vazios, livros sem OPF ou sem spine, DRM
   (`META-INF/encryption.xml` com algoritmo que não seja ofuscação de fonte, ou `META-INF/rights.xml`) e entradas
   acima de 64 MB descomprimidos (zip bomb). Cada erro vira uma mensagem em pt-BR com "Tentar de novo"; nada derruba
   a janela.

Testes: `sanitize.test.ts` (todos os vetores acima), `web/src/lib/epub/build.test.ts` (lixo, zip truncado, DRM) e
`web/e2e/epub-reader.spec.ts` (o `scriptEpub()`, com `<script>parent.__pwned=…</script>`, `<img onerror>`,
`<body onload>`, link `javascript:`, `srcdoc`, `<object>`, `<embed>`, `<set>` SVG e recursos remotos: `window.__pwned`
nunca é definido e nenhuma requisição sai, no Chromium e no WebKit).

## Componente e contrato (`web/src/features/epub/index.ts`)

- `EpubReader` (React, `forwardRef<EpubReaderHandle>`, props `{ events, hidden? }`) e `useEpubTheme()`.
- `EpubReaderHandle`: `open({uid, bytes, title, cfi?, section?, find?}) → {sectionCount}` (lança erro se o livro não
  abrir), `goTo({cfi?, section?, find?}) → {found}`, `close()` (envia o `onLocation` pendente),
  `currentLocation()`, `selectionNow()`, `setVocabMarks(section, words | null)`, `clearVocabMarks()`,
  `openDrawer('toc' | 'annotations' | 'search' | null)`, `theme`.
- `EpubReaderEvents`: `onLocation` (no máximo 1 a cada 250 ms), `onActivity` (no máximo 1 a cada 10 s, como o
  `pdfcraft:activity`), `onSelection` (300 ms), `onMenu('card' | 'ai' | 'define', seleção)`, `onVocabClick`,
  `onSectionShown`, `onKey` (atalhos do app dentro dos iframes: Ctrl/⌘+1/2/3, Alt+1/2/3, Ctrl+Shift+N,
  Ctrl+Shift+P, Alt+C, `?`), `onError`.
- Retângulos (`rect`) são `[left, top, width, height]` em px CSS, relativos ao elemento hospedeiro do livro
  (`data-testid="epub-host"`).
- `hidden` deixa o leitor invisível (`visibility: hidden`), mas mantém o layout: o foliate não perde a paginação.
- Anotações: o componente carrega e grava sozinho por `core.epubAnnotationList/Upsert/Delete`. A criação é otimista
  (uid temporário até o núcleo devolver o definitivo); edição e exclusão esperam a criação pendente.

## Aparência (spec 4)

- Barra discreta com os componentes do app: Sumário (gaveta com o sumário aninhado e o item atual marcado), título,
  progresso ("Cap. 3 · 42%"), Buscar (resultados → `goTo`), "Aa" (tema Claro/Sépia/Escuro, letra de 80 a 200 % em
  passos de 10 %, espaço entre linhas), Anotações (ordenadas por CFI; clique → `goTo`; apagar) e o marcador da
  página.
- Temas pelo `renderer.setStyles`: Claro `#ffffff`/`#1f1f1f`, Sépia `#f4ecd8`/`#5b4636`, Escuro `#1e1e1e`/`#d6d6d6`.
  No Escuro, o texto fica legível à força; links mantêm a cor do livro, a menos que o contraste fique abaixo de 3.
  As preferências ficam em `localStorage` `leitor.epub.prefs`.
- Destaques como os do PdfCraft: as 10 cores de `SWATCHES` (`third_party/pdfcraft/crates/ui-egui/src/comments.rs`,
  padrão Amarelo `#fff000`). O preenchimento é opaco com blend Multiply (`/BM /Multiply`, opacidade 1, como em
  `crates/annot/src/appearance.rs`). Na página escura, o Multiply apagaria tudo, então o preenchimento fica normal
  com opacidade 0,38. Sublinhado de 2 px na cor. Nota = destaque + o ícone de balão do PdfCraft (`note_icon`) no fim
  do trecho. Marcador = fita vermelha no canto da página.
- Vocabulário: sublinhado de 2 px na cor recebida (coral/âmbar), nunca fundo. Até 4000 marcas por seção. As palavras
  são achadas com `Intl.Segmenter('en', {granularity: 'word'})`, em minúsculas e com apóstrofos normalizados; um
  possessivo marca o radical. As marcas são redesenhadas quando a paginação muda (por exemplo, ao mudar a letra).

## Desempenho medido (Playwright, contêiner)

`a 1 MB EPUB opens fast…` em `web/e2e/epub-reader.spec.ts`: livro de 0,94 MB, do `open()` até a primeira página
pronta ≈ 0,3 s no Chromium e no WebKit (limite: 1,5 s no Chromium). Virada de página até o relocate: ≈ 1–2 ms
(limite: 150 ms).

## Testes

- Vitest: `web/src/features/epub/*.test.ts(x)` (sanitizador, paleta igual a `SWATCHES`, preferências, ordem por
  CFI, vocabulário, teclas, componente com livro ilegível) e `web/src/lib/epub/build.test.ts` (o EPUB gerado abre
  no `EPUB` do foliate, EPUB 2/3, deflate, sem sumário, lixo e DRM).
- Playwright (`pnpm --dir web e2e:mock`, Chromium + WebKit): `web/e2e/epub-reader.spec.ts` sobre a página de teste
  `/src/features/epub/harness/index.html?book=sample|epub2|script|garbage|notoc|drm|big[&section=N&cfi=…&find=…]`
  (só no servidor de dev/mock; fora do build de produção).
- Livros de teste gerados em código: `web/src/lib/epub/build.ts` (`buildEpub`, `sampleEpub` = "The Time Machine",
  domínio público, com sumário aninhado e imagem; `scriptEpub` para a segurança). Nada grande vai para o git.
