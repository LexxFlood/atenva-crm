# Contexto e memória da Clara

A memória usa o SQLite existente, na tabela `conversation_memory`. Cada registro pertence a uma empresa e a uma conversa, com declarações do cliente e os IDs das mensagens de origem, última pergunta e última resposta enviada. Declarações são dados atribuídos ao cliente, não fatos comprovados. A exclusão da conversa remove sua memória por chave estrangeira.

O agente recupera conhecimento ativo somente da empresa da conversa. A busca usa a pergunta atual, a pergunta anterior e o contexto recente, dando maior peso à solicitação atual. Informações antigas continuam disponíveis numa memória limitada, mesmo quando saem da janela de mensagens enviada ao modelo.

Datas SQL e ISO são ordenadas como datas e retornadas em UTC no histórico da API. Uma resposta enviada depois da entrada do cliente também fica disponível no contexto, evitando que a IA ignore sua própria resposta anterior.

O roteiro orienta a Clara a responder primeiro à dúvida, apresentar-se somente no início, acompanhar correções de assunto e fazer uma pergunta por vez. Uma pergunta de esclarecimento pode continuar o atendimento mesmo abaixo do limiar de confiança, desde que o modelo não tenha indicado um motivo de transferência. Pedidos explícitos de humano e regras de segurança continuam preservados.

Perguntas curtas idênticas à anterior também são bloqueadas, salvo quando o cliente pede repetição. Perguntar novamente nome, empresa ou e-mail já registrados, mesmo com outras palavras, e apenas ecoar o dado do cliente também provoca reformulação. A fila agenda uma reformulação, sem desligar a IA nem reenviar a frase duplicada. Há no máximo três tentativas por mensagem; somente uma falha persistente exige revisão humana.

Respostas diretas a uma única pergunta de nome, empresa ou e-mail são registradas antes da geração, com mensagem de origem e evidência literal. Assim, responder apenas o nome da empresa já atualiza o contexto da próxima resposta. Perguntas, recusas, cumprimentos e respostas a várias perguntas simultâneas não são interpretados como um nome. O modo copiloto continua sem alterar o cadastro automaticamente.

Um limite temporário HTTP 429 do provedor também mantém a mensagem na fila e respeita o prazo de nova tentativa informado. Não ativa plano pago nem aumenta o limite local de chamadas. Erros de configuração e respostas inválidas continuam sendo sinalizados para revisão.

Para organizar uma base existente sem gerar respostas:

```sh
node scripts/backfill-conversation-memory.mjs
node scripts/backfill-conversation-memory.mjs --apply
```

Use `DATABASE_PATH` para selecionar o banco correto. O primeiro comando só informa a quantidade elegível; o segundo grava a memória. Nenhum deles chama o modelo ou envia mensagens.

## Verificação

```sh
node --test test/conversation-context.test.js
```

Os cenários cobrem datas misturadas, resposta posterior à entrada, retenção de contexto, isolamento por empresa, conhecimento ativo, diálogo de três turnos, resposta curta com empresa, perguntas respondidas com outras palavras, ecos e preservação do modo copiloto. Usam um provedor simulado: validam contexto, integração e regras, mas não comprovam a qualidade generativa do Groq.

Na avaliação real, converse com a Clara perguntando pelos produtos, informando um ambiente, corrigindo esse ambiente e respondendo à pergunta anterior. Ela deve acompanhar a correção, usar o catálogo aprovado e não pedir novamente um dado já informado. No notebook, a comparação com dados fictícios detectou repetição e eco no GPT OSS 20B e aprovou explicação do termo técnico e continuidade após nome de empresa no GPT OSS 120B. O inicializador local usa o 120B, disponível no Free, preservando limite de chamadas e de saída. A configuração do modelo em outros ambientes depende de AI_MODEL. Nenhum documento comercial foi modificado.
