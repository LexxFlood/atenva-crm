# Entrega profissional para clientes

## Modelo recomendado para os dois primeiros clientes

Use uma instalação isolada por cliente:

```text
Cliente A                    Cliente B
crm.a.com                    crm.b.com
container próprio           container próprio
banco/volume próprio        banco/volume próprio
segredos próprios           segredos próprios
número WhatsApp próprio     número WhatsApp próprio
backup próprio              backup próprio
```

Essa abordagem evita que um erro de programação exponha dados de um cliente ao outro e simplifica cancelamento, backup, personalização e cobrança.

## Forma comercial

Entregue como serviço gerenciado, não como uma pasta de código:

- taxa de configuração e onboarding;
- mensalidade da plataforma, suporte e hospedagem;
- custos variáveis da Meta e do modelo discriminados ou incluídos com franquia;
- horas adicionais para integrações e novos fluxos;
- prazo piloto de 30 dias com objetivos mensuráveis.

O cliente recebe um endereço HTTPS, credenciais individuais, formação curta, manual de uso, canais de suporte e relatório do piloto. Você mantém deploy, backups, atualizações e monitorização.

## Instalação

1. Duplique a pasta para uma área de deploy exclusiva do cliente.
2. Copie `.env.example` para `.env`.
3. Defina, no mínimo:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=3210
ADMIN_EMAIL=admin@cliente.com
ADMIN_PASSWORD=uma-senha-longa-e-exclusiva
SESSION_SECRET=um-segredo-aleatorio-de-no-minimo-32-bytes
TRUST_PROXY=true
WHATSAPP_VERIFY_TOKEN=valor-exclusivo
WHATSAPP_ACCESS_TOKEN=token-da-meta
WHATSAPP_PHONE_NUMBER_ID=id-do-numero
WHATSAPP_APP_SECRET=segredo-do-app-meta
AI_API_URL=endpoint-do-modelo
AI_API_KEY=segredo-do-modelo
AI_MODEL=modelo-escolhido
```

4. Construa e inicie:

```bash
docker compose up -d --build
docker compose ps
```

5. Coloque Caddy, Nginx ou o proxy da plataforma na frente do container. O exemplo `deploy/Caddyfile.example` emite HTTPS automaticamente quando DNS e portas estão corretos.
6. Acesse `/api/health` e confirme `status: ok`.
7. Configure na Meta o webhook `https://crm.cliente.com/api/webhooks/whatsapp`.
8. Faça testes de mensagem recebida, resposta, handoff e modelo fora da janela.

## Operação

- Backup cifrado diário, retenção de 30 dias e cópia fora do servidor.
- Teste de restauração mensal.
- Monitor de disponibilidade a cada minuto em `/api/health`.
- Alerta para container reiniciando, disco acima de 75%, falha da Meta e falha da IA.
- Atualização mensal planejada e correção urgente para incidentes críticos.
- Revisão semanal das respostas da IA durante o piloto.

## Onboarding do cliente

1. Definir objetivo: qualificação, suporte, marcação ou vendas.
2. Recolher FAQs, preços, políticas e exemplos de conversas boas.
3. Definir o que a IA pode executar e o que exige humano.
4. Configurar horários, vendedores, etapas e motivos de handoff.
5. Aprovar modelos oficiais do WhatsApp.
6. Testar pelo menos 20 cenários, incluindo perguntas adversariais.
7. Começar em copiloto por 3–5 dias.
8. Ativar autonomia segura apenas para intenções aprovadas.

## Evolução após os pilotos

Se os dois clientes validarem o produto, a próxima versão deve migrar para PostgreSQL, filas persistentes, armazenamento de arquivos, MFA, gestão de utilizadores, cobrança, observabilidade e um modelo multi-tenant com `organization_id` aplicado e testado em todas as consultas.
