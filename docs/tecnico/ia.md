# IA (Fase 8)

Como a IA do Leitor funciona por dentro. Plano e decisões: `docs/planos/fase-8.md`, `docs/decisoes.md`.

## Onde fica cada coisa

| Parte | Arquivo |
|---|---|
| Interface única de provedor | `src-tauri/crates/core-ai/src/provider.rs` |
| Adaptador do Claude | `core-ai/src/anthropic.rs` (`API_VERSION = "2026-10-21"`) |
| Preços | `core-ai/model-prices.toml` (embutido com `include_str!`; edições do usuário na configuração `ai_price_overrides`) |
| Tetos e reservas | `core-ai/src/limits.rs` (`Budget`: decisão e reserva sob um só lock) |
| Uma chamada de ponta a ponta | `core-ai/src/engine.rs` (`Engine::call`, `Engine::structured`) |
| Prompts (Apêndice C) | `core-ai/prompts/*.md` + `core-ai/src/prompts.rs` (validação e schemas) |
| Provedor simulado (testes) | `core-ai/src/simulated.rs` |
| Configurações, chaves, preços, gasto | `src-tauri/app/src/ai.rs` |
| Juiz, cards, definir, estimativa, job do deck | `src-tauri/app/src/ai_features.rs` |
| Fila de segundo plano | `src-tauri/app/src/ai_queue.rs` |
| Tabelas | `core-store` migração V5: colunas novas em `ai_usage`, tabela `ai_queue`; `vocab_enrichment_cache` |
| Interface | `web/src/features/settings/AiSettings.tsx`, `web/src/features/ai/`, `AiCardsDialog.tsx`, `AiJudge.tsx` |
| Mock | `web/src/lib/core/mock/ai.ts` (mesmas regras; lê o mesmo `model-prices.toml`) |

## Uma chamada

1. `AppState::ai_target(função)`: provedor ligado, adaptador existente, preço do modelo e chave no chaveiro. Falta
   qualquer um → erro (`ai_disabled`, `ai_provider_unavailable`, `ai_model_unpriced`, `ai_no_key`) **sem abrir
   conexão**.
2. `Engine::worst_case`: entrada estimada (caracteres ÷ 3) × preço de entrada + teto de saída × preço de saída (o
   dobro quando não se sabe se o raciocínio conta no teto), na faixa de preço mais cara possível.
3. `Budget::reserve`: gasto do dia/mês (`ai_usage`, calendário local) + reservas em andamento + pior caso contra os
   tetos → `ai_limit_reached`; acima de `ai_confirm_above_usd` → `ai_needs_confirmation` (primeiro plano sem
   confirmação, ou a fila de segundo plano, que então pausa e avisa).
4. Chamada; a resposta tem `usage` → custo real gravado em `ai_usage`; sem `usage` → grava o pior caso
   (`estimated = 1`). Erros de rede/autenticação não são cobrados.
5. `Engine::structured`: JSON validado (`prompts::validate_*`); inválido → uma nova tentativa com o erro; cortado
   no teto → uma nova tentativa no esforço mínimo; depois disso, `ai_invalid_output`/`ai_truncated`.

## Chaves

- Chaveiro do sistema, serviço `dev.jmetri.leitor-estudos`, conta `ai:<provedor>`. Nunca em SQLite, log ou
  resposta de comando: `ApiKey` mostra `***` em `Debug`/`Display`; a tela recebe só `keySuffix`.
- Erros do provedor viram códigos; o corpo da resposta nunca chega a uma mensagem.
- Testes usam chaves `test-key-…`; um teste procura padrões de chave real nos arquivos gravados e nos prompts.

## Cache e frases

- Chave do cache: lema + `context_hash(frase)` (inclui `PROMPT_VERSION`). A frase é normalizada (espaços) e cortada
  em 600 caracteres antes, nos três caminhos (deck, definir, fila), para que a mesma palavra na mesma frase sempre
  ache a mesma entrada.
- "Definir com IA" manda só a palavra e (livro, página); o núcleo pega a frase do exemplo daquela página na tabela
  de vocabulário (a mesma do "Adicionar ao deck do livro"). Livro não escaneado → vai sem frase.

## Fila de segundo plano

- Entra: "Adicionar ao deck do livro" (Rust) e card de Vocabulário criado pela seleção (a tela chama
  `ai_queue_add_note`), só com o interruptor ligado.
- `left_fields` guarda Definição e Tradução como o app escreveu; a resposta só substitui um campo que ainda tem esse
  valor (`core_anki::vocab::fill_fields_if_unchanged`).
- Um worker (thread `ai-queue`, iniciado no warm-up) processa um lote por vez; acorda com novos itens, retomada ou
  mudança de configuração; sem rede espera 60 s, teto atingido 15 min; respostas inválidas contam tentativa (3 →
  `failed`). Estado para a tela: `ai_queue_get` e o evento `ai://queue`.

## Testes

- `cargo test -p core-ai` (servidor axum local com respostas gravadas da Anthropic em `tests/recorded/anthropic/`).
- `cargo test -p leitor-estudos --test ai --test vocab --test contract` (provedor simulado e servidor local).
- Vitest `mock/ai.test.ts`, `AiSettings.test.tsx`, `CodePanel.test.tsx`, `BookPanel.test.tsx`,
  `VocabReportPage.test.tsx`; Playwright `e2e/ai.spec.ts`.
