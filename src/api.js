import { createHash, randomBytes } from 'node:crypto';
import { all, asJson, db, databasePath, ensureCompanyPipelines, get, now, run, transaction } from './db.js';
import { agentModelStatus, companyAgentConfig, ensureCompanyAgentConfig, planAgentCommand, previewAgentResponse, processInboundMessage, processPendingInboundMessages, queueInboundMessage } from './agent.js';
import { customerWindowIsOpen, downloadWhatsAppMedia, extractWebhookEvents, sendWhatsAppAudio, sendWhatsAppTemplate, sendWhatsAppText, whatsappDeliveryStatus } from './whatsapp.js';
import { persistDatabaseSnapshot } from './remote-snapshot.js';
import { validateAgentConfig } from './automation-policy.js';
import { runStageAutomations } from './pipeline-automation.js';
import { hashPassword, requireRole, verifyPassword } from './auth.js';
import { activateMetaLeadRetrieval, companyForMetaIdentifiers, companyForMetaPage, completeWhatsAppEmbeddedSignup, fetchMetaLead, metaAdAccounts, metaAdCampaigns, metaAdsInsights, metaAuthorizationUrl, metaBusinesses, metaIsConfigured, metaLeadForms, metaOauthStatus, metaPages, publicMetaConfig, saveMetaConfig, selectMetaBusiness, selectWhatsAppNumber, syncMetaAnalytics, syncMetaMarketing, testMetaConnection } from './integrations.js';
import { qualificationConfig, recalculateContactQualification, recalculateQualifications, saveQualificationConfig } from './qualification.js';
import { approvedTemplates, campaignDetail, campaignList, cancelCampaign, importCampaign, startCampaign, syncApprovedTemplates, updateCampaignDelivery } from './campaigns.js';
import { connectEvolution, disconnectEvolution, evolutionStatus, extractEvolutionWebhookEvents } from './evolution.js';
import { sendInvitationEmail } from './email.js';
import { createGoogleTaskEvent, deleteGoogleTaskEvent, disconnectGoogle, googleAuthorizationUrl, googleCalendarEvents, googleCalendars, googleStatus, syncGoogleCalendar, updateGoogleTaskEvent } from './google-calendar.js';
import { archiveCadence, contactJourney, enrollContacts, listCadences, processCadences, recordAttribution, relationshipOverview, saveCadence, stopCadencesForContact } from './relationships.js';
import { appendHumanSignature, existingLeadOwner, nextLeadOwner } from './team-routing.js';

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('Identificador inválido'), { statusCode: 400 });
  return id;
}

function inviteHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function canAdminCompany(context) {
  return Boolean(context?.user?.isMaster || ['owner', 'admin'].includes(context?.user?.companyRole) || context?.user?.role === 'admin');
}

async function transcribeAudio(dataBase64, mimeType) {
  const audio=Buffer.from(dataBase64,'base64');
  const key=process.env.TRANSCRIPTION_API_KEY||process.env.OPENAI_API_KEY||(process.env.AI_API_URL?process.env.AI_API_KEY:null);
  if(key){
    const configured=String(process.env.TRANSCRIPTION_API_URL||(process.env.OPENAI_API_KEY?'https://api.openai.com/v1':process.env.AI_API_URL)||'https://api.openai.com/v1').replace(/\/chat\/completions\/?$/,'').replace(/\/$/,'');
    const model=process.env.TRANSCRIPTION_MODEL||(new URL(configured).hostname==='api.groq.com'?'whisper-large-v3-turbo':'whisper-1');
    const extension=({'audio/ogg':'ogg','audio/mp4':'m4a','audio/mpeg':'mp3'})[String(mimeType).split(';')[0]]||'webm';
    const form=new FormData(); form.append('file',new Blob([audio],{type:mimeType||'audio/webm'}),`audio.${extension}`); form.append('model',model); form.append('language','pt');
    const response=await fetch(`${configured}/audio/transcriptions`,{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,signal:AbortSignal.timeout(20_000)}); const payload=await response.json().catch(()=>({})); if(!response.ok)throw Object.assign(new Error(payload.error?.message||'Não foi possível transcrever o áudio.'),{statusCode:502}); return String(payload.text||'Áudio sem fala identificável.').slice(0,4000);
  }
  return '[Áudio sem transcrição] Atendimento humano necessário para ouvir esta mensagem.';
}

async function inboundAudioText(base64,mimeType,fallback){
  if(!base64)return fallback;
  try{return await transcribeAudio(base64,mimeType);}
  catch{return '[Áudio sem transcrição] Não foi possível transcrever. A equipe deve ouvir a mensagem no WhatsApp.';}
}

function previouslyReceived(event,companyId){
  const previous=get(`SELECT m.id,m.conversation_id,ct.company_id FROM messages m JOIN conversations c ON c.id=m.conversation_id
    JOIN contacts ct ON ct.id=c.contact_id WHERE m.whatsapp_message_id=?`,[event.externalId]);
  if(!previous)return false;
  if(previous.company_id!==companyId)throw Object.assign(new Error('Mensagem associada a outra empresa.'),{statusCode:409});
  queueInboundMessage(previous.conversation_id,previous.id);
  return true;
}
function syncPlaybook(content, companyId = 1) {
  const text=String(content||''); const tone=text.match(/(?:tom de voz|tom)\s*[:\-]\s*([^\n.]{4,160})/i)?.[1]; const objective=text.match(/(?:objetivo principal|objetivo)\s*[:\-]\s*([^\n]{4,300})/i)?.[1]; const name=text.match(/(?:nome do agente|agente)\s*[:\-]\s*([\p{L} ]{2,40})/iu)?.[1]?.trim(); const mql=Number(text.match(/MQL[^\d]{0,30}(\d{1,3})/i)?.[1]); const sql=Number(text.match(/SQL[^\d]{0,30}(\d{1,3})/i)?.[1]);
  ensureCompanyAgentConfig(companyId);
  const updates=[]; const values=[]; if(name){updates.push('name=?');values.push(name);} if(tone){updates.push('tone=?');values.push(tone.trim());} if(objective){updates.push('objective=?');values.push(objective.trim());} if(updates.length)run(`UPDATE company_agent_config SET ${updates.join(',')},updated_at=? WHERE company_id=?`,[...values,now(),companyId]);
  if((mql>=0&&mql<=100)||(sql>=0&&sql<=100)){const current=qualificationConfig(companyId);saveQualificationConfig({...current,mql_min_score:mql>=0&&mql<=100?mql:current.mql_min_score,sql_min_score:sql>=0&&sql<=100?sql:current.sql_min_score},companyId);}
}

function invitationByToken(token) {
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(String(token || ''))) return null;
  return get(`SELECT i.*, c.name AS company_name,c.status AS company_status,c.trial_ends_at AS company_trial_ends_at,u.name AS inviter_name
    FROM user_invitations i
    LEFT JOIN company_profiles c ON c.id=i.company_id
    JOIN users u ON u.id=i.invited_by
    WHERE i.token_hash=?`, [inviteHash(token)]);
}

function invitationIsUsable(invitation) {
  if(!invitation||invitation.revoked_at||invitation.accepted_at||new Date(invitation.expires_at)<=new Date())return false;
  if(invitation.role==='master'||!invitation.company_id)return true;
  if(invitation.company_status==='active')return true;
  return invitation.company_status==='trial'&&(!invitation.company_trial_ends_at||new Date(invitation.company_trial_ends_at)>new Date());
}

function normalizedCompanySlug(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'empresa';
}

const reservedCompanySlugs = new Set([
  'api', 'assets', 'favicon', 'login', 'logout', 'admin', 'administracao',
  'integracoes', 'convites', 'c', 'atenva'
]);

function uniqueCompanySlug(name) {
  const normalized = normalizedCompanySlug(name);
  const base = reservedCompanySlugs.has(normalized) ? `${normalized}-cliente` : normalized;
  let slug = base;
  let suffix = 1;
  while (get('SELECT id FROM company_profiles WHERE slug=?', [slug])) slug = `${base}-${++suffix}`;
  return slug;
}

function requestBaseUrl(request) {
  const host=String(request?.headers?.['x-forwarded-host']||request?.headers?.host||'').split(',')[0].trim();
  const protocol=String(request?.headers?.['x-forwarded-proto']||'http').split(',')[0].trim();
  return String(host?`${protocol}://${host}`:process.env.PUBLIC_URL||'http://localhost:3210').trim().replace(/\/+$/, '');
}

function oauthCallbackBaseUrl(request) {
  const requested = requestBaseUrl(request);
  const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const allowed = new Set([
    configured,
    'https://atenva-crm.vercel.app',
    'https://mais-tracao-atenva.vercel.app',
    process.env.NODE_ENV === 'production' ? '' : requested
  ].filter(Boolean));
  return allowed.has(requested) ? requested : (configured || 'https://atenva-crm.vercel.app');
}

function companyAccessUrl(request, company) {
  return `${requestBaseUrl(request)}/${encodeURIComponent(company.slug)}`;
}

async function createInvitation({ request, email, role, companyId, inviterId, inviterName }) {
  const existingUser=get('SELECT id,is_master FROM users WHERE lower(email)=?', [email]);
  if(existingUser?.is_master||existingUser&&role==='master')throw Object.assign(new Error('Este e-mail já possui acesso de Onboarding Manager à Atenva.'),{statusCode:409});
  if(existingUser&&get('SELECT 1 FROM user_company_memberships WHERE company_id=? AND user_id=? AND is_active=1',[companyId,existingUser.id]))throw Object.assign(new Error('Este e-mail já possui acesso a esta empresa.'),{statusCode:409});
  const company = companyId ? get('SELECT * FROM company_profiles WHERE id=?', [companyId]) : null;
  if (role !== 'master') {
    const trialActive=company?.status==='trial'&&(!company.trial_ends_at||new Date(company.trial_ends_at)>new Date());
    if (!company || !(company.status==='active'||trialActive)) throw Object.assign(new Error('Selecione uma empresa ativa para o convite.'), { statusCode: 400 });
    const activeMembers = Number(get(`SELECT COUNT(*) AS count FROM user_company_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.company_id=? AND m.is_active=1 AND u.is_master=0`, [companyId])?.count || 0);
    const pendingInvites = Number(get(`SELECT COUNT(*) AS count FROM user_invitations WHERE company_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?`, [companyId, now()])?.count || 0);
    if (activeMembers + pendingInvites >= Number(company.max_users || 10)) throw Object.assign(new Error(`O plano desta empresa permite até ${company.max_users || 10} usuários.`), { statusCode: 409 });
  }
  run(`UPDATE user_invitations SET revoked_at=? WHERE lower(email)=? AND accepted_at IS NULL AND revoked_at IS NULL`, [now(), email]);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const created = run(`INSERT INTO user_invitations (email,role,company_id,token_hash,invited_by,expires_at)
    VALUES (?,?,?,?,?,?)`, [email, role, companyId || null, inviteHash(token), inviterId, expiresAt]);
  const invitationId = Number(created.lastInsertRowid);
  const accessUrl = company ? companyAccessUrl(request, company) : requestBaseUrl(request);
  const inviteUrl = `${accessUrl}?invite=${encodeURIComponent(token)}`;
  let emailDelivery;
  try { emailDelivery = await sendInvitationEmail({ to: email, inviteUrl, inviterName, companyName: company?.name || 'Atenva', role, invitationId }); }
  catch (error) { emailDelivery = { sent: false, reason: error.message }; }
  return { id: invitationId, email, role, company_id: companyId || null, expires_at: expiresAt, invite_url: inviteUrl, email_sent: emailDelivery.sent, email_error: emailDelivery.sent ? null : emailDelivery.reason };
}

function normalizedPhone(value = '') {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) throw Object.assign(new Error('Telefone inválido'), { statusCode: 400 });
  return `+${digits}`;
}

function recoveryPipeline(companyId) {
  return get("SELECT p.id AS pipeline_id,s.id AS stage_id FROM pipelines p JOIN pipeline_stages s ON s.pipeline_id=p.id WHERE p.company_id=? AND lower(p.name)='retomada' ORDER BY s.local_position LIMIT 1", [companyId]);
}

function createRecoveryDeal(deal, strategy, reason, userId, companyId) {
  if (strategy !== 'retomada') return null;
  const target = recoveryPipeline(companyId);
  if (!target) return null;
  const existing = get("SELECT id FROM deals WHERE source_deal_id=? AND status='open'", [deal.id]);
  if (existing) return existing.id;
  const result = run(`INSERT INTO deals (contact_id,stage_id,owner_id,title,value_cents,currency,score,status,source_deal_id)
    VALUES (?,?,?,?,?,?,?,'open',?)`, [deal.contact_id,target.stage_id,deal.owner_id,`Retomada · ${deal.title}`,deal.value_cents,deal.currency,deal.score,deal.id]);
  const id = Number(result.lastInsertRowid);
  run(`INSERT INTO activities(contact_id,deal_id,actor_type,actor_id,action,description,metadata)
    VALUES (?,?,'human',?,'recovery_created',?,?)`, [deal.contact_id,id,userId,`Retomada criada após perda: ${reason}.`,JSON.stringify({source_deal_id:deal.id})]);
  return id;
}

function configuredOutcomeTarget(companyId, pipelineId, outcome) {
  return get(`SELECT r.target_stage_id AS stage_id,s.pipeline_id,p.kind FROM pipeline_outcome_rules r JOIN pipeline_stages s ON s.id=r.target_stage_id JOIN pipelines p ON p.id=s.pipeline_id
    WHERE r.company_id=? AND r.source_pipeline_id=? AND r.outcome=? AND r.is_active=1`, [companyId,pipelineId,outcome]);
}

function createOutcomeFollowup(deal, target, outcome, userId) {
  if (!target?.stage_id) return null;
  const existing=get("SELECT id FROM deals WHERE source_deal_id=? AND status='open'",[deal.id]);if(existing)return existing.id;
  const label=outcome==='lost'?'Pós-perda':'Pós-venda';
  const result=run(`INSERT INTO deals(contact_id,stage_id,owner_id,title,value_cents,currency,score,status,source_deal_id) VALUES (?,?,?,?,?,?,?,'open',?)`,[deal.contact_id,target.stage_id,deal.owner_id,`${label} · ${deal.title}`,deal.value_cents,deal.currency,deal.score,deal.id]);
  const id=Number(result.lastInsertRowid);run(`INSERT INTO activities(contact_id,deal_id,actor_type,actor_id,action,description) VALUES (?,?,'system',?,'outcome_automation',?)`,[deal.contact_id,id,userId,`Automação de ${outcome==='lost'?'perda':'ganho'} criou uma oportunidade em outro funil.`]);return id;
}

function dateRange(url) {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('end') || '') ? url.searchParams.get('end') : new Date().toISOString().slice(0, 10);
  const fallback = new Date(`${end}T12:00:00Z`); fallback.setUTCDate(fallback.getUTCDate() - 29);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('start') || '') ? url.searchParams.get('start') : fallback.toISOString().slice(0, 10);
  return { start, end };
}

function conversationList(companyId) {
  return all(`SELECT
      c.id, c.status, c.mode, c.priority, c.intent, c.sentiment, c.summary, c.next_action,
      c.customer_window_until, c.unread_count, c.last_message_at,
      ct.id AS contact_id, ct.name, ct.phone, ct.email, ct.company, ct.segment, ct.location, ct.qualification, ct.profile_picture_url,
      u.name AS assigned_name, u.avatar AS assigned_avatar,
      d.id AS deal_id, d.title AS deal_title, d.value_cents, d.score, d.status AS deal_status, d.lost_reason,
      s.id AS stage_id, COALESCE(s.display_name,s.name) AS stage_name, s.color AS stage_color,
      p.id AS pipeline_id, p.name AS pipeline_name,
      (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
      (SELECT sender_type FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN users u ON u.id = c.assigned_to
    LEFT JOIN deals d ON d.id = (SELECT id FROM deals WHERE contact_id = ct.id ORDER BY id DESC LIMIT 1)
    LEFT JOIN pipeline_stages s ON s.id = d.stage_id
    LEFT JOIN pipelines p ON p.id = s.pipeline_id
    WHERE ct.company_id = ?
    ORDER BY CASE c.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
             c.last_message_at DESC`, [companyId]);
}

function dashboard(url, companyId) {
  const range = dateRange(url);
  const metrics = get(`SELECT
    (SELECT COUNT(*) FROM contacts WHERE company_id=:companyId AND date(created_at) BETWEEN :start AND :end) AS new_contacts,
    (SELECT COUNT(*) FROM contacts WHERE company_id=:companyId AND lifecycle = 'lead') AS active_leads,
    (SELECT COUNT(*) FROM contacts WHERE company_id=:companyId AND qualification='lead') AS leads,
    (SELECT COUNT(*) FROM contacts WHERE company_id=:companyId AND qualification='mql') AS mqls,
    (SELECT COUNT(*) FROM contacts WHERE company_id=:companyId AND qualification='sql') AS sqls,
    (SELECT COUNT(*) FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=:companyId AND c.status IN ('open','waiting')) AS open_conversations,
    (SELECT COUNT(*) FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=:companyId AND c.status IN ('open','waiting') AND
      (SELECT direction FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1)='inbound') AS unanswered_conversations,
    (SELECT COUNT(*) FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=:companyId AND c.unread_count > 0) AS unread_conversations,
    (SELECT COUNT(*) FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=:companyId AND c.mode = 'human' AND c.status != 'closed') AS handoffs,
    (SELECT COALESCE(SUM(d.value_cents),0) FROM deals d JOIN contacts ct ON ct.id=d.contact_id WHERE ct.company_id=:companyId AND d.status='open') AS pipeline_value,
    (SELECT COUNT(*) FROM deals d JOIN contacts ct ON ct.id=d.contact_id WHERE ct.company_id=:companyId AND d.status='won') AS won_deals,
    (SELECT COALESCE(AVG((julianday((SELECT MIN(o.created_at) FROM messages o WHERE o.conversation_id=i.conversation_id AND o.direction='outbound' AND o.created_at>i.created_at))-julianday(i.created_at))*1440),0)
      FROM messages i JOIN conversations c ON c.id=i.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=:companyId AND i.direction='inbound' AND date(i.created_at) BETWEEN :start AND :end AND EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id=i.conversation_id AND o.direction='outbound' AND o.created_at>i.created_at)) AS response_minutes,
    (SELECT COUNT(*) FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=:companyId AND r.status='completed') AS ai_resolutions,
    (SELECT COUNT(*) FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=:companyId) AS total_runs`, { companyId, start: range.start, end: range.end });

  const stages = all(`SELECT s.id, COALESCE(s.display_name,s.name) AS name, s.local_position AS position, s.color, s.probability,
      COUNT(d.id) AS deal_count, COALESCE(SUM(d.value_cents),0) AS value_cents
    FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id AND p.company_id=? AND p.kind='sales'
    LEFT JOIN deals d ON d.stage_id=s.id AND d.status='open' AND d.contact_id IN (SELECT id FROM contacts WHERE company_id=?)
    GROUP BY s.id ORDER BY s.local_position`, [companyId,companyId]);
  const recentActivities = all(`SELECT a.*, ct.name AS contact_name, ct.company
    FROM activities a LEFT JOIN contacts ct ON ct.id=a.contact_id
    WHERE ct.company_id=? ORDER BY a.created_at DESC LIMIT 8`, [companyId]);
  const tasks = all(`SELECT t.*, ct.name AS contact_name, ct.company, u.name AS assigned_name
    FROM tasks t LEFT JOIN contacts ct ON ct.id=t.contact_id LEFT JOIN users u ON u.id=t.assigned_to
    WHERE t.company_id=? AND t.status='pending' ORDER BY t.due_at LIMIT 8`, [companyId]);
  const trend = all(`WITH RECURSIVE dates(day) AS (
      SELECT date(?) UNION ALL SELECT date(day,'+1 day') FROM dates WHERE day < date(?)
    ) SELECT day,
      (SELECT COUNT(*) FROM contacts WHERE company_id=? AND date(created_at)=day) AS contacts,
      (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=? AND date(m.created_at)=day AND m.direction='inbound') AS inbound,
      (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=? AND date(m.created_at)=day AND m.direction='outbound') AS outbound
    FROM dates ORDER BY day`, [range.start, range.end, companyId, companyId, companyId]);
  const metricDetails = {
    new_contacts: all(`SELECT id, name, company, source, created_at FROM contacts
      WHERE company_id=? AND date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 6`, [companyId, range.start, range.end]),
    open_conversations: all(`SELECT c.id, ct.name, ct.company, c.last_message_at,
        (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message
      FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
      WHERE ct.company_id=? AND c.status IN ('open','waiting') ORDER BY c.last_message_at DESC LIMIT 6`, [companyId]),
    unanswered_conversations: all(`SELECT c.id, ct.name, ct.company, c.last_message_at,
        (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message
      FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
      WHERE ct.company_id=? AND c.status IN ('open','waiting') AND
        (SELECT direction FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1)='inbound'
      ORDER BY c.last_message_at DESC LIMIT 6`, [companyId]),
    pipeline_value: all(`SELECT d.id, d.title, d.value_cents, d.created_at, ct.name AS contact_name,
        COALESCE(s.display_name,s.name) AS stage_name
      FROM deals d JOIN contacts ct ON ct.id=d.contact_id JOIN pipeline_stages s ON s.id=d.stage_id
      WHERE ct.company_id=? AND d.status='open' ORDER BY d.created_at DESC LIMIT 6`, [companyId])
  };
  return { metrics, stages, recentActivities, tasks, conversations: conversationList(companyId).slice(0, 5), trend, range, metricDetails };
}

function getConversation(id, companyId) {
  const conversation = conversationList(companyId).find(item => item.id === id);
  if (!conversation) throw Object.assign(new Error('Conversa não encontrada'), { statusCode: 404 });
  const messages = all(`SELECT m.*, u.name AS sender_name, u.avatar AS sender_avatar
    FROM messages m LEFT JOIN users u ON u.id=m.sender_id
    WHERE m.conversation_id=? ORDER BY m.created_at, m.id`, [id]).map(message => ({
      ...message,
      metadata: asJson(message.metadata)
    }));
  const tags = all('SELECT tag FROM contact_tags WHERE contact_id=? ORDER BY tag', [conversation.contact_id]).map(row => row.tag);
  const activities = all('SELECT * FROM activities WHERE conversation_id=? ORDER BY created_at DESC LIMIT 20', [id]);
  const tasks = all(`SELECT t.*, u.name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to
    WHERE t.conversation_id=? ORDER BY t.status, t.due_at`, [id]);
  const schedules = all(`SELECT sm.* FROM scheduled_messages sm JOIN conversations c ON c.id=sm.conversation_id
    JOIN contacts ct ON ct.id=c.contact_id WHERE sm.conversation_id=? AND ct.company_id=? ORDER BY sm.send_at,sm.id`, [id,companyId])
    .map(item=>({...item,payload:asJson(item.payload,{})}));
  return { ...conversation, messages, tags, activities, tasks, schedules };
}

export async function processScheduledMessages(companyId = null) {
  const deadline=Date.now()+90_000;
  run(`UPDATE scheduled_messages SET status='failed',last_error='Execução interrompida; confira o envio antes de tentar novamente.'
    WHERE status='scheduled' AND claimed_at IS NOT NULL AND datetime(claimed_at)<datetime('now','-10 minutes') AND conversation_id IN
    (SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE (? IS NULL OR ct.company_id=?))`,[companyId,companyId]);
  const params=[];let companyFilter='';
  if(companyId){companyFilter='AND ct.company_id=?';params.push(companyId);}
  const due=all(`SELECT sm.*,c.contact_id,ct.company_id,ct.phone FROM scheduled_messages sm
    JOIN conversations c ON c.id=sm.conversation_id JOIN contacts ct ON ct.id=c.contact_id
    WHERE sm.status='scheduled' AND sm.claimed_at IS NULL AND datetime(sm.send_at)<=datetime('now') ${companyFilter}
    ORDER BY sm.send_at,sm.id LIMIT 50`,params);
  const results=[];
  for(const item of due){
    if(Date.now()+25_000>deadline)break;
    const payload=asJson(item.payload,{});const content=String(payload.content||'').trim();
    if(!content){run("UPDATE scheduled_messages SET status='failed' WHERE id=? AND status='scheduled'",[item.id]);results.push({id:item.id,status:'failed'});continue;}
    const claim=run("UPDATE scheduled_messages SET claimed_at=?,attempts=attempts+1 WHERE id=? AND status='scheduled' AND claimed_at IS NULL",[now(),item.id]);
    if(!claim.changes)continue;
    try{
      await persistDatabaseSnapshot(databasePath,db);
      const signedContent=appendHumanSignature(item.company_id,payload.created_by,content);
      let sent;
      if(item.template_id){
        const template=get("SELECT * FROM message_templates WHERE id=? AND company_id=? AND source='meta' AND status='approved'",[item.template_id,item.company_id]);
        if(!template)throw Object.assign(new Error('Modelo aprovado não encontrado para esta empresa.'),{retryable:false});
        sent=await sendWhatsAppTemplate(String(item.phone||'').replace(/\D/g,''),{name:template.provider_name||template.meta_name,language:template.language,variables:payload.variables||[]},item.company_id);
      }else sent=await sendWhatsAppText(String(item.phone||'').replace(/\D/g,''),signedContent,item.company_id,{conversationId:item.conversation_id});
      const claimed=run("UPDATE scheduled_messages SET status='sent' WHERE id=? AND status='scheduled'",[item.id]);
      if(!claimed.changes)continue;
      run(`INSERT INTO messages(conversation_id,whatsapp_message_id,direction,sender_type,sender_id,content,status,metadata)
        VALUES (?,?,'outbound','system',?,?,?,?)`,[item.conversation_id,sent.id,payload.created_by||null,signedContent,sent.status,JSON.stringify({scheduled_message_id:item.id,kind:payload.kind||'followup',simulated:sent.simulated})]);
      run('UPDATE conversations SET last_message_at=?,updated_at=? WHERE id=?',[now(),now(),item.conversation_id]);
      results.push({id:item.id,status:sent.simulated?'simulated':'sent'});
    }catch(error){
      const retry=error.retryable===true && item.attempts+1<3;
      run("UPDATE scheduled_messages SET status=?,claimed_at=NULL,send_at=?,last_error=?,payload=? WHERE id=? AND status='scheduled'",
        [retry?'scheduled':'failed',retry?new Date(Date.now()+60_000*2**item.attempts).toISOString():item.send_at,String(error.message).slice(0,500),JSON.stringify({...payload,error:String(error.message||error).slice(0,300)}),item.id]);
      results.push({id:item.id,status:retry?'retry_scheduled':'failed',error:error.message});
    }
    await persistDatabaseSnapshot(databasePath,db);
  }
  const inbound=await processPendingInboundMessages(companyId,null,deadline);
  const cadences=await processCadences(companyId,deadline);
  const result={processed:results.length+cadences.processed+inbound.processed,sent:results.filter(item=>item.status==='sent').length+cadences.sent,simulated:results.filter(item=>item.status==='simulated').length,created:cadences.created,failed:results.filter(item=>item.status==='failed').length+cadences.failed+inbound.failed,results,cadences,inbound};
  if(companyId===null)run('INSERT INTO automation_health(id,last_run_at,result) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET last_run_at=excluded.last_run_at,result=excluded.result',[now(),JSON.stringify({processed:result.processed,failed:result.failed})]);
  return result;
}

function automationStatus(companyId) {
  const health=get('SELECT last_run_at FROM automation_health WHERE id=1');
  return {last_run_at:health?.last_run_at||null,healthy:Boolean(health?.last_run_at && Date.now()-new Date(health.last_run_at).getTime()<15*60_000),
    inbound:all(`SELECT j.status,COUNT(*) AS count FROM inbound_agent_jobs j JOIN conversations c ON c.id=j.conversation_id
      JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=? GROUP BY j.status`,[companyId]),
    scheduled:all(`SELECT sm.status,COUNT(*) AS count FROM scheduled_messages sm JOIN conversations c ON c.id=sm.conversation_id
      JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=? GROUP BY sm.status`,[companyId]),
    failures:all(`SELECT 'inbound' AS kind,j.message_id AS id,ct.name,j.error FROM inbound_agent_jobs j JOIN conversations c ON c.id=j.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=? AND j.status='failed'
      UNION ALL SELECT 'scheduled',sm.id,ct.name,sm.last_error FROM scheduled_messages sm JOIN conversations c ON c.id=sm.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE ct.company_id=? AND sm.status='failed' LIMIT 20`,[companyId,companyId])};
}

function createInbound({ phone, name, content, whatsappId, externalId, timestamp = now(), type = 'text', profilePictureUrl = null, audioData = null, companyId = 1 }) {
  if (!phone || !content) throw Object.assign(new Error('Telefone e mensagem são obrigatórios'), { statusCode: 400 });
  const optedOut=/^(?:pare|parar|sair|stop|cancelar mensagens)$|n[aã]o (?:quero|desejo) (?:mais )?receber|pare de (?:me )?enviar/i.test(String(content).trim());
  phone = normalizedPhone(phone);
  const windowUntil=new Date(Math.min(Date.now(),new Date(timestamp).getTime())+24*3_600_000).toISOString();
  const phoneDigits = phone.replace(/\D/g, '');
  let contact = get(`SELECT * FROM contacts WHERE company_id=? AND (whatsapp_id=? OR replace(replace(replace(replace(replace(phone,'+',''),' ',''),'-',''),'(',''),')','')=?) LIMIT 1`, [companyId, whatsappId || phoneDigits, phoneDigits]);
  if (!contact) {
    const result = run(`INSERT INTO contacts (company_id, phone, whatsapp_id, name, consent_status, last_seen_at, profile_picture_url)
      VALUES (?, ?, ?, ?, 'unknown', ?, ?)`, [companyId, phone, whatsappId || phoneDigits, name || 'Novo contato', timestamp, profilePictureUrl]);
    contact = get('SELECT * FROM contacts WHERE id=?', [Number(result.lastInsertRowid)]);
  } else {
    run(`UPDATE contacts SET name=CASE WHEN name='Novo contato' THEN ? ELSE name END,
      whatsapp_id=COALESCE(whatsapp_id, ?), profile_picture_url=COALESCE(?,profile_picture_url), last_seen_at=?, updated_at=? WHERE id=?`,
    [name || contact.name, whatsappId || phoneDigits, profilePictureUrl, timestamp, now(), contact.id]);
  }
  if(optedOut)run("UPDATE contacts SET consent_status='revoked',updated_at=? WHERE id=?",[now(),contact.id]);

  let conversation = get(`SELECT * FROM conversations WHERE contact_id=? AND status!='closed' ORDER BY id DESC LIMIT 1`, [contact.id]);
  if (!conversation) {
    const owner = existingLeadOwner(contact.id,companyId) || nextLeadOwner(companyId);
    const result = run(`INSERT INTO conversations
      (contact_id, assigned_to, status, mode, customer_window_until, unread_count, last_message_at)
      VALUES (?, ?, 'open', 'autopilot', ?, 1, ?)`, [contact.id, owner?.id||null, windowUntil, timestamp]);
    conversation = get('SELECT * FROM conversations WHERE id=?', [Number(result.lastInsertRowid)]);
  }

  const duplicate = externalId ? get('SELECT id,conversation_id FROM messages WHERE whatsapp_message_id=?', [externalId]) : null;
  if (duplicate) {
    if(duplicate.conversation_id!==conversation.id)throw Object.assign(new Error('Identificador de mensagem já associado a outra conversa.'),{statusCode:409});
    queueInboundMessage(conversation.id,duplicate.id);
    return { conversation, contact, messageId: duplicate.id, duplicate: true };
  }
  const result = run(`INSERT INTO messages
    (conversation_id, whatsapp_message_id, direction, sender_type, type, content, status, created_at)
    VALUES (?, ?, 'inbound', 'contact', ?, ?, 'received', ?)`,
  [conversation.id, externalId || `sim-${Date.now()}`, type, content, timestamp]);
  if (audioData) run('UPDATE messages SET metadata=? WHERE id=?', [JSON.stringify({ audio_data: audioData, transcribed: !content.startsWith('[Áudio sem transcrição]') }), Number(result.lastInsertRowid)]);
  run(`UPDATE conversations SET status='open', unread_count=unread_count+1,
    customer_window_until=?, last_message_at=?, updated_at=? WHERE id=?`,
  [windowUntil, timestamp, now(), conversation.id]);
  stopCadencesForContact(companyId,contact.id,'reply_received',true);
  run("UPDATE scheduled_messages SET status='cancelled' WHERE conversation_id=? AND status='scheduled' AND claimed_at IS NULL AND json_extract(payload,'$.automatic')=1",[conversation.id]);
  return { conversation, contact, messageId: Number(result.lastInsertRowid), duplicate: false };
}

async function processWebhook(payload) {
  const events = extractWebhookEvents(payload);
  const outcomes = [];
  for (const event of events) {
    const companyId=companyForMetaIdentifiers(event);
    if(!companyId)throw Object.assign(new Error('Webhook recebido para um número oficial não associado a nenhuma empresa da Atenva.'),{statusCode:400});
    if (event.kind === 'status') {
      const mapped = ['sent', 'delivered', 'read', 'failed'].includes(event.status) ? event.status : 'sent';
      run('UPDATE messages SET status=? WHERE whatsapp_message_id=?', [mapped, event.externalId]);
      updateCampaignDelivery(event.externalId, mapped);
      outcomes.push({ kind: 'status', id: event.externalId, status: mapped });
      continue;
    }
    if(previouslyReceived(event,companyId)){outcomes.push({kind:'duplicate',id:event.externalId});continue;}
    let media=null;if(event.mediaId&&event.type==='audio')try{media=await downloadWhatsAppMedia(event.mediaId,companyId);}catch{}
    const audioBase64=media?.base64||event.audioBase64;const audioMimeType=media?.mimeType||event.audioMimeType;
    const audioContent = await inboundAudioText(audioBase64,audioMimeType,event.type==='audio'&&!audioBase64?'[Áudio sem transcrição] A equipe deve ouvir esta mensagem no WhatsApp.':event.content);
    const incoming = createInbound({
      phone: `+${event.from}`,
      whatsappId: event.from,
      name: event.contactName,
      content: audioContent,
      externalId: event.externalId,
      timestamp: event.timestamp,
      type: event.type,
      profilePictureUrl: event.profilePictureUrl,
      audioData: audioBase64 ? `data:${audioMimeType};base64,${audioBase64}` : null,
      companyId
    });
    if (!incoming.duplicate) {
      queueInboundMessage(incoming.conversation.id,incoming.messageId);
      const result = await processPendingInboundMessages(companyId,incoming.messageId);
      outcomes.push({ kind: 'message', conversationId: incoming.conversation.id, agent: result });
    }
  }
  return outcomes;
}

function metaLeadFields(fieldData=[]) {
  const fields={};
  for(const item of fieldData||[]){const key=String(item.name||'').trim().toLowerCase();const value=Array.isArray(item.values)?item.values.join(', '):String(item.value||'');if(key)fields[key]=value.trim();}
  return fields;
}

async function processMetaLeadWebhook(payload) {
  const outcomes=[];
  for(const entry of payload?.entry||[]){
    const pageId=String(entry.id||'');
    for(const change of entry.changes||[]){
      if(change.field!=='leadgen'||!change.value?.leadgen_id)continue;
      const leadgenId=String(change.value.leadgen_id);
      const externalId=`meta-lead:${leadgenId}`;
      const previous=get('SELECT status FROM webhook_events WHERE external_id=?',[externalId]);
      if(previous?.status==='processed'){outcomes.push({leadgenId,duplicate:true});continue;}
      run(`INSERT INTO webhook_events(provider,external_id,event_type,payload,status) VALUES ('meta',?,'leadgen',?,'received')
        ON CONFLICT(external_id) DO UPDATE SET payload=excluded.payload,status='received'`,[externalId,JSON.stringify({entry,change})]);
      try{
        const companyId=companyForMetaPage(pageId);
        if(!companyId)throw Object.assign(new Error('Página Meta não associada a nenhuma empresa da Atenva.'),{statusCode:400});
        const lead=await fetchMetaLead(companyId,pageId,leadgenId);
        const fields=metaLeadFields(lead.field_data);
        const first=fields.first_name||fields.primeiro_nome||'';const last=fields.last_name||fields.sobrenome||'';
        const name=(fields.full_name||fields.nome_completo||`${first} ${last}`.trim()||`Lead Meta ${leadgenId.slice(-6)}`).slice(0,120);
        const email=(fields.email||fields.email_address||'').slice(0,160)||null;
        const rawPhone=fields.phone_number||fields.phone||fields.telefone||'';
        let phone=null;try{if(rawPhone)phone=normalizedPhone(rawPhone);}catch{}
        let contact=(phone?get('SELECT * FROM contacts WHERE company_id=? AND phone=?',[companyId,phone]):null)||(email?get('SELECT * FROM contacts WHERE company_id=? AND lower(email)=lower(?)',[companyId,email]):null);
        const company=(fields.company_name||fields.company||fields.empresa||'').slice(0,120)||null;
        const custom={meta_lead_id:leadgenId,meta_form_id:lead.form_id||change.value.form_id||null,meta_campaign_id:lead.campaign_id||null,meta_campaign_name:lead.campaign_name||null,meta_adset_id:lead.adset_id||null,meta_adset_name:lead.adset_name||null,meta_ad_id:lead.ad_id||null,meta_ad_name:lead.ad_name||null,meta_platform:lead.platform||null,meta_fields:fields};
        if(!contact){
          const globallyUsed=phone&&get('SELECT 1 FROM contacts WHERE phone=?',[phone]);
          const storedPhone=phone&&!globallyUsed?phone:`meta-lead:${companyId}:${leadgenId}`;
          if(phone&&globallyUsed)custom.lead_phone=phone;
          const created=run(`INSERT INTO contacts(company_id,phone,name,email,company,source,consent_status,custom_fields,updated_at)
            VALUES (?,?,?,?,?,'meta_ads','unknown',?,?)`,[companyId,storedPhone,name,email,company,JSON.stringify(custom),now()]);
          contact=get('SELECT * FROM contacts WHERE id=?',[Number(created.lastInsertRowid)]);
        }else{
          run(`UPDATE contacts SET name=CASE WHEN name='Novo contato' THEN ? ELSE name END,email=COALESCE(email,?),company=COALESCE(company,?),source='meta_ads',custom_fields=?,updated_at=? WHERE id=?`,[name,email,company,JSON.stringify({...asJson(contact.custom_fields,{}),...custom}),now(),contact.id]);
        }
        for(const tag of ['Meta Ads',lead.campaign_name,lead.ad_name].map(value=>String(value||'').trim().slice(0,60)).filter(Boolean))run('INSERT OR IGNORE INTO contact_tags(contact_id,tag) VALUES (?,?)',[contact.id,tag]);
        ensureCompanyPipelines(companyId);
        const stage=get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.company_id=? AND p.kind='sales' AND COALESCE(s.is_closed,0)=0 ORDER BY p.is_default DESC,s.local_position,s.position LIMIT 1`,[companyId]);
        const owner=existingLeadOwner(contact.id,companyId)||nextLeadOwner(companyId);
        let deal=null;
        if(stage&&!get(`SELECT d.id FROM deals d JOIN activities a ON a.deal_id=d.id WHERE d.contact_id=? AND a.action='meta_lead_imported' AND json_extract(a.metadata,'$.leadgen_id')=? LIMIT 1`,[contact.id,leadgenId])){
          const created=run(`INSERT INTO deals(contact_id,stage_id,owner_id,title,value_cents,currency,score,status) VALUES (?,?,?, ?,0,'BRL',0,'open')`,[contact.id,stage.id,owner?.id||null,`${name}${lead.campaign_name?` · ${lead.campaign_name}`:''}`.slice(0,160)]);
          deal={id:Number(created.lastInsertRowid)};
          run(`INSERT INTO activities(contact_id,deal_id,actor_type,action,description,metadata) VALUES (?,?,'system','meta_lead_imported',?,?)`,[contact.id,deal.id,`Lead recebido automaticamente da Meta${lead.campaign_name?` pela campanha ${lead.campaign_name}`:''}.`,JSON.stringify({leadgen_id:leadgenId,page_id:pageId,form_id:lead.form_id||change.value.form_id||null})]);
          run(`INSERT INTO tasks(company_id,contact_id,deal_id,assigned_to,title,description,due_at,type,priority,created_by) VALUES (?,?,?,?,?,?,?,'followup','high','system')`,[companyId,contact.id,deal.id,owner?.id||null,`Entrar em contato com ${name}`,'Novo lead recebido de formulário da Meta.',new Date(Date.now()+15*60_000).toISOString()]);
        }
        recordAttribution({companyId,contactId:contact.id,dealId:deal?.id||null,eventType:'first_touch',source:'meta_ads',medium:lead.platform||'paid_social',campaign:lead.campaign_name||lead.campaign_id||null,content:lead.ad_name||lead.ad_id||null,referrer:`meta:${pageId}`,destination:stage?'Funil de vendas · entrada':'Base de contatos',metadata:{leadgen_id:leadgenId,form_id:lead.form_id||change.value.form_id||null,campaign_id:lead.campaign_id||null,adset_id:lead.adset_id||null,ad_id:lead.ad_id||null}});
        recalculateContactQualification(contact.id);
        run("UPDATE webhook_events SET status='processed',processed_at=? WHERE external_id=?",[now(),externalId]);
        outcomes.push({leadgenId,companyId,contactId:contact.id,dealId:deal?.id||null});
      }catch(error){run("UPDATE webhook_events SET status='failed',processed_at=? WHERE external_id=?",[now(),externalId]);throw error;}
    }
  }
  return outcomes;
}

async function processEvolutionWebhook(payload, companyId = 1) {
  const events = extractEvolutionWebhookEvents(payload);
  const outcomes = [];
  for (const event of events) {
    if (event.kind === 'status') {
      const statusMap = { read: 'read', played: 'read', delivered: 'delivered', delivery_ack: 'delivered', server_ack: 'sent', error: 'failed' };
      const mapped = statusMap[event.status] || 'sent';
      run('UPDATE messages SET status=? WHERE whatsapp_message_id=?', [mapped, event.externalId]);
      updateCampaignDelivery(event.externalId, mapped);
      outcomes.push({ kind: 'status', id: event.externalId, status: mapped });
      continue;
    }
    if(previouslyReceived(event,companyId)){outcomes.push({kind:'duplicate',id:event.externalId});continue;}
    const audioContent = await inboundAudioText(event.audioBase64,event.audioMimeType,event.type==='audio'&&!event.audioBase64?'[Áudio sem transcrição] A equipe deve ouvir esta mensagem no WhatsApp.':event.content);
    const incoming = createInbound({
      phone: `+${event.from}`,
      whatsappId: event.from,
      name: event.contactName,
      content: audioContent,
      externalId: event.externalId,
      timestamp: event.timestamp,
      type: event.type,
      profilePictureUrl: event.profilePictureUrl,
      audioData: event.audioBase64 ? `data:${event.audioMimeType};base64,${event.audioBase64}` : null
      ,companyId
    });
    if (!incoming.duplicate) {
      queueInboundMessage(incoming.conversation.id,incoming.messageId);
      const result = await processPendingInboundMessages(companyId,incoming.messageId);
      outcomes.push({ kind: 'message', conversationId: incoming.conversation.id, agent: result });
    }
  }
  return outcomes;
}

export async function routeApi(request, response, url, body, context) {
  const method = request.method;
  const path = url.pathname;
  if (context?.user && !context.user.companyId) context.user.companyId = 1;

  let invitationMatch = path.match(/^\/api\/invitations\/([A-Za-z0-9_-]+)$/);
  if (method === 'GET' && invitationMatch) {
    const invitation = invitationByToken(invitationMatch[1]);
    if (!invitationIsUsable(invitation)) {
      throw Object.assign(new Error('Este convite é inválido ou expirou.'), { statusCode: 404 });
    }
    return { email: invitation.email, role: invitation.role, company_name: invitation.company_name || 'Atenva', inviter_name: invitation.inviter_name, expires_at: invitation.expires_at };
  }
  invitationMatch = path.match(/^\/api\/invitations\/([A-Za-z0-9_-]+)\/accept$/);
  if (method === 'POST' && invitationMatch) {
    const invitation = invitationByToken(invitationMatch[1]);
    if (!invitationIsUsable(invitation)) {
      throw Object.assign(new Error('Este convite é inválido ou expirou.'), { statusCode: 404 });
    }
    const name = String(body?.name || '').trim().slice(0, 120);
    const password = String(body?.password || '');
    if (name.length < 2) throw Object.assign(new Error('Informe seu nome completo.'), { statusCode: 400 });
    if (password.length < 10 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
      throw Object.assign(new Error('A senha precisa ter 10 caracteres, letra maiúscula, minúscula e número.'), { statusCode: 400 });
    }
    const existingUser=get('SELECT * FROM users WHERE lower(email)=?', [invitation.email]);
    if(existingUser&&!verifyPassword(password,existingUser.password_hash))throw Object.assign(new Error('A senha informada não corresponde a este acesso.'),{statusCode:401});
    transaction(() => {
      const userRole = invitation.role === 'master' ? 'admin' : invitation.role;
      const companyId = invitation.company_id || get('SELECT id FROM company_profiles ORDER BY id LIMIT 1')?.id;
      let userId=existingUser?.id;
      if(!existingUser){
        const created = run(`INSERT INTO users (name,email,password_hash,role,avatar,status,is_active,is_master,active_company_id)
          VALUES (?,?,?,?,?,'online',1,?,?)`, [name, invitation.email, hashPassword(password), userRole, name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase(), invitation.role === 'master' ? 1 : 0, companyId || null]);
        userId=Number(created.lastInsertRowid);
      }else if(companyId){run('UPDATE users SET active_company_id=? WHERE id=?',[companyId,userId]);}
      if (companyId) run(`INSERT INTO user_company_memberships (company_id,user_id,role,is_active,invited_by)
        VALUES (?,?,?,?,?) ON CONFLICT(company_id,user_id) DO UPDATE SET role=excluded.role,is_active=1,invited_by=excluded.invited_by`, [companyId,userId, invitation.role === 'master' ? 'owner' : invitation.role, 1, invitation.invited_by]);
      run('UPDATE user_invitations SET accepted_at=? WHERE id=?', [now(), invitation.id]);
      run(`INSERT INTO security_events (user_id,event_type,details) VALUES (?, 'invitation_accepted', ?)`, [userId, JSON.stringify({ invitation_id: invitation.id, role: invitation.role, company_id: companyId })]);
    });
    return { accepted: true, email: invitation.email };
  }

  if (method === 'GET' && path === '/api/health') return { status: 'ok', database: 'connected', whatsapp: whatsappDeliveryStatus(context?.user?.companyId||1), ai: agentModelStatus().configured, aiModel: agentModelStatus().model, time: now() };
  if (method === 'GET' && path === '/api/automations/status') return automationStatus(context.user.companyId);
  const retryAutomation=path.match(/^\/api\/automations\/(inbound|scheduled)\/(\d+)\/retry$/);
  if(method==='POST'&&retryAutomation){
    requireRole(context,['admin','manager']);
    if(body?.reviewed_delivery!==true)throw Object.assign(new Error('Confira no WhatsApp se já houve envio antes de autorizar uma nova tentativa.'),{statusCode:400});
    const id=parseId(retryAutomation[2]);
    if(retryAutomation[1]==='inbound'){
      const item=get(`SELECT j.* FROM inbound_agent_jobs j JOIN conversations c ON c.id=j.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE j.message_id=? AND ct.company_id=? AND j.status='failed'`,[id,context.user.companyId]);
      if(!item)throw Object.assign(new Error('Falha não encontrada nesta empresa.'),{statusCode:404});
      run("UPDATE inbound_agent_jobs SET status='pending',attempts=0,claimed_at=NULL,error=NULL,next_attempt_at=?,updated_at=? WHERE message_id=?",[now(),now(),id]);
      run("UPDATE conversations SET mode='autopilot',updated_at=? WHERE id=?",[now(),item.conversation_id]);
    }else{
      const item=get(`SELECT sm.id FROM scheduled_messages sm JOIN conversations c ON c.id=sm.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE sm.id=? AND ct.company_id=? AND sm.status='failed'`,[id,context.user.companyId]);
      if(!item)throw Object.assign(new Error('Falha não encontrada nesta empresa.'),{statusCode:404});
      run("UPDATE scheduled_messages SET status='scheduled',attempts=0,claimed_at=NULL,last_error=NULL,send_at=? WHERE id=?",[now(),id]);
    }
    run("INSERT INTO security_events(user_id,event_type,details) VALUES (?,'automation_retry_reviewed',?)",[context.user.id,JSON.stringify({kind:retryAutomation[1],id,company_id:context.user.companyId})]);
    return {queued:true};
  }
  if (method === 'GET' && path === '/api/dashboard') return dashboard(url, context.user.companyId);
  if (method === 'GET' && path === '/api/dashboard/preferences') {
    return asJson(get('SELECT value FROM settings WHERE key=?', [`dashboard:${context.user.id}`])?.value, { cards: ['new_contacts', 'open_conversations', 'unanswered_conversations', 'response_minutes', 'pipeline_value'] });
  }
  if (method === 'PUT' && path === '/api/dashboard/preferences') {
    const allowed = ['new_contacts', 'open_conversations', 'unanswered_conversations', 'response_minutes', 'pipeline_value', 'won_deals', 'active_leads', 'mqls', 'sqls', 'handoffs'];
    const cards = [...new Set((body.cards || []).filter(card => allowed.includes(card)))].slice(0, 8);
    run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, [`dashboard:${context.user.id}`, JSON.stringify({ cards }), now()]);
    return { cards };
  }
  if (method === 'GET' && path === '/api/conversations') { await processScheduledMessages(context.user.companyId); return conversationList(context.user.companyId); }
  if (method === 'POST' && path === '/api/scheduled-messages/process') return processScheduledMessages(context.user.companyId);

  let match = path.match(/^\/api\/conversations\/(\d+)$/);
  if (method === 'GET' && match) return getConversation(parseId(match[1]), context.user.companyId);
  if (method === 'PATCH' && match) {
    const id = parseId(match[1]);
    const allowed = ['status', 'mode', 'priority', 'assigned_to', 'next_action'];
    const entries = Object.entries(body || {}).filter(([key]) => allowed.includes(key));
    if (!entries.length) throw Object.assign(new Error('Nenhum campo permitido foi informado'), { statusCode: 400 });
    const sets = entries.map(([key]) => `${key}=?`).join(', ');
    run(`UPDATE conversations SET ${sets}, updated_at=? WHERE id=?`, [...entries.map(([, value]) => value), now(), id]);
    if (body.mode === 'human') {
      const item = getConversation(id, context.user.companyId);
      run(`INSERT INTO activities (contact_id, conversation_id, actor_type, action, description)
        VALUES (?, ?, 'human', 'human_takeover', 'Atendimento assumido por uma pessoa.')`, [item.contact_id, id]);
    }
    return getConversation(id, context.user.companyId);
  }

  match = path.match(/^\/api\/conversations\/(\d+)\/schedules$/);
  if (method === 'GET' && match) return getConversation(parseId(match[1]),context.user.companyId).schedules;
  if (method === 'POST' && match) {
    const id=parseId(match[1]);const conversation=getConversation(id,context.user.companyId);
    const items=Array.isArray(body?.items)?body.items.slice(0,12):[];
    if(!items.length)throw Object.assign(new Error('Adicione pelo menos um follow-up ou lembrete.'),{statusCode:400});
    const created=[];
    for(const entry of items){
      const kind=['followup','reminder','calendar'].includes(entry.kind)?entry.kind:'followup';
      let content=String(entry.content||'').trim().slice(0,4000);const date=new Date(entry.send_at);
      if(!content)throw Object.assign(new Error('Preencha a mensagem ou descrição de cada item.'),{statusCode:400});
      if(Number.isNaN(date.getTime())||date.getTime()<Date.now()+30_000)throw Object.assign(new Error('Escolha uma data futura para todos os itens.'),{statusCode:400});
      const sendAt=date.toISOString();
      if(kind==='followup'){
        const templateId=entry.template_id?parseId(entry.template_id):null;
        const template=templateId?get("SELECT * FROM message_templates WHERE id=? AND company_id=? AND source='meta' AND status='approved'",[templateId,context.user.companyId]):null;
        if(templateId&&!template)throw Object.assign(new Error('Modelo aprovado não encontrado nesta empresa.'),{statusCode:400});
        const variables=Array.isArray(entry.variables)?entry.variables.map(value=>String(value).trim()).slice(0,20):[];
        if(template){
          const count=Math.max(0,...[...template.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match=>Number(match[1])));
          if(variables.length!==count||variables.some(value=>!value||value.length>1024))throw Object.assign(new Error(`Informe ${count} valor(es) para as variáveis deste modelo.`),{statusCode:400});
          content=template.body.replace(/\{\{\s*(\d+)\s*\}\}/g,(_,number)=>variables[Number(number)-1]);
        }
        if(!templateId&&metaIsConfigured(context.user.companyId)&&!customerWindowIsOpen(conversation.customer_window_until,date.getTime()))throw Object.assign(new Error('Este horário está fora da janela de atendimento. Selecione um modelo aprovado.'),{statusCode:400});
        const result=run(`INSERT INTO scheduled_messages(conversation_id,template_id,send_at,payload,status) VALUES (?,?,?,?,'scheduled')`,[id,templateId,sendAt,JSON.stringify({kind,content,variables,created_by:context.user.id})]);
        created.push({kind,id:Number(result.lastInsertRowid),send_at:sendAt,content,status:'scheduled'});
      }else{
        const result=run(`INSERT INTO tasks(company_id,contact_id,conversation_id,assigned_to,title,description,due_at,type,priority,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,'human')`,[context.user.companyId,conversation.contact_id,id,context.user.id,kind==='calendar'?'Compromisso da conversa':'Lembrete da conversa',content,sendAt,kind==='calendar'?'meeting':'followup','normal']);
        const task=get('SELECT * FROM tasks WHERE id=?',[Number(result.lastInsertRowid)]);let calendar_sync_warning=null;
        if(kind==='calendar')try{const event=await createGoogleTaskEvent(context.user.companyId,task);if(event?.id){run("UPDATE tasks SET google_event_id=?,google_calendar_id='primary' WHERE id=?",[event.id,task.id]);task.google_event_id=event.id;task.google_calendar_id='primary';}}catch(error){calendar_sync_warning=error.message;}
        created.push({kind,id:task.id,send_at:sendAt,content,status:'pending',google_event_id:task.google_event_id||null,calendar_sync_warning});
      }
    }
    return {created};
  }

  match = path.match(/^\/api\/scheduled-messages\/(\d+)$/);
  if(method==='DELETE'&&match){const id=parseId(match[1]);const item=get(`SELECT sm.id FROM scheduled_messages sm JOIN conversations c ON c.id=sm.conversation_id JOIN contacts ct ON ct.id=c.contact_id
    WHERE sm.id=? AND ct.company_id=? AND sm.status='scheduled'`,[id,context.user.companyId]);if(!item)throw Object.assign(new Error('Agendamento não encontrado ou já processado.'),{statusCode:404});run("UPDATE scheduled_messages SET status='cancelled' WHERE id=?",[id]);return {cancelled:true};}

  match = path.match(/^\/api\/conversations\/(\d+)\/messages$/);
  if (method === 'POST' && match) {
    const id = parseId(match[1]);
    const conversation = getConversation(id, context.user.companyId);
    if (!body?.content?.trim()) throw Object.assign(new Error('A mensagem não pode estar vazia'), { statusCode: 400 });
    const signedContent = appendHumanSignature(context.user.companyId, context.user.id, body.content);
    const sendResult = await sendWhatsAppText(conversation.phone.replace(/\D/g, ''), signedContent, context.user.companyId);
    const result = run(`INSERT INTO messages
      (conversation_id, whatsapp_message_id, direction, sender_type, sender_id, content, status, metadata)
      VALUES (?, ?, 'outbound', 'human', ?, ?, ?, ?)`,
    [id, sendResult.id, context.user.id, signedContent, sendResult.status, JSON.stringify({ simulated: sendResult.simulated })]);
    run(`UPDATE conversations SET mode='human', unread_count=0, last_message_at=?, updated_at=? WHERE id=?`, [now(), now(), id]);
    return { id: Number(result.lastInsertRowid), ...sendResult };
  }

  match = path.match(/^\/api\/conversations\/(\d+)\/audio$/);
  if (method === 'POST' && match) {
    const id=parseId(match[1]); const conversation=getConversation(id, context.user.companyId); const encoded=String(body?.data_base64||''); if(!encoded||encoded.length>2_600_000)throw Object.assign(new Error('O áudio deve ter no máximo 1,8 MB.'),{statusCode:400});
    const transcript=await transcribeAudio(encoded,String(body?.mime_type||'audio/webm')); const sendResult=await sendWhatsAppAudio(conversation.phone.replace(/\D/g,''),encoded,context.user.companyId,String(body?.mime_type||'audio/ogg'));
    const result=run(`INSERT INTO messages (conversation_id,whatsapp_message_id,direction,sender_type,sender_id,type,content,status,metadata) VALUES (?,?,'outbound','human',?,'audio',?,?,?)`,[id,sendResult.id,context.user.id,transcript,sendResult.status,JSON.stringify({transcribed:true,mime_type:body?.mime_type,simulated:sendResult.simulated,audio_data:`data:${body?.mime_type||'audio/webm'};base64,${encoded}`})]); run(`UPDATE conversations SET mode='human',unread_count=0,last_message_at=?,updated_at=? WHERE id=?`,[now(),now(),id]); return {id:Number(result.lastInsertRowid),transcript,...sendResult};
  }

  if (method === 'POST' && path === '/api/simulate/inbound') {
    requireRole(context, ['admin', 'manager']);
    const incoming = createInbound({ phone: body?.phone || '+5511999990000', name: body?.name || 'Lead de teste', content: body?.content, companyId: context.user.companyId });
    const agent = incoming.duplicate ? null : await processInboundMessage(incoming.conversation.id, incoming.messageId);
    return { conversationId: incoming.conversation.id, messageId: incoming.messageId, agent };
  }

  if (method === 'GET' && path === '/api/pipelines') return all(`SELECT p.*,
    (SELECT COUNT(*) FROM pipeline_stages s JOIN deals d ON d.stage_id=s.id JOIN contacts ct ON ct.id=d.contact_id WHERE s.pipeline_id=p.id AND ct.company_id=?) AS deal_count
    FROM pipelines p WHERE p.company_id=? ORDER BY p.is_default DESC, p.id`, [context.user.companyId,context.user.companyId]);
  if (method === 'GET' && path === '/api/pipeline-stages') return all(`SELECT s.id,s.pipeline_id,COALESCE(ps.display_name,s.display_name,s.name) AS name,p.name AS pipeline_name,p.kind,COALESCE(ps.local_position,s.local_position) AS local_position FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=? WHERE p.company_id=? AND s.company_id=? AND COALESCE(ps.is_visible,1)=1 ORDER BY p.is_default DESC,p.id,COALESCE(ps.local_position,s.local_position)`, [context.user.companyId,context.user.companyId,context.user.companyId]);
  if (method === 'POST' && path === '/api/pipelines') {
    requireRole(context, ['admin', 'manager']);
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) throw Object.assign(new Error('Informe o nome do funil'), { statusCode: 400 });
    const result = run(`INSERT INTO pipelines (company_id,name,kind,color) VALUES (?,?,'custom',?)`, [context.user.companyId,name,body.color || '#246044']);
    const pipelineId = Number(result.lastInsertRowid);
    const labels = Array.isArray(body.stages) && body.stages.length ? body.stages : ['Entrada', 'Em andamento', 'Concluído'];
    labels.slice(0, 10).forEach((label, index) => run(`INSERT INTO pipeline_stages
      (name,position,color,probability,is_closed,pipeline_id,display_name,local_position,company_id)
      VALUES (?,?,?,?,0,?,?,?,?)`, [`${pipelineId}:${context.user.companyId}:${String(label).trim()}`, pipelineId * 100 + index + 1, body.color || '#62B98C', Math.min(100, index * 40), pipelineId, String(label).trim(), index + 1,context.user.companyId]));
    return get('SELECT * FROM pipelines WHERE id=?', [pipelineId]);
  }

  if (method === 'GET' && path === '/api/pipeline') {
    const pipeline = url.searchParams.get('pipeline_id')
      ? get('SELECT * FROM pipelines WHERE id=? AND company_id=?', [parseId(url.searchParams.get('pipeline_id')),context.user.companyId])
      : get('SELECT * FROM pipelines WHERE company_id=? ORDER BY is_default DESC, id LIMIT 1',[context.user.companyId]);
    if (!pipeline) throw Object.assign(new Error('Funil não encontrado'), { statusCode: 404 });
    const stages = all(`SELECT s.*,COALESCE(ps.display_name,s.display_name,s.name) AS name,COALESCE(ps.local_position,s.local_position) AS effective_position FROM pipeline_stages s
      LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=?
      WHERE s.pipeline_id=? AND s.company_id=? AND COALESCE(ps.is_visible,1)=1 ORDER BY effective_position,s.position`, [context.user.companyId,pipeline.id,context.user.companyId]);
    const statusClause = pipeline.kind === 'customers' ? "AND d.status IN ('open','won')" : "AND d.status='open'";
    const deals = all(`SELECT d.*, ct.name AS contact_name, COALESCE(o.name,ct.company) AS company, ct.phone,ct.email,ct.source,ct.segment,ct.notes AS sdr_notes,ct.organization_id, u.name AS owner_name, u.avatar AS owner_avatar,
      cv.id AS conversation_id, cv.summary AS ai_summary, cv.next_action
      FROM deals d JOIN contacts ct ON ct.id=d.contact_id LEFT JOIN organizations o ON o.id=ct.organization_id LEFT JOIN users u ON u.id=d.owner_id
      LEFT JOIN conversations cv ON cv.contact_id=d.contact_id
      JOIN pipeline_stages s ON s.id=d.stage_id WHERE s.pipeline_id=? AND ct.company_id=? ${statusClause} ORDER BY d.updated_at DESC`, [pipeline.id, context.user.companyId]);
    const closed = get(`SELECT SUM(CASE WHEN d.status='won' THEN 1 ELSE 0 END) AS won, SUM(CASE WHEN d.status='lost' THEN 1 ELSE 0 END) AS lost
      FROM deals d JOIN contacts ct ON ct.id=d.contact_id JOIN pipeline_stages s ON s.id=d.stage_id WHERE s.pipeline_id=? AND ct.company_id=?`, [pipeline.id, context.user.companyId]);
    return { pipeline, stages, deals, closed: { won: Number(closed?.won || 0), lost: Number(closed?.lost || 0) } };
  }

  match = path.match(/^\/api\/pipelines\/(\d+)\/stages$/);
  if (method === 'PUT' && match) {
    requireRole(context, ['admin', 'manager']);
    const pipelineId = parseId(match[1]);
    if (!get('SELECT 1 FROM pipelines WHERE id=? AND company_id=?', [pipelineId,context.user.companyId])) throw Object.assign(new Error('Funil não encontrado.'), { statusCode: 404 });
    const requested = Array.isArray(body?.stages) ? body.stages.slice(0, 12) : [];
    if (!requested.length) throw Object.assign(new Error('Mantenha pelo menos uma etapa no pipeline.'), { statusCode: 400 });
    const existing = all(`SELECT s.id FROM pipeline_stages s LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=?
      WHERE s.pipeline_id=? AND s.company_id=? AND COALESCE(ps.is_visible,1)=1`, [context.user.companyId,pipelineId,context.user.companyId]);
    const requestedIds = new Set(requested.map(item => Number(item.id)).filter(Number.isInteger));
    for (const stage of existing.filter(item => !requestedIds.has(item.id))) {
      const used = get(`SELECT COUNT(*) AS count FROM deals d JOIN contacts ct ON ct.id=d.contact_id WHERE d.stage_id=? AND ct.company_id=?`, [stage.id,context.user.companyId]);
      if (used.count) throw Object.assign(new Error('Mova os negócios da etapa antes de removê-la.'), { statusCode: 409 });
    }
    transaction(() => {
      for (const stage of existing.filter(item => !requestedIds.has(item.id))) run(`INSERT INTO pipeline_stage_settings(company_id,stage_id,display_name,local_position,is_visible) VALUES (?,?,?,?,0)
        ON CONFLICT(company_id,stage_id) DO UPDATE SET is_visible=0`, [context.user.companyId,stage.id,'Etapa removida',999]);
      requested.forEach((item,index) => {
        const label = String(item.name || '').trim().slice(0,80);
        if (!label) throw Object.assign(new Error('Todas as etapas precisam de um nome.'), { statusCode: 400 });
        let stageId = Number(item.id);
        if (Number.isInteger(stageId)) {
          const allowed = get('SELECT 1 FROM pipeline_stages WHERE id=? AND pipeline_id=? AND company_id=?', [stageId,pipelineId,context.user.companyId]);
          if (!allowed) throw Object.assign(new Error('Etapa inválida.'), { statusCode: 400 });
        } else {
          const nextPosition = Number(get('SELECT COALESCE(MAX(position),0)+1 AS value FROM pipeline_stages').value);
          const created = run(`INSERT INTO pipeline_stages(name,position,color,probability,is_closed,pipeline_id,display_name,local_position,company_id) VALUES (?,?,?,?,0,?,?,?,?)`, [`${pipelineId}:${context.user.companyId}:${Date.now()}:${index}`,nextPosition,['#B8F24A','#79CD78','#62B98C','#3C8D68','#246044'][index%5],Math.min(95,index*20),pipelineId,label,index+1,context.user.companyId]);
          stageId = Number(created.lastInsertRowid);
        }
        run(`INSERT INTO pipeline_stage_settings(company_id,stage_id,display_name,local_position,is_visible) VALUES (?,?,?,?,1)
          ON CONFLICT(company_id,stage_id) DO UPDATE SET display_name=excluded.display_name,local_position=excluded.local_position,is_visible=1`, [context.user.companyId,stageId,label,index+1]);
      });
    });
    const stages=all(`SELECT s.id,COALESCE(ps.display_name,s.display_name,s.name) AS name,COALESCE(ps.local_position,s.local_position,s.position) AS local_position
      FROM pipeline_stages s LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=?
      WHERE s.pipeline_id=? AND s.company_id=? AND COALESCE(ps.is_visible,1)=1 ORDER BY local_position`,[context.user.companyId,pipelineId,context.user.companyId]);
    return { updated: true, stages };
  }

  if (method === 'POST' && path === '/api/deals') {
    const stageId = parseId(body?.stage_id);
    const stage = get(`SELECT s.id,s.pipeline_id,COALESCE(ps.display_name,s.display_name,s.name) AS name
      FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=?
      WHERE s.id=? AND p.company_id=? AND s.company_id=? AND COALESCE(ps.is_visible,1)=1`, [context.user.companyId,stageId,context.user.companyId,context.user.companyId]);
    if (!stage) throw Object.assign(new Error('Etapa do pipeline não encontrada.'), { statusCode: 404 });
    const title = String(body?.title || '').trim().slice(0, 160);
    if (!title) throw Object.assign(new Error('Informe o nome do negócio.'), { statusCode: 400 });
    let contact; const contactInput = body?.contact || {};
    if (body?.contact_id) {
      contact = get('SELECT id,name FROM contacts WHERE id=? AND company_id=?', [parseId(body.contact_id), context.user.companyId]);
      if (!contact) throw Object.assign(new Error('Contato não encontrado nesta empresa.'), { statusCode: 404 });
    } else {
      const name = String(contactInput.name || title).trim().slice(0, 120);
      const rawPhone = String(contactInput.phone || '').trim();
      const actualPhone = rawPhone ? normalizedPhone(rawPhone) : null;
      if (actualPhone) contact = get('SELECT id,name FROM contacts WHERE company_id=? AND phone=?', [context.user.companyId,actualPhone]);
      if (!contact) {
        const company = String(contactInput.company || '').trim().slice(0,120) || null;
        let organizationId = null;
        if (company) {
          run('INSERT OR IGNORE INTO organizations(company_id,name) VALUES (?,?)', [context.user.companyId,company]);
          organizationId = get('SELECT id FROM organizations WHERE company_id=? AND name=?', [context.user.companyId,company])?.id || null;
          run(`UPDATE organizations SET phone=?,email=?,socials=?,website=?,domain=?,segment=?,updated_at=? WHERE id=? AND company_id=?`, [String(contactInput.company_phone||'').trim().slice(0,30)||null,String(contactInput.company_email||'').trim().slice(0,160)||null,String(contactInput.company_socials||'').trim().slice(0,300)||null,String(contactInput.company_website||'').trim().slice(0,240)||null,String(contactInput.company_website||'').trim().slice(0,240)||null,String(contactInput.segment||'').trim().slice(0,100)||null,now(),organizationId,context.user.companyId]);
        }
        const globallyUsed = actualPhone && get('SELECT 1 FROM contacts WHERE phone=?', [actualPhone]);
        const storedPhone = !actualPhone || globallyUsed ? `manual:${context.user.companyId}:${Date.now()}:${randomBytes(4).toString('hex')}` : actualPhone;
        const source = ['manual','whatsapp','instagram','facebook','meta_ads','google_ads','indicacao','organico','outro'].includes(contactInput.source) ? contactInput.source : 'manual';
        const temperature = ['cold','warm','hot'].includes(contactInput.temperature) ? contactInput.temperature : 'warm';
        const customFields = { first_name:String(contactInput.first_name||'').slice(0,70), last_name:String(contactInput.last_name||'').slice(0,70), social:String(contactInput.social||'').slice(0,240), lead_temperature:temperature, client_type:String(contactInput.client_type||'').slice(0,80), budget:String(contactInput.budget||'').slice(0,80), payment_method:String(contactInput.payment_method||'').slice(0,80), objective:String(contactInput.objective||'').slice(0,500) };
        if (actualPhone && globallyUsed) customFields.manual_phone = actualPhone;
        const created = run(`INSERT INTO contacts(company_id,phone,name,email,company,organization_id,source,segment,notes,custom_fields,consent_status,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'unknown',?)`, [context.user.companyId,storedPhone,name,String(contactInput.email||'').trim().slice(0,160)||null,company,organizationId,source,String(contactInput.segment||'').trim().slice(0,100)||null,String(contactInput.notes||'').trim().slice(0,1000)||null,JSON.stringify(customFields),now()]);
        contact = { id:Number(created.lastInsertRowid),name };
      }
    }
    const sourceLabels={manual:'Cadastro manual',whatsapp:'WhatsApp',instagram:'Instagram',facebook:'Facebook',meta_ads:'Meta Ads',google_ads:'Google Ads',indicacao:'Indicação',organico:'Orgânico',outro:'Outro'};
    const temperatureLabels={cold:'Lead frio',warm:'Lead morno',hot:'Lead quente'};
    const tags = [...new Set([...String(contactInput.tags || '').split(','),sourceLabels[contactInput.source],temperatureLabels[contactInput.temperature]].map(tag=>String(tag||'').trim().slice(0,60)).filter(Boolean))].slice(0,12);
    for (const tag of tags) run('INSERT OR IGNORE INTO contact_tags(contact_id,tag) VALUES (?,?)', [contact.id,tag]);
    const valueCents = Math.max(0, Math.round(Number(body?.value_cents) || 0));
    const score = Math.min(100, Math.max(0, Math.round(Number(body?.score) || 0)));
    const expectedCloseAt = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.expected_close_at || '')) ? body.expected_close_at : null;
    const result = run(`INSERT INTO deals
      (contact_id,stage_id,owner_id,title,value_cents,currency,score,expected_close_at,status)
      VALUES (?,?,?,?,?,'BRL',?,?,'open')`, [contact.id,stage.id,context.user.id,title,valueCents,score,expectedCloseAt]);
    const dealId = Number(result.lastInsertRowid);
    run(`INSERT INTO activities(contact_id,deal_id,actor_type,actor_id,action,description)
      VALUES (?,?,'human',?,'deal_created',?)`, [contact.id,dealId,context.user.id,`Negócio criado manualmente: ${title}.`]);
    recordAttribution({companyId:context.user.companyId,contactId:contact.id,dealId,eventType:'first_touch',source:contactInput.source||'manual',medium:'crm',campaign:String(contactInput.campaign||'').trim()||null,destination:stage.name,metadata:{pipeline_id:stage.pipeline_id,stage_id:stage.id}});
    runStageAutomations(dealId, stage.id, context.user.companyId, context.user.id);
    recalculateContactQualification(contact.id);
    return get(`SELECT d.*,ct.name AS contact_name,COALESCE(o.name,ct.company) AS company,
      COALESCE(s.display_name,s.name) AS stage_name,s.pipeline_id
      FROM deals d JOIN contacts ct ON ct.id=d.contact_id LEFT JOIN organizations o ON o.id=ct.organization_id
      JOIN pipeline_stages s ON s.id=d.stage_id WHERE d.id=?`, [dealId]);
  }

  match = path.match(/^\/api\/deals\/(\d+)$/);
  if (method === 'DELETE' && match) {
    requireRole(context, ['admin', 'manager']);
    const id = parseId(match[1]);
    const deal = get('SELECT d.id FROM deals d JOIN contacts ct ON ct.id=d.contact_id WHERE d.id=? AND ct.company_id=?', [id,context.user.companyId]);
    if (!deal) throw Object.assign(new Error('Oportunidade não encontrada.'), { statusCode: 404 });
    run('DELETE FROM deals WHERE id=?', [id]);
    return { deleted:true };
  }
  if (method === 'PATCH' && match) {
    const id = parseId(match[1]);
    const ownedDeal=get('SELECT d.*,ct.id AS contact_id FROM deals d JOIN contacts ct ON ct.id=d.contact_id WHERE d.id=? AND ct.company_id=?', [id, context.user.companyId]);
    if (!ownedDeal) throw Object.assign(new Error('Oportunidade não encontrada.'), { statusCode: 404 });
    if (body.title !== undefined) {
      const title=String(body.title||'').trim().slice(0,160);if(!title)throw Object.assign(new Error('Informe o nome do negócio.'),{statusCode:400});
      run('UPDATE deals SET title=?,updated_at=? WHERE id=?',[title,now(),id]);
    }
    if (body.score !== undefined) run('UPDATE deals SET score=?,updated_at=? WHERE id=?',[Math.min(100,Math.max(0,Math.round(Number(body.score)||0))),now(),id]);
    if (body.expected_close_at !== undefined) {
      const expected=/^\d{4}-\d{2}-\d{2}$/.test(String(body.expected_close_at||''))?body.expected_close_at:null;
      run('UPDATE deals SET expected_close_at=?,updated_at=? WHERE id=?',[expected,now(),id]);
    }
    if (body.owner_id !== undefined) {
      const ownerId=parseId(body.owner_id);
      const membership=get('SELECT 1 FROM user_company_memberships WHERE company_id=? AND user_id=? AND is_active=1',[context.user.companyId,ownerId]);
      if(!membership)throw Object.assign(new Error('O responsável não pertence a esta empresa.'),{statusCode:400});
      run('UPDATE deals SET owner_id=?,updated_at=? WHERE id=?',[ownerId,now(),id]);
    }
    if (body.contact && typeof body.contact==='object') {
      const input=body.contact;const updates=[];const params=[];
      if(input.name!==undefined){updates.push('name=?');params.push(String(input.name||'').trim().slice(0,120)||'Contato sem nome');}
      if(input.email!==undefined){const email=String(input.email||'').trim().toLowerCase().slice(0,160);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Object.assign(new Error('Informe um e-mail válido.'),{statusCode:400});updates.push('email=?');params.push(email||null);}
      if(input.phone!==undefined){const raw=String(input.phone||'').trim();const phone=raw?normalizedPhone(raw):`manual:${context.user.companyId}:${Date.now()}:${randomBytes(4).toString('hex')}`;const duplicate=get('SELECT id FROM contacts WHERE phone=? AND id<>?',[phone,ownedDeal.contact_id]);if(duplicate)throw Object.assign(new Error('Este telefone já pertence a outro contato.'),{statusCode:409});updates.push('phone=?');params.push(phone);}
      if(input.source!==undefined){const source=['manual','whatsapp','instagram','facebook','meta_ads','google_ads','indicacao','organico','outro'].includes(input.source)?input.source:'manual';updates.push('source=?');params.push(source);}
      if(input.segment!==undefined){updates.push('segment=?');params.push(String(input.segment||'').trim().slice(0,100)||null);}
      if(input.notes!==undefined){updates.push('notes=?');params.push(String(input.notes||'').trim().slice(0,1000)||null);}
      if(input.company!==undefined){const company=String(input.company||'').trim().slice(0,120)||null;let organizationId=null;if(company){run('INSERT OR IGNORE INTO organizations(company_id,name) VALUES (?,?)',[context.user.companyId,company]);organizationId=get('SELECT id FROM organizations WHERE company_id=? AND lower(name)=lower(?)',[context.user.companyId,company])?.id||null;}updates.push('company=?','organization_id=?');params.push(company,organizationId);}
      if(updates.length)run(`UPDATE contacts SET ${updates.join(',')},updated_at=? WHERE id=? AND company_id=?`,[...params,now(),ownedDeal.contact_id,context.user.companyId]);
    }
    if (body.stage_id) {
      const stage = get(`SELECT s.*, COALESCE(ps.display_name,s.display_name,s.name) AS label, p.kind AS pipeline_kind
        FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=?
        WHERE s.id=? AND p.company_id=? AND s.company_id=? AND COALESCE(ps.is_visible,1)=1`, [context.user.companyId,parseId(body.stage_id),context.user.companyId,context.user.companyId]);
      if (!stage) throw Object.assign(new Error('Etapa não encontrada'), { statusCode: 404 });
      if (stage.label === 'Ganho') body.status = 'won';
      else {
        run("UPDATE deals SET stage_id=?, status=CASE WHEN status='lost' THEN 'open' ELSE status END, updated_at=? WHERE id=?", [stage.id, now(), id]);
        recordAttribution({companyId:context.user.companyId,contactId:ownedDeal.contact_id,dealId:id,eventType:'stage_change',source:null,medium:'crm',destination:stage.label,metadata:{pipeline_id:stage.pipeline_id,stage_id:stage.id}});
        runStageAutomations(id, stage.id, context.user.companyId, context.user.id);
      }
    }
    if (Number.isFinite(body.value_cents)) run('UPDATE deals SET value_cents=?, updated_at=? WHERE id=?', [body.value_cents, now(), id]);
    if (body.status === 'won') {
      const deal = get('SELECT d.*,s.pipeline_id FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id WHERE d.id=?', [id]);
      const configuredTarget=configuredOutcomeTarget(context.user.companyId,deal.pipeline_id,'won');
      const customerStage = get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
        WHERE p.company_id=? AND p.kind='customers' ORDER BY s.local_position LIMIT 1`,[context.user.companyId]);
      const wonStage=configuredTarget?.kind==='customers'?configuredTarget.stage_id:customerStage?.id;
      run("UPDATE deals SET status='won', stage_id=COALESCE(?,stage_id), lost_reason=NULL, closed_at=?, updated_at=? WHERE id=?", [wonStage, now(), now(), id]);
      const followupDealId=configuredTarget?.kind!=='customers'?createOutcomeFollowup(deal,configuredTarget,'won',context.user.id):null;
      run("UPDATE contacts SET lifecycle='customer', updated_at=? WHERE id=?", [now(), deal.contact_id]);
      run(`INSERT INTO activities (contact_id,deal_id,actor_type,actor_id,action,description) VALUES (?,?,'human',?,'deal_won','Oportunidade marcada como ganha e enviada ao pipeline de clientes.')`, [deal.contact_id, id, context.user.id]);
      recordAttribution({companyId:context.user.companyId,contactId:deal.contact_id,dealId:id,eventType:'outcome',medium:'crm',destination:'Ganho · Base de clientes',metadata:{status:'won',value_cents:deal.value_cents}});
      stopCadencesForContact(context.user.companyId,deal.contact_id,'deal_won',false);
    }
    if (body.status === 'lost') {
      const reason = String(body.lost_reason || '').trim();
      if (!reason) throw Object.assign(new Error('Selecione o motivo da perda'), { statusCode: 400 });
      const strategy = ['retomada','remarketing','arquivar'].includes(body.recovery_strategy) ? body.recovery_strategy : null;
      if (!strategy) throw Object.assign(new Error('Escolha se o contato vai para retomada, remarketing ou arquivo'), { statusCode: 400 });
      const deal = get('SELECT d.*,s.pipeline_id FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id WHERE d.id=?', [id]);
      run("UPDATE deals SET status='lost', lost_reason=?, recovery_strategy=?, closed_at=?, updated_at=? WHERE id=?", [reason, strategy, now(), now(), id]);
      run("UPDATE contacts SET lifecycle='inactive',updated_at=? WHERE id=?", [now(),deal.contact_id]);
      run('INSERT OR IGNORE INTO contact_tags(contact_id,tag) VALUES (?,?)', [deal.contact_id,strategy === 'retomada' ? 'Retomada' : strategy === 'remarketing' ? 'Remarketing' : 'Arquivado']);
      const configuredTarget=configuredOutcomeTarget(context.user.companyId,deal.pipeline_id,'lost');
      const recoveryDealId = configuredTarget ? createOutcomeFollowup(deal,configuredTarget,'lost',context.user.id) : createRecoveryDeal(deal,strategy,reason,context.user.id,context.user.companyId);
      run(`INSERT INTO activities (contact_id,deal_id,actor_type,actor_id,action,description,metadata) VALUES (?,?,'human',?,'deal_lost',?,?)`, [deal.contact_id, id, context.user.id, `Oportunidade perdida: ${reason}.`,JSON.stringify({recovery_strategy:strategy,recovery_deal_id:recoveryDealId})]);
      recordAttribution({companyId:context.user.companyId,contactId:deal.contact_id,dealId:id,eventType:'outcome',medium:'crm',destination:`Perda · ${strategy}`,metadata:{status:'lost',reason,recovery_strategy:strategy}});
      stopCadencesForContact(context.user.companyId,deal.contact_id,'deal_lost',false);
    }
    const updatedDeal = get('SELECT contact_id FROM deals WHERE id=?', [id]);
    if (updatedDeal) recalculateContactQualification(updatedDeal.contact_id);
    return get(`SELECT d.*,ct.name AS contact_name,COALESCE(o.name,ct.company) AS company,ct.phone,ct.email,ct.source,ct.segment,ct.notes AS sdr_notes,COALESCE(s.display_name,s.name) AS stage_name,s.pipeline_id,u.name AS owner_name,u.avatar AS owner_avatar FROM deals d JOIN contacts ct ON ct.id=d.contact_id LEFT JOIN organizations o ON o.id=ct.organization_id LEFT JOIN users u ON u.id=d.owner_id JOIN pipeline_stages s ON s.id=d.stage_id WHERE d.id=?`, [id]);
  }

  if (method === 'GET' && path === '/api/contacts') {
    return all(`SELECT ct.*, COALESCE(o.name,ct.company) AS company, o.id AS organization_id, o.phone AS company_phone,o.email AS company_email,o.socials AS company_socials,o.website AS company_website,o.segment AS company_segment,GROUP_CONCAT(t.tag) AS tags,
      CASE ct.source WHEN 'whatsapp' THEN 'WhatsApp' WHEN 'instagram' THEN 'Instagram' WHEN 'facebook' THEN 'Facebook' WHEN 'meta_ads' THEN 'Meta Ads' WHEN 'google_ads' THEN 'Google Ads' WHEN 'indicacao' THEN 'Indicação' WHEN 'organico' THEN 'Orgânico' WHEN 'outro' THEN 'Outro' ELSE 'Cadastro manual' END AS acquisition_channel,
      d.value_cents, d.score, d.status AS deal_status, d.lost_reason, COALESCE(s.display_name,s.name) AS stage_name,p.id AS pipeline_id,p.name AS pipeline_name
      FROM contacts ct LEFT JOIN contact_tags t ON t.contact_id=ct.id
      LEFT JOIN organizations o ON o.id=ct.organization_id
      LEFT JOIN deals d ON d.id=(SELECT id FROM deals WHERE contact_id=ct.id ORDER BY id DESC LIMIT 1)
      LEFT JOIN pipeline_stages s ON s.id=d.stage_id LEFT JOIN pipelines p ON p.id=s.pipeline_id WHERE ct.company_id=? GROUP BY ct.id ORDER BY ct.updated_at DESC`, [context.user.companyId]);
  }
  if (method === 'GET' && path === '/api/relationships') return relationshipOverview(context.user.companyId);
  if (method === 'GET' && path === '/api/cadences') return listCadences(context.user.companyId);
  if (method === 'POST' && path === '/api/cadences') {
    requireRole(context,['admin','manager']);
    return saveCadence(context.user.companyId,context.user.id,body);
  }
  match=path.match(/^\/api\/cadences\/(\d+)$/);
  if(method==='PUT'&&match){requireRole(context,['admin','manager']);return saveCadence(context.user.companyId,context.user.id,body,parseId(match[1]));}
  if(method==='DELETE'&&match){requireRole(context,['admin','manager']);return archiveCadence(context.user.companyId,parseId(match[1]));}
  match=path.match(/^\/api\/cadences\/(\d+)\/enroll$/);
  if(method==='POST'&&match)return enrollContacts(context.user.companyId,context.user.id,parseId(match[1]),body?.contact_ids);
  match=path.match(/^\/api\/contacts\/(\d+)\/journey$/);
  if(method==='GET'&&match)return contactJourney(context.user.companyId,parseId(match[1]));
  if(method==='POST'&&path==='/api/cadences/process')return processCadences(context.user.companyId);
  if (method === 'GET' && path === '/api/organizations') {
    for(const item of all("SELECT DISTINCT company_id,trim(company) AS name FROM contacts WHERE company_id=? AND trim(COALESCE(company,''))<>''",[context.user.companyId]))run('INSERT OR IGNORE INTO organizations(company_id,name) VALUES (?,?)',[item.company_id,item.name]);
    run(`UPDATE contacts SET organization_id=(SELECT o.id FROM organizations o WHERE o.company_id=contacts.company_id AND lower(o.name)=lower(trim(contacts.company)) LIMIT 1) WHERE company_id=? AND organization_id IS NULL AND trim(COALESCE(company,''))<>''`,[context.user.companyId]);
    return all(`SELECT o.*,COUNT(ct.id) AS contact_count,COALESCE(SUM(d.value_cents),0) AS pipeline_value
    FROM organizations o LEFT JOIN contacts ct ON ct.organization_id=o.id LEFT JOIN deals d ON d.id=(SELECT id FROM deals WHERE contact_id=ct.id AND status='open' ORDER BY id DESC LIMIT 1)
    WHERE o.company_id=? GROUP BY o.id ORDER BY o.name`, [context.user.companyId]);
  }
  if (method === 'POST' && path === '/api/organizations') {
    const name=String(body?.name||'').trim().slice(0,120); if(!name)throw Object.assign(new Error('Informe o nome da empresa.'),{statusCode:400});
    const result=run('INSERT INTO organizations(company_id,name,domain,segment) VALUES (?,?,?,?)',[context.user.companyId,name,String(body?.domain||'').trim()||null,String(body?.segment||'').trim()||null]);
    return get('SELECT * FROM organizations WHERE id=?',[Number(result.lastInsertRowid)]);
  }
  match = path.match(/^\/api\/contacts\/(\d+)$/);
  if (method === 'PATCH' && match) {
    const id=parseId(match[1]); if(!get('SELECT 1 FROM contacts WHERE id=? AND company_id=?',[id,context.user.companyId]))throw Object.assign(new Error('Contato não encontrado.'),{statusCode:404});
    const allowed=['name','phone','email','segment','location','organization_id','notes','consent_status']; const entries=Object.entries(body||{}).filter(([key])=>allowed.includes(key));
    if(!entries.length)throw Object.assign(new Error('Nenhum campo permitido foi informado.'),{statusCode:400});
    if(body.organization_id&&!get('SELECT 1 FROM organizations WHERE id=? AND company_id=?',[Number(body.organization_id),context.user.companyId]))throw Object.assign(new Error('Empresa não encontrada.'),{statusCode:404});
    run(`UPDATE contacts SET ${entries.map(([key])=>`${key}=?`).join(',')},company=CASE WHEN ? IS NULL THEN company ELSE (SELECT name FROM organizations WHERE id=?) END,updated_at=? WHERE id=?`,[...entries.map(([,value])=>value||null),body.organization_id??null,body.organization_id??null,now(),id]);
    return get('SELECT * FROM contacts WHERE id=?',[id]);
  }

  if (method === 'GET' && path === '/api/insights') {
    const reasons=all(`SELECT COALESCE(NULLIF(d.lost_reason,''),'Não informado') AS label,COUNT(*) AS value FROM deals d JOIN contacts ct ON ct.id=d.contact_id WHERE ct.company_id=? AND d.status='lost' GROUP BY label ORDER BY value DESC`,[context.user.companyId]);
    const recovery=all(`SELECT COALESCE(d.recovery_strategy,'arquivar') AS label,COUNT(*) AS value FROM deals d JOIN contacts ct ON ct.id=d.contact_id WHERE ct.company_id=? AND d.status='lost' GROUP BY label ORDER BY value DESC`,[context.user.companyId]);
    const stages=all(`SELECT COALESCE(s.display_name,s.name) AS label,COUNT(d.id) AS value,COALESCE(SUM(d.value_cents),0) AS amount FROM pipeline_stages s LEFT JOIN deals d ON d.stage_id=s.id AND d.status='open' AND d.contact_id IN(SELECT id FROM contacts WHERE company_id=?) JOIN pipelines p ON p.id=s.pipeline_id WHERE p.company_id=? AND p.kind='sales' GROUP BY s.id ORDER BY s.local_position`,[context.user.companyId,context.user.companyId]);
    return {loss_reasons:reasons,recovery,stages};
  }

  if (method === 'GET' && path === '/api/pipeline-automations') return all('SELECT * FROM pipeline_automations WHERE company_id=? ORDER BY id DESC',[context.user.companyId]);
  if(method==='GET'&&path==='/api/pipeline-conversation-rules'){
    const pipelineId=parseId(url.searchParams.get('pipeline_id'));
    if(!get('SELECT 1 FROM pipelines WHERE id=? AND company_id=?',[pipelineId,context.user.companyId]))throw Object.assign(new Error('Funil não encontrado.'),{statusCode:404});
    return all(`SELECT r.id,r.stage_id,r.trigger_phrases,r.is_active,COALESCE(ps.display_name,s.display_name,s.name) AS stage_name
      FROM conversation_stage_rules r JOIN pipeline_stages s ON s.id=r.stage_id
      LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=r.company_id
      WHERE r.company_id=? AND s.pipeline_id=? ORDER BY COALESCE(ps.local_position,s.local_position,s.position)`,[context.user.companyId,pipelineId]).map(item=>({...item,trigger_phrases:asJson(item.trigger_phrases,[])}));
  }
  if(method==='PUT'&&path==='/api/pipeline-conversation-rules'){
    requireRole(context,['admin','manager']);const pipelineId=parseId(body?.pipeline_id);const input=Array.isArray(body?.rules)?body.rules.slice(0,12):[];
    if(!get('SELECT 1 FROM pipelines WHERE id=? AND company_id=?',[pipelineId,context.user.companyId]))throw Object.assign(new Error('Funil não encontrado.'),{statusCode:404});
    const prepared=input.map(item=>{const stageId=parseId(item.stage_id);const stage=get(`SELECT s.id FROM pipeline_stages s LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=?
      WHERE s.id=? AND s.pipeline_id=? AND s.company_id=? AND COALESCE(ps.is_visible,1)=1`,[context.user.companyId,stageId,pipelineId,context.user.companyId]);if(!stage)throw Object.assign(new Error('Etapa inválida para a automação por conversa.'),{statusCode:400});
      const phrases=[...new Set((Array.isArray(item.trigger_phrases)?item.trigger_phrases:String(item.trigger_phrases||'').split(/[,;\n]/)).map(value=>String(value).trim().slice(0,120)).filter(Boolean))].slice(0,20);return{stageId,phrases};});
    transaction(()=>{run(`DELETE FROM conversation_stage_rules WHERE company_id=? AND stage_id IN (SELECT id FROM pipeline_stages WHERE pipeline_id=?)`,[context.user.companyId,pipelineId]);for(const item of prepared.filter(item=>item.phrases.length))run(`INSERT INTO conversation_stage_rules(company_id,stage_id,trigger_phrases,is_active,updated_at) VALUES (?,?,?,1,?)`,[context.user.companyId,item.stageId,JSON.stringify(item.phrases),now()]);});
    return {updated:true,rules:prepared.filter(item=>item.phrases.length)};
  }
  if (method === 'GET' && path === '/api/pipeline-outcome-rules') {
    const pipelineId=parseId(url.searchParams.get('pipeline_id'));
    if(!get('SELECT 1 FROM pipelines WHERE id=? AND company_id=?',[pipelineId,context.user.companyId]))throw Object.assign(new Error('Funil não encontrado.'),{statusCode:404});
    return all('SELECT outcome,target_stage_id,is_active FROM pipeline_outcome_rules WHERE company_id=? AND source_pipeline_id=?',[context.user.companyId,pipelineId]);
  }
  if (method === 'PUT' && path === '/api/pipeline-outcome-rules') {
    requireRole(context,['admin','manager']);const pipelineId=parseId(body?.pipeline_id);
    if(!get('SELECT 1 FROM pipelines WHERE id=? AND company_id=?',[pipelineId,context.user.companyId]))throw Object.assign(new Error('Funil não encontrado.'),{statusCode:404});
    for(const outcome of ['won','lost']){const stageId=Number(body?.[`${outcome}_stage_id`]);if(!stageId){run('DELETE FROM pipeline_outcome_rules WHERE company_id=? AND source_pipeline_id=? AND outcome=?',[context.user.companyId,pipelineId,outcome]);continue;}const stage=get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.id=? AND s.company_id=? AND p.company_id=?`,[stageId,context.user.companyId,context.user.companyId]);if(!stage)throw Object.assign(new Error('Etapa de destino inválida.'),{statusCode:400});run(`INSERT INTO pipeline_outcome_rules(company_id,source_pipeline_id,outcome,target_stage_id,is_active,updated_at) VALUES (?,?,?,?,1,?) ON CONFLICT(company_id,source_pipeline_id,outcome) DO UPDATE SET target_stage_id=excluded.target_stage_id,is_active=1,updated_at=excluded.updated_at`,[context.user.companyId,pipelineId,outcome,stageId,now()]);}
    return {updated:true};
  }
  if (method === 'POST' && path === '/api/pipeline-automations') {
    requireRole(context,['admin','manager']); const name=String(body?.name||'').trim().slice(0,100); if(!name)throw Object.assign(new Error('Informe o nome da automação.'),{statusCode:400});
    for(const pipelineId of [body.target_pipeline_id].filter(Boolean))if(!get('SELECT 1 FROM pipelines WHERE id=? AND company_id=?',[Number(pipelineId),context.user.companyId]))throw Object.assign(new Error('Pipeline de destino inválido.'),{statusCode:400});
    for(const stageId of [body.trigger_stage_id,body.target_stage_id].filter(Boolean))if(!get(`SELECT 1 FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.id=? AND p.company_id=?`,[Number(stageId),context.user.companyId]))throw Object.assign(new Error('Etapa inválida para esta empresa.'),{statusCode:400});
    const result=run(`INSERT INTO pipeline_automations(company_id,name,trigger_type,trigger_stage_id,target_pipeline_id,target_stage_id,action_type,action_value,is_active) VALUES (?,?,?,?,?,?,?,?,?)`,[context.user.companyId,name,body.trigger_type||'stage_entered',body.trigger_stage_id||null,body.target_pipeline_id||null,body.target_stage_id||null,body.action_type||'move_deal',String(body.action_value||'').slice(0,200)||null,body.is_active===false?0:1]);
    return get('SELECT * FROM pipeline_automations WHERE id=?',[Number(result.lastInsertRowid)]);
  }
  match=path.match(/^\/api\/pipeline-automations\/(\d+)$/);
  if(method==='DELETE'&&match){requireRole(context,['admin','manager']);run('DELETE FROM pipeline_automations WHERE id=? AND company_id=?',[parseId(match[1]),context.user.companyId]);return {deleted:true};}
  if (method === 'DELETE' && path === '/api/contacts/bulk') {
    requireRole(context,['admin','manager']); const ids=[...new Set((body?.ids||[]).map(Number).filter(Number.isInteger))].slice(0,500); if(!ids.length)throw Object.assign(new Error('Selecione ao menos um contato.'),{statusCode:400}); const placeholders=ids.map(()=>'?').join(','); const result=run(`DELETE FROM contacts WHERE company_id=? AND id IN (${placeholders})`,[context.user.companyId,...ids]); return {deleted:Number(result.changes)};
  }

  if (method === 'GET' && path === '/api/loss-reasons') return all('SELECT * FROM loss_reasons WHERE is_active=1 ORDER BY name');
  if (method === 'POST' && path === '/api/loss-reasons') {
    requireRole(context, ['admin', 'manager']);
    const name = String(body.name || '').trim();
    if (!name) throw Object.assign(new Error('Informe o motivo'), { statusCode: 400 });
    const result = run('INSERT INTO loss_reasons (name,color) VALUES (?,?)', [name, body.color || '#B65353']);
    return get('SELECT * FROM loss_reasons WHERE id=?', [Number(result.lastInsertRowid)]);
  }

  if (method === 'GET' && path === '/api/tags') return all('SELECT * FROM tag_definitions ORDER BY category,name');
  if (method === 'GET' && path === '/api/qualification/config') {
    const pipeline = get("SELECT id,name FROM pipelines WHERE company_id=? AND kind='sales' ORDER BY is_default DESC,id LIMIT 1",[context.user.companyId]);
    const stages = pipeline ? all(`SELECT id,COALESCE(display_name,name) AS name,local_position FROM pipeline_stages WHERE pipeline_id=? ORDER BY local_position`, [pipeline.id]) : [];
    return { config: qualificationConfig(context.user.companyId), pipeline, stages, totals: recalculateQualifications(context.user.companyId) };
  }
  if (method === 'PUT' && path === '/api/qualification/config') {
    requireRole(context, ['admin', 'manager']);
    return saveQualificationConfig({ ...body, mql_stage_id: body.mql_stage_id ? parseId(body.mql_stage_id) : null, sql_stage_id: body.sql_stage_id ? parseId(body.sql_stage_id) : null }, context.user.companyId);
  }
  if (method === 'POST' && path === '/api/qualification/recalculate') {
    requireRole(context, ['admin', 'manager']);
    return recalculateQualifications(context.user.companyId);
  }
  match = path.match(/^\/api\/contacts\/(\d+)\/tags$/);
  if (method === 'POST' && match) {
    const contactId = parseId(match[1]); const tag = String(body.tag || '').trim().slice(0, 40);
    if (!tag) throw Object.assign(new Error('Informe a tag'), { statusCode: 400 });
    run('INSERT OR IGNORE INTO tag_definitions (name,category,campaign_name) VALUES (?,?,?)', [tag, body.category || 'manual', body.campaign_name || null]);
    run('INSERT OR IGNORE INTO contact_tags (contact_id,tag) VALUES (?,?)', [contactId, tag]);
    return { tag };
  }

  if (method === 'GET' && path === '/api/knowledge') return all(`SELECT d.*,(SELECT COUNT(*) FROM knowledge_documents x WHERE x.company_id=d.company_id AND x.id<>d.id AND x.status='active' AND lower(x.category)=lower(d.category) AND lower(x.title)=lower(d.title) AND x.content<>d.content) AS conflict_count FROM knowledge_documents d WHERE d.company_id=? ORDER BY d.is_authoritative DESC,d.priority DESC,d.updated_at DESC`, [context.user.companyId]);
  if (method === 'POST' && path === '/api/knowledge') {
    requireRole(context, ['admin', 'manager']);
    if (!body?.title || !body?.content) throw Object.assign(new Error('Título e conteúdo são obrigatórios'), { statusCode: 400 });
    const result = run(`INSERT INTO knowledge_documents (company_id,title, category, content, priority,is_authoritative,updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [context.user.companyId, body.title, body.category || 'Geral', body.content,Math.max(0,Math.min(100,Number(body.priority)||50)),body.is_authoritative?1:0,context.user.id]);
    if(String(body.category||'').toLowerCase()==='playbook')syncPlaybook(body.content, context.user.companyId);
    return get('SELECT * FROM knowledge_documents WHERE id=?', [Number(result.lastInsertRowid)]);
  }

  match = path.match(/^\/api\/knowledge\/(\d+)$/);
  if (method === 'PUT' && match) {
    requireRole(context,['admin','manager']); const id=parseId(match[1]); if(!body?.title||!body?.content)throw Object.assign(new Error('Título e conteúdo são obrigatórios'),{statusCode:400}); run(`UPDATE knowledge_documents SET title=?,category=?,content=?,priority=?,is_authoritative=?,version=version+1,updated_at=? WHERE id=? AND company_id=?`,[String(body.title).slice(0,160),String(body.category||'Geral').slice(0,60),String(body.content).slice(0,100000),Math.max(0,Math.min(100,Number(body.priority)||50)),body.is_authoritative?1:0,now(),id,context.user.companyId]); if(String(body.category||'').toLowerCase()==='playbook')syncPlaybook(body.content, context.user.companyId); return get('SELECT * FROM knowledge_documents WHERE id=? AND company_id=?',[id,context.user.companyId]);
  }

  match = path.match(/^\/api\/knowledge\/(\d+)$/);
  if (method === 'DELETE' && match) {
    requireRole(context, ['admin', 'manager']);
    run(`UPDATE knowledge_documents SET status='archived', updated_at=? WHERE id=? AND company_id=?`, [now(), parseId(match[1]), context.user.companyId]);
    return { archived: true };
  }

  if (method === 'GET' && path === '/api/agent/command/sessions') {
    return all(`SELECT s.*,(SELECT content FROM agent_command_messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) AS last_message,
      (SELECT COUNT(*) FROM agent_action_proposals a WHERE a.session_id=s.id AND a.status='pending') AS pending_actions
      FROM agent_command_sessions s WHERE s.company_id=? ORDER BY s.updated_at DESC,s.id DESC LIMIT 40`,[context.user.companyId]);
  }
  if (method === 'POST' && path === '/api/agent/command/sessions') {
    const title=String(body?.title||'Nova sessão').trim().slice(0,100)||'Nova sessão';const result=run('INSERT INTO agent_command_sessions(company_id,title,created_by) VALUES (?,?,?)',[context.user.companyId,title,context.user.id]);
    return get('SELECT * FROM agent_command_sessions WHERE id=?',[Number(result.lastInsertRowid)]);
  }
  match=path.match(/^\/api\/agent\/command\/sessions\/(\d+)$/);
  if(method==='GET'&&match){const session=get('SELECT * FROM agent_command_sessions WHERE id=? AND company_id=?',[parseId(match[1]),context.user.companyId]);if(!session)throw Object.assign(new Error('Sessão não encontrada.'),{statusCode:404});const messages=all('SELECT * FROM agent_command_messages WHERE session_id=? ORDER BY id',[session.id]).map(item=>({...item,metadata:asJson(item.metadata,{})}));const actions=all('SELECT * FROM agent_action_proposals WHERE session_id=? ORDER BY id',[session.id]).map(item=>({...item,arguments:asJson(item.arguments,{})}));return {...session,messages,actions};}
  match=path.match(/^\/api\/agent\/command\/sessions\/(\d+)\/messages$/);
  if(method==='POST'&&match){requireRole(context,['admin','manager']);const session=get('SELECT * FROM agent_command_sessions WHERE id=? AND company_id=?',[parseId(match[1]),context.user.companyId]);if(!session)throw Object.assign(new Error('Sessão não encontrada.'),{statusCode:404});const content=String(body?.content||'').trim().slice(0,5000);if(!content)throw Object.assign(new Error('Escreva uma mensagem.'),{statusCode:400});run("INSERT INTO agent_command_messages(session_id,role,content) VALUES (?,'user',?)",[session.id,content]);const history=all('SELECT role,content FROM agent_command_messages WHERE session_id=? ORDER BY id DESC LIMIT 20',[session.id]).reverse();const plan=await planAgentCommand({companyId:context.user.companyId,message:content,history});const metadata={model:plan.model,questions:plan.questions||[]};const assistant=run("INSERT INTO agent_command_messages(session_id,role,content,metadata) VALUES (?,'assistant',?,?)",[session.id,plan.reply,JSON.stringify(metadata)]);const messageId=Number(assistant.lastInsertRowid);const proposals=[];for(const action of plan.actions){const result=run(`INSERT INTO agent_action_proposals(session_id,message_id,company_id,action_type,label,arguments,created_by) VALUES (?,?,?,?,?,?,?)`,[session.id,messageId,context.user.companyId,action.type,action.label,JSON.stringify(action.arguments),context.user.id]);proposals.push({...get('SELECT * FROM agent_action_proposals WHERE id=?',[Number(result.lastInsertRowid)]),arguments:action.arguments});}const firstUserMessage=get("SELECT content FROM agent_command_messages WHERE session_id=? AND role='user' ORDER BY id LIMIT 1",[session.id])?.content;if(session.title==='Nova sessão'&&firstUserMessage)run('UPDATE agent_command_sessions SET title=?,updated_at=? WHERE id=?',[firstUserMessage.slice(0,58),now(),session.id]);else run('UPDATE agent_command_sessions SET updated_at=? WHERE id=?',[now(),session.id]);return {message:{id:messageId,session_id:session.id,role:'assistant',content:plan.reply,metadata},actions:proposals};}
  match=path.match(/^\/api\/agent\/command\/actions\/(\d+)\/(apply|reject)$/);
  if(method==='POST'&&match){requireRole(context,['admin','manager']);const action=get('SELECT * FROM agent_action_proposals WHERE id=? AND company_id=?',[parseId(match[1]),context.user.companyId]);if(!action)throw Object.assign(new Error('Ação não encontrada.'),{statusCode:404});if(action.status!=='pending')throw Object.assign(new Error('Esta ação já foi revisada.'),{statusCode:409});if(match[2]==='reject'){run("UPDATE agent_action_proposals SET status='rejected',applied_by=?,applied_at=? WHERE id=?",[context.user.id,now(),action.id]);return {status:'rejected'};}const args=asJson(action.arguments,{});
    if(action.action_type==='update_agent_config'){const allowed=['name','tone','objective','autonomy_level'];const entries=Object.entries(args).filter(([key])=>allowed.includes(key));if(!entries.length)throw Object.assign(new Error('Nenhuma configuração válida foi proposta.'),{statusCode:400});if(entries.some(([key,value])=>key==='autonomy_level'&&(!Number.isInteger(Number(value))||Number(value)<0||Number(value)>3)))throw Object.assign(new Error('Nível de autonomia inválido.'),{statusCode:400});ensureCompanyAgentConfig(context.user.companyId);run(`UPDATE company_agent_config SET ${entries.map(([key])=>`${key}=?`).join(',')},updated_at=? WHERE company_id=?`,[...entries.map(([key,value])=>key==='autonomy_level'?Number(value):String(value).slice(0,key==='objective'?1000:240)),now(),context.user.companyId]);}
    if(action.action_type==='add_learning_rule'){const instruction=String(args.instruction||'').trim().slice(0,2000);if(!instruction)throw Object.assign(new Error('A instrução proposta está vazia.'),{statusCode:400});run(`INSERT INTO agent_learning_rules(company_id,instruction,applies_to,source_type,status,created_by,approved_by,updated_at) VALUES (?,?,?,'manual','approved',?,?,?)`,[context.user.companyId,instruction,String(args.applies_to||'Toda a jornada comercial').slice(0,160),context.user.id,context.user.id,now()]);}
    if(action.action_type==='add_knowledge'){const title=String(args.title||'Conhecimento adicionado pelo agente').trim().slice(0,160);const content=String(args.content||'').trim().slice(0,100000);if(!content)throw Object.assign(new Error('O conteúdo proposto está vazio.'),{statusCode:400});const category=String(args.category||'Geral').slice(0,60);run(`INSERT INTO knowledge_documents(company_id,title,category,content,priority,is_authoritative,updated_by) VALUES (?,?,?,?,60,0,?)`,[context.user.companyId,title,category,content,context.user.id]);if(category.toLowerCase()==='playbook')syncPlaybook(content,context.user.companyId);}
    if(action.action_type==='create_task'){const title=String(args.title||'').trim().slice(0,160);if(!title)throw Object.assign(new Error('O título da tarefa está vazio.'),{statusCode:400});const dueAt=args.due_at&&!Number.isNaN(new Date(args.due_at).getTime())?new Date(args.due_at).toISOString():null;const assignedTo=args.assigned_to?parseId(args.assigned_to):context.user.id;const contactId=args.contact_id?parseId(args.contact_id):null;const dealId=args.deal_id?parseId(args.deal_id):null;if(!get('SELECT 1 FROM user_company_memberships WHERE company_id=? AND user_id=? AND is_active=1',[context.user.companyId,assignedTo]))throw Object.assign(new Error('O responsável proposto não pertence a esta empresa.'),{statusCode:400});if(contactId&&!get('SELECT 1 FROM contacts WHERE id=? AND company_id=?',[contactId,context.user.companyId]))throw Object.assign(new Error('O contato proposto não pertence a esta empresa.'),{statusCode:400});if(dealId&&!get('SELECT 1 FROM deals d JOIN contacts c ON c.id=d.contact_id WHERE d.id=? AND c.company_id=?',[dealId,context.user.companyId]))throw Object.assign(new Error('O negócio proposto não pertence a esta empresa.'),{statusCode:400});const type=['followup','call','meeting','email','internal'].includes(args.type)?args.type:'followup';const priority=['low','normal','high','urgent'].includes(args.priority)?args.priority:'normal';run(`INSERT INTO tasks(company_id,contact_id,deal_id,assigned_to,title,description,due_at,type,priority,created_by) VALUES (?,?,?,?,?,?,?,?,?,'ai')`,[context.user.companyId,contactId,dealId,assignedTo,title,String(args.description||'Criada pela central de comando do agente.').slice(0,1000),dueAt,type,priority]);}
    run("UPDATE agent_action_proposals SET status='applied',applied_by=?,applied_at=? WHERE id=?",[context.user.id,now(),action.id]);return {status:'applied',action_type:action.action_type};
  }

  if (method === 'GET' && path === '/api/agent/learning') {
    return all(`SELECT r.*,u.name AS created_by_name,a.name AS approved_by_name FROM agent_learning_rules r
      LEFT JOIN users u ON u.id=r.created_by LEFT JOIN users a ON a.id=r.approved_by
      WHERE r.company_id=? ORDER BY CASE r.status WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,r.updated_at DESC,r.id DESC`, [context.user.companyId]);
  }
  if (method === 'POST' && path === '/api/agent/preview') {
    return previewAgentResponse({companyId:context.user.companyId,question:body?.question});
  }
  if (method === 'POST' && path === '/api/agent/learning') {
    requireRole(context,['admin','manager']);
    const instruction=String(body?.instruction||'').trim().slice(0,2000);if(!instruction)throw Object.assign(new Error('Explique o que o agente deve aprender.'),{statusCode:400});
    const appliesTo=String(body?.applies_to||'Toda a jornada comercial').trim().slice(0,160)||'Toda a jornada comercial';const sourceType=['preview','conversation'].includes(body?.source_type)?body.source_type:'manual';const sourceMessageId=body?.source_message_id?parseId(body.source_message_id):null;
    if(sourceMessageId&&!get(`SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts ct ON ct.id=c.contact_id WHERE m.id=? AND ct.company_id=?`,[sourceMessageId,context.user.companyId]))throw Object.assign(new Error('Mensagem de origem inválida.'),{statusCode:400});
    const approved=body?.approve!==false;const result=run(`INSERT INTO agent_learning_rules(company_id,instruction,applies_to,example_question,original_response,corrected_response,source_type,source_message_id,status,created_by,approved_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[context.user.companyId,instruction,appliesTo,String(body?.example_question||'').slice(0,4000)||null,String(body?.original_response||'').slice(0,4000)||null,String(body?.corrected_response||'').slice(0,4000)||null,sourceType,sourceMessageId,approved?'approved':'proposed',context.user.id,approved?context.user.id:null,now()]);
    return get('SELECT * FROM agent_learning_rules WHERE id=?',[Number(result.lastInsertRowid)]);
  }
  match=path.match(/^\/api\/agent\/learning\/(\d+)$/);
  if(method==='PATCH'&&match){requireRole(context,['admin','manager']);const status=['approved','rejected','proposed'].includes(body?.status)?body.status:null;if(!status)throw Object.assign(new Error('Status inválido.'),{statusCode:400});run('UPDATE agent_learning_rules SET status=?,approved_by=?,updated_at=? WHERE id=? AND company_id=?',[status,status==='approved'?context.user.id:null,now(),parseId(match[1]),context.user.companyId]);return get('SELECT * FROM agent_learning_rules WHERE id=? AND company_id=?',[parseId(match[1]),context.user.companyId]);}
  if(method==='DELETE'&&match){requireRole(context,['admin','manager']);run('DELETE FROM agent_learning_rules WHERE id=? AND company_id=?',[parseId(match[1]),context.user.companyId]);return {deleted:true};}

  if (method === 'GET' && path === '/api/agent/config') {
    const config = companyAgentConfig(context.user.companyId);
    return { ...config, handoff_rules: asJson(config.handoff_rules, []), followup_rules: asJson(config.followup_rules, {}), business_hours: asJson(config.business_hours, {}), model_status: agentModelStatus(), automation_status:automationStatus(context.user.companyId), whatsapp_status:whatsappDeliveryStatus(context.user.companyId), followup_templates:approvedTemplates(context.user.companyId).filter(item=>item.source==='meta') };
  }
  if (method === 'PUT' && path === '/api/agent/config') {
    requireRole(context, ['admin', 'manager']);
    const validated=validateAgentConfig(body||{});
    const followups=validated.followup_rules?JSON.parse(validated.followup_rules):null;
    if(followups?.template_id && !get("SELECT id FROM message_templates WHERE id=? AND company_id=? AND source='meta' AND status='approved'",[followups.template_id,context.user.companyId]))throw Object.assign(new Error('Escolha um modelo aprovado desta empresa.'),{statusCode:400});
    if(followups?.template_id && /\{\{/.test(get('SELECT body FROM message_templates WHERE id=?',[followups.template_id]).body))throw Object.assign(new Error('Para retomadas automáticas, escolha um modelo aprovado sem variáveis.'),{statusCode:400});
    const entries = Object.entries(validated);
    ensureCompanyAgentConfig(context.user.companyId);
    if (entries.length) run(`UPDATE company_agent_config SET ${entries.map(([key]) => `${key}=?`).join(', ')}, updated_at=? WHERE company_id=?`, [...entries.map(([, value]) => value), now(), context.user.companyId]);
    return companyAgentConfig(context.user.companyId);
  }

  if (method === 'GET' && path === '/api/agent/runs') {
    return all(`SELECT r.*, ct.name AS contact_name, c.intent AS current_intent,
      (SELECT COUNT(*) FROM tool_calls t WHERE t.run_id=r.id) AS tools,
      (SELECT GROUP_CONCAT(tool_name, ', ') FROM tool_calls t WHERE t.run_id=r.id) AS tool_names
      FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id JOIN contacts ct ON ct.id=c.contact_id
      WHERE ct.company_id=? ORDER BY r.id DESC LIMIT 30`, [context.user.companyId]);
  }

  if (method === 'GET' && path === '/api/tasks') {
    const where = ['t.company_id=?']; const params = [context.user.companyId];
    if (url.searchParams.get('start')) { where.push('date(t.due_at)>=?'); params.push(url.searchParams.get('start')); }
    if (url.searchParams.get('end')) { where.push('date(t.due_at)<=?'); params.push(url.searchParams.get('end')); }
    if (url.searchParams.get('assigned_to')) { where.push('t.assigned_to=?'); params.push(parseId(url.searchParams.get('assigned_to'))); }
    return all(`SELECT t.*, CASE WHEN t.google_event_id IS NOT NULL AND t.created_by='system' THEN 'google' ELSE 'internal' END AS source, ct.name AS contact_name, ct.company, u.name AS assigned_name
      FROM tasks t LEFT JOIN contacts ct ON ct.id=t.contact_id LEFT JOIN users u ON u.id=t.assigned_to
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.status, t.due_at`, params);
  }
  if (method === 'GET' && path === '/api/integrations/google/status') return googleStatus(context.user.companyId);
  if (method === 'GET' && path === '/api/integrations/google/start') return { url: googleAuthorizationUrl(context.user, `${oauthCallbackBaseUrl(request)}/api/integrations/google/callback`) };
  if (method === 'GET' && path === '/api/integrations/google/events') {
    const range = dateRange(url); return googleCalendarEvents(context.user.companyId, range.start, range.end);
  }
  if (method === 'GET' && path === '/api/integrations/google/calendars') return googleCalendars(context.user.companyId);
  if (method === 'POST' && path === '/api/integrations/google/sync') return syncGoogleCalendar(context.user.companyId, context.user.id);
  if (method === 'POST' && path === '/api/integrations/google/disconnect') return disconnectGoogle(context.user.companyId);
  if (method === 'POST' && path === '/api/tasks') {
    const title = String(body.title || '').trim().slice(0, 160);
    if (!title) throw Object.assign(new Error('Informe o título da tarefa'), { statusCode: 400 });
    const dealId = body.deal_id ? parseId(body.deal_id) : null;
    const deal = dealId ? get(`SELECT d.id,d.contact_id FROM deals d JOIN contacts ct ON ct.id=d.contact_id
      WHERE d.id=? AND ct.company_id=?`, [dealId, context.user.companyId]) : null;
    if (dealId && !deal) throw Object.assign(new Error('Negócio não encontrado nesta empresa.'), { statusCode: 404 });
    let contactId = body.contact_id ? parseId(body.contact_id) : null;
    if (deal) {
      if (contactId && contactId !== deal.contact_id) throw Object.assign(new Error('O contato informado não pertence a este negócio.'), { statusCode: 400 });
      contactId = deal.contact_id;
    }
    const conversationId = body.conversation_id ? parseId(body.conversation_id) : null;
    const assignedTo = body.assigned_to ? parseId(body.assigned_to) : context.user.id;
    const priority=['urgent','high','normal','low'].includes(body.priority)?body.priority:'normal';
    if (contactId && !get('SELECT 1 FROM contacts WHERE id=? AND company_id=?', [contactId, context.user.companyId])) throw Object.assign(new Error('Contato não encontrado.'), { statusCode: 404 });
    const result = run(`INSERT INTO tasks (company_id,contact_id,deal_id,conversation_id,assigned_to,title,description,due_at,type,priority,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,'human')`, [context.user.companyId, contactId, dealId, conversationId, assignedTo, title, String(body.description || '').slice(0, 1000), body.due_at || null, body.type || 'followup',priority]);
    if (contactId) run(`INSERT INTO activities (contact_id,deal_id,conversation_id,actor_type,actor_id,action,description)
      VALUES (?,?,?,'human',?,'task_created',?)`, [contactId, dealId, conversationId, context.user.id, `Tarefa criada: ${title}.`]);
    const task=get(`SELECT t.*, u.name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE t.id=?`, [Number(result.lastInsertRowid)]);
    try { const event=await createGoogleTaskEvent(context.user.companyId,task); if(event?.id){run("UPDATE tasks SET google_event_id=?,google_calendar_id='primary' WHERE id=?",[event.id,task.id]);task.google_event_id=event.id;task.google_calendar_id='primary';} } catch(error) { task.calendar_sync_warning=error.message; }
    return task;
  }
  if ((method === 'PATCH' || method === 'DELETE') && path === '/api/tasks/bulk') {
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(value => parseId(value)).filter(Boolean))].slice(0, 200);
    if (!ids.length) throw Object.assign(new Error('Selecione ao menos uma tarefa.'), { statusCode: 400 });
    const placeholders = ids.map(() => '?').join(',');
    const tasks = all(`SELECT * FROM tasks WHERE company_id=? AND id IN (${placeholders})`, [context.user.companyId, ...ids]);
    if (!tasks.length) throw Object.assign(new Error('Nenhuma tarefa selecionada foi encontrada nesta empresa.'), { statusCode: 404 });

    if (method === 'DELETE') {
      let calendarWarnings = 0;
      for (const task of tasks) {
        try { await deleteGoogleTaskEvent(context.user.companyId, task.google_event_id, task.google_calendar_id); } catch { calendarWarnings += 1; }
      }
      run(`DELETE FROM tasks WHERE company_id=? AND id IN (${placeholders})`, [context.user.companyId, ...ids]);
      return { deleted: tasks.length, calendar_sync_warnings: calendarWarnings };
    }

    const action = String(body.action || '');
    const allowedActions = ['complete', 'update', 'reschedule', 'move'];
    if (!allowedActions.includes(action)) throw Object.assign(new Error('Ação em lote inválida.'), { statusCode: 400 });
    let assignedTo;
    if (action === 'update' && body.assigned_to !== undefined && body.assigned_to !== '') {
      assignedTo = parseId(body.assigned_to);
      if (!get('SELECT 1 FROM user_company_memberships WHERE company_id=? AND user_id=? AND is_active=1', [context.user.companyId, assignedTo])) {
        throw Object.assign(new Error('O responsável não pertence a esta empresa.'), { statusCode: 400 });
      }
    }
    const dueAt = action === 'update' && body.due_at ? String(body.due_at) : null;
    if (dueAt && Number.isNaN(new Date(dueAt).getTime())) throw Object.assign(new Error('Informe uma data válida.'), { statusCode: 400 });
    const taskType = action === 'move' && ['followup', 'meeting', 'call', 'other'].includes(body.type) ? body.type : null;
    if (action === 'move' && !taskType) throw Object.assign(new Error('Escolha um tipo de tarefa válido.'), { statusCode: 400 });
    const reschedule = action === 'reschedule' && ['tomorrow', 'two-days', 'next-monday', 'next-month'].includes(body.reschedule) ? body.reschedule : null;
    if (action === 'reschedule' && !reschedule) throw Object.assign(new Error('Escolha um prazo válido.'), { statusCode: 400 });
    if (action === 'update' && assignedTo === undefined && !dueAt) throw Object.assign(new Error('Informe um novo responsável ou uma nova data.'), { statusCode: 400 });

    const rescheduledDate = task => {
      const original = task.due_at ? new Date(task.due_at) : new Date();
      const current = new Date();
      const target = new Date(current);
      target.setHours(original.getHours(), original.getMinutes(), 0, 0);
      if (reschedule === 'tomorrow') target.setDate(current.getDate() + 1);
      if (reschedule === 'two-days') target.setDate(current.getDate() + 2);
      if (reschedule === 'next-monday') target.setDate(current.getDate() + (((8 - current.getDay()) % 7) || 7));
      if (reschedule === 'next-month') {
        const desiredDay = current.getDate();
        target.setDate(1);
        target.setMonth(current.getMonth() + 1);
        target.setDate(Math.min(desiredDay, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
      }
      return target.toISOString();
    };

    let calendarWarnings = 0;
    for (const task of tasks) {
      if (action === 'complete') run("UPDATE tasks SET status='completed', completed_at=? WHERE id=? AND company_id=?", [now(), task.id, context.user.companyId]);
      if (action === 'update') {
        const entries = [];
        const params = [];
        if (assignedTo !== undefined) { entries.push('assigned_to=?'); params.push(assignedTo); }
        if (dueAt) { entries.push('due_at=?'); params.push(dueAt); }
        run(`UPDATE tasks SET ${entries.join(', ')} WHERE id=? AND company_id=?`, [...params, task.id, context.user.companyId]);
      }
      if (action === 'reschedule') run("UPDATE tasks SET due_at=?, status='pending', completed_at=NULL WHERE id=? AND company_id=?", [rescheduledDate(task), task.id, context.user.companyId]);
      if (action === 'move') run('UPDATE tasks SET type=? WHERE id=? AND company_id=?', [taskType, task.id, context.user.companyId]);
      const updated = get('SELECT * FROM tasks WHERE id=? AND company_id=?', [task.id, context.user.companyId]);
      try {
        if (updated.status === 'completed' || updated.status === 'cancelled') await deleteGoogleTaskEvent(context.user.companyId, updated.google_event_id, updated.google_calendar_id);
        else if (updated.google_event_id) await updateGoogleTaskEvent(context.user.companyId, updated);
        else {
          const event = await createGoogleTaskEvent(context.user.companyId, updated);
          if (event?.id) run("UPDATE tasks SET google_event_id=?,google_calendar_id='primary' WHERE id=?", [event.id, updated.id]);
        }
      } catch { calendarWarnings += 1; }
    }
    return { updated: tasks.length, action, calendar_sync_warnings: calendarWarnings };
  }
  match = path.match(/^\/api\/tasks\/(\d+)$/);
  if (method === 'PATCH' && match) {
    const id = parseId(match[1]);
    if (!get('SELECT 1 FROM tasks WHERE id=? AND company_id=?', [id, context.user.companyId])) throw Object.assign(new Error('Tarefa não encontrada.'), { statusCode: 404 });
    const allowed = ['title', 'description', 'due_at', 'assigned_to', 'type', 'priority', 'status'];
    const entries = Object.entries(body || {}).filter(([key]) => allowed.includes(key));
    if (!entries.length) throw Object.assign(new Error('Nenhum campo permitido foi informado'), { statusCode: 400 });
    const completedAt = body.status && body.status !== 'pending' ? now() : null;
    run(`UPDATE tasks SET ${entries.map(([key]) => `${key}=?`).join(', ')}, completed_at=? WHERE id=?`, [...entries.map(([, value]) => value), completedAt, id]);
    const task=get('SELECT * FROM tasks WHERE id=?', [id]);
    try { if(task.status==='cancelled'||task.status==='completed')await deleteGoogleTaskEvent(context.user.companyId,task.google_event_id,task.google_calendar_id); else if(task.google_event_id)await updateGoogleTaskEvent(context.user.companyId,task); else {const event=await createGoogleTaskEvent(context.user.companyId,task);if(event?.id){run("UPDATE tasks SET google_event_id=?,google_calendar_id='primary' WHERE id=?",[event.id,id]);task.google_event_id=event.id;task.google_calendar_id='primary';}} } catch(error){task.calendar_sync_warning=error.message;}
    return task;
  }
  match = path.match(/^\/api\/tasks\/(\d+)$/);
  if (method === 'DELETE' && match) {
    const id=parseId(match[1]); const task=get('SELECT * FROM tasks WHERE id=? AND company_id=?',[id,context.user.companyId]); if(!task)throw Object.assign(new Error('Tarefa não encontrada.'),{statusCode:404});
    try{await deleteGoogleTaskEvent(context.user.companyId,task.google_event_id,task.google_calendar_id);}catch{}
    run('DELETE FROM tasks WHERE id=?',[id]); return {deleted:true};
  }

  match = path.match(/^\/api\/conversations\/(\d+)\/summary$/);
  if (method === 'POST' && match) {
    const id = parseId(match[1]); const item = getConversation(id, context.user.companyId);
    const inbound = item.messages.filter(message => message.direction === 'inbound').slice(-3).map(message => message.content).join(' ');
    const summary = `${item.name} está em ${item.stage_name || 'novo lead'}. ${item.intent ? `Interesse principal: ${item.intent}.` : ''} ${inbound ? `Últimos sinais: ${inbound.slice(0, 220)}.` : ''}`.replace(/\s+/g, ' ').trim();
    const nextAction = item.tasks.find(task => task.status === 'pending')?.title || item.next_action || 'Aguardar próxima interação.';
    run('UPDATE conversations SET summary=?, next_action=?, updated_at=? WHERE id=?', [summary, nextAction, now(), id]);
    return { summary, next_action: nextAction };
  }

  if (method === 'GET' && path === '/api/meta/status') return {
    ...publicMetaConfig(context.user.companyId),
    oauth: metaOauthStatus(),
    webhook_url: `${String(process.env.PUBLIC_URL || `${request.headers['x-forwarded-proto'] || 'http'}://${request.headers.host || 'localhost:3210'}`).trim().replace(/\/+$/, '')}/api/webhooks/whatsapp`,
    leads_webhook_url: `${String(process.env.PUBLIC_URL || `${request.headers['x-forwarded-proto'] || 'http'}://${request.headers.host || 'localhost:3210'}`).trim().replace(/\/+$/, '')}/api/webhooks/meta-leads`,
    requirements: ['Token permanente da Meta', 'Phone Number ID', 'App Secret', 'Token de verificação', 'URL pública HTTPS']
  };
  if (method === 'GET' && path === '/api/meta/oauth/start') return {url:metaAuthorizationUrl(context.user,`${oauthCallbackBaseUrl(request)}/api/integrations/meta/callback`)};
  if (method === 'POST' && path === '/api/meta/whatsapp/embedded-signup') {
    requireRole(context, ['admin', 'manager']);
    return completeWhatsAppEmbeddedSignup({ code:body.code, wabaId:body.waba_id, phoneNumberId:body.phone_number_id, companyId:context.user.companyId });
  }
  if (method === 'PUT' && path === '/api/meta/whatsapp/numbers/active') {
    requireRole(context, ['admin', 'manager']);
    return selectWhatsAppNumber(context.user.companyId, body.phone_number_id);
  }
  if (method === 'GET' && path === '/api/evolution/status') return evolutionStatus(context.user.companyId);
  if (method === 'POST' && path === '/api/evolution/connect') {
    requireRole(context, ['admin', 'manager']);
    return connectEvolution(request, context.user.companyId);
  }
  if (method === 'POST' && path === '/api/evolution/disconnect') {
    requireRole(context, ['admin', 'manager']);
    return disconnectEvolution(context.user.companyId);
  }
  if (method === 'GET' && path === '/api/message-templates') return approvedTemplates(context.user.companyId);
  if (method === 'POST' && path === '/api/message-templates') {
    requireRole(context, ['admin', 'manager']);
    const displayName = String(body.display_name || '').trim().slice(0, 120);
    const messageBody = String(body.body || '').trim().slice(0, 2000);
    const category = ['marketing', 'utility', 'authentication'].includes(body.category) ? body.category : 'marketing';
    if (!displayName || !messageBody) throw Object.assign(new Error('Informe o nome e a mensagem do modelo.'), { statusCode: 400 });
    const metaName = `local_${Date.now()}_${displayName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'modelo'}`;
    const result = run("INSERT INTO message_templates (company_id,meta_name,display_name,category,language,body,status,source) VALUES (?,?,?,?,?,?,'approved','local')", [context.user.companyId, metaName, displayName, category, 'pt_BR', messageBody]);
    return get('SELECT id,meta_name,display_name,category,language,body,source FROM message_templates WHERE id=?', [result.lastInsertRowid]);
  }
  if (method === 'POST' && path === '/api/message-templates/sync') {
    requireRole(context, ['admin', 'manager']);
    return syncApprovedTemplates(context.user.companyId);
  }
  if (method === 'GET' && path === '/api/campaigns') return campaignList(context.user.companyId);
  match = path.match(/^\/api\/campaigns\/(\d+)$/);
  if (method === 'GET' && match) return campaignDetail(parseId(match[1]), context.user.companyId);
  if (method === 'POST' && path === '/api/campaigns/import') {
    requireRole(context, ['admin', 'manager']);
    return importCampaign({ name: body.name, templateId: body.template_id, fileName: body.file_name, dataBase64: body.data_base64, userId: context.user.id, companyId: context.user.companyId });
  }
  match = path.match(/^\/api\/campaigns\/(\d+)\/start$/);
  if (method === 'POST' && match) {
    requireRole(context, ['admin', 'manager']);
    if (body.confirm_compliance !== true) throw Object.assign(new Error('Confirme o consentimento dos destinatários antes de iniciar.'), { statusCode: 400 });
    return startCampaign(parseId(match[1]), { simulate: body.simulate === true, companyId: context.user.companyId });
  }
  match = path.match(/^\/api\/campaigns\/(\d+)\/cancel$/);
  if (method === 'POST' && match) {
    requireRole(context, ['admin', 'manager']);
    return cancelCampaign(parseId(match[1]), context.user.companyId);
  }
  if (method === 'PUT' && path === '/api/meta/config') {
    requireRole(context, ['admin', 'manager']);
    return saveMetaConfig(body || {}, context.user.companyId);
  }
  if (method === 'POST' && path === '/api/meta/test') {
    requireRole(context, ['admin', 'manager']);
    return testMetaConnection(context.user.companyId);
  }
  if (method === 'POST' && path === '/api/meta/sync') {
    requireRole(context, ['admin', 'manager']);
    const range = dateRange(url);
    return syncMetaAnalytics(range.start, range.end, context.user.companyId);
  }
  if (method === 'GET' && path === '/api/meta/metrics') {
    const range = dateRange(url);
    let daily = all('SELECT * FROM company_meta_metrics_daily WHERE company_id=? AND date BETWEEN ? AND ? ORDER BY date', [context.user.companyId, range.start, range.end]);
    if (!metaIsConfigured(context.user.companyId) && !daily.length) {
      daily = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(`${range.end}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - (6 - index));
        return { date: date.toISOString().slice(0, 10), conversations_started: 9 + index * 2, messages_sent: 27 + index * 4, messages_delivered: 25 + index * 4, messages_read: 19 + index * 3, messages_received: 21 + index * 3, spend_cents: 1180 + index * 140 };
      }).filter(row => row.date >= range.start && row.date <= range.end);
    }
    const totals = daily.reduce((sum, row) => ({ conversations_started: sum.conversations_started + row.conversations_started, messages_sent: sum.messages_sent + row.messages_sent, messages_delivered: sum.messages_delivered + row.messages_delivered, messages_read: sum.messages_read + row.messages_read, messages_received: sum.messages_received + row.messages_received, spend_cents: sum.spend_cents + row.spend_cents }), { conversations_started: 0, messages_sent: 0, messages_delivered: 0, messages_read: 0, messages_received: 0, spend_cents: 0 });
    return { connected: metaIsConfigured(context.user.companyId), demo: !metaIsConfigured(context.user.companyId), range, totals, daily };
  }
  if (method === 'GET' && path === '/api/meta/ads/accounts') return metaAdAccounts(context.user.companyId);
  if (method === 'GET' && path === '/api/meta/businesses') return metaBusinesses(context.user.companyId);
  if (method === 'PUT' && path === '/api/meta/businesses/active') { requireRole(context,['admin','manager']); return selectMetaBusiness(context.user.companyId,body?.business_id); }
  if (method === 'POST' && path === '/api/meta/marketing/sync') { requireRole(context,['admin','manager']); return syncMetaMarketing(context.user.companyId); }
  if (method === 'GET' && path === '/api/meta/ads/campaigns') return metaAdCampaigns(context.user.companyId,url.searchParams.get('account_id'));
  if (method === 'GET' && path === '/api/meta/pages') return metaPages(context.user.companyId);
  if (method === 'GET' && path === '/api/meta/lead-forms') return metaLeadForms(context.user.companyId,url.searchParams.get('page_id'));
  if (method === 'POST' && path === '/api/meta/leads/activate') { requireRole(context,['admin','manager']); return activateMetaLeadRetrieval(context.user.companyId); }
  if (method === 'GET' && path === '/api/meta/ads/insights') {
    const range=dateRange(url); return metaAdsInsights(context.user.companyId,url.searchParams.get('account_id'),range.start,range.end,url.searchParams.get('campaign_id')||'');
  }

  if (method === 'GET' && path === '/api/companies') {
    if (context.user.isMaster) return all(`SELECT c.*,COALESCE(SUM(CASE WHEN u.is_master=0 THEN 1 ELSE 0 END),0) AS member_count FROM company_profiles c
      LEFT JOIN user_company_memberships m ON m.company_id=c.id AND m.is_active=1
      LEFT JOIN users u ON u.id=m.user_id GROUP BY c.id ORDER BY c.name`)
      .map(company => ({ ...company, access_url: companyAccessUrl(request, company) }));
    return all(`SELECT c.*, m.role AS membership_role FROM company_profiles c
      JOIN user_company_memberships m ON m.company_id=c.id WHERE m.user_id=? AND m.is_active=1 ORDER BY c.name`, [context.user.id]);
  }
  if (method === 'POST' && path === '/api/companies') {
    if (!context.user.isMaster) throw Object.assign(new Error('Somente o Onboarding Manager da Atenva pode cadastrar novos clientes.'), { statusCode: 403 });
    const name=String(body?.name||'').trim().slice(0,120); if(name.length<2)throw Object.assign(new Error('Informe o nome da empresa.'),{statusCode:400});
    const slug=uniqueCompanySlug(name);
    const created=run(`INSERT INTO company_profiles (name,slug,status,created_by) VALUES (?,?,'active',?)`,[name,slug,context.user.id]); const companyId=Number(created.lastInsertRowid);
    run(`INSERT INTO user_company_memberships (company_id,user_id,role,is_active,invited_by) VALUES (?,?, 'owner',1,?)`,[companyId,context.user.id,context.user.id]);
    ensureCompanyPipelines(companyId);
    ensureCompanyAgentConfig(companyId);
    qualificationConfig(companyId);
    const company=get('SELECT * FROM company_profiles WHERE id=?',[companyId]);
    return {...company,access_url:companyAccessUrl(request,company)};
  }
  if (method === 'POST' && path === '/api/clients') {
    if (!context.user.isMaster) throw Object.assign(new Error('Somente o Onboarding Manager da Atenva pode cadastrar novos clientes.'), { statusCode: 403 });
    const name=String(body?.name||'').trim().slice(0,120);
    const adminName=String(body?.admin_name||'').trim().slice(0,120);
    const adminEmail=String(body?.admin_email||'').trim().toLowerCase().slice(0,254);
    const plan=['starter','business','scale'].includes(body?.plan)?body.plan:'business';
    const status=['trial','active'].includes(body?.status)?body.status:'trial';
    const maxUsers=Math.max(1,Math.min(500,Number(body?.max_users)||({starter:3,business:10,scale:30}[plan])));
    if(name.length<2)throw Object.assign(new Error('Informe o nome da empresa.'),{statusCode:400});
    if(adminName.length<2)throw Object.assign(new Error('Informe o nome do administrador do cliente.'),{statusCode:400});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail))throw Object.assign(new Error('Informe um e-mail válido para o administrador.'),{statusCode:400});
    if(get('SELECT is_master FROM users WHERE lower(email)=?',[adminEmail])?.is_master)throw Object.assign(new Error('Use um e-mail de cliente, não um acesso de Onboarding Manager.'),{statusCode:409});
    const slug=uniqueCompanySlug(body?.slug||name);
    const trialEndsAt=status==='trial'?new Date(Date.now()+14*86_400_000).toISOString():null;
    let companyId;
    transaction(()=>{
      const created=run(`INSERT INTO company_profiles (name,slug,status,plan,max_users,trial_ends_at,created_by) VALUES (?,?,?,?,?,?,?)`,[name,slug,status,plan,maxUsers,trialEndsAt,context.user.id]);
      companyId=Number(created.lastInsertRowid);
      run(`INSERT INTO user_company_memberships (company_id,user_id,role,is_active,invited_by) VALUES (?,?,'owner',1,?)`,[companyId,context.user.id,context.user.id]);
    });
    ensureCompanyPipelines(companyId);
    ensureCompanyAgentConfig(companyId);
    qualificationConfig(companyId);
    const invitation=await createInvitation({request,email:adminEmail,role:'admin',companyId,inviterId:context.user.id,inviterName:context.user.name});
    const company=get('SELECT * FROM company_profiles WHERE id=?',[companyId]);
    return {company:{...company,access_url:companyAccessUrl(request,company)},administrator:{name:adminName,email:adminEmail},invitation};
  }
  let companyUpdate=path.match(/^\/api\/companies\/(\d+)$/);
  if(method==='PATCH'&&companyUpdate){
    if(!context.user.isMaster)throw Object.assign(new Error('Somente o Onboarding Manager da Atenva pode alterar clientes.'),{statusCode:403});
    const companyId=parseId(companyUpdate[1]);const company=get('SELECT * FROM company_profiles WHERE id=?',[companyId]);
    if(!company)throw Object.assign(new Error('Cliente não encontrado.'),{statusCode:404});
    const status=['trial','active','suspended','cancelled'].includes(body?.status)?body.status:company.status;
    const plan=['starter','business','scale'].includes(body?.plan)?body.plan:company.plan;
    const maxUsers=body?.max_users===undefined?company.max_users:Math.max(1,Math.min(500,Number(body.max_users)||company.max_users));
    run('UPDATE company_profiles SET status=?,plan=?,max_users=?,updated_at=? WHERE id=?',[status,plan,maxUsers,now(),companyId]);
    const updated=get('SELECT * FROM company_profiles WHERE id=?',[companyId]);return {...updated,access_url:companyAccessUrl(request,updated)};
  }
  let companySwitch=path.match(/^\/api\/companies\/(\d+)\/activate$/);
  if (method === 'POST' && companySwitch) {
    const companyId=parseId(companySwitch[1]); const allowed=context.user.isMaster||get(`SELECT 1 FROM user_company_memberships m JOIN company_profiles c ON c.id=m.company_id
      WHERE m.company_id=? AND m.user_id=? AND m.is_active=1 AND (c.status='active' OR (c.status='trial' AND (c.trial_ends_at IS NULL OR c.trial_ends_at>?)))`,[companyId,context.user.id,now()]);
    if(!allowed)throw Object.assign(new Error('Você não possui acesso a esta empresa.'),{statusCode:403});
    run('UPDATE users SET active_company_id=? WHERE id=?',[companyId,context.user.id]); return {active_company_id:companyId};
  }
  if (method === 'GET' && path === '/api/invitations') {
    if (!canAdminCompany(context)) throw Object.assign(new Error('Você não tem permissão para visualizar convites.'), { statusCode: 403 });
    const where = context.user.isMaster ? '' : 'WHERE i.company_id=?';
    const params = context.user.isMaster ? [] : [context.user.companyId];
    return all(`SELECT i.id,i.email,i.role,i.company_id,i.expires_at,i.accepted_at,i.revoked_at,i.created_at,
      c.name AS company_name,u.name AS inviter_name
      FROM user_invitations i LEFT JOIN company_profiles c ON c.id=i.company_id JOIN users u ON u.id=i.invited_by
      ${where} ORDER BY i.created_at DESC LIMIT 100`, params);
  }
  if (method === 'POST' && path === '/api/invitations') {
    if (!canAdminCompany(context)) throw Object.assign(new Error('Você não tem permissão para enviar convites.'), { statusCode: 403 });
    const email = String(body?.email || '').trim().toLowerCase().slice(0, 254);
    const requestedRole = String(body?.role || 'agent');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Informe um e-mail válido.'), { statusCode: 400 });
    const allowedRoles = context.user.isMaster ? ['master', 'admin', 'manager', 'agent'] : ['admin', 'manager', 'agent'];
    if (!allowedRoles.includes(requestedRole)) throw Object.assign(new Error('Você não pode conceder esta permissão.'), { statusCode: 403 });
    let companyId = context.user.companyId;
    if (context.user.isMaster && body?.company_id) companyId = parseId(body.company_id);
    if (requestedRole !== 'master' && !get(`SELECT id FROM company_profiles WHERE id=? AND
      (status='active' OR (status='trial' AND (trial_ends_at IS NULL OR trial_ends_at>?)))`, [companyId,now()])) {
      throw Object.assign(new Error('Selecione uma empresa ativa para o convite.'), { statusCode: 400 });
    }
    if (!context.user.isMaster && Number(companyId) !== Number(context.user.companyId)) throw Object.assign(new Error('Você só pode convidar pessoas para sua empresa.'), { statusCode: 403 });
    return createInvitation({request,email,role:requestedRole,companyId,inviterId:context.user.id,inviterName:context.user.name});
  }
  let revokeMatch = path.match(/^\/api\/invitations\/(\d+)\/revoke$/);
  if (method === 'POST' && revokeMatch) {
    if (!canAdminCompany(context)) throw Object.assign(new Error('Você não tem permissão para cancelar convites.'), { statusCode: 403 });
    const invitation = get('SELECT * FROM user_invitations WHERE id=?', [parseId(revokeMatch[1])]);
    if (!invitation || (!context.user.isMaster && Number(invitation.company_id) !== Number(context.user.companyId))) throw Object.assign(new Error('Convite não encontrado.'), { statusCode: 404 });
    run('UPDATE user_invitations SET revoked_at=? WHERE id=? AND accepted_at IS NULL', [now(), invitation.id]);
    return { revoked: true };
  }

  if (method === 'GET' && path === '/api/users') {
    if (context.user.isMaster) return all(`SELECT u.id,u.name,u.email,u.role,u.avatar,u.status,u.is_active,u.is_master,
      c.name AS company_name,m.role AS company_role FROM users u
      LEFT JOIN company_profiles c ON c.id=u.active_company_id
      LEFT JOIN user_company_memberships m ON m.user_id=u.id AND m.company_id=u.active_company_id ORDER BY u.name`);
    return all(`SELECT u.id,u.name,u.email,u.role,u.avatar,u.status,u.is_active,u.is_master,c.name AS company_name,m.role AS company_role
      FROM users u JOIN user_company_memberships m ON m.user_id=u.id AND m.company_id=? AND m.is_active=1
      JOIN company_profiles c ON c.id=m.company_id ORDER BY u.name`, [context.user.companyId]);
  }
  if (method === 'POST' && path === '/api/users') {
    if (!context.user.isMaster) throw Object.assign(new Error('Use convites para adicionar pessoas à empresa.'), { statusCode: 403 });
    const requestedUsers = Array.isArray(body.users) && body.users.length ? body.users.slice(0, 20) : [body];
    const normalized = requestedUsers.map(item => ({
      name: String(item.name || '').trim().slice(0, 120),
      email: String(item.email || '').trim().toLowerCase().slice(0, 254),
      password: String(item.password || ''),
      role: ['master', 'admin', 'manager', 'agent'].includes(item.role) ? item.role : 'agent',
      companyId: parseId(item.company_id || context.user.companyId)
    }));
    if (normalized.some(item => item.name.length < 2)) throw Object.assign(new Error('Informe o nome de cada usuário'), { statusCode: 400 });
    if (normalized.some(item => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email))) throw Object.assign(new Error('Informe um e-mail válido para cada usuário'), { statusCode: 400 });
    if (normalized.some(item => item.password.length < 10 || !/[a-z]/.test(item.password) || !/[A-Z]/.test(item.password) || !/\d/.test(item.password))) {
      throw Object.assign(new Error('Cada senha precisa ter 10 caracteres, letra maiúscula, minúscula e número'), { statusCode: 400 });
    }
    if (new Set(normalized.map(item => item.email)).size !== normalized.length) throw Object.assign(new Error('Não repita o mesmo e-mail'), { statusCode: 400 });
    const existingUsers = normalized.map(item => get('SELECT id,is_master FROM users WHERE lower(email)=?', [item.email]));
    if (existingUsers.some(user => user?.is_master)) throw Object.assign(new Error('Um Onboarding Manager não pode ser redefinido por este formulário'), { statusCode: 403 });
    if (existingUsers.some(Boolean) && body.replace_existing !== true) throw Object.assign(new Error('Um dos e-mails já possui acesso. Confirme a redefinição para continuar'), { statusCode: 409 });
    if (normalized.some(item => !get('SELECT id FROM company_profiles WHERE id=?', [item.companyId]))) throw Object.assign(new Error('Selecione uma empresa válida'), { statusCode: 400 });
    const createdIds = transaction(() => normalized.map(item => {
      const existing = get('SELECT id FROM users WHERE lower(email)=?', [item.email]);
      let userId;
      if (existing) {
        userId = Number(existing.id);
        run(`UPDATE users SET name=?,password_hash=?,role=?,avatar=?,status='online',is_active=1,is_master=?,active_company_id=? WHERE id=?`,
          [item.name, hashPassword(item.password), item.role === 'master' ? 'admin' : item.role, item.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase(), item.role === 'master' ? 1 : 0, item.companyId, userId]);
      } else {
        const created = run(`INSERT INTO users (name,email,password_hash,role,avatar,status,is_active,is_master,active_company_id)
          VALUES (?,?,?,?,?,'online',1,?,?)`, [item.name, item.email, hashPassword(item.password), item.role === 'master' ? 'admin' : item.role, item.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase(), item.role === 'master' ? 1 : 0, item.companyId]);
        userId = Number(created.lastInsertRowid);
      }
      run(`INSERT INTO user_company_memberships (company_id,user_id,role,is_active,invited_by)
        VALUES (?,?,?,1,?) ON CONFLICT(company_id,user_id) DO UPDATE SET role=excluded.role,is_active=1,invited_by=excluded.invited_by`, [item.companyId, userId, item.role === 'master' ? 'owner' : item.role, context.user.id]);
      if (existing) run(`INSERT INTO security_events (user_id,event_type,details) VALUES (?, 'admin_access_reset', ?)`, [context.user.id, JSON.stringify({ target_user_id:userId,company_id:item.companyId })]);
      return userId;
    }));
    const createdUsers = createdIds.map(id => get('SELECT id,name,email,role,avatar,status,is_active FROM users WHERE id=?', [id]));
    return requestedUsers.length === 1 ? createdUsers[0] : { users: createdUsers };
  }

  match = path.match(/^\/api\/users\/(\d+)$/);
  if (method === 'PATCH' && match) {
    if (!canAdminCompany(context)) throw Object.assign(new Error('Somente administradores podem alterar permissões.'), { statusCode: 403 });
    const id = parseId(match[1]);
    if (id === context.user.id) throw Object.assign(new Error('Você não pode alterar o próprio acesso por esta tela.'), { statusCode: 400 });
    const target = get('SELECT * FROM users WHERE id=?', [id]);
    if (!target) throw Object.assign(new Error('Usuário não encontrado.'), { statusCode: 404 });
    if (target.is_master && !context.user.isMaster) throw Object.assign(new Error('Somente um Onboarding Manager pode alterar outro Onboarding Manager.'), { statusCode: 403 });
    const role = ['admin', 'manager', 'agent'].includes(body?.role) ? body.role : null;
    const active = body?.is_active === undefined ? null : (body.is_active ? 1 : 0);
    if (role) {
      run('UPDATE users SET role=? WHERE id=?', [role, id]);
      if (context.user.companyId) run('UPDATE user_company_memberships SET role=? WHERE user_id=? AND company_id=?', [role, id, context.user.companyId]);
    }
    if (active !== null) run('UPDATE users SET is_active=? WHERE id=?', [active, id]);
    return get('SELECT id,name,email,role,is_active,is_master FROM users WHERE id=?', [id]);
  }
  if (method === 'DELETE' && match) {
    if (!canAdminCompany(context)) throw Object.assign(new Error('Somente administradores podem remover usuários.'), { statusCode: 403 });
    const id = parseId(match[1]);
    if (id === context.user.id) throw Object.assign(new Error('Você não pode excluir o próprio acesso.'), { statusCode: 400 });
    const target = get('SELECT * FROM users WHERE id=?', [id]);
    if (!target) throw Object.assign(new Error('Usuário não encontrado.'), { statusCode: 404 });
    if (target.is_master && !context.user.isMaster) throw Object.assign(new Error('Somente um Onboarding Manager pode remover outro Onboarding Manager.'), { statusCode: 403 });
    run('DELETE FROM sessions WHERE user_id=?', [id]);
    if (context.user.isMaster) run('DELETE FROM users WHERE id=?', [id]);
    else run('DELETE FROM user_company_memberships WHERE user_id=? AND company_id=?', [id, context.user.companyId]);
    return { deleted: true };
  }

  if (method === 'POST' && path === '/api/webhooks/whatsapp') {
    const outcomes = await processWebhook(body);
    return { received: true, processed: outcomes.length };
  }
  if (method === 'POST' && path === '/api/webhooks/meta-leads') {
    const outcomes=await processMetaLeadWebhook(body);
    return {received:true,processed:outcomes.length,outcomes};
  }
  if (method === 'POST' && path.startsWith('/api/webhooks/evolution/')) {
    const companyId = Number(path.split('/').filter(Boolean).at(-1)) || 1;
    if (!get('SELECT id FROM company_profiles WHERE id=?', [companyId])) throw Object.assign(new Error('Empresa do webhook inválida.'), { statusCode: 404 });
    const outcomes = await processEvolutionWebhook(body, companyId);
    return { received: true, processed: outcomes.length };
  }

  throw Object.assign(new Error('Rota não encontrada'), { statusCode: 404 });
}

export { processMetaLeadWebhook, processWebhook };
