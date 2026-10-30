import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_PATH=join(process.cwd(),'data','automation.test.db');
process.env.WHATSAPP_SIMULATE='true';
for(const suffix of ['', '-wal', '-shm'])if(existsSync(process.env.DATABASE_PATH+suffix))unlinkSync(process.env.DATABASE_PATH+suffix);
const {db,get,run,all}=await import('../src/db.js');
const {seed}=await import('../src/seed.js');
seed();
const {processInboundMessage,queueInboundMessage,processPendingInboundMessages}=await import('../src/agent.js');
const {collectProfileUpdates,contactProfile}=await import('../src/lead-profile.js');
const {qualificationConfig,recalculateContactQualification,saveQualificationConfig}=await import('../src/qualification.js');
const {sendWhatsAppText,sendWhatsAppTemplate}=await import('../src/whatsapp.js');
const {nextBusinessTime,validateAgentConfig}=await import('../src/automation-policy.js');
const {routeApi,processScheduledMessages,processWebhook}=await import('../src/api.js');
const {pauseForHumanReply,resumeExpiredHumanPauses}=await import('../src/team-attendance.js');
const context={user:{id:1,role:'manager',companyId:1}};
const stages=all("SELECT s.id,s.local_position FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.company_id=1 AND p.kind='sales' ORDER BY s.local_position");
const originalFetch=globalThis.fetch;
let serial=0;

beforeEach(()=>{
  globalThis.fetch=async()=>{throw new Error('Unexpected network call in a local test');};
  process.env.NODE_ENV='test';process.env.WHATSAPP_SIMULATE='true';
  for(const key of ['AI_API_URL','AI_API_KEY','AI_MODEL','AI_GATEWAY_API_KEY','VERCEL_OIDC_TOKEN','EVOLUTION_API_URL','EVOLUTION_API_KEY','EVOLUTION_WEBHOOK_SECRET','EVOLUTION_WEBHOOK_BASE_URL','PUBLIC_URL'])delete process.env[key];
  run("DELETE FROM settings WHERE key LIKE 'integration:meta-whatsapp%'");
  run("UPDATE company_agent_config SET autonomy_level=2,confidence_threshold=.72,followup_rules=? WHERE company_id=1",[JSON.stringify({enabled:false,delays_hours:[24,72],max_attempts:2})]);
  run('DELETE FROM conversation_stage_rules WHERE company_id=1');
  run('DELETE FROM pipeline_automations WHERE company_id=1');
  saveQualificationConfig({mql_min_score:50,sql_min_score:80,mql_stage_id:stages[1].id,sql_stage_id:stages[3].id,required_fields:['phone','company','need'],sql_required_fields:['need','timeframe','decision_role'],auto_move:true});
});
after(()=>{globalThis.fetch=originalFetch;db.close();for(const suffix of ['', '-wal', '-shm'])if(existsSync(process.env.DATABASE_PATH+suffix))unlinkSync(process.env.DATABASE_PATH+suffix);});

function fixture({mode='autopilot',complete=false}={}){
  const phone=`+5511988${String(++serial).padStart(6,'0')}`;
  const commercial=complete?{need:{value:'Organizar vendas'},budget:{value:'5000 reais'},timeframe:{value:'Este mês'},decision_role:{value:'Sou responsável'}}:{};
  const contactId=Number(run('INSERT INTO contacts(company_id,phone,name,email,company,custom_fields) VALUES (1,?,?,?,?,?)',[phone,'Ana','ana@acme.com',complete?'Acme':null,JSON.stringify({commercial})]).lastInsertRowid);
  const conversationId=Number(run('INSERT INTO conversations(contact_id,assigned_to,mode,customer_window_until) VALUES (?,1,?,?)',[contactId,mode,new Date(Date.now()+3600000).toISOString()]).lastInsertRowid);
  const dealId=Number(run('INSERT INTO deals(contact_id,stage_id,owner_id,title,score) VALUES (?,?,1,?,0)',[contactId,stages[0].id,'Lead de teste']).lastInsertRowid);
  return {contactId,conversationId,dealId,phone};
}
function inbound(f,text,type='text'){
  const id=Number(run("INSERT INTO messages(conversation_id,direction,sender_type,type,content,status) VALUES (?,'inbound','contact',?,?,'received')",[f.conversationId,type,text]).lastInsertRowid);
  return get('SELECT * FROM messages WHERE id=?',[id]);
}

test('handoff fica pendente, sincroniza sem enviar mensagens e encerra ao assumir',async()=>{
  const f=fixture();
  const result=await processInboundMessage(f.conversationId,inbound(f,'Quero falar com um atendente').id);
  assert.equal(result.status,'handoff');
  const live=async(companyId=1)=>routeApi({method:'GET'},null,new URL(`http://local/api/conversations/live?selected=${f.conversationId}`),null,{user:{...context.user,companyId}});
  const pending=await live();
  assert.equal(pending.selected.waiting_human,1);
  assert.match(pending.selected.next_action,/Aguardando atendimento humano/);
  const unchanged=await routeApi({method:'GET'},null,new URL(`http://local/api/conversations/live?selected=${f.conversationId}&version=${pending.selected_version}`),null,context);
  assert.equal(unchanged.selected,null);
  assert.equal(unchanged.selected_version,pending.selected_version);
  const count=Number(get('SELECT COUNT(*) AS total FROM messages WHERE conversation_id=?',[f.conversationId]).total);
  await live();
  assert.equal(Number(get('SELECT COUNT(*) AS total FROM messages WHERE conversation_id=?',[f.conversationId]).total),count);
  const ignored=await processInboundMessage(f.conversationId,inbound(f,'Pode me ajudar?').id);
  assert.equal(ignored,null);
  const other=Number(run("INSERT INTO company_profiles(name,slug,status) VALUES ('Outra conta live','outra-conta-live','active')").lastInsertRowid);
  assert.equal((await live(other)).selected,null);
  assert.ok(!(await live(other)).conversations.some(item=>item.id===f.conversationId));
  await assert.rejects(()=>routeApi({method:'PATCH'},null,new URL(`http://local/api/conversations/${f.conversationId}`),{mode:'human'},{user:{...context.user,companyId:other}}),/Conversa não encontrada/);
  await routeApi({method:'PATCH'},null,new URL(`http://local/api/conversations/${f.conversationId}`),{mode:'human'},context);
  assert.equal((await live()).selected.waiting_human,0);
  assert.equal((await live()).selected.mode,'human');
});

test('resposta humana retira o cliente da espera sem reativar a IA',async()=>{
  const f=fixture();
  await processInboundMessage(f.conversationId,inbound(f,'Quero falar com um atendente').id);
  await routeApi({method:'POST'},null,new URL(`http://local/api/conversations/${f.conversationId}/messages`),{content:'Olá, vou continuar seu atendimento.'},context);
  const live=await routeApi({method:'GET'},null,new URL(`http://local/api/conversations/live?selected=${f.conversationId}`),null,context);
  assert.equal(live.selected.waiting_human,0);
  assert.equal(live.selected.mode,'human');
  assert.equal(live.selected.assigned_name,get('SELECT name FROM users WHERE id=1').name);
});

test('pausa de um minuto reinicia após resposta humana e mantém mensagens na fila',async()=>{
  const f=fixture();
  const send=()=>routeApi({method:'POST'},null,new URL(`http://local/api/conversations/${f.conversationId}/messages`),{content:'Um instante, estou verificando.'},context);
  await send();
  let row=get('SELECT * FROM conversations WHERE id=?',[f.conversationId]);
  assert.ok(new Date(row.human_pause_until)-Date.now()>58_000);
  run('UPDATE conversations SET human_pause_until=? WHERE id=?',[new Date(Date.now()+5000).toISOString(),f.conversationId]);
  await send();
  row=get('SELECT * FROM conversations WHERE id=?',[f.conversationId]);
  assert.ok(new Date(row.human_pause_until)-Date.now()>58_000);
  const first=inbound(f,'Quanto custa?');const latest=inbound(f,'Qual o valor para minha equipe?');
  queueInboundMessage(f.conversationId,first.id);queueInboundMessage(f.conversationId,latest.id);
  const outboundCount=()=>get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND direction='outbound'",[f.conversationId]).n;
  const before=outboundCount();
  await processPendingInboundMessages(1);
  assert.equal(outboundCount(),before);
  assert.equal(get('SELECT status FROM inbound_agent_jobs WHERE message_id=?',[latest.id]).status,'pending');
  const past=new Date(Date.now()-1000).toISOString();
  run('UPDATE conversations SET human_pause_until=? WHERE id=?',[past,f.conversationId]);
  run('UPDATE inbound_agent_jobs SET next_attempt_at=? WHERE conversation_id=?',[past,f.conversationId]);
  modelResponse(answer());
  await processPendingInboundMessages(1);
  assert.equal(outboundCount(),before+1);
  assert.equal(get('SELECT mode FROM conversations WHERE id=?',[f.conversationId]).mode,'autopilot');
  assert.equal(get('SELECT status FROM inbound_agent_jobs WHERE message_id=?',[first.id]).status,'completed');
});

test('dez executores concorrentes não duplicam respostas da mesma conversa',async()=>{
  const f=fixture();
  const message=inbound(f,'Quanto custa?');queueInboundMessage(f.conversationId,message.id);
  modelResponse(answer());
  await Promise.all(Array.from({length:10},()=>processPendingInboundMessages(1)));
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND direction='outbound'",[f.conversationId]).n,1);
  assert.equal(get('SELECT attempts FROM inbound_agent_jobs WHERE message_id=?',[message.id]).attempts,1);
});

test('resposta humana durante geração impede envio tardio da IA',async()=>{
  const f=fixture();
  modelResponse(answer(),()=>pauseForHumanReply(f.conversationId,1));
  const result=await processInboundMessage(f.conversationId,inbound(f,'Quanto custa?').id);
  assert.equal(result.status,'superseded_by_human');
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND direction='outbound'",[f.conversationId]).n,0);
});

test('movimento humano durante geração prevalece sobre o movimento da IA',async()=>{
  const f=fixture({complete:true});
  modelResponse(answer([],{stage_id:stages[3].id,stage_evidence:'Quero avançar'}),()=>run('UPDATE deals SET stage_id=? WHERE id=?',[stages[1].id,f.dealId]));
  await processInboundMessage(f.conversationId,inbound(f,'Quero avançar').id);
  assert.equal(get('SELECT stage_id FROM deals WHERE id=?',[f.dealId]).stage_id,stages[1].id);
});

test('card rejeita revisão antiga sem sobrescrever a alteração anterior',async()=>{
  const f=fixture();const revision=get('SELECT revision FROM deals WHERE id=?',[f.dealId]).revision;
  const request=body=>routeApi({method:'PATCH'},null,new URL(`http://local/api/deals/${f.dealId}`),body,context);
  await request({stage_id:stages[1].id,expected_revision:revision});
  await assert.rejects(()=>request({stage_id:stages[2].id,expected_revision:revision}),error=>error.statusCode===409);
  assert.equal(get('SELECT stage_id FROM deals WHERE id=?',[f.dealId]).stage_id,stages[1].id);
});
function modelResponse(payload,hook){
  Object.assign(process.env,{AI_API_URL:'https://model.invalid/v1/chat/completions',AI_API_KEY:'test-key',AI_MODEL:'test-model',AI_GATEWAY_API_KEY:'different-gateway-key'});
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),'https://model.invalid/v1/chat/completions');
    assert.equal(options.headers.Authorization,'Bearer test-key');
    hook?.(JSON.parse(options.body));
    return {ok:true,json:async()=>({model:'test-model',choices:[{message:{content:JSON.stringify(payload)}}]})};
  };
}
async function connectOfficial(){
  await routeApi({method:'PUT'},null,new URL('http://local/api/meta/config'),{access_token:'test-token',phone_number_id:'123123123',business_account_id:'456456456',app_secret:'test-app-secret',verify_token:'test-verify'},context);
  globalThis.fetch=async(url)=>({ok:true,json:async()=>String(url).endsWith('subscribed_apps')?{success:true}:{display_phone_number:'5511000000000',verified_name:'Empresa Teste'}});
  await routeApi({method:'POST'},null,new URL('http://local/api/meta/test'),{},context);
}
const answer=(updates=[],analysis={})=>({response:'Obrigado. Qual necessidade você quer resolver?',contact_updates:updates,analysis:{intent:'produto',confidence:.95,...analysis}});

test('coleta apenas dados literais do cliente e rejeita valores inventados ou inválidos',()=>{
  const f=fixture();const message=inbound(f,'Minha empresa é Acme. Meu e-mail é ana@acme.com. Preciso organizar vendas.');
  const changes=collectProfileUpdates(f.contactId,message,[
    {field:'need',value:'organizar vendas',evidence:'Preciso organizar vendas'},
    {field:'budget',value:'5000',evidence:'Tenho 5000'},
    {field:'email',value:'inválido',evidence:'inválido'},
    {field:'company_id',value:'2',evidence:'Acme'}]);
  const contact=get('SELECT * FROM contacts WHERE id=?',[f.contactId]);
  assert.equal(contact.company,'Acme');assert.equal(contact.email,'ana@acme.com');assert.equal(contactProfile(contact).need,'organizar vendas');
  assert.equal(contactProfile(contact).budget,undefined);assert.equal(contact.company_id,1);
  assert.ok(changes.every(item=>item.message_id===message.id));
});

test('paráfrase da IA preserva a frase literal do cliente como dado comercial',()=>{
  const f=fixture();const message=inbound(f,'Preciso organizar minhas vendas.');
  collectProfileUpdates(f.contactId,message,[{field:'need',value:'Organização comercial',evidence:'Preciso organizar minhas vendas'}]);
  assert.equal(contactProfile(get('SELECT * FROM contacts WHERE id=?',[f.contactId])).need,'Preciso organizar minhas vendas');
});

test('não usa mensagem de outro contato como fonte de atualização',()=>{
  const f=fixture(),other=fixture();const message=inbound(other,'Minha empresa é Outra Empresa.');
  assert.deepEqual(collectProfileUpdates(f.contactId,message),[]);
  assert.equal(get('SELECT company FROM contacts WHERE id=?',[f.contactId]).company,null);
});

test('modelo coleta dados, qualifica SQL e avança card com histórico e motivo auditável',async()=>{
  const f=fixture();const text='Minha empresa é Acme. Preciso organizar vendas. Tenho 5000 reais. Quero este mês. Sou responsável.';
  const updates=[['need','organizar vendas'],['budget','5000 reais'],['timeframe','este mês'],['decision_role','Sou responsável']].map(([field,value])=>({field,value,evidence:value}));
  modelResponse(answer(updates,{stage_id:stages[3].id,stage_evidence:'Quero este mês'}));
  await processInboundMessage(f.conversationId,inbound(f,text).id);
  assert.equal(get('SELECT qualification FROM contacts WHERE id=?',[f.contactId]).qualification,'sql');
  assert.equal(get('SELECT stage_id FROM deals WHERE id=?',[f.dealId]).stage_id,stages[3].id);
  assert.ok(get("SELECT id FROM activities WHERE contact_id=? AND action='qualification_stage_move'",[f.contactId]));
});

test('IA interpreta resposta curta usando histórico antes de encaminhar por baixa confiança',async()=>{
  const f=fixture();inbound(f,'Quero conhecer o serviço');
  run("INSERT INTO messages(conversation_id,direction,sender_type,content) VALUES (?,'outbound','ai','Qual é o seu prazo?')",[f.conversationId]);
  let usedHistory=false;
  modelResponse(answer([{field:'timeframe',value:'Este mês',evidence:'Este mês'}]),request=>{usedHistory=request.messages.some(item=>item.content==='Qual é o seu prazo?');});
  await processInboundMessage(f.conversationId,inbound(f,'Este mês').id);
  assert.equal(usedHistory,true);assert.equal(get('SELECT mode FROM conversations WHERE id=?',[f.conversationId]).mode,'autopilot');
  assert.equal(contactProfile(get('SELECT * FROM contacts WHERE id=?',[f.contactId])).timeframe,'Este mês');
});

test('auto_move desligado coleta e classifica sem movimentar card',async()=>{
  const f=fixture({complete:true});run('UPDATE company_qualification_config SET auto_move=0 WHERE company_id=1');modelResponse(answer());
  await processInboundMessage(f.conversationId,inbound(f,'Como funciona?').id);
  assert.equal(get('SELECT stage_id FROM deals WHERE id=?',[f.dealId]).stage_id,stages[0].id);
  assert.equal(get('SELECT qualification FROM contacts WHERE id=?',[f.contactId]).qualification,'sql');
});

test('avanço pela IA dispara a mesma automação de etapa do Kanban uma única vez',async()=>{
  const f=fixture({complete:true});
  run("INSERT INTO pipeline_automations(company_id,name,trigger_type,trigger_stage_id,action_type,action_value) VALUES (1,'Tarefa após SQL','stage_entered',?,'create_task','Preparar proposta')",[stages[3].id]);
  modelResponse(answer());const message=inbound(f,'Como funciona?');
  await processInboundMessage(f.conversationId,message.id);await processInboundMessage(f.conversationId,message.id);
  assert.equal(get("SELECT COUNT(*) n FROM tasks WHERE deal_id=? AND title='Preparar proposta'",[f.dealId]).n,1);
});

test('modo copiloto gera sugestão sem enviar nem alterar ficha, pontuação ou etapa',async()=>{
  const f=fixture({mode:'copilot'});modelResponse(answer([{field:'company',value:'Acme',evidence:'Acme'}]));
  const result=await processInboundMessage(f.conversationId,inbound(f,'Minha empresa é Acme.').id);
  assert.equal(result.status,'suggested');assert.equal(get('SELECT company FROM contacts WHERE id=?',[f.contactId]).company,null);
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND direction='outbound'",[f.conversationId]).n,0);
  assert.equal(get('SELECT score FROM deals WHERE id=?',[f.dealId]).score,0);
});

test('negativa e pedido de agendamento não comprovam reunião confirmada',async()=>{
  const f=fixture({complete:true});
  modelResponse(answer([],{intent:'agendamento',stage_id:stages[2].id,stage_evidence:'Quero agendar'}));
  await processInboundMessage(f.conversationId,inbound(f,'Quero agendar uma conversa.').id);
  assert.equal(get('SELECT stage_id FROM deals WHERE id=?',[f.dealId]).stage_id,stages[0].id);
  modelResponse(answer([],{stage_id:stages[3].id,stage_evidence:'Não quero avançar'}));
  await processInboundMessage(f.conversationId,inbound(f,'Não quero avançar agora.').id);
  assert.equal(get('SELECT stage_id FROM deals WHERE id=?',[f.dealId]).stage_id,stages[0].id);
});

test('etapa proposta de outra empresa é ignorada',async()=>{
  const f=fixture({complete:true});
  const companyId=Number(run("INSERT INTO company_profiles(name,slug) VALUES ('Outro','outro-teste')").lastInsertRowid);
  const pipeline=Number(run("INSERT INTO pipelines(company_id,name) VALUES (?,'Externo')",[companyId]).lastInsertRowid);
  const stage=Number(run("INSERT INTO pipeline_stages(name,position,color,pipeline_id,company_id,local_position) VALUES ('Externa-Teste',999999,'#000',?,?,4)",[pipeline,companyId]).lastInsertRowid);
  modelResponse(answer([],{stage_id:stage,stage_evidence:'Quero avançar'}));
  await processInboundMessage(f.conversationId,inbound(f,'Quero avançar').id);
  assert.equal(get('SELECT stage_id FROM deals WHERE id=?',[f.dealId]).stage_id,stages[0].id);
});

test('perguntas repetidas não aumentam score e reprocessamento não duplica resposta',async()=>{
  const f=fixture();const message=inbound(f,'Quanto custa?');
  await processInboundMessage(f.conversationId,message.id);const score=get('SELECT score FROM deals WHERE id=?',[f.dealId]).score;
  const replay=await processInboundMessage(f.conversationId,message.id);assert.equal(replay.status,'already_processed');
  await processInboundMessage(f.conversationId,inbound(f,'Quanto custa?').id);
  assert.equal(get('SELECT score FROM deals WHERE id=?',[f.dealId]).score,score);
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND direction='outbound'",[f.conversationId]).n,2);
});

test('etapas não configuradas não qualificam automaticamente todos os contatos',()=>{
  const f=fixture();run("UPDATE company_qualification_config SET mql_stage_id=NULL,sql_stage_id=NULL,required_fields='[]',sql_required_fields='[]' WHERE company_id=1");
  assert.equal(recalculateContactQualification(f.contactId),'lead');
});

test('simulação explícita fica na fila e nunca se passa por envio real',async()=>{
  const f=fixture();const sent=await sendWhatsAppText(f.phone.slice(1),'Olá');
  assert.equal(sent.simulated,true);assert.equal(sent.status,'queued');
  process.env.NODE_ENV='production';
  await assert.rejects(sendWhatsAppText(f.phone.slice(1),'Olá'),{code:'WHATSAPP_NOT_CONNECTED'});
});

test('falta de conexão não simula silenciosamente em desenvolvimento',async()=>{
  const f=fixture();delete process.env.WHATSAPP_SIMULATE;
  await assert.rejects(sendWhatsAppText(f.phone.slice(1),'Olá'),{code:'WHATSAPP_NOT_CONNECTED'});
});

test('fila persiste tentativa, recebe erro explícito e encaminha a humano',async()=>{
  const f=fixture();delete process.env.WHATSAPP_SIMULATE;const message=inbound(f,'Olá');
  queueInboundMessage(f.conversationId,message.id);queueInboundMessage(f.conversationId,message.id);
  const result=await processPendingInboundMessages(1,message.id);
  assert.equal(result.failed,1);assert.equal(get('SELECT attempts FROM inbound_agent_jobs WHERE message_id=?',[message.id]).attempts,1);
  assert.equal(get('SELECT mode FROM conversations WHERE id=?',[f.conversationId]).mode,'human');
});

test('execução interrompida vai para revisão sem reenviar mensagem de resultado desconhecido',async()=>{
  const f=fixture();const message=inbound(f,'Olá');queueInboundMessage(f.conversationId,message.id);
  run("UPDATE inbound_agent_jobs SET status='processing',claimed_at=datetime('now','-20 minutes') WHERE message_id=?",[message.id]);
  await processPendingInboundMessages(1,message.id);
  assert.equal(get('SELECT status FROM inbound_agent_jobs WHERE message_id=?',[message.id]).status,'failed');
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND direction='outbound'",[f.conversationId]).n,0);
});

test('agendamentos simultâneos não enviam a mesma mensagem duas vezes',async()=>{
  const f=fixture();const id=Number(run("INSERT INTO scheduled_messages(conversation_id,send_at,payload) VALUES (?,datetime('now','-1 minute'),?)",[f.conversationId,JSON.stringify({content:'Olá novamente'})]).lastInsertRowid);
  await Promise.all([processScheduledMessages(1),processScheduledMessages(1)]);
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE json_extract(metadata,'$.scheduled_message_id')=?",[id]).n,1);
  assert.equal(get('SELECT status FROM messages WHERE json_extract(metadata,\'$.scheduled_message_id\')=?',[id]).status,'queued');
});

test('consentimento revogado bloqueia texto e modelo',async()=>{
  const f=fixture();run("UPDATE contacts SET consent_status='revoked' WHERE id=?",[f.contactId]);
  await assert.rejects(sendWhatsAppText(f.phone.slice(1),'Olá'),/recusou/);
  await assert.rejects(sendWhatsAppTemplate(f.phone.slice(1),{name:'teste'}),/recusou/);
});

test('áudio sem transcrição encaminha a humano sem inventar interpretação',async()=>{
  const f=fixture();const result=await processInboundMessage(f.conversationId,inbound(f,'[Áudio sem transcrição] Atendimento humano necessário.','audio').id);
  assert.equal(result.status,'handoff');assert.equal(get('SELECT mode FROM conversations WHERE id=?',[f.conversationId]).mode,'human');
});

test('horário de retomada respeita fim de semana e fuso de São Paulo',()=>{
  const rules={timezone:'America/Sao_Paulo',weekdays:[1,2,3,4,5],start:'09:00',end:'18:00'};
  assert.equal(nextBusinessTime('2026-10-30T22:00:00Z',rules),'2026-11-02T12:00:00.000Z');
  assert.throws(()=>validateAgentConfig({confidence_threshold:2}),/inválido/);
  assert.throws(()=>validateAgentConfig({business_hours:{...rules,start:'19:00'}}),/horários/);
});

test('configuração recusa modelo de retomada não pertencente à empresa',async()=>{
  await assert.rejects(routeApi({method:'PUT'},null,new URL('http://local/api/agent/config'),{followup_rules:{enabled:true,delays_hours:[24],max_attempts:1,template_id:999999}},context),/aprovado desta empresa/);
  assert.deepEqual(qualificationConfig().sql_required_fields,['need','timeframe','decision_role']);
});

test('envio oficial exige janela válida e modelo pode retomar fora da janela',async()=>{
  const f=fixture();await connectOfficial();
  run("UPDATE conversations SET customer_window_until=datetime('now','-1 minute') WHERE id=?",[f.conversationId]);
  let requests=0;globalThis.fetch=async()=>{requests++;return {ok:true,json:async()=>({messages:[{id:'wamid.template'}]})};};
  await assert.rejects(sendWhatsAppText(f.phone.slice(1),'Olá'),{code:'WHATSAPP_WINDOW_CLOSED'});
  assert.equal(requests,0);
  const result=await sendWhatsAppTemplate(f.phone.slice(1),{name:'approved_template'});
  assert.equal(result.id,'wamid.template');assert.equal(result.simulated,false);assert.equal(requests,1);
});

test('resposta ambígua do provedor não recebe status enviado',async()=>{
  const f=fixture();await connectOfficial();
  globalThis.fetch=async()=>({ok:true,json:async()=>({success:true})});
  await assert.rejects(sendWhatsAppText(f.phone.slice(1),'Olá'),{code:'DELIVERY_UNKNOWN'});
});

test('erro temporário confirmado agenda nova tentativa e envia uma única resposta',async()=>{
  const f=fixture();await connectOfficial();let count=0;
  globalThis.fetch=async()=>{count++;return count===1?{ok:false,status:429,json:async()=>({error:{message:'Rate limit'}})}:{ok:true,json:async()=>({messages:[{id:'wamid.retry'}]})};};
  const message=inbound(f,'Olá');queueInboundMessage(f.conversationId,message.id);
  const first=await processPendingInboundMessages(1,message.id);
  assert.equal(first.results[0].status,'retry_scheduled');assert.equal(get('SELECT mode FROM conversations WHERE id=?',[f.conversationId]).mode,'autopilot');
  run("UPDATE inbound_agent_jobs SET next_attempt_at=datetime('now','-1 minute') WHERE message_id=?",[message.id]);
  await processPendingInboundMessages(1,message.id);
  assert.equal(count,2);assert.equal(get('SELECT attempts,status FROM inbound_agent_jobs WHERE message_id=?',[message.id]).status,'completed');
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND direction='outbound'",[f.conversationId]).n,1);
});

test('webhook duplicado registra uma entrada e cliente pode recusar mensagens',async()=>{
  await connectOfficial();globalThis.fetch=async()=>({ok:true,json:async()=>({messages:[{id:'wamid.webhook'}]})});
  const payload={entry:[{id:'456456456',changes:[{value:{metadata:{phone_number_id:'123123123'},contacts:[{profile:{name:'Lead Webhook'}}],messages:[{from:'5511999997766',id:'wamid.incoming.unique',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'pare de me enviar mensagens'}}]}}]}]};
  await processWebhook(payload);await processWebhook(payload);
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE whatsapp_message_id='wamid.incoming.unique'").n,1);
  const contact=get("SELECT * FROM contacts WHERE whatsapp_id='5511999997766'");assert.equal(contact.consent_status,'revoked');
  assert.equal(get("SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.contact_id=? AND m.direction='outbound'",[contact.id]).n,0);
});

test('retomadas automáticas respeitam limite e são canceladas quando o cliente responde',async()=>{
  const f=fixture({complete:true});run("UPDATE contacts SET consent_status='granted' WHERE id=?",[f.contactId]);
  const template=Number(run("INSERT INTO message_templates(company_id,meta_name,provider_name,display_name,category,body,status,source) VALUES (1,'auto_followup','auto_followup','Retomada','utility','Podemos continuar seu atendimento?','approved','meta')").lastInsertRowid);
  run('UPDATE company_agent_config SET followup_rules=? WHERE company_id=1',[JSON.stringify({enabled:true,delays_hours:[24,72],max_attempts:1,template_id:template})]);
  await processInboundMessage(f.conversationId,inbound(f,'Como funciona?').id);
  assert.equal(get("SELECT COUNT(*) n FROM scheduled_messages WHERE conversation_id=? AND status='scheduled'",[f.conversationId]).n,1);
  // Bind the receiving number without activating a live send provider.
  await routeApi({method:'PUT'},null,new URL('http://local/api/meta/config'),{access_token:'followup-token',phone_number_id:'789789789',business_account_id:'987987987',app_secret:'test-secret',verify_token:'test'},context);
  await routeApi({method:'PUT'},null,new URL('http://local/api/agent/config'),{autonomy_level:0},context);
  await processWebhook({entry:[{id:'987987987',changes:[{value:{metadata:{phone_number_id:'789789789'},messages:[{from:f.phone.slice(1),id:'wamid.reply-cancel',type:'text',text:{body:'Obrigado'}}]}}]}]});
  assert.equal(get("SELECT COUNT(*) n FROM scheduled_messages WHERE conversation_id=? AND status='scheduled'",[f.conversationId]).n,0);
});

test('requisição ao GPT OSS no Groq usa esquema estrito e limite de saída',async()=>{
  const f=fixture();Object.assign(process.env,{AI_API_URL:'https://api.groq.com/openai/v1/chat/completions',AI_API_KEY:'test-key',AI_MODEL:'openai/gpt-oss-20b'});
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),process.env.AI_API_URL);const body=JSON.parse(options.body);
    assert.equal(body.response_format.type,'json_schema');assert.equal(body.response_format.json_schema.strict,true);
    assert.equal(body.max_completion_tokens,1200);assert.equal(body.max_tokens,undefined);assert.equal(body.reasoning_effort,'low');
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(answer())}}]})};
  };
  const result=await processInboundMessage(f.conversationId,inbound(f,'Olá').id);assert.equal(result.status,'completed');
});

test('falhas ficam visíveis e nova tentativa exige revisão explícita e empresa correta',async()=>{
  const f=fixture();const message=inbound(f,'Olá');queueInboundMessage(f.conversationId,message.id);
  run("UPDATE inbound_agent_jobs SET status='failed',error='Conferir envio' WHERE message_id=?",[message.id]);
  const url=new URL(`http://local/api/automations/inbound/${message.id}/retry`);
  await assert.rejects(routeApi({method:'POST'},null,url,{},context),/Confira no WhatsApp/);
  await assert.rejects(routeApi({method:'POST'},null,url,{reviewed_delivery:true},{user:{...context.user,companyId:999}}),/nesta empresa/);
  const status=await routeApi({method:'GET'},null,new URL('http://local/api/automations/status'),{},context);
  assert.ok(status.failures.some(item=>item.id===message.id&&item.kind==='inbound'));
  await routeApi({method:'POST'},null,url,{reviewed_delivery:true},context);
  assert.equal(get('SELECT status FROM inbound_agent_jobs WHERE message_id=?',[message.id]).status,'pending');
  // Leave this reviewed item for the next runner, without executing network calls in this test.
});

test('conexão Evolution usa endereço alcançável pelo container no webhook local',async()=>{
  Object.assign(process.env,{EVOLUTION_API_URL:'http://127.0.0.1:8787',EVOLUTION_API_KEY:'test-evolution-key',EVOLUTION_WEBHOOK_SECRET:'test-local-secret',EVOLUTION_WEBHOOK_BASE_URL:'http://host.docker.internal:3210',PUBLIC_URL:'http://localhost:3210'});
  const webhookUrls=[];
  globalThis.fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;if(body?.webhook?.url)webhookUrls.push(body.webhook.url);
    let payload={success:true};if(String(url).includes('fetchInstances'))payload=[];
    else if(String(url).includes('/instance/create'))payload={qrcode:{base64:'dGVzdA=='}};
    else if(String(url).includes('/connectionState/'))payload={instance:{state:'connecting'}};
    return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
  };
  const result=await routeApi({method:'POST',headers:{host:'localhost:3210'}},null,new URL('http://local/api/evolution/connect'),{},context);
  assert.match(result.qr_code,/^data:image\/png;base64,/);assert.equal(result.webhook_configured,true);
  assert.ok(webhookUrls.length>=1);assert.ok(webhookUrls.every(url=>url==='http://host.docker.internal:3210/api/webhooks/evolution/test-local-secret/1'));
});
