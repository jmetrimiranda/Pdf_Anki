# Incidente de disco cheio: leia antes de trabalhar nesta máquina

**Data:** 23/10/2026
**Máquina:** Alienware 16 Area-51, Ubuntu, partição `/` = `/dev/nvme0n1p2` (544 GB, ext4)
**Usuário:** `jorgemetri`, com os repositórios em `~/Desktop/git_repositories/`

## 0. Para quem é este documento

Para **qualquer agente que trabalhe em algum projeto desta máquina**: Painel de Estudos, Leitor e os projetos de robótica e outros cujas imagens Docker foram apagadas.

Como usar:
1. Leia as seções 1 a 3 para entender o que aconteceu.
2. Procure o seu projeto na **tabela da seção 4** e faça o que está na linha dele.
3. Siga o **procedimento da seção 5** para recriar o que precisar.
4. Se você for o agente do Painel ou do Leitor, veja também a **seção 6**.
5. Respeite as **regras da seção 7** em todo trabalho daqui para frente.
6. Termine com o **relatório da seção 8**.

## 1. Resumo

- **O que aconteceu:** o disco chegou a 100% (0 bytes livres). Um agente não conseguiu gravar um commit, e uma suíte E2E caiu.
- **Causa:** agentes rodando builds e testes pesados ao mesmo tempo, sem checar o espaço antes. Isso se somou a meses de acúmulo de imagens e volumes Docker.
- **Correção feita pelo usuário:** `docker builder prune` (2,84 GB) e `docker image prune -a` (7,37 GB). Foram removidas **apenas as imagens que nenhum container usava** e o cache de build.
- **Perda de dados: nenhuma.**
  - Nenhum container, volume ou arquivo de código foi apagado.
  - Não há `docker commit` no histórico do usuário. Nenhuma imagem guardava um estado salvo à mão; todas foram geradas a partir de uma receita ou baixadas de um registro.
- **Consequência:** alguns projetos vão precisar **recriar ou baixar de novo** as suas imagens no próximo uso (seção 4).
- **Agora:** cerca de 31 GB disponíveis (95% de uso). A folga é pequena, então as regras da seção 7 são obrigatórias.

## 2. O que aconteceu

| Hora | Evento |
|---|---|
| até 13h38 | O agente do Painel termina as etapas 1 a 4. As etapas 1 a 3 ficam com commit local; a 4 fica só nos arquivos. Enquanto ele verificava, o uso subiu de 517 para 519 GB: outro processo estava escrevendo no disco. |
| 13h38 | Disco a 100%. O commit da etapa 4 falha (o repositório fica íntegro). O Playwright cai no início. |
| 13h39 | O agente do Leitor apaga um volume temporário (7 GB) e relata "14 GB livres". Ele ainda tem um volume de build com cerca de 55 GB de sobras. |
| 13h41 | O usuário mede, como usuário comum: 513 GB usados, **3,7 GB disponíveis**. |
| 13h42 | Builder prune (2,84 GB) e image prune -a (7,37 GB). |
| 13h46 | 486 GB usados, **31 GB disponíveis**. Cerca de 17 GB além da limpeza do usuário foram liberados por outro processo, provavelmente o agente do Leitor. A confirmar. |

## 3. Diagnóstico

### 3.1 Causa direta
- **O Leitor** fazia builds de Rust e C++ com volumes Docker de build (cerca de 55 GB de sobras e um volume temporário de 7 GB).
- **Ao mesmo tempo, o Painel** rodava a suíte E2E completa do Playwright (vídeos, traces e capturas) e usava imagens de teste.
- **Ninguém media o espaço** antes de tarefas pesadas, e não havia regra de uma tarefa pesada por vez.

### 3.2 Causa de fundo: acúmulo

| Onde | Tamanho antes da limpeza |
|---|---|
| Imagens Docker | 113,7 GB (65 imagens, 15 em uso) |
| Volumes Docker | 88,8 GB (174 volumes; só 2,7 GB sem vínculo com container) |
| Containers Docker | 5,2 GB (27 no total, 5 rodando) |
| `/home/jorgemetri` | 277 GB, sendo: repositórios 135 GB, VirtualBox VMs 47 GB, Downloads 45 GB, `.cache` 16 GB, micromamba 11 GB |

### 3.3 Armadilhas de medição (evite repetir)
1. **A reserva do ext4.** A partição reserva 5% (cerca de 27 GB) que só o root pode usar. Um processo rodando como root vê cerca de 27 GB a mais de espaço livre do que o usuário. **Meça sempre como usuário comum.**
2. **O "RECLAIMABLE" do `docker system df` exagera.** Ele indicava 73 GB recuperáveis em imagens; a limpeza liberou 7,37 GB. Ele soma o tamanho inteiro de cada imagem sem uso, inclusive camadas compartilhadas com imagens que continuam em uso.

## 4. Imagens apagadas, por projeto

Encontre o seu projeto. "Receita" é onde a imagem é definida.

| Projeto | Imagens apagadas | Receita encontrada | O que fazer |
|---|---|---|---|
| **Painel de Estudos** | `painel-api-test`, `painel-web-test`, `painel-backup-test` | No repositório do Painel | Recriar no próximo E2E (seção 6.1) |
| **Leitor** | `leitor-runner-dev:latest`, `leitor-ankisync-dev:26.9.3` (`leitor-dev:phase1-test` só perdeu a etiqueta; a imagem continua com outro nome) | No repositório do Leitor | Recriar **antes** de testar o runner de C++ e o Anki sync (seção 6.2) |
| **Solid_bulk_unloading_lidar_livox360** | `livox-mid360s-humble:latest` | `docker-compose.yml` e `fastlio_pkg/docker-compose.yml` | `docker compose build` quando for usar |
| **go2_stack_mining_company** | `tc001:humble` | `docker/Dockerfile.humble`, `docker/run_dev.sh`, `docker/entrypoint.sh`, `scripts/tc001_detect.sh` | Recriar pelo `run_dev.sh` ou pelo Dockerfile quando for usar |
| **Open_Source_Brick** | `nfc-brick-dev:latest` | `dev.sh` | Recriar pelo `dev.sh` quando for usar |
| **FlyHub** (caminho do repositório a confirmar) | `flyhub-backend`, `flyhub-frontend`, `flyhub-docs`, o devcontainer `vsc-fly_hub_system-front_end-...` | Compose ou Dockerfiles do FlyHub; o devcontainer o VS Code recria | Recriar quando for usar |
| **Dono a identificar** | `cyclone-010-emitter:local`, `unitree-sdk-pc:latest`, `eptest:latest` | Não encontrada em Dockerfile, compose, `.sh` ou Makefile dos repositórios | Se o seu projeto usa alguma delas, ache a receita (seção 5, passo 1). Se ninguém usar, não recrie |
| **Projeto que use a stack do FZI** | `ids-git.fzi.de:5555/ret/core_stack/fzi-ret-stack/fzi-ret-devel:kilted` | Registro privado do FZI | Baixar de novo exige credenciais do FZI. Se não houver acesso, avise o usuário |
| **Qualquer projeto** | Imagens públicas: `ros:humble-ros-base`, `ros:foxy-ros-base`, `nvidia/cuda:12.4.0-base-ubuntu22.04`, `rust:1.97.1-bookworm`, `gcc:13`, `node:22-bookworm`, `python:3.11-slim`, `python:3.12-slim-bookworm`, `alpine:3.20`, `alpine:latest`, `ubuntu:latest`, `caddy:2`, `ghcr.io/astral-sh/uv:latest`, `rhysd/actionlint`, `mcr.microsoft.com/devcontainers/java:17-bookworm`, `hello-world` | Registros públicos | Baixadas automaticamente no próximo build. Nenhuma ação |

**Imagens que continuam no disco:** as usadas por algum dos 27 containers, inclusive os parados. Se o container do seu projeto ainda existe, a imagem dele está intacta.

## 5. Procedimento padrão para qualquer projeto

1. **Descubra quais imagens o seu projeto usa** e se elas ainda existem:
   ```bash
   # nomes de imagem citados no projeto
   grep -rhoE "image:\s*\S+|-t\s+\S+|FROM\s+\S+" --include="Dockerfile*" --include="*compose*.y*ml" --include="*.sh" --include="Makefile" . | sort -u
   # o que existe hoje
   docker image ls
   ```
2. **Só recrie o que for usar agora.** Recriar antecipadamente ocupa disco à toa.
3. **Antes de recriar,** siga a regra 7.1 (medir o espaço) e a 7.2 (trava de tarefa pesada).
4. **Recrie pela receita do próprio projeto** (`docker compose build`, `docker build -t <nome> ...` ou o script `dev.sh` / `run_dev.sh`). Imagens que vêm de registro voltam com `docker pull`.
5. **Teste o mínimo** para confirmar que a imagem funciona: subir o container e rodar o comando ou teste principal.
6. **Se a receita depender de algo que não existe mais** (um arquivo baixado, uma credencial, um registro privado), pare e avise o usuário. Não improvise uma substituta.

## 6. Ações específicas: Painel e Leitor

### 6.1 Agente do Painel de Estudos

**Estado:**
- etapas 1 a 3 com commit local;
- etapa 4 pronta nos arquivos, **sem commit**;
- nada enviado ao `main`.

**Testes até agora:**
- a API passa inteira (118 testes) e o vitest também (40);
- os E2E novos passam em Chromium e WebKit;
- a suíte completa do Playwright ainda não rodou.

**O que fazer:**
1. **Faça agora o commit local da etapa 4.**
2. **Configure o Playwright para gravar só nas falhas:** `video: 'retain-on-failure'`, `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`. Apague `test-results/` e `playwright-report/` antigos.
3. **Recrie as imagens `painel-*-test`** só quando for rodar os testes que dependem delas.
4. **Antes da suíte completa,** siga as regras 7.1 e 7.2.
5. **Com a suíte verde,** envie as etapas 1 a 4 e siga para a etapa 5.
6. **Informe ao usuário** onde fica o backup automático da migração 0011 no banco real e como restaurá-lo.

### 6.2 Agente do Leitor

**Estado:**
- a correção "C++ não roda como root" está pronta, sem commit;
- o `rustfmt` reformatou arquivos fora do escopo, inclusive alguns da Fase 6;
- o clippy acusa um erro no código da Fase 6, que ainda está em andamento;
- o volume de build tem cerca de 55 GB de sobras.

**O que fazer:**
1. **Informe o que você apagou** entre 13h42 e 13h46. O espaço livre subiu cerca de 17 GB além da limpeza do usuário.
2. **Coloque a correção do C++ num commit próprio** (`git add -p`), separado da Fase 6.
3. **Desfaça a formatação do `rustfmt` nos arquivos fora do escopo.** Se quiser formatar o projeto inteiro, faça isso num commit separado depois da Fase 6.
4. **Recrie `leitor-runner-dev` e `leitor-ankisync-dev`** antes de testar o runner e o Anki sync.
5. **Confirme que o CI continua executando C++ de verdade** em algum passo como usuário comum, ou com runner configurado. Rodando como root, tudo vira "Não verificável", e essa cobertura se perde sem ninguém perceber.
6. **Depois do commit da Fase 6,** apague o volume de build (cerca de 55 GB). Liste antes o que vai remover e remova só o que é do Leitor.

## 7. Regras desta máquina (valem para todos os projetos)

1. **Medir antes de tarefas pesadas.** Antes de `docker build` ou `pull` grande, `cargo build --release`, a suíte E2E completa, migrações ou downloads grandes, rode como usuário comum:
   ```bash
   df -h --output=avail / | tail -1
   ```
   Se houver **menos de 25 GB**, não comece e avise o usuário. Reporte sempre esse número, nunca o visto como root.
2. **Uma tarefa pesada por vez na máquina.** Antes de começar:
   ```bash
   [ -e ~/.agent-heavy.lock ] && cat ~/.agent-heavy.lock   # se existir, espere ou avise o usuário
   echo "<projeto> $(date -Is) <tarefa>" > ~/.agent-heavy.lock
   ```
   Ao terminar, **inclusive se a tarefa falhar**, rode `rm -f ~/.agent-heavy.lock`.
3. **Limpe o que você criou:** volumes temporários, containers de teste parados, `test-results/` e artefatos de build que não serão reutilizados. Use nomes com o prefixo do projeto (`painel-*`, `leitor-*`, `go2-*` etc.).
4. **Não apague o que não é seu.** Itens de outro projeto: liste e pergunte ao usuário.
5. **Proibido sem aprovação do usuário:**
   - `docker volume prune`, `docker system prune`, `docker container prune` (volumes e containers parados podem guardar dados);
   - `rm -rf` fora da pasta do seu projeto.
6. **Escopo:** não rode formatadores ou ferramentas de reescrita no projeto inteiro sem pedir. Faça mudanças de formatação em commits separados.

## 8. Relatório ao terminar

Responda ao usuário neste formato, curto:

```
Projeto: <nome>
Imagens recriadas: <lista ou "nenhuma">
Imagens que não consegui recriar: <lista + motivo, ou "nenhuma">
Espaço disponível antes / depois (usuário comum): <X GB> / <Y GB>
O que eu criei e limpei: <lista>
Pendências: <lista>
```
