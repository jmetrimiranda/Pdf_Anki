# Plano da Fase 8 — IA (revisão 2, com os ajustes do usuário)

Status: **revisão 2 para o usuário conferir antes de codar**. Nada de código, build ou dependência foi mexido.
A implementação começa só depois de: (1) CI verde do `f9215c0` e do `e57e3c4` (fecha a Fase 7); (2) o commit pequeno
do popover de vocabulário (Esc e botão ×); (3) o usuário ver o resumo desta revisão.

Fontes: `docs/PROJETO.md` §10.3, §11.6, §12.6, §12.7, §13, §14, §15, §18, §21 (Fase 8) e Apêndice C; `docs/decisoes.md`;
código atual (seção 6.1); **documentação oficial de cada provedor, lida em 24/10/2026** (links na seção 9). Nada
sobre provedores foi escrito de memória; o que a documentação não diz está marcado como **não verificado**.

---

## 0. Ajustes do usuário e conflitos

### 0.1 Ajustes incorporados (resumo)

| Ajuste | Onde está neste plano |
|---|---|
| 4 provedores: Claude (API própria), GPT, Gemini, DeepSeek; uma interface, um adaptador por provedor | 2.1–2.5 |
| Ordem: interface + Claude; depois GPT, Gemini, DeepSeek; um commit por provedor, cada um com testes | 6.5 |
| Provedor e modelo escolhidos por função (enriquecimento, juiz); um provedor ativo por função; sem troca automática | 2.6 |
| Modelos padrão: enriquecimento = o mais barato atual; juiz = intermediário; IDs conferidos; todos editáveis | 2.6 |
| Esforço do juiz baixo por padrão, configurável; equivalente mais barato onde não houver o parâmetro | 2.7 |
| Chamadas só pelo Rust; CSP sem mudança; chave no cofre; últimos 4 caracteres; "Testar chave" só no clique | 4, 6.2 |
| Nenhuma chamada sem chave; só o necessário sai; a tela diz o que é enviado | 4, 5 |
| Tetos US$ 5/mês e US$ 1/dia (somando provedores), aviso 80%, bloqueio total; saída por função (enriquecimento ≤ 4 000, juiz ≤ 2 000 tokens); confirmação acima de US$ 0,05 (no segundo plano: pausa a fila e avisa) | 3.6 |
| Custo = tokens devolvidos × tabela de preços no repositório (com data); estimativa antes de cada chamada | 3.2, 3.6 |
| Gasto do dia e do mês por provedor nas configurações | 3.6, 6.4 |
| Enriquecimento em segundo plano só de itens novos, fila visível, pausar, respeita os tetos | 5.3 |
| Testes e CI só com provedor simulado e respostas gravadas de cada API | 7.2 |
| 5º provedor: "Compatível com OpenAI (URL personalizada)" — Ollama/LM Studio locais, OpenRouter, Groq; feito **depois** dos 4 fixos | 0.3 |

### 0.2 Conflitos e mudanças (com o plano anterior e com a especificação)

Cada item diz o que muda e o que proponho. Os marcados **[decidir]** precisam da sua resposta (seção 8.2). As respostas
do usuário de 24/10/2026 estão na seção 0.3 e **valem acima** do texto destes itens.

1. **Lista de provedores (§13 da especificação e 2.3 do plano anterior).** A §13 previa "Anthropic ou compatível com
   OpenAI" com URL base livre (OpenAI, OpenRouter, Groq, DeepSeek, Ollama local, LM Studio, Gemini). Agora são
   **exatamente 4 provedores com URL fixa**. Saem: URL base livre, OpenRouter, Groq, **Ollama e LM Studio locais**
   (não haverá IA offline/local na v1), o conceito de "provedor local sem chave e sem custo" e o critério 8 do plano
   anterior. A chave `ai_base_url` deixa de existir.
2. **Gemini não usa o endpoint compatível com OpenAI.** Você permitiu usá-lo "se simplificar". Pela documentação de
   hoje ele **não serve**: (a) o Google diz que a compatibilidade "ainda está em beta"; (b) a página não documenta os
   campos de `usage` nem o formato `json_schema`; (c) ela diz que parâmetros não listados "serão ignorados em
   silêncio" — se `max_tokens` fosse ignorado, o teto de 1 000 tokens deixaria de valer sem erro; (d) a tabela de
   `reasoning_effort` não cobre os modelos atuais (3.5 Flash-Lite, 3.8 Flash). Proposta: **adaptador nativo** da
   Interactions API (GA, a recomendada pelo Google), que documenta `max_output_tokens` (inclui o pensamento),
   `thinking_level`, `response_format` com schema, `usage` com tokens de pensamento e `store=false`. **[decidir]**
3. **DeepSeek e GPT dividem um adaptador** (Chat Completions), com um "dialeto" por provedor: o DeepSeek não tem
   `json_schema` (só `json_object`), usa `thinking: {type}` e devolve cache acerto/erro em campos próprios. O
   commit do GPT cria o adaptador; o do DeepSeek acrescenta o dialeto e os testes dele.
4. **"Modelo rápido / modelo forte" (§13, §14, `settings.rs`, Apêndice C) viram "por função".** Saem `ai_provider`,
   `ai_model_fast`, `ai_model_strong`; entram provedor + modelo para **enriquecimento** e para **juiz** (seção 2.6).
   **Interpretação minha:** "Definir palavra" (C.3) e "Cards a partir de um trecho" (C.4) usam o provedor e o modelo
   do **enriquecimento**. **[decidir]**
5. **Lotes de 40 (§12.6, C.2) não cabem no teto de 1 000 tokens de saída.** Cada item custa ~50–60 tokens de JSON,
   então 40 itens pedem ~2 200–2 400 tokens. Lote máximo = `floor((teto − 100) / 60)` = **15 itens** com o teto
   padrão (100 tokens de folga para o envelope do JSON). Um deck de 300 palavras passa de 8 para 20 chamadas; o
   custo quase não muda (o prompt fixo de ~200 tokens se repete 12 vezes a mais, ≈ 2 400 tokens de entrada). Se você
   subir o teto, o lote cresce até 40. **[decidir]**
6. **O pensamento conta no teto de 1 000 tokens** em 3 dos 4 provedores, pela documentação: Anthropic ("thinking
   tokens count toward `max_tokens`"), OpenAI (`max_completion_tokens` inclui "reasoning tokens"), Gemini
   (`max_output_tokens` inclui "thought tokens"). **DeepSeek: não verificado** (a documentação não diz). Em todos, o
   pensamento é cobrado como saída. Consequências: (a) o juiz com esforço baixo pode bater no teto e devolver JSON
   cortado; (b) a regra antiga "nova tentativa com `max_tokens` maior" conflita com o teto. Proposta: corte por
   limite → **uma** nova tentativa com o pensamento no mínimo daquele modelo (se houver um mínimo mais baixo);
   senão, erro claro "A resposta passou do limite de tokens; aumente o limite ou baixe o esforço". Para o DeepSeek, a
   estimativa antes da chamada reserva o dobro do teto enquanto isso não for verificado.
7. **Consentimento por função no primeiro uso (5.2 do plano anterior) × seu desenho.** Você pediu que a tela de
   configurações diga o que é enviado e que só peça confirmação acima de US$ 0,05. Proposta: **um consentimento por
   provedor, ao ativá-lo nas configurações** (a tela lista o que cada função envia e para onde); sem diálogo por
   função; ligar o segundo plano é o consentimento dele. O diálogo de confirmação fica para chamadas acima de
   US$ 0,05. **[decidir]**
8. **Segundo plano:** o plano anterior o deixava desligado por padrão e "desligar esvazia a fila". Agora: **ligado
   quando houver provedor de enriquecimento configurado** (sua resposta foi "sim"), fila visível, botão **Pausar** (a
   fila fica guardada), nunca reprocessa a biblioteca. **[decidir: ligado por padrão ou um interruptor que você
   liga]**
9. **Limite (§13 "limite mensal estimado"; 3.4 do plano anterior):** o campo nascia vazio (= sem limite) e provedor
   local não contava. Agora: **dois tetos sempre ativos** (US$ 1/dia, US$ 5/mês, somando todos os provedores), aviso
   aos 80%, bloqueio total ao atingir, teto de tokens por chamada e confirmação acima de US$ 0,05.
10. **Tabela de preços:** o plano anterior tinha `prices.rs` só com Anthropic e preço digitado para os outros. Agora:
    arquivo `src-tauri/crates/core-ai/model-prices.toml` com os 4 provedores, data e fonte por modelo, editável
    (seção 3.2). Dois casos que uma tabela simples não cobre: **DeepSeek tem preço de pico e fora de pico** (metade)
    por horário UTC; **Gemini 3.8 Flash dobra de preço em 01/01/2027**. Proposta: a tabela aceita faixas de data e
    de horário; a estimativa usa o preço de pico (conservador) e o registro usa o preço do horário da resposta.
    **[decidir: ou sempre o de pico, mais simples]**
11. **Sem consulta automática de capacidades.** O plano anterior lia `GET /v1/models/{id}` da Anthropic para montar
    o pedido. Como nenhuma chamada sai sem clique, as capacidades (níveis de esforço, como desligar o pensamento)
    ficam **na mesma tabela do repositório**; o "Testar chave" confere se batem.
12. **Últimos 4 caracteres da chave na tela.** O plano anterior não devolvia nada da chave ao JavaScript (só
    `hasKey`). Agora `ai_settings_get` devolve `keySuffix` (4 caracteres), lido do cofre na hora; nunca gravado no
    SQLite. É uma exposição mínima pedida por você.
13. **C.4 (cards de um trecho) manda o título do livro e a página.** "Só o necessário" → proposta: **não enviar
    título nem página**; o campo Fonte é preenchido localmente. Muda o texto do prompt C.4. E o trecho fica limitado
    a **1 000 palavras** ("trecho curto"; o plano anterior aceitava ~1 500). **[decidir o limite]**
14. **Versão da API da Anthropic:** o plano anterior usava `anthropic-version: 2023-06-01`. A versão atual é
    `2026-10-21` (rejeita `temperature`/`top_p`/`top_k` em qualquer valor; nós não os mandamos). Proposta: usar
    `2026-10-21`.
15. **OpenAI: Chat Completions, não Responses.** A OpenAI recomenda a Responses API para modelos com raciocínio, mas
    diz que Chat Completions continua suportado, e os dois modelos padrão o aceitam (sem ferramentas, que não usamos).
    Chat Completions deixa o DeepSeek reaproveitar o adaptador. **[decidir]**
16. **Esforço do enriquecimento:** você definiu só o do juiz. Interpretação: enriquecimento, definir palavra e cards
    usam o **pensamento no mínimo** de cada modelo (desligado onde der). Configurável como o do juiz.
17. **"Gerar deck com IA"** (§12.6) é uma ação sua, em primeiro plano, não segundo plano. Continua existindo, com o
    custo estimado na tela e os tetos valendo; nunca roda sozinho.
18. **§18 da especificação** ("nada vai para terceiros, exceto o texto enviado ao provedor de IA…") passa a listar
    os 4 provedores e a tabela 5.1. Acrescenta dois avisos tirados da documentação: chave do **nível gratuito do
    Gemini** permite ao Google usar o conteúdo para melhorar produtos; a Interactions API **guarda as interações por
    padrão** (mandamos `store=false`).
19. **§21 Fase 8 (aceite):** "Funciona com a Anthropic e com uma URL compatível com OpenAI" → "com Claude, GPT,
    Gemini e DeepSeek"; "Limite mensal respeitado" → "tetos diário e mensal somados, aviso, bloqueio, teto por
    chamada"; acrescentar "CSP sem domínio de IA" e "testes só com provedor simulado e respostas gravadas".
20. **§14 da especificação:** a lista de chaves de `settings` muda (seção 6.1) e `ai_usage` ganha colunas
    (pensamento, cache, "estimado", data da tabela de preços) — uma migração do banco.

### 0.3 Respostas do usuário (24/10/2026) — valem acima da seção 0.2

1. **Provedores (item 1):** mantém-se, **além dos 4 fixos**, a opção **"Compatível com OpenAI (URL personalizada)"**
   (Ollama/LM Studio locais, OpenRouter, Groq), implementada **depois** dos 4 fixos, num commit próprio, reaproveitando
   o adaptador Chat Completions.
   - **URL local** (`localhost`, `127.0.0.1`, `::1`): custo zero, **fora dos tetos** de gasto, sem chave obrigatória.
   - **URL remota:** só funciona depois que o usuário preencher o **preço por milhão de tokens de entrada e de saída**;
     sem preço, a opção fica **desativada** (não fura o teto). Chave no cofre como as outras.
   - A chave de configuração `ai_base_url` volta a existir só para essa opção.
2. **Limite de saída por função (itens 5 e 6):**
   - **Enriquecimento** (e "Definir palavra" e "Cards a partir de um trecho"): até **4 000** tokens de saída por
     chamada. Com ~60 tokens por item, **o lote de 40 cabe** (~2 400 + envelope); usa-se 40 e, se um modelo/dialeto
     pedir mais por item, o maior lote que caiba: `floor((teto − 100) / tokens_por_item)`.
   - **Juiz:** até **2 000** tokens de saída, para comportar o raciocínio baixo.
   - A proteção de custo continua nos tetos de US$ 1/dia e US$ 5/mês e na estimativa antes de cada chamada.
3. **Segundo plano (itens 7 e 8):** ligado (resposta "sim"), só para itens novos, fila visível, botão Pausar. **No
   segundo plano não há diálogo de confirmação:** se a estimativa de uma chamada passar de US$ 0,05, a fila **pausa** e o
   app **avisa**; o usuário decide ao retomar. Em primeiro plano, o diálogo acima de US$ 0,05 continua.
4. **Raciocínio (itens 6 e 16):** de acordo — desligado ou no mínimo no enriquecimento, baixo no juiz, conforme a
   documentação de cada provedor (seção 2.7).
5. **"Definir palavra" e "Cards a partir de um trecho" (item 4):** usam a configuração do enriquecimento — de acordo.

Continuam abertos (seção 8.2): Gemini pela API nativa (item 2), consentimento por provedor (item 7), preço de
pico × faixa de horário do DeepSeek (item 10), limite do trecho e não enviar título/página (item 13), Chat
Completions × Responses na OpenAI (item 15).

---

## 1. Escopo e o que fica de fora

### 1.1 Entra na v1 (Fase 8)

| Função | Onde aparece hoje | O que a Fase 8 faz |
|---|---|---|
| **Configurações → IA** | `web/src/features/settings/AiSettings.tsx` (placeholder) | Chave por provedor (últimos 4 caracteres, "Testar chave", "Remover chave"), provedor + modelo + esforço por função, tetos, teto de tokens, preços (com data), gasto do dia e do mês por provedor, fila do segundo plano, o que é enviado. |
| **Enriquecer vocabulário** (§12.6) | `GenerateDeckDialog.tsx` (opção IA desabilitada), `EnrichMode::Ai` → `ai_unavailable` em `app/src/vocab/deck.rs` | Lotes de até 15 (seção 0.2, item 5), Definição (inglês B1), Tradução (pt-BR no sentido da frase) e Classe; custo estimado na tela; cache por (lema, hash do exemplo). |
| **Definir palavra no leitor** (§12.7, C.3) | `PanelDialogs.tsx`, popover das marcas; `vocab_define` | "Definir com IA" sob demanda. Um item, mesmo schema do C.2, mesmo cache. |
| **Enriquecimento em segundo plano** (§12.7) | `vocab_add_word` | Palavras novas adicionadas entram numa fila visível; a IA preenche Tradução/Definição depois (seção 5.3). |
| **Juiz de código** (§11.6, C.1) | `CodePanel.tsx` ("Pedir avaliação da IA") | Só com veredito Errado ou Não verificável, só por clique. Mostra veredito, explicação e nota sugerida; **nunca responde o card**. |
| **Cards a partir de um trecho** (§10.3, C.4) | `AiDialog` em `PanelDialogs.tsx`, menu do PdfCraft, `SelectionToolbar.tsx` do EPUB | Até 1 000 palavras; lista de cards com checkboxes; nada entra na coleção sem confirmação. |
| **Uso e tetos** | tabela `ai_usage` (já existe) | Registro de cada chamada, gasto do dia e do mês por provedor, aviso, bloqueio. |

### 1.2 Fica de fora da v1 (com o motivo)

- **Provedores além dos 4**, URL base livre, OpenRouter, Groq, **Ollama/LM Studio locais** (seção 0.2, item 1).
- **Troca automática de provedor** quando um falha (custo previsível).
- **Streaming:** respostas JSON curtas (≤ 4 000 tokens no enriquecimento, ≤ 2 000 no juiz). Tempo limite de 60 s (§13).
- **Batch APIs** (Anthropic e OpenAI dão 50%): assíncronas; o custo de um deck já é de centavos (seção 3.5).
- **Prompt caching explícito:** os prefixos fixos (~150–400 tokens) são pequenos; o cache que importa é o nosso
  (`vocab_enrichment_cache`). O cache automático dos provedores, quando houver, aparece no `usage` e é cobrado pela
  tabela (seção 3.2).
- **Imagens/PDF como entrada, chat livre, resumo, "pergunte ao livro", ferramentas, busca na web:** fora.
- **Reprocessar a biblioteca** ou decks antigos com IA por conta própria: nunca.
- **Português como idioma do livro** (§12.8) e **iPad/iPhone** (Fase 10; `core-ai` fica sem APIs de desktop).

---

## 2. Provedores, modelos e onde roda

### 2.1 Interface única e adaptadores

- **Padrão: IA desligada.** Sem provedor configurado para uma função, os botões dela mostram "IA desligada — ative
  em Configurações → IA" e **nenhuma conexão é aberta**. O app inteiro funciona sem IA (WordNet, verificador,
  criação manual).
- `trait Provider` em `core-ai`: `complete_json(req) -> Result<Completion>`, com `model`, `system`, `user`,
  `schema`, `max_output_tokens`, `effort: Effort` (`Minimum | Low | Medium | High`); a resposta traz o texto JSON,
  `Usage { input, cached_input, cache_write, output, thinking }`, `stop: Stop` (`Done | Length | Refused | Other`).
- Três implementações: `AnthropicProvider` (Messages API), `OpenAiChatProvider` com dialetos `OpenAi` e `DeepSeek`
  (Chat Completions), `GeminiProvider` (Interactions API). Um `SimulatedProvider` para testes.
- Quem chama a rede é **sempre o Rust** (`reqwest`, `rustls`). A CSP (`connect-src` em `tauri.conf.json`) **não
  muda**: nenhum domínio de IA; um teste garante isso.
- Em todos: tempo limite de 60 s, sem novas tentativas automáticas de HTTP; `service_tier` fixado no padrão quando o
  provedor tem esse parâmetro (Anthropic `standard_only`, OpenAI `default`), para nenhuma configuração do projeto
  mandar o pedido para uma faixa mais cara.

### 2.2 Claude (Anthropic) — API própria

- `POST https://api.anthropic.com/v1/messages`, cabeçalhos `x-api-key` (a API aceita também
  `Authorization: Bearer`), `anthropic-version: 2026-10-21`.
- **Modelos padrão** (página de modelos): enriquecimento **Claude Haiku 5.5 — `claude-haiku-5-5`** ("para tarefas
  de alto volume… classificação, extração"; aposentadoria não antes de 07/10/2027); juiz **Claude Sonnet 5.5 —
  `claude-sonnet-5-5`** ("a melhor combinação de velocidade e inteligência"; não antes de 28/09/2027). Os IDs sem
  data são snapshots fixos.
- **Esforço:** `output_config.effort` = `low | medium | high | xhigh | max`. Padrão da API: `medium` no Haiku 5.5,
  `high` no Sonnet 5.5 — por isso **sempre mandamos o esforço explícito**.
- **Pensamento** (ligado por padrão nos dois; tokens cobrados como saída e contados em `max_tokens`):
  - Haiku 5.5: `thinking: {type: "disabled"}` aceito com esforço `high` ou menor (400 em `xhigh`/`max`).
  - Sonnet 5.5: `{type: "disabled"}` → **400**; o mínimo é `{type: "between_tools"}` (desliga o pensamento antes
    da resposta), aceito em `low`, `medium` e `high`.
- **JSON:** `output_config.format = {type: "json_schema", schema}`, GA, sem cabeçalho beta, nos dois modelos. O
  schema não aceita `minimum/maximum`, `minLength/maxLength` e exige `additionalProperties: false`; esses limites
  ficam na validação em Rust. `stop_reason: "refusal"` (cobrado) e `"max_tokens"` podem devolver JSON fora do
  schema — sempre validamos com `serde`.
- **Sem** `temperature`, `top_p`, `top_k` (400 em qualquer valor na versão `2026-10-21`).
- **Uso:** `usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` (total
  cobrado, inclui pensamento) e `output_tokens_details.thinking_tokens`.
- **Testar chave:** `GET /v1/models/{modelo}` para cada modelo Claude configurado (não gera tokens).

### 2.3 GPT (OpenAI) — Chat Completions

- `POST https://api.openai.com/v1/chat/completions`, `Authorization: Bearer`.
- **Modelos padrão** (página de modelos): enriquecimento **GPT-6 Luna — `gpt-6-luna`** ("o mais eficiente, para
  tarefas focadas de alto volume"); juiz **GPT-6.1 Sol — `gpt-6.1-sol`** ("para equilibrar inteligência e custo").
  Os dois aceitam Chat Completions e saída estruturada. Observação: a página de preços ainda lista modelos de
  gerações anteriores mais baratos (ex.: `gpt-5-nano`, US$ 0,05/0,40), que não aparecem entre os modelos atuais; se
  você preferir o mais barato a qualquer custo de geração, troque no campo (é editável).
- **Esforço:** `reasoning_effort` = `none | minimal | low | medium | high | xhigh | max` (depende do modelo).
  Luna: `none, low, medium (padrão), high, xhigh, max`. Sol: `low, medium (padrão), high, xhigh, max` — **sem
  `none` nem `minimal`**.
- **Teto:** `max_completion_tokens` ("inclui tokens visíveis e de raciocínio"; `max_tokens` está obsoleto).
- **JSON:** `response_format: {type: "json_schema", json_schema: {name, schema, strict: true}}`. Regras do modo
  estrito: `additionalProperties: false` em todo objeto e todos os campos em `required`; `minimum/maximum`,
  `minItems/maxItems` aceitos; `minLength/maxLength` não constam. Recusa vem em `message.refusal`.
- **Sem** `temperature`, `top_p`, `logprobs` quando o esforço não é `none` (a documentação manda removê-los).
- **Uso:** `usage.prompt_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens` e
  `completion_tokens_details.reasoning_tokens` (o raciocínio está dentro de `completion_tokens`, cobrado como
  saída). `finish_reason: "length"` = cortado pelo teto.
- **Testar chave:** `GET https://api.openai.com/v1/models/{modelo}` (não gera tokens).
- Mandamos `store: false` explícito (o parâmetro guarda a saída para "destilação ou avaliações").

### 2.4 Gemini (Google) — Interactions API nativa

- `POST https://generativelanguage.googleapis.com/v1beta/interactions`, cabeçalho `x-goog-api-key` (**nunca** a
  chave na URL `?key=`, como nos exemplos de REST, para ela não aparecer em logs de URL).
- Por que nativo e não o compatível com OpenAI: seção 0.2, item 2. (A Interactions API é GA desde junho de 2026 e a
  recomendada; `generateContent` é "legado", ainda suportado.)
- **Modelos padrão** (página de modelos, atualizada em 22/10/2026): enriquecimento **Gemini 3.5 Flash-Lite —
  `gemini-3.5-flash-lite`** ("o modelo 3.5 mais rápido e econômico"; a página recomenda 3.5 Flash-Lite ou 3.8 Flash
  para projetos novos); juiz **Gemini 3.8 Flash — `gemini-3.8-flash`**. Observação: o `gemini-3.1-flash-lite`
  (estável, geração anterior) é mais barato (US$ 0,25/1,50 contra 0,30/2,50); editável se você preferir.
- **Pensamento:** `generation_config.thinking_level` = `minimal | low | medium | high`. 3.5 Flash-Lite: padrão
  `minimal`, níveis `minimal, low, medium, high`. 3.8 Flash: padrão `medium`, níveis `low, medium, high` (sem
  `minimal`). **Não dá para desligar** o pensamento nos modelos 3.x (a página não oferece "off" para eles).
- **Teto:** `generation_config.max_output_tokens`, que **inclui os tokens de pensamento** e é um corte rígido;
  cortado → `status: "incomplete"`, cobrando o pensamento gerado.
- **JSON:** `response_format` com `mime_type: "application/json"` e `schema`. `minLength/maxLength` são ignorados
  em silêncio; `minimum/maximum`, `minItems/maxItems`, `enum`, `additionalProperties` aceitos. Os subcampos exatos do
  objeto `ResponseFormat` não apareceram na página de referência lida: **conferir no exemplo da documentação ao
  gravar as respostas** (seção 7.2).
- **Uso:** `usage.total_input_tokens`, `total_cached_tokens`, `total_output_tokens`, `total_thought_tokens`. A página
  de pensamento diz que o preço da resposta é a **soma** de saída + pensamento; **não verificado** se
  `total_output_tokens` já inclui o pensamento — somamos os dois (se houver dupla contagem, ela superestima, o que
  é seguro para os tetos) e corrigimos ao gravar as respostas de exemplo.
- **`store: false`** em todo pedido (por padrão a API guarda as interações por 55 dias no nível pago).
- **Testar chave:** `GET https://generativelanguage.googleapis.com/v1beta/models/{modelo}` (não gera tokens).
- **Aviso na tela:** no nível gratuito o Google usa o conteúdo para melhorar produtos; no pago, não.

### 2.5 DeepSeek — compatível com OpenAI

- `POST https://api.deepseek.com/chat/completions`, `Authorization: Bearer`. Mesmo adaptador do GPT, dialeto
  `DeepSeek`.
- **Modelos** (página de modelos e preços): só dois. Enriquecimento **`deepseek-flash`** (hoje servido pelo
  DeepSeek-V4.1-Flash-1017); juiz **`deepseek-v4-pro`** (DeepSeek-V4-Pro-0813). Não há um "intermediário": o Pro é o
  maior, mas o preço dele é de faixa intermediária. Os nomes antigos `deepseek-v4-flash` ainda são aceitos e
  redirecionados.
- **Pensamento:** ligado por padrão (esforço `high`). Desligar: `thinking: {type: "disabled"}` ou
  `reasoning_effort: "none"`. Esforço: `none, low, high, max` (`minimal` → `low`; `medium`/`xhigh` → `high`).
- **Teto:** `max_tokens` (1 a 393 216; padrão 8K sem pensamento, 64K com). **Não verificado** se inclui o
  raciocínio (seção 0.2, item 6).
- **JSON:** só `response_format: {type: "json_object"}` (sem `json_schema`); o prompt precisa conter a palavra
  "json" e um exemplo; a documentação avisa que às vezes vem **conteúdo vazio** (tratado como saída inválida →
  uma nova tentativa). **Não verificado** se o modo JSON funciona com o pensamento ligado.
- `temperature` não tem efeito no modo com pensamento (não mandamos).
- **Uso:** `prompt_tokens` = `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`, `completion_tokens`,
  `completion_tokens_details.reasoning_tokens` (opcional). A posição dos dois campos de cache diverge entre o
  schema e os exemplos da própria documentação: o parser aceita os dois lugares.
- `finish_reason`: `stop`, `length`, `content_filter`, `tool_calls`, `insufficient_system_resource`, `aborted`.
- **Testar chave:** `GET https://api.deepseek.com/models` (lista; não gera tokens).
- **Aviso na tela:** servidores na China; preço muda com o horário (seção 3.1).

### 2.6 Configuração por função

| Função | Provedor e modelo | Esforço padrão |
|---|---|---|
| **Enriquecimento** (deck, segundo plano) | escolhidos por você | mínimo |
| **Juiz de código** | escolhidos por você | **baixo** |
| Definir palavra (C.3) | os do enriquecimento (interpretação, seção 0.2 item 4) | mínimo |
| Cards de um trecho (C.4) | os do enriquecimento (interpretação) | mínimo |

- **Um provedor ativo por função**; se ele falhar (sem rede, 429, 5xx), a função falha com a mensagem; **nunca**
  troca de provedor sozinha.
- Ao escolher um provedor, o modelo é preenchido com o padrão dele (tabela abaixo); o campo é texto livre com
  sugestões vindas da tabela de preços. Modelo fora da tabela → bloqueado até você informar o preço (seção 3.2).

| Provedor | Enriquecimento (mais barato atual) | Juiz (intermediário) |
|---|---|---|
| Claude | `claude-haiku-5-5` | `claude-sonnet-5-5` |
| GPT | `gpt-6-luna` | `gpt-6.1-sol` |
| Gemini | `gemini-3.5-flash-lite` | `gemini-3.8-flash` |
| DeepSeek | `deepseek-flash` | `deepseek-v4-pro` |

### 2.7 Esforço: o que cada nível manda

Níveis do app: **mínimo**, **baixo** (padrão do juiz), **médio**, **alto**. A tabela de preços guarda, por modelo, os
níveis aceitos e o parâmetro (seção 3.2); "o equivalente mais barato" vem dali.

| Modelo | Mínimo | Baixo |
|---|---|---|
| `claude-haiku-5-5` | `thinking: disabled` + `effort: low` | `effort: low` (pensamento adaptativo) |
| `claude-sonnet-5-5` | `thinking: between_tools` + `effort: low` | `effort: low` (pensamento adaptativo) |
| `gpt-6-luna` | `reasoning_effort: none` | `low` |
| `gpt-6.1-sol` | `low` (não há `none`/`minimal`) | `low` |
| `gemini-3.5-flash-lite` | `thinking_level: minimal` | `low` |
| `gemini-3.8-flash` | `low` (não há `minimal`) | `low` |
| `deepseek-flash` / `deepseek-v4-pro` | `thinking: disabled` | `reasoning_effort: low` |

Modelo editado que não tem parâmetro de esforço (marcado na tabela): "baixo" e "mínimo" mandam o pensamento
desligado, se houver como, e um teto de saída menor (metade do teto configurado). Médio/alto mapeiam para os nomes
iguais (Gemini 3.8 e DeepSeek: `high` para "alto").

---

## 3. Custo

### 3.1 Preços oficiais (US$ por milhão de tokens, lidos em 24/10/2026)

| Modelo | Entrada | Entrada em cache | Saída (inclui pensamento) | Observação | Fonte |
|---|---|---|---|---|---|
| `claude-haiku-5-5` | 0,10 | 0,01 (leitura) | 0,50 | prompt ≤ 100 mil tokens; acima: 0,50 / 2,50 | Anthropic, Pricing |
| `claude-sonnet-5-5` | 2,00 | 0,10 (leitura) | 10,00 | contexto todo no mesmo preço | Anthropic, Pricing |
| `gpt-6-luna` | 0,10 | 0,01 | 0,50 | ≤ 272 mil tokens de entrada; acima: entrada ×2, saída ×1,5 | OpenAI, Pricing e página do modelo |
| `gpt-6.1-sol` | 2,00 | 0,10 | 10,00 | idem | OpenAI, Pricing e página do modelo |
| `gemini-3.5-flash-lite` | 0,30 | 0,03 | 2,50 | nível pago | Google, Pricing |
| `gemini-3.8-flash` | 0,75 | 0,075 | 3,75 | **até 31/12/2026; a partir de 01/01/2027: 1,50 / 0,15 / 7,50** | Google, Pricing |
| `deepseek-flash` | 0,30 pico / 0,15 fora | 0,006 / 0,003 | 1,20 / 0,60 | pico: 01–04 h e 06–10 h UTC, seg–sex | DeepSeek, Models & Pricing |
| `deepseek-v4-pro` | 1,32 pico / 0,66 fora | 0,044 / 0,022 | 3,96 / 1,98 | idem | DeepSeek, Models & Pricing |

Multiplicadores que **não usamos** e que o app evita: Anthropic `inference_geo: "us"` (×1,1); OpenAI residência de
dados (+10%); faixas prioritárias/rápidas. Nenhum pedido nosso chega perto de 100 mil tokens.

### 3.2 Tabela de preços no repositório

- Arquivo **`src-tauri/crates/core-ai/model-prices.toml`**, embutido no binário (`include_str!`), revisado por PR.
  Uma linha por modelo:

  ```toml
  schema = 1

  [[model]]
  provider = "anthropic"            # anthropic | openai | gemini | deepseek
  id = "claude-haiku-5-5"
  role_default = "enrich"           # enrich | judge | (vazio)
  checked_at = "2026-10-24"
  source = "https://platform.claude.com/docs/en/about-claude/pricing"
  input = 0.10                      # US$ por milhão de tokens
  cached_input = 0.01
  cache_write = 0.125
  output = 0.50                     # inclui pensamento
  max_prompt_tokens = 100000        # acima disso vale a próxima faixa
  effort_param = "anthropic"        # anthropic | openai | gemini | deepseek | none
  effort_levels = ["low", "medium", "high", "xhigh", "max"]
  thinking_off = "disabled"         # disabled | between_tools | none | (vazio = não desliga)
  max_tokens_includes_thinking = "yes"   # yes | no | unverified

  [[model.tier]]                    # faixas extras: por tamanho do prompt, por data ou por horário UTC
  min_prompt_tokens = 100001
  input = 0.50
  cached_input = 0.05
  output = 2.50
  ```

  Faixas por data (`valid_from = "2027-01-01"`, Gemini 3.8 Flash) e por horário (`utc_windows = ["01:00-04:00",
  "06:00-10:00"]`, `weekdays = "mon-fri"`, DeepSeek) usam o mesmo `[[model.tier]]`.
- **Editável no app:** a tela mostra a tabela com "conferido em DD/MM/AAAA" e a fonte; você pode sobrescrever o
  preço de um modelo ou acrescentar um modelo novo (guardado em `settings.ai_price_overrides`, JSON, com a data em
  que você editou). Linha com mais de 90 dias mostra "conferir preço".
- Teste de unidade: o arquivo é lido sem erro, todo modelo padrão da tabela 2.6 tem preço, fonte e data.

### 3.3 Tokens por chamada (estimados a partir dos prompts do Apêndice C)

Premissas: frase de exemplo ≈ 25 palavras ≈ 35–45 tokens; item do C.2 ≈ 50–60 tokens de JSON; tokenizadores
diferentes entre provedores (margem para cima).

| Função | Entrada | Saída |
|---|---|---|
| Enriquecer 1 lote de 40 (C.2, pensamento no mínimo) | ~2 600 | ~2 300 |
| Deck de 300 palavras = 8 lotes | ~21 000 | ~18 000 |
| Definir palavra (C.3) | ~300 | ~70 |
| Juiz de código (C.1, esforço baixo) | ~1 200 | ~150 de JSON + 0–1 850 de pensamento (teto 2 000) |
| Cards de um trecho (C.4, ≤ 1 000 palavras, n = 5) | ~1 800 | ~500 |

### 3.4 Custo por chamada com os modelos padrão (US$)

| Função | Claude | GPT | Gemini | DeepSeek (pico) |
|---|---|---|---|---|
| Lote de 15 | 0,0005 | 0,0005 | 0,0025 | 0,0014 |
| Deck de 300 palavras | **0,011** | **0,011** | **0,049** | **0,027** (fora de pico 0,014) |
| Definir palavra | 0,00007 | 0,00007 | 0,0003 | 0,0002 |
| Juiz (150–2 000 de saída) | 0,004–0,012 | 0,004–0,012 | 0,0015–0,005 (2027: 0,003–0,009) | 0,002–0,006 |
| Cards de um trecho | 0,0004 | 0,0004 | 0,0018 | 0,0011 |
| **Pior caso de uma chamada** (entrada + teto de saída da função; os valores abaixo são do teto antigo de 1 000 e dobram no juiz com o teto de 2 000) | juiz: 0,012 | juiz: 0,012 | juiz: 0,005 | juiz: 0,006 (×2 enquanto o item 6 não for verificado: 0,010) |

Com os tetos por função (4 000 no enriquecimento, 2 000 no juiz), o pior caso do juiz com os modelos padrão fica em
~US$ 0,02–0,025 (Claude/GPT) e o de um lote de 40 no enriquecimento em ~US$ 0,002–0,011: **nenhuma chamada com os
modelos padrão passa de US$ 0,05**. A confirmação (ou, no segundo plano, a pausa da fila) só aparece com um modelo caro
ou com os tetos aumentados.

### 3.5 Cenários mensais

- **Leve:** 1 deck de 300 palavras, 100 definições, 30 avaliações de código, 20 gerações de cards.
- **Pesado:** 4 decks (1 200 palavras), 1 000 definições, 300 avaliações, 200 gerações de cards.

| Cenário | Claude | GPT | Gemini | DeepSeek (pico) |
|---|---|---|---|---|
| Leve | US$ 0,14–0,40 | US$ 0,14–0,40 | US$ 0,16–0,25 | US$ 0,13–0,23 |
| Pesado | US$ 1,36–3,91 | US$ 1,36–3,91 | US$ 1,26–2,21 (2027: até 3,61) | US$ 1,16–2,17 |

O juiz domina o custo. Todos cabem no teto de US$ 5/mês; o dia pesado (ex.: 100 avaliações num dia, ≤ US$ 1,24 no
pior caso do Claude/GPT) pode bater no teto de US$ 1/dia — é para isso que ele existe. Novas tentativas por JSON
inválido custam outra chamada (contam no gasto). A estimativa será **recalibrada** com as respostas gravadas e, depois,
com 2–3 chamadas manuais suas (seção 7.3).

### 3.6 Tetos, estimativa e registro

- **Configurações** (novas chaves, seção 6.1): `ai_limit_day_usd` = **1**, `ai_limit_month_usd` = **5**,
  `ai_max_output_tokens_enrich` = **4 000**, `ai_max_output_tokens_judge` = **2 000**, `ai_confirm_above_usd` = **0,05**. Aviso fixo aos **80%**. "Dia" e "mês" =
  calendário no fuso local. Os tetos somam **todos** os provedores.
- **Antes de cada chamada** (no Rust, dentro de um `Mutex` que serializa a decisão):
  `pior_caso = tokens_de_entrada_estimados × preço_entrada + teto_de_saída × preço_saída` (entrada estimada de forma
  conservadora: caracteres ÷ 3 do prompt montado; preço de pico/da faixa mais cara que possa valer; DeepSeek com teto
  ×2 enquanto não verificado). Se `gasto + reservado + pior_caso` passar do teto do dia **ou** do mês → **bloqueia sem
  chamar**. Se não, reserva o `pior_caso` até a resposta voltar (chamadas paralelas não estouram).
- **Confirmação:** se o `pior_caso` de uma única chamada passar de US$ 0,05, o app pergunta ("Esta chamada pode custar
  até US$ X. Enviar?"). Na fila do segundo plano, um item assim **pausa a fila** e espera você; nunca é confirmado
  sozinho.
- **Depois da chamada:** grava em `ai_usage` com o `usage` real devolvido pela API × a tabela (entrada sem cache,
  entrada em cache, escrita de cache, saída incluindo pensamento) e a data da tabela usada. Recusa e JSON inválido
  também são cobrados e gravados. Sem `usage` na resposta → grava o `pior_caso`, marcado "estimado".
- **Aviso aos 80%** (dia ou mês): faixa amarela nas telas de IA e na fila, uma vez por período.
- **Ao atingir um teto:** **todas** as chamadas de IA param (todas as funções, todos os provedores), com a mensagem
  "Limite de IA atingido: US$ X de US$ Y hoje (ou neste mês). As funções de IA voltam amanhã (ou no dia 1º), ou
  aumente o limite em Configurações → IA. O resto do app continua funcionando." O enriquecimento em andamento para
  entre lotes; o que já voltou fica no cache; as palavras restantes usam o WordNet, com aviso.
- **Tela:** gasto do dia e do mês **por provedor** (e por função), barras dos dois tetos, data da tabela de preços.
- **Recomendação na tela:** definir também um limite de gasto no painel de cada provedor (a Anthropic, por exemplo,
  permite); os nossos tetos são estimativas locais.

---

## 4. Onde ficam as chaves

- **Uma chave por provedor, só no cofre do sistema**, pelo mecanismo da chave de sync do Anki (`app/src/secrets.rs`,
  `keyring` 3.6 → Secret Service no Linux). Serviço `dev.jmetri.leitor-estudos`, contas `ai:anthropic`, `ai:openai`,
  `ai:gemini`, `ai:deepseek`. Sem cofre disponível, a chave não é guardada e o app avisa (sem alternativa em arquivo).
  `LEITOR_SECRET_STORE=memory` continua só em builds de debug.
- **Nenhuma chamada sem chave:** o adaptador recebe a chave do cofre no momento do pedido; sem chave → `ai_no_key`,
  sem abrir conexão (teste com o servidor simulado contando zero pedidos).
- **Nunca no repositório:** testes usam chaves falsas (`test-key-…`); o CI não tem chave nenhuma; nada de `.env`.
  Um teste procura padrões de chave (`sk-`, `sk-ant-`, `AIza`) nos arquivos versionados e nas respostas gravadas.
- **Nunca no SQLite:** `settings` guarda provedores, modelos, esforço, tetos, preços editados e o estado da fila.
- **Nunca no log:** newtype `ApiKey` com `Debug`/`Display` = `***`; nenhum `tracing` de cabeçalhos ou corpos;
  `reqwest=warn,hyper=warn`; corpos de erro do provedor viram códigos (`ai_auth`, `ai_rate_limited`…) e passam por
  uma função que apaga a chave e padrões de chave antes de qualquer registro. Teste: todas as funções contra o
  servidor simulado com uma chave marcada; falha se a chave ou o trecho final aparecer no log ou no JSON de algum
  comando além do `keySuffix`.
- **Nunca em captura:** as capturas da fase usam chaves falsas cujo final é `TEST`; a tela só mostra
  "•••• TEST".
- **Na interface:** a chave é digitada num campo de senha e atravessa **uma vez** o IPC (`ai_key_set`); o campo é
  limpo. `ai_settings_get` devolve só `hasKey` e `keySuffix` (últimos 4 caracteres, lidos do cofre na hora).
- **"Testar chave"** (só no clique, nunca automático): o Rust lê a chave do cofre e faz a chamada **sem tokens** da
  seção 2 (Anthropic/OpenAI/Gemini: obter o modelo configurado; DeepSeek: listar modelos). Custo: nenhum token
  consumido; as páginas de preço só cobram tokens e ferramentas, mas **nenhuma delas diz explicitamente** que essas
  rotas são gratuitas. Resposta à interface: "ok", "chave inválida", "modelo não encontrado", "sem rede" ou
  "servidor fora do ar".
- **"Remover chave"** apaga do cofre; a função que usava o provedor volta a "IA desligada".

---

## 5. O que sai do computador e com qual consentimento

### 5.1 O que cada função envia

| Função | Enviado | Não enviado |
|---|---|---|
| Enriquecer (lote) | para cada palavra: lema, classe e **a frase de exemplo do livro**; até 40 por pedido | título, arquivo, páginas, outras frases, a coleção |
| Definir palavra / segundo plano | lema, classe e **a frase** onde a palavra foi tocada ou adicionada | título, página |
| Juiz de código | linguagem, **pergunta, resposta de referência, respostas aceitas, a sua resposta** e o resultado do verificador | o resto da nota, o deck, o histórico |
| Cards de um trecho | **o trecho selecionado** (≤ 1 000 palavras), o tipo de card e o número máximo | **título e página** (mudança no C.4), o resto do livro |
| Testar chave | só a chave (cabeçalho) e o nome do modelo | nenhum texto |

Em todos: a chave vai no cabeçalho para o próprio provedor; nada de identificador do aparelho nem telemetria. A tela
de Configurações → IA mostra esta tabela, o nome e o domínio do provedor de cada função e o link da política de dados
dele, com os avisos da seção 2 (Gemini nível gratuito; DeepSeek na China; OpenAI/Gemini com armazenamento
desligado por nós).

### 5.2 Consentimento

1. IA desligada por padrão; nada sai sem provedor e chave configurados.
2. **Ao ativar um provedor para uma função**, um diálogo mostra o que será enviado (seção 5.1), para onde e os tetos;
   "Ativar" ou "Cancelar". Trocar de provedor pede de novo. (Substitui o consentimento por função no primeiro uso do
   plano anterior; seção 0.2, item 7.)
3. Gerar deck com IA e cards de um trecho mostram o custo estimado na própria tela antes de "Gerar".
4. Confirmação de chamada acima de US$ 0,05 (seção 3.6).
5. Sem telemetria; `ai_usage` fica no aparelho e não sincroniza (Fase 9 não a inclui).

### 5.3 Enriquecimento em segundo plano

- **Só itens novos:** palavras que você adiciona depois de o segundo plano estar ativo ("Adicionar ao deck do
  livro", criar card de Vocabulário pela seleção). Nunca decks antigos, nunca a biblioteca, nunca de novo quando o
  prompt mudar de versão.
- **Fila local** (tabela nova `ai_queue`: nota, lema, frase, criado em, estado, tentativas), visível em
  Configurações → IA e num indicador no Painel Anki do livro ("IA: 3 na fila"), com **Pausar/Retomar** e remover item.
  Pausar guarda a fila (não esvazia).
- Processa em lotes (até 40, juntando o que estiver na fila), um lote por vez, respeitando os tetos: teto atingido →
  a fila fica parada com a mensagem e volta sozinha na virada do dia/mês (se você não pausou). Sem rede → espera.
- Cada item: cache primeiro (custo zero); senão a IA; o resultado só preenche Tradução/Definição **se o campo ainda
  estiver como o app deixou** (não sobrescreve o que você editou).

---

## 6. Arquitetura e tarefas

### 6.1 Ganchos existentes e mudanças

- `src-tauri/crates/core-ai` (vazio: `serde`, `thiserror`).
- `core-store/src/settings.rs`: hoje `ai_provider` (`anthropic | openai_compatible`), `ai_base_url`,
  `ai_model_fast`, `ai_model_strong`, `ai_monthly_limit_usd`. **Passam a ser:** `ai_enrich_provider`,
  `ai_enrich_model`, `ai_enrich_effort`, `ai_judge_provider`, `ai_judge_model`, `ai_judge_effort`,
  `ai_limit_day_usd`, `ai_limit_month_usd`, `ai_max_output_tokens`, `ai_confirm_above_usd`, `ai_price_overrides`,
  `ai_background_enrich`, `ai_background_paused`, `ai_consent` (por provedor). As antigas são removidas (nunca foram
  usadas por funções).
- `core-store` esquema: `ai_usage` ganha `tokens_cached_in`, `tokens_cache_write`, `tokens_thinking`, `estimated`,
  `prices_checked_at`; tabela nova `ai_queue`; `vocab_enrichment_cache` sem mudança. Uma migração.
- `app/src/vocab/deck.rs` (`EnrichMode::Ai`, `VocabEnricher`), `core-vocab/src/notes.rs`, `app/src/secrets.rs`,
  interface (`AiSettings.tsx`, `AiDialog`, `CodePanel.tsx`, `GenerateDeckDialog.tsx`, `SelectionToolbar.tsx`,
  `types.ts`).

### 6.2 `core-ai` (Rust, sem APIs de desktop)

- `provider.rs` (trait, tipos), `anthropic.rs`, `openai_chat.rs` (dialetos OpenAI/DeepSeek), `gemini.rs`,
  `simulated.rs`.
- `run_structured<T>`: monta o pedido, valida com `serde` + regras (até 15 palavras na definição, 1–3 na tradução,
  `nota_sugerida` 1..4, lemas da resposta = lemas enviados, sem itens extras); inválido → **uma** nova tentativa com o
  erro; corte por limite → seção 0.2, item 6; falhou de novo → `ai_invalid_output`.
- Para o DeepSeek (sem `json_schema`), o schema vai no prompt com um exemplo, e a validação em Rust é a garantia.
- `prices.rs` (lê `model-prices.toml` + sobrescritas), `cost.rs` (pior caso antes, custo real depois), `limits.rs`
  (dia/mês locais, reserva, 80%, bloqueio), `queue.rs` (segundo plano).
- Erros: `ai_disabled`, `ai_no_key`, `ai_offline`, `ai_timeout`, `ai_auth`, `ai_rate_limited` (mostra
  `retry-after`), `ai_provider_spend_limit` (ex.: Anthropic `enforced_spend_limit_reached`), `ai_server`,
  `ai_refused`, `ai_invalid_output`, `ai_truncated`, `ai_limit_reached`, `ai_needs_confirmation`,
  `ai_model_not_found`, `ai_model_unpriced`. Mensagens em pt-BR.
- `prompts/*.md` (Apêndice C) versionados, embutidos com `include_str!`; a versão entra no hash do cache. C.4 sem
  título/página.
- Texto do livro e respostas do usuário são **dados não confiáveis** no prompt (delimitados, aviso no sistema); a
  saída nunca é executada nem vira HTML (campos escapados).

### 6.3 Comandos (Tauri)

| Comando | O que faz |
|---|---|
| `ai_settings_get` / `ai_settings_set` | Provedor/modelo/esforço por função, tetos, teto de tokens, confirmação, segundo plano; `hasKey` e `keySuffix` por provedor. |
| `ai_key_set(provider, key)` / `ai_key_delete(provider)` | Cofre. |
| `ai_key_test(provider)` | "Testar chave" (seção 4). |
| `ai_prices_get` / `ai_prices_set` | Tabela com data e fonte; sobrescritas. |
| `ai_usage(period)` | Gasto do dia e do mês por provedor e por função; tetos; estado (ok / 80% / bloqueado). |
| `ai_estimate(feature, input)` | Pior caso e custo provável, para a tela e a confirmação. |
| `ai_queue_get` / `ai_queue_pause` / `ai_queue_resume` / `ai_queue_remove` | Segundo plano. |
| `ai_judge_code(card, answer, verdict)` | C.1. |
| `ai_cards_from_text(text, kind, n)` | C.4; devolve propostas, não grava. |
| `vocab_define(lemma, context)` | Modo IA (C.3). |
| `vocab_generate_deck(…, {enrich: 'ai'})` | Job com progresso e cancelamento, lote a lote. |

Depois: `LEITOR_UPDATE_CONTRACT=1 cargo test -p leitor-estudos --test contract` e o mock da interface.

### 6.4 Telas

- **Configurações → IA:** (1) "Chaves": uma linha por provedor (Claude, GPT, Gemini, DeepSeek) com "•••• ABCD",
  "Testar chave", "Remover chave"; (2) "Funções": enriquecimento e juiz, cada um com provedor, modelo (sugestões) e
  esforço; nota de que Definir palavra e Cards usam os do enriquecimento; (3) "Limites": dia, mês, tokens por
  chamada, confirmação acima de; (4) "Gasto": hoje e no mês, por provedor e por função, com as barras; (5) "Preços":
  tabela com "conferido em" e fonte, editável; (6) "Segundo plano": interruptor, fila, Pausar/Retomar; (7) "O que é
  enviado": a tabela 5.1 e os avisos de cada provedor.
- **Gerar deck:** rádio "Definições com IA" quando o enriquecimento está configurado; custo estimado; palavras já no
  cache.
- **Popover / Definir palavra:** "Definir com IA".
- **Revisão de código:** "Pedir avaliação da IA" → veredito, explicação, nota sugerida ("Sugestão da IA — você decide
  a nota").
- **Criar cards com IA:** tipo e número → custo → lista com checkboxes → "Adicionar selecionados".
- Todo botão de IA mostra o estado: desligada, sem chave, sem rede, 80%, limite atingido.

### 6.5 Tarefas e commits, na ordem

1. **Interface + Claude** (um commit, ou dois se ficar grande: base e adaptador): `core-ai` (trait, tipos, prompts,
   validação, preços com os 4 provedores já na tabela, custo, tetos, `SimulatedProvider`), `AnthropicProvider`;
   configurações, cofre (`ai:anthropic`), migração, comandos, contrato, tela de IA, as 4 funções e a fila — tudo
   funcionando com o Claude. Testes com as respostas gravadas da Anthropic.
2. **GPT:** `OpenAiChatProvider` (dialeto OpenAI), cofre `ai:openai`, opção na tela; respostas gravadas da OpenAI.
3. **Gemini:** `GeminiProvider` (Interactions API), cofre `ai:gemini`; respostas gravadas do Google.
4. **DeepSeek:** dialeto `DeepSeek` no adaptador do GPT, cofre `ai:deepseek`; respostas gravadas da DeepSeek.
5. Fechamento: Vitest + Playwright simulado, capturas em `docs/capturas/fase-8/` (servidor simulado, chaves falsas),
   `docs/progresso.md`, `docs/decisoes.md`, `docs/tecnico/ia.md`, ajustes da especificação (§12.6, §13, §14, §18,
   §21, Apêndice C), `scripts/full-suite.sh`, CI verde.

Cada commit de provedor passa pela suíte completa antes. Dependências: nenhuma nova em produção além de `json`
no `reqwest` do `core-ai` (já usado em `core-cpp`) e `toml` (já no `Cargo.lock`, 0.8.2 e 1.1.8 pelo Tauri; usar
uma dessas versões, sem trazer outra). Em testes, servidor HTTP local com `axum` (já no `Cargo.lock`).

---

## 7. Critérios de aceite e como testar

### 7.1 Critérios

1. Funciona com **Claude, GPT, Gemini e DeepSeek**, um provedor por função, sem troca automática.
2. Chave por provedor **no cofre**; nunca no repositório, SQLite, log, captura ou JavaScript (exceto os 4 últimos
   caracteres); nenhuma chamada sem chave; "Testar chave" só no clique.
3. Todas as chamadas no Rust; **CSP sem mudança**.
4. **Tetos** dia/mês somados respeitados (inclusive em paralelo), aviso aos 80%, bloqueio total com mensagem; teto de
   tokens por chamada; confirmação acima de US$ 0,05; gasto por provedor na tela.
5. Enriquecimento (deck e segundo plano só de itens novos, com fila e pausa), definir palavra, juiz e cards de um
   trecho.
6. Com a IA desligada, o app inteiro funciona e nenhuma conexão de IA é aberta.
7. Saída validada; inválida → uma nova tentativa → falha clara; nada gravado sem validação.
8. Testes e CI só com provedor simulado e respostas gravadas; nenhuma chamada real, nenhuma chave real.

### 7.2 Testes (sem chave real, sem rede)

- **Respostas gravadas** em `src-tauri/crates/core-ai/tests/fixtures/<provedor>/`: montadas a partir dos exemplos
  de resposta da documentação oficial de cada API e escritas à mão no schema documentado (sucesso, JSON inválido,
  cortado por limite, recusa, 401, 429, 5xx, conteúdo vazio no DeepSeek, `status: incomplete` no Gemini). Cada
  arquivo diz de qual página e data veio. Nenhuma foi capturada de uma chamada real.
- **Servidor HTTP simulado** (local, porta aleatória) que serve essas respostas e confere o pedido: rota, cabeçalhos
  (`x-api-key` + `anthropic-version: 2026-10-21`; `Authorization: Bearer`; `x-goog-api-key` e nenhuma `?key=`), o
  schema/`response_format`, o esforço/pensamento da tabela 2.7, o teto de tokens, `store: false`, ausência de
  `temperature`. Os adaptadores recebem a URL base por injeção **só em testes** (não há configuração de URL no app).
- | Critério | Teste |
  |---|---|
  | 1 | Para cada provedor: as 4 funções contra o servidor simulado; troca de provedor por função; falha do provedor → erro, nenhum pedido a outro provedor (contagem do servidor). |
  | 2 | `MemoryStore`; chave marcada ausente de `settings`, do arquivo SQLite, do log capturado e do JSON de todos os comandos (só `keySuffix`); sem chave → servidor conta zero pedidos; varredura de padrões de chave no repositório; teste real do cofre com `scripts/with-keyring.sh`. |
  | 3 | Teste da CSP: `connect-src` igual ao de hoje; Vitest garante que a interface não chama `fetch` para fora. |
  | 4 | `limits.rs`: virada de dia/mês no fuso local, reserva concorrente, 80%, bloqueio; app: teto de US$ 0,01 → a chamada que passaria é bloqueada antes de sair; pior caso > US$ 0,05 → `ai_needs_confirmation`; faixas de preço (100 mil do Haiku, data do Gemini, horário do DeepSeek). |
  | 5 | `SimulatedProvider`: deck com IA (lotes de 40, cache evita a 2ª chamada, HTML escapado), fila (só itens novos, pausa, teto para a fila, não sobrescreve campo editado), `vocab_define`, juiz (o card não é respondido), cards (nada gravado sem confirmar). Vitest e Playwright simulado (Chromium + WebKit). |
  | 6 | Suíte atual com IA desligada; servidor simulado com zero pedidos; botões "IA desligada". |
  | 7 | JSON inválido → nova tentativa; inválido 2× → erro; corte → regra do item 6 da seção 0.2. |
  | 8 | O CI não tem segredo de IA; teste falha se alguma variável `*_API_KEY` estiver definida no ambiente de teste. |

### 7.3 Verificação manual (depois, com as suas chaves)

Com as suas chaves (digitadas só na tela, nunca no chat ou em arquivo): "Testar chave" de cada provedor, 1 lote de
15 palavras, 3 definições, 2 avaliações de código, 1 geração de cards por provedor, comparando o custo registrado com
o painel de uso de cada provedor. Anotar em `docs/progresso.md`, e confirmar ali os itens **não verificados** (DeepSeek
`max_tokens` com raciocínio; Gemini `total_output_tokens` com ou sem pensamento; campos do `ResponseFormat`).

---

## 8. Riscos e perguntas

### 8.1 Riscos

- **Modelos e preços mudam** (o Gemini 3.8 Flash já tem data para dobrar): tabela com data, aviso após 90 dias,
  modelo sem preço bloqueado, "Testar chave" detecta modelo inexistente.
- **Pensamento no teto do juiz (2 000):** com esforço baixo deve caber; se cortar, regra do item 6 da seção 0.2; medir com as respostas reais.
- **DeepSeek sem `json_schema`** e com conteúdo vazio ocasional: validação + uma nova tentativa.
- **Gemini sem "desligar pensamento"** nos 3.x: o mínimo ainda pensa um pouco; coberto pelo teto e pelo custo real.
- **Compatibilidade do Gemini com OpenAI em beta:** evitada com o adaptador nativo.
- **Qualidade da tradução "no sentido da frase"** com modelos baratos: conferir numa amostra.
- **Injeção de prompt pelo texto do livro:** schema, validação, escape e revisão humana.
- **A chave passa uma vez pela interface ao ser digitada.**
- **Disco/CI:** sem builds pesados novos.

### 8.2 Perguntas que ficam (as respondidas saíram da tabela)

| Pergunta | Padrão proposto |
|---|---|
| Gemini pelo adaptador nativo (Interactions API) em vez do compatível com OpenAI (0.2, item 2) | Nativo. |
| Consentimento: um por provedor, ao ativar, em vez de um por função (0.2, item 7) | Um por provedor. |
| Preço do DeepSeek: pelo horário (pico/fora) ou sempre o de pico (0.2, item 10) | Estimativa pelo pico, registro pelo horário. |
| Limite do trecho para "Cards de um trecho" (0.2, item 13) | 1 000 palavras, sem título/página. |
| OpenAI por Chat Completions (0.2, item 15) | Sim. |
| Modelos de enriquecimento: "atual" = geração atual (Luna, 3.5 Flash-Lite) mesmo havendo modelos antigos mais baratos (2.3, 2.4) | Geração atual. |
| Juiz do DeepSeek: `deepseek-v4-pro` (só existem 2 modelos) | Sim. |
| Fila parada pelo teto volta sozinha na virada do dia/mês | Sim (se não estiver pausada). |

---

## 9. Fontes consultadas (todas lidas em 24/10/2026)

**Anthropic**
- Modelos: <https://platform.claude.com/docs/en/about-claude/models/overview>
- Preços: <https://platform.claude.com/docs/en/about-claude/pricing>
- Pensamento: <https://platform.claude.com/docs/en/build-with-claude/thinking>
- Esforço: <https://platform.claude.com/docs/en/build-with-claude/effort>
- Saída estruturada: <https://platform.claude.com/docs/en/build-with-claude/structured-outputs>
- Messages API (criar, `usage`, `stop_reason`): <https://platform.claude.com/docs/en/api/messages/create>
- Obter modelo: <https://platform.claude.com/docs/en/api/models/retrieve>
- Versão 2026-10-21: <https://platform.claude.com/docs/en/api/migration-2026-10-21>
- Limites e teto de gasto: <https://platform.claude.com/docs/en/api/rate-limits>

**OpenAI**
- Modelos: <https://developers.openai.com/api/docs/models> · <https://developers.openai.com/api/docs/models/gpt-6-luna> · <https://developers.openai.com/api/docs/models/gpt-6.1-sol>
- Preços: <https://developers.openai.com/api/docs/pricing>
- Raciocínio: <https://developers.openai.com/api/docs/guides/reasoning> · <https://developers.openai.com/api/docs/guides/latest-model>
- Saída estruturada: <https://developers.openai.com/api/docs/guides/structured-outputs>
- Chat Completions (referência): <https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create>
- Obter modelo: <https://developers.openai.com/api/reference/resources/models/methods/retrieve>

**Google**
- Modelos: <https://ai.google.dev/gemini-api/docs/models>
- Preços: <https://ai.google.dev/gemini-api/docs/pricing>
- Compatibilidade com OpenAI: <https://ai.google.dev/gemini-api/docs/openai>
- Pensamento: <https://ai.google.dev/gemini-api/docs/thinking>
- Saída estruturada: <https://ai.google.dev/gemini-api/docs/structured-output>
- Interactions API: <https://ai.google.dev/gemini-api/docs/interactions> · <https://ai.google.dev/api/interactions-api>
- `generateContent` (legado; `usageMetadata`, `finishReason`): <https://ai.google.dev/api/generate-content>
- Modelos (get/list): <https://ai.google.dev/api/models>

**DeepSeek**
- Primeira chamada: <https://api-docs.deepseek.com/>
- Modelos e preços: <https://api-docs.deepseek.com/quick_start/pricing>
- Chat Completions: <https://api-docs.deepseek.com/api/create-chat-completion>
- Modo JSON: <https://api-docs.deepseek.com/guides/json_mode>
- Modo de pensamento: <https://api-docs.deepseek.com/guides/thinking_mode>
- Listar modelos: <https://api-docs.deepseek.com/api/list-models>

**Não verificado nas páginas lidas** (fica para as respostas gravadas e a verificação manual): se o `max_tokens` do
DeepSeek inclui o raciocínio; se o modo JSON do DeepSeek funciona com pensamento; se `total_output_tokens` do Gemini
inclui `total_thought_tokens`; os subcampos exatos do `ResponseFormat` da Interactions API; que as rotas de
modelos (usadas no "Testar chave") são gratuitas — nenhuma página diz isso explicitamente, embora não gerem tokens.
