# Atenva — acessos e infraestrutura

Documento operacional para administradores da Atenva. Atualizado em 21 de outubro de 2026.

> **Segurança:** este arquivo pode permanecer no repositório porque não contém senhas, tokens, chaves privadas ou códigos de recuperação. Segredos devem ser entregues por um cofre de senhas e nunca por GitHub, WhatsApp, e-mail ou documentação em texto aberto.

## 1. Produção

| Item | Informação |
| --- | --- |
| Aplicação | <https://mais-tracao-atenva.vercel.app> |
| Health check | <https://mais-tracao-atenva.vercel.app/api/health> |
| Hospedagem | Vercel |
| Projeto Vercel | `mais-tracao-atenva` |
| ID do projeto | `prj_aWmkWsXeQYJnfbNkBIFOXrwO8EL8` |
| Time proprietário | `ATENVA` (`atenva1`) |
| ID do time | `team_xjKRY67rI7t3WySlyavgAlmy` |
| Plano atual | Hobby |
| E-mail principal | `atenvacrm@gmail.com` |
| Usuário Vercel | `danielhenrique-7602` |

### Como entrar na Vercel

1. Acesse <https://vercel.com/login>.
2. Entre com `atenvacrm@gmail.com` e confirme o código enviado por e-mail, ou use a conexão GitHub da conta `atenvacrm`.
3. Selecione o time **ATENVA**.
4. Abra o projeto **mais-tracao-atenva**.

O plano Hobby não permite convidar membros comuns do time. Para cada administrador ter login individual na Vercel, será necessário migrar para Pro. Enquanto permanecer no Hobby, o acesso administrativo depende da conta principal Atenva.

### Configurações críticas na Vercel

- **Deployments:** histórico, logs e promoção de versões.
- **Settings → Environment Variables:** credenciais e segredos da produção.
- **Settings → Git:** ligação com `atenvacrm/atenva-crm`, branch `main`.
- **Settings → Domains:** domínio próprio quando for adquirido.

Variáveis já cadastradas incluem administração, sessão, Supabase, Google, Meta, WhatsApp, IA e integração legada Evolution. Os valores classificados como `Secret` não podem ser recuperados em texto aberto; somente substituídos.

## 2. Código e GitHub

| Item | Informação |
| --- | --- |
| Repositório | <https://github.com/atenvacrm/atenva-crm> |
| Visibilidade | Privado |
| Branch de produção | `main` |
| Conta proprietária | `atenvacrm` |
| Administrador principal | `atenvacrm@gmail.com` |
| Colaborador | `LexxFlood` / `Albert7pereira@gmail.com` |
| Permissão do Albert | Escrita no repositório |

### Entrada

Cada administrador deve usar sua própria conta GitHub e autenticação em dois fatores. Não compartilhar a senha da conta `atenvacrm`.

Para conceder acesso: **Repository → Settings → Collaborators → Add people**. Para administração total do repositório, alterar a função do colaborador para **Admin** após validar a identidade e ativar 2FA.

O deploy de produção é automático quando uma alteração aprovada chega à branch `main`.

## 3. Google Cloud e Google Agenda

| Item | Informação |
| --- | --- |
| Console | <https://console.cloud.google.com/home/dashboard?project=atenva-agenda> |
| Projeto | `atenva-agenda` |
| Proprietário | `atenvacrm@gmail.com` (`roles/owner`) |
| Editor | `Albert7pereira@gmail.com` (`roles/editor`) |
| Cliente OAuth | `476134502759-oqs28rl35ljs26l5qri4fv7uu5qn6u2g.apps.googleusercontent.com` |
| Credenciais OAuth | <https://console.cloud.google.com/auth/clients?project=atenva-agenda> |
| Tela de consentimento | <https://console.cloud.google.com/auth/branding?project=atenva-agenda> |
| Usuários/testadores | <https://console.cloud.google.com/auth/audience?project=atenva-agenda> |

### Entrada e permissões

Cada administrador entra com sua própria conta Google. O proprietário concede acesso em **IAM e administrador → IAM**. Para gerir faturamento é necessária uma função de faturamento separada; `Editor` não concede essa permissão.

As variáveis `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_REDIRECT_URI` estão na Vercel. O segredo OAuth deve ser rotacionado no Google Cloud se houver suspeita de exposição.

## 4. Meta, WhatsApp oficial e Meta Ads

| Item | Informação |
| --- | --- |
| Meta for Developers | <https://developers.facebook.com/apps/1633796511785732/> |
| App ID | `1633796511785732` |
| Business ID usado na configuração | `447510021781980` |
| Configurações empresariais | <https://business.facebook.com/settings> |
| WhatsApp Manager | <https://business.facebook.com/wa/manage> |

### Modelo de acesso

Cada administrador deve ser adicionado individualmente no portfólio empresarial da Meta em **Configurações do negócio → Pessoas**, com autenticação de dois fatores obrigatória. Não compartilhar senha pessoal do Facebook.

O aplicativo central da Atenva usa configurações separadas para:

- conexão de Meta Ads e captação de leads;
- Embedded Signup do WhatsApp Cloud API;
- webhook oficial do WhatsApp;
- consulta de métricas e sincronização com o CRM.

Variáveis centrais na Vercel: `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, `META_OAUTH_SCOPES`, `META_MARKETING_LOGIN_CONFIG_ID`, `META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, `META_LEADS_VERIFY_TOKEN`, `WHATSAPP_VERIFY_TOKEN` e `WHATSAPP_APP_SECRET`.

Credenciais específicas de cada cliente/WABA são salvas cifradas pela aplicação. Para cada novo cliente, a conexão deve ser feita dentro de **Integrações → WhatsApp oficial** usando a conta Meta do cliente.

### Webhook

- Endpoint: `https://mais-tracao-atenva.vercel.app/api/webhooks/whatsapp`
- Token de verificação: armazenado como `WHATSAPP_VERIFY_TOKEN` na Vercel.
- O valor do token não deve aparecer neste documento.

### Evolution API

A Evolution é integração legada e não é o canal principal. O produto deve utilizar a WhatsApp Cloud API oficial. As variáveis `EVOLUTION_*` ainda existem na Vercel apenas por compatibilidade e devem ser removidas depois de confirmar que nenhum cliente depende delas.

## 5. Supabase e persistência

| Item | Informação |
| --- | --- |
| Painel | <https://supabase.com/dashboard> |
| Uso no projeto | Persistência/snapshot protegido e estrutura multiempresa |
| Variáveis | `SUPABASE_SNAPSHOT_URL`, `SUPABASE_ANON_KEY`, `SNAPSHOT_SYNC_KEY`, `SNAPSHOT_COMPANY` |

O administrador deve entrar no Supabase com uma conta própria convidada para a organização/projeto. O proprietário atual do projeto Supabase deve ser confirmado no painel, pois essa informação não é exposta pela aplicação nem pela Vercel.

Nunca compartilhar `service_role`, `SNAPSHOT_SYNC_KEY` ou chaves privadas. Em caso de troca de administrador, convide a nova pessoa e só depois remova a anterior.

## 6. Inteligência artificial

| Item | Informação |
| --- | --- |
| Provedor principal | Vercel AI Gateway |
| Modelo configurado | `openai/gpt-5.4-mini` |
| Variável | `AI_GATEWAY_API_KEY` |
| Alternativa | Endpoint compatível com Chat Completions por `AI_API_URL`, `AI_API_KEY` e `AI_MODEL` |

O token da IA está salvo como segredo na Vercel. Administradores podem substituí-lo, mas não devem copiá-lo para o código, navegador ou documentos.

## 7. Acesso administrativo ao CRM

O login administrativo da aplicação é controlado pelas variáveis `ADMIN_EMAIL`, `ADMIN_PASSWORD_B64`, `ADMIN_NAME`, `SESSION_SECRET` e `INTEGRATION_ENCRYPTION_KEY` na Vercel.

### Senha do CRM

A senha atual não pode ser recuperada da Vercel porque está armazenada como segredo. Para entregar uma senha nova aos administradores:

1. Gere uma senha longa e exclusiva no cofre.
2. Converta-a para Base64 conforme o formato esperado pelo projeto.
3. Substitua `ADMIN_PASSWORD_B64` na Vercel.
4. Faça um novo deploy.
5. Teste o login em janela anônima.
6. Compartilhe a senha somente pelo cofre.

Trocar `SESSION_SECRET` encerra sessões existentes. Trocar `INTEGRATION_ENCRYPTION_KEY` sem migrar os dados impede a leitura das credenciais de integrações já cifradas; essa variável nunca deve ser alterada casualmente.

## 8. Cofre de senhas recomendado

Use uma organização gratuita do Bitwarden ou outro gerenciador empresarial. Crie a coleção **Atenva — Produção** e armazene:

- recuperação e 2FA de `atenvacrm@gmail.com`;
- recuperação e 2FA do GitHub `atenvacrm`;
- acesso de emergência da Vercel;
- senha administrativa do CRM;
- conta proprietária do Supabase;
- contas e códigos de recuperação da Meta;
- contatos e recuperação do Google Cloud;
- procedimentos de rotação dos tokens.

Conceda acesso nominal aos administradores. Ative 2FA para todos e remova imediatamente pessoas desligadas. Não armazene segredos diretamente neste repositório.

## 9. Matriz de administradores

| Pessoa/conta | GitHub | Google Cloud | Vercel | Meta | Supabase | CRM |
| --- | --- | --- | --- | --- | --- | --- |
| `atenvacrm@gmail.com` | Proprietário (`atenvacrm`) | Owner | Conta principal | Confirmar no Business Manager | Confirmar no painel | Administrador principal |
| `Albert7pereira@gmail.com` | Write (`LexxFlood`) | Editor | Sem membro individual no Hobby | Conceder individualmente | Convidar individualmente | Criar usuário próprio quando disponível |

## 10. Checklist para adicionar um administrador

- [ ] Confirmar nome, e-mail e identidade da pessoa.
- [ ] Exigir 2FA em Google, GitHub, Meta, Vercel e cofre.
- [ ] Convidar no GitHub com o menor privilégio necessário.
- [ ] Conceder função adequada no Google Cloud IAM.
- [ ] Adicionar na Meta Business com ativos específicos.
- [ ] Convidar na organização do Supabase.
- [ ] Compartilhar itens necessários pelo cofre de senhas.
- [ ] Registrar quem aprovou e a data do acesso.
- [ ] Fazer um teste de login sem compartilhar sessão do navegador.

## 11. Checklist de revogação

- [ ] Remover GitHub, Google Cloud, Meta, Supabase e cofre.
- [ ] Revogar sessões e tokens pessoais.
- [ ] Rotacionar qualquer segredo que tenha sido visualizado.
- [ ] Remover o usuário do CRM.
- [ ] Registrar data, responsável e motivo da revogação.
- [ ] Confirmar que produção, deploy e integrações continuam funcionando.

## 12. Documentos relacionados

- [Guia do Albert — GitHub e Codex](GUIA-ALBERT-CODEX.md)
- [Deploy profissional](DEPLOYMENT.md)
- [Checklist de entrega ao cliente](CLIENT-HANDOFF.md)
- [Segurança](SECURITY.md)
- [Tutorial de produção em PDF](../entregas/Tutorial_Atenva_Producao_Dominio_Integracoes.pdf)

