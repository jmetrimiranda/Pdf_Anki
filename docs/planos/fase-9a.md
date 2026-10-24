# Fase 9a — Sincronização entre PCs Linux (plano de trabalho)

Escopo e aceite: mensagem do usuário de 24/10/2026 (resumo em `docs/decisoes.md`). Especificação: §16. Este plano
registra só o desenho e as escolhas técnicas; o que contradiz a §16 está marcado e vai para `docs/decisoes.md`.

## 1. Servidor (`server/library-sync`, Rust + axum + SQLite)

Projeto Cargo próprio (como o `server/runner`), imagem própria, sem portas publicadas. Dados num volume nomeado:
`library.sqlite` (registros, aparelhos) e `files/<book_uid>/<file_hash>` (arquivos).

| Rota | O que faz |
|---|---|
| `GET /v1/health` | Sem autenticação; para o deploy e o Caddy. |
| `POST /v1/login` | `{user, password, device}` → token novo do aparelho (só o hash fica no servidor). Usuário e senha da biblioteca vêm do `.env` do H110. Falha: 1 s de espera; 10 falhas em 10 min bloqueiam o login por 10 min. |
| `POST /v1/logout` | Revoga o token do próprio aparelho. |
| `GET /v1/changes?since=<seq>&limit=<n>` | Registros com `seq > since`, em ordem, e o novo cursor (`seq` do servidor, nunca o relógio dos aparelhos). |
| `POST /v1/changes` | Registros alterados. Por chave vence o `updated_at` maior; empate: o que chega por último. Devolve o `seq` de cada registro aceito e a versão vencedora dos recusados. |
| `HEAD/GET /v1/files/{book_uid}` | Versão atual (`x-file-hash`, `x-file-version`, `content-length`), com `Range` para baixar em partes. |
| `POST /v1/uploads` | Começa um envio `{book_uid, base, hash, size}` → `upload_id`, tamanho das partes (32 MB). |
| `PUT /v1/uploads/{id}/{n}` | Uma parte (≤ 32 MB: abaixo do limite de 100 MB por requisição do Cloudflare). |
| `POST /v1/uploads/{id}/finish` | Confere o SHA-256 do todo; se `base` não é mais a versão atual → **409** com a versão atual (cópia de conflito no app); senão vira a versão atual (`file_version + 1`). |

**Diferença da §16:** o `PUT /v1/files/{book_uid}?base=` de uma vez vira o envio em partes acima (limite de 100 MB
do Cloudflare). Sempre em partes, até para arquivos pequenos (um caminho só).

Registros: tipo (`book`, `reading_position`, `epub_annotation`, `vocab_override`, `notetype_mapping`,
`code_note_extra`), chave, `updated_at`, `deleted`, dados JSON (≤ 256 KB). O servidor não interpreta os dados
(só confere tipo, tamanho da chave e JSON válido). Limpeza diária: lápides com mais de 90 dias; arquivos de livros
apagados há mais de 30 dias; envios abandonados há mais de 1 dia.

Aparelhos: `library-sync device list` e `library-sync device revoke <nome>` (dentro do container; não mostram tokens).

## 2. App

- `core-store` V6: tabela `library_sync_seen(kind, key, updated_at, file_hash)` — a última versão de cada registro
  que este aparelho já trocou com o servidor (evita reenviar o que veio de lá) e `sync_state` para cursor, URL e
  primeiro sync.
- Ordem de cada sincronização: (1) enviar os arquivos que mudaram **neste** aparelho (versão local atual diferente
  da última confirmada pelo servidor; em partes), antes de tudo, para o servidor apontar o conflito (409) antes que
  o registro de outro aparelho mude o livro aqui; (2) puxar `changes` até o fim e aplicar (livros antes de
  posição/anotações); (3) enviar os registros alterados (os que diferem de `library_sync_seen`). Um livro igual ao
  original (hash = `book_uid`) num aparelho novo não sobe se o servidor já tem uma versão: adota a do servidor.
- **Primeiro sync de um aparelho:** só baixa. Para chaves que o servidor já tem, a versão do servidor vence, qualquer
  que seja o relógio; só registros que o servidor não tem são enviados. Nunca sobrescreve o servidor.
- **Arquivos:** livro que veio de outro aparelho aparece na biblioteca com "Baixar"; abrir baixa antes (em partes,
  `Range`). Livro com versão local desatualizada baixa a do servidor ao abrir.
- **Conflito de arquivo (409):** baixa a versão do servidor como atual; a versão local vira um livro novo
  "<título> (cópia de conflito, <aparelho>, <data>)", enviado como qualquer livro novo; aviso na tela. Anotações
  de PDF não são juntadas (decisão do usuário).
- **Quando:** ao abrir o app, ao fechar um livro, a cada 5 min, e no botão "Sincronizar agora". Offline: espera e
  tenta de novo, nada se perde (as alterações ficam no banco local).
- Configurações → Sincronização: endereço do servidor da biblioteca, nome do aparelho, login (usuário/senha da
  biblioteca → token no chaveiro, `library-sync:<url>`), sair (revoga), último status e "Sincronizar agora". O Anki
  continua na seção dele (agora apontando para `https://anki.jmetrimirandai.com/`).
- **Coleção do Anki acima de 100 MB:** o envio completo do Anki é uma requisição só; acima de ~95 MB o app recusa o
  envio completo com mensagem clara (o sync normal e o de mídia já vão em partes pequenas).

## 3. H110 (`infra/sync-server/`)

`compose.yml` (Anki sync oficial 26.9.3 como no `compose.dev.yml` + `library-sync` + Caddy interno na porta 80
roteando por hostname + cloudflared com o túnel novo "leitor"), sem portas publicadas, `restart: unless-stopped`,
logs com rotação, volumes nomeados, `ulimits core: 0`. `deploy.sh` como o do Painel (etiqueta do commit, saúde,
volta automática). `README.md` com os comandos (os de `sudo` o usuário roda) e o passo a passo do Cloudflare.

## 4. Testes

- Servidor: testes do próprio crate (rotas, LWW, empates, 409, partes, Range, login/bloqueio, revogação, limpeza).
- App: dois `AppState` (PC A e PC B) contra o servidor rodando no próprio teste (sem rede externa, roda no CI):
  livro + leitura + destaques + anotações + palavras + revisão; B recebe tudo; mudanças de B voltam para A;
  offline nos dois e reconexão; posição (mais recente), anotações (soma), exclusões; primeiro sync só baixa;
  conflito de arquivo → cópia; arquivo de mais de 100 MB em partes.
- `scripts/library-sync-test.sh`: os mesmos dois clientes contra o compose local (servidor de verdade em container),
  fora do CI.
