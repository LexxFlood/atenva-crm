# WhatsApp, atendimento e qualificação

## Comportamento

Uma mensagem recebida é identificada pela empresa e pelo ID do provedor, gravada e incluída na fila persistente. O agente considera as últimas 20 mensagens públicas, a ficha do contato, regras aprovadas e base de conhecimento da empresa. Notas internas não entram no histórico enviado ao modelo.

A IA propõe respostas, dados comerciais e uma etapa. O servidor valida os dados e a evidência literal na mensagem do cliente antes de gravar. Empresa, e-mail, nome, segmento e localização ficam na ficha; necessidade, orçamento, prazo e participação na decisão ficam em `custom_fields.commercial`, com mensagem de origem e evidência. O histórico registra a coleta. Isso valida formato e origem declarada; não comprova identidade, existência da empresa, poder de decisão ou capacidade financeira.

O score deriva dos dados registrados: repetir perguntas não aumenta a pontuação. Os campos obrigatórios para MQL e os campos adicionais para SQL são configuráveis em **Insights**. A classificação continua sendo recalculada com a movimentação automática desligada. Etapas não configuradas e etapas de outros funis não satisfazem critérios por acidente.

Cards só avançam dentro do funil comercial da empresa, para etapas visíveis e abertas. Os critérios obrigatórios e a opção de movimentação são respeitados. Frases negativas não provocam avanço. Etapas de demonstração/reunião exigem compromisso futuro sincronizado com Google Agenda. Não há fechamento automático de venda ou regressão de cards. O motivo da movimentação fica registrado.

No modo copiloto, o agente gera uma sugestão interna e não altera ficha, pontuação ou etapa nem envia resposta ao cliente. Pedidos de humano, reclamações, descontos, baixa confiança e mídias não interpretadas são encaminhados à equipe. A IA nunca confirma agenda sem uma ferramenta de agendamento.

## Conexão e envios

1. Configure o aplicativo Meta, Embedded Signup, credenciais centrais, assinatura do webhook e HTTPS conforme o README.
2. Em cada empresa, conecte e valide o WhatsApp oficial e sincronize os modelos aprovados.
3. Revise a base de conhecimento, os critérios de qualificação e o nível de autonomia. Comece pelo modo copiloto.
4. Envie uma mensagem por um aparelho externo e confirme recebimento, empresa correta, resposta, entrega e leitura.

Ausência de conexão produz erro, nunca sucesso simulado silencioso. Simulação só é permitida explicitamente fora de produção e aparece como **Simulação** no chat. Envio aceito pelo provedor, entrega e leitura são estados diferentes.

Texto livre respeita a janela registrada a partir da mensagem recebida. Fora dela, selecione um modelo aprovado. O agendador permite preencher variáveis de corpo, uma por linha, na ordem do modelo. Mídias/cabeçalhos interativos de modelos não são preenchidos por esse formulário. Novos contatos entram com consentimento desconhecido; não se presume autorização de marketing só porque enviaram uma mensagem. Recusas explícitas bloqueiam novos envios.

Áudio usa transcrição opcional, configurada por `TRANSCRIPTION_API_URL`, `TRANSCRIPTION_API_KEY` e `TRANSCRIPTION_MODEL`. Sem configuração ou em caso de falha, a conversa vai para humano sem inventar o conteúdo. Gravação pelo navegador utiliza MP4 ou OGG quando suportado. Evolution continua disponível como integração legada, com confirmação do ID retornado pelo provedor.

Para teste por QR Code, configure `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_SECRET` e um nome de instância próprio. A tela Integrações exibe o cartão de QR somente quando essa infraestrutura está configurada. Se o CRM estiver no Windows e o Evolution no Docker Desktop, use `EVOLUTION_WEBHOOK_BASE_URL=http://host.docker.internal:3210` e permita que o serviço local seja alcançado pelo container. Esse endereço é usado apenas para o callback; `PUBLIC_URL` pode continuar como `http://localhost:3210`. O status da aplicação também acompanha a conexão Evolution, sem exigir credenciais Meta.

## Acompanhamentos com a tela fechada

O servidor disponibiliza `GET /api/cron/scheduled-messages`, protegido por `Authorization: Bearer CRON_SECRET`. O executor processa mensagens agendadas, a fila de atendimento e cadências em lotes limitados. O último acionamento independente do navegador aparece em **Agente → Acompanhamentos**.

Escolha um executor:

- **Servidor próprio já disponível:** defina `CRON_PUBLIC_URL` e `CRON_SECRET` e mantenha `npm run automations` supervisionado pelo serviço do sistema. O comando não instala nem contrata infraestrutura.
- **GitHub Actions:** configure os secrets `CRON_PUBLIC_URL` (URL HTTPS pública do CRM) e `CRON_SECRET` (o mesmo segredo do servidor). Execute manualmente o workflow para validar. Para habilitar a agenda, defina a variável do repositório `CRM_AUTOMATIONS_ENABLED=true`. A agenda está desabilitada por padrão. Considere a cota e o faturamento de minutos do GitHub antes de ativá-la. A frequência nominal é de cinco minutos, sem garantia de pontualidade.
- **Vercel:** o `vercel.json` inclui acionamento diário às 12:00 UTC, compatível com Hobby. Para acompanhamento em minutos, use o executor próprio, GitHub Actions ou um plano que permita cron mais frequente. Não altere o plano automaticamente. Consulte a documentação atual: https://vercel.com/docs/cron-jobs/usage-and-pricing.

Em **Agente → Configuração do WhatsApp**, habilite o acompanhamento, defina intervalos, limite de tentativas e horário comercial. Sem um modelo aprovado sem variáveis, o agente cria apenas uma tarefa para a equipe. O disparo automático exige consentimento registrado. Uma resposta do contato cancela as retomadas automáticas pendentes da conversa.

## Falhas e repetição

Mensagens e etapas de cadência são reservadas antes do envio e a reserva é persistida no snapshot. Duas execuções concorrentes não devem processar a mesma reserva. Falhas temporárias confirmadas no envio de texto (429/5xx) têm até três tentativas com espera progressiva; resultados de rede desconhecidos exigem revisão. O provedor não oferece uma transação conjunta com o banco: não se promete entrega exatamente uma vez em toda falha possível.

Uma execução interrompida vai para revisão após dez minutos. Em **Agente → Precisam de revisão**, confira o histórico no WhatsApp antes de autorizar uma nova tentativa. Só administradores e gestores podem autorizar; a decisão fica auditada. Não reenviar se o provedor já entregou. Cadências que falham ficam identificadas para revisão; não são repetidas cegamente.

As migrações SQLite são automáticas e idempotentes, inclusive quando uma instância recarrega um snapshot antigo. Faça backup antes da publicação. A correção de sessões invalida cookies sem sessão válida no banco, inclusive após logout; sessões antigas podem exigir novo login.

## IA e controle de consumo

O provedor padrão continua sendo o já configurado no ambiente. Para um endpoint compatível, use `AI_API_URL`, `AI_API_KEY` e `AI_MODEL`. Não confunda a chave de um endpoint personalizado com o token do AI Gateway. `AI_MAX_OUTPUT_TOKENS` limita cada resposta, com padrão de 1200 e teto de 2000. Cada chamada tem timeout e não existe repetição automática de geração após erro do modelo.

Para modelos GPT OSS no endpoint Groq, as respostas comerciais usam esquema JSON estrito e esforço de raciocínio baixo. Essa adaptação foi validada por testes de contrato; os testes reais iniciais identificaram falhas do modo JSON simples antes da adaptação. A mudança final de formato precisa de nova homologação real com orçamento autorizado. Nunca inclua chaves no front-end, nos testes versionados, em URLs ou nos relatórios.

Os testes automáticos locais usam respostas controladas e não consomem APIs. Para um teste real, use chave exclusiva temporária, dados fictícios, limite de chamadas e tokens, sem loops de repetição. Confirme o plano gratuito antes de exigir ausência de cobrança; em plano pago, defina limites de gasto no provedor. Limite de tokens por chamada não é um limite financeiro global. Revogue chaves compartilhadas em chats.

## Roteiro de homologação

1. Rodar `npm ci` e `npm test` em Node 24.
2. Validar login, logout, gravação das regras de Insights e configuração do agente.
3. Conectar uma empresa de teste à Meta e enviar mensagem pelo aparelho externo.
4. Informar os dados em várias mensagens, incluindo correção de e-mail e respostas curtas. Conferir fonte e ficha.
5. Conferir MQL/SQL, score, histórico e avanço; repetir com movimentação desligada e em copiloto.
6. Testar pedido de humano, negativa, baixa confiança, áudio, falha do modelo e recusa de mensagens.
7. Testar modelo aprovado fora da janela, variáveis e cancelamento após resposta.
8. Fechar o navegador e confirmar que o executor continua funcionando.
9. Simular erro temporário e execução interrompida; verificar que a interface orienta a revisão.

Conexão da Meta, disponibilidade do número, configuração dos segredos, ativação do executor e entrega real permanecem dependentes do ambiente. Testes locais não atestam esses serviços em produção.
