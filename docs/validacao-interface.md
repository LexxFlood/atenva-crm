# Ajustes da interface e fotos de clientes

- O gráfico ampliado é redesenhado a partir dos dados, ocupa a altura disponível e mostra zero para dias sem mensagens. O tooltip fica fora da área de recorte do gráfico e é limitado às bordas da tela.
- Atividades recentes, contatos e conversas usam o avatar do cliente. As fotos são consultadas na Evolution e servidas por um endpoint autenticado do CRM, validando a empresa do contato. Nenhuma chave da Evolution é enviada ao navegador.
- O proxy aceita imagens somente nas CDNs autorizadas do WhatsApp/Meta, valida redirecionamentos e limita tamanho, tempo e concorrência. A resposta é mantida em cache. Quando o cliente não disponibiliza a foto, as iniciais continuam centralizadas.
- O formulário de automações usa rótulos, bordas, cores, foco e espaçamento dos controles da Atenva, nos temas claro e escuro e em telas menores.
- Os símbolos de conexão usam o ícone Meta de [Simple Icons](https://github.com/simple-icons/simple-icons/blob/develop/icons/meta.svg).
- Uma interrupção de rede é apresentada em português. Consultas de leitura têm uma nova tentativa curta; uma tela que não abriu por indisponibilidade retoma o carregamento automaticamente. Operações de envio não são repetidas por esse mecanismo.
- Quando a Evolution fornece o conteúdo original do QR, ele é gerado novamente com correção de erro alta e a marca Atenva no centro. O original é mantido como alternativa quando não há conteúdo suficiente para gerar uma imagem personalizada com segurança. A sessão atual não precisa ser desconectada para aplicar o visual às próximas conexões.

## Testes

```sh
npm test
npm run test:visual
```

O teste visual usa a mesma preparação Playwright descrita em `validacao-equipe.md`, banco isolado e fotos/QR fictícios. Verifica escala e tooltip do gráfico, avatares, formulário nos dois temas, recuperação de rede da tela do agente, símbolo Meta e QR personalizado. As capturas e o relatório ficam em `reports/qa`.

Os testes de unidade decodificam o QR personalizado em 512 e 320 pixels, verificam a restrição dos endereços de fotos e o limite de duas buscas simultâneas. Essa validação de leitura usa códigos fictícios e não desconecta um WhatsApp real.
