# Servidor de sincronização no H110

Sincronização do Leitor entre PCs (Fase 9a, `docs/planos/fase-9a.md`): servidor de sync do Anki (oficial, 26.9.3),
servidor da biblioteca (`server/library-sync`), Caddy interno e um cloudflared com o túnel **novo "leitor"**.
Nenhuma porta aberta no H110: a única entrada é o túnel. Nada aqui mexe no Painel (`/opt/painel`), no túnel
"painel", no LibreChat nem no `cloudflared.service` do sistema.

| Endereço | Vai para |
|---|---|
| `https://anki.jmetrimirandai.com` | servidor de sync do Anki (usuário e senha do Anki) |
| `https://leitor-sync.jmetrimirandai.com` | servidor da biblioteca (login do aparelho → token próprio, revogável) |

Segredos só no `.env` desta pasta (permissão 600) e no chaveiro do sistema do app. Nunca no repositório, em log,
no terminal ou no chat: o `set-secret.sh` lê o valor sem mostrar.

## 1. Pasta e repositório (comandos com `sudo`: você roda)

```bash
sudo mkdir -p /opt/leitor-sync
sudo chown jorgemetri:jorgemetri /opt/leitor-sync
git clone https://github.com/jmetrimiranda/Pdf_Anki.git /opt/leitor-sync
cd /opt/leitor-sync/infra/sync-server
docker ps >/dev/null && echo "docker ok"   # precisa funcionar sem sudo (grupo docker), como no Painel
```

## 2. `.env` e senhas

```bash
cd /opt/leitor-sync/infra/sync-server
cp .env.example .env
chmod 600 .env
nano .env                       # só se quiser mudar ANKI_SYNC_USER, LIBRARY_SYNC_USER ou os hostnames
./set-secret.sh ANKI_SYNC_PASSWORD
./set-secret.sh LIBRARY_SYNC_PASSWORD
```

As duas senhas: pelo menos 12 caracteres, sem espaço, `$`, `#`, aspas ou barra invertida. A do Anki é a que você
vai digitar no Leitor e no Anki/AnkiMobile; a da biblioteca, só no Leitor (cada aparelho recebe um token próprio).

## 3. Cloudflare: túnel "leitor"

No painel da Cloudflare (Zero Trust):

1. **Networks → Tunnels → Create a tunnel** → tipo **Cloudflared** → nome **`leitor`** → **Save tunnel**.
2. Na tela "Install and run a connector", escolha **Docker**. O comando mostrado termina em `--token <TOKEN>`.
   **Não rode esse comando.** Copie só o token (o texto longo depois de `--token`) e, no H110:

   ```bash
   cd /opt/leitor-sync/infra/sync-server
   ./set-secret.sh CLOUDFLARE_TUNNEL_TOKEN     # cole quando pedir; não aparece na tela
   ```

   Não cole o token em nenhum outro lugar (nem no chat).
3. **Next → Public hostnames** (rotas publicadas). Crie duas:

   | Subdomain | Domain | Path | Service |
   |---|---|---|---|
   | `anki` | `jmetrimirandai.com` | (vazio) | **HTTP** `caddy` |
   | `leitor-sync` | `jmetrimirandai.com` | (vazio) | **HTTP** `caddy` |

   Sem porta (`caddy` = porta 80 do Caddy interno, que separa pelo hostname).
4. **Sem Cloudflare Access** nesses dois hostnames (o Anki e o app não fazem login por e-mail). Se houver uma
   aplicação do Access que cubra `*.jmetrimirandai.com`, ela precisa deixar esses dois de fora.

## 4. Subir

```bash
cd /opt/leitor-sync/infra/sync-server
./deploy.sh            # constrói, sobe, confere a saúde; se falhar, volta sozinho para a versão anterior
./deploy.sh saude      # a qualquer momento
curl -fsS https://leitor-sync.jmetrimirandai.com/v1/health && echo
curl -fsS -o /dev/null -w '%{http_code}\n' https://anki.jmetrimirandai.com/health
```

Se a saúde interna passa mas os endereços públicos dão 404, a rota não está mandando o hostname: na rota, em
**Additional application settings → HTTP Settings → HTTP Host Header**, ponha o próprio hostname
(`anki.jmetrimirandai.com` / `leitor-sync.jmetrimirandai.com`).

## 5. Atualizar e voltar

```bash
cd /opt/leitor-sync && git pull && cd infra/sync-server && ./deploy.sh
./deploy.sh versoes    # versões publicadas
./deploy.sh voltar     # volta para a anterior, sem recompilar
```

Os dados ficam nos volumes `leitor-sync_ankisync-data` e `leitor-sync_library-data`: deploy e volta não mexem
neles.

## 6. Aparelhos da biblioteca

```bash
cd /opt/leitor-sync/infra/sync-server
docker compose exec library-sync library-sync device list            # nomes, datas, ativos/revogados (sem tokens)
docker compose exec library-sync library-sync device revoke "PC sala" # desconecta esse aparelho
```

Trocar a senha da biblioteca não derruba os aparelhos já conectados (cada um tem seu token); para isso, revogue.

## 7. Limites

- Cloudflare aceita até 100 MB por requisição. O Leitor envia livros em partes de 32 MB e baixa em partes, então
  livros grandes passam. O envio **completo** da coleção do Anki é uma requisição só: acima de ~95 MB o app recusa
  com uma mensagem clara (o sync normal e o de mídia vão em partes pequenas e não têm esse problema).
- Arquivos de livros apagados saem do servidor depois de 30 dias; as lápides, depois de 90 dias.
