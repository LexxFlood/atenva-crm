from pathlib import Path
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from PIL import Image, ImageDraw, ImageFont
import subprocess, imageio_ffmpeg, shutil

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'entregas'; ASSETS=OUT/'tutorial-assets'; OUT.mkdir(exist_ok=True); ASSETS.mkdir(exist_ok=True)
DOCX=OUT/'Tutorial_Atenva_Producao_Dominio_Integracoes.docx'
VIDEO=OUT/'Video_Tutorial_Atenva_Producao.mp4'
GREEN=RGBColor(15,55,31); MID=RGBColor(36,96,68); LIME=RGBColor(174,245,58); MUTED=RGBColor(93,108,98)

def shade(cell, fill):
    tcPr=cell._tc.get_or_add_tcPr(); shd=OxmlElement('w:shd'); shd.set(qn('w:fill'),fill); tcPr.append(shd)

def hyperlink(p,text,url):
    part=p.part; rid=part.relate_to(url,'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',is_external=True)
    h=OxmlElement('w:hyperlink'); h.set(qn('r:id'),rid); r=OxmlElement('w:r'); rPr=OxmlElement('w:rPr'); color=OxmlElement('w:color'); color.set(qn('w:val'),'246044'); underline=OxmlElement('w:u'); underline.set(qn('w:val'),'single'); rPr.append(color);rPr.append(underline);r.append(rPr);t=OxmlElement('w:t');t.text=text;r.append(t);h.append(r);p._p.append(h)

def add_title(doc,title,subtitle=None):
    p=doc.add_paragraph();p.style='Title';p.add_run(title)
    if subtitle:
        p=doc.add_paragraph(subtitle);p.style='Subtitle'

def add_h(doc,text,level=1): doc.add_heading(text,level=level)
def bullet(doc,text,level=0):
    p=doc.add_paragraph(style='List Bullet' if level==0 else 'List Bullet 2');p.add_run(text);return p
def number(doc,text):
    p=doc.add_paragraph(style='List Number');p.add_run(text);return p
def callout(doc,title,text,color='EAF7D3'):
    table=doc.add_table(rows=1,cols=1);table.alignment=WD_TABLE_ALIGNMENT.CENTER;cell=table.cell(0,0);shade(cell,color);cell.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
    p=cell.paragraphs[0];r=p.add_run(title+' — ');r.bold=True;r.font.color.rgb=GREEN;p.add_run(text)

def table(doc,headers,rows,widths=None):
    t=doc.add_table(rows=1,cols=len(headers));t.alignment=WD_TABLE_ALIGNMENT.CENTER;t.style='Table Grid'
    for i,h in enumerate(headers):
        c=t.rows[0].cells[i];shade(c,'0F371F');r=c.paragraphs[0].add_run(h);r.bold=True;r.font.color.rgb=RGBColor(255,255,255)
    for row in rows:
        cells=t.add_row().cells
        for i,val in enumerate(row): cells[i].text=str(val);cells[i].vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
    if widths:
        for row in t.rows:
            for i,w in enumerate(widths): row.cells[i].width=Inches(w)
    return t

def build_doc():
    doc=Document();sec=doc.sections[0];sec.top_margin=Inches(.65);sec.bottom_margin=Inches(.65);sec.left_margin=Inches(.72);sec.right_margin=Inches(.72)
    styles=doc.styles
    styles['Normal'].font.name='Aptos';styles['Normal'].font.size=Pt(10);styles['Normal'].paragraph_format.space_after=Pt(6)
    for name,size,color in [('Title',34,GREEN),('Subtitle',14,MUTED),('Heading 1',21,GREEN),('Heading 2',14,MID),('Heading 3',11,MID)]:
        styles[name].font.name='Aptos Display';styles[name].font.size=Pt(size);styles[name].font.color.rgb=color
    logo=ROOT/'public/assets/atenva-logo-green.png'
    if logo.exists(): doc.add_picture(str(logo),width=Inches(1.8));doc.paragraphs[-1].alignment=WD_ALIGN_PARAGRAPH.LEFT
    add_title(doc,'ATENVA em produção','Tutorial completo de domínio, hospedagem, subdomínios, logins e integrações · versão 21/10/2026')
    callout(doc,'Objetivo','sair do ambiente de teste e operar a Atenva como um SaaS multiempresa vendável, com uma conta central, acessos isolados por cliente, Google Agenda, Meta Ads, WhatsApp oficial, IA e cadências automáticas.')
    doc.add_paragraph('Este guia foi escrito para execução prática. Faça os itens na ordem e marque o checklist final antes de cadastrar o primeiro cliente pagante.')
    add_h(doc,'1. O que já está pronto na Atenva')
    for x in ['Multiempresa com isolamento de contatos, funis, tarefas, conhecimento, integrações e usuários.','Conta central de Onboarding Manager para criar e administrar clientes.','URLs por empresa no formato /empresa e leitura de subdomínio no formato empresa.seudominio.com.','WhatsApp Cloud API oficial, Google Agenda, Meta Marketing/Lead Ads e agente de IA.','Novo módulo Relacionamento: origem → destino, LTV, segmentação da base e linha do tempo.','Cadências automáticas com mensagens, tarefas, pausa por resposta e encerramento por ganho/perda.']: bullet(doc,x)
    add_h(doc,'2. Arquitetura recomendada e custo mínimo')
    table(doc,['Camada','Teste / validação','Produção vendável'],[
        ['Aplicação','Vercel Hobby + URL vercel.app','Vercel Pro ou outro plano comercial com SLA adequado'],
        ['Banco','Supabase Free','Supabase Pro, backups e alertas'],
        ['Domínio','URL gratuita *.vercel.app','Domínio próprio pago anualmente'],
        ['WhatsApp','Número de teste da Meta','Cloud API oficial por cliente; cobrança Meta conforme uso'],
        ['IA','Motor local ou créditos de teste','AI Gateway/OpenAI com limite e orçamento'],
        ['Agendador','App aberto / chamada manual','Cron confiável chamando /api/cron/scheduled-messages'],
    ],[1.25,2.3,3.1])
    callout(doc,'Importante','domínio próprio não é gratuito: o registro anual é pago. A hospedagem pode começar grátis, mas um produto vendido não deve depender de planos que pausam por inatividade ou não permitem uso comercial. O Supabase informa que projetos Free podem ser pausados por baixa atividade após 7 dias.')
    add_h(doc,'3. Estrutura de domínio')
    table(doc,['Endereço','Função'],[['atenva.com.br','Site institucional'],['app.atenva.com.br','Login central da Atenva'],['*.atenva.com.br','Acesso dedicado por cliente, ex.: mais-tracao.atenva.com.br'],['app.atenva.com.br/api/webhooks/whatsapp','Webhook da Cloud API'],['app.atenva.com.br/api/webhooks/meta-leads','Webhook de Lead Ads'],['app.atenva.com.br/api/integrations/google/callback','Retorno OAuth Google'],['app.atenva.com.br/api/integrations/meta/callback','Retorno OAuth Meta']], [2.55,4.1])
    add_h(doc,'4. Domínio próprio e DNS na Vercel')
    for s in ['Compre o domínio em um registrador confiável e mantenha-o na conta jurídica da Atenva.','Na Vercel, abra o projeto mais-tracao-atenva → Settings → Domains.','Adicione app.seudominio.com e depois *.seudominio.com.','Para o wildcard, use os nameservers fornecidos pela Vercel no registrador; isso é necessário para emitir certificados wildcard.','Aguarde o status Valid Configuration e confirme o cadeado HTTPS.','Defina app.seudominio.com como domínio principal do projeto.']: number(doc,s)
    p=doc.add_paragraph('Referência oficial: ');hyperlink(p,'Vercel — adicionar e configurar domínio','https://vercel.com/docs/domains/working-with-domains/add-a-domain')
    add_h(doc,'5. Hospedagem e variáveis de produção')
    doc.add_paragraph('No projeto Vercel, abra Settings → Environment Variables. Cadastre os segredos como Sensitive e aplique em Production. Nunca envie tokens por conversa, e-mail ou repositório.')
    table(doc,['Grupo','Variáveis necessárias'],[
        ['Segurança','ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD, SESSION_SECRET, INTEGRATION_ENCRYPTION_KEY, TRUST_PROXY=true'],
        ['URL','BASE_URL=https://app.seudominio.com'],
        ['Supabase','SUPABASE_SNAPSHOT_URL, SUPABASE_ANON_KEY, SNAPSHOT_SYNC_KEY, SNAPSHOT_COMPANY'],
        ['Google','GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI'],
        ['Meta central','META_APP_ID, META_APP_SECRET, META_MARKETING_LOGIN_CONFIG_ID, META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID, META_REDIRECT_URI'],
        ['Webhooks','WHATSAPP_VERIFY_TOKEN, META_LEADS_VERIFY_TOKEN'],
        ['IA','AI_GATEWAY_MODEL=openai/gpt-5.4-mini e credencial do Gateway quando necessária'],
        ['Automação','CRON_SECRET'],
    ],[1.25,5.4])
    callout(doc,'Segurança','gere SESSION_SECRET, INTEGRATION_ENCRYPTION_KEY, SNAPSHOT_SYNC_KEY, WHATSAPP_VERIFY_TOKEN, META_LEADS_VERIFY_TOKEN e CRON_SECRET com pelo menos 32 bytes aleatórios. Não reutilize valores.')
    add_h(doc,'6. Banco de dados no Supabase')
    for s in ['Crie um projeto Supabase na organização Atenva.','Use uma região próxima ao público e guarde a senha do banco em um gerenciador de senhas.','Implante a função de snapshot usada pela Atenva e preencha SUPABASE_SNAPSHOT_URL/SNAPSHOT_SYNC_KEY.','Ative RLS em qualquer tabela exposta pelo cliente Supabase; o banco da Atenva deve ser acessado somente pelo backend.','Configure backup e alertas. Para produção, use plano que não pause por inatividade.']: number(doc,s)
    p=doc.add_paragraph('Referência oficial: ');hyperlink(p,'Supabase — checklist de produção','https://supabase.com/docs/guides/deployment/going-into-prod')
    add_h(doc,'7. Google Agenda: conexão para qualquer cliente')
    for s in ['No Google Cloud, use um projeto de produção separado e habilite Google Calendar API.','Em Google Auth Platform → Branding, use a marca Atenva, domínio verificado, e-mail de suporte, homepage e política de privacidade.','Em Audience, selecione External e publique em produção. Enquanto estiver em Testing, só usuários de teste entram e a autorização pode expirar em 7 dias.','No cliente Web, cadastre exatamente https://app.seudominio.com/api/integrations/google/callback em Authorized redirect URIs.','Preencha GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI na Vercel.','Na Atenva: Integrações → Google Agenda → Conectar; escolha as agendas que devem sincronizar e faça o teste criando uma tarefa.']: number(doc,s)
    callout(doc,'Erro 403','significa normalmente que o app ainda está em Testing e a conta não foi cadastrada como testadora, ou que a publicação/verificação não foi concluída.')
    p=doc.add_paragraph('Referências: ');hyperlink(p,'OAuth para aplicações web','https://developers.google.com/identity/protocols/oauth2/web-server');p.add_run(' · ');hyperlink(p,'requisitos de verificação','https://support.google.com/cloud/answer/13464321')
    add_h(doc,'8. Meta Ads e rastreamento de leads')
    for s in ['No Meta for Developers, mantenha um app central da Atenva vinculado ao Business Manager da Atenva.','Crie uma configuração Business Login para Marketing e outra específica para WhatsApp Embedded Signup.','Cadastre https://app.seudominio.com/api/integrations/meta/callback como URI OAuth válida.','Configure o webhook de Lead Ads em https://app.seudominio.com/api/webhooks/meta-leads e use META_LEADS_VERIFY_TOKEN.','Solicite App Review/Advanced Access para leads_retrieval, pages_manage_metadata e demais permissões realmente usadas.','Enquanto leads_retrieval não estiver aprovado, mantenha META_ENABLE_LEADS_RETRIEVAL=false. Após a aprovação, altere para true e faça novo deploy.','Na Atenva: Integrações → Meta → Conectar; selecione BM, conta de anúncios, Página e formulários.','Envie um lead de teste pelo Lead Ads Testing Tool e confirme: contato, negócio, tarefa e origem Meta Ads.']: number(doc,s)
    add_h(doc,'9. WhatsApp Cloud API oficial')
    for s in ['Cadastre a Atenva como Tech Provider/BSP parceiro ou use conexão manual enquanto o Embedded Signup não estiver aprovado.','Configure META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID com a configuração aprovada.','Cadastre o domínio da Atenva, OAuth redirect e os domínios permitidos no app Meta.','Configure o webhook https://app.seudominio.com/api/webhooks/whatsapp, verify token e assinatura com META_APP_SECRET.','Assine messages e demais eventos necessários na WABA.','Na conta do cliente, abra Integrações → WhatsApp oficial → Entrar com Facebook, escolha BM, WABA e número.','Envie e receba uma mensagem real. Confirme status sent/delivered/read e abertura da janela de atendimento.']: number(doc,s)
    callout(doc,'Janela de 24 horas','mensagem livre só deve ser usada na janela de atendimento. Para iniciar ou retomar fora da janela, use um template aprovado na Meta. O construtor de cadências permite escolher esse modelo.')
    add_h(doc,'10. IA do Agente Atenva')
    for s in ['Defina AI_GATEWAY_MODEL e configure orçamento/limites no provedor.','Em Conhecimento, adicione playbook, oferta, objeções e políticas; mantenha versões curtas e atualizadas.','No Agente Atenva, crie sessões de laboratório, teste perguntas reais e aprove somente regras corretas.','Use o modo de confirmação para comandos que alteram dados: criar tarefa, mover lead, atualizar regra ou agir no WhatsApp.','Teste o fallback: se o modelo ficar indisponível, o sistema não pode afirmar que executou algo que não executou.']: number(doc,s)
    add_h(doc,'11. Criar clientes, subdomínios e logins')
    for s in ['Entre por app.seudominio.com com o Onboarding Manager.','Abra Administração → Clientes → Criar cliente e acesso.','Defina empresa, administrador, e-mail, plano, início e limite de usuários.','O slug gerado vira a rota /slug e também pode ser usado como slug.seudominio.com com o wildcard configurado.','Envie o convite seguro ao administrador. O link expira e não deve ser reutilizado.','Entre no ambiente do cliente e conecte Google, Meta e WhatsApp dentro desse perfil; as credenciais ficam isoladas por empresa.','Crie um funil, um contato e uma tarefa de teste. Confirme que outra empresa não enxerga esses registros.']: number(doc,s)
    add_h(doc,'12. Relacionamento e cadência automática')
    for s in ['Abra Relacionamento. Use os cards para filtrar clientes ativos, em risco e inativos.','Clique no nome do contato para ver a jornada Origem → Destino e todos os eventos comerciais.','Clique Nova cadência e combine mensagens WhatsApp e tarefas.','Use {{nome}}, {{empresa}} e {{telefone}} para personalização.','Selecione contatos na tabela, escolha uma cadência e clique Adicionar seleção.','Ao responder, o contato sai da cadência automaticamente. Ganho ou perda também encerram a sequência quando a regra estiver marcada.','A rota /api/cron/scheduled-messages deve ser chamada periodicamente com Authorization: Bearer <CRON_SECRET> para execução sem depender de alguém com a tela aberta.']: number(doc,s)
    callout(doc,'Cadência segura','trate consentimento, opt-out, horário comercial, frequência e templates aprovados como regras obrigatórias. Relacionamento não é disparo indiscriminado.')
    add_h(doc,'13. Disponibilidade, monitoramento e backups')
    table(doc,['Controle','Como validar'],[['Health check','GET /api/health a cada 5 minutos'],['Cron','POST /api/cron/scheduled-messages com CRON_SECRET'],['Logs','Vercel → Observability → Functions; alertar erros 5xx'],['Banco','Snapshot/backup diário e teste de restauração mensal'],['Google','Status conectado e última sincronização'],['Meta/WhatsApp','Webhook verificado, token válido e mensagens entregues'],['IA','Modelo configurado, limite de gasto e fallback testado'],['SSL/DNS','HTTPS válido no app e em um subdomínio de cliente']],[1.5,5.1])
    add_h(doc,'14. Checklist de lançamento')
    checks=['Domínio e wildcard verificados','SSL ativo','Produção não depende de plano que pausa','Segredos cadastrados como Sensitive','Backup restaurado em teste','Google em produção e callback exato','Meta App Review concluído para permissões usadas','WhatsApp envia, recebe e confirma status','Lead Ads cria contato/negócio/tarefa','Agente responde com modelo real e confirma ações','Cadência executa sem tela aberta','Isolamento entre duas empresas validado','Conta de suporte e política de privacidade publicadas','Monitoramento e responsável por incidentes definidos']
    for c in checks: doc.add_paragraph('☐ '+c)
    add_h(doc,'15. Critério de “pronto para vender”')
    doc.add_paragraph('A Atenva só está pronta para venda quando um cliente novo consegue receber convite, entrar no seu ambiente isolado, conectar Google/Meta/WhatsApp sem intervenção técnica, receber um lead real, conversar, criar tarefa, mover o negócio, rastrear sua origem e executar uma cadência fora da tela — com logs, backup e suporte definidos.')
    add_h(doc,'Fontes oficiais e leitura adicional')
    refs=[('Vercel — domínios e wildcard','https://vercel.com/docs/domains/working-with-domains/add-a-domain'),('Vercel — configuração de domínio','https://vercel.com/docs/domains/set-up-custom-domain'),('Supabase — produção','https://supabase.com/docs/guides/deployment/going-into-prod'),('Google — OAuth web server','https://developers.google.com/identity/protocols/oauth2/web-server'),('Google — verificação OAuth','https://support.google.com/cloud/answer/13464321'),('Google — audiência e publicação','https://support.google.com/cloud/answer/15549945'),('Meta — WhatsApp Cloud API','https://developers.facebook.com/docs/whatsapp/cloud-api/'),('Meta — Lead Ads e webhooks','https://developers.facebook.com/docs/marketing-api/guides/lead-ads/'),('Repediu — referência funcional de relacionamento','https://repediu.com.br/')]
    for label,url in refs:
        p=doc.add_paragraph(style='List Bullet');hyperlink(p,label,url)
    for section in doc.sections:
        header=section.header.paragraphs[0];header.text='ATENVA · GUIA DE PRODUÇÃO';header.alignment=WD_ALIGN_PARAGRAPH.RIGHT;header.runs[0].font.color.rgb=MUTED;header.runs[0].font.size=Pt(8)
        footer=section.footer.paragraphs[0];footer.alignment=WD_ALIGN_PARAGRAPH.CENTER;footer.add_run('Documento operacional · não compartilhe segredos ou tokens')
    doc.save(DOCX)

def font(size,bold=False):
    paths=[Path('C:/Windows/Fonts/seguisb.ttf') if bold else Path('C:/Windows/Fonts/segoeui.ttf'),Path('C:/Windows/Fonts/arialbd.ttf') if bold else Path('C:/Windows/Fonts/arial.ttf')]
    for p in paths:
        if p.exists(): return ImageFont.truetype(str(p),size)
    return ImageFont.load_default()

def wrap(draw,text,f,maxw):
    words=text.split();lines=[];line=''
    for w in words:
        test=(line+' '+w).strip()
        if draw.textbbox((0,0),test,font=f)[2]<=maxw:line=test
        else:
            if line:lines.append(line)
            line=w
    if line:lines.append(line)
    return lines

def slide(title,subtitle,bullets,index,total):
    img=Image.new('RGB',(1280,720),'#F5F8F1');d=ImageDraw.Draw(img)
    d.rectangle((0,0,1280,14),fill='#AEF53A');d.rounded_rectangle((65,55,1215,650),radius=26,fill='#FFFFFF',outline='#DCE5D8',width=2)
    d.text((95,83),'ATENVA',font=font(24,True),fill='#0F371F');d.text((1080,90),f'{index:02d}/{total:02d}',font=font(18,True),fill='#6B786E')
    y=148
    for line in wrap(d,title,font(42,True),1020):d.text((95,y),line,font=font(42,True),fill='#10251A');y+=54
    if subtitle:
        y+=4
        for line in wrap(d,subtitle,font(22),1010):d.text((95,y),line,font=font(22),fill='#496054');y+=31
    y+=24
    for item in bullets:
        d.rounded_rectangle((98,y+6,112,y+20),radius=5,fill='#AEF53A')
        lines=wrap(d,item,font(24),970)
        for j,line in enumerate(lines):d.text((132,y+j*33),line,font=font(24),fill='#24382C')
        y+=max(47,len(lines)*33+14)
    d.text((95,620),'Tutorial operacional · implantação e venda',font=font(16),fill='#738077')
    return img

def build_video():
    slides=[
      ('ATENVA pronta para vender','O caminho completo do teste à produção',['Domínio próprio e subdomínios por cliente','Hospedagem, banco, logins e integrações','Relacionamento, rastreamento e cadências automáticas']),
      ('Arquitetura recomendada','Comece barato, mas sem esconder os limites',['Vercel para aplicação e SSL','Supabase para persistência e backup','Meta Cloud API, Google OAuth e AI Gateway','Em produção, evite planos que pausam ou não permitem uso comercial']),
      ('Domínio e wildcard','Uma configuração para todos os clientes',['Use app.seudominio.com para o login central','Configure *.seudominio.com para cliente.seudominio.com','Wildcard na Vercel exige nameservers da Vercel','Confirme DNS e certificado HTTPS antes de seguir']),
      ('Variáveis e segurança','Segredos ficam no provedor — nunca no código',['BASE_URL deve apontar para o domínio final','Segredos de sessão e criptografia com 32+ bytes','Cadastre Google, Meta, Supabase, IA e CRON_SECRET','Use ambiente Production e marque segredos como Sensitive']),
      ('Google Agenda','OAuth publicado e callback exato',['Ative Calendar API e configure Branding/Audience','Use projeto de produção e domínio verificado','Cadastre /api/integrations/google/callback exatamente','Conecte pela Atenva e teste criando uma tarefa']),
      ('Meta Ads e leads','Da campanha ao destino comercial',['Use configuração de Marketing separada do WhatsApp','Solicite acesso avançado a leads_retrieval','Configure o webhook de Meta Leads','Um lead real deve criar contato, negócio, tarefa e origem']),
      ('WhatsApp oficial','Cloud API sem Evolution',['Use Embedded Signup aprovado ou configuração manual','Configure webhook, verify token e assinatura','Teste envio, recebimento e status de leitura','Fora de 24h, use template aprovado']),
      ('Agente Atenva','IA com conhecimento e ações confirmadas',['Configure modelo real e limite de gasto','Treine o playbook em Conhecimento','Teste no laboratório por sessões','Confirme ações antes de alterar dados ou falar com leads']),
      ('Relacionamento com a base','Nova área operacional',['Classifique clientes ativos, em risco e inativos','Veja origem → destino e a linha do tempo completa','Acompanhe LTV e última interação','Use a base para retenção, reativação e expansão']),
      ('Cadência automática','Follow-up que para no momento certo',['Combine mensagens e tarefas por horas ou dias','Personalize com {{nome}}, {{empresa}} e {{telefone}}','Pare automaticamente quando o contato responder','Ganho ou perda encerram a sequência']),
      ('Criar um novo cliente','Processo do Onboarding Manager',['Administração → Criar cliente e acesso','O slug vira /empresa e empresa.seudominio.com','Envie convite seguro ao administrador','Conecte Google, Meta e WhatsApp dentro do perfil correto']),
      ('Operação confiável','O que precisa funcionar sem a tela aberta',['Cron chama /api/cron/scheduled-messages','Health check, logs e alerta de erro 5xx','Backup diário e restauração testada','Valide isolamento com duas empresas antes da primeira venda']),
      ('Checklist final','Atenva pronta para venda',['Cliente entra sem ajuda técnica','Integrações conectam e sincronizam','Lead percorre origem, conversa, funil e destino','Cadência executa, para por resposta e deixa histórico'])]
    frame_dir=ASSETS/'frames';shutil.rmtree(frame_dir,ignore_errors=True);frame_dir.mkdir(parents=True)
    files=[]
    for i,s in enumerate(slides,1):
        path=frame_dir/f'slide-{i:02d}.png';slide(*s,i,len(slides)).save(path,quality=95);files.append(path)
    concat=ASSETS/'slides.txt'
    concat.write_text(''.join([f"file '{p.as_posix()}'\nduration 5\n" for p in files]+[f"file '{files[-1].as_posix()}'\n"]),encoding='utf-8')
    ff=imageio_ffmpeg.get_ffmpeg_exe();subprocess.run([ff,'-y','-f','concat','-safe','0','-i',str(concat),'-vf','fps=30,format=yuv420p','-c:v','libx264','-movflags','+faststart',str(VIDEO)],check=True,capture_output=True)

if __name__=='__main__':
    build_doc();build_video();print(DOCX);print(VIDEO)
