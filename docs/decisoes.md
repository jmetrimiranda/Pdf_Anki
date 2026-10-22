# Decisões

Formato: data · decisão · motivo (uma linha cada). Ver docs/PROJETO.md seção 0, item 1.

- 2026-10-22 · Escopo de plataformas: só desktop por enquanto (Linux principal, Windows pelo GitHub Actions `windows-latest`; macOS opcional). iPad/iPhone adiados. · Decisão do usuário: não tem Mac e não precisa de iOS agora.
- 2026-10-22 · Critério da Fase 0 "compila para iOS" trocado por "compila e roda no Linux e no Windows"; todos os critérios de iOS/iPad marcados como ADIADOS em `docs/progresso.md`. · Decisão do usuário.
- 2026-10-22 · Porta do iOS continua aberta: nada de API só de desktop no núcleo Rust (código específico de desktop fica atrás de `cfg(desktop)` no crate `app`), interface responsiva. · Pedido do usuário.
- 2026-10-22 · Plano B do PdfCraft (seção 6.1) adiado para quando formos ao iPad; no desktop o `core-pdf` usa o `pdfcraft-engine`. · Pedido do usuário; o engine compila no desktop.
- 2026-10-22 · Adiados por depender do iPad: runner remoto de C++ para o iPad, pacotes de dados baixados no primeiro uso, Fase 10. No desktop, C++ usa o compilador local (`g++`). · Decisão do usuário.
- 2026-10-22 · PdfCraft fixado no commit `3e968c8aa24adfb729c6d45a3c98abf5fed07027` (main de 22/10/2026, "chore(a11y, fonts): satisfy clippy…"), como submódulo em `third_party/pdfcraft`. · Seção 3.2.
- 2026-10-22 · Anki fixado na tag `26.09.3` (commit `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba`); protoc 31.1. · Seção 3.2.
- 2026-10-22 · O repositório é `jmetrimiranda/Pdf_Anki` (público); a raiz do repositório é a raiz do projeto `leitor-estudos` da seção 3.1. · Repositório já criado pelo usuário.
- 2026-10-22 · Desenvolvimento num devcontainer (`.devcontainer/`, Debian bookworm + Rust 1.97.1 + protoc 31.1 + Node 22/pnpm + deps do Tauri + g++/clang + Xvfb). · Pedido do usuário; o mesmo ambiente serve ao CI Linux.
- 2026-10-22 · `[patch.crates-io]` copiado do PdfCraft sem `winit` e `egui-wgpu`. · Só servem à interface egui, que o app não usa.
