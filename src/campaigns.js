import readXlsxFile from 'read-excel-file/node';
import { all, get, now, run, transaction } from './db.js';
import { sendWhatsAppTemplate } from './whatsapp.js';
import { existingLeadOwner, nextLeadOwner } from './team-routing.js';
import { metaConfig, metaIsConfigured } from './integrations.js';

const MAX_FILE_BYTES = 1_200_000;
const MAX_ROWS = 500;
const activeWorkers = new Set();

function appError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanHeader(value) {
  return String(value ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = []; let field = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') { field += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === delimiter && !quoted) { row.push(field); field = ''; continue; }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.some(cell => String(cell).trim())) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.some(cell => String(cell).trim())) rows.push(row);
  return rows;
}

function canonicalPhone(value) {
  let digits = String(value ?? '').replace(/\.0$/, '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.length < 12 || digits.length > 15) return null;
  return `+${digits}`;
}

function consentValue(value) {
  const normalized = cleanHeader(value);
  if (['sim', 'yes', 'true', '1', 'granted', 'autorizado', 'autorizada', 'opt_in', 'aceito'].includes(normalized)) return 'granted';
  if (['nao', 'no', 'false', '0', 'revoked', 'revogado', 'revogada', 'opt_out', 'recusado'].includes(normalized)) return 'revoked';
  return 'unknown';
}

function findColumn(headers, aliases) {
  return headers.findIndex(header => aliases.includes(header));
}

function variableCount(templateBody = '') {
  return Math.max(0, ...[...String(templateBody).matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1])));
}

export async function parseCampaignFile({ fileName, dataBase64 }) {
  const safeName = String(fileName || '').trim().slice(0, 160);
  if (!safeName || !dataBase64) throw appError('Selecione uma planilha para importar.');
  const buffer = Buffer.from(String(dataBase64), 'base64');
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw appError('A planilha deve ter no máximo 1,2 MB.', 413);
  const extension = safeName.toLowerCase().split('.').pop();
  let matrix;
  if (extension === 'xlsx') matrix = await readXlsxFile(buffer);
  else if (extension === 'csv' || extension === 'tsv') {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const delimiter = extension === 'tsv' ? '\t' : ((firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',');
    matrix = parseCsv(text, delimiter);
  } else throw appError('Formato não aceito. Use .xlsx, .csv ou .tsv.');
  if (matrix.length < 2) throw appError('A planilha precisa ter cabeçalho e pelo menos uma linha de contato.');
  if (matrix.length - 1 > MAX_ROWS) throw appError(`Envie no máximo ${MAX_ROWS} contatos por campanha.`);
  const headers = matrix[0].map(cleanHeader);
  const phoneIndex = findColumn(headers, ['telefone', 'phone', 'celular', 'whatsapp', 'numero']);
  const nameIndex = findColumn(headers, ['nome', 'name', 'contato']);
  const consentIndex = findColumn(headers, ['consentimento', 'consent', 'opt_in', 'autorizacao', 'autorizado']);
  if (phoneIndex < 0) throw appError('Não encontrei a coluna telefone. Use o cabeçalho “telefone”.');
  const variableIndexes = new Map();
  headers.forEach((header, index) => {
    const match = header.match(/^(?:variavel|variable|campo)_(\d+)$/);
    if (match) variableIndexes.set(Number(match[1]), index);
  });
  return {
    fileName: safeName,
    rows: matrix.slice(1).map((cells, index) => ({
      sourceRow: index + 2,
      rawPhone: cells[phoneIndex],
      phone: canonicalPhone(cells[phoneIndex]),
      name: String(nameIndex >= 0 ? cells[nameIndex] ?? '' : '').trim().slice(0, 120),
      consent: consentValue(consentIndex >= 0 ? cells[consentIndex] : ''),
      variables: Object.fromEntries([...variableIndexes].map(([number, cellIndex]) => [number, String(cells[cellIndex] ?? '').trim().slice(0, 500)]))
    }))
  };
}

export async function importCampaign({ name, templateId, fileName, dataBase64, userId, companyId = 1 }) {
  const campaignName = String(name || '').trim().slice(0, 120);
  if (!campaignName) throw appError('Informe o nome da campanha.');
  const template = get("SELECT * FROM message_templates WHERE id=? AND company_id=? AND status='approved'", [Number(templateId), companyId]);
  if (!template) throw appError('Escolha um modelo aprovado pela Meta.');
  const parsed = await parseCampaignFile({ fileName, dataBase64 });
  const requiredVariables = variableCount(template.body);
  const seen = new Set();
  const recipients = parsed.rows.map(row => {
    let status = 'ready'; let reason = null; let contact = null;
    if (!row.phone) { status = 'skipped'; reason = 'Telefone inválido'; }
    else if (seen.has(row.phone)) { status = 'skipped'; reason = 'Duplicado na planilha'; }
    else {
      seen.add(row.phone);
      const digits = row.phone.replace(/\D/g, '');
      contact = get(`SELECT * FROM contacts WHERE company_id=? AND (replace(replace(replace(replace(replace(phone,'+',''),' ',''),'-',''),'(',''),')','')=? OR whatsapp_id=?) LIMIT 1`, [companyId, digits, digits]);
      if (row.consent === 'revoked' || contact?.consent_status === 'revoked') { status = 'skipped'; reason = 'Consentimento revogado'; }
      else if (row.consent !== 'granted' && contact?.consent_status !== 'granted') { status = 'skipped'; reason = 'Consentimento não confirmado'; }
      else {
        for (let number = 1; number <= requiredVariables; number += 1) {
          const fallback = number === 1 ? (row.name || contact?.name || '') : '';
          if (!(row.variables[number] || fallback)) { status = 'skipped'; reason = `Variável ${number} não preenchida`; break; }
        }
      }
    }
    const variables = Array.from({ length: requiredVariables }, (_, index) => row.variables[index + 1] || (index === 0 ? row.name || contact?.name || '' : ''));
    return { ...row, contactId: contact?.id || null, status, reason, variables, consentSource: row.consent === 'granted' ? 'planilha' : 'cadastro' };
  });
  const ready = recipients.filter(item => item.status === 'ready').length;
  const campaignId = transaction(() => {
    const result = run(`INSERT INTO campaigns (company_id,name,template_id,source_file,total_rows,ready_count,skipped_count,created_by)
      VALUES (?,?,?,?,?,?,?,?)`, [companyId, campaignName, template.id, parsed.fileName, recipients.length, ready, recipients.length - ready, userId]);
    const id = Number(result.lastInsertRowid);
    for (const item of recipients) run(`INSERT INTO campaign_recipients
      (campaign_id,contact_id,source_row,phone,name,variables,consent_source,status,skip_reason)
      VALUES (?,?,?,?,?,?,?,?,?)`, [id, item.contactId, item.sourceRow, item.phone, item.name || null, JSON.stringify(item.variables), item.consentSource, item.status, item.reason]);
    return id;
  });
  return campaignDetail(campaignId, companyId);
}

export function campaignList(companyId = 1) {
  return all(`SELECT c.*, t.display_name AS template_name, t.category AS template_category, t.body AS template_body,
    u.name AS created_by_name FROM campaigns c JOIN message_templates t ON t.id=c.template_id
    LEFT JOIN users u ON u.id=c.created_by WHERE c.company_id=? ORDER BY c.id DESC`, [companyId]);
}

export function campaignDetail(id, companyId = null) {
  const campaign = get(`SELECT c.*, t.meta_name, t.display_name AS template_name, t.category AS template_category,
    t.language, t.body AS template_body, t.source AS template_source, u.name AS created_by_name FROM campaigns c
    JOIN message_templates t ON t.id=c.template_id LEFT JOIN users u ON u.id=c.created_by WHERE c.id=? ${companyId ? 'AND c.company_id=?' : ''}`, companyId ? [id, companyId] : [id]);
  if (!campaign) throw appError('Campanha não encontrada.', 404);
  const recipients = all(`SELECT id,source_row,phone,name,status,skip_reason,error,sent_at FROM campaign_recipients
    WHERE campaign_id=? ORDER BY source_row LIMIT 500`, [id]);
  return { campaign, recipients };
}

function ensureContactAndConversation(recipient, companyId) {
  const digits = recipient.phone.replace(/\D/g, '');
  let contact = recipient.contact_id ? get('SELECT * FROM contacts WHERE id=?', [recipient.contact_id]) : null;
  if (!contact) {
    const result = run(`INSERT INTO contacts (company_id,phone,whatsapp_id,name,source,consent_status,updated_at)
      VALUES (?,?,?,?, 'campaign','granted',?)`, [companyId, recipient.phone, digits, recipient.name || 'Contato importado', now()]);
    contact = get('SELECT * FROM contacts WHERE id=?', [Number(result.lastInsertRowid)]);
    run('UPDATE campaign_recipients SET contact_id=? WHERE id=?', [contact.id, recipient.id]);
  } else if (contact.consent_status === 'unknown' && recipient.consent_source === 'planilha') {
    run("UPDATE contacts SET consent_status='granted',updated_at=? WHERE id=?", [now(), contact.id]);
  }
  if (get('SELECT consent_status FROM contacts WHERE id=?', [contact.id])?.consent_status !== 'granted') throw new Error('Contato sem consentimento ativo');
  let conversation = get("SELECT * FROM conversations WHERE contact_id=? AND status!='closed' ORDER BY id DESC LIMIT 1", [contact.id]);
  if (!conversation) {
    const owner = existingLeadOwner(contact.id,companyId) || nextLeadOwner(companyId);
    const result = run("INSERT INTO conversations (contact_id,assigned_to,status,mode,unread_count,last_message_at) VALUES (?,?,'open','human',0,?)", [contact.id, owner?.id || null, now()]);
    conversation = get('SELECT * FROM conversations WHERE id=?', [Number(result.lastInsertRowid)]);
  }
  return { contact, conversation };
}

function renderedTemplate(body, variables) {
  return String(body).replace(/\{\{(\d+)\}\}/g, (_, number) => variables[Number(number) - 1] ?? '');
}

async function processCampaign(campaignId, simulate) {
  if (activeWorkers.has(campaignId)) return;
  activeWorkers.add(campaignId);
  try {
    const campaign = campaignDetail(campaignId).campaign;
    for (const recipient of all("SELECT * FROM campaign_recipients WHERE campaign_id=? AND status IN ('ready','queued') ORDER BY source_row", [campaignId])) {
      if (get('SELECT status FROM campaigns WHERE id=?', [campaignId])?.status !== 'running') break;
      try {
        run("UPDATE campaign_recipients SET status='queued' WHERE id=?", [recipient.id]);
        const { contact, conversation } = ensureContactAndConversation(recipient, campaign.company_id);
        const variables = JSON.parse(recipient.variables || '[]');
        const result = simulate
          ? { simulated: true, id: `campaign-${campaignId}-${recipient.id}`, status: 'sent' }
          : await sendWhatsAppTemplate(recipient.phone.replace(/\D/g, ''), { name: campaign.meta_name, language: campaign.language, variables }, campaign.company_id);
        const content = renderedTemplate(campaign.template_body, variables);
        run(`INSERT INTO messages (conversation_id,whatsapp_message_id,direction,sender_type,content,status,type,metadata)
          VALUES (?,?,'outbound','human',?,'sent','template',?)`, [conversation.id, result.id, content, JSON.stringify({ campaign_id: campaignId, template_id: campaign.template_id, simulated: result.simulated })]);
        run("UPDATE campaign_recipients SET contact_id=?,status='sent',whatsapp_message_id=?,sent_at=? WHERE id=?", [contact.id, result.id, now(), recipient.id]);
        const campaignTag = `Campanha: ${campaign.name}`.slice(0, 40);
        run("INSERT OR IGNORE INTO tag_definitions (name,category,campaign_name) VALUES (?,'campaign',?)", [campaignTag, campaign.name]);
        run('INSERT OR IGNORE INTO contact_tags (contact_id,tag) VALUES (?,?)', [contact.id, campaignTag]);
        run('UPDATE conversations SET last_message_at=?,updated_at=? WHERE id=?', [now(), now(), conversation.id]);
      } catch (error) {
        run("UPDATE campaign_recipients SET status='failed',error=? WHERE id=?", [String(error.message || error).slice(0, 500), recipient.id]);
      }
      run(`UPDATE campaigns SET sent_count=(SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id=? AND status IN ('sent','delivered','read')),
        delivered_count=(SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id=? AND status IN ('delivered','read')),
        read_count=(SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id=? AND status='read'),
        failed_count=(SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id=? AND status='failed') WHERE id=?`, [campaignId, campaignId, campaignId, campaignId, campaignId]);
      const delay = Number(process.env.CAMPAIGN_INTERVAL_MS || 1100);
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(delay, 10_000)));
    }
    if (get('SELECT status FROM campaigns WHERE id=?', [campaignId])?.status === 'running') run("UPDATE campaigns SET status='completed',completed_at=? WHERE id=?", [now(), campaignId]);
  } finally { activeWorkers.delete(campaignId); }
}

export function startCampaign(id, { simulate = false, companyId = null } = {}) {
  const campaign = campaignDetail(id, companyId).campaign;
  if (campaign.status !== 'draft' && campaign.status !== 'paused') throw appError('Esta campanha não pode ser iniciada nesse estado.');
  if (!campaign.ready_count) throw appError('A campanha não tem destinatários válidos.');
  if (!metaIsConfigured(campaign.company_id) && !simulate) throw appError('Conecte a conta oficial do WhatsApp desta empresa antes de iniciar o disparo.');
  if (!simulate && campaign.template_source !== 'meta') throw appError('Sincronize e selecione um modelo aprovado da sua conta Meta antes de enviar.');
  if (simulate && process.env.NODE_ENV === 'production') throw appError('Simulação indisponível em produção.', 403);
  run("UPDATE campaigns SET status='running',started_at=COALESCE(started_at,?) WHERE id=?", [now(), id]);
  setImmediate(() => processCampaign(id, simulate).catch(error => {
    console.error('Falha na campanha:', error);
    run("UPDATE campaigns SET status='failed',completed_at=? WHERE id=?", [now(), id]);
  }));
  return campaignDetail(id, companyId);
}

export function cancelCampaign(id, companyId = null) {
  const campaign = campaignDetail(id, companyId).campaign;
  if (!['draft', 'running', 'paused'].includes(campaign.status)) throw appError('Esta campanha não pode ser cancelada.');
  run("UPDATE campaigns SET status='cancelled',completed_at=? WHERE id=?", [now(), id]);
  return campaignDetail(id, companyId);
}

export function updateCampaignDelivery(externalId, status) {
  const mapped = ['sent', 'delivered', 'read', 'failed'].includes(status) ? status : 'sent';
  const recipient = get('SELECT campaign_id FROM campaign_recipients WHERE whatsapp_message_id=?', [externalId]);
  if (!recipient) return;
  run('UPDATE campaign_recipients SET status=? WHERE whatsapp_message_id=?', [mapped, externalId]);
  run(`UPDATE campaigns SET sent_count=(SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id=? AND status IN ('sent','delivered','read')),
    delivered_count=(SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id=? AND status IN ('delivered','read')),
    read_count=(SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id=? AND status='read'),
    failed_count=(SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id=? AND status='failed') WHERE id=?`, [recipient.campaign_id, recipient.campaign_id, recipient.campaign_id, recipient.campaign_id, recipient.campaign_id]);
}

export function approvedTemplates(companyId = 1) {
  return all("SELECT id,COALESCE(provider_name,meta_name) AS meta_name,display_name,category,language,body,source FROM message_templates WHERE company_id=? AND status='approved' ORDER BY source DESC,display_name", [companyId]);
}

export async function syncApprovedTemplates(companyId = 1) {
  const config = metaConfig(companyId);
  if (!config.accessToken || !config.businessAccountId) throw appError('Conecte a Meta e informe o Business Account ID antes de sincronizar modelos.');
  const fields = 'name,status,category,language,components';
  const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.businessAccountId}/message_templates?status=APPROVED&limit=100&fields=${encodeURIComponent(fields)}`, { headers: { Authorization: `Bearer ${config.accessToken}` } });
  const payload = await response.json();
  if (!response.ok) throw appError(payload?.error?.message || 'Não foi possível sincronizar os modelos da Meta.');
  const templates = (payload.data || []).filter(item => item.status === 'APPROVED');
  transaction(() => {
    run("UPDATE message_templates SET status='draft' WHERE company_id=? AND source='meta'", [companyId]);
    for (const item of templates) {
      const body = item.components?.find(component => component.type === 'BODY')?.text || '';
      const category = ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(item.category) ? item.category.toLowerCase() : 'marketing';
      const providerName=String(item.name).slice(0,160);const storageName=`${companyId}:${providerName}`;
      run(`INSERT INTO message_templates (company_id,meta_name,provider_name,display_name,category,language,body,status,source)
        VALUES (?,?,?,?,?,?,?,'approved','meta') ON CONFLICT(meta_name) DO UPDATE SET provider_name=excluded.provider_name,display_name=excluded.display_name,
        category=excluded.category,language=excluded.language,body=excluded.body,status='approved',source='meta'`,
      [companyId,storageName,providerName,providerName.replace(/_/g, ' ').slice(0, 160), category, item.language || 'pt_BR', body]);
    }
  });
  return { count: templates.length, templates: approvedTemplates(companyId) };
}
