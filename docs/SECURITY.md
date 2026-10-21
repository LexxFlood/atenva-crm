# Relatório de segurança

Data da revisão: 22 de agosto de 2026.

## Resumo executivo

A primeira versão era adequada apenas para demonstração local: as APIs não exigiam autenticação e uma configuração incompleta poderia aceitar webhooks sem assinatura. Estes problemas foram corrigidos.

O sistema agora possui autenticação, sessões no servidor, proteção CSRF, permissões por função, rate limiting, bloqueio de login, cabeçalhos defensivos, assinatura obrigatória do webhook e configuração de produção fail-closed.

Para os dois primeiros clientes, a recomendação é manter uma instância e um banco completamente separados por cliente. O código ainda não deve ser usado como SaaS multi-tenant compartilhado.

## Riscos encontrados e tratamento

| Risco | Severidade inicial | Situação | Tratamento |
|---|---:|---|---|
| APIs acessíveis sem login | Crítica | Corrigido | Login obrigatório e sessão no servidor |
| Alteração de recursos por IDs previsíveis | Alta | Mitigado | Autenticação, RBAC e instância isolada por cliente |
| Webhook sem segredo | Alta | Corrigido | Assinatura HMAC obrigatória; exceção apenas local e explícita |
| Tentativas ilimitadas de login/API | Alta | Corrigido | Limite por IP e bloqueio temporário da conta |
| Roubo ou fixação de sessão | Alta | Corrigido | Tokens CSPRNG, hash no banco, expiração e cookies seguros |
| CSRF em alterações | Alta | Corrigido | Token por sessão, SameSite e validação de origem |
| Clickjacking/XSS facilitado por configuração | Média | Mitigado | CSP, frame-ancestors, nosniff e escape de conteúdo |
| Exposição de segredos no repositório | Alta | Mitigado | `.env` ignorado e produção exige segredos externos |
| Mistura de dados entre clientes | Crítica | Em aberto por design | Usar uma implantação isolada por cliente |
| Falta de MFA | Média | Em aberto | Adicionar antes de escalar para equipes maiores |
| Rate limiting apenas em memória | Média | Em aberto | Migrar para Redis ao usar mais de uma réplica |
| Dados pessoais sem criptografia por campo | Média | Em aberto | Criptografia de disco agora; criptografia de campos na fase SaaS |
| SQLite e backup manual | Média | Em aberto | Volume isolado + backup diário; migrar para PostgreSQL ao escalar |
| Recuperação de senha/invites ausentes | Média | Em aberto | Administrador gerencia acesso na fase piloto |
| Auditoria editável pelo administrador do servidor | Baixa | Em aberto | Exportar logs para serviço imutável na fase de produção |

## Proteções implementadas

- Senhas derivadas com `scrypt`, salt aleatório e comparação em tempo constante.
- Sessões de 256 bits; somente o hash é armazenado.
- Cookies `HttpOnly`, `SameSite=Strict` e `Secure` em produção.
- Token anti-CSRF para todas as operações que alteram dados.
- Bloqueio de conta por 15 minutos após cinco falhas.
- Limites de login e tráfego geral por IP.
- Funções administrativas restritas a `admin` e `manager`.
- CSP, HSTS, `X-Frame-Options`, `nosniff`, política de referência e permissões.
- Limite de 2 MB por requisição e allowlist de campos alteráveis.
- Consultas SQL parametrizadas.
- Assinatura `X-Hub-Signature-256` validada com HMAC e comparação segura.
- Eventos duplicados do WhatsApp ignorados pelo identificador externo.
- Imagem Docker sem root, sem capabilities e com sistema de arquivos somente leitura.
- Produção não inicia sem senha exclusiva e segredo de sessão.

## Antes de armazenar dados reais

1. Usar HTTPS e nunca publicar diretamente a porta 3210.
2. Definir segredos exclusivos por cliente em um cofre de segredos.
3. Ativar criptografia do disco/volume e backups cifrados.
4. Testar restauração do backup, não apenas sua criação.
5. Definir retenção, exportação e exclusão de contactos conforme LGPD.
6. Configurar alertas para falhas de webhook, login e aumento de custos.
7. Rotacionar tokens da Meta e do modelo periodicamente.
8. Fazer teste de intrusão externo antes de uma abertura ampla.

Esta revisão reduz o risco do MVP, mas não substitui pentest independente, revisão jurídica ou certificação de segurança.
