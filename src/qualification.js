import { all, asJson, get, now, run } from './db.js';
import { missingProfileFields, profileLabels } from './lead-profile.js';

const allowedFields = new Set(Object.keys(profileLabels));

export function ensureCompanyQualificationConfig(companyId = 1) {
  const base = get('SELECT * FROM qualification_config WHERE id=1');
  const mqlStage = get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
    WHERE p.company_id=? AND p.kind='sales' AND COALESCE(s.display_name,s.name)='Qualificado' ORDER BY p.is_default DESC,s.local_position LIMIT 1`, [companyId]);
  const sqlStage = get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
    WHERE p.company_id=? AND p.kind='sales' AND COALESCE(s.display_name,s.name) IN ('Demonstração','Proposta') ORDER BY p.is_default DESC,s.local_position LIMIT 1`, [companyId]);
  run(`INSERT OR IGNORE INTO company_qualification_config
    (company_id,mql_stage_id,sql_stage_id,mql_min_score,sql_min_score,required_fields,auto_move)
    VALUES (?,?,?,?,?,?,?)`, [companyId, mqlStage?.id || null, sqlStage?.id || null, base?.mql_min_score ?? 55, base?.sql_min_score ?? 80, base?.required_fields || '["phone","company"]', base?.auto_move ?? 1]);
}

export function qualificationConfig(companyId = 1) {
  ensureCompanyQualificationConfig(companyId);
  const config = get('SELECT * FROM company_qualification_config WHERE company_id=?', [companyId]);
  return { ...config, required_fields: asJson(config?.required_fields, ['phone', 'company']),
    sql_required_fields: asJson(config?.sql_required_fields, ['need', 'timeframe', 'decision_role']) };
}

export function saveQualificationConfig(input, companyId = 1) {
  const mqlScore = Number(input.mql_min_score);
  const sqlScore = Number(input.sql_min_score);
  if (!Number.isFinite(mqlScore) || !Number.isFinite(sqlScore) || mqlScore < 0 || sqlScore > 100 || sqlScore < mqlScore) {
    throw Object.assign(new Error('A pontuação SQL deve ser igual ou maior que a pontuação MQL'), { statusCode: 400 });
  }
  if (!Array.isArray(input.required_fields) || (input.sql_required_fields !== undefined && !Array.isArray(input.sql_required_fields))) {
    throw Object.assign(new Error('Informe os campos de qualificação como listas.'), { statusCode: 400 });
  }
  const requiredFields = [...new Set(input.required_fields.filter(field => allowedFields.has(field)))];
  const sqlRequiredFields = [...new Set((input.sql_required_fields || qualificationConfig(companyId).sql_required_fields).filter(field => allowedFields.has(field)))];
  for (const stageId of [input.mql_stage_id,input.sql_stage_id].filter(Boolean)) {
    const owned = get(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
      WHERE s.id=? AND p.company_id=? AND s.company_id=?`, [Number(stageId),companyId,companyId]);
    if (!owned) throw Object.assign(new Error('A etapa de qualificação não pertence a esta empresa.'), { statusCode: 400 });
  }
  ensureCompanyQualificationConfig(companyId);
  run(`UPDATE company_qualification_config SET mql_stage_id=?,sql_stage_id=?,mql_min_score=?,sql_min_score=?,required_fields=?,sql_required_fields=?,auto_move=?,updated_at=? WHERE company_id=?`,
    [input.mql_stage_id || null, input.sql_stage_id || null, mqlScore, sqlScore, JSON.stringify(requiredFields), JSON.stringify(sqlRequiredFields), input.auto_move ? 1 : 0, now(), companyId]);
  recalculateQualifications(companyId);
  return qualificationConfig(companyId);
}

function reachedStage(contact, stageId) {
  if (!stageId || !contact.pipeline_id) return false;
  const stage = get(`SELECT s.pipeline_id,COALESCE(ps.local_position,s.local_position,s.position) AS position
    FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
    LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=p.company_id
    WHERE s.id=? AND p.company_id=? AND COALESCE(ps.is_visible,1)=1`, [stageId,contact.company_id]);
  return Boolean(stage && stage.pipeline_id === contact.pipeline_id && contact.local_position >= stage.position);
}

export function recalculateContactQualification(contactId) {
  const contact = get(`SELECT ct.*, d.score, d.status AS deal_status, s.pipeline_id,
    COALESCE(ps.local_position,s.local_position,s.position) AS local_position
    FROM contacts ct LEFT JOIN deals d ON d.id=(SELECT id FROM deals WHERE contact_id=ct.id ORDER BY id DESC LIMIT 1)
    LEFT JOIN pipeline_stages s ON s.id=d.stage_id
    LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=ct.company_id WHERE ct.id=?`, [contactId]);
  if (!contact) return null;
  const config = qualificationConfig(contact.company_id || 1);
  let qualification = contact.lifecycle === 'customer' || contact.deal_status === 'won' ? 'customer' : 'lead';
  const complete = missingProfileFields(contact, config.required_fields).length === 0;
  const sqlComplete = missingProfileFields(contact, config.sql_required_fields).length === 0;
  if (qualification !== 'customer' && complete && (Number(contact.score || 0) >= config.mql_min_score || reachedStage(contact,config.mql_stage_id))) qualification = 'mql';
  if (qualification !== 'customer' && complete && sqlComplete && (Number(contact.score || 0) >= config.sql_min_score || reachedStage(contact,config.sql_stage_id))) qualification = 'sql';
  run('UPDATE contacts SET qualification=?,updated_at=? WHERE id=?', [qualification, now(), contactId]);
  return qualification;
}

export function recalculateQualifications(companyId = 1) {
  const contacts = all('SELECT id FROM contacts WHERE company_id=?', [companyId]);
  const totals = { lead: 0, mql: 0, sql: 0, customer: 0 };
  for (const contact of contacts) totals[recalculateContactQualification(contact.id)] += 1;
  return totals;
}
