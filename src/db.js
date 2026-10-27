import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hydrateDatabaseFile } from './remote-snapshot.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
export const databasePath = process.env.DATABASE_PATH || (process.env.VERCEL ? join(process.env.TEMP || '/tmp', 'atenva-preview.db') : join(projectRoot, 'data', 'whatscrm.db'));

mkdirSync(dirname(databasePath), { recursive: true });
await hydrateDatabaseFile(databasePath);

export let db = new DatabaseSync(databasePath);
db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

// Migra bancos criados por versões anteriores sem apagar dados do cliente.
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
const userMigrations = [
  ['password_hash', 'ALTER TABLE users ADD COLUMN password_hash TEXT'],
  ['is_active', 'ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1'],
  ['is_master', 'ALTER TABLE users ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0'],
  ['active_company_id', 'ALTER TABLE users ADD COLUMN active_company_id INTEGER'],
  ['failed_login_count', 'ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0'],
  ['locked_until', 'ALTER TABLE users ADD COLUMN locked_until TEXT'],
  ['last_login_at', 'ALTER TABLE users ADD COLUMN last_login_at TEXT']
];
for (const [column, statement] of userMigrations) {
  if (!userColumns.has(column)) db.exec(statement);
}

const primaryCompanyName = String(process.env.PRIMARY_COMPANY_NAME || 'Atenva').trim().slice(0, 120) || 'Atenva';
const primaryCompanySlug = String(process.env.PRIMARY_COMPANY_SLUG || 'atenva-demo').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'atenva-demo';
db.prepare(`INSERT OR IGNORE INTO company_profiles (id,name,slug,status) VALUES (1,?,?, 'active')`).run(primaryCompanyName, primaryCompanySlug);

function normalizeCanonicalCompanySlugs(database) {
  // Migração de endereço: preserva o mesmo company_id e, portanto, todos os
  // contatos, conversas, funis, tarefas e integrações ligados à Mais Tração.
  const legacy = database.prepare("SELECT id FROM company_profiles WHERE slug='mais-tracao-gestao-de-trafego'").get();
  const canonical = database.prepare("SELECT id FROM company_profiles WHERE slug='mais-tracao'").get();
  if (legacy && !canonical) database.prepare("UPDATE company_profiles SET slug='mais-tracao',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(legacy.id);
}

normalizeCanonicalCompanySlugs(db);
db.prepare(`INSERT OR IGNORE INTO user_company_memberships (company_id,user_id,role,is_active)
  SELECT 1,id,CASE WHEN role='admin' THEN 'owner' ELSE role END,1 FROM users`).run();
db.prepare(`UPDATE users SET active_company_id=1 WHERE active_company_id IS NULL`).run();

function addColumns(table, migrations) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  for (const [column, statement] of migrations) if (!columns.has(column)) db.exec(statement);
}

addColumns('company_profiles', [
  ['plan', "ALTER TABLE company_profiles ADD COLUMN plan TEXT NOT NULL DEFAULT 'business'"],
  ['max_users', 'ALTER TABLE company_profiles ADD COLUMN max_users INTEGER NOT NULL DEFAULT 10'],
  ['trial_ends_at', 'ALTER TABLE company_profiles ADD COLUMN trial_ends_at TEXT']
]);

addColumns('pipeline_stages', [
  ['pipeline_id', 'ALTER TABLE pipeline_stages ADD COLUMN pipeline_id INTEGER REFERENCES pipelines(id)'],
  ['display_name', 'ALTER TABLE pipeline_stages ADD COLUMN display_name TEXT'],
  ['local_position', 'ALTER TABLE pipeline_stages ADD COLUMN local_position INTEGER'],
  ['company_id', 'ALTER TABLE pipeline_stages ADD COLUMN company_id INTEGER REFERENCES company_profiles(id)']
]);
addColumns('deals', [
  ['status', "ALTER TABLE deals ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost'))"],
  ['closed_at', 'ALTER TABLE deals ADD COLUMN closed_at TEXT'],
  ['recovery_strategy', "ALTER TABLE deals ADD COLUMN recovery_strategy TEXT CHECK (recovery_strategy IN ('retomada', 'remarketing', 'arquivar'))"],
  ['source_deal_id', 'ALTER TABLE deals ADD COLUMN source_deal_id INTEGER REFERENCES deals(id)']
]);
addColumns('contacts', [
  ['qualification', "ALTER TABLE contacts ADD COLUMN qualification TEXT NOT NULL DEFAULT 'lead' CHECK (qualification IN ('lead', 'mql', 'sql', 'customer'))"],
  ['profile_picture_url', 'ALTER TABLE contacts ADD COLUMN profile_picture_url TEXT'],
  ['company_id', 'ALTER TABLE contacts ADD COLUMN company_id INTEGER REFERENCES company_profiles(id)'],
  ['organization_id', 'ALTER TABLE contacts ADD COLUMN organization_id INTEGER REFERENCES organizations(id)']
]);
addColumns('organizations', [
  ['phone', 'ALTER TABLE organizations ADD COLUMN phone TEXT'],
  ['email', 'ALTER TABLE organizations ADD COLUMN email TEXT'],
  ['socials', 'ALTER TABLE organizations ADD COLUMN socials TEXT'],
  ['website', 'ALTER TABLE organizations ADD COLUMN website TEXT']
]);
addColumns('message_templates', [
  ['source', "ALTER TABLE message_templates ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'meta'))"],
  ['provider_name', 'ALTER TABLE message_templates ADD COLUMN provider_name TEXT']
]);
addColumns('tasks', [
  ['priority', "ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent'))"],
  ['company_id', 'ALTER TABLE tasks ADD COLUMN company_id INTEGER REFERENCES company_profiles(id)'],
  ['google_event_id', 'ALTER TABLE tasks ADD COLUMN google_event_id TEXT'],
  ['google_calendar_id', 'ALTER TABLE tasks ADD COLUMN google_calendar_id TEXT']
]);
addColumns('knowledge_documents', [
  ['company_id', 'ALTER TABLE knowledge_documents ADD COLUMN company_id INTEGER REFERENCES company_profiles(id)'],
  ['status', "ALTER TABLE knowledge_documents ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived'))"],
  ['version', 'ALTER TABLE knowledge_documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1'],
  ['priority', 'ALTER TABLE knowledge_documents ADD COLUMN priority INTEGER NOT NULL DEFAULT 50'],
  ['is_authoritative', 'ALTER TABLE knowledge_documents ADD COLUMN is_authoritative INTEGER NOT NULL DEFAULT 0'],
  ['updated_by', 'ALTER TABLE knowledge_documents ADD COLUMN updated_by INTEGER REFERENCES users(id)'],
  ['created_at', 'ALTER TABLE knowledge_documents ADD COLUMN created_at TEXT'],
  ['updated_at', 'ALTER TABLE knowledge_documents ADD COLUMN updated_at TEXT']
]);
db.exec("UPDATE knowledge_documents SET created_at=COALESCE(created_at,CURRENT_TIMESTAMP),updated_at=COALESCE(updated_at,created_at,CURRENT_TIMESTAMP)");
addColumns('message_templates', [['company_id', 'ALTER TABLE message_templates ADD COLUMN company_id INTEGER REFERENCES company_profiles(id)']]);
addColumns('campaigns', [['company_id', 'ALTER TABLE campaigns ADD COLUMN company_id INTEGER REFERENCES company_profiles(id)']]);
for (const table of ['contacts','tasks','knowledge_documents','message_templates','campaigns']) db.exec(`UPDATE ${table} SET company_id=1 WHERE company_id IS NULL`);
db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id); CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id); CREATE INDEX IF NOT EXISTS idx_knowledge_company ON knowledge_documents(company_id); CREATE INDEX IF NOT EXISTS idx_campaigns_company ON campaigns(company_id)');

// Normaliza empresas sem apagar o texto legado usado por versões anteriores.
db.exec(`CREATE INDEX IF NOT EXISTS idx_organizations_company ON organizations(company_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_organization ON contacts(organization_id);
  CREATE INDEX IF NOT EXISTS idx_automations_company ON pipeline_automations(company_id);`);
for (const item of db.prepare("SELECT DISTINCT company_id, trim(company) AS name FROM contacts WHERE trim(COALESCE(company,''))<>''").all()) {
  db.prepare('INSERT OR IGNORE INTO organizations(company_id,name) VALUES (?,?)').run(item.company_id || 1, item.name);
}
db.exec(`UPDATE contacts SET organization_id=(SELECT o.id FROM organizations o WHERE o.company_id=contacts.company_id AND lower(o.name)=lower(trim(contacts.company)) LIMIT 1)
  WHERE organization_id IS NULL AND trim(COALESCE(company,''))<>''`);

// Isola os pipelines legados por empresa. A tabela precisa ser reconstruída para
// substituir a antiga unicidade global do nome por unicidade dentro da empresa.
const pipelineColumns = new Set(db.prepare('PRAGMA table_info(pipelines)').all().map(column => column.name));
if (!pipelineColumns.has('company_id')) {
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(`BEGIN;
    CREATE TABLE pipelines_by_company (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL DEFAULT 1 REFERENCES company_profiles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'sales' CHECK (kind IN ('sales', 'customers', 'custom')),
      color TEXT NOT NULL DEFAULT '#246044',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, name)
    );
    INSERT INTO pipelines_by_company (id,company_id,name,kind,color,is_default,created_at)
      SELECT id,1,name,kind,color,is_default,created_at FROM pipelines;
    DROP TABLE pipelines;
    ALTER TABLE pipelines_by_company RENAME TO pipelines;
    CREATE INDEX IF NOT EXISTS idx_pipelines_company ON pipelines(company_id,is_default,id);
    COMMIT;`);
  db.exec('PRAGMA foreign_keys=ON');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_pipelines_company ON pipelines(company_id,is_default,id)');
db.exec('UPDATE pipeline_stages SET company_id=1 WHERE company_id IS NULL');

function cloneCompanyPipelines(companyId, templateCompanyId = 1) {
  if (db.prepare('SELECT 1 FROM pipelines WHERE company_id=? LIMIT 1').get(companyId)) return false;
  const templates = db.prepare('SELECT * FROM pipelines WHERE company_id=? ORDER BY is_default DESC,id').all(templateCompanyId);
  if (!templates.length) return false;
  const pipelineMap = new Map();
  const stageMap = new Map();
  db.exec('BEGIN');
  try {
    let nextPosition = Number(db.prepare('SELECT COALESCE(MAX(position),0) AS value FROM pipeline_stages').get().value);
    for (const pipeline of templates) {
      const created = db.prepare(`INSERT INTO pipelines(company_id,name,kind,color,is_default,created_at)
        VALUES (?,?,?,?,?,?)`).run(companyId,pipeline.name,pipeline.kind,pipeline.color,pipeline.is_default,pipeline.created_at);
      const newPipelineId = Number(created.lastInsertRowid);
      pipelineMap.set(pipeline.id,newPipelineId);
      const stages = db.prepare(`SELECT s.*,COALESCE(ps.display_name,s.display_name,s.name) AS effective_name,
        COALESCE(ps.local_position,s.local_position,s.position) AS effective_position,COALESCE(ps.is_visible,1) AS is_visible
        FROM pipeline_stages s LEFT JOIN pipeline_stage_settings ps ON ps.stage_id=s.id AND ps.company_id=?
        WHERE s.pipeline_id=? ORDER BY effective_position,s.position`).all(companyId,pipeline.id);
      for (const stage of stages) {
        nextPosition += 1;
        const createdStage = db.prepare(`INSERT INTO pipeline_stages
          (name,position,color,probability,is_closed,pipeline_id,display_name,local_position,company_id)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(`${newPipelineId}:${companyId}:${stage.id}`,nextPosition,stage.color,stage.probability,stage.is_closed,newPipelineId,stage.effective_name,stage.effective_position,companyId);
        const newStageId = Number(createdStage.lastInsertRowid);
        stageMap.set(stage.id,newStageId);
        if (!stage.is_visible) db.prepare(`INSERT INTO pipeline_stage_settings(company_id,stage_id,display_name,local_position,is_visible)
          VALUES (?,?,?,?,0)`).run(companyId,newStageId,stage.effective_name,stage.effective_position);
      }
    }

    for (const [oldStageId,newStageId] of stageMap) {
      db.prepare(`UPDATE deals SET stage_id=? WHERE stage_id=? AND contact_id IN
        (SELECT id FROM contacts WHERE company_id=?)`).run(newStageId,oldStageId,companyId);
      db.prepare('UPDATE company_qualification_config SET mql_stage_id=? WHERE company_id=? AND mql_stage_id=?').run(newStageId,companyId,oldStageId);
      db.prepare('UPDATE company_qualification_config SET sql_stage_id=? WHERE company_id=? AND sql_stage_id=?').run(newStageId,companyId,oldStageId);
      db.prepare('UPDATE pipeline_outcome_rules SET target_stage_id=? WHERE company_id=? AND target_stage_id=?').run(newStageId,companyId,oldStageId);
      db.prepare('UPDATE pipeline_automations SET trigger_stage_id=? WHERE company_id=? AND trigger_stage_id=?').run(newStageId,companyId,oldStageId);
      db.prepare('UPDATE pipeline_automations SET target_stage_id=? WHERE company_id=? AND target_stage_id=?').run(newStageId,companyId,oldStageId);
      db.prepare('UPDATE conversation_stage_rules SET stage_id=? WHERE company_id=? AND stage_id=?').run(newStageId,companyId,oldStageId);
    }
    for (const [oldPipelineId,newPipelineId] of pipelineMap) {
      db.prepare('UPDATE pipeline_outcome_rules SET source_pipeline_id=? WHERE company_id=? AND source_pipeline_id=?').run(newPipelineId,companyId,oldPipelineId);
      db.prepare('UPDATE pipeline_automations SET target_pipeline_id=? WHERE company_id=? AND target_pipeline_id=?').run(newPipelineId,companyId,oldPipelineId);
    }
    db.prepare('DELETE FROM pipeline_stage_settings WHERE company_id=? AND stage_id IN (SELECT id FROM pipeline_stages WHERE company_id<>?)').run(companyId,companyId);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Converte, sem apagar dados, o funil único das primeiras versões em dois funis.
let salesPipeline = db.prepare("SELECT id FROM pipelines WHERE company_id=1 AND kind='sales' ORDER BY id LIMIT 1").get();
if (!salesPipeline) {
  const result = db.prepare("INSERT INTO pipelines (company_id,name,kind,color,is_default) VALUES (1,'Vendas','sales','#246044',1)").run();
  salesPipeline = { id: Number(result.lastInsertRowid) };
}
db.prepare('UPDATE pipeline_stages SET pipeline_id=COALESCE(pipeline_id, ?), display_name=COALESCE(display_name, name), local_position=COALESCE(local_position, position)').run(salesPipeline.id);
db.prepare("UPDATE deals SET status='won', closed_at=COALESCE(closed_at, updated_at) WHERE stage_id IN (SELECT id FROM pipeline_stages WHERE COALESCE(display_name,name)='Ganho')").run();

let customerPipeline = db.prepare("SELECT id FROM pipelines WHERE company_id=1 AND kind='customers' ORDER BY id LIMIT 1").get();
if (!customerPipeline) {
  const result = db.prepare("INSERT INTO pipelines (company_id,name,kind,color) VALUES (1,'Clientes','customers','#3C8D68')").run();
  customerPipeline = { id: Number(result.lastInsertRowid) };
  const base = customerPipeline.id * 100;
  const customerStages = [
    ['Onboarding', '#B8F24A', 10], ['Ativo', '#62B98C', 60], ['Expansão', '#246044', 100]
  ];
  customerStages.forEach(([label, color, probability], index) => db.prepare(`INSERT INTO pipeline_stages
    (name, position, color, probability, is_closed, pipeline_id, display_name, local_position, company_id)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1)`).run(`${customerPipeline.id}:${label}`, base + index + 1, color, probability, customerPipeline.id, label, index + 1));
}
const firstCustomerStage = db.prepare('SELECT id FROM pipeline_stages WHERE pipeline_id=? ORDER BY local_position LIMIT 1').get(customerPipeline.id);
if (firstCustomerStage) db.prepare(`UPDATE deals SET stage_id=? WHERE status='won' AND stage_id IN
  (SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.company_id=1 AND p.kind='sales')
  AND contact_id IN (SELECT id FROM contacts WHERE company_id=1)`).run(firstCustomerStage.id);

let recoveryPipeline = db.prepare("SELECT id FROM pipelines WHERE company_id=1 AND lower(name)='retomada' ORDER BY id LIMIT 1").get();
if (!recoveryPipeline) {
  const result = db.prepare("INSERT INTO pipelines (company_id,name,kind,color) VALUES (1,'Retomada','custom','#B8892A')").run();
  recoveryPipeline = { id: Number(result.lastInsertRowid) };
  [['Entrada','#D8A636',15],['Em contato','#C27D2C',45],['Reativado','#3C8D68',85]].forEach(([label,color,probability],index) => db.prepare(`INSERT INTO pipeline_stages
    (name,position,color,probability,is_closed,pipeline_id,display_name,local_position,company_id) VALUES (?,?,?,?,0,?,?,?,1)`).run(`${recoveryPipeline.id}:${label}`,recoveryPipeline.id*100+index+1,color,probability,recoveryPipeline.id,label,index+1));
}

for (const company of db.prepare('SELECT id FROM company_profiles WHERE id<>1 ORDER BY id').all()) cloneCompanyPipelines(company.id);

for (const reason of ['Preço', 'Sem retorno', 'Concorrente', 'Sem prioridade', 'Produto não atende', 'Outro']) {
  db.prepare('INSERT OR IGNORE INTO loss_reasons (name) VALUES (?)').run(reason);
}
db.exec(`INSERT OR IGNORE INTO tag_definitions (name, category, campaign_name)
  SELECT DISTINCT tag, CASE WHEN lower(tag) IN ('inbound','google ads','meta ads') THEN 'campaign' ELSE 'manual' END,
    CASE WHEN lower(tag) IN ('inbound','google ads','meta ads') THEN tag ELSE NULL END
  FROM contact_tags`);

const mqlStage = db.prepare(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
  WHERE p.company_id=1 AND p.kind='sales' AND COALESCE(s.display_name,s.name)='Qualificado' LIMIT 1`).get();
const sqlStage = db.prepare(`SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
  WHERE p.company_id=1 AND p.kind='sales' AND COALESCE(s.display_name,s.name) IN ('Demonstração','Proposta') ORDER BY s.local_position LIMIT 1`).get();
db.prepare(`INSERT OR IGNORE INTO qualification_config (id,mql_stage_id,sql_stage_id) VALUES (1,?,?)`).run(mqlStage?.id || null, sqlStage?.id || null);
db.prepare(`INSERT OR IGNORE INTO company_agent_config
  (company_id,name,company_name,tone,objective,autonomy_level,confidence_threshold,max_tool_steps,business_hours,handoff_rules,followup_rules,updated_at)
  SELECT 1,name,company_name,tone,objective,autonomy_level,confidence_threshold,max_tool_steps,business_hours,handoff_rules,followup_rules,updated_at FROM agent_config WHERE id=1`).run();
db.prepare(`INSERT OR IGNORE INTO company_qualification_config
  (company_id,mql_stage_id,sql_stage_id,mql_min_score,sql_min_score,required_fields,auto_move,updated_at)
  SELECT 1,mql_stage_id,sql_stage_id,mql_min_score,sql_min_score,required_fields,auto_move,updated_at FROM qualification_config WHERE id=1`).run();
db.prepare(`INSERT OR IGNORE INTO company_meta_metrics_daily
  (company_id,date,conversations_started,messages_sent,messages_delivered,messages_read,messages_received,spend_cents,updated_at)
  SELECT 1,date,conversations_started,messages_sent,messages_delivered,messages_read,messages_received,spend_cents,updated_at FROM meta_metrics_daily`).run();
db.prepare("UPDATE contacts SET qualification='customer' WHERE lifecycle='customer'").run();
db.prepare("UPDATE agent_config SET company_name='Atenva' WHERE company_name='Verde CRM'").run();
db.prepare("UPDATE agent_config SET name='Atenva' WHERE name IN ('Nia','Nina')").run();
db.prepare("UPDATE company_agent_config SET company_name=(SELECT name FROM company_profiles WHERE id=company_id) WHERE company_name IN ('Verde CRM','Green CRM')").run();
db.prepare("UPDATE company_agent_config SET name='Atenva' WHERE name IN ('Nia','Nina')").run();
db.prepare("UPDATE knowledge_documents SET content=replace(content, 'Verde CRM', 'Atenva') WHERE content LIKE '%Verde CRM%'").run();

function invoke(statement, method, params) {
  if (Array.isArray(params)) return statement[method](...params);
  return statement[method](params);
}

export function all(sql, params = {}) {
  return invoke(db.prepare(sql), 'all', params);
}

export function get(sql, params = {}) {
  return invoke(db.prepare(sql), 'get', params);
}

export function run(sql, params = {}) {
  return invoke(db.prepare(sql), 'run', params);
}

export function transaction(callback) {
  db.exec('BEGIN');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function asJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function now() {
  return new Date().toISOString();
}

export function ensureCompanyPipelines(companyId, templateCompanyId = 1) {
  cloneCompanyPipelines(Number(companyId), Number(templateCompanyId));
  return db.prepare('SELECT * FROM pipelines WHERE company_id=? ORDER BY is_default DESC,id').all(Number(companyId));
}

export function closeDatabase() {
  db.close();
}

export async function reloadDatabaseFromSnapshot(leaseToken = '') {
  if (!process.env.SUPABASE_SNAPSHOT_URL) return false;
  db.close();
  try {
    const hydrated = await hydrateDatabaseFile(databasePath, leaseToken);
    db = new DatabaseSync(databasePath);
    db.exec('PRAGMA foreign_keys=ON');
    normalizeCanonicalCompanySlugs(db);
    return hydrated;
  } catch (error) {
    db = new DatabaseSync(databasePath);
    db.exec('PRAGMA foreign_keys=ON');
    throw error;
  }
}
