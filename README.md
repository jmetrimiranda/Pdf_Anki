# Leitor de Estudos

Leitor de PDF (e, mais adiante, EPUB) com o núcleo do Anki dentro. Você lê o livro, marca trechos, cria cards a partir da
seleção e estuda os decks no mesmo app, sincronizando com o seu servidor do Anki. Feito com Tauri 2 (Rust) + React, usando
o motor de PDF do [PdfCraft](https://github.com/storytold/pdfcraft) e o `rslib` do [Anki](https://github.com/ankitects/anki).

Plataformas por enquanto: **Linux** e **Windows** (desktop). A especificação completa está em
[docs/PROJETO.md](docs/PROJETO.md); decisões em [docs/decisoes.md](docs/decisoes.md); andamento em
[docs/progresso.md](docs/progresso.md).

## Ambiente de desenvolvimento

Tudo roda no devcontainer (`.devcontainer/`: Rust 1.97.1, protoc 31.1, Node 22 + pnpm, dependências do Tauri, g++/clang,
Xvfb).

- **VS Code:** "Dev Containers: Reopen in Container".
- **Sem VS Code:** `scripts/dev.sh <comando…>` roda o comando dentro da mesma imagem (constrói a imagem na primeira vez),
  a partir da raiz do repositório. Use `scripts/dev.sh --gui …` para abrir janelas no X do host.

Depois de clonar:

```sh
git submodule update --init --recursive   # PdfCraft em third_party/pdfcraft
scripts/dev.sh scripts/fetch-anki-web.sh  # páginas do Anki (aqt==26.9.3) → src-tauri/resources/anki-web/
scripts/dev.sh scripts/fetch-ocr-models.sh # modelos de OCR → src-tauri/resources/ocr-models/
scripts/dev.sh pnpm install
```

## Comandos

| O quê | Comando (dentro do container ou via `scripts/dev.sh`) |
|---|---|
| App em modo dev | `pnpm --dir web tauri dev` (com `scripts/dev.sh --gui`) |
| Testes Rust | `cd src-tauri && cargo test -j 8 --workspace` |
| Testes web | `pnpm --dir web test` · verificador: `pnpm --dir packages/checkers test` |
| E2E (núcleo simulado) | `pnpm --dir web e2e` |
| Lint | `cd src-tauri && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings` · `pnpm -r lint` |
| Pacotes | `pnpm --dir web tauri build` (AppImage/.deb no Linux; .msi no CI do Windows) |
| Release | criar a tag `v*` → `.github/workflows/release.yml` gera um rascunho de release com os pacotes |

O Tauri CLI roda a partir de `web/`; se ele não achar o app, exporte `TAURI_APP_PATH=../src-tauri/app` (o CI faz isso).

## Licença

Leitor de Estudos é software livre sob a **GNU AGPL, versão 3 ou posterior** (`AGPL-3.0-or-later`); o texto está em
[LICENSE](LICENSE).

Créditos de terceiros:

- **Anki** (núcleo `rslib` e páginas web do pacote `aqt`): © Ankitects Pty Ltd e colaboradores, AGPL-3.0-or-later.
  Inclui o MathJax (Apache-2.0).
- **PdfCraft** (motor de PDF, submódulo em `third_party/pdfcraft`): MIT OR Apache-2.0; as dependências que ele traz têm as
  licenças listadas no `ATTRIBUTION.toml` dele.
- **Modelos de OCR do ocrs** (Robert Knight): CC-BY-SA-4.0, sem modificações; a atribuição vai junto com os modelos
  (`ATTRIBUTION.txt`).
- **Open English WordNet** (a partir da Fase 6): CC-BY-4.0.
