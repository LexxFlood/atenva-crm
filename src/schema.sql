PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'manager', 'agent')),
  avatar TEXT,
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'away', 'offline')),
  is_active INTEGER NOT NULL DEFAULT 1,
  is_master INTEGER NOT NULL DEFAULT 0,
  active_company_id INTEGER,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_profiles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'suspended', 'cancelled')),
  plan TEXT NOT NULL DEFAULT 'business' CHECK (plan IN ('starter', 'business', 'scale')),
  max_users INTEGER NOT NULL DEFAULT 10,
  trial_ends_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_company_memberships (
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('owner', 'admin', 'manager', 'agent')),
  is_active INTEGER NOT NULL DEFAULT 1,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_invitations (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('master', 'admin', 'manager', 'agent')),
  company_id INTEGER REFERENCES company_profiles(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  invited_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_invitations_email ON user_invitations(email, expires_at);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON user_company_memberships(user_id, is_active);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  csrf_token TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  ip_hash TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES company_profiles(id) ON DELETE CASCADE,
  whatsapp_id TEXT UNIQUE,
  phone TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT 'Novo contato',
  email TEXT,
  company TEXT,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  segment TEXT,
  location TEXT,
  profile_picture_url TEXT,
  source TEXT NOT NULL DEFAULT 'whatsapp',
  lifecycle TEXT NOT NULL DEFAULT 'lead' CHECK (lifecycle IN ('lead', 'customer', 'inactive')),
  qualification TEXT NOT NULL DEFAULT 'lead' CHECK (qualification IN ('lead', 'mql', 'sql', 'customer')),
  consent_status TEXT NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown', 'granted', 'revoked')),
  notes TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (contact_id, tag)
);

CREATE TABLE IF NOT EXISTS pipelines (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES company_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sales' CHECK (kind IN ('sales', 'customers', 'custom')),
  color TEXT NOT NULL DEFAULT '#246044',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  position INTEGER UNIQUE NOT NULL,
  color TEXT NOT NULL,
  probability INTEGER NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  is_closed INTEGER NOT NULL DEFAULT 0,
  pipeline_id INTEGER REFERENCES pipelines(id),
  display_name TEXT,
  local_position INTEGER,
  company_id INTEGER REFERENCES company_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pipeline_stage_settings (
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  stage_id INTEGER NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  local_position INTEGER NOT NULL,
  is_visible INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, stage_id)
);

CREATE TABLE IF NOT EXISTS pipeline_outcome_rules (
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  source_pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('won','lost')),
  target_stage_id INTEGER NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, source_pipeline_id, outcome)
);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  stage_id INTEGER NOT NULL REFERENCES pipeline_stages(id),
  owner_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  value_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  score INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  expected_close_at TEXT,
  lost_reason TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  closed_at TEXT,
  recovery_strategy TEXT CHECK (recovery_strategy IN ('retomada', 'remarketing', 'arquivar')),
  source_deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS loss_reasons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#B65353',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tag_definitions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#DFF3B8',
  category TEXT NOT NULL DEFAULT 'manual' CHECK (category IN ('stage', 'campaign', 'manual')),
  stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  campaign_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  assigned_to INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'snoozed', 'closed')),
  mode TEXT NOT NULL DEFAULT 'autopilot' CHECK (mode IN ('autopilot', 'copilot', 'human')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  intent TEXT,
  sentiment TEXT NOT NULL DEFAULT 'neutral' CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  summary TEXT,
  next_action TEXT,
  customer_window_until TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  whatsapp_message_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('contact', 'ai', 'human', 'system')),
  sender_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'received', 'failed')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('ai', 'human', 'system')),
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES company_profiles(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  assigned_to INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  due_at TEXT,
  type TEXT NOT NULL DEFAULT 'followup',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_by TEXT NOT NULL DEFAULT 'ai' CHECK (created_by IN ('ai', 'human', 'system')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
  ,google_event_id TEXT
  ,google_calendar_id TEXT
);

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES company_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain TEXT,
  segment TEXT,
  phone TEXT,
  email TEXT,
  socials TEXT,
  website TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS pipeline_automations (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES company_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('stage_entered', 'deal_won', 'deal_lost')),
  trigger_stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  target_pipeline_id INTEGER REFERENCES pipelines(id) ON DELETE CASCADE,
  target_stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL DEFAULT 'move_deal' CHECK (action_type IN ('move_deal', 'create_followup', 'create_task', 'add_tag')),
  action_value TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_stage_rules (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  stage_id INTEGER NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  trigger_phrases TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, stage_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_stage_rules_company ON conversation_stage_rules(company_id,stage_id,is_active);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES company_profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  is_authoritative INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_learning_rules (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  instruction TEXT NOT NULL,
  applies_to TEXT NOT NULL DEFAULT 'Toda a jornada comercial',
  example_question TEXT,
  original_response TEXT,
  corrected_response TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'preview', 'conversation')),
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_learning_company ON agent_learning_rules(company_id,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_command_sessions (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Nova sessão',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_command_messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES agent_command_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_action_proposals (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES agent_command_sessions(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES agent_command_messages(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('update_agent_config','add_learning_rule','add_knowledge','create_task')),
  label TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','failed')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  applied_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_command_sessions_company ON agent_command_sessions(company_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_command_messages_session ON agent_command_messages(session_id,id);
CREATE INDEX IF NOT EXISTS idx_agent_action_proposals_session ON agent_action_proposals(session_id,status,id);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  title,
  content,
  content='knowledge_documents',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_documents BEGIN
  INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_documents BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_documents BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
  INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TABLE IF NOT EXISTS agent_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'Atenva',
  company_name TEXT NOT NULL DEFAULT 'Atenva',
  tone TEXT NOT NULL DEFAULT 'claro, acolhedor e objetivo',
  objective TEXT NOT NULL DEFAULT 'qualificar leads e agendar demonstrações',
  autonomy_level INTEGER NOT NULL DEFAULT 2 CHECK (autonomy_level BETWEEN 0 AND 3),
  confidence_threshold REAL NOT NULL DEFAULT 0.72,
  max_tool_steps INTEGER NOT NULL DEFAULT 5,
  business_hours TEXT NOT NULL DEFAULT '{"timezone":"America/Sao_Paulo","weekdays":[1,2,3,4,5],"start":"09:00","end":"18:00"}',
  handoff_rules TEXT NOT NULL DEFAULT '["pedido_humano","baixa_confianca","reclamacao","desconto","erro_ferramenta"]',
  followup_rules TEXT NOT NULL DEFAULT '{"enabled":true,"delays_hours":[24,72],"max_attempts":2}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  trigger_message_id INTEGER REFERENCES messages(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'handoff', 'failed')),
  intent TEXT,
  confidence REAL,
  reasoning_summary TEXT,
  action_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'blocked', 'failed')),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES company_profiles(id) ON DELETE CASCADE,
  meta_name TEXT UNIQUE NOT NULL,
  provider_name TEXT,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('marketing', 'utility', 'authentication')),
  language TEXT NOT NULL DEFAULT 'pt_BR',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'meta')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES message_templates(id),
  send_at TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled', 'failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inbound_agent_jobs (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TEXT,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_due ON inbound_agent_jobs(status,next_attempt_at);

CREATE TABLE IF NOT EXISTS automation_health (
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_run_at TEXT,
  result TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS contact_attribution_events (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('first_touch','touch','conversion','stage_change','outcome')),
  source TEXT,
  medium TEXT,
  campaign TEXT,
  content TEXT,
  referrer TEXT,
  destination TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attribution_contact ON contact_attribution_events(company_id,contact_id,occurred_at);

CREATE TABLE IF NOT EXISTS relationship_cadences (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  audience_filter TEXT NOT NULL DEFAULT '{}',
  stop_on_reply INTEGER NOT NULL DEFAULT 1,
  stop_on_outcome INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS relationship_cadence_steps (
  id INTEGER PRIMARY KEY,
  cadence_id INTEGER NOT NULL REFERENCES relationship_cadences(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  delay_hours INTEGER NOT NULL DEFAULT 0,
  action_type TEXT NOT NULL CHECK (action_type IN ('whatsapp','task')),
  template_id INTEGER REFERENCES message_templates(id) ON DELETE SET NULL,
  message TEXT,
  task_title TEXT,
  task_description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cadence_id,position)
);

CREATE TABLE IF NOT EXISTS relationship_cadence_enrollments (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  cadence_id INTEGER NOT NULL REFERENCES relationship_cadences(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','stopped','failed')),
  current_step INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  stop_reason TEXT,
  enrolled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cadence_active_contact ON relationship_cadence_enrollments(cadence_id,contact_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_cadence_due ON relationship_cadence_enrollments(company_id,status,next_run_at);

CREATE TABLE IF NOT EXISTS relationship_cadence_runs (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES relationship_cadence_enrollments(id) ON DELETE CASCADE,
  step_id INTEGER REFERENCES relationship_cadence_steps(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','created','failed','skipped')),
  scheduled_at TEXT,
  executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  external_id TEXT,
  error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT 1 REFERENCES company_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template_id INTEGER NOT NULL REFERENCES message_templates(id),
  source_file TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'paused', 'completed', 'cancelled', 'failed')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  source_row INTEGER NOT NULL,
  phone TEXT,
  name TEXT,
  variables TEXT NOT NULL DEFAULT '[]',
  consent_source TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  skip_reason TEXT,
  whatsapp_message_id TEXT,
  error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(campaign_id, source_row)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON campaign_recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_message ON campaign_recipients(whatsapp_message_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT UNIQUE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS meta_metrics_daily (
  date TEXT PRIMARY KEY,
  conversations_started INTEGER NOT NULL DEFAULT 0,
  messages_sent INTEGER NOT NULL DEFAULT 0,
  messages_delivered INTEGER NOT NULL DEFAULT 0,
  messages_read INTEGER NOT NULL DEFAULT 0,
  messages_received INTEGER NOT NULL DEFAULT 0,
  spend_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_meta_metrics_daily (
  company_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  conversations_started INTEGER NOT NULL DEFAULT 0,
  messages_sent INTEGER NOT NULL DEFAULT 0,
  messages_delivered INTEGER NOT NULL DEFAULT 0,
  messages_read INTEGER NOT NULL DEFAULT 0,
  messages_received INTEGER NOT NULL DEFAULT 0,
  spend_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(company_id,date)
);

CREATE TABLE IF NOT EXISTS qualification_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mql_stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  sql_stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  mql_min_score INTEGER NOT NULL DEFAULT 55 CHECK (mql_min_score BETWEEN 0 AND 100),
  sql_min_score INTEGER NOT NULL DEFAULT 80 CHECK (sql_min_score BETWEEN 0 AND 100),
  required_fields TEXT NOT NULL DEFAULT '["phone","company"]',
  auto_move INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_agent_config (
  company_id INTEGER PRIMARY KEY REFERENCES company_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Atenva',
  company_name TEXT NOT NULL DEFAULT 'Atenva',
  tone TEXT NOT NULL DEFAULT 'claro, acolhedor e objetivo',
  objective TEXT NOT NULL DEFAULT 'qualificar leads e agendar demonstrações',
  autonomy_level INTEGER NOT NULL DEFAULT 2 CHECK (autonomy_level BETWEEN 0 AND 3),
  confidence_threshold REAL NOT NULL DEFAULT 0.72,
  max_tool_steps INTEGER NOT NULL DEFAULT 5,
  business_hours TEXT NOT NULL DEFAULT '{"timezone":"America/Sao_Paulo","weekdays":[1,2,3,4,5],"start":"09:00","end":"18:00"}',
  handoff_rules TEXT NOT NULL DEFAULT '["pedido_humano","baixa_confianca","reclamacao","desconto","erro_ferramenta"]',
  followup_rules TEXT NOT NULL DEFAULT '{"enabled":true,"delays_hours":[24,72],"max_attempts":2}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_qualification_config (
  company_id INTEGER PRIMARY KEY REFERENCES company_profiles(id) ON DELETE CASCADE,
  mql_stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  sql_stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  mql_min_score INTEGER NOT NULL DEFAULT 55 CHECK (mql_min_score BETWEEN 0 AND 100),
  sql_min_score INTEGER NOT NULL DEFAULT 80 CHECK (sql_min_score BETWEEN 0 AND 100),
  required_fields TEXT NOT NULL DEFAULT '["phone","company"]',
  sql_required_fields TEXT NOT NULL DEFAULT '["need","timeframe","decision_role"]',
  auto_move INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
