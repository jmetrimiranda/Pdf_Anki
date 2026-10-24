# Núcleo EPUB (`core-epub`)

Spec: 7.1 (EPUB: leitor foliate-js na aba Leitor; o núcleo extrai o texto por capítulo e o sumário), 12.3 B (texto de
cada capítulo pelo `core-epub`), 14 (`book_text`, `epub_annotation`, `reading_position.cfi`), 18 (arquivos não
confiáveis nunca derrubam o app), 21 (Fase 7).

Rust puro, síncrono, sem APIs de desktop (serve ao iPad depois), `#![forbid(unsafe_code)]` pelos lints do workspace.
Dependências: `zip` 4.6 (MIT; só `deflate` em Rust puro — sem bzip2/zstd/lzma/aes), `quick-xml` 0.42 (MIT),
`encoding_rs` 0.8 (já no grafo pelo Anki/reqwest), `percent-encoding`, `sha2`/`hex`. O leitor em si é o foliate-js na
interface (docs/tecnico/foliate.md); o núcleo não renderiza nada.

## API

```rust
pub fn open(bytes: Arc<Vec<u8>>) -> Result<EpubBook, EpubError>;
impl EpubBook {
    fn meta(&self) -> &EpubMeta;            // title, authors, language, identifier, version V2|V3
    fn sections(&self) -> &[Section];       // index, id, href (caminho no zip), media_type, linear
    fn toc(&self) -> &[TocItem];            // title, href, fragment, section, children
    fn toc_is_fallback(&self) -> bool;
    fn cover(&self) -> Option<CoverImage>;  // PNG/JPEG/GIF/WebP ≤ 10 MiB
    fn section_text(&self, section: u32) -> Result<SectionText, EpubError>;
    fn texts(&self, cancel: &AtomicBool, progress: &mut dyn FnMut(u32, u32)) -> Result<Vec<SectionText>, EpubError>;
    fn text_fingerprint(&self) -> String;   // = fingerprint_of(&texts)
    fn section_label(&self, section: u32) -> Option<String>;
    // extras: section_of_href, section_for_cfi, spine_position, file_bytes
}
pub fn fingerprint_of(texts: &[SectionText]) -> String;
pub fn section_of_cfi(cfi: &str) -> Option<u32>;  // posição no spine (passo N/2 − 1)
pub fn is_valid_cfi(cfi: &str) -> bool;
```

`EpubBook` é `Send + Sync + Clone` (o zip é compartilhado por `Arc`); todo método recebe `&self`. Toda função pública
roda sob um `catch_unwind` (`error::guard`, como no `core-pdf`): um pânico numa dependência vira `EpubError::Internal`.

### Erros (`Display` em pt-BR, `code()` para o contrato de comandos)

| Variante | `code()` | Mensagem |
|---|---|---|
| `NotEpub` | `epub_invalid` | Este arquivo não é um EPUB válido ou está danificado. |
| `Damaged(detalhe)` | `epub_invalid` | idem (o detalhe, em inglês, só vai para o log/`Debug`) |
| `Drm` | `epub_drm` | Este EPUB está protegido por DRM e não pode ser aberto. |
| `TooLarge` | `epub_too_big` | O EPUB é grande demais para abrir. |
| `NoContent` | `epub_empty` | Este EPUB não tem capítulos para ler. |
| `Cancelled` | `cancelled` | A leitura do texto do livro foi cancelada. |
| `Internal` | `epub_internal` | Erro interno no leitor de EPUB. |

## Estrutura e passos de leitura

1. **Zip** (`archive.rs`): precisa começar com `PK` e ter diretório central legível (senão `NotEpub`). Até 20 000
   entradas (`TooLarge`). Entrada com o bit de criptografia → `Drm`. Entrada > 1 MiB com razão de compressão
   > 1000:1 → `TooLarge` (bomba). Os tamanhos declarados nunca são confiados: toda leitura passa por
   `Read::take(limite + 1)`. Os hrefs são só chaves de busca no zip (busca exata, depois sem diferença de
   maiúsculas); nada é extraído para o disco e `..` não sai da raiz.
2. **container.xml** → primeiro `rootfile` com `full-path` (preferindo `application/oebps-package+xml`). Sem container
   (ou ilegível): o primeiro `*.opf` do zip. Nenhum dos dois → `NotEpub`. OPF ausente ou que não é XML/sem
   `<package>`, `<manifest>` ou `<spine>` → `Damaged`.
3. **OPF**: `package@version` começando com 3 → `V3`, senão `V2`. Metadados `dc:title` (primeiro não vazio),
   `dc:creator` (todos, sem repetição), `dc:language`, `dc:identifier` (o apontado por `unique-identifier`, senão o
   primeiro); espaços colapsados. Manifesto com hrefs resolvidos em relação ao OPF e decodificados (`%20` → espaço).
   Spine com `linear="no"` e `toc` (id do NCX).
4. **DRM**: `META-INF/rights.xml` → `Drm`. `META-INF/encryption.xml` → `Drm` se algum `EncryptedData` usa um algoritmo
   que não é ofuscação de fonte (`http://www.idpf.org/2008/embedding`, `http://ns.adobe.com/pdf/enc#RC`) ou se a
   "ofuscação" aponta para um documento de conteúdo (XHTML/HTML/XML/NCX/SVG ou o próprio OPF). `encryption.xml`
   ilegível também conta como `Drm`. Fontes só ofuscadas abrem normalmente.
5. **Seções** = todos os `itemref` do spine, na ordem, lineares e não lineares. Itemref sem item no manifesto é
   pulado (veja "Alinhamento com o foliate-js"). Nenhuma seção → `NoContent`.
6. **Sumário**: nav do EPUB 3 (item com `properties="nav"`, primeiro `<nav epub:type="toc">`, `<ol>/<li>` aninhados,
   rótulo do `<a>` ou `<span>`, ou o `title`) primeiro; se faltar, estiver vazio ou ilegível, o NCX do EPUB 2
   (`spine@toc`, senão o item `application/x-dtbncx+xml`; `navMap/navPoint` aninhados). Cada href é resolvido em
   relação ao arquivo nav/NCX, decodificado, com o `#fragmento` separado em `fragment`, e ligado à seção do mesmo
   arquivo (`section`; `None` para links externos ou arquivos fora do spine). Um título sem link (`<span>`) recebe a
   seção do primeiro filho e `href` vazio. Itens sem título viram "Seção N"; folhas sem título e sem destino somem.
   Limites: profundidade 32 (níveis mais fundos são descartados) e 10 000 itens.
7. **Sumário de reserva** (`toc_is_fallback() == true`) quando nav e NCX faltam ou não têm itens: um item por seção
   linear (todas, se nenhuma for linear), com o primeiro `<h1>`–`<h3>` dos primeiros 256 KiB da seção, senão o
   `<title>`, senão "Seção N" (N = índice + 1).

## Unidade = índice da seção

Em todo o app a unidade de texto de um EPUB é o índice da seção (`Section::index`, `SectionText::section`): é a
`unit` de `book_text` e da tabela de lemas por unidade do vocabulário (spec 12), e o "capítulo" dos intervalos.
`section_label(n)` é o título do item mais fundo do sumário que cobre a seção: o item com a maior seção ≤ n; entre
itens que começam na mesma seção ganha o que aponta para o arquivo sem `#fragmento` (início da seção), depois o mais
fundo, depois o primeiro na ordem de leitura. Seções antes do primeiro item (capa, folha de rosto) ficam sem rótulo.

## CFI → seção

Um CFI de EPUB começa pelo passo do spine: `epubcfi(/6/N[id]!/…)`. `/6` é o elemento `spine` dentro do `package`
(o foliate-js calcula o índice real; aceitamos qualquer passo par > 0) e `N` (par, ≥ 2) é o filho `itemref`:
**posição no spine = N/2 − 1**. Asserções `[id]` (com escapes `^`), indireção `!` e CFIs de intervalo
(`epubcfi(/6/4!/4,/2/1:0,/3:5)`) são aceitos; qualquer outra coisa → `None`. `is_valid_cfi`: começa com `epubcfi(`,
termina com `)`, ≤ 4096 bytes, sem caracteres de controle (o que o banco aceita em `epub_annotation.cfi` e
`reading_position.cfi`). `section_of_cfi` devolve a posição no spine; `EpubBook::section_for_cfi` a converte para o
índice da seção (iguais, salvo itemrefs sem item no manifesto).

## Alinhamento com o foliate-js

Conferido no commit fixado `78914aef4466eb960965702401634c2cb348e9b1` (`epub.js`):

- `book.sections` = `resources.spine.map(...)` com `.filter(s => s)`, onde o item vira `null` quando o `idref` não
  existe no manifesto. Lineares e não lineares ficam (com `linear`). Logo `book.sections[i]` é a nossa seção `i`, e o
  `index` dos eventos `relocate` do foliate é a nossa unidade.
- O CFI de cada seção vem de `CFI.fromElements($$itemref)` sobre **todos** os itemrefs, isto é, a posição no spine.
  Com um itemref órfão, o próprio foliate desalinha (`resolveCFI`/`resolveHref` devolvem o índice no spine e o usam em
  `book.sections`). Por isso `section_for_cfi` faz o mapeamento explícito; em livros sãos as duas numerações coincidem.
- O foliate usa o nav quando existe (mesmo vazio) e só então o NCX; nós também caímos para o NCX quando o nav não tem
  itens. O sumário do núcleo serve aos rótulos e aos intervalos do vocabulário; a navegação do leitor usa o do foliate.
- Hrefs: o foliate resolve em relação ao arquivo e aplica `decodeURI`; nós decodificamos percent-encoding da mesma
  forma, então `TocItem::href` bate com o `id` (href) das seções do foliate.

## Texto (busca e vocabulário)

- Codificação: UTF-8 (com ou sem BOM); UTF-16 LE/BE (BOM, ou `<` seguido de NUL); senão, se não for UTF-8 válido, a
  codificação declarada (`<?xml encoding=…?>` ou `<meta charset>`/`charset=`) via `encoding_rs` (rótulos WHATWG:
  `iso-8859-1` → windows-1252); senão UTF-8 com substituição. Nunca falha.
- quick-xml com checagem de nomes de fechamento desligada, `&` solto aceito e fechamentos órfãos ignorados. Erro
  sintático duro → removedor de tags tolerante só para aquela seção (comentários, CDATA, `<script>`/`<style>`
  pulados, `<` solto vira texto). Uma seção nunca derruba o livro.
- Viram quebra de linha: `p, div, h1–h6, li, blockquote, pre, tr, section, article, aside, header, footer,
  figcaption, dt, dd, hr, br` (e `ul, ol, table, body`). `td`/`th` viram espaço (células não grudam palavras).
- Ignorados: `head` (inclusive `title`), `script`, `style`, `svg`, `math`, `rt`, `rp`, `template`, `noscript`.
- Entidades: as cinco do XML, referências numéricas (`&#0;`/inválidas → U+FFFD) e uma tabela estática das entidades
  HTML comuns (Latin-1 completo, tipografia: `nbsp`, `mdash`, `ndash`, `hellip`, aspas, `copy`…). Desconhecidas ficam
  literais.
- Espaços (inclusive `&nbsp;`) colapsados dentro da linha, linhas aparadas, linhas vazias descartadas; hífen suave e
  espaço de largura zero removidos.
- Seções que não são (X)HTML/XML/texto (imagens no spine) têm texto vazio; seção ilegível (entrada ausente, deflate
  corrompido) também, com aviso no log — mas se **todas** falharem, `texts()` dá `Damaged`.
- `texts()` confere `cancel` antes de cada seção (→ `Cancelled`), chama `progress(feitas, total)` depois de cada uma e
  limita o total descomprimido a 512 MiB (`TooLarge`); uma seção > 16 MiB → `TooLarge`.
- `text_fingerprint()` = SHA-256 de `core-epub/1`, do número de seções e, por seção, índice, tamanho e texto. Muda
  quando o texto muda (não com título/OPF/empacotamento). `fingerprint_of(&texts)` evita reler o livro.

## Capa

Ordem: item com `properties="cover-image"` (EPUB 3) → `<meta name="cover" content="id">` (EPUB 2; aceita também um
href) → item de imagem do manifesto cujo id ou href contém "cover" → primeira `<img>` (ou `<image href>` de SVG) dos
primeiros 256 KiB da primeira seção. SVG é ignorado; o tipo vem dos bytes (PNG/JPEG/GIF/WebP), não do manifesto;
máximo 10 MiB. Candidatos inválidos passam para a próxima estratégia.

## Limites

| O quê | Limite | Erro |
|---|---|---|
| Entradas no zip | 20 000 | `TooLarge` |
| container.xml, OPF, nav, NCX, encryption.xml | 4 MiB cada | `TooLarge` |
| Uma seção | 16 MiB | `TooLarge` |
| Capa | 10 MiB | ignorada |
| Total descomprimido em `texts()` | 512 MiB | `TooLarge` |
| Razão de compressão (entradas > 1 MiB) | 1000:1 | `TooLarge` |
| Aninhamento XML nos arquivos de pacote | 256 | `Damaged` |
| Sumário | profundidade 32, 10 000 itens | cortado |
| CFI | 4096 bytes | inválido |

`core_epub::limits` exporta essas constantes.

## Testes e fixtures

Nada binário no repositório: a feature `testkit` (`core_epub::testkit`, também usada pelo app como dev-dependency)
gera tudo em código — `EpubBuilder` (V2/V3, título, autores, idioma, capítulos `ChapterSpec` aninhados, cada um com
seu XHTML ou como `#fragmento` no arquivo do pai, `with_nav`/`with_ncx`, `cover_png`, `with_image`, `non_linear`,
`extra_file`, `with_container`; `build()` grava `mimetype` primeiro e sem compressão), `EpubBuilder::sample(v)`
(sumário de 3 níveis, fragmento, imagem e capa), `zip_entries`/`zip_raw`, `tiny_png`, `garbage`, `truncated`, `Rng`,
`zip_bomb`, `drm_epub`, `encrypted_entries_epub`, `encryption_xml`, `without_container`, `without_toc` e
`script_epub` (`<script>`, `onload`, `onerror`, `javascript:`, `<iframe>`, `<object>`, script em SVG; todos marcariam
`window.parent.__epubScriptRan`).

```sh
scripts/heavy.sh "core-epub tests" -- scripts/dev.sh bash -c 'cd src-tauri && CARGO_INCREMENTAL=0 cargo test -j 8 -p core-epub --all-features && cargo clippy -j 8 -p core-epub --all-targets --all-features -- -D warnings'
# desempenho (1 MB / 100 mil palavras: open + texts < 300 ms em release)
cargo test --release -p core-epub --test text -- --ignored --nocapture
# livro de exemplo (A Máquina do Tempo, H. G. Wells, domínio público; trechos dos capítulos I–VI)
cargo run -p core-epub --example sample_epub -- /tmp/the-time-machine.epub
```

`tests/parse.rs` (EPUB 2 só NCX, EPUB 3 só nav e nav + NCX, sumário de 3 níveis com fragmentos, hrefs relativos ao
diretório do nav e com percent-encoding, sumário de reserva, itemref não linear e órfão, metadados, as 4 estratégias de
capa e SVG ignorado), `tests/text.rs` (entidades, `&nbsp;`, `<br>`, blocos, script/style, UTF-16 com BOM,
windows-1252 declarado, XHTML malformado, progresso/cancelamento, impressão digital, desempenho `#[ignore]`) e
`tests/robustness.rs` (2 000 mutações determinísticas em < 10 s em debug, lixo, arquivo vazio, PDF renomeado, zip sem
container, container apontando para OPF ausente, OPF que não é XML, bomba, DRM, 30 mil entradas, sumários fundos e
enormes, hrefs hostis, CFIs inválidos). Nenhum pode terminar em `Internal` (seria um pânico capturado).

Medido no devcontainer (23/10/2026): 2 000 mutações em ~0,15 s (debug; 1 441 viram erro, o resto abre com seções
vazias); `open` + `texts()` de 100 seções / 100 200 palavras / 1,09 MB de texto em ~6 ms (release) e ~8 ms (debug).
