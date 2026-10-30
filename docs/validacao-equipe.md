# Atendimento de equipes: sincronização, fila e concorrência

O servidor persistente atende as consultas enquanto a IA aguarda um provedor externo. Os webhooks de texto são confirmados após gravar a mensagem e seu trabalho na fila SQLite; três executores processam os trabalhos em segundo plano. Cada conversa tem no máximo um trabalho em processamento. Mensagens pendentes mais antigas são consolidadas quando outra mensagem do mesmo cliente já chegou, usando o histórico completo para a resposta.

## Comportamento da equipe

- Conversas e confirmações de entrega são consultadas a cada 2 segundos enquanto a aba está visível. Rascunho, foco, seleção, busca e rolagem do histórico são preservados.
- O QR Code pode ser fechado e reaberto sem recarregar a página e é renovado automaticamente enquanto aguarda leitura.
- Cards do funil são sincronizados automaticamente. Dashboard, contatos e tarefas internas são consultados periodicamente. Diálogos abertos, digitação e arraste suspendem a repintura dessas telas até a interação terminar.
- O pedido de transferência da IA aparece como **Aguardando atendimento humano**, no filtro **Aguardando equipe**, no sino e em um aviso na tela. Abrir a conversa não equivale a assumir.
- Assumir reserva a conversa para um atendente. Um segundo atendente recebe conflito, em vez de assumir silenciosamente. Uma resposta de outro atendente também é recusada enquanto o primeiro mantém o atendimento humano.
- Uma resposta humana enviada pelo CRM pausa a IA por **60 segundos contados após o envio**. Outra resposta humana reinicia o prazo. A pausa e as mensagens pendentes persistem se o processo reiniciar. Ao terminar o minuto, a IA atende mensagens pendentes; se não houver mensagem pendente, aguarda o cliente, sem enviar uma mensagem espontânea.
- Uma resposta da IA ainda em geração é descartada se alguém assumir/responder antes de seu envio. Uma alteração humana no card durante a geração também é preservada.
- Cada alteração de oportunidade incrementa uma revisão. A interface envia a revisão que o atendente viu; uma edição antiga recebe HTTP 409 e não substitui a mudança anterior.
- Falhas de envio com resultado incerto e trabalhos interrompidos não são reenviados automaticamente; são encaminhados para conferência humana. Falhas explicitamente recuperáveis têm tentativas limitadas e espera progressiva.

O controle de pausa acima considera respostas enviadas **pelo CRM**. Mensagens enviadas diretamente no aplicativo WhatsApp pelo número vinculado ainda são ignoradas pelo conector para não confundir ecos das mensagens automáticas com respostas humanas.

## Verificação reproduzível

Requer Node.js 24 e `npm ci`. Execute os testes abaixo sequencialmente, pois os cenários HTTP usam a porta local 3211.

```sh
npm test
npm run test:team
npm run test:queue
```

- `test:team`: 10 usuários distintos, 450 leituras autenticadas, disputa de 10 alterações do mesmo card, disputa de atendimento e bloqueio de resposta por um segundo atendente.
- `test:queue`: provedor fictício com resposta lenta, cinco conversas simultâneas, webhooks duplicados, limite de três gerações paralelas, consultas durante a geração, reinício do servidor e espera real de um minuto antes da retomada.
- Os testes criam bancos e senhas temporários próprios. Não usam a chave Groq, não conectam um WhatsApp real e não enviam mensagens a clientes.
- Os relatórios ficam em `reports/qa/`, fora do Git. Os bancos e logs isolados ficam em pastas `atenva-qa-*` do diretório temporário do sistema para diagnóstico.

O teste visual adicional usa Playwright. Para prepará-lo sem alterar as dependências versionadas:

```sh
npm install --no-save --package-lock=false playwright@1.64.1
npx playwright install chromium
npm run test:browser
```

Também é possível usar um navegador existente por `ATENVA_QA_BROWSER_PATH` e um módulo Playwright já instalado por `ATENVA_PLAYWRIGHT_MODULE`. O teste verifica mensagens sem recarregar, rascunho/foco/seleção, filtros, espera humana, reconexão, rolagem do histórico e movimento automático de cards.

## Limites da validação

Os resultados são de testes locais controlados. Não representam teste prolongado com dez pessoas, dispositivos reais e tráfego real de clientes. Antes de liberar a um cliente, ainda é necessário ensaio operacional com a equipe, recuperação de backup, desconexão/reconexão do WhatsApp, monitoramento e verificação da infraestrutura escolhida.

A fila em segundo plano e a pausa com precisão aproximada de um segundo exigem um **processo persistente** com disco durável. Em Vercel, o código mantém o processamento de webhook na requisição e depende do executor agendado; timers em segundo plano não são usados. O modo de snapshot remoto mantém a reserva distribuída e a serialização para proteger o banco, portanto não recebe a mesma garantia de latência deste teste local. Não se deve extrapolar os resultados para esse modelo de hospedagem sem testar ou migrar a persistência e o trabalhador da fila.

SQLite neste modo pressupõe um único processo do CRM controlando a fila. Várias réplicas independentes precisam de coordenação de trabalhadores e um banco compartilhado apropriado. A conexão Evolution deve permanecer protegida por chave, e os volumes do banco e das instâncias devem ser incluídos no backup.
