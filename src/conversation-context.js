import {all,get,run,asJson,now} from './db.js';

const normalize=text=>String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const stopWords=new Set('a ao aos as o os de da das do dos e em um uma uns umas para pra por com que qual quais como quanto quantos voce voces seu seus sua suas tenho tem sao ser esta esse essa isso isto quero gostaria preciso pode poderia sobre mais muito sim nao aqui bom dia boa tarde noite ola obrigado obrigada tudo bem'.split(' '));
function words(text){return [...new Set(normalize(text).split(' ').filter(word=>word.length>=3&&!stopWords.has(word)).map(word=>word.length>4?word.replace(/s$/,''):word))];}
function questionOf(text){return (String(text||'').match(/[^.!?\n]*\?/g)||[]).at(-1)?.trim()||'';}
export function canonicalMessageDate(value){
  const input=String(value||'').trim().replace(' ','T');
  const timestamp=Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)?input:input+'Z');
  return Number.isFinite(timestamp)?new Date(timestamp).toISOString():value;
}
function meaningful(text){const n=normalize(text);return n.length>=6&&!/^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|obrigad[oa]|sim|nao|ok|certo|entendi|como assim|o que|oq|q)$/.test(n);}

export function conversationContext(conversationId,companyId,triggerId){
  const owned=get('SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=? AND ct.company_id=?',[conversationId,companyId]);
  if(!owned)throw Object.assign(new Error('Conversa não encontrada'),{statusCode:404});
  const trigger=get("SELECT id FROM messages WHERE id=? AND conversation_id=? AND direction='inbound'",[triggerId,conversationId]);
  if(!trigger)throw new Error('Mensagem de contexto inválida');
  const history=all(`SELECT * FROM (SELECT id,direction,content,created_at FROM messages WHERE conversation_id=?
    AND direction IN ('inbound','outbound') AND (direction='outbound' OR id<=?) ORDER BY julianday(created_at) DESC,id DESC LIMIT 60)
    ORDER BY julianday(created_at),id`,[conversationId,triggerId]);
  const saved=get('SELECT * FROM conversation_memory WHERE conversation_id=? AND company_id=?',[conversationId,companyId]);
  const statements=asJson(saved?.customer_statements,[]);
  const seen=new Set(statements.map(item=>normalize(item.text)));
  for(const message of history.filter(item=>item.direction==='inbound')){
    if(meaningful(message.content)&&!seen.has(normalize(message.content))){statements.push({message_id:message.id,text:message.content.slice(0,600)});seen.add(normalize(message.content));}
  }
  // These are attributed customer statements, not independently verified facts.
  const retained=[...statements.slice(0,6),...statements.slice(6).slice(-12)];
  const lastOutbound=history.filter(item=>item.direction==='outbound').at(-1);
  const lastResponse=lastOutbound?.content||saved?.last_response||'';
  const lastQuestion=questionOf(lastResponse);
  run(`INSERT INTO conversation_memory(conversation_id,company_id,last_message_id,customer_statements,last_question,last_response,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET last_message_id=excluded.last_message_id,
    customer_statements=excluded.customer_statements,last_question=excluded.last_question,last_response=excluded.last_response,updated_at=excluded.updated_at`,
    [conversationId,companyId,triggerId,JSON.stringify(retained),lastQuestion,lastResponse,now()]);
  return {history,memory:{customer_statements:retained,last_question:lastQuestion,last_response:lastResponse}};
}

export function rememberConversationResponse(conversationId,companyId,response){
  run('UPDATE conversation_memory SET last_response=?,last_question=?,updated_at=? WHERE conversation_id=? AND company_id=?',
    [String(response).slice(0,4000),questionOf(response),now(),conversationId,companyId]);
}

export function contextKnowledge(query,companyId,{memory={},history=[]}={}){
  const current=words(query);
  if(current.some(token=>/^(produto|modelo|catalogo)$/.test(token)))current.push('catalogo','produto','modelo');
  if(current.some(token=>/^(preco|valor|custa)$/.test(token)))current.push('preco','orcamento');
  const previous=words([memory.last_question,...(memory.customer_statements||[]).slice(-4).map(item=>item.text),...history.filter(item=>item.direction==='inbound').slice(-3).map(item=>item.content)].join(' '));
  const documents=all("SELECT id,title,category,content,priority,is_authoritative FROM knowledge_documents WHERE company_id=? AND status='active'",[companyId]);
  const ranked=documents.map(document=>{
    const title=new Set(words(`${document.title} ${document.category}`));const body=new Set(words(document.content));
    const match=tokens=>tokens.reduce((score,token)=>score+(title.has(token)?4:body.has(token)?1:0),0);
    return {document,score:match(current)*5+match(previous)*.5};
  }).sort((a,b)=>b.score-a.score||Number(b.document.is_authoritative)-Number(a.document.is_authoritative)||b.document.priority-a.document.priority||a.document.id-b.document.id);
  const relevant=ranked.filter(item=>item.score>0);
  return (relevant.length?relevant:ranked).slice(0,relevant.length?4:2).map(item=>item.document);
}

export function repeatsPreviousAnswer(response,previous,request){
  if(/\b(repit[ae]|repetir|de novo|novamente|mesma resposta)\b/i.test(request))return false;
  const candidate=normalize(response);return candidate.length>=12&&candidate===normalize(previous);
}

export function echoesCustomerMessage(response,request){
  const candidate=normalize(response);
  return candidate.length>=4&&candidate===normalize(request)&&! /^(oi|ola|bom dia|boa tarde|boa noite|obrigad[oa])$/.test(candidate);
}
