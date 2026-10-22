# Progresso

Legenda: ✅ feito · 🔶 parcial · ⬜ pendente · ⏸️ ADIADO (iOS/iPad, decisão de 22/10/2026 em `docs/decisoes.md`) · 🌐 [VPS] (depende dos serviços no VPS)

## Fase 0 — Fundação e prova de integração

- 🔶 O app compila e roda no Linux e no Windows com o `rslib` (com `rustls`) e o motor do PdfCraft linkados. *(substitui o critério de iOS)* — Linux ✅ (devcontainer: build, clippy, 53 testes Rust, app sob Xvfb); Windows: build no CI (`windows-latest`), aguardando o primeiro resultado.
- ⏸️ Compila para iOS (dispositivo e simulador).
- ⏸️ No simulador de iOS, o `rslib` faz login e sincroniza por HTTPS.
- ✅ Um comando de teste no app abre uma coleção, mostra a árvore de decks, abre um PDF e mostra a página 1. (`/dev/smoke` e `leitor-estudos --smoke`; captura em `docs/capturas/fase-0/dev-smoke.png`)
- 🔶 `/dev/ui` com todos os componentes nos temas claro e escuro — pronto (`docs/capturas/fase-0/dev-ui.png`); aguardando a aprovação visual do usuário.

## Fase 1 — Leitor de PDF

- ⬜ Abrir um PDF de 500 páginas em até 3 s; cada página visível em até 500 ms; memória estável após 200 páginas.
- ⬜ Seleção de texto, busca, sumário, miniaturas, zoom, temas de leitura e progresso salvo. (pinça no iPad ⏸️)
- ⬜ Trocar o renderizador para PDF.js e voltar.
- ⬜ PDF corrompido mostra erro e não derruba o app.

## Fase 2 — Anki local

- ⬜ Importar cópia da coleção real por `.colpkg` e ver os decks como na captura.
- ⬜ `docs/anki-handlers.md` com a decisão para cada handler especial.
- ⬜ Teste de isolamento: de dentro de um card, `invoke` e `POST /_anki/addNote` falham.
- ⬜ Estudar com áudio, imagens, cloze, MathJax e "digitar resposta"; intervalos iguais aos do Anki desktop.
- ⬜ Adicionar, editar, navegar, importar e exportar `.apkg`.
- ⬜ Opções do deck, estatísticas e informações do card pelas páginas do Anki.

## Fase 3 — Sincronização do Anki

- ⬜ Login e sync com o servidor local; primeira sync sempre baixa.
- 🌐 Sync com o servidor no VPS.
- 🌐 Revisar no app → aparece no AnkiMobile/desktop e vice-versa.
- ⬜ Sem rede revisa; ao voltar sincroniza sozinho.
- ⬜ Diálogo de sync completa com backup antes.

## Fase 4 — Anotações e Painel Anki do livro

- ⬜ Destaques, notas, marcadores; exportar PDF anotado e Markdown.
- ⬜ Card Básico e Cloze da seleção com `Ctrl+Shift+N` e `Fonte`.
- ⬜ "Abrir no livro" a partir da aba Anki. (link `leitor://` no AnkiMobile do iPad ⏸️)
- ⬜ Mini-revisão no painel lateral (regras da seção 10.1).

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
- ⬜ Realce, popover e "Adicionar ao deck do livro".

## Fase 7 — EPUB e OCR

- ⬜ EPUB: abrir, progresso, anotações, cards, escaneamento.
- ⬜ PDF escaneado em inglês via OCR; busca, seleção e escaneamento funcionam.

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
