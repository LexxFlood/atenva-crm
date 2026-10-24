import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDatabase = join(root, 'data', 'whatscrm.test.db');
for (const suffix of ['', '-shm', '-wal']) {
  if (existsSync(testDatabase + suffix)) unlinkSync(testDatabase + suffix);
}
process.env.DATABASE_PATH = testDatabase;

const { db, get, run } = await import('../src/db.js');
const { seed } = await import('../src/seed.js');
const { agentModelStatus, classifyIntent, searchKnowledge, processInboundMessage } = await import('../src/agent.js');
const { runWithRequestContext } = await import('../src/request-context.js');
const { extractWebhookEvents, sendWhatsAppAudio, sendWhatsAppText, verifyChallenge, verifySignature } = await import('../src/whatsapp.js');
const { describeEvolutionState, extractEvolutionWebhookEvents } = await import('../src/evolution.js');
const { completeGoogleAuthorization, googleAuthorizationUrl, googleCalendarEvents, googleCalendars, googleStatus } = await import('../src/google-calendar.js');
const { completeMetaAuthorization, metaAuthorizationUrl, metaOauthStatus, publicMetaConfig, verifyMetaLeadChallenge, verifyMetaLeadSignature } = await import('../src/integrations.js');
const { authenticate, ensureAdminCredentials, hashPassword, login, logout, requireRole } = await import('../src/auth.js');
const { processMetaLeadWebhook, processScheduledMessages, processWebhook, routeApi } = await import('../src/api.js');
const { processCadences, stopCadencesForContact } = await import('../src/relationships.js');
const { appendHumanSignature, nextLeadOwner } = await import('../src/team-routing.js');

seed();
ensureAdminCredentials();

test('cria o banco e os dados essenciais', () => {
  assert.equal(get('SELECT COUNT(*) AS count FROM contacts').count, 6);
  assert.equal(get('SELECT COUNT(*) AS count FROM pipelines').count, 3);
  assert.equal(get("SELECT COUNT(*) AS count FROM pipelines WHERE lower(name)='retomada'").count, 1);
  assert.equal(get("SELECT COUNT(*) AS count FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.kind='sales'").count, 5);
  assert.equal(get("SELECT COUNT(*) AS count FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.kind='customers'").count, 3);
  assert.equal(get('SELECT COUNT(*) AS count FROM loss_reasons').count, 6);
  assert.equal(get('SELECT COUNT(*) AS count FROM knowledge_documents').count, 4);
  assert.equal(get('SELECT autonomy_level FROM agent_config WHERE id=1').autonomy_level, 2);
});

test('distribui novos leads em rodízio persistente por ordem de chegada', () => {
  const companyId=Number(run("INSERT INTO company_profiles(name,slug,status) VALUES ('Empresa Rodízio','empresa-rodizio','active')").lastInsertRowid);
  const first=Number(run("INSERT INTO users(name,email,role,status,is_active) VALUES ('Atendente Um','fila1@atenva.test','agent','online',1)").lastInsertRowid);
  const second=Number(run("INSERT INTO users(name,email,role,status,is_active) VALUES ('Atendente Dois','fila2@atenva.test','agent','online',1)").lastInsertRowid);
  run("INSERT INTO user_company_memberships(company_id,user_id,role,is_active) VALUES (?,?,'agent',1)",[companyId,first]);
  run("INSERT INTO user_company_memberships(company_id,user_id,role,is_active) VALUES (?,?,'agent',1)",[companyId,second]);
  assert.deepEqual([nextLeadOwner(companyId).id,nextLeadOwner(companyId).id,nextLeadOwner(companyId).id,nextLeadOwner(companyId).id],[first,second,first,second]);
});

test('Produtora Mais Tração assina mensagens humanas com o nome do atendente', () => {
  const companyId=Number(run("INSERT INTO company_profiles(name,slug,status) VALUES ('Produtora Mais Tração','produtora-mais-tracao','active')").lastInsertRowid);
  const userId=Number(run("INSERT INTO users(name,email,role,status,is_active) VALUES ('Thiago Fernandes','thiago.assinatura@atenva.test','agent','online',1)").lastInsertRowid);
  run("INSERT INTO user_company_memberships(company_id,user_id,role,is_active) VALUES (?,?,'agent',1)",[companyId,userId]);
  assert.equal(appendHumanSignature(companyId,userId,'Olá! Como posso ajudar?'),'Olá! Como posso ajudar?\n\n— Thiago Fernandes');
  assert.equal(appendHumanSignature(companyId,userId,'Olá!\n\n— Thiago Fernandes'),'Olá!\n\n— Thiago Fernandes');
  assert.equal(appendHumanSignature(1,userId,'Mensagem Atenva'),'Mensagem Atenva');
});

test('classifica preço sem confundir quantidade de pessoas com handoff', () => {
  const [intent, confidence] = classifyIntent('Quanto custa para uma equipe de 6 pessoas?');
  assert.equal(intent, 'preco');
  assert.ok(confidence >= 0.8);
});

test('reconhece pedido explícito de atendimento humano', () => {
  assert.equal(classifyIntent('Quero falar com uma pessoa da equipe')[0], 'pedido_humano');
  assert.equal(classifyIntent('Pode chamar um atendente?')[0], 'pedido_humano');
});

test('recupera conhecimento aprovado por busca textual', () => {
  const documents = searchKnowledge('Quais são os planos e preços?');
  assert.ok(documents.length > 0);
  assert.match(documents.map(document => document.title).join(' '), /preços/i);
});

test('normaliza mensagem recebida no webhook da Meta', () => {
  const events = extractWebhookEvents({
    entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: 'Marina' } }],
      messages: [{ id: 'wamid.123', from: '5511999999999', timestamp: '1787400000', type: 'text', text: { body: 'Olá' } }]
    } }] }]
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].contactName, 'Marina');
  assert.equal(events[0].content, 'Olá');
  assert.equal(events[0].externalId, 'wamid.123');
});

test('normaliza mensagens e confirmações recebidas da Evolution', () => {
  const messages = extractEvolutionWebhookEvents({
    event: 'messages.upsert',
    data: { key: { id: 'EVO-123', remoteJid: '5511987654321@s.whatsapp.net', fromMe: false }, pushName: 'Daniel', messageTimestamp: 1787400000, message: { conversation: 'Olá pela Evolution' } }
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, '5511987654321');
  assert.equal(messages[0].contactName, 'Daniel');
  assert.equal(messages[0].content, 'Olá pela Evolution');
  assert.equal(messages[0].externalId, 'EVO-123');

  const statuses = extractEvolutionWebhookEvents({ event: 'messages.update', data: { key: { id: 'EVO-123' }, update: { status: 'delivered' } } });
  assert.equal(statuses[0].kind, 'status');
  assert.equal(statuses[0].status, 'delivered');
});

test('ignora grupos e mensagens enviadas pelo próprio número na Evolution', () => {
  const group = extractEvolutionWebhookEvents({ event: 'messages.upsert', data: { key: { id: '1', remoteJid: '123@g.us', fromMe: false }, message: { conversation: 'grupo' } } });
  const outbound = extractEvolutionWebhookEvents({ event: 'messages.upsert', data: { key: { id: '2', remoteJid: '5511999999999@s.whatsapp.net', fromMe: true }, message: { conversation: 'minha mensagem' } } });
  assert.equal(group.length, 0);
  assert.equal(outbound.length, 0);
});

test('Evolution diferencia infraestrutura, instância e sessão do WhatsApp',()=>{
  const offline=describeEvolutionState('unavailable');
  assert.equal(offline.reachable,false);assert.equal(offline.lifecycle,'infrastructure_offline');assert.match(offline.status_title,/indisponível/i);
  const ready=describeEvolutionState('not_created');
  assert.equal(ready.reachable,true);assert.equal(ready.instance_created,false);assert.equal(ready.needs_qr,true);
  const connected=describeEvolutionState('connected');
  assert.equal(connected.reachable,true);assert.equal(connected.connected,true);assert.equal(connected.needs_qr,false);
});

test('valida o desafio de configuração do webhook', () => {
  process.env.WHATSAPP_VERIFY_TOKEN = 'segredo';
  assert.equal(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'segredo', 'hub.challenge': '12345' }), '12345');
  assert.equal(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '12345' }), null);
});

test('recusa webhook sem assinatura por padrão', () => {
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.ALLOW_INSECURE_WEBHOOKS;
  assert.equal(verifySignature(Buffer.from('{}'), undefined), false);
});

test('cria, autentica e revoga uma sessão segura', () => {
  run(`INSERT INTO sessions (user_id,token_hash,csrf_token,expires_at) VALUES (2,'sessao-controle','csrf-controle',?)`, [new Date(Date.now() + 60_000).toISOString()]);
  const result = login({ email: 'ana@verdecrm.local', password: 'VerdeDemo!2026', ip: '127.0.0.1', userAgent: 'test' });
  assert.equal(result.user.role, 'manager');
  assert.ok(result.csrfToken.length >= 24);
  assert.match(result.cookie, /HttpOnly/);
  assert.match(result.cookie, /SameSite=Lax/);
  assert.doesNotMatch(result.cookie, /SameSite=Strict/);
  const secondSession = login({ email: 'ana@verdecrm.local', password: 'VerdeDemo!2026', ip: '127.0.0.2', userAgent: 'second-tab' });
  assert.ok(secondSession.cookie);
  assert.ok(get('SELECT COUNT(*) AS count FROM sessions WHERE user_id=1').count >= 2, 'um novo login deve preservar a outra aba/dispositivo');
  const token = decodeURIComponent(result.cookie.match(/verde_session=([^;]+)/)[1]);
  const auth = authenticate({ headers: { cookie: `verde_session=${encodeURIComponent(token)}` } });
  assert.equal(auth.user.id, 1);
  assert.equal(auth.user.email, 'ana@verdecrm.local');
  run('DELETE FROM sessions WHERE id=?', [auth.sessionId]);
  assert.equal(authenticate({ headers: { cookie: `verde_session=${encodeURIComponent(token)}` } }).user.id, 1);
  assert.doesNotThrow(() => requireRole(auth, ['manager']));
  assert.throws(() => requireRole(auth, ['agent']), /permissão/);
  logout(auth, '127.0.0.1');
  assert.equal(authenticate({ headers: { cookie: 'verde_session=' } }), null);
});

test('cria múltiplos pipelines e tarefas atribuídas', async () => {
  const context = { user: { id: 1, role: 'manager' } };
  const pipeline = await routeApi({ method: 'POST' }, null, new URL('http://local/api/pipelines'), { name: 'Parcerias', stages: ['Entrada', 'Negociação'] }, context);
  assert.equal(pipeline.name, 'Parcerias');
  assert.equal(get('SELECT COUNT(*) AS count FROM pipeline_stages WHERE pipeline_id=?', [pipeline.id]).count, 2);
  const task = await routeApi({ method: 'POST' }, null, new URL('http://local/api/tasks'), { title: 'Revisar proposta', contact_id: 1, conversation_id: 1, assigned_to: 1, due_at: new Date().toISOString() }, context);
  assert.equal(task.assigned_name, 'Ana Martins');
});

test('cria um novo negócio manualmente na etapa escolhida', async () => {
  const context = { user: { id: 1, role: 'manager', companyId: 1 } };
  const stage = get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
    WHERE p.kind='sales' ORDER BY s.local_position LIMIT 1`);
  const deal = await routeApi({ method: 'POST' }, null, new URL('http://local/api/deals'), {
    title: 'Novo projeto de tráfego', contact_id: 1, stage_id: stage.id, value_cents: 125000, score: 72, expected_close_at: '2026-10-30'
  }, context);
  assert.equal(deal.title, 'Novo projeto de tráfego');
  assert.equal(deal.value_cents, 125000);
  assert.equal(deal.status, 'open');
  assert.equal(deal.pipeline_id > 0, true);
});

test('cria novo contato e negócio em uma única ação', async () => {
  const context = { user: { id: 1, role: 'manager', companyId: 1 } };
  const stage = get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.kind='sales' ORDER BY s.local_position LIMIT 1`);
  const deal = await routeApi({ method: 'POST' }, null, new URL('http://local/api/deals'), {
    title:'Lead criado pelo Kanban',stage_id:stage.id,value_cents:50000,contact:{first_name:'Contato',last_name:'Rápido',name:'Contato Rápido',email:'rapido@example.com',social:'@contatorapido',company:'Empresa teste',company_phone:'+551133334444',company_email:'empresa@example.com',company_socials:'@empresateste',company_website:'https://empresa.test',source:'instagram',temperature:'hot',tags:'Inbound, Produtora',segment:'Eventos',client_type:'Empresa',objective:'Produzir campanha'}
  }, context);
  assert.equal(deal.contact_name,'Contato Rápido');
  const contact=get('SELECT source,segment,custom_fields FROM contacts WHERE id=?',[deal.contact_id]);
  assert.equal(contact.source,'instagram');assert.equal(contact.segment,'Eventos');assert.equal(JSON.parse(contact.custom_fields).lead_temperature,'hot');
  assert.equal(get('SELECT COUNT(*) AS count FROM contact_tags WHERE contact_id=?',[deal.contact_id]).count,4);
  const organization=get('SELECT phone,email,socials,website,segment FROM organizations WHERE name=?',['Empresa teste']);assert.equal(organization.email,'empresa@example.com');assert.equal(organization.segment,'Eventos');
});

test('cria negócio somente com título e mantém os dados complementares opcionais', async () => {
  const context = { user: { id: 1, role: 'manager', companyId: 1 } };
  const stage = get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.company_id=1 AND p.kind='sales' ORDER BY s.local_position LIMIT 1`);
  const deal = await routeApi({ method:'POST' }, null, new URL('http://local/api/deals'), { title:'Oportunidade sem cadastro completo', stage_id:stage.id }, context);
  assert.equal(deal.title, 'Oportunidade sem cadastro completo');
  assert.equal(deal.contact_name, 'Oportunidade sem cadastro completo');
  const contact = get('SELECT name,email,company FROM contacts WHERE id=?', [deal.contact_id]);
  assert.equal(contact.name, 'Oportunidade sem cadastro completo');
  assert.equal(contact.email, null);
  assert.equal(contact.company, null);
});

test('edita o lead e a oportunidade diretamente pelo card do pipeline', async () => {
  const context={user:{id:1,role:'manager',companyId:1}};
  const deal=get(`SELECT d.id FROM deals d JOIN contacts ct ON ct.id=d.contact_id WHERE ct.company_id=1 AND d.status='open' ORDER BY d.id DESC LIMIT 1`);
  const updated=await routeApi({method:'PATCH'},null,new URL(`http://local/api/deals/${deal.id}`),{title:'Oportunidade atualizada',value_cents:98700,score:81,expected_close_at:'2026-11-15',contact:{name:'Lead Atualizado',email:'lead.atualizado@example.com',phone:'+5511988887777',company:'Empresa Atualizada',source:'indicacao',segment:'Serviços',notes:'SDR alinhou retorno para sexta-feira.'}},context);
  assert.equal(updated.title,'Oportunidade atualizada');assert.equal(updated.contact_name,'Lead Atualizado');assert.equal(updated.company,'Empresa Atualizada');assert.equal(updated.value_cents,98700);assert.equal(updated.score,81);assert.equal(updated.source,'indicacao');assert.equal(updated.sdr_notes,'SDR alinhou retorno para sexta-feira.');
  const reassigned=await routeApi({method:'PATCH'},null,new URL(`http://local/api/deals/${deal.id}`),{owner_id:1},context);
  assert.equal(reassigned.owner_id,1);assert.ok(reassigned.owner_name);
});

test('cria tarefa pelo negócio e vincula automaticamente o contato correto', async () => {
  const context = { user: { id: 1, role: 'manager', companyId: 1 } };
  const stage = get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.company_id=1 AND p.kind='sales' ORDER BY s.local_position LIMIT 1`);
  const deal = await routeApi({ method:'POST' }, null, new URL('http://local/api/deals'), { title:'Negócio com próxima ação', contact_id:1, stage_id:stage.id }, context);
  const task = await routeApi({ method:'POST' }, null, new URL('http://local/api/tasks'), { title:'Fazer follow-up', deal_id:deal.id, assigned_to:1 }, context);
  assert.equal(task.deal_id, deal.id);
  assert.equal(task.contact_id, deal.contact_id);
  const activity = get("SELECT deal_id,contact_id FROM activities WHERE action='task_created' ORDER BY id DESC LIMIT 1");
  assert.equal(activity.deal_id, deal.id);
  assert.equal(activity.contact_id, deal.contact_id);
  await assert.rejects(() => routeApi({ method:'POST' }, null, new URL('http://local/api/tasks'), { title:'Vínculo incoerente', deal_id:deal.id, contact_id:2 }, context), /não pertence/);
});

test('exclui um negócio sem excluir o contato', async () => {
  const context={user:{id:1,role:'manager',companyId:1}};const stage=get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.kind='sales' ORDER BY s.local_position LIMIT 1`);
  const deal=await routeApi({method:'POST'},null,new URL('http://local/api/deals'),{title:'Negócio descartável',contact_id:1,stage_id:stage.id},context);
  await routeApi({method:'DELETE'},null,new URL(`http://local/api/deals/${deal.id}`),{},context);
  assert.equal(get('SELECT COUNT(*) AS count FROM deals WHERE id=?',[deal.id]).count,0);
  assert.equal(get('SELECT COUNT(*) AS count FROM contacts WHERE id=1').count,1);
});

test('personaliza etapas do pipeline por empresa e adiciona coluna', async () => {
  const context = { user: { id: 1, role: 'manager', companyId: 1 } };
  const pipeline = get("SELECT id FROM pipelines WHERE kind='sales' ORDER BY id LIMIT 1");
  const before = await routeApi({ method: 'GET' }, null, new URL(`http://local/api/pipeline?pipeline_id=${pipeline.id}`), {}, context);
  const stages = before.stages.map((stage,index)=>({id:stage.id,name:index===0?'Entrada personalizada':stage.name}));
  stages.push({name:'Negociação final'});
  await routeApi({ method: 'PUT' }, null, new URL(`http://local/api/pipelines/${pipeline.id}/stages`), { stages }, context);
  const after = await routeApi({ method: 'GET' }, null, new URL(`http://local/api/pipeline?pipeline_id=${pipeline.id}`), {}, context);
  assert.equal(after.stages[0].name, 'Entrada personalizada');
  assert.equal(after.stages.at(-1).name, 'Negociação final');
});

test('negócio ganho vai para o pipeline de clientes', async () => {
  const deal = get("SELECT id, contact_id FROM deals WHERE status='open' ORDER BY id LIMIT 1");
  await routeApi({ method: 'PATCH' }, null, new URL(`http://local/api/deals/${deal.id}`), { status: 'won' }, { user: { id: 1, role: 'manager' } });
  const moved = get(`SELECT d.status, p.kind, c.lifecycle FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id
    JOIN pipelines p ON p.id=s.pipeline_id JOIN contacts c ON c.id=d.contact_id WHERE d.id=?`, [deal.id]);
  assert.equal(moved.status, 'won');
  assert.equal(moved.kind, 'customers');
  assert.equal(moved.lifecycle, 'customer');
});

test('negócio perdido exige tratamento e cria retomada separada', async () => {
  const deal=get("SELECT id,contact_id FROM deals WHERE status='open' ORDER BY id LIMIT 1");
  const context={user:{id:1,role:'manager',companyId:1}};
  await assert.rejects(()=>routeApi({method:'PATCH'},null,new URL(`http://local/api/deals/${deal.id}`),{status:'lost',lost_reason:'Preço'},context),/Escolha/);
  await routeApi({method:'PATCH'},null,new URL(`http://local/api/deals/${deal.id}`),{status:'lost',lost_reason:'Preço',recovery_strategy:'retomada'},context);
  assert.equal(get('SELECT recovery_strategy FROM deals WHERE id=?',[deal.id]).recovery_strategy,'retomada');
  const recovery=get("SELECT d.status,p.name FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id JOIN pipelines p ON p.id=s.pipeline_id WHERE d.source_deal_id=?",[deal.id]);
  assert.equal(recovery.status,'open');assert.equal(recovery.name,'Retomada');
});

test('automatiza ganho e perda para etapas de outros funis', async()=>{
  const context={user:{id:1,role:'manager',companyId:1}};const source=get("SELECT id FROM pipelines WHERE kind='sales' LIMIT 1");const sourceStage=get('SELECT id FROM pipeline_stages WHERE pipeline_id=? ORDER BY local_position LIMIT 1',[source.id]);const target=get("SELECT s.id,s.pipeline_id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE lower(p.name)='retomada' ORDER BY s.local_position LIMIT 1");
  await routeApi({method:'PUT'},null,new URL('http://local/api/pipeline-outcome-rules'),{pipeline_id:source.id,won_stage_id:target.id,lost_stage_id:target.id},context);
  for(const outcome of ['won','lost']){const deal=await routeApi({method:'POST'},null,new URL('http://local/api/deals'),{title:`Automação ${outcome}`,contact_id:1,stage_id:sourceStage.id},context);const body=outcome==='won'?{status:'won'}:{status:'lost',lost_reason:'Sem prioridade',recovery_strategy:'arquivar'};await routeApi({method:'PATCH'},null,new URL(`http://local/api/deals/${deal.id}`),body,context);const followup=get("SELECT s.pipeline_id FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id WHERE d.source_deal_id=? AND d.status='open'",[deal.id]);assert.equal(followup.pipeline_id,target.pipeline_id);}
});

test('conversa avança o card automaticamente conforme os sinais configurados na etapa',async()=>{
  const context={user:{id:1,role:'manager',companyId:1}};const pipeline=get("SELECT id FROM pipelines WHERE kind='sales' ORDER BY is_default DESC,id LIMIT 1");
  const stages=db.prepare('SELECT id FROM pipeline_stages WHERE pipeline_id=? ORDER BY local_position').all(pipeline.id);const target=stages[2];
  await routeApi({method:'PUT'},null,new URL('http://local/api/pipeline-conversation-rules'),{pipeline_id:pipeline.id,rules:[{stage_id:target.id,trigger_phrases:['quero avançar','vamos marcar a apresentação']}]},context);
  const contactId=Number(run("INSERT INTO contacts(company_id,phone,name,company) VALUES (1,'+5511999990088','Lead automação','Empresa áudio')").lastInsertRowid);
  const conversationId=Number(run('INSERT INTO conversations(contact_id,assigned_to) VALUES (?,1)',[contactId]).lastInsertRowid);
  const deal=await routeApi({method:'POST'},null,new URL('http://local/api/deals'),{title:'Teste de avanço pela conversa',contact_id:contactId,stage_id:stages[0].id},context);
  const messageId=Number(run("INSERT INTO messages(conversation_id,direction,sender_type,content,status) VALUES (?,'inbound','contact',?,'received')",[conversationId,'Quero saber como funciona e quero avançar com vocês.']).lastInsertRowid);
  await processInboundMessage(conversationId,messageId);
  assert.equal(get('SELECT stage_id FROM deals WHERE id=?',[deal.id]).stage_id,target.id);
  const activity=get("SELECT description,metadata FROM activities WHERE deal_id=? AND action='conversation_stage_move' ORDER BY id DESC LIMIT 1",[deal.id]);assert.match(activity.description,/Conversa moveu/);assert.match(activity.metadata,/quero avançar/);
  const laterMessage=Number(run("INSERT INTO messages(conversation_id,direction,sender_type,content,status) VALUES (?,'inbound','contact',?,'received')",[conversationId,'Como funciona esse recurso no dia a dia?']).lastInsertRowid);await processInboundMessage(conversationId,laterMessage);assert.equal(get('SELECT stage_id FROM deals WHERE id=?',[deal.id]).stage_id,target.id,'a automação nunca deve regredir o card');
  const listed=await routeApi({method:'GET'},null,new URL(`http://local/api/pipeline-conversation-rules?pipeline_id=${pipeline.id}`),{},context);assert.deepEqual(listed[0].trigger_phrases,['quero avançar','vamos marcar a apresentação']);
});

test('tarefas podem ter todos os dados editados, ser reagendadas e excluídas', async()=>{
  const context={user:{id:1,role:'manager',companyId:1}};const due=new Date(Date.now()+3600000).toISOString();
  const task=await routeApi({method:'POST'},null,new URL('http://local/api/tasks'),{title:'Teste editável',assigned_to:1,due_at:due},context);
  const nextDue=new Date(Date.now()+7200000).toISOString();
  const changed=await routeApi({method:'PATCH'},null,new URL(`http://local/api/tasks/${task.id}`),{title:'Teste reagendado',description:'Descrição atualizada',due_at:nextDue,assigned_to:2,type:'meeting',priority:'high'},context);
  assert.equal(changed.title,'Teste reagendado');assert.equal(changed.description,'Descrição atualizada');assert.equal(changed.due_at,nextDue);assert.equal(changed.assigned_to,2);assert.equal(changed.type,'meeting');assert.equal(changed.priority,'high');
  await routeApi({method:'DELETE'},null,new URL(`http://local/api/tasks/${task.id}`),{},context);assert.equal(get('SELECT COUNT(*) n FROM tasks WHERE id=?',[task.id]).n,0);
});

test('ações em lote alteram somente tarefas selecionadas da empresa ativa', async()=>{
  const context={user:{id:1,role:'manager',companyId:1}};
  const first=await routeApi({method:'POST'},null,new URL('http://local/api/tasks'),{title:'Lote um',assigned_to:1},context);
  const second=await routeApi({method:'POST'},null,new URL('http://local/api/tasks'),{title:'Lote dois',assigned_to:1},context);
  const otherCompany=Number(run("INSERT INTO company_profiles(name,slug,status,created_by) VALUES ('Cliente tarefas','cliente-tarefas','active',1)").lastInsertRowid);
  const external=Number(run("INSERT INTO tasks(company_id,assigned_to,title,type,status,created_by) VALUES (?,1,'Não alterar','followup','pending','human')",[otherCompany]).lastInsertRowid);
  const ids=[first.id,second.id,external];const dueAt=new Date(Date.now()+86400000).toISOString();
  const updated=await routeApi({method:'PATCH'},null,new URL('http://local/api/tasks/bulk'),{ids,action:'update',assigned_to:2,due_at:dueAt},context);
  assert.equal(updated.updated,2);assert.equal(get('SELECT assigned_to FROM tasks WHERE id=?',[first.id]).assigned_to,2);assert.equal(get('SELECT due_at FROM tasks WHERE id=?',[second.id]).due_at,dueAt);
  await routeApi({method:'PATCH'},null,new URL('http://local/api/tasks/bulk'),{ids:[first.id,second.id],action:'move',type:'meeting'},context);
  assert.equal(get('SELECT type FROM tasks WHERE id=?',[first.id]).type,'meeting');
  await routeApi({method:'PATCH'},null,new URL('http://local/api/tasks/bulk'),{ids:[first.id,second.id],action:'reschedule',reschedule:'next-monday'},context);
  assert.equal(get('SELECT status FROM tasks WHERE id=?',[second.id]).status,'pending');
  await routeApi({method:'PATCH'},null,new URL('http://local/api/tasks/bulk'),{ids:[first.id,second.id,external],action:'complete'},context);
  assert.equal(get('SELECT status FROM tasks WHERE id=?',[first.id]).status,'completed');assert.equal(get('SELECT status FROM tasks WHERE id=?',[external]).status,'pending');
  const removed=await routeApi({method:'DELETE'},null,new URL('http://local/api/tasks/bulk'),{ids:[first.id,second.id,external]},context);
  assert.equal(removed.deleted,2);assert.equal(get('SELECT COUNT(*) n FROM tasks WHERE id=?',[external]).n,1);
});

test('agente aprende correções aprovadas e as aplica nas próximas simulações',async()=>{
  const context={user:{id:1,role:'manager',companyId:1}};
  const first=await routeApi({method:'POST'},null,new URL('http://local/api/agent/preview'),{question:'O serviço está caro, por que vale a pena?'},context);
  assert.ok(first.response);assert.ok(first.intent);
  const rule=await routeApi({method:'POST'},null,new URL('http://local/api/agent/learning'),{instruction:'Termine respostas comerciais com uma pergunta relevante.',applies_to:'Toda a jornada comercial',example_question:'Está caro',original_response:first.response,corrected_response:'Entendo sua preocupação. Qual resultado você quer priorizar?',source_type:'preview',approve:true},context);
  assert.equal(rule.status,'approved');
  const originalFetch=globalThis.fetch;process.env.AI_API_URL='https://modelo.test/chat/completions';process.env.AI_API_KEY='teste';process.env.AI_MODEL='modelo-real-teste';
  globalThis.fetch=async(_url,options)=>{const request=JSON.parse(options.body);assert.match(request.messages[0].content,new RegExp(`ID ${rule.id}`));return new Response(JSON.stringify({model:'modelo-real-teste',choices:[{message:{content:JSON.stringify({response:'Entendo sua preocupação. Qual resultado você quer priorizar?',applied_rule_ids:[rule.id]})}}],usage:{prompt_tokens:100,completion_tokens:18}}),{status:200,headers:{'content-type':'application/json'}});};
  let second;try{second=await routeApi({method:'POST'},null,new URL('http://local/api/agent/preview'),{question:'Quero entender melhor a proposta.'},context);}finally{globalThis.fetch=originalFetch;delete process.env.AI_API_URL;delete process.env.AI_API_KEY;delete process.env.AI_MODEL;}
  assert.equal(second.generation.live,true);assert.equal(second.generation.model,'modelo-real-teste');assert.deepEqual(second.applied_rules.map(item=>item.id),[rule.id]);
  const rules=await routeApi({method:'GET'},null,new URL('http://local/api/agent/learning'),{},context);assert.ok(rules.some(item=>item.id===rule.id&&item.applies_to==='Toda a jornada comercial'));
  await routeApi({method:'DELETE'},null,new URL(`http://local/api/agent/learning/${rule.id}`),{},context);
});

test('fallback local não afirma que regras foram aplicadas',async()=>{
  const context={user:{id:1,role:'manager',companyId:1}};const rule=await routeApi({method:'POST'},null,new URL('http://local/api/agent/learning'),{instruction:'Use uma saudação especial.',applies_to:'Saudação',source_type:'manual',approve:true},context);
  const preview=await routeApi({method:'POST'},null,new URL('http://local/api/agent/preview'),{question:'Quanto custa o serviço?'},context);
  assert.equal(preview.generation.live,false);assert.deepEqual(preview.applied_rules,[]);
  await routeApi({method:'DELETE'},null,new URL(`http://local/api/agent/learning/${rule.id}`),{},context);
});

test('reconhece o OIDC entregue pela Vercel no contexto da requisição',async()=>{
  const status=await runWithRequestContext({headers:{'x-vercel-oidc-token':'token-de-teste'}},async()=>agentModelStatus());
  assert.equal(status.configured,true);assert.equal(status.provider,'Vercel AI Gateway');assert.equal(status.model,'openai/gpt-5.4-mini');
});

test('protege credenciais da Meta e expõe apenas dados mascarados', async () => {
  const context = { user: { id: 1, role: 'manager' } };
  const saved = await routeApi({ method: 'PUT', headers: { host: 'localhost:3210' } }, null, new URL('http://local/api/meta/config'), {
    access_token: 'token-super-secreto', phone_number_id: '123456789', business_account_id: '987654321', app_secret: 'app-secret', verify_token: 'verify-secret', api_version: 'v23.0'
  }, context);
  assert.equal(saved.connected, false);
  assert.equal(saved.oauth_connected, false);
  assert.equal(saved.phone_number_id, '••••6789');
  assert.equal(Object.hasOwn(saved, 'access_token'), false);
  assert.doesNotMatch(get("SELECT value FROM settings WHERE key='integration:meta-whatsapp'").value, /token-super-secreto/);
  const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls+=1;return {ok:true,json:async()=>calls===1?{display_phone_number:'+55 11 99999-9999',verified_name:'Atenva Teste',quality_rating:'GREEN'}:{success:true}};};
  try{const connected=await routeApi({method:'POST'},null,new URL('http://local/api/meta/test'),{},context);assert.equal(connected.connected,true);assert.equal(connected.webhooks_subscribed,true);}finally{globalThis.fetch=originalFetch;}
});

test('Cloud API oficial isola empresas, roteia webhooks e tem prioridade sobre Evolution', async () => {
  const companyId=Number(run("INSERT INTO company_profiles(name,slug,status) VALUES ('Cliente Cloud','cliente-cloud','active')").lastInsertRowid);
  run("INSERT INTO user_company_memberships(company_id,user_id,role,is_active) VALUES (?,1,'owner',1)",[companyId]);
  const context={user:{id:1,role:'admin',companyRole:'owner',companyId}};
  await routeApi({method:'PUT'},null,new URL('http://local/api/meta/config'),{access_token:'cloud-token-2',phone_number_id:'222222',business_account_id:'333333',app_secret:'shared-app-secret',verify_token:'shared-verify-token',api_version:'v23.0'},context);
  const originalFetch=globalThis.fetch;let phase='connect';const requests=[];
  globalThis.fetch=async(url,options={})=>{requests.push({url:String(url),options});if(phase==='connect')return {ok:true,json:async()=>requests.length%2?{display_phone_number:'+55 11 98888-7777',verified_name:'Cliente Cloud',quality_rating:'GREEN'}:{success:true}};if(String(url).includes('/media'))return {ok:true,json:async()=>({id:'media-1'})};return {ok:true,json:async()=>({messages:[{id:'wamid.cloud'}]})};};
  try{
    const connected=await routeApi({method:'POST'},null,new URL('http://local/api/meta/test'),{},context);assert.equal(connected.connected,true);phase='send';requests.length=0;
    const sent=await sendWhatsAppText('551198887766','Mensagem oficial',companyId);assert.equal(sent.simulated,false);assert.match(requests[0].url,/222222\/messages/);assert.equal(requests[0].options.headers.Authorization,'Bearer cloud-token-2');
    const audio=await sendWhatsAppAudio('551198887766',Buffer.from('audio-test').toString('base64'),companyId);assert.equal(audio.simulated,false);assert.ok(requests.some(item=>item.url.includes('/222222/media')));
    await routeApi({method:'PUT'},null,new URL('http://local/api/agent/config'),{autonomy_level:0},context);
    const payload={object:'whatsapp_business_account',entry:[{id:'333333',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{display_phone_number:'551198887766',phone_number_id:'222222'},contacts:[{profile:{name:'Lead Oficial'},wa_id:'551197771111'}],messages:[{from:'551197771111',id:'wamid.inbound.cloud',timestamp:'1791840000',type:'text',text:{body:'Olá pela API oficial'}}]}}]}]};
    const result=await processWebhook(payload);assert.equal(result.length,1);assert.ok(get("SELECT 1 AS found FROM contacts WHERE company_id=? AND whatsapp_id='551197771111'",[companyId]).found);
  }finally{globalThis.fetch=originalFetch;}
});

test('Embedded Signup conecta um cliente em um fluxo e valida que o número pertence à WABA', async () => {
  const previous={META_APP_ID:process.env.META_APP_ID,META_APP_SECRET:process.env.META_APP_SECRET,META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID:process.env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID};
  Object.assign(process.env,{META_APP_ID:'embedded-app',META_APP_SECRET:'embedded-secret',META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID:'embedded-config'});
  const companyId=Number(run("INSERT INTO company_profiles(name,slug,status) VALUES ('Cliente Embedded','cliente-embedded','active')").lastInsertRowid);
  run("INSERT INTO user_company_memberships(company_id,user_id,role,is_active) VALUES (?,1,'owner',1)",[companyId]);
  const context={user:{id:1,role:'admin',companyRole:'owner',companyId}};const originalFetch=globalThis.fetch;const requests=[];
  globalThis.fetch=async(url,options={})=>{const address=String(url);requests.push({address,options});
    if(address.includes('/oauth/access_token'))return {ok:true,json:async()=>({access_token:'embedded-client-token'})};
    if(address.includes('/444444/phone_numbers'))return {ok:true,json:async()=>({data:[{id:'555555',verified_name:'Cliente Embedded',display_phone_number:'+55 11 95555-5555',quality_rating:'GREEN'},{id:'666666',verified_name:'Cliente Comercial',display_phone_number:'+55 11 96666-6666',quality_rating:'GREEN'}]})};
    if(address.includes('/444444/subscribed_apps'))return {ok:true,json:async()=>({success:true})};
    if(address.includes('/555555/register')||address.includes('/666666/register'))return {ok:true,json:async()=>({success:true})};
    if(address.includes('/444444?'))return {ok:true,json:async()=>({id:'444444',name:'WABA Cliente'})};
    return {ok:false,json:async()=>({error:{message:'requisição inesperada'}})};
  };
  try{
    await assert.rejects(()=>routeApi({method:'POST'},null,new URL('http://local/api/meta/whatsapp/embedded-signup'),{code:'one-time-code',waba_id:'444444',phone_number_id:'999999'},context),/não pertence/);
    const connected=await routeApi({method:'POST'},null,new URL('http://local/api/meta/whatsapp/embedded-signup'),{code:'one-time-code-2',waba_id:'444444',phone_number_id:'555555'},context);
    assert.equal(connected.connected,true);assert.equal(connected.onboarding_method,'embedded_signup');assert.equal(connected.two_step_pin_configured,true);assert.equal(connected.initial_sync.synced,true);
    assert.ok(requests.some(item=>item.address.includes('/444444/subscribed_apps')&&item.options.method==='POST'));
    const registration=requests.find(item=>item.address.includes('/555555/register'));assert.match(JSON.parse(registration.options.body).pin,/^\d{6}$/);
    assert.equal(publicMetaConfig(companyId).display_phone_number,'+55 11 95555-5555');
    const second=await routeApi({method:'POST'},null,new URL('http://local/api/meta/whatsapp/embedded-signup'),{code:'one-time-code-3',waba_id:'444444',phone_number_id:'666666'},context);
    assert.equal(second.whatsapp_numbers.length,2);assert.equal(second.whatsapp_numbers.find(number=>number.phone_number_id==='666666').active,true);
    const switched=await routeApi({method:'PUT'},null,new URL('http://local/api/meta/whatsapp/numbers/active'),{phone_number_id:'555555'},context);
    assert.equal(switched.whatsapp_numbers.find(number=>number.phone_number_id==='555555').active,true);
    assert.equal(switched.display_phone_number,'+55 11 95555-5555');
  }finally{globalThis.fetch=originalFetch;for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('qualifica Lead, MQL e SQL usando pontuação e Kanban', async () => {
  const context = { user: { id: 1, role: 'manager' } };
  const stages = await routeApi({ method: 'GET' }, null, new URL('http://local/api/qualification/config'), {}, context);
  await routeApi({ method: 'PUT' }, null, new URL('http://local/api/qualification/config'), {
    mql_min_score: 50, sql_min_score: 80, mql_stage_id: stages.stages[1].id, sql_stage_id: stages.stages[2].id, required_fields: ['phone', 'company'], auto_move: true
  }, context);
  assert.ok(get("SELECT COUNT(*) AS count FROM contacts WHERE qualification='mql'").count > 0);
  assert.ok(get("SELECT COUNT(*) AS count FROM contacts WHERE qualification='sql'").count > 0);
});

test('importa campanha de planilha, remove duplicados e exige consentimento', async () => {
  const context = { user: { id: 1, role: 'manager' } };
  const template = get("SELECT id FROM message_templates WHERE meta_name='retomar_interesse'");
  const csv = [
    'telefone;nome;consentimento;variavel_1',
    '11988887777;Carla Lima;sim;Carla',
    '11988887777;Carla duplicada;sim;Carla',
    '123;Telefone inválido;sim;Teste',
    '11977776666;Sem autorização;não;Pessoa',
    '11966665555;Consentimento ausente;;Pessoa'
  ].join('\n');
  const result = await routeApi({ method: 'POST' }, null, new URL('http://local/api/campaigns/import'), {
    name: 'Campanha segura', template_id: template.id, file_name: 'contatos.csv', data_base64: Buffer.from(csv).toString('base64')
  }, context);
  assert.equal(result.campaign.total_rows, 5);
  assert.equal(result.campaign.ready_count, 1);
  assert.equal(result.campaign.skipped_count, 4);
  assert.equal(result.recipients.filter(item => item.skip_reason === 'Duplicado na planilha').length, 1);
  await assert.rejects(() => routeApi({ method: 'POST' }, null, new URL(`http://local/api/campaigns/${result.campaign.id}/start`), { confirm_compliance: false, simulate: true }, context), /Confirme o consentimento/);
});

test('Master Atenva convida outro Master por link único e sem armazenar o token aberto', async () => {
  const created = run(`INSERT INTO users (name,email,password_hash,role,avatar,status,is_active,is_master,active_company_id)
    VALUES ('Master Teste','master@atenva.test',?,'admin','MT','online',1,1,1)`, [hashPassword('MasterTeste123')]);
  const master = { user: { id: Number(created.lastInsertRowid), role: 'admin', isMaster: true, companyId: 1, companyRole: 'owner' } };
  const invitation = await routeApi({ method: 'POST', headers: { host: 'localhost:3210' } }, null, new URL('http://local/api/invitations'), { email: 'novo.master@atenva.test', role: 'master', company_id: 1 }, master);
  const token = new URL(invitation.invite_url).searchParams.get('invite');
  assert.ok(token?.length > 30);
  assert.notEqual(get('SELECT token_hash FROM user_invitations WHERE id=?', [invitation.id]).token_hash, token);
  const preview = await routeApi({ method: 'GET', headers: { host: 'localhost:3210' } }, null, new URL(`http://local/api/invitations/${token}`), {}, null);
  assert.equal(preview.role, 'master');
  await routeApi({ method: 'POST', headers: { host: 'localhost:3210' } }, null, new URL(`http://local/api/invitations/${token}/accept`), { name: 'Novo Master', password: 'SenhaMaster123' }, null);
  const accepted = get('SELECT is_master,role FROM users WHERE email=?', ['novo.master@atenva.test']);
  assert.equal(accepted.is_master, 1);
  assert.equal(accepted.role, 'admin');
  await assert.rejects(() => routeApi({ method: 'GET', headers: { host: 'localhost:3210' } }, null, new URL(`http://local/api/invitations/${token}`), {}, null), /inválido ou expirou/);
});

test('administrador da empresa convida sua equipe, mas não pode criar Masters', async () => {
  const companyAdmin = { user: { id: 1, role: 'admin', isMaster: false, companyId: 1, companyRole: 'admin' } };
  await assert.rejects(() => routeApi({ method: 'POST', headers: { host: 'localhost:3210' } }, null, new URL('http://local/api/invitations'), { email: 'master.negado@empresa.test', role: 'master', company_id: 1 }, companyAdmin), /não pode conceder/);
  const invitation = await routeApi({ method: 'POST', headers: { host: 'localhost:3210' } }, null, new URL('http://local/api/invitations'), { email: 'admin.conta@empresa.test', role: 'admin', company_id: 999 }, companyAdmin);
  assert.equal(invitation.company_id, 1);
  assert.equal(invitation.role, 'admin');
});

test('isola contatos, tarefas, conhecimento e campanhas por empresa', async () => {
  const company = run("INSERT INTO company_profiles (name,slug,status,created_by) VALUES ('Empresa Isolada','empresa-isolada','active',1)");
  const companyId = Number(company.lastInsertRowid);
  const context = { user: { id: 1, role: 'admin', isMaster: true, companyId, companyRole: 'owner' } };
  const originalContacts = await routeApi({ method: 'GET' }, null, new URL('http://local/api/contacts'), {}, context);
  assert.equal(originalContacts.length, 0);
  await routeApi({ method: 'POST' }, null, new URL('http://local/api/tasks'), { title: 'Tarefa privada', assigned_to: 1, priority: 'high' }, context);
  await routeApi({ method: 'POST' }, null, new URL('http://local/api/knowledge'), { title: 'Playbook privado', category: 'Playbook', content: 'Objetivo: atender esta empresa' }, context);
  assert.equal((await routeApi({ method: 'GET' }, null, new URL('http://local/api/tasks'), {}, context)).length, 1);
  assert.equal((await routeApi({ method: 'GET' }, null, new URL('http://local/api/knowledge'), {}, context)).length, 1);
  const defaultContext = { user: { id: 1, role: 'admin', isMaster: true, companyId: 1, companyRole: 'owner' } };
  assert.equal((await routeApi({ method: 'GET' }, null, new URL('http://local/api/tasks'), {}, defaultContext)).some(item => item.title === 'Tarefa privada'), false);
  assert.equal((await routeApi({ method: 'GET' }, null, new URL('http://local/api/knowledge'), {}, defaultContext)).some(item => item.title === 'Playbook privado'), false);
});

test('isola pipelines, etapas e nomes iguais entre empresas', async () => {
  const masterContext = { user: { id: 1, role: 'admin', isMaster: true, companyId: 1, companyRole: 'owner' } };
  const company = await routeApi({ method: 'POST' }, null, new URL('http://local/api/companies'), { name: 'Empresa Pipeline Isolado' }, masterContext);
  const otherContext = { user: { ...masterContext.user, companyId: company.id } };
  const primaryPipelines = await routeApi({ method: 'GET' }, null, new URL('http://local/api/pipelines'), {}, masterContext);
  const otherPipelines = await routeApi({ method: 'GET' }, null, new URL('http://local/api/pipelines'), {}, otherContext);
  assert.ok(primaryPipelines.length >= 3);
  assert.equal(otherPipelines.length, primaryPipelines.length);
  assert.ok(otherPipelines.every(item => item.company_id === company.id));
  assert.equal(otherPipelines.some(item => primaryPipelines.some(primary => primary.id === item.id)), false);

  const primaryPrivate = await routeApi({ method: 'POST' }, null, new URL('http://local/api/pipelines'), { name: 'Pipeline com mesmo nome', stages: ['Entrada'] }, masterContext);
  const otherPrivate = await routeApi({ method: 'POST' }, null, new URL('http://local/api/pipelines'), { name: 'Pipeline com mesmo nome', stages: ['Entrada'] }, otherContext);
  assert.notEqual(primaryPrivate.id, otherPrivate.id);
  assert.equal(primaryPrivate.company_id, 1);
  assert.equal(otherPrivate.company_id, company.id);
  await assert.rejects(() => routeApi({ method: 'GET' }, null, new URL(`http://local/api/pipeline?pipeline_id=${primaryPrivate.id}`), {}, otherContext), /Funil não encontrado/);
  const otherStages = await routeApi({ method: 'GET' }, null, new URL('http://local/api/pipeline-stages'), {}, otherContext);
  assert.ok(otherStages.length > 0);
  assert.equal(otherStages.some(stage => stage.pipeline_id === primaryPrivate.id), false);
});

test('regressão 1/4: uma empresa não consegue ler nem editar o pipeline de outra',async()=>{
  const master={user:{id:1,role:'admin',isMaster:true,companyId:1,companyRole:'owner'}};
  const tenant=await routeApi({method:'POST'},null,new URL('http://local/api/companies'),{name:'Tenant de regressão'},master);
  const outsider={user:{...master.user,companyId:tenant.id}};
  const primary=await routeApi({method:'GET'},null,new URL('http://local/api/pipeline'),{},master);
  const originalNames=primary.stages.map(stage=>stage.name);
  await assert.rejects(()=>routeApi({method:'PUT'},null,new URL(`http://local/api/pipelines/${primary.pipeline.id}/stages`),{stages:primary.stages.map((stage,index)=>({id:stage.id,name:`Invadida ${index}`}))},outsider),/Funil não encontrado/);
  const unchanged=await routeApi({method:'GET'},null,new URL(`http://local/api/pipeline?pipeline_id=${primary.pipeline.id}`),{},master);
  assert.deepEqual(unchanged.stages.map(stage=>stage.name),originalNames);
});

test('regressão 2/4: modelo real só informa regras pertinentes e IDs aprovados',async()=>{
  const context={user:{id:1,role:'manager',companyId:1}};
  const priceRule=await routeApi({method:'POST'},null,new URL('http://local/api/agent/learning'),{instruction:'Pergunte o orçamento disponível.',applies_to:'Preço e objeções',source_type:'manual',approve:true},context);
  const scheduleRule=await routeApi({method:'POST'},null,new URL('http://local/api/agent/learning'),{instruction:'Ofereça horários amanhã.',applies_to:'Agendamento',source_type:'manual',approve:true},context);
  const originalFetch=globalThis.fetch;process.env.AI_API_URL='https://modelo.test/chat/completions';process.env.AI_API_KEY='teste';process.env.AI_MODEL='modelo-regressao';
  globalThis.fetch=async(_url,options)=>{const request=JSON.parse(options.body);assert.match(request.messages[0].content,new RegExp(`ID ${priceRule.id}`));assert.doesNotMatch(request.messages[0].content,new RegExp(`ID ${scheduleRule.id}`));return new Response(JSON.stringify({model:'modelo-regressao',choices:[{message:{content:JSON.stringify({response:'Entendo. Qual orçamento você reservou?',applied_rule_ids:[priceRule.id,scheduleRule.id,999999]})}}]}),{status:200,headers:{'content-type':'application/json'}});};
  let preview;try{preview=await routeApi({method:'POST'},null,new URL('http://local/api/agent/preview'),{question:'Achei o preço alto.'},context);}finally{globalThis.fetch=originalFetch;delete process.env.AI_API_URL;delete process.env.AI_API_KEY;delete process.env.AI_MODEL;}
  assert.equal(preview.generation.live,true,preview.generation.error);assert.deepEqual(preview.applied_rules.map(rule=>rule.id),[priceRule.id]);
  await routeApi({method:'DELETE'},null,new URL(`http://local/api/agent/learning/${priceRule.id}`),{},context);await routeApi({method:'DELETE'},null,new URL(`http://local/api/agent/learning/${scheduleRule.id}`),{},context);
});

test('regressão 3/4: Evolution permanece compatível no backend, mas sai da interface oficial',()=>{
  assert.deepEqual(['unavailable','not_created','connecting','disconnected','connected'].map(state=>describeEvolutionState(state).lifecycle),['infrastructure_offline','ready_to_create','awaiting_qr','disconnected','connected']);
  const app=readFileSync(join(root,'public','app.js'),'utf8');
  const integrationView=app.slice(app.indexOf('async function renderMeta()'),app.indexOf('let facebookSdkPromise'));
  assert.doesNotMatch(integrationView,/evolution/i);assert.match(integrationView,/WhatsApp oficial/);assert.match(integrationView,/\/api\/meta\/businesses/);
});

test('regressão 4/4: OAuth Google e Meta pertence exclusivamente ao perfil que iniciou a conexão',async()=>{
  const previous={GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET:process.env.GOOGLE_CLIENT_SECRET,GOOGLE_REDIRECT_URI:process.env.GOOGLE_REDIRECT_URI,META_APP_ID:process.env.META_APP_ID,META_APP_SECRET:process.env.META_APP_SECRET,META_REDIRECT_URI:process.env.META_REDIRECT_URI};
  Object.assign(process.env,{GOOGLE_CLIENT_ID:'google-client-test',GOOGLE_CLIENT_SECRET:'google-secret-test',GOOGLE_REDIRECT_URI:'https://crm.test/google/callback',META_APP_ID:'meta-app-test',META_APP_SECRET:'meta-secret-test',META_REDIRECT_URI:'https://crm.test/meta/callback'});
  const companyA=Number(run("INSERT INTO company_profiles(name,slug,status,created_by) VALUES ('OAuth A','oauth-a','active',1)").lastInsertRowid);const companyB=Number(run("INSERT INTO company_profiles(name,slug,status,created_by) VALUES ('OAuth B','oauth-b','active',1)").lastInsertRowid);
  const userA={id:701,companyId:companyA,email:'a@crm.test'};const userB={id:702,companyId:companyB,email:'b@crm.test'};
  const googleUrl=new URL(googleAuthorizationUrl(userA));const metaUrl=new URL(metaAuthorizationUrl(userA));
  await assert.rejects(()=>completeGoogleAuthorization({code:'code',state:googleUrl.searchParams.get('state'),user:userB}),/outro perfil/);await assert.rejects(()=>completeMetaAuthorization({code:'code',state:metaUrl.searchParams.get('state'),user:userB}),/outro perfil/);
  const originalFetch=globalThis.fetch;globalThis.fetch=async url=>String(url).includes('googleapis.com')?new Response(JSON.stringify({access_token:'google-access-a',refresh_token:'google-refresh-a',expires_in:3600,id_token:`x.${Buffer.from(JSON.stringify({email:'a@crm.test'})).toString('base64url')}.x`}),{status:200,headers:{'content-type':'application/json'}}):new Response(JSON.stringify({access_token:'meta-access-a'}),{status:200,headers:{'content-type':'application/json'}});
  try{await completeGoogleAuthorization({code:'google-code',state:googleUrl.searchParams.get('state'),user:userA});await completeMetaAuthorization({code:'meta-code',state:metaUrl.searchParams.get('state'),user:userA});}finally{globalThis.fetch=originalFetch;for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  assert.equal(googleStatus(companyA).connected,true);assert.equal(googleStatus(companyA).email,'a@crm.test');assert.equal(googleStatus(companyB).connected,false);assert.equal(publicMetaConfig(companyA).oauth_connected,true);assert.equal(publicMetaConfig(companyB).oauth_connected,false);
});

test('OAuth retorna ao mesmo domínio em que a conexão foi iniciada',async()=>{
  const keys=['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI','META_APP_ID','META_APP_SECRET','META_REDIRECT_URI','META_MARKETING_LOGIN_CONFIG_ID'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{GOOGLE_CLIENT_ID:'google-domain-test',GOOGLE_CLIENT_SECRET:'google-secret',GOOGLE_REDIRECT_URI:'https://canonical.test/api/integrations/google/callback',META_APP_ID:'meta-domain-test',META_APP_SECRET:'meta-secret',META_REDIRECT_URI:'https://canonical.test/api/integrations/meta/callback',META_MARKETING_LOGIN_CONFIG_ID:''});
  const user={id:1,companyId:1,email:'admin@atenva.test'};
  const googleRedirect='https://mais-tracao-atenva.vercel.app/api/integrations/google/callback';
  const metaRedirect='https://mais-tracao-atenva.vercel.app/api/integrations/meta/callback';
  const googleUrl=new URL(googleAuthorizationUrl(user,googleRedirect));
  const metaUrl=new URL(metaAuthorizationUrl(user,metaRedirect));
  assert.equal(googleUrl.searchParams.get('redirect_uri'),googleRedirect);
  assert.equal(metaUrl.searchParams.get('redirect_uri'),metaRedirect);
  let exchangedGoogleRedirect='';let exchangedMetaRedirect='';const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    const address=String(url);
    if(address==='https://oauth2.googleapis.com/token'){exchangedGoogleRedirect=new URLSearchParams(options.body).get('redirect_uri');return new Response(JSON.stringify({access_token:'domain-google-token',refresh_token:'domain-google-refresh',expires_in:3600}),{status:200});}
    if(address.includes('/oauth/access_token')){exchangedMetaRedirect=new URL(address).searchParams.get('redirect_uri');return new Response(JSON.stringify({access_token:'domain-meta-token'}),{status:200});}
    return new Response(JSON.stringify({error:{message:'sync indisponível no teste'}}),{status:400});
  };
  try{await completeGoogleAuthorization({code:'google-code',state:googleUrl.searchParams.get('state'),user});await completeMetaAuthorization({code:'meta-code',state:metaUrl.searchParams.get('state'),user});}
  finally{globalThis.fetch=originalFetch;for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
  assert.equal(exchangedGoogleRedirect,googleRedirect);
  assert.equal(exchangedMetaRedirect,metaRedirect);
});

test('conexões Google e Meta executam a primeira sincronização automaticamente',async()=>{
  const previous={GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET:process.env.GOOGLE_CLIENT_SECRET,GOOGLE_REDIRECT_URI:process.env.GOOGLE_REDIRECT_URI,META_APP_ID:process.env.META_APP_ID,META_APP_SECRET:process.env.META_APP_SECRET,META_REDIRECT_URI:process.env.META_REDIRECT_URI,META_ENABLE_LEADS_RETRIEVAL:process.env.META_ENABLE_LEADS_RETRIEVAL};
  Object.assign(process.env,{GOOGLE_CLIENT_ID:'auto-google',GOOGLE_CLIENT_SECRET:'auto-google-secret',GOOGLE_REDIRECT_URI:'https://crm.test/google/callback',META_APP_ID:'auto-meta',META_APP_SECRET:'auto-meta-secret',META_REDIRECT_URI:'https://crm.test/meta/callback',META_ENABLE_LEADS_RETRIEVAL:'false'});
  const companyId=Number(run("INSERT INTO company_profiles(name,slug,status,created_by) VALUES ('Sincronização Automática','sync-auto','active',1)").lastInsertRowid);const user={id:1,companyId,email:'admin@sync.test'};
  const googleState=new URL(googleAuthorizationUrl(user)).searchParams.get('state');const metaState=new URL(metaAuthorizationUrl(user)).searchParams.get('state');const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{const address=String(url);
    if(address==='https://oauth2.googleapis.com/token')return new Response(JSON.stringify({access_token:'google-auto-token',refresh_token:'google-auto-refresh',expires_in:3600}),{status:200,headers:{'content-type':'application/json'}});
    if(address.includes('googleapis.com/calendar/v3'))return new Response(JSON.stringify({items:[{id:'calendar-auto-1',summary:'Reunião importada',start:{dateTime:'2026-10-20T14:00:00-03:00'},end:{dateTime:'2026-10-20T15:00:00-03:00'}}]}),{status:200,headers:{'content-type':'application/json'}});
    if(address.includes('/oauth/access_token'))return new Response(JSON.stringify({access_token:'meta-auto-token'}),{status:200,headers:{'content-type':'application/json'}});
    if(address.includes('/me/adaccounts'))return new Response(JSON.stringify({data:[{id:'act_123456',name:'Conta principal'}]}),{status:200,headers:{'content-type':'application/json'}});
    if(address.includes('/me/accounts'))return new Response(JSON.stringify({data:[{id:'page-1',name:'Página principal',category:'Empresa'}]}),{status:200,headers:{'content-type':'application/json'}});
    if(address.includes('/act_123456/insights'))return new Response(JSON.stringify({data:[{date_start:'2026-10-14',impressions:'100',reach:'80',clicks:'12',spend:'30',actions:[{action_type:'lead',value:'3'}]}]}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({error:{message:'requisição inesperada'}}),{status:400,headers:{'content-type':'application/json'}});
  };
  try{const google=await completeGoogleAuthorization({code:'google-auto-code',state:googleState,user});const meta=await completeMetaAuthorization({code:'meta-auto-code',state:metaState,user});assert.equal(google.initial_sync.synced,true);assert.equal(google.initial_sync.events,1);assert.ok(get("SELECT 1 AS found FROM tasks WHERE company_id=? AND google_event_id='calendar-auto-1'",[companyId]).found);assert.equal(meta.initial_sync.synced,true);assert.equal(meta.initial_sync.accounts,1);assert.equal(meta.ad_accounts_connected,1);assert.equal(meta.pages_connected,1);assert.ok(meta.marketing_last_synced_at);}finally{globalThis.fetch=originalFetch;for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('Google lista e sincroniza todas as agendas selecionadas sem colidir eventos',async()=>{
  const previous={GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET:process.env.GOOGLE_CLIENT_SECRET,GOOGLE_REDIRECT_URI:process.env.GOOGLE_REDIRECT_URI};
  Object.assign(process.env,{GOOGLE_CLIENT_ID:'multi-google',GOOGLE_CLIENT_SECRET:'multi-secret',GOOGLE_REDIRECT_URI:'https://crm.test/google/callback'});
  const companyId=Number(run("INSERT INTO company_profiles(name,slug,status,created_by) VALUES ('Agendas Múltiplas','agendas-multiplas','active',1)").lastInsertRowid);const user={id:1,companyId,email:'agenda@crm.test'};
  const state=new URL(googleAuthorizationUrl(user)).searchParams.get('state');const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{const address=String(url);
    if(address==='https://oauth2.googleapis.com/token')return new Response(JSON.stringify({access_token:'multi-token',refresh_token:'multi-refresh',expires_in:3600,scope:'openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly'}),{status:200,headers:{'content-type':'application/json'}});
    if(address.includes('/users/me/calendarList'))return new Response(JSON.stringify({items:[{id:'principal@crm.test',summary:'Agenda principal',primary:true,selected:true,accessRole:'owner'},{id:'vendas@crm.test',summary:'Equipe de vendas',selected:true,accessRole:'writer'}]}),{status:200,headers:{'content-type':'application/json'}});
    if(address.includes('/calendars/principal%40crm.test/events'))return new Response(JSON.stringify({items:[{id:'evento-igual',summary:'Reunião principal',start:{dateTime:'2026-10-22T10:00:00-03:00'},end:{dateTime:'2026-10-22T11:00:00-03:00'}}]}),{status:200,headers:{'content-type':'application/json'}});
    if(address.includes('/calendars/vendas%40crm.test/events'))return new Response(JSON.stringify({items:[{id:'evento-igual',summary:'Reunião de vendas',start:{dateTime:'2026-10-22T14:00:00-03:00'},end:{dateTime:'2026-10-22T15:00:00-03:00'}}]}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({error:{message:'requisição inesperada'}}),{status:400,headers:{'content-type':'application/json'}});
  };
  try{const connected=await completeGoogleAuthorization({code:'multi-code',state,user});const calendars=await googleCalendars(companyId);const events=await googleCalendarEvents(companyId,'2026-10-22','2026-10-22');assert.equal(connected.initial_sync.events,2);assert.equal(connected.initial_sync.calendars,2);assert.equal(calendars.length,2);assert.equal(events.length,2);assert.notEqual(events[0].id,events[1].id);assert.equal(get("SELECT count(*) AS total FROM tasks WHERE company_id=? AND google_event_id='evento-igual'",[companyId]).total,2);assert.equal(googleStatus(companyId).needs_reconnect,false);}finally{globalThis.fetch=originalFetch;for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('tour assistido aponta para ações reais e usa o nome Integrações', () => {
  const app = readFileSync(join(root, 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const css = readFileSync(join(root, 'public', 'styles.css'), 'utf8');
  assert.match(app, /Clique no card destacado para continuar/);
  assert.match(app, /Clique em Personalizar para conhecer as opções/);
  assert.match(app, /Clique em Calendário para abrir a visão mensal/);
  assert.match(app, /view:'meta',selector:'\.official-meta-details'/);
  assert.doesNotMatch(app, /selector:'\.integration-hub'/);
  assert.match(app, /connectEvolutionFlow[\s\S]*stopSystemTour\(false\)/);
  assert.match(app, /target\.addEventListener\('click',activeTourClickHandler/);
  assert.match(app, /addEventListener\('scroll'.*positionTour\(activeTourTarget\)/);
  assert.match(css, /\.product-tour-card\{[^}]*max-height:calc\(100dvh - 32px\)[^}]*overflow:auto/);
  assert.doesNotMatch(app, /WhatsApp & Meta/);
  assert.match(html, /id="product-tour-instruction"/);
});

test('central de notificações abre um painel com pendências e atalhos', () => {
  const app = readFileSync(join(root, 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const css = readFileSync(join(root, 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="notification-button"/);
  assert.match(html, /id="notification-panel"[^>]*hidden/);
  assert.match(app, /async function refreshNotifications/);
  assert.match(app, /data-notification-view/);
  assert.match(app, /notification-button.*addEventListener\('click'/s);
  assert.match(css, /\.notification-panel\{/);
});

test('tarefas exibem edição completa na lista e no calendário', () => {
  const app = readFileSync(join(root, 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const css = readFileSync(join(root, 'public', 'styles.css'), 'utf8');
  assert.match(html, /name="due_date" type="date"/);
  assert.match(html, /name="due_time" type="time"/);
  assert.match(html, /name="description"/);
  assert.match(html, /name="type"/);
  assert.match(app, /data-task-edit-button/);
  assert.match(app, /openTaskModal\(null,task\)/);
  assert.match(app, /taskId\?'PATCH':'POST'/);
  assert.match(app, /data-task-drop="tomorrow"/);
  assert.match(app, /data-task-drop="two-days"/);
  assert.match(app, /data-task-drop="next-monday"/);
  assert.match(app, /data-task-drop="next-month"/);
  assert.match(app, /data-task-drop="done"/);
  assert.match(app, /function bindTaskDragAndDrop/);
  assert.match(app, /rescheduledTaskDate/);
  assert.match(app, /data-select-task/);
  assert.match(app, /id="task-bulk-toolbar"/);
  assert.match(app, /data-task-bulk="complete"/);
  assert.match(app, /data-task-bulk="edit"/);
  assert.match(app, /data-task-bulk="reschedule"/);
  assert.match(app, /data-task-bulk="move"/);
  assert.match(app, /data-task-bulk="delete"/);
  assert.match(app, /\/api\/tasks\/bulk/);
  assert.match(app, /data-task-delete-button/);
  assert.match(app, /data-task-complete-button/);
  assert.match(app, /data-task-edit-button[\s\S]{0,160}Editar<\/button>/);
  assert.match(app, /data-task-delete-button[\s\S]{0,160}Excluir<\/button>/);
  assert.match(app, /'Reabrir':'Concluir'/);
  assert.match(css, /\.task-action-button\{/);
  assert.match(css, /\.task-action-button\.delete/);
  assert.match(css, /\.task-action-button\.complete/);
  assert.match(css, /\.task-bulk-toolbar\{/);
  assert.match(css, /\.task-drag-active \.task-drop-actions/);
});

test('contatos exibem filtros compactos alinhados ao design do sistema',()=>{
  const app=readFileSync(join(root,'public','app.js'),'utf8');
  const css=readFileSync(join(root,'public','styles.css'),'utf8');
  assert.match(app,/class="contact-filters-heading"/);
  assert.match(app,/class="contact-filter-grid"/);
  assert.match(app,/id="clear-contact-filters"/);
  assert.match(app,/Etapa comercial/);
  assert.match(css,/\.contact-filter-control select\{/);
  assert.match(css,/font-family:inherit/);
  assert.match(css,/@media\(max-width:560px\)\{\.contact-filter-grid/);
});

test('conhecimento exibe estado vazio e nunca deixa a navegação em branco', () => {
  const app=readFileSync(join(root,'public','app.js'),'utf8');
  const css=readFileSync(join(root,'public','styles.css'),'utf8');
  assert.match(app,/class="knowledge-empty"/);
  assert.match(app,/Adicionar primeiro conhecimento/);
  assert.match(app,/id="retry-knowledge"/);
  assert.match(app,/class="view-load-error"/);
  assert.match(app,/data-retry-view/);
  assert.match(css,/\.knowledge-empty,/);
  assert.match(css,/\.view-load-error/);
});

test('agente possui laboratório e correção viva dentro das conversas',()=>{
  const app=readFileSync(join(root,'public','app.js'),'utf8');const html=readFileSync(join(root,'public','index.html'),'utf8');const css=readFileSync(join(root,'public','styles.css'),'utf8');
  assert.match(app,/Laboratório do agente/);assert.match(app,/Playbook vivo/);assert.match(app,/data-correct-ai/);assert.match(app,/Autoevolução supervisionada/);assert.match(app,/\/api\/agent\/preview/);assert.match(app,/\/api\/agent\/learning/);
  assert.match(app,/Modelo pronto/);assert.match(app,/Regras realmente aplicadas/);assert.match(app,/Nenhuma regra evolutiva foi aplicada nesta resposta/);
  assert.match(html,/id="knowledge-form"[\s\S]*Contexto livre/);assert.match(html,/não há categorias obrigatórias/);assert.doesNotMatch(html,/id="knowledge-form"[\s\S]{0,1200}<label>Categoria<select name="category">/);
  assert.match(app,/selector:'\[data-add-knowledge\]'/);
  assert.match(css,/\.agent-learning-lab/);assert.match(css,/\.ai-correction-button/);
});

test('pipeline oferece botão e card para criar novo negócio', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /id="deal-modal"/);
  assert.match(html, /id="deal-form"/);
  assert.match(html, /id="new-deal-contact-fields"/);
  assert.match(html, /name="contact_source"/);
  assert.match(html, /name="contact_tags"/);
  assert.match(html, /name="lead_temperature"/);
  assert.match(html, /name="company_socials"/);
  assert.match(html, /name="company_website"/);
  assert.match(app, /id="new-deal"/);
  assert.match(app, /class="new-deal-card"/);
  assert.match(app, /api\('\/api\/deals', \{ method: 'POST'/);
  assert.match(app, /Criar um novo lead agora/);
  assert.match(app, /data-create-deal-task/);
  assert.match(app, /class="deal-task-button"/);
  assert.match(app, /openTaskModal\(null,null,deal\)/);
  assert.doesNotMatch(app, /data-win-deal/);
  assert.doesNotMatch(app, /data-lose-deal/);
  assert.match(css, /\.deal-task-button/);
  assert.doesNotMatch(app, /class="ai-deal-summary">\$\{icon\('spark'\)\}/);
  assert.doesNotMatch(app, /contact_first_name'\)\.required/);
  assert.match(html, /name="deal_id"/);
  assert.match(html, /Novo lead \(opcional\)/);
  assert.match(css, /\.new-deal-card/);
});

test('pipeline oferece editor para renomear, ordenar, adicionar e remover etapas', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="edit-pipeline-modal"/);
  assert.match(html, /id="add-pipeline-stage"/);
  assert.match(app, /id="edit-pipeline"/);
  assert.match(app, /data-remove-stage/);
  assert.match(app, /\/stages`,\{method:'PUT'/);
  assert.match(html, /id="won-outcome-stage"/);
  assert.match(html, /id="lost-outcome-stage"/);
  assert.match(app, /pipeline-outcome-rules/);
  assert.match(app,/data-stage-triggers/);assert.match(app,/pipeline-conversation-rules/);assert.match(html,/sinais da conversa/);
});

test('pipeline mostra destinos de arraste para excluir, perder e ganhar', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(app,/data-deal-drop="delete"/);assert.match(app,/data-deal-drop="lost"/);assert.match(app,/data-deal-drop="won"/);
  assert.match(app,/method:'DELETE'/);assert.match(css,/\.pipeline-drop-actions/);assert.match(css,/\.pipeline-drag-active/);
});

test('Master provisiona um cliente vendável com ambiente, plano, módulos e convite próprios', async () => {
  const master={user:{id:1,name:'Master Atenva',role:'admin',isMaster:true,companyId:1,companyRole:'owner'}};
  const result=await routeApi({method:'POST',headers:{host:'crm.atenva.test','x-forwarded-proto':'https'}},null,new URL('https://crm.atenva.test/api/clients'),{
    name:'Cliente Modular Teste',admin_name:'Gestora Cliente',admin_email:'gestora.modular@cliente.test',plan:'starter',status:'trial',max_users:3
  },master);
  assert.equal(result.company.plan,'starter');
  assert.equal(result.company.status,'trial');
  assert.equal(result.company.max_users,3);
  assert.equal(result.company.access_url,'https://crm.atenva.test/cliente-modular-teste');
  assert.match(result.invitation.invite_url,/^https:\/\/crm\.atenva\.test\/cliente-modular-teste\?invite=/);
  assert.ok(get('SELECT COUNT(*) AS count FROM pipelines WHERE company_id=?',[result.company.id]).count>=3);
  assert.ok(get('SELECT 1 AS found FROM company_agent_config WHERE company_id=?',[result.company.id]).found);
  assert.ok(get('SELECT 1 AS found FROM company_qualification_config WHERE company_id=?',[result.company.id]).found);
  const token=new URL(result.invitation.invite_url).searchParams.get('invite');
  assert.notEqual(get('SELECT token_hash FROM user_invitations WHERE id=?',[result.invitation.id]).token_hash,token);
});

test('cliente comum não provisiona tenants e suspensão bloqueia a troca de ambiente', async () => {
  const company=get("SELECT * FROM company_profiles WHERE slug='cliente-modular-teste'");
  const customer={user:{id:1,name:'Cliente',role:'admin',isMaster:false,companyId:company.id,companyRole:'admin'}};
  await assert.rejects(()=>routeApi({method:'POST'},null,new URL('http://local/api/clients'),{name:'Tenant indevido',admin_name:'Pessoa',admin_email:'pessoa@indevido.test'},customer),/Somente o Onboarding Manager/);
  const master={user:{id:1,name:'Master Atenva',role:'admin',isMaster:true,companyId:1,companyRole:'owner'}};
  await routeApi({method:'PATCH'},null,new URL(`http://local/api/companies/${company.id}`),{status:'suspended'},master);
  await assert.rejects(()=>routeApi({method:'POST'},null,new URL(`http://local/api/companies/${company.id}/activate`),{},customer),/não possui acesso/);
});

test('interface aceita URLs dinâmicas para qualquer cliente e só o Master vê o provisionamento', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(app,/const cleanDynamic = path\.match/);
  assert.match(app,/const legacyDynamic = path\.match/);
  assert.match(app,/\/api\/clients/);
  assert.match(app,/new-company-button'\)\.hidden = !user\.isMaster/);
  assert.ok(server.includes('api\\/public\\/companies'));
});

test('Onboarding Manager entra pela Atenva padrão e mantém acesso a todas as contas', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(app,/Onboarding Manager/);
  assert.match(app,/Central de clientes Atenva/);
  assert.match(app,/state\.user\.isMaster \? companies\.find\(company => Number\(company\.id\)===1\) : null/);
  assert.match(app,/Number\(company\.id\)===1&&state\.user\?\.isMaster\?'\/':`\/\$\{company\.slug\}`/);
  assert.match(app,/location\.hostname\.startsWith\('mais-tracao-atenva'\)/);
});

test('links de novos clientes usam o domínio Atenva que fez o provisionamento', async () => {
  const master={user:{id:1,name:'Onboarding Manager',role:'admin',isMaster:true,companyId:1,companyRole:'owner'}};
  const result=await routeApi({method:'POST',headers:{host:'atenva.vercel.app','x-forwarded-proto':'https'}},null,new URL('https://atenva.vercel.app/api/clients'),{
    name:'Cliente pelo Portal Atenva',admin_name:'Cliente Portal',admin_email:'cliente.portal@empresa.test',plan:'business',status:'active',max_users:10
  },master);
  assert.match(result.company.access_url,/^https:\/\/atenva\.vercel\.app\/cliente-pelo-portal-atenva$/);
  assert.match(result.invitation.invite_url,/^https:\/\/atenva\.vercel\.app\/cliente-pelo-portal-atenva\?invite=/);
});

test('login pela URL da empresa seleciona o tenant correto e bloqueia acesso cruzado', () => {
  const companyA=Number(run("INSERT INTO company_profiles(name,slug,status) VALUES ('Empresa Login A','empresa-login-a','active')").lastInsertRowid);
  const companyB=Number(run("INSERT INTO company_profiles(name,slug,status) VALUES ('Empresa Login B','empresa-login-b','active')").lastInsertRowid);
  const userId=Number(run(`INSERT INTO users(name,email,password_hash,role,is_active,active_company_id)
    VALUES ('Admin Tenant','admin.tenant@login.test',?,'admin',1,?)`,[hashPassword('SenhaTenant2026'),companyB]).lastInsertRowid);
  run("INSERT INTO user_company_memberships(company_id,user_id,role,is_active) VALUES (?,?,'admin',1)",[companyA,userId]);
  const selected=login({email:'admin.tenant@login.test',password:'SenhaTenant2026',companySlug:'empresa-login-a',ip:'127.0.0.1',userAgent:'test'});
  assert.equal(selected.user.companyId,companyA);
  const denied=login({email:'admin.tenant@login.test',password:'SenhaTenant2026',companySlug:'empresa-login-b',ip:'127.0.0.1',userAgent:'test'});
  assert.equal(denied.tenantDenied,true);
});

test('slug reservado recebe sufixo de cliente e não conflita com rotas do sistema', async () => {
  const master={user:{id:1,name:'Onboarding Manager',role:'admin',isMaster:true,companyId:1,companyRole:'owner'}};
  const result=await routeApi({method:'POST',headers:{host:'atenva-crm.vercel.app','x-forwarded-proto':'https'}},null,new URL('https://atenva-crm.vercel.app/api/clients'),{
    name:'Admin',admin_name:'Admin Cliente',admin_email:'admin.slug@empresa.test',status:'active'
  },master);
  assert.equal(result.company.slug,'admin-cliente');
  assert.equal(result.company.access_url,'https://atenva-crm.vercel.app/admin-cliente');
});

test('tarefas deixam a seleção em lote explícita e acessível', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(app,/id="select-visible-tasks"/);
  assert.match(app,/Selecionar todas as tarefas exibidas/);
  assert.match(css,/\.task-selection-guide\{/);
});

test('administração usa blocos expansíveis e oferece ajuste de texto', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(app,/class="admin-quick-grid"/);
  assert.match(app,/class="admin-section/);
  assert.match(app,/id="admin-text-size"/);
  assert.match(app,/addEventListener\('click',openTextSizeSettings\)/);
  assert.match(css,/\.admin-section>summary\{/);
});

test('dashboard expõe listas resumidas e tooltips amplos', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const api=readFileSync(new URL('../src/api.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(api,/metricDetails/);
  assert.match(app,/class="metric-detail-list"/);
  assert.match(app,/data-chart-tip=/);
  assert.match(css,/\.chart-hover-target::after/);
});

test('disparos usa um fluxo compacto sem ícone substituto gigante', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(app,/class="campaign-steps"/);
  assert.match(app,/class="compact-feature-icon"/);
  assert.match(css,/\.campaign-steps\{/);
  assert.doesNotMatch(app,/: icon\('send'\)<\/div>\$\{selectedExisting/);
});

test('laboratório do agente usa sessões e aplica comandos auditáveis ao WhatsApp', async () => {
  const company=get('SELECT id FROM company_profiles ORDER BY id LIMIT 1');
  const admin={user:{id:1,name:'Administrador',role:'admin',isMaster:false,companyId:company.id,companyRole:'admin'}};
  const session=await routeApi({method:'POST'},null,new URL('http://local/api/agent/command/sessions'),{},admin);
  assert.equal(session.company_id,company.id);
  const response=await routeApi({method:'POST'},null,new URL(`http://local/api/agent/command/sessions/${session.id}/messages`),{content:'Sempre termine as respostas comerciais com uma pergunta.'},admin);
  assert.equal(response.actions[0].action_type,'add_learning_rule');
  assert.equal(response.actions[0].status,'pending');
  await routeApi({method:'POST'},null,new URL(`http://local/api/agent/command/actions/${response.actions[0].id}/apply`),{},admin);
  assert.ok(get("SELECT 1 AS found FROM agent_learning_rules WHERE company_id=? AND instruction LIKE '%pergunta%' AND status='approved'",[company.id]).found);
  const detail=await routeApi({method:'GET'},null,new URL(`http://local/api/agent/command/sessions/${session.id}`),null,admin);
  assert.equal(detail.messages.length,2);
  assert.equal(detail.actions[0].status,'applied');
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(app,/id="new-agent-session"/);
  assert.match(app,/class="agent-command-shell"/);
  assert.match(app,/data-agent-action-apply/);
});

test('Agente Atenva consulta o CRM, sugere perguntas e cria tarefa vinculada com confirmação', async () => {
  const company=get('SELECT id FROM company_profiles ORDER BY id LIMIT 1');
  const admin={user:{id:1,name:'Administrador',role:'admin',isMaster:false,companyId:company.id,companyRole:'admin'}};
  const keys=['AI_GATEWAY_API_KEY','VERCEL_OIDC_TOKEN','AI_API_KEY','AI_API_URL','AI_MODEL','AI_GATEWAY_MODEL'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));keys.forEach(key=>delete process.env[key]);
  try{
    const session=await routeApi({method:'POST'},null,new URL('http://local/api/agent/command/sessions'),{title:'Copiloto comercial'},admin);
    const summary=await routeApi({method:'POST'},null,new URL(`http://local/api/agent/command/sessions/${session.id}/messages`),{content:'Quantos contatos, negócios e tarefas temos no CRM?'},admin);
    assert.match(summary.message.content,/No CRM há/);
    assert.ok(summary.message.metadata.questions.length>=1);
    const contact=get('SELECT id,name FROM contacts WHERE company_id=? ORDER BY id LIMIT 1',[company.id]);
    const proposed=await routeApi({method:'POST'},null,new URL(`http://local/api/agent/command/sessions/${session.id}/messages`),{content:`Crie uma tarefa para retornar para ${contact.name} amanhã às 10h`},admin);
    assert.equal(proposed.actions[0].action_type,'create_task');
    assert.equal(proposed.actions[0].arguments.contact_id,contact.id);
    await routeApi({method:'POST'},null,new URL(`http://local/api/agent/command/actions/${proposed.actions[0].id}/apply`),{},admin);
    const task=get("SELECT * FROM tasks WHERE company_id=? AND contact_id=? AND created_by='ai' ORDER BY id DESC LIMIT 1",[company.id,contact.id]);
    assert.ok(task);
    assert.equal(task.assigned_to,admin.user.id);
    const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
    assert.match(app,/agent-followup-questions/);
    assert.match(app,/metadata\?\.questions/);
  } finally { for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];} }
});

test('chat do agente envia o histórico da sessão ao modelo real', async () => {
  const company=get('SELECT id FROM company_profiles ORDER BY id LIMIT 1');
  const admin={user:{id:1,name:'Administrador',role:'admin',isMaster:false,companyId:company.id,companyRole:'admin'}};
  const previous={AI_API_URL:process.env.AI_API_URL,AI_API_KEY:process.env.AI_API_KEY,AI_MODEL:process.env.AI_MODEL};
  const originalFetch=globalThis.fetch;const requests=[];
  process.env.AI_API_URL='https://model.test/v1/chat/completions';process.env.AI_API_KEY='test-key';process.env.AI_MODEL='test-model';
  globalThis.fetch=async (_url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({model:'test-model',choices:[{message:{content:JSON.stringify({reply:'Resposta contextual',actions:[],questions:['Quer aprofundar?']})}}]})};};
  try{
    const session=await routeApi({method:'POST'},null,new URL('http://local/api/agent/command/sessions'),{title:'Memória'},admin);
    await routeApi({method:'POST'},null,new URL(`http://local/api/agent/command/sessions/${session.id}/messages`),{content:'O lead se chama Marina.'},admin);
    await routeApi({method:'POST'},null,new URL(`http://local/api/agent/command/sessions/${session.id}/messages`),{content:'Qual era o nome que eu disse?'},admin);
    const messages=requests.at(-1).messages;
    assert.ok(messages.some(item=>item.role==='user'&&item.content==='O lead se chama Marina.'));
    assert.ok(messages.some(item=>item.role==='assistant'&&item.content==='Resposta contextual'));
    assert.equal(messages.at(-1).content,'Qual era o nome que eu disse?');
  } finally {globalThis.fetch=originalFetch;for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('sessão permanece salva e a inicialização não pisca a tela de login', () => {
  const auth=readFileSync(new URL('../src/auth.js',import.meta.url),'utf8');
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(auth,/24 \* 30/);
  assert.match(auth,/Expires=\$\{expires\}/);
  assert.match(html,/id="app-boot"/);
  assert.match(html,/id="login-screen" hidden/);
  assert.match(app,/for\(let attempt=0;attempt<2/);
  assert.match(app,/timeoutMs:6_000/);
  assert.match(app,/Sua sessão continua salva/);
});

test('resumo do pipeline exibe o valor individual e possui layouts responsivos', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(app,/class="metric-detail-money"/);
  assert.match(app,/money\(item\.value_cents\)/);
  assert.match(css,/@media \(min-width:1121px\) and \(max-width:1366px\)/);
  assert.match(css,/@media \(max-width:1024px\)/);
  assert.match(css,/@media \(max-width:820px\)/);
  assert.match(css,/\.sidebar-scrim/);
  assert.match(css,/env\(safe-area-inset-bottom\)/);
  assert.match(app,/--ui-zoom/);
  assert.match(css,/height: calc\(100dvh \/ var\(--ui-zoom\)\)/);
  assert.match(css,/html\[data-text-size="extra"\] \.metric-grid/);
  assert.match(css,/\.metric-row \{[^}]*flex-wrap:wrap/);
});

test('pipeline permite editar lead, menu recolhe e pizza identifica cada segmento',()=>{
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(app,/data-edit-deal/);assert.match(app,/function openDealEditor/);assert.match(html,/id="sidebar-collapse"/);assert.match(app,/atenva-sidebar-collapsed/);assert.match(css,/\.app-shell\.sidebar-collapsed/);assert.match(app,/data-pie-tip="Recebidas/);assert.match(app,/data-pie-tip="Enviadas/);assert.match(css,/\.pie-sector\.received/);
});

test('funis, contatos e tarefas expõem os novos controles operacionais',()=>{
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(html,/<span>Funis<\/span>/);assert.match(app,/id="funnel-switcher-menu"/);assert.match(app,/data-deal-owner=/);assert.match(css,/\.deal-owner-control/);
  assert.match(app,/id="contact-search-scope"/);assert.match(app,/acquisition_channel/);assert.match(app,/pipeline_name/);assert.match(app,/Canal de aquisição/);
  assert.match(app,/id="task-start"/);assert.match(app,/id="task-end"/);assert.match(app,/taskRange/);
});

test('card do funil abre edição direta com conversa no topo e anotação do SDR',()=>{
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(app,/if\(deal\)openDealEditor\(deal\)/);assert.match(app,/deal-conversation-top/);assert.match(app,/name="sdr_notes"/);assert.match(app,/notes:values\.sdr_notes/);
  assert.match(css,/\.deal-edit-top/);assert.match(css,/\.sdr-notes-field/);assert.match(css,/grid-auto-columns:minmax\(270px,86vw\)/);assert.match(css,/\.main-content \{ min-width: 0; max-width:100vw; overflow-x:hidden;/);
});

test('troca de empresa limpa dados de funis e OAuth mantém sessão no retorno',()=>{
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const auth=readFileSync(new URL('../src/auth.js',import.meta.url),'utf8');
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(app,/function resetCompanyScopedState\(\)/);
  assert.match(app,/state\.pipelines = \[\]/);
  assert.match(app,/state\.selectedPipelineId = null/);
  assert.match(app,/resetCompanyScopedState\(\);\s*showApp\(session\.user\)/);
  assert.match(auth,/SameSite=Lax/);
  assert.doesNotMatch(auth,/SameSite=Strict/);
  assert.match(auth,/export function refreshCookie/);
  assert.match(server,/renewedCookie = refreshCookie\(request\)/);
});

test('navegação e integrações continuam utilizáveis durante falhas parciais',()=>{
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(app,/function refreshSession\(\)/);
  assert.match(app,/credentials:'same-origin'/);
  assert.match(app,/Promise\.allSettled\(\[api\('\/api\/meta\/status'/);
  assert.match(app,/id="retry-integrations"/);
  assert.match(app,/if \(token !== navigationToken\) return;/);
  assert.match(css,/\.integration-load-warning/);
});

test('menu lateral possui rolagem própria, usuário visível e saída direta',()=>{
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(html,/id="sidebar-logout-button"/);
  assert.match(app,/sidebar-logout-button.*addEventListener\('click',endSession\)/);
  assert.match(css,/\.main-nav \{[^}]*overflow-y:auto/);
  assert.match(css,/\.sidebar \{[^}]*overflow:hidden/);
  assert.match(css,/\.sidebar-bottom \{[^}]*flex:0 0 auto/);
  assert.match(app,/controller\.abort\(\)/);
  assert.match(app,/A conexão demorou demais/);
});

test('OAuth Meta não solicita leads_retrieval antes da aprovação do aplicativo',()=>{
  const keys=['META_APP_ID','META_APP_SECRET','META_OAUTH_SCOPES','META_ENABLE_LEADS_RETRIEVAL'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{META_APP_ID:'scope-test',META_APP_SECRET:'scope-secret',META_OAUTH_SCOPES:'ads_read,pages_show_list,leads_retrieval'});
  delete process.env.META_ENABLE_LEADS_RETRIEVAL;
  try{const url=new URL(metaAuthorizationUrl({id:1,companyId:1}));assert.match(url.searchParams.get('scope'),/ads_read/);assert.doesNotMatch(url.searchParams.get('scope'),/leads_retrieval/);}
  finally{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});

test('Marketing e WhatsApp usam configurações Meta separadas',()=>{
  const keys=['META_APP_ID','META_APP_SECRET','META_BUSINESS_LOGIN_CONFIG_ID','META_MARKETING_LOGIN_CONFIG_ID','META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID','META_TECH_PROVIDER_APPROVED'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{
    META_APP_ID:'split-config-app',
    META_APP_SECRET:'split-config-secret',
    META_BUSINESS_LOGIN_CONFIG_ID:'legacy-marketing-config',
    META_MARKETING_LOGIN_CONFIG_ID:'marketing-config',
    META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID:'whatsapp-config',
    META_TECH_PROVIDER_APPROVED:'true'
  });
  try{
    const marketingUrl=new URL(metaAuthorizationUrl({id:1,companyId:1}));
    const status=metaOauthStatus();
    assert.equal(marketingUrl.searchParams.get('config_id'),'marketing-config');
    assert.equal(marketingUrl.searchParams.has('scope'),false);
    assert.equal(status.marketing_login_config_id,'marketing-config');
    assert.equal(status.whatsapp_embedded_signup_config_id,'whatsapp-config');
    assert.equal(status.business_login_config_id,'whatsapp-config');
    assert.equal(status.embedded_signup_configured,true);
  }finally{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});

test('servidor permite o SDK e o popup oficiais da Meta sem relaxar o restante da CSP',()=>{
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(server,/script-src 'self' https:\/\/connect\.facebook\.net/);
  assert.match(server,/Cross-Origin-Opener-Policy': 'same-origin-allow-popups'/);
  assert.match(server,/frame-src https:\/\/www\.facebook\.com https:\/\/web\.facebook\.com/);
  assert.match(server,/frame-ancestors 'none'/);
});

test('Lead Ads cria contato, negócio e tarefa no tenant correto sem duplicar',async()=>{
  const keys=['META_APP_ID','META_APP_SECRET','META_OAUTH_SCOPES','META_ENABLE_LEADS_RETRIEVAL','META_LEADS_VERIFY_TOKEN'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{META_APP_ID:'lead-app',META_APP_SECRET:'lead-secret',META_OAUTH_SCOPES:'ads_read,pages_show_list,leads_retrieval,pages_manage_metadata',META_ENABLE_LEADS_RETRIEVAL:'true',META_LEADS_VERIFY_TOKEN:'lead-verify'});
  const companyId=Number(run("INSERT INTO company_profiles(name,slug,status) VALUES ('Tenant Lead Ads','tenant-lead-ads','active')").lastInsertRowid);
  const user={id:1,companyId};const authorization=new URL(metaAuthorizationUrl(user));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    const value=String(url);
    if(value.includes('/oauth/access_token'))return new Response(JSON.stringify({access_token:'marketing-token'}),{status:200});
    if(value.includes('/me/accounts'))return new Response(JSON.stringify({data:[{id:'page-123',name:'Página Teste',category:'Serviços',access_token:'page-token'}]}),{status:200});
    if(value.includes('/subscribed_apps'))return new Response(JSON.stringify({success:true}),{status:200});
    if(value.includes('/lead-987'))return new Response(JSON.stringify({id:'lead-987',form_id:'form-1',campaign_id:'campaign-1',campaign_name:'Campanha Outubro',ad_name:'Criativo A',field_data:[{name:'full_name',values:['Lead Teste']},{name:'email',values:['lead@teste.com']},{name:'phone_number',values:['+55 11 98888-7777']}]}),{status:200});
    return new Response(JSON.stringify({error:{message:'URL inesperada'}}),{status:400});
  };
  try{
    await completeMetaAuthorization({code:'lead-code',state:authorization.searchParams.get('state'),user});
    const payload={object:'page',entry:[{id:'page-123',changes:[{field:'leadgen',value:{leadgen_id:'lead-987',form_id:'form-1'}}]}]};
    const first=await processMetaLeadWebhook(payload);const second=await processMetaLeadWebhook(payload);
    assert.equal(first[0].companyId,companyId);assert.equal(second[0].duplicate,true);
    const contact=get("SELECT * FROM contacts WHERE company_id=? AND email='lead@teste.com'",[companyId]);assert.equal(contact.source,'meta_ads');
    assert.equal(get('SELECT COUNT(*) count FROM deals WHERE contact_id=?',[contact.id]).count,1);
    assert.equal(get('SELECT COUNT(*) count FROM tasks WHERE company_id=? AND contact_id=?',[companyId,contact.id]).count,1);
  }finally{globalThis.fetch=originalFetch;for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});

test('webhook de Lead Ads valida desafio e assinatura da Meta',()=>{
  const previous={secret:process.env.META_APP_SECRET,token:process.env.META_LEADS_VERIFY_TOKEN};process.env.META_APP_SECRET='signature-secret';process.env.META_LEADS_VERIFY_TOKEN='challenge-secret';
  try{const raw=Buffer.from('{"object":"page"}');const signature=`sha256=${createHmac('sha256','signature-secret').update(raw).digest('hex')}`;assert.equal(verifyMetaLeadChallenge({'hub.mode':'subscribe','hub.verify_token':'challenge-secret','hub.challenge':'123'}),'123');assert.equal(verifyMetaLeadChallenge({'hub.mode':'subscribe','hub.verify_token':'wrong','hub.challenge':'123'}),null);assert.equal(verifyMetaLeadSignature(raw,signature),true);assert.equal(verifyMetaLeadSignature(Buffer.from('{}'),signature),false);}
  finally{if(previous.secret===undefined)delete process.env.META_APP_SECRET;else process.env.META_APP_SECRET=previous.secret;if(previous.token===undefined)delete process.env.META_LEADS_VERIFY_TOKEN;else process.env.META_LEADS_VERIFY_TOKEN=previous.token;}
});

test('conversa permite sequência de follow-up, lembrete e compromisso de agenda',async()=>{
  const context={user:{id:1,role:'manager',companyId:1}};
  const conversation=get(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=1 ORDER BY c.id LIMIT 1`);
  const first=new Date(Date.now()+3_600_000).toISOString();
  const second=new Date(Date.now()+7_200_000).toISOString();
  const result=await routeApi({method:'POST'},null,new URL(`http://local/api/conversations/${conversation.id}/schedules`),{items:[
    {kind:'followup',send_at:first,content:'Posso ajudar com mais alguma informação?'},
    {kind:'reminder',send_at:second,content:'Revisar a proposta com o SDR'}
  ]},context);
  assert.equal(result.created.length,2);
  assert.equal(result.created[0].kind,'followup');
  assert.equal(result.created[1].kind,'reminder');
  const detail=await routeApi({method:'GET'},null,new URL(`http://local/api/conversations/${conversation.id}`),{},context);
  assert.ok(detail.schedules.some(item=>item.payload.content==='Posso ajudar com mais alguma informação?'));
  assert.ok(detail.tasks.some(item=>item.description==='Revisar a proposta com o SDR'));
  await routeApi({method:'DELETE'},null,new URL(`http://local/api/scheduled-messages/${result.created[0].id}`),{},context);
  assert.equal(get('SELECT status FROM scheduled_messages WHERE id=?',[result.created[0].id]).status,'cancelled');
});

test('executor envia follow-up vencido uma única vez e registra no histórico',async()=>{
  const evolutionEnv={url:process.env.EVOLUTION_API_URL,key:process.env.EVOLUTION_API_KEY,secret:process.env.EVOLUTION_WEBHOOK_SECRET};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>({messages:[{id:'scheduled-test-message'}]})});
  delete process.env.EVOLUTION_API_URL;delete process.env.EVOLUTION_API_KEY;delete process.env.EVOLUTION_WEBHOOK_SECRET;
  const conversation=get(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=1 ORDER BY c.id LIMIT 1`);
  const scheduleId=Number(run(`INSERT INTO scheduled_messages(conversation_id,send_at,payload,status) VALUES (?,?,?,'scheduled')`,[conversation.id,new Date(Date.now()-60_000).toISOString(),JSON.stringify({kind:'followup',content:'Mensagem automática de teste',created_by:1})]).lastInsertRowid);
  try{
    const executed=await processScheduledMessages(1);
    assert.ok(executed.sent>=1);
    assert.equal(get('SELECT status FROM scheduled_messages WHERE id=?',[scheduleId]).status,'sent');
    assert.equal(get(`SELECT COUNT(*) count FROM messages WHERE json_extract(metadata,'$.scheduled_message_id')=?`,[scheduleId]).count,1);
    await processScheduledMessages(1);
    assert.equal(get(`SELECT COUNT(*) count FROM messages WHERE json_extract(metadata,'$.scheduled_message_id')=?`,[scheduleId]).count,1);
  }finally{
    globalThis.fetch=originalFetch;
    if(evolutionEnv.url===undefined)delete process.env.EVOLUTION_API_URL;else process.env.EVOLUTION_API_URL=evolutionEnv.url;
    if(evolutionEnv.key===undefined)delete process.env.EVOLUTION_API_KEY;else process.env.EVOLUTION_API_KEY=evolutionEnv.key;
    if(evolutionEnv.secret===undefined)delete process.env.EVOLUTION_WEBHOOK_SECRET;else process.env.EVOLUTION_WEBHOOK_SECRET=evolutionEnv.secret;
  }
});

test('interface oferece agendamento em sequência e lista lembretes da conversa',()=>{
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(app,/id="schedule-conversation"/);
  assert.match(app,/Mensagem de follow-up/);
  assert.match(app,/Lembrete interno/);
  assert.match(app,/Compromisso no Google Agenda/);
  assert.match(app,/Adicionar outra etapa ou outro dia/);
  assert.match(app,/data-cancel-schedule/);
  assert.match(app,/scheduledMessageHeartbeat=setInterval\(processScheduledMessages,60_000\)/);
  assert.match(css,/\.conversation-schedule-row/);
  assert.match(css,/\.conversation-reminder-list/);
  assert.match(server,/\/api\/cron\/scheduled-messages/);
});

test('relacionamento rastreia origem, destino e jornada comercial por empresa',async()=>{
  const context={user:{id:1,role:'manager',companyId:1}};
  const overview=await routeApi({method:'GET'},null,new URL('http://local/api/relationships'),{},context);
  assert.ok(overview.summary.total>=6);
  assert.ok(overview.contacts.every(item=>item.source_label&&item.destination&&item.relationship_segment));
  const contact=overview.contacts[0];
  const journey=await routeApi({method:'GET'},null,new URL(`http://local/api/contacts/${contact.id}/journey`),{},context);
  assert.equal(journey.contact.id,contact.id);
  assert.ok(journey.attribution.some(item=>item.event_type==='first_touch'));
});

test('cadência cria tarefa, avança etapas e para quando o contato responde',async()=>{
  const context={user:{id:1,role:'manager',companyId:1}};
  const cadence=await routeApi({method:'POST'},null,new URL('http://local/api/cadences'),{name:'Cadência de teste',status:'active',stop_on_reply:true,steps:[{delay_hours:0,action_type:'task',task_title:'Retomar {{nome}}'},{delay_hours:24,action_type:'task',task_title:'Segundo contato {{nome}}'}]},context);
  const enrolled=await routeApi({method:'POST'},null,new URL(`http://local/api/cadences/${cadence.id}/enroll`),{contact_ids:[1]},context);
  assert.equal(enrolled.enrolled,1);
  const result=await processCadences(1);
  assert.ok(result.created>=1);
  const enrollment=get('SELECT * FROM relationship_cadence_enrollments WHERE cadence_id=? AND contact_id=1',[cadence.id]);
  assert.equal(enrollment.current_step,2);
  assert.match(get("SELECT title FROM tasks WHERE contact_id=1 AND created_by='system' ORDER BY id DESC LIMIT 1").title,/Retomar/);
  assert.equal(stopCadencesForContact(1,1,'reply_received',true),1);
  assert.equal(get('SELECT status FROM relationship_cadence_enrollments WHERE id=?',[enrollment.id]).status,'stopped');
});

test('interface expõe base de relacionamento, jornada e construtor de cadências',()=>{
  const app=readFileSync(new URL('../public/relationships.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.match(html,/data-view="relationships"/);
  assert.match(app,/Origem → destino atual/);
  assert.match(app,/Parar quando o contato responder/);
  assert.match(app,/Nova cadência/);
  assert.match(css,/\.relationship-layout/);
});

after(() => {
  db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    if (existsSync(testDatabase + suffix)) unlinkSync(testDatabase + suffix);
  }
});
