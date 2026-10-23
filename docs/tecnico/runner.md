# C++ nos cards de código: compilador local e runner

Spec: 11.5 (C++), 14/15 (`code_run_cpp`), 18 (limites locais, runner isolado), 21 (Fase 5), Apêndice A.1 (serviços do
Leitor no VPS). Decisão do usuário (docs/decisoes.md, 2026-10-22): no desktop, C++ usa o compilador local; o runner
remoto serve ao iPad, que está adiado — mas o runner existe e passa nos testes de isolamento **localmente**.

## Peças

| Peça | Onde | O quê |
|---|---|---|
| `core-cpp` | `src-tauri/crates/core-cpp` | `run_local` (compilador local), `RemoteRunner` (cliente do runner), `detect_local`, `format_cpp`, `CHECK_HPP`, validação |
| runner | `server/runner` | Serviço Rust + axum, projeto Cargo próprio (fora do workspace `src-tauri`), imagem Docker |
| proxy local | `server/runner/Caddyfile`, serviço `runner-dev-proxy` | Única entrada do runner local (espelha o Caddy do VPS) |
| testes de isolamento | `src-tauri/crates/core-cpp/tests/remote.rs`, `scripts/runner-test.sh` | Rodam contra o runner local pelo proxy |
| modelo do VPS | `server/compose.leitor.yml` | Runner numa rede interna atrás do Caddy do Painel — **implantação pendente** |

## Validação (igual no local e no runner)

`src/validate.rs` é idêntico byte a byte em `core-cpp` e em `server/runner` (o teste `tests/shared_files.rs` de
`core-cpp` confere; o mesmo vale para `check.hpp`).

- Nomes de arquivo: `^[A-Za-z0-9_.-]{1,64}$`, sem começar com `.` ou `-`, extensão `.cpp`, `.cc`, `.hpp` ou `.h`
  (minúsculas). `check.hpp` é reservado (qualquer caixa).
- No máximo 16 arquivos, 512 KiB de código no total, 1 MiB de stdin, pelo menos um `.cpp`/`.cc`.
- Só `.cpp`/`.cc` vão para o compilador, um por um (sem glob, sem shell); os cabeçalhos ficam ao lado.

## `check.hpp` (modo `testes`)

Escrito sempre ao lado dos fontes. `CHECK(expr)` imprime exatamente `PASS <expr>` ou `FAIL <expr> (<arquivo>:<linha>)`
seguido de `\n` no stdout e faz `fflush`; se algum `CHECK` falhou, o programa termina com código 1 (gancho `atexit`).
Só cabeçalho, C++20, sem exceções. A macro é variádica, então `CHECK(f(std::vector<int>{1, 2}) == 3)` funciona.

## Local (desktop)

- Compilador: `LEITOR_CXX` (caminho ou nome no PATH), senão `g++`, senão `clang++` no PATH (`.exe` no Windows).
  `clang-format` no PATH para o modo `estrutura` (`format_cpp`: `--style=LLVM` pelo stdin, 5 s; sem ele, o chamador
  normaliza espaços).
- Pasta temporária nova (`leitor-cpp-*` em `std::env::temp_dir()`), removida também em erro e tempo esgotado.
- Compilação: `g++ -std=c++20 -O0 -Wall -Wextra -o prog <cada .cpp>`, 10 s de relógio.
- Execução: `./prog`, 10 s de relógio (`timeout_ms` do pedido pode baixar, nunca subir; mínimo 100 ms). stdin por uma
  thread, stdout/stderr lidos em threads (sem deadlock de pipe), cada um limitado a 256 KiB (`truncated`).
- Grupo de processos próprio (`process_group(0)`); no fim — por tempo ou não — `killpg(SIGKILL)` no grupo inteiro.
  No Linux o líder fica zumbi (`waitid` com `WNOWAIT`) até o `killpg`, então o id do grupo não pode ser reutilizado.
  Depois do `killpg`, no Linux, também morre (`SIGKILL`) todo processo do mesmo uid cujo diretório de trabalho ou
  executável está dentro da pasta temporária da execução — pega quem saiu do grupo com `setsid`/`setpgid`
  (`process.rs`, `supervise_in`/`kill_strays`).
- Limites com o `prlimit` do util-linux (Linux; o workspace proíbe `unsafe`, então nada de `setrlimit` em `pre_exec`):
  - compilação: `--cpu=10:11 --as=2147483648`;
  - programa: `--cpu=10:11 --as=1073741824 --fsize=10485760 --nproc=<tarefas atuais deste uid em /proc + 128>`.
  - CPU como `macio:duro` para o kernel mandar `SIGXCPU` (relatado como `timedOut`); com macio = duro ele mandaria
    `SIGKILL`, que parece um crash.
  - Sem `prlimit`: um aviso no log (uma vez) e só tempo limite + `killpg`.
- Windows: só `Child::kill` (fora do escopo; não quebrar de propósito).

## API do runner

- `GET /health` → `200 ok` (sem token).
- `POST /run`, `Authorization: Bearer <RUNNER_TOKEN>` (comparação em tempo constante; o servidor não sobe com o token
  vazio; o token nunca vai para o log), corpo até 1 MiB:

  ```json
  {"language": "cpp", "files": {"main.cpp": "…"}, "stdin": "", "timeout_ms": 10000}
  ```

  → `200`

  ```json
  {"compile": {"ok": true, "stderr": "", "time_ms": 412},
   "run": {"exit_code": 0, "signal": null, "stdout": "…", "stderr": "", "time_ms": 3, "timed_out": false, "truncated": false},
   "compiler": "g++ (Debian 12.2.0-14+deb12u1) 12.2.0"}
  ```

  O formato da spec mais `compile.time_ms`, `run.signal`, `run.truncated` e `compiler`. `run` é `null` quando a
  compilação falha.
- Erros (`{"error": "<código>", "message": "…"}`): `401 unauthorized` (antes de ler o corpo); `400 invalid_json`, `unsupported_language`,
  `invalid_name`, `reserved_name`, `no_source`, `too_many_files`; `413` (`body_too_large` — corpo > 1 MiB; o runner
  lê e descarta até 8 MiB antes de responder, para o proxy repassar o 413 em vez de um 502 —, `source_too_large`,
  `stdin_too_large`); `400 invalid_body`; `503 busy` (fila cheia); `500 internal`.
- Uma execução por vez (`Semaphore(1)`), até 8 esperando; a 10ª simultânea recebe 503. O trabalho roda destacado da
  conexão: um cliente que desiste não interrompe a limpeza nem libera a vez antes da hora.
- Por execução: pasta nova em `/work`, `check.hpp` escrito, depois
  - compilação: `prlimit --cpu=10:11 --as=1073741824 --fsize=10485760 --nproc=64 -- timeout -s KILL 15 g++ -std=c++20 -O0 -Wall -Wextra -o prog …`
  - programa: `prlimit --cpu=5:6 --as=536870912 --fsize=10485760 --nproc=64 -- timeout -s KILL <limite + 0,5 s> ./prog`
    (spec: CPU 5 s, 512 MB, 64 processos, arquivos de 10 MB). O limite de relógio é `min(timeout_ms, 10000)`, medido
    pelo próprio runner; o `timeout` é a rede de segurança meio segundo depois.
  - `killpg(SIGKILL)` no grupo, pasta apagada, saída limitada a 256 KiB por fluxo.
  - Usuário próprio dos jobs (`RUNNER_JOB_USER`, `10002:10002` na imagem): compilador e programa rodam como
    `setpriv --reuid=10002 --regid=10002 --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs -- prlimit …`.
    Como o servidor é 10001 e não é "dumpable" (`PR_SET_DUMPABLE 0`), um programa não consegue matar o servidor nem
    ler o `/proc/<pid>/environ` dele (onde está o `RUNNER_TOKEN`).
  - Ambiente mínimo (`env_clear`): só `PATH`, `LANG=C.UTF-8`, `HOME` e `TMPDIR` (a pasta do job). Nada do runner chega
    ao programa.
  - Coletor (`runner --reap <uid> [pastas…]`, rodado como 10002 pelo mesmo `setpriv`): depois da compilação e da
    execução, `kill(-1, SIGKILL)` mata **todo** processo do uid dos jobs (quem fez `setsid` também) até o `/proc` não
    mostrar nenhum vivo; no fim de cada job apaga os arquivos do uid dos jobs em `/work`, `/tmp` e `/dev/shm`. Ele se
    recusa a agir se não estiver exatamente com o uid pedido (nunca root). Também roda na partida (falhar = o runner
    não sobe).
  - `timed_out`: limite de relógio, `SIGXCPU` (CPU) ou `SIGKILL` (limite duro de CPU / `timeout`).
- `RUNNER_NPROC` (padrão 64) só existe para os testes de unidade, que rodam com o uid do desenvolvedor (sem
  `RUNNER_JOB_USER`): aí o `RLIMIT_NPROC` conta todas as tarefas do uid, inclusive as do próprio runner (por isso o
  runtime tokio tem uma thread só). No contêiner ele conta só os processos do uid dos jobs. Outras variáveis: `RUNNER_PORT` (8080), `RUNNER_WORK_DIR` (`/work`), `RUNNER_CXX` (`g++`).

## Contêiner

`server/runner/Dockerfile`: estágio de build `rust:1.97.1-slim-bookworm` (`cargo build --release --locked`); imagem final
`debian:bookworm-slim` com `g++`, `clang-format`, `util-linux`, `coreutils` (sem curl), usuários `runner` (uid 10001,
o servidor) e `runner-job` (uid 10002, os jobs), entrada
`setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all,+setuid,+setgid --ambient-caps=-all,+setuid,+setgid -- runner`
(o contêiner parte como root só para isso: o servidor já nasce 10001, com CAP_SETUID/CAP_SETGID como únicas
capacidades, só para iniciar os jobs como 10002 — o Docker não dá capacidades a um `user:` não root),
`WORKDIR /work`, `EXPOSE 8080`, `HEALTHCHECK` por `runner --healthcheck`.

No compose (`compose.dev.yml`, perfil `runner`; o mesmo no modelo do VPS):

| Isolamento | Como |
|---|---|
| Sem rede | Só na rede `leitor-runner-internal` (`internal: true`: sem rota para fora, sem porta publicada) |
| Única entrada | `runner-dev-proxy` (Caddy) nas redes `leitor-runner-internal` e `leitor-dev`; no host, `127.0.0.1:28090` (`LEITOR_RUNNER_PROXY_PORT`) |
| Raiz somente leitura | `read_only: true`; `tmpfs` em `/work` (64 MB, `exec`) e `/tmp` (16 MB) |
| Sem privilégios | `user: "0:0"` só para a entrada `setpriv` (servidor 10001, jobs 10002), `cap_drop: [ALL]` + `cap_add: [SETUID, SETGID]`, `no-new-privileges` |
| Teto do contêiner | `pids_limit: 256`, `mem_limit: 1g`, `cpus: 2`, `init: true` (recolhe os processos órfãos de um programa morto) |
| Token | `RUNNER_TOKEN: ${LEITOR_RUNNER_DEV_TOKEN:-dev-runner-token}` — valor descartável só para testes locais, como a senha `test` do servidor de sync |

O perfil `runner` deixa o `docker compose -f compose.dev.yml up` padrão (usado por `scripts/sync-test.sh` e pela CI de
sync) exatamente como antes: `docker compose -f compose.dev.yml config` sem o perfil é idêntico ao de antes.

## Rodar localmente

```bash
# Subir (constrói a imagem leitor-runner-dev na primeira vez)
docker compose -f compose.dev.yml --profile runner up -d --build --wait runner-dev runner-dev-proxy
curl -s http://127.0.0.1:28090/health
curl -s -H 'Authorization: Bearer dev-runner-token' -H 'Content-Type: application/json' \
  -d '{"language":"cpp","files":{"main.cpp":"#include <cstdio>\nint main(){std::puts(\"oi\");}"}}' \
  http://127.0.0.1:28090/run
# Remover
docker compose -f compose.dev.yml --profile runner rm -sfv runner-dev runner-dev-proxy
```

No app (Configurações → Código), o runner local é `http://127.0.0.1:28090/` com o token `dev-runner-token`.

## Testes

| O quê | Comando |
|---|---|
| `core-cpp` local (g++, clang-format e prlimit do devcontainer) | `scripts/dev.sh bash -c 'cd src-tauri && CARGO_INCREMENTAL=0 cargo test -j 8 -p core-cpp'` |
| Runner, testes de unidade (auth, validação, fila, formato da resposta, execuções reais) | `scripts/dev.sh bash -c 'cd server/runner && CARGO_TARGET_DIR=$PWD/../../src-tauri/target/runner CARGO_INCREMENTAL=0 cargo test'` |
| Isolamento (host, raiz do repo) | `scripts/runner-test.sh [all\|core-cpp\|app]` → `RESULT: PASS` |

`scripts/runner-test.sh` sobe `runner-dev` + `runner-dev-proxy`, confere pelo `docker inspect` que o runner está só na
rede interna, com raiz somente leitura, `cap_drop ALL` + só `SETUID`/`SETGID`, o processo do servidor com uid 10001
(`docker top`) e sem porta publicada, e roda
`cargo test -p core-cpp --test remote -- --test-threads=1` no devcontainer na rede `leitor-dev`
(`LEITOR_RUNNER_TEST_URL=http://runner-dev-proxy:8080`, `LEITOR_RUNNER_TEST_TOKEN`); com `app`, também
`cargo test -p leitor-estudos --test code remote`. No fim remove sempre os dois contêineres (`KEEP_RUNNER=1` mantém).

A suíte de isolamento (`tests/remote.rs`):

1. modos `testes` e `saida` funcionam pelo runner (e erro de compilação volta como `compile.ok = false`);
2. rede: `connect()` para `1.1.1.1:80`, para `ankisync-dev:8080` e `getaddrinfo("example.com")` falham;
3. loop infinito: `timed_out` e a requisição inteira em menos de 8 s (CPU 5 s);
4. fork bomb contida: a requisição volta, `/health` responde 200 e uma execução normal funciona em menos de 15 s;
5. arquivo de 20 MB: o programa morre com `SIGXFSZ`; ignorando o sinal, a escrita para em 10 MB;
6. `malloc` + `memset` de 1 GiB falha;
7. raiz somente leitura: escrever em `/etc`, `/usr`, `/`, `/usr/local/bin` falha; `/work` e a pasta da execução aceitam;
8. sem token ou com token errado → `RemoteAuth` / 401 (o `/health` não pede token);
9. duas requisições simultâneas são serializadas (as janelas de execução não se sobrepõem);
10. corpo grande demais → `TooLarge` no cliente, 413 no runner (código > 512 KiB e corpo > 1 MiB), linguagem errada → 400;
11. um processo que fez `setsid` manda `SIGKILL` para todo pid de outro uid em `/proc` (init e o servidor): todos dão
    `EPERM`, e depois `/health` responde 200 e uma execução normal funciona;
12. escape com `setsid`: um filho que dorme 120 s segurando os pipes e deixa arquivos em `/work`, `/tmp`, `/dev/shm` —
    a resposta volta logo e o job seguinte não vê nenhum processo do uid dos jobs nem os arquivos;
13. o ambiente do programa não tem nenhuma variável `RUNNER_` nem o token, e nenhum `/proc/<pid>/environ` legível o
    contém;

## O que falta para o VPS (🌐 pendente; o iPad está ⏸️ adiado)

- Clonar o repositório em `/opt/leitor-estudos` e ligar `include: /opt/leitor-estudos/server/compose.leitor.yml` no
  compose do Painel (Apêndice A.1). O modelo já define o serviço `runner` (porta interna 8091, `RUNNER_TOKEN`) só na
  rede `runner_net` (`internal: true`), com os mesmos limites do `compose.dev.yml`.
- No Caddy do Painel: entrar na rede `runner_net` e servir `https://runner.<domínio>/ { reverse_proxy runner:8091 }`
  (limite grosso de corpo de ~8 MB, como no `Caddyfile` local; quem responde 413 é o runner).
- Gerar o token no VPS (`openssl rand -base64 32`), guardar no `.env` do VPS (fora do git) e colar no Leitor
  (Configurações → Código; fica no keychain).
- Rodar a suíte de isolamento contra o VPS (`LEITOR_RUNNER_TEST_URL=https://runner.<domínio>/` e o token) antes de
  usar no iPad. Os testes 2 (nome `ankisync-dev`) e 7 continuam válidos; o 2 deve também tentar um serviço do Painel.

## Limitações conhecidas

- Local: `RLIMIT_NPROC` conta as tarefas do uid no sistema inteiro. Dentro do devcontainer (sem userns), o `/proc` só
  mostra os processos do contêiner, então o limite calculado fica mais apertado que o real (uma fork bomb nem consegue
  começar) — no desktop de verdade a conta é exata.
- Local: um programa que sai do próprio grupo de processos (`setsid`) escapa do `killpg`, mas é morto pela varredura
  da pasta temporária (diretório de trabalho ou executável dentro dela). Quem sai do grupo **e** faz `chdir` para fora
  **e** `exec` de outro binário escapa da varredura; ainda carrega os limites de CPU, memória e arquivo. É a máquina do
  próprio usuário (spec 11.5); no runner, o coletor por uid pega tudo.
- Runner: depois que o líder sai, o grupo é morto logo depois de recolhido; dentro do namespace de PIDs do contêiner,
  que só roda o runner, a reutilização desse id nesse intervalo não é um risco prático.
