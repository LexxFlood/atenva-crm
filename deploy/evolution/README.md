# Evolution API da Atenva

Pacote de implantação preparado para a Evolution API `v2.3.7`, com PostgreSQL 15, Redis persistente e HTTPS automático pelo Caddy.

## Requisitos do servidor

- VPS Linux com endereço IPv4 público;
- Ubuntu 22.04/24.04 ou distribuição equivalente;
- Docker Engine com Docker Compose v2;
- pelo menos 2 vCPU, 4 GB de RAM e 30 GB de disco;
- portas TCP 80 e 443 e UDP 443 liberadas.

## DNS

No provedor do domínio `atenva.com.br`, crie:

| Tipo | Nome | Valor |
| --- | --- | --- |
| A | `evolution` | IP público do servidor |

Não prossiga até `evolution.atenva.com.br` resolver para o IP correto.

## Instalação

1. Copie esta pasta para o servidor.
2. Execute `chmod +x deploy.sh`.
3. Execute `./deploy.sh` uma vez para gerar o `.env` seguro.
4. Confira `EVOLUTION_DOMAIN=evolution.atenva.com.br` no `.env`.
5. Execute `./deploy.sh` novamente para baixar e iniciar os containers.
6. Teste `https://evolution.atenva.com.br/`.

O arquivo `.env` contém segredos e nunca deve ser enviado ao Git ou exposto no navegador.

## Ligação com a Vercel

Depois que o endereço HTTPS responder, configurar no projeto `atenva`:

```text
EVOLUTION_API_URL=https://evolution.atenva.com.br
EVOLUTION_API_KEY=<mesma chave do servidor>
EVOLUTION_INSTANCE_NAME=atenva-principal
EVOLUTION_WEBHOOK_SECRET=<segredo aleatório exclusivo>
```

Após novo deploy da Vercel, a página **WhatsApp & Meta** habilita o botão **Conectar WhatsApp**. Um clique cria a instância, configura o webhook e mostra o QR Code.

## Operação

```bash
docker compose ps
docker compose logs --tail=200 evolution
docker compose restart evolution
docker compose pull && docker compose up -d
```

Backups mínimos devem incluir os volumes `postgres_data`, `redis_data` e `evolution_instances`.
