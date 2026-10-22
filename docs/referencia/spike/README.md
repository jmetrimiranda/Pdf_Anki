# Protótipo: núcleo do Anki + motor do PdfCraft num binário só

Feito em 22/10/2026 para provar que os dois motores convivem. Compilou e rodou em Linux x86_64 (Rust 1.97.0, build de debug).

Como reproduzir:

1. `git clone --branch 26.09.3 https://github.com/ankitects/anki` e `git submodule update --init --depth 1` (traduções).
2. `git clone https://github.com/storytold/pdfcraft` (anote o commit usado).
3. Baixe o protoc 31.1 e exporte `PROTOC=/caminho/protoc`.
4. Troque `<caminho>` no `Cargo.toml` pelas pastas clonadas.
5. `cargo run -j 2 -- sample.pdf`

Saída obtida:

```
anki: exported 1 note(s) to /tmp/spike-leitor-anki/vocab.apkg
anki: imported 1 new note(s)
anki: deck tree root children = 1
anki: queue new=1 learn=0 review=0
anki: front html = "windmill"
anki: revlog rows = 1, time = 4200 ms
pdf: 1 page(s)
pdf: rendered 1191x1684 in 274 ms -> /tmp/spike-leitor-anki/page1.png
pdf: page text chars = 293
```

A segmentação de palavras do protótipo (`word_at`) não é a certa para o app: o app segmenta com UAX #29 sobre o texto e mapeia de volta pelos índices de glifo (seção 6.3 da especificação).
