# Dados de vocabulário e motor `core-vocab`

Spec: 12 (escaneamento de vocabulário, atualizada em 23/10/2026), 12.2 (dados embutidos), 12.3 (algoritmo A–I),
12.4–12.6 (métricas, relatório, deck), 12.7 (marcas), 12.8 (desempenho), 21 (Fase 6).

## Pacote de dados (`scripts/build-wordnet.sh`)

`scripts/build-wordnet.sh` baixa as fontes fixadas abaixo (cada uma na sua pasta em `data/generated/cache/`,
conferidas por SHA-256; nada baixado é executado), roda o conversor `scripts/vocab-data/build_vocab_db.py` com
`python3 -I` (só biblioteca padrão) e grava em `data/generated/vocab/` (fora do git):

| Arquivo | Conteúdo |
|---|---|
| `vocab-en.sqlite` | O léxico (esquema abaixo), ~21 MB |
| `vocab-data.json` | `{schemaVersion, wordnet, frequency, stopwords: {name, release, sha256, license, url}, builtFrom, counts, sqliteSha256, sqliteBytes}` |
| `CREDITS.txt` | Atribuições em pt-BR e inglês (vai para a tela "Sobre") |
| `LICENSES/` | `CC-BY-4.0.txt`, `CC-BY-SA-4.0.txt`, `Snowball-BSD-3-Clause.txt` (cópias também em `data/LICENSES/`) |

Idempotente: um carimbo (`.stamp` = hash do script + conversor + SHA-256 das fontes) faz a segunda execução imprimir
"up to date"; `--force` refaz. A saída é determinística (inserções ordenadas, `ANALYZE`, `VACUUM`).
`python3 -I scripts/vocab-data/build_vocab_db.py --self-test` testa o conversor com um LMF, um cBpack e uma lista de
stopwords mínimos (inclusive msgpack inválido e determinismo). O CI roda os dois antes de qualquer `cargo test` ou
`tauri build` (cache pela hash do script e do conversor) com `LEITOR_REQUIRE_VOCAB_DATA=1`. O app embute
`data/generated/vocab` como recurso do Tauri (download no primeiro uso é só para o iPad, adiado).

### Fontes fixadas

| Fonte | Versão | URL | SHA-256 | Licença |
|---|---|---|---|---|
| Open English WordNet (WN-LMF XML) | 2025 (`2025-edition`) | `https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025.xml.gz` | `9ca6d1dcb75f822fdd66617f7d9da48142ace38dd544d6ad5e2feca1674ad3fe` | CC-BY-4.0 |
| wordfreq (sdist do PyPI; só `wordfreq/data/large_en.msgpack.gz`) | 3.1.1 | `https://files.pythonhosted.org/packages/4c/cd/9581ff0ea2c581012d0caae4bba024f3ff6b46e030a55ddec1ce545e2caf/wordfreq-3.1.1.tar.gz` | `7943098975f25c2a70e1151ee5a62083b14a5f86f6cc5703cc9526f716ceb408` | dados CC-BY-SA-4.0 (código Apache-2.0, não usado) |
| Snowball, lista de stopwords do inglês | commit `dc14fb462784e5bdf90f3210022b0f91d3881ffd` de `snowballstem/snowball-website` | `…/algorithms/english/stop.txt` | `06b8b14bbe6f6e0b64c0830813819416d96a71bec1655668d83b3e602a651db6` | BSD-3-Clause |
| Licença Snowball (`license.tt`, mesmo commit) | — | `…/license.tt` | `f629f037a1849c71ecbea77f5916a6433c9854db5e0298dc90556eba94c0773b` | — |
| CC BY 4.0 legalcode | — | `https://creativecommons.org/licenses/by/4.0/legalcode.txt` | `9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411` | — |
| CC BY-SA 4.0 legalcode | — | `https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt` | `28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5` | — |

Verificado no arquivo fixado: o LMF de 2025 traz as formas irregulares como `<Form writtenForm>` em
`LexicalEntry` (4.473 formas: went/gone → go, children → child, mice → mouse, studied → study…), então não usamos os
`*.exc` do WNDB. As relações `derivation` e `pertainym` são de sentido (`SenseRelation`) e viram relações entre lemas.

**Licença da frequência.** O README do sdist 3.1.1 diz: código Apache-2.0; dados CC-BY-SA 4.0, derivados de Google
Books Ngrams (uso livre, com agradecimento pedido), Leeds Internet Corpus, Wikipedia, ParaCrawl, OpenSubtitles 2018
(com atribuição), SUBTLEX (permissão de Marc Brysbaert para qualquer uso, com crédito e deixando claro que o SUBTLEX é
livre) e estatísticas do Twitter. Não há bloqueio: a lista Zipf das 100 mil palavras é um arquivo de dados à parte,
distribuído sob CC-BY-SA 4.0 com a atribuição completa, nunca misturado ao código (mesmo precedente dos modelos de OCR
CC-BY-SA).

### Atribuição (texto exato, também em `CREDITS.txt`)

- Léxico, formas irregulares, relações de derivação e definições: **Open English WordNet 2025**, de John P. McCrae e
  colaboradores, licença CC BY 4.0. Convertido para SQLite (só lemas, classes, formas, relações derivation/pertainym,
  phrasal verbs e a definição do primeiro sentido). Baseado no Princeton WordNet 3.0.
- Frequência geral (escala Zipf) das 100 mil palavras inglesas mais frequentes, extraída dos dados do **wordfreq 3.1.1**
  de Robyn Speer, licença CC BY-SA 4.0 (este arquivo de dados é distribuído sob a mesma licença). Fontes do wordfreq:
  Google Books Ngrams, Leeds Internet Corpus, Wikipedia, ParaCrawl, OpenSubtitles 2018, SUBTLEX (Brysbaert et al.;
  dados livremente disponíveis), Twitter.
- Lista de palavras funcionais do **Snowball** (Martin Porter e Richard Boulton), licença BSD de 3 cláusulas.

### Esquema (`meta.schema_version = 1`; o leitor Rust recusa outra versão)

```sql
meta(key TEXT PRIMARY KEY, value TEXT)          -- schema_version, {wordnet,frequency,stopwords}_{name,release,sha256,license,url}, built_from
lemma(id INTEGER PRIMARY KEY, word TEXT, pos TEXT CHECK (pos IN ('n','v','a','r')), sense_count INTEGER,
      definition TEXT, UNIQUE (word, pos))      -- satélites 's' viram 'a'; a grafia do WordNet fica ("Napoleon")
CREATE INDEX lemma_lower ON lemma (lower(word))
form(form TEXT, lemma_id INTEGER, PRIMARY KEY (form, lemma_id))            -- formas irregulares
relation(from_id, to_id, kind CHECK (kind IN ('derivation','pertainym')), PRIMARY KEY (from_id, to_id, kind))
                                                -- derivation nos dois sentidos; pertainym só from → to (quickly → quick)
freq(word TEXT PRIMARY KEY, zipf REAL)          -- 100 mil palavras com letra e sem dígito; zipf = 9 − i/100 (balde i do cBpack)
stopword(word TEXT PRIMARY KEY)                 -- Snowball (174 palavras)
phrasal(lemma_id INTEGER PRIMARY KEY, verb TEXT, particle TEXT)
                                                -- verbos de duas palavras cuja segunda é partícula (up, down, in, out, on,
                                                -- off, over, away, back, through, about, around, along, across, by,
                                                -- forward, together, apart, aside)
```

A definição é a glosa do synset do **primeiro sentido** da entrada (ordem do OEWN). Entradas repetidas com a mesma
grafia e classe somam `sense_count` e ficam com a definição da primeira. Contagens da build de 2025: 135.909 lemas,
4.450 formas, 48.386 relações, 1.763 phrasal verbs, 100.000 frequências, 174 stopwords; 21,2 MB.

## Motor (`src-tauri/crates/core-vocab`)

Puro Rust (sem `core-anki`/`core-pdf`/`core-store`, sem APIs só de desktop), nunca entra em pânico (testes com lixo
aleatório), mensagens em pt-BR. Páginas são 0-based nos dados e 1-based só no que se mostra; são as páginas
**físicas** do PDF (não `/PageLabels`).

- **`Lexicon::open(path)`** carrega tudo em memória menos as definições (lidas do SQLite sob demanda, atrás de um
  `Mutex`): ~0,3 s em release. `Lexicon::from_parts(TestLexicon)` (e `TestLexicon::sample()`) servem aos testes sem
  dados.
- **Limpeza (B):** junta "exam-\nple"; tira linhas que, com dígitos normalizados, aparecem em mais de 30% das páginas
  (só em livros com 5 páginas ou mais, linhas de até 120 caracteres); tira linhas só com número de página ("12",
  "- 12 -", "Page 12", "xii"), URLs e e-mails; normaliza ’ ‘ ʼ para '. Quebras de linha viram espaço, menos depois de
  uma linha curta com cara de título ("Chapter One") seguida de maiúscula, que vira limite de frase.
- **Palavras (C):** UAX #29 (palavras e frases); descarta números, tokens sem letra, algarismos romanos em maiúsculas
  (≥ 2 letras, sintaxe válida: "XIV" sai, "CIVIL" fica) e pedaços de contração (`n't` → base, com can't → can,
  won't → will, shan't → shall; `'s 'll 're 've 'd 'm` e possessivo saem).
- **Lematização (D):** formas irregulares do OEWN; regras do morphy por classe (substantivo: s, ses, xes, zes, ches,
  shes, men, ies; verbo: s, ies, es, ed, ied, ing; adjetivo: er, est, ier, iest) e consoante dobrada
  (running → run, bigger → big); só candidatos do léxico ou do índice do usuário; escolha: o do índice; senão o de
  maior Zipf; a própria forma só ganha de uma redução se for ao menos 1,0 Zipf mais frequente (physics, news) —
  "running" → run, "glasses" → glass. A tabela é feita sem o índice e guarda as alternativas (`alts`).
- **Nome próprio (E):** inicial maiúscula fora do início de frase ao menos uma vez, a forma minúscula em menos de 10%
  das ocorrências no livro, não é palavra funcional e não é lema minúsculo comum (lema minúsculo no WordNet com
  Zipf ≥ 3,5), a não ser que o WordNet também tenha o lema com maiúscula (Napoleon, Boxer). O limite 3,5 (em vez de
  3,0) deixa "Snowball" (snowball, Zipf 3,18) como nome. As ocorrências minúsculas continuam palavra comum.
- **Tabela (F):** `build_book_table` → `BookTable {pageCount, lemmas, pages}`; por (lema, página): ocorrências, forma
  original mais comum, formas, exemplo (primeira frase da página com 8–30 palavras; senão uma janela de 30 palavras),
  posição do exemplo em UTF-16 e `position` (índice da primeira ocorrência entre as palavras da página, para a ordem
  de leitura). 100 mil palavras: ~0,3 s em release.
- **Formas (I):** uma forma flexionada de verbo/adjetivo que também é lema próprio de substantivo ou adjetivo no
  WordNet (learning, meaning, feeling, building, interesting; também learned, saw, left…) fica como chave própria da
  tabela com a base em `alts`; plurais regulares de substantivo não se separam. Na comparação, se uma base é conhecida
  (deck, ajuste "já sei" ou palavra funcional), a linha vai para o grupo `forms`, conta como conhecida e vem
  desmarcada com `base`.
- **Famílias (I):** `Lexicon::family_bases` = ligações `derivation` do OEWN para um lema **mais curto** (learner →
  learn, happiness → happy), `pertainym` (quickly → quick) e, de reserva, regras de afixo validadas por as duas
  palavras serem lemas do WordNet com a classe certa (un-, re-, dis-, mis-, in-/im-/il-/ir-, non-; -ness, -ly, -er/-or,
  -ment, -ful, -less, -able/-ible, -ity, -ation: unlearn → learn). A base escolhida é a conhecida de maior Zipf.
  `derivedPolicy = card` → linha desconhecida com `family`; `known` → conhecida (`statusSource = family`).
- **Phrasal verbs (H):** verbo + partícula adjacentes na mesma frase que existem na tabela `phrasal` viram chaves
  com espaço ("look up"), grupo `phrasal`, comparadas só com expressões de várias palavras dos decks; não entram nas
  métricas de tokens.
- **Comparação (G) e métricas (12.4):** `compare(CompareInput)` → `ScanResult {metrics, chapters, rows}`, só com as
  páginas do trecho. A curva começa na cobertura "com aprendizado" e soma os lemas desconhecidos (e suspensos) do mais
  ao menos frequente; `wordsTo95/98` = 0 se a meta já foi atingida. Suspensas com a política "ignorar" aparecem como
  `suspended` (já são nota da pasta, não ficam marcadas) e contam como desconhecidas.
- **Trechos (12.1, passo 2):** `parse_pages`, `outline_ranges` (regra: do item até a página anterior ao próximo item,
  na ordem do documento, do mesmo nível ou acima com página maior; próximo item na mesma página → uma página; sem
  página → não selecionável), `resolve_range`, `chapters` (itens do topo do sumário; sem sumário, blocos de 20 páginas).
- **Nomes (12.6):** `slug`, `book_tag`, `range_tag`, `chapter_tag`, `chapter_subdeck`, `vocab_deck_names` (subdecks por
  capítulo ficam sob o deck do livro; o subdeck do trecho só sem subdecks por capítulo; a tag `trecho::…` sempre que o
  escaneamento for de um trecho), `vocab_note_fields` (Família = lema conhecido da família; Tradução vazia — gancho
  da Fase 8).
- **Marcas (12.7):** `StatusOracle::classify_words` usa a mesma tokenização, chave e comparação da tabela.
- **Conferência manual (12.8):** `sample_tokens` + `to_csv` (colunas `lemma_ok`/`status_ok` para preencher);
  `cargo run -p core-vocab --example vocab_sample_text -- data/generated/vocab livro.txt` para texto puro (páginas
  separadas por `\f`). Aguardando um livro real do usuário.

`ALGO_VERSION` invalida as tabelas guardadas quando a tokenização/lematização muda.

### Testes

`cargo test -j 8 -p core-vocab` (os testes com dados reais leem `LEITOR_VOCAB_DATA_DIR` ou
`data/generated/vocab`; sem os dados são pulados, a não ser com `LEITOR_REQUIRE_VOCAB_DATA=1` ou `CI`, quando
falham). Desempenho em release: `cargo test --release -p core-vocab --test perf -- --ignored --nocapture`
(livro gerado de 300 páginas/100 mil palavras: `Lexicon::open` ≤ 1,5 s, tabela ≤ 2 s, comparação de ≥ 10 mil lemas
≤ 300 ms). `cargo run -p core-vocab --example vocab_probe -- data/generated/vocab went learning …` mostra como o
motor vê palavras.
