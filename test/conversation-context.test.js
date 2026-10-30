import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync,unlinkSync} from 'node:fs';
process.env.DATABASE_PATH=join(process.cwd(),'data','conversation-context.test.db');
process.env.NODE_ENV='test';process.env.WHATSAPP_SIMULATE='true';
for(const suffix of ['','-wal','-shm'])if(existsSync(process.env.DATABASE_PATH+suffix))unlinkSync(process.env.DATABASE_PATH+suffix);
const {db,run,get}=await import('../src/db.js');
const {seed}=await import('../src/seed.js');seed();
const {routeApi}=await import('../src/api.js');
const {conversationContext,contextKnowledge,repeatsPreviousAnswer,echoesCustomerMessage}=await import('../src/conversation-context.js');
const {processInboundMessage,companyAgentConfig}=await import('../src/agent.js');
const {collectProfileUpdates,repeatedAnsweredQuestion}=await import('../src/lead-profile.js');
const originalFetch=globalThis.fetch;
after(()=>{globalThis.fetch=originalFetch;db.close();for(const suffix of ['','-wal','-shm'])if(existsSync(process.env.DATABASE_PATH+suffix))unlinkSync(process.env.DATABASE_PATH+suffix);});
let serial=0;
function fixture(){
  const contact=Number(run("INSERT INTO contacts(company_id,name,phone) VALUES (1,'Cliente QA',?)",['+551187600'+String(++serial).padStart(4,'0')]).lastInsertRowid);
  const conversation=Number(run("INSERT INTO conversations(contact_id,mode) VALUES (?,'autopilot')",[contact]).lastInsertRowid);
  return {contact,conversation};
}
function message(f,direction,content,created='2026-10-30T11:00:00.000Z'){
  return Number(run('INSERT INTO messages(conversation_id,direction,sender_type,content,created_at) VALUES (?,?,?,?,?)',[f.conversation,direction,direction==='inbound'?'contact':'ai',content,created]).lastInsertRowid);
}
test('histórico mistura datas SQL e ISO sem agrupar mensagens por formato',async()=>{
  const f=fixture();const one=message(f,'inbound','Quais produtos vocês têm?');const two=message(f,'outbound','Temos climatização. Para qual ambiente?','2026-10-30 11:01:00');const three=message(f,'inbound','Para um galpão','2026-10-30T11:02:00Z');
  const result=await routeApi({method:'GET'},null,new URL(`http://local/api/conversations/${f.conversation}`),null,{user:{id:1,companyId:1}});
  assert.deepEqual(result.messages.map(item=>item.id),[one,two,three]);
  assert.equal(result.messages[1].created_at,'2026-10-30T11:01:00.000Z');
  assert.deepEqual(conversationContext(f.conversation,1,three).history.map(item=>item.id),[one,two,three]);
});
test('memória guarda declarações e inclui resposta enviada após a entrada do cliente',()=>{
  const f=fixture();const input=message(f,'inbound','É para resfriar uma sala de servidores');const sent=message(f,'outbound','Entendi, qual a metragem da sala de servidores?','2026-10-30 11:01:00');
  const context=conversationContext(f.conversation,1,input);
  assert.ok(context.history.some(item=>item.id===sent));
  assert.equal(context.memory.customer_statements[0].message_id,input);
  assert.match(context.memory.last_question,/metragem/);
  assert.equal(get('SELECT COUNT(*) n FROM conversation_memory WHERE conversation_id=?',[f.conversation]).n,1);
  assert.throws(()=>conversationContext(f.conversation,999,input),/Conversa não encontrada/);
});
test('memória persiste a necessidade anterior além da janela de mensagens',()=>{
  const f=fixture();const first=message(f,'inbound','Quero climatização para um galpão industrial');conversationContext(f.conversation,1,first);
  let latest;
  for(let n=0;n<70;n++)latest=message(f,'inbound',`Informação comercial complementar ${n}`,new Date(Date.UTC(2026,9,30,12,0,n)).toISOString());
  const context=conversationContext(f.conversation,1,latest);
  assert.equal(context.history.length,60);
  assert.ok(context.memory.customer_statements.some(item=>item.message_id===first));
});
test('busca usa contexto de resposta curta e respeita empresa e documentos ativos',()=>{
  const company=Number(run("INSERT INTO company_profiles(name,slug) VALUES ('Empresa contextual QA','contextual-qa')").lastInsertRowid);
  const add=(companyId,title,content,status='active',priority=1)=>Number(run('INSERT INTO knowledge_documents(company_id,title,category,content,status,priority) VALUES (?,?,?,?,?,?)',[companyId,title,'QA',content,status,priority]).lastInsertRowid);
  const expected=add(company,'Climatização de galpão','A metragem do galpão orienta o orçamento de climatização.');
  add(company,'Sistema CRM','Gestão de contatos e funil de vendas.','active',99);
  add(company,'Climatização antiga','Metragem do galpão e climatização.','archived',100);
  add(1,'Climatização de outra empresa','Metragem do galpão e climatização.','active',100);
  const docs=contextKnowledge('Sim',company,{memory:{last_question:'Qual a metragem do galpão para climatização?'}});
  assert.equal(docs[0].id,expected);assert.equal(docs.length,1);
});
test('bloqueia resposta idêntica mas permite repetição solicitada pelo cliente',()=>{
  const response='Para a sala de servidores, qual é a metragem aproximada?';
  assert.equal(repeatsPreviousAnswer(response,response,'É um ambiente de 50 metros quadrados.'),true);
  assert.equal(repeatsPreviousAnswer(response,response,'Pode repetir a mesma resposta?'),false);
});
test('diálogo completo envia memória e conhecimento contextual sem escalar uma pergunta curta',async()=>{
  const f=fixture();
  companyAgentConfig(1);
  run("UPDATE company_agent_config SET autonomy_level=2,confidence_threshold=.72,company_name='Clima QA',objective='Atender climatização de ambientes; uma pergunta por vez.' WHERE company_id=1");
  Object.assign(process.env,{AI_API_URL:'https://model.invalid/v1/chat/completions',AI_API_KEY:'qa-only',AI_MODEL:'qa-model'});
  const answers=['Trabalhamos com climatização. Para qual ambiente você precisa?','Entendi, é para um galpão. Qual a metragem aproximada?','Obrigado por esclarecer: é uma sala de servidores. Qual é a metragem dessa sala?'];
  let turn=0;
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);const prompt=body.messages[0].content;
    assert.match(prompt,/Clima QA/);assert.match(prompt,/Memória desta conversa/);assert.match(prompt,/Não reinicie o atendimento/);
    if(turn===2){assert.match(prompt,/servidor/);assert.ok(body.messages.some(item=>item.role==='assistant'&&item.content.includes('galpão')));}
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({response:answers[turn++],applied_rule_ids:[],analysis:{intent:'produto',confidence:.6,handoff_reason:null,summary:'Necessidade de climatização identificada.'},contact_updates:[]})}}]})};
  };
  for(const [n,text] of ['Quais são seus produtos?','Para um galpão','Na verdade, para resfriar o servidor da minha empresa'].entries()){
    const id=message(f,'inbound',text,new Date(Date.UTC(2026,9,30,14,n)).toISOString());
    const result=await processInboundMessage(f.conversation,id);assert.equal(result.status,'completed');
  }
  assert.equal(turn,3);assert.equal(get('SELECT mode FROM conversations WHERE id=?',[f.conversation]).mode,'autopilot');
  assert.match(get('SELECT last_response FROM conversation_memory WHERE conversation_id=?',[f.conversation]).last_response,/sala de servidores/);
});

test('resposta repetida não é reenviada nem substituída por transferência genérica',async()=>{
  const f=fixture();let calls=0;
  globalThis.fetch=async()=>({ok:true,json:async()=>{calls++;return {choices:[{message:{content:JSON.stringify({response:'Para climatizar esse ambiente, qual é a metragem aproximada?',analysis:{intent:'produto',confidence:.9,handoff_reason:null},contact_updates:[],applied_rule_ids:[]})}}]}}});
  const first=message(f,'inbound','Preciso climatizar um galpão',new Date().toISOString());
  await processInboundMessage(f.conversation,first);
  const second=message(f,'inbound','O galpão tem aproximadamente 200 metros quadrados',new Date().toISOString());
  await assert.rejects(()=>processInboundMessage(f.conversation,second),error=>error.code==='AI_REPEATED_RESPONSE'&&error.retryable===true);
  assert.equal(calls,2);assert.equal(get('SELECT mode FROM conversations WHERE id=?',[f.conversation]).mode,'autopilot');
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND direction='outbound'",[f.conversation]).n,1);
});

test('resposta repetida é reformulada na fila e não deixa a conversa em humano',async()=>{
  const f=fixture();const {queueInboundMessage,processPendingInboundMessages}=await import('../src/agent.js');
  let turn=0;
  const original='Para climatizar esse ambiente, qual é a metragem aproximada?';
  globalThis.fetch=async(_url,options)=>{
    const request=JSON.parse(options.body);turn++;
    if(turn===3)assert.match(request.messages[0].content,/geração anterior foi rejeitada/);
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({response:turn<3?original:'Entendi os 200 metros quadrados. Esse ambiente tem pé-direito alto?',analysis:{intent:'produto',confidence:.9,handoff_reason:null},contact_updates:[],applied_rule_ids:[]})}}]})};
  };
  await processInboundMessage(f.conversation,message(f,'inbound','Preciso climatizar um galpão',new Date().toISOString()));
  const latest=message(f,'inbound','O galpão tem 200 metros quadrados',new Date().toISOString());queueInboundMessage(f.conversation,latest);
  const repeated=await processPendingInboundMessages(1,latest);
  assert.equal(repeated.results[0].status,'retry_scheduled');assert.equal(get('SELECT mode FROM conversations WHERE id=?',[f.conversation]).mode,'autopilot');
  run("UPDATE inbound_agent_jobs SET next_attempt_at=datetime('now','-1 second') WHERE message_id=?",[latest]);
  await processPendingInboundMessages(1,latest);
  assert.equal(turn,3);assert.equal(get('SELECT status FROM inbound_agent_jobs WHERE message_id=?',[latest]).status,'completed');
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND direction='outbound'",[f.conversation]).n,2);
});

test('resposta curta à pergunta da empresa fica registrada antes da próxima geração',async()=>{
  const f=fixture();
  message(f,'outbound','Qual é o nome da sua empresa?',new Date().toISOString());
  const id=message(f,'inbound','AJAX SOLUTIONS',new Date().toISOString());
  globalThis.fetch=async(_url,options)=>{
    const request=JSON.parse(options.body);
    assert.match(request.messages[0].content,/"company":"AJAX SOLUTIONS"/);
    assert.equal(get('SELECT company FROM contacts WHERE id=?',[f.contact]).company,'AJAX SOLUTIONS');
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({response:'Obrigado! Para quando vocês precisam da climatização?',analysis:{intent:'produto',confidence:.9,handoff_reason:null},contact_updates:[],applied_rule_ids:[]})}}]})};
  };
  await processInboundMessage(f.conversation,id);
  const saved=get('SELECT company,custom_fields FROM contacts WHERE id=?',[f.contact]);
  assert.equal(saved.company,'AJAX SOLUTIONS');
  assert.equal(JSON.parse(saved.custom_fields).profile_sources.company.message_id,id);
  assert.equal(JSON.parse(saved.custom_fields).profile_sources.company.evidence,'AJAX SOLUTIONS');
  assert.equal(get('SELECT mode FROM conversations WHERE id=?',[f.conversation]).mode,'autopilot');
});

test('perguntas curtas repetidas e paráfrases de pergunta respondida são bloqueadas',()=>{
  assert.equal(repeatsPreviousAnswer('Qual é sua empresa?','Qual é sua empresa?','AJAX SOLUTIONS'),true);
  const contact={company:'AJAX SOLUTIONS'};
  assert.equal(repeatedAnsweredQuestion('Pode informar o nome da sua empresa?',contact),'company');
  assert.equal(repeatedAnsweredQuestion('O nome da sua empresa é AJAX SOLUTIONS. Qual é o prazo?',contact),null);
  assert.equal(repeatedAnsweredQuestion('Entendi! Como a sua empresa se chama?',contact),'company');
});

test('esclarecimentos, recusa e respostas ambíguas não viram nome de empresa',()=>{
  for(const text of ['Como assim?','Não sei','não quero informar','Vamos continuar?','?','não entendi','pode explicar','obrigado','não tenho empresa']){
    const f=fixture();message(f,'outbound','Qual é o nome da sua empresa?');
    const id=message(f,'inbound',text);
    assert.deepEqual(collectProfileUpdates(f.contact,get('SELECT * FROM messages WHERE id=?',[id])),[]);
    assert.equal(get('SELECT company FROM contacts WHERE id=?',[f.contact]).company,null);
  }
  const f=fixture();message(f,'outbound','Qual é seu nome? Qual é o nome da sua empresa?');
  const id=message(f,'inbound','João');
  assert.deepEqual(collectProfileUpdates(f.contact,get('SELECT * FROM messages WHERE id=?',[id])),[]);
});

test('eco do dado do cliente não é uma resposta de atendimento',()=>{
  assert.equal(echoesCustomerMessage('AJAX SOLUTIONS','AJAX SOLUTIONS'),true);
  assert.equal(echoesCustomerMessage('220 V','220 V'),true);
  assert.equal(echoesCustomerMessage('Bom dia!','Bom dia'),false);
  assert.equal(echoesCustomerMessage('Obrigado! Qual é o prazo?','AJAX SOLUTIONS'),false);
});

test('empresa respondida não gera nova pergunta da empresa, mesmo com palavras diferentes',async()=>{
  const f=fixture();const {queueInboundMessage,processPendingInboundMessages}=await import('../src/agent.js');
  message(f,'outbound','Qual é o nome da sua empresa?',new Date().toISOString());
  const id=message(f,'inbound','AJAX SOLUTIONS',new Date().toISOString());let calls=0;
  globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({response:++calls===1?'Como a sua empresa se chama?':'Entendi, AJAX SOLUTIONS. Para quando vocês precisam do equipamento?',analysis:{intent:'produto',confidence:.9,handoff_reason:null},contact_updates:[],applied_rule_ids:[]})}}]})});
  queueInboundMessage(f.conversation,id);
  const first=await processPendingInboundMessages(1,id);
  assert.equal(first.results[0].status,'retry_scheduled');
  assert.equal(get("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND direction='outbound'",[f.conversation]).n,1);
  run("UPDATE inbound_agent_jobs SET next_attempt_at=datetime('now','-1 second') WHERE message_id=?",[id]);
  await processPendingInboundMessages(1,id);
  assert.equal(calls,2);
  assert.equal(get('SELECT status FROM inbound_agent_jobs WHERE message_id=?',[id]).status,'completed');
  assert.equal(get('SELECT mode FROM conversations WHERE id=?',[f.conversation]).mode,'autopilot');
  assert.match(get("SELECT content FROM messages WHERE conversation_id=? AND direction='outbound' ORDER BY id DESC LIMIT 1",[f.conversation]).content,/Para quando/);
});

test('copiloto não altera cadastro a partir de resposta curta',async()=>{
  const f=fixture();run('UPDATE company_agent_config SET autonomy_level=1 WHERE company_id=1');
  message(f,'outbound','Qual é o nome da sua empresa?',new Date().toISOString());
  const id=message(f,'inbound','AJAX SOLUTIONS',new Date().toISOString());
  globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({response:'Obrigado! Qual é o prazo?',analysis:{intent:'produto',confidence:.9,handoff_reason:null},contact_updates:[],applied_rule_ids:[]})}}]})});
  try{await processInboundMessage(f.conversation,id);assert.equal(get('SELECT company FROM contacts WHERE id=?',[f.contact]).company,null);}
  finally{run('UPDATE company_agent_config SET autonomy_level=2 WHERE company_id=1');}
});
