# Fixtures do `core-anki`

A coleção de teste **não é um arquivo binário commitado**: ela é montada em código por
`core_anki::fixture::build(pasta, FixtureOptions)` (`src/fixture.rs`), a cada teste, numa pasta
temporária. Os testes usam o helper `tests/common/mod.rs` (`fixture()`), que monta a coleção e a
abre num `AnkiService`.

Conteúdo (determinístico; os ids mudam a cada montagem):

| Baralho | Conteúdo |
|---|---|
| `5000 palavras` | 8 notas Básico (a 1ª com `<img src="fixture-image.png">`, a 2ª com `[sound:fixture-audio.wav]`) e 1 nota "Vocabulário · Livro" com `{{tts en_US:Palavra}}`; 3 cards de revisão para hoje com intervalos diferentes, 1 em aprendizado, os demais novos; 2 respostas hoje ("Estudados hoje" > 0) |
| `Oxford::Oxford 3000` | 5 cards novos |
| `Oxford::Oxford 5000` | vazio |
| `ROS 2 — Revisão` | 2 notas "Código · Comando" (`{{type:Resposta}}`) e 1 nota do tipo padrão "Básico (digitar a resposta)" |
| `Matemática` | Básico com `\(\frac{a}{b}\)` e `\[x^2\]` (MathJax) |
| `Gramática::Cloze` | "Cloze (Leitor)" com `c1` e `c2` |
| `Livros::Animal Farm` | "Básico (Leitor)" com `Fonte` = `<a href="leitor://livro/<64 hex>?pagina=37&q=windmill">Animal Farm, p. 37</a>` |
| `Isolamento (teste)` | só com `FixtureOptions { isolation_probe: true }`: o card da sonda de isolamento (`fixture::ISOLATION_PROBE_FRONT`) |

A mídia (PNG 16×16 e WAV de 0,2 s a 8 kHz) também é gerada em código. Os cinco tipos de nota do
app são criados antes por `notetypes::prepare_collection`.

Para ver a coleção no app real (capturas de tela, sondas):

```sh
scripts/dev.sh bash -c 'cd src-tauri && cargo run -p core-anki --example seed_fixture -- "$LEITOR_DATA_DIR/anki" [--isolation-probe] [--force]'
```

O exemplo imprime o `FixtureInfo` em JSON (baralho → id, primeiro card de cada baralho, notas por
papel e o `bookUid`). A coleção não pode estar aberta; sem `--force`, uma pasta que já tem coleção é
recusada.

`bridge/` guarda as requisições gravadas das páginas do Anki (adicionadas pelo integrador).
