# Guia do Albert — Atenva, GitHub e Codex

Este guia configura um computador Windows novo para trabalhar no projeto Atenva com uma conta própria. Não compartilhe senhas, tokens, arquivos `.env` ou códigos de recuperação.

## 1. Aceitar os acessos

### GitHub

1. Entre em <https://github.com> usando a conta associada a `Albert7pereira@gmail.com`.
2. Confirme que o usuário exibido é `LexxFlood`.
3. Abra as notificações do GitHub ou o e-mail de convite.
4. Aceite o convite para o repositório privado `atenvacrm/atenva-crm`.
5. Confirme que consegue abrir <https://github.com/atenvacrm/atenva-crm>.

O convite concede permissão de escrita no código. Não concede acesso ao faturamento ou às senhas de produção.

### Google Cloud

1. Entre em <https://console.cloud.google.com> com `Albert7pereira@gmail.com`.
2. No seletor de projetos, procure por `atenva-agenda`.
3. Abra o projeto e confirme que os menus de APIs, credenciais e Cloud Run estão disponíveis.
4. A permissão concedida é `Editor`. Ela permite modificar os recursos do projeto, mas não alterar faturamento ou conceder acesso a outras pessoas.

## 2. Proteger as contas

Antes de editar o projeto:

1. Ative autenticação de dois fatores no GitHub.
2. Ative a verificação em duas etapas na conta Google.
3. Ative autenticação de dois fatores na conta ChatGPT.
4. Nunca envie tokens ou senhas em mensagens, commits, issues ou pull requests.

## 3. Instalar os programas necessários no Windows

Abra o PowerShell normalmente e execute um comando por vez:

```powershell
winget install --id Git.Git
winget install --id OpenJS.NodeJS.LTS
winget install --id GitHub.cli
```

Depois, reinicie o computador ou feche e abra o PowerShell. Confirme as instalações:

```powershell
git --version
node --version
npm --version
gh --version
```

## 4. Entrar no GitHub pelo computador

No PowerShell, execute:

```powershell
gh auth login
```

Escolha:

1. `GitHub.com`.
2. `HTTPS`.
3. Autenticar o Git com as credenciais do GitHub: `Yes`.
4. `Login with a web browser`.
5. Copie o código mostrado, abra o endereço informado e confirme na conta `LexxFlood`.

Valide:

```powershell
gh auth status
```

## 5. Baixar o projeto

Crie uma pasta de trabalho, por exemplo `C:\Projetos`, e execute:

```powershell
New-Item -ItemType Directory -Force C:\Projetos
Set-Location C:\Projetos
git clone https://github.com/atenvacrm/atenva-crm.git
Set-Location C:\Projetos\atenva-crm
```

Confirme:

```powershell
git status
git remote -v
```

O resultado deve indicar a branch `main` e o remoto `atenvacrm/atenva-crm`.

## 6. Instalar e entrar no Codex

1. Instale o aplicativo ChatGPT para Windows pela Microsoft Store ou pelo link oficial da OpenAI.
2. Abra o aplicativo e selecione **Continuar para entrar**.
3. Entre com a conta ChatGPT pessoal do Albert. Não use a conta do Daniel.
4. No seletor do produto, escolha **Codex**.
5. Se o aplicativo pedir autorização para trabalhar localmente, permita somente o acesso necessário à pasta do projeto.
6. Use **Adicionar novo projeto** ou pressione `Ctrl+O`.
7. Selecione `C:\Projetos\atenva-crm`.
8. Em permissões, prefira **Pedir aprovação**. Não habilite acesso irrestrito ao computador.

O login fica salvo no computador do Albert. Tokens de autenticação nunca devem ser enviados para o repositório.

### Conectar o GitHub ao Codex

1. Dentro do Codex, abra **Plugins**.
2. Procure por **GitHub**.
3. Selecione instalar/conectar.
4. Autorize a conta GitHub `LexxFlood`.
5. Permita acesso ao repositório `atenvacrm/atenva-crm` quando o GitHub perguntar.
6. Inicie uma nova tarefa depois de concluir a conexão.

Se preferir usar somente os recursos Git locais, o login feito com `gh auth login` já permite criar branches, enviar commits e abrir pull requests.

## 7. Preparar e testar a Atenva localmente

No terminal integrado do Codex, dentro da pasta do projeto:

```powershell
npm install
npm test
npm start
```

O teste deve terminar sem falhas. O comando `npm start` informa o endereço local da aplicação.

Arquivos `.env` não ficam no GitHub. Se uma tarefa exigir integração real com Google, Meta, WhatsApp, Supabase ou IA, peça ao Daniel acesso/configuração específica. Nunca invente nem copie credenciais da produção.

## 8. Fluxo obrigatório para cada alteração

Nunca trabalhar diretamente na branch `main`. Para cada solicitação:

```powershell
git switch main
git pull --ff-only origin main
git switch -c nome-curto-da-alteracao
```

Exemplo:

```powershell
git switch -c corrigir-filtro-contatos
```

No Codex, descreva o resultado desejado, por exemplo:

> Revise o filtro de contatos. Implemente a correção, preserve o isolamento por empresa, adicione testes e não publique. Mostre o diff antes do commit.

Depois de revisar e testar:

```powershell
npm test
git status
git diff
git add -A
git commit -m "fix: corrigir filtro de contatos"
git push -u origin nome-curto-da-alteracao
gh pr create --fill --base main
```

Envie o link do pull request para o Daniel. A publicação deve ocorrer somente depois da revisão e da integração na `main`.

## 9. Atualizar o projeto antes de uma nova tarefa

```powershell
git switch main
git pull --ff-only origin main
```

Se uma branch antiga ainda estiver em uso:

```powershell
git switch nome-da-branch
git fetch origin
git rebase origin/main
```

Se houver conflito, pare e peça ao Codex para explicar os arquivos conflitantes antes de escolher o que manter.

## 10. Regras de segurança do projeto

- Não editar nem enviar `.env`, `.env.local`, `.env.cloudrun.local` ou tokens.
- Não copiar dados reais de clientes para testes locais.
- Não remover isolamento por `company_id` ou regras multiempresa.
- Não executar exclusões em produção sem confirmação do Daniel.
- Não alterar credenciais Google, Meta, WhatsApp, Supabase ou OpenAI sem uma tarefa específica.
- Rodar `npm test` antes de cada pull request.
- Usar branches e pull requests; não usar `git push --force`.
- Não publicar diretamente pela Vercel enquanto o fluxo de revisão não estiver configurado.

## 11. Primeira mensagem recomendada no Codex

Ao abrir o projeto pela primeira vez, envie:

> Leia o README, docs/SECURITY.md e docs/CLIENT-HANDOFF.md. Explique a arquitetura, os comandos de teste, o isolamento multiempresa e o fluxo Git. Não altere arquivos ainda.

Depois, para uma tarefa real:

> Crie uma branch para esta tarefa. Antes de editar, localize os arquivos envolvidos e explique o plano. Implemente apenas o escopo pedido, adicione testes, execute a suíte completa e prepare um pull request. Não publique nem altere credenciais.

## 12. Problemas comuns

### O repositório retorna 404

O convite ainda não foi aceito ou a conta GitHub aberta não é `LexxFlood`.

### `git` ou `gh` não é reconhecido

Feche e abra novamente o PowerShell. Se continuar, reinstale o programa com `winget`.

### `npm.ps1` foi bloqueado

Consulte a política de execução do PowerShell antes de alterá-la. Uma configuração comum para o usuário atual é:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### Codex não mostra o GitHub

Confirme que o plugin GitHub foi conectado, reinicie o aplicativo e abra uma nova tarefa.

### Os testes falharam

Não envie o pull request. Copie somente a mensagem de erro, sem credenciais ou dados de clientes, e peça ao Codex para diagnosticar a causa.

## Links importantes

- Repositório: <https://github.com/atenvacrm/atenva-crm>
- Produção: <https://mais-tracao-atenva.vercel.app>
- Google Cloud: <https://console.cloud.google.com/home/dashboard?project=atenva-agenda>
- Documentação oficial do Codex: <https://developers.openai.com/learn/codex>
- Configuração de revisão do Codex: <https://chatgpt.com/settings/code-review>

