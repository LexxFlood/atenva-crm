# Verde CRM

MVP funcional de um CRM WhatsApp-first com agente comercial autónomo, caixa de entrada compartilhada, pipeline, contactos, base de conhecimento e supervisão humana.

## Executar

Requisito: Node.js 24.x. Instale as dependências com `npm ci`.

No Windows, abra `INICIAR.cmd`. Alternativamente:

```powershell
node server.js
```

Depois acesse [http://localhost:3210](http://localhost:3210). O banco e os dados de demonstração são criados automaticamente.

Credenciais locais de demonstração:

```text
E-mail: ana@verdecrm.local
Senha:  VerdeDemo!2026
```

Esta senha é aceita somente como padrão de desenvolvimento. Em produção, o servidor exige `ADMIN_PASSWORD` e `SESSION_SECRET` exclusivos.

## O que já funciona

- Dashboard personalizável por período, com indicadores, gráficos de conversas e funil.
- Caixa de entrada com mensagens, prioridades, filtros e troca entre IA e humano.
- Múltiplos pipelines Kanban, ganhos, perdas com motivo e transferência automática para Clientes.
- Contactos, pontuação comercial, tags e contexto completo.
- Agenda de tarefas por responsável e criação de tarefas diretamente no chat.
- Deduplicação de contatos por telefone/WhatsApp ID.
- Resumo de IA por contato e automação de etapas do lead.
- Qualificação configurável de Lead, MQL e SQL por pontuação, dados obrigatórios e etapa do Kanban.
- Base de conhecimento pesquisável usada pelo agente.
- Níveis de autonomia: desligado, copiloto, autonomia segura e elevada.
- Classificação de intenção, resposta, qualificação, tarefas e handoff.
- Histórico de execuções e ferramentas utilizadas pela IA.
- Webhook oficial da WhatsApp Cloud API com validação de assinatura.
- Envio real pela Graph API quando as credenciais estão configuradas.
- Área WhatsApp & Meta com status da conexão, webhook e relatório de entrega/leitura/custos.
- Tutorial guiado dentro do CRM, com capítulos e links oficiais para concluir a conexão da Meta.
- Simulação completa sem WhatsApp ou modelo externo.
- Login, sessões seguras, permissões, CSRF, rate limiting e auditoria.

## Ligar ao WhatsApp oficial

1. Configure uma vez o aplicativo central da Atenva em [Meta for Developers](https://developers.facebook.com/) com WhatsApp, Facebook Login for Business e Embedded Signup.
2. Defina `META_APP_ID`, `META_APP_SECRET`, `META_MARKETING_LOGIN_CONFIG_ID` e `META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` na Vercel. As configurações de Marketing e WhatsApp precisam ser diferentes.
3. Configure o webhook do aplicativo como `https://seu-dominio/api/webhooks/whatsapp` e use o `WHATSAPP_VERIFY_TOKEN` do servidor.
4. Cada cliente abre **Integrações → WhatsApp oficial** e clica em **Entrar com Facebook**.
5. O cliente escolhe a empresa, a WABA e o número. A Atenva troca o código temporário, valida o vínculo, registra o número, ativa a verificação em duas etapas e assina o webhook automaticamente.

O formulário manual continua disponível em **Configuração avançada manual** apenas para suporte e migrações.

Variáveis necessárias:

```text
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_API_VERSION=v23.0
META_APP_ID=
META_APP_SECRET=
META_MARKETING_LOGIN_CONFIG_ID=
META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=
```

Sem uma conexão validada, os envios são bloqueados. Para testes locais, ative explicitamente `WHATSAPP_SIMULATE=true`: as mensagens aparecem como **Simulação**, sem entrega real. Essa opção não funciona em produção. O arquivo `.env` é carregado automaticamente quando o servidor inicia.
As credenciais salvas pela interface são cifradas antes de serem gravadas no banco. Em produção, defina também `INTEGRATION_ENCRYPTION_KEY` com um segredo exclusivo.

## Ligar a um modelo de IA

Consulte [operação de WhatsApp e qualificação](docs/WHATSAPP-IA-OPERACAO.md) para configurar os critérios comerciais, acompanhamentos, executor e roteiro de homologação.

Em produção na Vercel, o agente usa o AI Gateway com o token OIDC injetado automaticamente e o modelo definido em `AI_GATEWAY_MODEL` (padrão: `openai/gpt-5.4-mini`). Fora da Vercel, configure uma chave do Gateway:

```text
AI_GATEWAY_API_KEY=
AI_GATEWAY_MODEL=openai/gpt-5.4-mini
```

Como alternativa, também é possível usar um endpoint compatível com Chat Completions:

```text
AI_API_URL=
AI_API_KEY=
AI_MODEL=
```

O modelo só recebe o resumo do CRM, as mensagens recentes e os trechos aprovados da base de conhecimento. As ações comerciais continuam controladas pelo servidor.
Se o provedor estiver indisponível, o motor local de contingência responde sem indicar falsamente que regras evolutivas foram aplicadas.

## Como a autonomia é controlada

O agente nunca recebe acesso irrestrito ao banco. Cada decisão chama ferramentas limitadas e auditáveis:

1. classificar a intenção;
2. consultar conhecimento aprovado;
3. criar ou atualizar a oportunidade;
4. atualizar a pontuação do lead;
5. criar tarefa de acompanhamento;
6. responder ou transferir para humano.

Pedidos de atendente, reclamações, descontos e baixa confiança provocam handoff. No modo copiloto, a resposta é guardada como sugestão interna e não é enviada ao cliente.

## Estrutura

```text
public/              dashboard web
src/schema.sql       modelo completo do banco
src/db.js            acesso ao SQLite
src/agent.js         motor do agente e ferramentas
src/api.js           API do CRM e ingestão de mensagens
src/whatsapp.js      Cloud API, assinatura e normalização
src/seed.js          dados de demonstração
server.js            servidor HTTP e arquivos da dashboard
test/                testes automatizados
```

## Testes

```powershell
npm test
npm run test:team
npm run test:queue
```

Os testes de equipe usam 10 sessões autenticadas e dados fictícios. Consulte [`docs/validacao-equipe.md`](docs/validacao-equipe.md) para os testes de navegador, retomada após 60 segundos, fila persistente e limites da validação local.

## Antes de produção

Para os primeiros pilotos, use uma instância isolada por cliente. Antes de transformar o produto em SaaS compartilhado, implemente isolamento por organização, PostgreSQL, fila persistente, MFA, cofre de segredos, backups testados, retenção e exclusão de dados, monitorização, limites de custo e revisão de LGPD.

Consulte:

- [`docs/SECURITY.md`](docs/SECURITY.md) — vulnerabilidades, correções e riscos residuais.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — instalação profissional por cliente.
- [`docs/CLIENT-HANDOFF.md`](docs/CLIENT-HANDOFF.md) — checklist de onboarding e go-live.
- [`docs/validacao-equipe.md`](docs/validacao-equipe.md) — sincronização, fila, disputa de atendimento e proteção de cards.
