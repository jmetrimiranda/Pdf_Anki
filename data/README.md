# Dados de vocabulário

`scripts/build-wordnet.sh` gera `data/generated/vocab/` (fora do git): `vocab-en.sqlite` (Open English WordNet 2025,
CC BY 4.0; frequência Zipf do wordfreq 3.1.1, CC BY-SA 4.0; stopwords do Snowball, BSD-3-Clause), `vocab-data.json`,
`CREDITS.txt` e `LICENSES/`. Fontes fixadas por SHA-256, esquema e atribuições: [docs/tecnico/vocab-data.md](../docs/tecnico/vocab-data.md).

`LICENSES/` tem os textos das licenças desses dados (as mesmas cópias vão junto do pacote gerado e do app).
