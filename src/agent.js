import { all, db, get, now, run } from './db.js';
import { sendWhatsAppText } from './whatsapp.js';
import { recalculateContactQualification } from './qualification.js';
import { currentVercelOidcToken } from './request-context.js';

const HANDOFF_PATTERNS = {
  pedido_humano: /(?:falar|conversar|atendimento).{0,18}(?:pessoa|humano|atendente|vendedor|gerente)|(?:quero|pode|chame|chamar|preciso d[eo]).{0,18}(?:atendente|vendedor|gerente)|falar com algu[eé]m/i,
  reclamacao: /(?:reclama|péssim|horrível|absurdo|processo|procon|decepcionad|cancelar)/i,
  desconto: /(?:desconto|mais barato|reduzir o valor|negociar pre[cç]o)/i
};

export function ensureCompanyAgentConfig(companyId = 1) {
  const company = get('SELECT name FROM company_profiles WHERE id=?', [companyId]);
  const base = get('SELECT * FROM agent_config WHERE id=1');
  run(`INSERT OR IGNORE INTO company_agent_config
    (company_id,name,company_name,tone,objective,autonomy_level,confidence_threshold,max_tool_steps,business_hours,handoff_rules,followup_rules)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [companyId, base?.name || 'Atenva', company?.name || base?.company_name || 'Atenva', base?.tone || 'claro, acolhedor e objetivo', base?.objective || 'qualificar leads e agendar demonstrações', base?.autonomy_level ?? 2, base?.confidence_threshold ?? 0.72, base?.max_tool_steps ?? 5, base?.business_hours || '{}', base?.handoff_rules || '[]', base?.followup_rules || '{}']);
}

export function companyAgentConfig(companyId = 1) {
  ensureCompanyAgentConfig(companyId);
  return get('SELECT * FROM company_agent_config WHERE company_id=?', [companyId]);
}

function classifyIntent(text) {
  const normalized = text.toLowerCase();
  if (HANDOFF_PATTERNS.pedido_humano.test(text)) return ['pedido_humano', 0.98];
  if (HANDOFF_PATTERNS.reclamacao.test(text)) return ['reclamacao', 0.91];
  if (HANDOFF_PATTERNS.desconto.test(text)) return ['desconto', 0.88];
  if (/(?:agendar|marcar|agenda|demonstra[cç][aã]o|reuni[aã]o|amanh[aã]|hor[aá]rio)/i.test(normalized)) return ['agendamento', 0.9];
  if (/(?:pre[cç]o|custa|valor|plano|mensalidade)/i.test(normalized)) return ['preco', 0.9];
  if (/(?:funciona|recurso|integra|faz o qu[eê]|como usar)/i.test(normalized)) return ['produto', 0.84];
  if (/(?:ol[aá]|bom dia|boa tarde|boa noite|oi\b)/i.test(normalized)) return ['saudacao', 0.83];
  return ['duvida_geral', 0.66];
}

function firstName(name = '') {
  return name.trim().split(/\s+/)[0] || 'tudo bem';
}

function logTool(runId, name, args, result, status = 'completed', requiresApproval = 0) {
  run(`INSERT INTO tool_calls
    (run_id, tool_name, arguments, result, status, requires_approval, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [runId, name, JSON.stringify(args), JSON.stringify(result), status, requiresApproval, now()]);
}

function searchKnowledge(query, companyId = 1) {
  const tokens = query.toLowerCase().replace(/[^a-zà-ÿ0-9\s]/g, ' ').split(/\s+/).filter(word => word.length > 3);
  if (!tokens.length) return [];
  const ftsQuery = tokens.slice(0, 6).map(token => `"${token.replace(/"/g, '')}"`).join(' OR ');
  try {
    return all(`SELECT d.id, d.title, d.category, d.content, d.priority, d.is_authoritative
      FROM knowledge_fts f JOIN knowledge_documents d ON d.id = f.rowid
      WHERE knowledge_fts MATCH ? AND d.status = 'active' AND d.company_id=?
      ORDER BY d.is_authoritative DESC,d.priority DESC,bm25(knowledge_fts) LIMIT 3`, [ftsQuery, companyId]);
  } catch {
    return all(`SELECT id, title, category, content,priority,is_authoritative FROM knowledge_documents WHERE status = 'active' AND company_id=? ORDER BY is_authoritative DESC,priority DESC,updated_at DESC LIMIT 3`, [companyId]);
  }
}

export function approvedLearningRules(companyId = 1) {
  return all(`SELECT id,instruction,applies_to,example_question,corrected_response,source_type,updated_at
    FROM agent_learning_rules WHERE company_id=? AND status='approved' ORDER BY updated_at DESC,id DESC LIMIT 40`, [companyId]);
}

function normalizedWords(value = '') {
  return new Set(normalizedText(value).split(' ').filter(word => word.length >= 4));
}

export function applicableLearningRules(prompt, intent, rules = []) {
  const input = normalizedText(prompt);
  const inputWords = normalizedWords(`${prompt} ${String(intent).replaceAll('_',' ')}`);
  const intentSignals = {
    preco: ['preco','valor','plano','desconto','caro','orcamento','negociacao','objecao'],
    agendamento: ['agenda','agendamento','reuniao','demonstracao','horario'],
    produto: ['produto','servico','recurso','funciona','integracao'],
    saudacao: ['saudacao','abertura','primeiro contato'],
    reclamacao: ['reclamacao','insatisfacao','cancelamento'],
    desconto: ['desconto','negociacao','preco','objecao']
  };
  return rules.filter(rule => {
    const scope = normalizedText(rule.applies_to);
    if (/toda (a )?jornada|todas? (as )?(etapas|conversas|respostas)|geral|sempre/.test(scope)) return true;
    const ruleText = `${rule.applies_to} ${rule.instruction} ${rule.example_question || ''}`;
    const ruleWords = normalizedWords(ruleText);
    if ([...ruleWords].some(word => inputWords.has(word))) return true;
    const normalizedRule = normalizedText(ruleText);
    return (intentSignals[intent] || []).some(signal => normalizedRule.includes(signal));
  }).slice(0, 12);
}

export function agentModelStatus() {
  const gatewayToken = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || currentVercelOidcToken();
  const customToken = process.env.AI_API_KEY;
  const gateway = Boolean(gatewayToken) && !process.env.AI_API_URL;
  const configured = Boolean(gatewayToken || (customToken && process.env.AI_API_URL));
  return {
    configured,
    provider: gateway ? 'Vercel AI Gateway' : customToken && process.env.AI_API_URL ? 'Endpoint personalizado' : 'Motor local',
    model: process.env.AI_MODEL || process.env.AI_GATEWAY_MODEL || (gateway ? 'openai/gpt-5.4-mini' : null)
  };
}

function ensureDeal(contactId, ownerId, intent) {
  let deal = get(`SELECT d.*, COALESCE(ps.display_name,s.display_name,s.name) AS stage_name,s.pipeline_id,
    COALESCE(ps.local_position,s.local_position,s.position) AS stage_position FROM deals d
    JOIN contacts ct ON ct.id=d.contact_id JOIN pipeline_stages s ON s.id = d.stage_id
    LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=ct.company_id
    WHERE d.contact_id = ? ORDER BY d.id DESC LIMIT 1`, [contactId]);
  if (deal) return deal;
  const contact = get('SELECT name, company, company_id FROM contacts WHERE id = ?', [contactId]);
  const stage = get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
    WHERE p.company_id=? AND p.kind='sales' ORDER BY p.is_default DESC, s.local_position LIMIT 1`, [contact.company_id]);
  if (!stage) throw new Error('Pipeline comercial não configurado para esta empresa.');
  const result = run(`INSERT INTO deals (contact_id, stage_id, owner_id, title, score)
    VALUES (?, ?, ?, ?, ?)`, [contactId, stage.id, ownerId, `${contact.company || contact.name} · Nova oportunidade`, intent === 'preco' ? 55 : 35]);
  return get(`SELECT d.*, COALESCE(ps.display_name,s.display_name,s.name) AS stage_name,s.pipeline_id,
    COALESCE(ps.local_position,s.local_position,s.position) AS stage_position FROM deals d
    JOIN contacts ct ON ct.id=d.contact_id JOIN pipeline_stages s ON s.id=d.stage_id
    LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=ct.company_id WHERE d.id=?`, [Number(result.lastInsertRowid)]);
}

function normalizedText(value='') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}

function configuredConversationStage(deal, message, companyId) {
  const current=get(`SELECT s.pipeline_id,COALESCE(ps.local_position,s.local_position,s.position) AS position FROM pipeline_stages s
    LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=? WHERE s.id=?`,[companyId,deal.stage_id]);
  if(!current)return null;
  const messageText=normalizedText(message);
  const candidates=all(`SELECT r.stage_id,r.trigger_phrases,COALESCE(ps.display_name,s.display_name,s.name) AS label,
    COALESCE(ps.local_position,s.local_position,s.position) AS position FROM conversation_stage_rules r
    JOIN pipeline_stages s ON s.id=r.stage_id LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=r.company_id
    WHERE r.company_id=? AND r.is_active=1 AND s.pipeline_id=? AND COALESCE(ps.local_position,s.local_position,s.position)>?
      AND COALESCE(ps.is_visible,1)=1 ORDER BY position`,[companyId,current.pipeline_id,current.position]);
  let selected=null;
  for(const candidate of candidates){
    let phrases=[];try{phrases=JSON.parse(candidate.trigger_phrases||'[]');}catch{phrases=String(candidate.trigger_phrases||'').split(',');}
    const matched=phrases.map(value=>({raw:String(value).trim(),normalized:normalizedText(value)})).filter(item=>item.normalized&&messageText.includes(item.normalized));
    if(!matched.length)continue;
    const score=Math.max(...matched.map(item=>item.normalized.length));
    if(!selected||score>selected.score||(score===selected.score&&candidate.position<selected.position))selected={...candidate,matched:matched.map(item=>item.raw),score};
  }
  return selected;
}

function automateDealStage(deal, intent, contactId, message='') {
  if (deal.status && deal.status !== 'open') return deal;
  const contact=get('SELECT company_id FROM contacts WHERE id=?',[contactId]);
  const configured=configuredConversationStage(deal,message,contact?.company_id||1);
  if(configured){
    run('UPDATE deals SET stage_id=?, updated_at=? WHERE id=?',[configured.stage_id,now(),deal.id]);
    run('INSERT OR IGNORE INTO tag_definitions (name,category,stage_id) VALUES (?,\'stage\',?)',[configured.label,configured.stage_id]);
    run('INSERT OR IGNORE INTO contact_tags (contact_id,tag) VALUES (?,?)',[contactId,configured.label]);
    run(`INSERT INTO activities(contact_id,deal_id,actor_type,action,description,metadata) VALUES (?,?,'ai','conversation_stage_move',?,?)`,
      [contactId,deal.id,`Conversa moveu o negócio para ${configured.label}.`,JSON.stringify({matched_phrases:configured.matched,from_stage_id:deal.stage_id,to_stage_id:configured.stage_id})]);
    return {...deal,stage_id:configured.stage_id,stage_name:configured.label,automation_reason:`Sinais encontrados: ${configured.matched.join(', ')}`};
  }
  const targetLabel = intent === 'agendamento' ? 'Demonstração' : ['preco', 'produto'].includes(intent) && deal.score >= 45 ? 'Qualificado' : null;
  if (!targetLabel) return deal;
  const current=get(`SELECT s.pipeline_id,COALESCE(ps.local_position,s.local_position,s.position) AS position FROM pipeline_stages s
    LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=? WHERE s.id=?`,[contact?.company_id||1,deal.stage_id]);
  const stage = get(`SELECT s.id,COALESCE(ps.display_name,s.display_name,s.name) AS label FROM pipeline_stages s
    LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=?
    WHERE s.pipeline_id=? AND COALESCE(ps.display_name,s.display_name,s.name)=?
      AND COALESCE(ps.local_position,s.local_position,s.position)>? AND COALESCE(ps.is_visible,1)=1 LIMIT 1`, [contact?.company_id||1,current?.pipeline_id||deal.pipeline_id,targetLabel,current?.position||0]);
  if (!stage || stage.id === deal.stage_id) return deal;
  run('UPDATE deals SET stage_id=?, updated_at=? WHERE id=?', [stage.id, now(), deal.id]);
  run('INSERT OR IGNORE INTO tag_definitions (name,category,stage_id) VALUES (?,\'stage\',?)', [stage.label, stage.id]);
  run('INSERT OR IGNORE INTO contact_tags (contact_id,tag) VALUES (?,?)', [contactId, stage.label]);
  return { ...deal, stage_id: stage.id, stage_name: stage.label };
}

function updateLeadScore(dealId, intent) {
  const increments = { preco: 12, agendamento: 20, produto: 8, saudacao: 2, duvida_geral: 4 };
  const amount = increments[intent] || 0;
  run('UPDATE deals SET score = MIN(100, score + ?), updated_at = ? WHERE id = ?', [amount, now(), dealId]);
  return get('SELECT score FROM deals WHERE id = ?', [dealId]);
}

function scheduleFollowup(conversation, contact) {
  const due = new Date(Date.now() + 24 * 3_600_000).toISOString();
  const existing = get(`SELECT id FROM tasks WHERE conversation_id = ? AND type = 'followup' AND status = 'pending'`, [conversation.id]);
  if (!existing) {
    run(`INSERT INTO tasks (company_id, contact_id, conversation_id, assigned_to, title, description, due_at, type, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'followup', 'ai')`,
    [contact.company_id || 1, contact.id, conversation.id, conversation.assigned_to, `Retomar contato com ${firstName(contact.name)}`, 'Seguimento criado automaticamente pelo agente.', due]);
  }
  return { scheduled: !existing, due_at: due };
}

function handoff(conversation, contact, runId, reason) {
  run(`UPDATE conversations SET mode = 'human', priority = ?, next_action = ?, updated_at = ? WHERE id = ?`,
    [reason === 'reclamacao' ? 'urgent' : 'high', `Atendimento humano necessário: ${reason.replaceAll('_', ' ')}.`, now(), conversation.id]);
  logTool(runId, 'transferir_para_humano', { reason }, { assigned_to: conversation.assigned_to, status: 'transferred' });
  run(`INSERT INTO activities (contact_id, conversation_id, actor_type, action, description)
    VALUES (?, ?, 'ai', 'human_handoff', ?)`, [contact.id, conversation.id, `Conversa transferida: ${reason.replaceAll('_', ' ')}.`]);
  return `Entendi, ${firstName(contact.name)}. Vou chamar uma pessoa da nossa equipe para continuar com você. Já deixei todo o contexto organizado para que não precise repetir nada.`;
}

async function askConfiguredModel({ config, contact, conversation, history, knowledge, learningRules = [], contactContext, intent }) {
  const relevantRules = applicableLearningRules(history.at(-1)?.content || '', intent, learningRules);
  const system = `Você é ${config.name}, agente comercial da ${config.company_name}. Tom: ${config.tone}.
Objetivo: ${config.objective}. Responda em português do Brasil, com no máximo 3 frases curtas.
Não invente informações. Não ofereça descontos. Quando faltar informação, faça apenas uma pergunta.
Retorne somente JSON no formato {"response":"texto para o cliente","applied_rule_ids":[1,2]}.
Em applied_rule_ids inclua apenas IDs de instruções que alteraram concretamente esta resposta. Não liste uma regra apenas porque ela estava disponível.
Intenção detectada: ${intent}. Contexto CRM: ${conversation.summary || 'sem resumo'}.
Histórico individual do contato: ${contactContext || 'sem atividades anteriores'}.
Instruções evolutivas aprovadas pela equipe (aplique quando o contexto indicado for pertinente):
${relevantRules.map(item => `- ID ${item.id} [${item.applies_to}] ${item.instruction}${item.corrected_response ? ` Exemplo aprovado: ${item.corrected_response}` : ''}`).join('\n') || '- Nenhuma instrução evolutiva pertinente.'}
Conhecimento aprovado:\n${knowledge.map(item => `${item.title}: ${item.content}`).join('\n') || 'Nenhum trecho encontrado.'}`;
  const gatewayToken = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || currentVercelOidcToken();
  const token = gatewayToken || process.env.AI_API_KEY;
  const endpoint = process.env.AI_API_URL || (gatewayToken ? 'https://ai-gateway.vercel.sh/v1/chat/completions' : null);
  const model = process.env.AI_MODEL || process.env.AI_GATEWAY_MODEL || (gatewayToken ? 'openai/gpt-5.4-mini' : null);
  if (!endpoint || !token || !model) return null;
  const messages = history.slice(-8).map(message => ({ role: message.direction === 'inbound' ? 'user' : 'assistant', content: message.content }));
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      max_tokens: 320,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `Modelo respondeu com status ${response.status}`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) return null;
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = { response: content, applied_rule_ids: [] }; }
  const allowedIds = new Set(relevantRules.map(rule => Number(rule.id)));
  const appliedRuleIds = [...new Set((Array.isArray(parsed.applied_rule_ids) ? parsed.applied_rule_ids : []).map(Number).filter(id => allowedIds.has(id)))];
  return {
    text: String(parsed.response || '').trim(),
    appliedRuleIds,
    model: payload.model || model,
    provider: gatewayToken ? 'Vercel AI Gateway' : 'Endpoint personalizado',
    usage: payload.usage || null
  };
}

export async function previewAgentResponse({ companyId = 1, question }) {
  const prompt=String(question||'').trim().slice(0,4000);
  if(!prompt)throw Object.assign(new Error('Escreva uma mensagem para testar o agente.'),{statusCode:400});
  const config=companyAgentConfig(companyId);const [intent,confidence]=classifyIntent(prompt);const knowledge=searchKnowledge(prompt,companyId);const learningRules=approvedLearningRules(companyId);
  const contact={name:'Contato de teste',company_id:companyId};const conversation={summary:'Simulação no laboratório do agente.'};const history=[{direction:'inbound',content:prompt}];
  let generation=null;let modelError=null;try{generation=await askConfiguredModel({config,contact,conversation,history,knowledge,learningRules,contactContext:'Simulação sem alterar dados do CRM.',intent});}catch(error){modelError=error.message;}
  const response=generation?.text||fallbackResponse({intent,contact,knowledge,conversation,config});
  const appliedIds=new Set(generation?.appliedRuleIds||[]);
  return {response,intent,confidence,knowledge:knowledge.map(item=>item.title),applied_rules:learningRules.filter(item=>appliedIds.has(Number(item.id))).map(item=>({id:item.id,instruction:item.instruction,applies_to:item.applies_to})),generation:{live:Boolean(generation?.text),provider:generation?.provider||'Motor local',model:generation?.model||null,error:modelError}};
}

const COMMAND_ACTIONS = new Set(['update_agent_config','add_learning_rule','add_knowledge','create_task']);

function localCommandPlan(message, config) {
  const text=String(message||'').trim();const normalized=normalizedText(text);const actions=[];
  const tone=text.match(/(?:tom de voz|tom)\s*(?:para|como|:|-)?\s*([^.!?\n]{4,180})/i)?.[1]?.trim();
  const objective=text.match(/(?:objetivo)\s*(?:para|como|:|-)?\s*([^.!?\n]{4,260})/i)?.[1]?.trim();
  const autonomy=text.match(/autonomia[^0-3]*(0|1|2|3)/i)?.[1];
  if(tone||objective||autonomy!==undefined)actions.push({type:'update_agent_config',label:'Atualizar comportamento do agente do WhatsApp',arguments:{...(tone?{tone}:{}),...(objective?{objective}:{}),...(autonomy!==undefined?{autonomy_level:Number(autonomy)}:{})}});
  if(!actions.length&&/(sempre|nunca|regra|instrucao|instrução|responda|termine|pergunte|evite)/i.test(text))actions.push({type:'add_learning_rule',label:'Adicionar comando ao playbook vivo',arguments:{instruction:text,applies_to:'Toda a jornada comercial'}});
  const reply=actions.length
    ? `Entendi. Preparei ${actions.length===1?'uma alteração':'as alterações'} para o agente que atende no WhatsApp. Revise abaixo e clique em Aplicar para ativar.`
    : `Posso ajustar o agente do WhatsApp, ensinar uma regra, adicionar conhecimento ou criar uma tarefa. Explique o resultado desejado; se faltar algum dado, eu pergunto antes de propor a mudança.`;
  return {reply,actions,questions:actions.length?[]:['Você quer testar uma resposta para um lead?','Quer consultar contatos, negócios ou tarefas?','Quer que eu crie uma tarefa?'],model:{live:false,provider:'Motor local',model:null},config_name:config.name};
}

function crmAssistantContext(companyId=1) {
  const company=get('SELECT name FROM company_profiles WHERE id=?',[companyId]);
  const metrics=get(`SELECT
    (SELECT COUNT(*) FROM contacts WHERE company_id=?) AS contacts,
    (SELECT COUNT(*) FROM deals d JOIN contacts c ON c.id=d.contact_id WHERE c.company_id=? AND d.status='open') AS open_deals,
    (SELECT COUNT(*) FROM tasks WHERE company_id=? AND status='pending') AS pending_tasks,
    (SELECT COUNT(*) FROM conversations v JOIN contacts c ON c.id=v.contact_id WHERE c.company_id=? AND v.status!='closed') AS open_conversations,
    (SELECT COUNT(*) FROM conversations v JOIN contacts c ON c.id=v.contact_id WHERE c.company_id=? AND v.status!='closed' AND (SELECT direction FROM messages WHERE conversation_id=v.id ORDER BY id DESC LIMIT 1)='inbound') AS unanswered`,[companyId,companyId,companyId,companyId,companyId]);
  const team=all(`SELECT u.id,u.name,m.role FROM users u JOIN user_company_memberships m ON m.user_id=u.id WHERE m.company_id=? AND m.is_active=1 AND u.is_active=1 ORDER BY u.name LIMIT 30`,[companyId]);
  const contacts=all(`SELECT id,name,company,source,lifecycle,qualification,last_seen_at FROM contacts WHERE company_id=? ORDER BY COALESCE(last_seen_at,updated_at,created_at) DESC LIMIT 20`,[companyId]);
  const deals=all(`SELECT d.id,d.title,d.value_cents,d.score,d.status,d.expected_close_at,c.id AS contact_id,c.name AS contact_name,c.company,
    COALESCE(ps.display_name,s.display_name,s.name) AS stage,u.id AS owner_id,u.name AS owner_name
    FROM deals d JOIN contacts c ON c.id=d.contact_id JOIN pipeline_stages s ON s.id=d.stage_id
    LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=c.company_id LEFT JOIN users u ON u.id=d.owner_id
    WHERE c.company_id=? ORDER BY CASE d.status WHEN 'open' THEN 0 ELSE 1 END,d.updated_at DESC LIMIT 20`,[companyId]);
  const tasks=all(`SELECT t.id,t.title,t.description,t.due_at,t.type,t.priority,t.status,t.contact_id,t.deal_id,t.assigned_to,u.name AS assigned_name,c.name AS contact_name
    FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to LEFT JOIN contacts c ON c.id=t.contact_id
    WHERE t.company_id=? ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END,t.due_at LIMIT 20`,[companyId]);
  const conversations=all(`SELECT v.id,v.status,v.mode,v.summary,v.next_action,v.last_message_at,c.id AS contact_id,c.name AS contact_name,c.company,
    (SELECT content FROM messages m WHERE m.conversation_id=v.id ORDER BY m.id DESC LIMIT 1) AS last_message,
    (SELECT direction FROM messages m WHERE m.conversation_id=v.id ORDER BY m.id DESC LIMIT 1) AS last_direction
    FROM conversations v JOIN contacts c ON c.id=v.contact_id WHERE c.company_id=? ORDER BY v.last_message_at DESC LIMIT 15`,[companyId]);
  return {company:company?.name||'Empresa',metrics,team,contacts,deals,tasks,conversations};
}

function localCrmAnswer(message, context) {
  const text=normalizedText(message);const metrics=context?.metrics||{};
  if(/quant|total|resumo|como esta|como estamos/.test(text)&&/(contato|negocio|tarefa|conversa|crm|funil)/.test(text)){
    return `No CRM há ${metrics.contacts||0} contatos, ${metrics.open_deals||0} negócios em aberto, ${metrics.pending_tasks||0} tarefas pendentes e ${metrics.open_conversations||0} conversas abertas. ${metrics.unanswered||0} conversa(s) aguardam resposta.`;
  }
  if(/nao respond|aguardando resposta|precisa responder/.test(text)){
    const pending=(context?.conversations||[]).filter(item=>item.last_direction==='inbound');
    return pending.length?`Aguardam resposta: ${pending.map(item=>item.contact_name).join(', ')}.`:'Não encontrei conversas aguardando resposta.';
  }
  return null;
}

function localTaskProposal(message, context) {
  const text=String(message||'').trim();if(!/(?:crie|criar|adicione|adicionar|agende|agendar).{0,24}tarefa|tarefa.{0,24}(?:crie|criar|adicione|agende)/i.test(text))return null;
  let dueAt=null;const due=new Date();
  if(/amanh[aã]/i.test(text)){due.setDate(due.getDate()+1);due.setHours(9,0,0,0);}
  const time=text.match(/(?:às|as)\s*(\d{1,2})(?::(\d{2}))?\s*h?/i);if(time){if(!dueAt&&!/amanh[aã]/i.test(text))due.setDate(due.getDate());due.setHours(Math.min(23,Number(time[1])),Math.min(59,Number(time[2]||0)),0,0);}
  if(/amanh[aã]/i.test(text)||time)dueAt=due.toISOString();
  const matchedContact=(context?.contacts||[]).find(item=>normalizedText(text).includes(normalizedText(item.name)));
  const matchedDeal=(context?.deals||[]).find(item=>normalizedText(text).includes(normalizedText(item.title))||matchedContact&&Number(item.contact_id)===Number(matchedContact.id));
  const title=text.replace(/^(?:por favor[,.]?\s*)?(?:crie|criar|adicione|adicionar|agende|agendar)\s+(?:uma\s+)?tarefa\s*(?:para|de|:|-)?\s*/i,'').replace(/\s+(?:amanh[aã]|hoje)(?:\s+(?:às|as)\s*\d{1,2}(?::\d{2})?\s*h?)?.*$/i,'').trim()||'Nova tarefa solicitada ao Agente Atenva';
  return {type:'create_task',label:`Criar tarefa: ${title.slice(0,100)}`,arguments:{title:title.slice(0,160),description:'Criada pelo Agente Atenva a partir da conversa do vendedor.',...(dueAt?{due_at:dueAt}:{}),...(matchedContact?{contact_id:matchedContact.id}:{}),...(matchedDeal?{deal_id:matchedDeal.id}:{})}};
}

export async function planAgentCommand({ companyId = 1, message, history = [] }) {
  const prompt=String(message||'').trim().slice(0,5000);if(!prompt)throw Object.assign(new Error('Escreva um comando para o agente.'),{statusCode:400});
  const config=companyAgentConfig(companyId);const rules=approvedLearningRules(companyId).slice(0,12);const documents=all(`SELECT title,category FROM knowledge_documents WHERE company_id=? AND status='active' ORDER BY priority DESC,updated_at DESC LIMIT 12`,[companyId]);const crmContext=crmAssistantContext(companyId);
  const gatewayToken=process.env.AI_GATEWAY_API_KEY||process.env.VERCEL_OIDC_TOKEN||currentVercelOidcToken();const token=gatewayToken||process.env.AI_API_KEY;
  const endpoint=process.env.AI_API_URL||(gatewayToken?'https://ai-gateway.vercel.sh/v1/chat/completions':null);const model=process.env.AI_MODEL||process.env.AI_GATEWAY_MODEL||(gatewayToken?'openai/gpt-5.4-mini':null);
  if(!endpoint||!token||!model){const task=localTaskProposal(prompt,crmContext);if(task)return {reply:'Preparei a tarefa para sua revisão. Confira os dados e clique em Aplicar.',actions:[task],questions:[],model:{live:false,provider:'Motor local',model:null}};const crmReply=localCrmAnswer(prompt,crmContext);if(crmReply)return {reply:crmReply,actions:[],questions:['Quer ver os negócios em aberto?','Quer listar as tarefas pendentes?','Quer preparar uma resposta para algum contato?'],model:{live:false,provider:'Motor local',model:null}};return localCommandPlan(prompt,config);}
  const system=`Você é o copiloto comercial ${config.name}, da ${config.company_name}, dentro do CRM. Converse naturalmente como um excelente ChatGPT para vendedores.
Você pode: responder perguntas sobre os dados fornecidos do CRM; resumir leads, negócios, tarefas e conversas; redigir respostas prontas para leads; orientar o vendedor; e converter pedidos de alteração em propostas auditáveis. Nunca invente dados e nunca execute alterações diretamente.
Responda somente JSON: {"reply":"resposta útil e direta","actions":[{"type":"tipo","label":"descrição clara","arguments":{}}],"questions":["próxima pergunta curta"]}.
Use questions para oferecer até 3 continuações relevantes, no estilo de perguntas sugeridas. Se o pedido estiver ambíguo, faça uma pergunta de esclarecimento no reply e retorne actions vazio.
Ferramentas permitidas:
- update_agent_config: arguments pode conter name, tone, objective, autonomy_level (0 a 3).
- add_learning_rule: instruction e applies_to.
- add_knowledge: title, category e content.
- create_task: title, description, due_at em ISO, type, priority, assigned_to, contact_id e deal_id. Use somente IDs presentes no contexto.
Não proponha enviar mensagens, excluir dados, alterar credenciais ou acessar outra empresa. Se faltarem dados, faça uma pergunta e retorne actions vazio. Máximo de 3 ações.
Configuração atual: tom=${config.tone}; objetivo=${config.objective}; autonomia=${config.autonomy_level}.
Regras ativas: ${rules.map(rule=>rule.instruction).join(' | ')||'nenhuma'}.
Conhecimentos: ${documents.map(doc=>`${doc.category}: ${doc.title}`).join(' | ')||'nenhum'}.
Contexto atual e exclusivo desta empresa: ${JSON.stringify(crmContext)}.`;
  try{
    const conversation=(Array.isArray(history)?history:[]).slice(-16).map(item=>({role:item.role==='assistant'?'assistant':'user',content:String(item.content||'').slice(0,5000)}));if(!conversation.length||conversation.at(-1).content!==prompt)conversation.push({role:'user',content:prompt});
    const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({model,temperature:.2,max_tokens:900,response_format:{type:'json_object'},messages:[{role:'system',content:system},...conversation]})});
    if(!response.ok){const problem=await response.json().catch(()=>({}));throw new Error(problem?.error?.message||problem?.message||`Modelo respondeu com status ${response.status}`);}const payload=await response.json();const content=payload.choices?.[0]?.message?.content;const parsed=JSON.parse(content||'{}');
    const actions=(Array.isArray(parsed.actions)?parsed.actions:[]).filter(action=>COMMAND_ACTIONS.has(action?.type)&&action.arguments&&typeof action.arguments==='object').slice(0,3).map(action=>({type:action.type,label:String(action.label||'Alteração proposta').slice(0,180),arguments:action.arguments}));
    const questions=(Array.isArray(parsed.questions)?parsed.questions:[]).map(item=>String(item||'').trim().slice(0,180)).filter(Boolean).slice(0,3);
    return {reply:String(parsed.reply||'Como posso ajudar você com esta venda?').slice(0,4000),actions,questions,model:{live:true,provider:gatewayToken?'Vercel AI Gateway':'Endpoint personalizado',model:payload.model||model}};
  }catch(error){
    console.error('[agent] falha no modelo real; usando contingência local',{companyId,error:error.message,model});
    const fallback=localCommandPlan(prompt,config);
    fallback.model={...fallback.model,error:error.message||'Falha ao acessar o modelo real.'};
    fallback.reply=`${fallback.reply}\n\nO modelo de IA não respondeu nesta tentativa. O modo local foi usado e nenhuma alteração foi aplicada sem confirmação.`;
    return fallback;
  }
}

function fallbackResponse({ intent, contact, knowledge, conversation, config }) {
  const name = firstName(contact.name);
  const agentName = String(config?.name || 'Atenva').trim() || 'Atenva';
  const companyName = String(config?.company_name || 'Atenva').trim() || 'Atenva';
  if (intent === 'preco') {
    const pricing = knowledge.find(item => /pre[cç]o|plano/i.test(`${item.title} ${item.content}`));
    if (pricing) return `Claro, ${name}. Temos planos a partir de R$ 249 por mês e a opção ideal depende do tamanho da equipe. Quantas pessoas vão utilizar o CRM?`;
  }
  if (intent === 'agendamento') {
    return `Perfeito, ${name}. Posso organizar uma demonstração de 25 minutos em dias úteis, entre 9h e 18h. Qual dia e horário prefere?`;
  }
  if (intent === 'produto') {
    return `O ${companyName || 'CRM'} centraliza o WhatsApp, organiza o funil e usa IA para qualificar e acompanhar leads. Qual é hoje o maior desafio da sua equipe com o atendimento?`;
  }
  if (intent === 'saudacao') {
    return `Olá, ${name}! Sou ${agentName}, assistente virtual da ${companyName}. Posso ajudar com planos, funcionamento do produto ou marcar uma demonstração. O que gostaria de resolver?`;
  }
  return `Obrigado por explicar, ${name}. Para eu direcionar corretamente: procura melhorar o atendimento, organizar as vendas ou automatizar o acompanhamento dos leads?`;
}

export async function processInboundMessage(conversationId, triggerMessageId) {
  const started = Date.now();
  const conversation = get(`SELECT c.*, u.name AS assigned_name FROM conversations c
    LEFT JOIN users u ON u.id = c.assigned_to WHERE c.id = ?`, [conversationId]);
  if (!conversation || conversation.mode === 'human' || conversation.status === 'closed') return null;
  const contact = get('SELECT * FROM contacts WHERE id = ?', [conversation.contact_id]);
  const config = companyAgentConfig(contact.company_id || 1);
  const trigger = get('SELECT * FROM messages WHERE id = ?', [triggerMessageId]);
  if (!trigger) return null;

  if (config.autonomy_level === 0) {
    run(`UPDATE conversations SET mode='human', next_action='Agente desativado; responder manualmente.', updated_at=? WHERE id=?`, [now(), conversationId]);
    return { response: null, intent: null, confidence: null, status: 'disabled' };
  }

  const [intent, confidence] = classifyIntent(trigger.content);
  const runResult = run(`INSERT INTO agent_runs
    (conversation_id, trigger_message_id, status, intent, confidence, reasoning_summary)
    VALUES (?, ?, 'running', ?, ?, ?)`,
  [conversationId, triggerMessageId, intent, confidence, `Intenção ${intent} detectada com confiança de ${Math.round(confidence * 100)}%.`]);
  const runId = Number(runResult.lastInsertRowid);

  try {
    let responseText;
    let generation = null;
    let runStatus = 'completed';
    const handoffReason = Object.entries(HANDOFF_PATTERNS).find(([, pattern]) => pattern.test(trigger.content))?.[0];
    if (handoffReason || confidence < config.confidence_threshold) {
      const reason = handoffReason || 'baixa_confianca';
      if (config.autonomy_level === 1) {
        responseText = `Entendi, ${firstName(contact.name)}. Vou chamar uma pessoa da nossa equipe para continuar com você.`;
        runStatus = 'completed';
      } else {
        responseText = handoff(conversation, contact, runId, reason);
        runStatus = 'handoff';
      }
    } else {
      const knowledge = searchKnowledge(trigger.content, contact.company_id || 1);
      const learningRules = approvedLearningRules(contact.company_id || 1);
      logTool(runId, 'consultar_conhecimento', { query: trigger.content }, { documents: knowledge.map(item => item.title) });

      const deal = ensureDeal(contact.id, conversation.assigned_to, intent);
      logTool(runId, 'criar_ou_atualizar_oportunidade', { contact_id: contact.id, intent }, { deal_id: deal.id, stage: deal.stage_name });
      const score = updateLeadScore(deal.id, intent);
      logTool(runId, 'pontuar_lead', { intent }, { score: score.score });
      deal.score = score.score;
      const automatedDeal = automateDealStage(deal, intent, contact.id, trigger.content);
      if (automatedDeal.stage_id !== deal.stage_id) logTool(runId, 'atualizar_etapa_automaticamente', { intent, message:trigger.content }, { stage: automatedDeal.stage_name, reason:automatedDeal.automation_reason||`Intenção ${intent}` });
      const qualification = recalculateContactQualification(contact.id);
      logTool(runId, 'qualificar_lead', { contact_id: contact.id }, { qualification });

      if (intent === 'agendamento') {
        const task = scheduleFollowup(conversation, contact);
        logTool(runId, 'agendar_followup', { conversation_id: conversation.id }, task);
      }

      const history = all('SELECT direction, content FROM messages WHERE conversation_id = ? ORDER BY id', [conversationId]);
      const contactContext=all(`SELECT action,description,created_at FROM activities WHERE contact_id=? ORDER BY id DESC LIMIT 12`,[contact.id]).map(item=>`${item.created_at}: ${item.description}`).join(' | ');
      try {
        generation = await askConfiguredModel({ config, contact, conversation, history, knowledge, learningRules, contactContext, intent });
        responseText = generation?.text || null;
        if (generation?.text) logTool(runId, 'gerar_resposta_ia', { model:generation.model }, { provider:generation.provider,model:generation.model,applied_rule_ids:generation.appliedRuleIds,usage:generation.usage });
      } catch (modelError) {
        logTool(runId, 'gerar_resposta_ia', {}, { error: modelError.message }, 'failed');
      }
      responseText ||= fallbackResponse({ intent, contact, knowledge, conversation, config });

      run(`UPDATE conversations SET intent = ?, summary = ?, next_action = ?, updated_at = ? WHERE id = ?`,
        [intent, `${firstName(contact.name)} demonstrou interesse relacionado a ${intent.replaceAll('_', ' ')}.`,
          intent === 'agendamento' ? 'Confirmar data e horário da demonstração.' : 'Aguardar resposta do cliente.', now(), conversationId]);
    }

    if (config.autonomy_level === 1) {
      const suggestion = run(`INSERT INTO messages
        (conversation_id, direction, sender_type, type, content, status, metadata)
        VALUES (?, 'internal', 'ai', 'text', ?, 'received', ?)`,
      [conversationId, `Sugestão de ${config.name}: ${responseText}`, JSON.stringify({ run_id: runId, confidence, suggestion: true, model:generation?.model||null, provider:generation?.provider||'Motor local', applied_rule_ids:generation?.appliedRuleIds||[] })]);
      run(`UPDATE conversations SET mode='copilot', next_action=?, updated_at=? WHERE id=?`, [`Revisar e enviar a sugestão de ${config.name}.`, now(), conversationId]);
      const actionCount = get('SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?', [runId]).count;
      run(`UPDATE agent_runs SET status='completed', action_count=?, duration_ms=?, completed_at=? WHERE id=?`, [actionCount, Date.now() - started, now(), runId]);
      return { runId, messageId: Number(suggestion.lastInsertRowid), response: responseText, intent, confidence, status: 'suggested' };
    }

    const outbound = await sendWhatsAppText(contact.whatsapp_id || contact.phone.replace(/\D/g, ''), responseText, contact.company_id || 1);
    const messageResult = run(`INSERT INTO messages
      (conversation_id, whatsapp_message_id, direction, sender_type, type, content, status, metadata)
      VALUES (?, ?, 'outbound', 'ai', 'text', ?, ?, ?)`,
    [conversationId, outbound.id, responseText, outbound.status || 'sent', JSON.stringify({ run_id: runId, confidence, simulated: outbound.simulated, model:generation?.model||null, provider:generation?.provider||'Motor local', applied_rule_ids:generation?.appliedRuleIds||[] })]);
    run('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?', [now(), now(), conversationId]);
    run(`INSERT INTO activities (contact_id, conversation_id, actor_type, action, description, metadata)
      VALUES (?, ?, 'ai', 'message_sent', ?, ?)`, [contact.id, conversationId, 'Agente respondeu automaticamente.', JSON.stringify({ intent, confidence })]);

    const actionCount = get('SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?', [runId]).count;
    run(`UPDATE agent_runs SET status = ?, action_count = ?, duration_ms = ?, completed_at = ? WHERE id = ?`,
      [runStatus, actionCount, Date.now() - started, now(), runId]);
    return { runId, messageId: Number(messageResult.lastInsertRowid), response: responseText, intent, confidence, status: runStatus };
  } catch (error) {
    run(`UPDATE agent_runs SET status = 'failed', error = ?, duration_ms = ?, completed_at = ? WHERE id = ?`,
      [error.message, Date.now() - started, now(), runId]);
    run(`UPDATE conversations SET mode = 'human', priority = 'high', next_action = 'Agente falhou; atendimento humano necessário.', updated_at = ? WHERE id = ?`, [now(), conversationId]);
    throw error;
  }
}

export { classifyIntent, searchKnowledge };
