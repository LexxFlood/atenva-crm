import { all, asJson, get, now, run, transaction } from './db.js';
import { sendWhatsAppTemplate, sendWhatsAppText } from './whatsapp.js';

const sourceLabels={manual:'Cadastro manual',whatsapp:'WhatsApp',instagram:'Instagram',facebook:'Facebook',meta_ads:'Meta Ads',google_ads:'Google Ads',indicacao:'Indicação',organico:'Orgânico',outro:'Outro'};

export function recordAttribution({companyId,contactId,dealId=null,eventType='touch',source=null,medium=null,campaign=null,content=null,referrer=null,destination=null,metadata={}}){
  if(!companyId||!contactId)return null;
  const result=run(`INSERT INTO contact_attribution_events(company_id,contact_id,deal_id,event_type,source,medium,campaign,content,referrer,destination,metadata,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[companyId,contactId,dealId,eventType,source||null,medium||null,campaign||null,content||null,referrer||null,destination||null,JSON.stringify(metadata||{}),now()]);
  return Number(result.lastInsertRowid);
}

export function ensureAttributionHistory(companyId){
  const missing=all(`SELECT ct.id,ct.source,ct.created_at,d.id AS deal_id,p.name AS pipeline_name,COALESCE(s.display_name,s.name) AS stage_name
    FROM contacts ct LEFT JOIN deals d ON d.id=(SELECT id FROM deals WHERE contact_id=ct.id ORDER BY id LIMIT 1)
    LEFT JOIN pipeline_stages s ON s.id=d.stage_id LEFT JOIN pipelines p ON p.id=s.pipeline_id
    WHERE ct.company_id=? AND NOT EXISTS(SELECT 1 FROM contact_attribution_events e WHERE e.contact_id=ct.id AND e.company_id=ct.company_id)`,[companyId]);
  for(const item of missing)run(`INSERT INTO contact_attribution_events(company_id,contact_id,deal_id,event_type,source,medium,destination,metadata,occurred_at)
    VALUES (?,?,?,'first_touch',?,'crm',?,?,?)`,[companyId,item.id,item.deal_id,item.source||'manual',item.pipeline_name&&item.stage_name?`${item.pipeline_name} · ${item.stage_name}`:item.pipeline_name||'Base de contatos',JSON.stringify({backfilled:true}),item.created_at||now()]);
  return missing.length;
}

function relationshipSegment(item){
  if(item.deal_status==='open')return 'em_negociacao';
  const days=item.last_interaction_at?Math.floor((Date.now()-new Date(item.last_interaction_at).getTime())/86400000):999;
  if(Number(item.won_count)>0&&days<=60)return 'cliente_ativo';
  if(Number(item.won_count)>0&&days<=120)return 'em_risco';
  if(item.lifecycle==='inactive'||days>120)return 'inativo';
  return 'novo';
}

export function relationshipOverview(companyId){
  ensureAttributionHistory(companyId);
  const contacts=all(`SELECT ct.id,ct.name,ct.phone,ct.email,ct.company,ct.source,ct.lifecycle,ct.consent_status,ct.created_at,ct.updated_at,
    COALESCE((SELECT MAX(m.created_at) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.contact_id=ct.id),ct.last_seen_at,ct.updated_at) AS last_interaction_at,
    (SELECT COUNT(*) FROM deals dw WHERE dw.contact_id=ct.id AND dw.status='won') AS won_count,
    (SELECT COALESCE(SUM(dw.value_cents),0) FROM deals dw WHERE dw.contact_id=ct.id AND dw.status='won') AS ltv_cents,
    d.id AS deal_id,d.status AS deal_status,d.value_cents,COALESCE(s.display_name,s.name) AS stage_name,p.name AS pipeline_name,
    (SELECT e.campaign FROM contact_attribution_events e WHERE e.contact_id=ct.id AND e.campaign IS NOT NULL ORDER BY e.occurred_at LIMIT 1) AS first_campaign,
    (SELECT COUNT(*) FROM relationship_cadence_enrollments ce WHERE ce.contact_id=ct.id AND ce.status='active') AS active_cadences
    FROM contacts ct LEFT JOIN deals d ON d.id=(SELECT id FROM deals WHERE contact_id=ct.id ORDER BY id DESC LIMIT 1)
    LEFT JOIN pipeline_stages s ON s.id=d.stage_id LEFT JOIN pipelines p ON p.id=s.pipeline_id
    WHERE ct.company_id=? ORDER BY last_interaction_at DESC,ct.id DESC`,[companyId]).map(item=>({...item,source_label:sourceLabels[item.source]||item.source||'Não informado',relationship_segment:relationshipSegment(item),destination:item.pipeline_name?(item.stage_name?`${item.pipeline_name} · ${item.stage_name}`:item.pipeline_name):(item.lifecycle==='customer'?'Base de clientes':'Base de contatos')}));
  const counts={novo:0,em_negociacao:0,cliente_ativo:0,em_risco:0,inativo:0};
  contacts.forEach(item=>{counts[item.relationship_segment]=(counts[item.relationship_segment]||0)+1;});
  return {contacts,summary:{total:contacts.length,...counts,customers:contacts.filter(item=>Number(item.won_count)>0).length,ltv_cents:contacts.reduce((sum,item)=>sum+Number(item.ltv_cents||0),0),active_cadences:contacts.reduce((sum,item)=>sum+Number(item.active_cadences||0),0)}};
}

export function contactJourney(companyId,contactId){
  const contact=get('SELECT * FROM contacts WHERE id=? AND company_id=?',[contactId,companyId]);
  if(!contact)throw Object.assign(new Error('Contato não encontrado.'),{statusCode:404});
  ensureAttributionHistory(companyId);
  const attribution=all('SELECT * FROM contact_attribution_events WHERE company_id=? AND contact_id=? ORDER BY occurred_at,id',[companyId,contactId]).map(item=>({...item,metadata:asJson(item.metadata,{})}));
  const activities=all(`SELECT a.*,d.title AS deal_title FROM activities a LEFT JOIN deals d ON d.id=a.deal_id WHERE a.contact_id=? ORDER BY a.created_at,a.id`,[contactId]).map(item=>({...item,metadata:asJson(item.metadata,{})}));
  const cadenceRuns=all(`SELECT r.*,c.name AS cadence_name,s.position,s.action_type FROM relationship_cadence_runs r
    JOIN relationship_cadence_enrollments e ON e.id=r.enrollment_id JOIN relationship_cadences c ON c.id=e.cadence_id
    LEFT JOIN relationship_cadence_steps s ON s.id=r.step_id WHERE e.company_id=? AND e.contact_id=? ORDER BY r.executed_at,r.id`,[companyId,contactId]).map(item=>({...item,metadata:asJson(item.metadata,{})}));
  return {contact,attribution,activities,cadence_runs:cadenceRuns};
}

function hydrateCadence(item){
  return {...item,audience_filter:asJson(item.audience_filter,{}),steps:all('SELECT * FROM relationship_cadence_steps WHERE cadence_id=? ORDER BY position',[item.id])};
}

export function listCadences(companyId){
  return all(`SELECT c.*,
    (SELECT COUNT(*) FROM relationship_cadence_enrollments e WHERE e.cadence_id=c.id AND e.status='active') AS active_count,
    (SELECT COUNT(*) FROM relationship_cadence_enrollments e WHERE e.cadence_id=c.id AND e.status='completed') AS completed_count
    FROM relationship_cadences c WHERE c.company_id=? AND c.status<>'archived' ORDER BY c.updated_at DESC,c.id DESC`,[companyId]).map(hydrateCadence);
}

function cleanSteps(steps){
  const prepared=(Array.isArray(steps)?steps:[]).slice(0,20).map((step,index)=>({position:index+1,delay_hours:Math.max(0,Math.min(8760,Math.round(Number(step.delay_hours)||0))),action_type:step.action_type==='task'?'task':'whatsapp',template_id:step.template_id?Number(step.template_id):null,message:String(step.message||'').trim().slice(0,4000)||null,task_title:String(step.task_title||'').trim().slice(0,160)||null,task_description:String(step.task_description||'').trim().slice(0,1000)||null}));
  if(!prepared.length)throw Object.assign(new Error('Adicione ao menos uma etapa à cadência.'),{statusCode:400});
  for(const step of prepared){if(step.action_type==='whatsapp'&&!step.message&&!step.template_id)throw Object.assign(new Error(`A etapa ${step.position} precisa de uma mensagem ou modelo aprovado.`),{statusCode:400});if(step.action_type==='task'&&!step.task_title)throw Object.assign(new Error(`A etapa ${step.position} precisa de um título para a tarefa.`),{statusCode:400});}
  return prepared;
}

export function saveCadence(companyId,userId,body,id=null){
  const name=String(body?.name||'').trim().slice(0,120);if(!name)throw Object.assign(new Error('Informe o nome da cadência.'),{statusCode:400});
  const steps=cleanSteps(body?.steps);const status=['draft','active','paused'].includes(body?.status)?body.status:'draft';
  let cadenceId=id;
  transaction(()=>{
    if(id){const owned=get('SELECT id FROM relationship_cadences WHERE id=? AND company_id=?',[id,companyId]);if(!owned)throw Object.assign(new Error('Cadência não encontrada.'),{statusCode:404});run(`UPDATE relationship_cadences SET name=?,description=?,audience_filter=?,stop_on_reply=?,stop_on_outcome=?,status=?,updated_at=? WHERE id=?`,[name,String(body.description||'').trim().slice(0,500)||null,JSON.stringify(body.audience_filter||{}),body.stop_on_reply===false?0:1,body.stop_on_outcome===false?0:1,status,now(),id]);run('DELETE FROM relationship_cadence_steps WHERE cadence_id=?',[id]);}
    else{const created=run(`INSERT INTO relationship_cadences(company_id,name,description,audience_filter,stop_on_reply,stop_on_outcome,status,created_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,[companyId,name,String(body.description||'').trim().slice(0,500)||null,JSON.stringify(body.audience_filter||{}),body.stop_on_reply===false?0:1,body.stop_on_outcome===false?0:1,status,userId,now()]);cadenceId=Number(created.lastInsertRowid);}
    for(const step of steps)run(`INSERT INTO relationship_cadence_steps(cadence_id,position,delay_hours,action_type,template_id,message,task_title,task_description) VALUES (?,?,?,?,?,?,?,?)`,[cadenceId,step.position,step.delay_hours,step.action_type,step.template_id,step.message,step.task_title,step.task_description]);
  });
  return hydrateCadence(get('SELECT * FROM relationship_cadences WHERE id=?',[cadenceId]));
}

export function archiveCadence(companyId,id){
  const result=run("UPDATE relationship_cadences SET status='archived',updated_at=? WHERE id=? AND company_id=?",[now(),id,companyId]);
  if(!result.changes)throw Object.assign(new Error('Cadência não encontrada.'),{statusCode:404});
  run("UPDATE relationship_cadence_enrollments SET status='stopped',stop_reason='cadence_archived',updated_at=? WHERE cadence_id=? AND status='active'",[now(),id]);
  return {archived:true};
}

export function enrollContacts(companyId,userId,cadenceId,contactIds){
  const cadence=get("SELECT * FROM relationship_cadences WHERE id=? AND company_id=? AND status IN ('active','draft')",[cadenceId,companyId]);if(!cadence)throw Object.assign(new Error('Cadência não encontrada ou indisponível.'),{statusCode:404});
  const first=get('SELECT * FROM relationship_cadence_steps WHERE cadence_id=? ORDER BY position LIMIT 1',[cadenceId]);if(!first)throw Object.assign(new Error('Cadência sem etapas.'),{statusCode:400});
  const ids=[...new Set((contactIds||[]).map(Number).filter(Number.isInteger))].slice(0,500);if(!ids.length)throw Object.assign(new Error('Selecione ao menos um contato.'),{statusCode:400});
  let enrolled=0,skipped=0;for(const contactId of ids){const contact=get('SELECT * FROM contacts WHERE id=? AND company_id=?',[contactId,companyId]);if(!contact){skipped++;continue;}const conversation=get('SELECT id FROM conversations WHERE contact_id=? ORDER BY id DESC LIMIT 1',[contactId]);const deal=get('SELECT id FROM deals WHERE contact_id=? ORDER BY id DESC LIMIT 1',[contactId]);const nextRun=new Date(Date.now()+Number(first.delay_hours||0)*3600000).toISOString();try{run(`INSERT INTO relationship_cadence_enrollments(company_id,cadence_id,contact_id,deal_id,conversation_id,status,current_step,next_run_at,enrolled_by,updated_at) VALUES (?,?,?,?,?,'active',1,?,?,?)`,[companyId,cadenceId,contactId,deal?.id||null,conversation?.id||null,nextRun,userId,now()]);enrolled++;}catch{skipped++;}}
  if(cadence.status==='draft')run("UPDATE relationship_cadences SET status='active',updated_at=? WHERE id=?",[now(),cadenceId]);
  return {enrolled,skipped};
}

export function stopCadencesForContact(companyId,contactId,reason='reply_received',onlyReply=true){
  const filter=onlyReply?'AND c.stop_on_reply=1':'AND c.stop_on_outcome=1';
  return run(`UPDATE relationship_cadence_enrollments SET status='stopped',stop_reason=?,updated_at=? WHERE id IN
    (SELECT e.id FROM relationship_cadence_enrollments e JOIN relationship_cadences c ON c.id=e.cadence_id WHERE e.company_id=? AND e.contact_id=? AND e.status='active' ${filter})`,[reason,now(),companyId,contactId]).changes;
}

function fillMessage(text,contact){return String(text||'').replace(/{{\s*nome\s*}}/gi,contact.name||'').replace(/{{\s*empresa\s*}}/gi,contact.company||'').replace(/{{\s*telefone\s*}}/gi,contact.phone||'');}

export async function processCadences(companyId=null){
  const params=[];let filter='';if(companyId){filter='AND e.company_id=?';params.push(companyId);}
  const due=all(`SELECT e.*,c.stop_on_reply,c.stop_on_outcome,s.id AS step_id,s.position,s.delay_hours,s.action_type,s.template_id,s.message,s.task_title,s.task_description,
    ct.name,ct.phone,ct.company,ct.consent_status,d.owner_id FROM relationship_cadence_enrollments e JOIN relationship_cadences c ON c.id=e.cadence_id
    JOIN relationship_cadence_steps s ON s.cadence_id=e.cadence_id AND s.position=e.current_step JOIN contacts ct ON ct.id=e.contact_id LEFT JOIN deals d ON d.id=e.deal_id
    WHERE e.status='active' AND c.status='active' AND datetime(e.next_run_at)<=datetime('now') ${filter} ORDER BY e.next_run_at,e.id LIMIT 50`,params);
  const results=[];
  for(const item of due){let status='created',externalId=null,error=null;try{
      if(item.action_type==='task')run(`INSERT INTO tasks(company_id,contact_id,deal_id,conversation_id,assigned_to,title,description,due_at,type,priority,status,created_by) VALUES (?,?,?,?,?,?,?,?,'followup','normal','pending','system')`,[item.company_id,item.contact_id,item.deal_id,item.conversation_id,item.owner_id,fillMessage(item.task_title,item),fillMessage(item.task_description,item)||null,now()]);
      else{
        if(item.consent_status==='revoked')throw new Error('Contato sem consentimento para receber mensagens.');
        if(!item.conversation_id)throw new Error('O contato ainda não possui uma conversa de WhatsApp.');
        const phone=String(item.phone||'').replace(/\D/g,'');if(!phone)throw new Error('Contato sem telefone válido.');
        let sent;if(item.template_id){const template=get("SELECT * FROM message_templates WHERE id=? AND company_id=? AND status='approved'",[item.template_id,item.company_id]);if(!template)throw new Error('Modelo aprovado não encontrado.');sent=await sendWhatsAppTemplate(phone,{name:template.provider_name||template.meta_name,language:template.language,variables:[]},item.company_id);}else sent=await sendWhatsAppText(phone,fillMessage(item.message,item),item.company_id);
        externalId=sent.id;run(`INSERT INTO messages(conversation_id,whatsapp_message_id,direction,sender_type,content,status,metadata) VALUES (?,?,'outbound','system',?,'sent',?)`,[item.conversation_id,sent.id,fillMessage(item.message,item)||'[modelo aprovado]',JSON.stringify({cadence_id:item.cadence_id,enrollment_id:item.id,step:item.position,simulated:sent.simulated})]);status='sent';
      }
      const next=get('SELECT * FROM relationship_cadence_steps WHERE cadence_id=? AND position>? ORDER BY position LIMIT 1',[item.cadence_id,item.position]);
      if(next)run('UPDATE relationship_cadence_enrollments SET current_step=?,next_run_at=?,updated_at=? WHERE id=? AND status=\'active\'',[next.position,new Date(Date.now()+Number(next.delay_hours||0)*3600000).toISOString(),now(),item.id]);
      else run("UPDATE relationship_cadence_enrollments SET status='completed',next_run_at=NULL,updated_at=? WHERE id=? AND status='active'",[now(),item.id]);
    }catch(caught){status='failed';error=String(caught.message||caught).slice(0,500);run("UPDATE relationship_cadence_enrollments SET status='failed',stop_reason=?,updated_at=? WHERE id=?",[error,now(),item.id]);}
    run(`INSERT INTO relationship_cadence_runs(enrollment_id,step_id,status,scheduled_at,executed_at,external_id,error,metadata) VALUES (?,?,?,?,?,?,?,?)`,[item.id,item.step_id,status,item.next_run_at,now(),externalId,error,JSON.stringify({action_type:item.action_type})]);results.push({id:item.id,status,error});
  }
  return {processed:results.length,sent:results.filter(item=>item.status==='sent').length,created:results.filter(item=>item.status==='created').length,failed:results.filter(item=>item.status==='failed').length,results};
}
