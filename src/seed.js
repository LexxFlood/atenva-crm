import { db, get } from './db.js';

function insert(sql, params = {}) {
  const statement = db.prepare(sql);
  const result = Array.isArray(params) ? statement.run(...params) : statement.run(params);
  return Number(result.lastInsertRowid);
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

function seed() {
  if (get('SELECT COUNT(*) AS count FROM users').count > 0) return false;

  db.exec('BEGIN');
  try {
    const ana = insert(`INSERT INTO users (name, email, role, avatar, status)
      VALUES ('Ana Martins', 'ana@verdecrm.local', 'manager', 'AM', 'online')`);
    const lucas = insert(`INSERT INTO users (name, email, role, avatar, status)
      VALUES ('Lucas Ribeiro', 'lucas@verdecrm.local', 'agent', 'LR', 'online')`);

    const salesPipeline = get("SELECT id FROM pipelines WHERE company_id=1 AND kind='sales' ORDER BY id LIMIT 1").id;

    const stages = [
      ['Novo lead', 1, '#B8F24A', 10, 0],
      ['Qualificado', 2, '#83D475', 35, 0],
      ['Demonstração', 3, '#62B98C', 60, 0],
      ['Proposta', 4, '#3C8D68', 80, 0],
      ['Ganho', 5, '#246044', 100, 1]
    ].map(([name, position, color, probability, closed]) => insert(
      `INSERT INTO pipeline_stages (name, position, color, probability, is_closed, pipeline_id, display_name, local_position, company_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`, [name, position, color, probability, closed, salesPipeline, name, position]
    ));
    db.prepare('UPDATE qualification_config SET mql_stage_id=?, sql_stage_id=? WHERE id=1').run(stages[1], stages[2]);

    const people = [
      { name: 'Marina Costa', phone: '+5511998124401', email: 'marina@lumina.com', company: 'Clínica Lumina', segment: 'Saúde', location: 'São Paulo, SP', stage: 2, value: 780000, score: 86, owner: ana, status: 'open', mode: 'autopilot', priority: 'high', intent: 'Solicitar demonstração', sentiment: 'positive', ago: 0.08, unread: 2, summary: 'Procura uma solução para organizar o atendimento de uma clínica com 8 profissionais.', next: 'Confirmar demonstração para amanhã às 14h.', tags: ['Quente', 'Saúde'] },
      { name: 'Rafael Mendes', phone: '+5511987203350', email: 'rafael@norte.arq.br', company: 'Norte Arquitetura', segment: 'Serviços', location: 'Campinas, SP', stage: 1, value: 420000, score: 68, owner: lucas, status: 'open', mode: 'copilot', priority: 'normal', intent: 'Comparar planos', sentiment: 'neutral', ago: 0.7, unread: 0, summary: 'Quer centralizar os leads do WhatsApp de uma equipe comercial pequena.', next: 'Responder sobre integração com agenda.', tags: ['Inbound'] },
      { name: 'Beatriz Oliveira', phone: '+5521998337744', email: 'bia@casaio.com', company: 'Casa Iô', segment: 'Varejo', location: 'Rio de Janeiro, RJ', stage: 3, value: 1290000, score: 91, owner: ana, status: 'waiting', mode: 'autopilot', priority: 'high', intent: 'Negociar proposta', sentiment: 'positive', ago: 3.2, unread: 0, summary: 'Participou da demonstração e pediu uma proposta para 15 utilizadores.', next: 'Enviar proposta aprovada.', tags: ['Quente', 'Varejo'] },
      { name: 'Pedro Lima', phone: '+5531999452266', email: 'pedro@oficina62.com', company: 'Oficina 62', segment: 'Automotivo', location: 'Belo Horizonte, MG', stage: 0, value: 240000, score: 42, owner: lucas, status: 'open', mode: 'autopilot', priority: 'normal', intent: 'Entender produto', sentiment: 'neutral', ago: 5.5, unread: 1, summary: 'Primeiro contacto; ainda não informou tamanho da equipe.', next: 'Perguntar quantas pessoas atendem pelo WhatsApp.', tags: ['Novo'] },
      { name: 'Camila Duarte', phone: '+5548997211188', email: 'camila@atlantic.fit', company: 'Atlantic Fit', segment: 'Fitness', location: 'Florianópolis, SC', stage: 3, value: 960000, score: 74, owner: ana, status: 'open', mode: 'human', priority: 'urgent', intent: 'Solicitar desconto', sentiment: 'negative', ago: 8.4, unread: 1, summary: 'Gostou da proposta, mas pediu desconto de 15%. O agente transferiu para humano.', next: 'Ana deve analisar condição comercial.', tags: ['Humano', 'Proposta'] },
      { name: 'João Vitor', phone: '+5585998130077', email: 'joao@solaris.eng.br', company: 'Solaris Engenharia', segment: 'Engenharia', location: 'Fortaleza, CE', stage: 4, value: 1480000, score: 100, owner: lucas, status: 'closed', mode: 'autopilot', priority: 'low', intent: 'Cliente convertido', sentiment: 'positive', ago: 26, unread: 0, summary: 'Contrato confirmado após demonstração e proposta.', next: 'Iniciar onboarding.', tags: ['Cliente'] }
    ];

    for (const [index, person] of people.entries()) {
      const contact = insert(`INSERT INTO contacts
        (whatsapp_id, phone, name, email, company, segment, location, consent_status, last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'granted', ?, ?, ?)`,
        [`demo-${index + 1}`, person.phone, person.name, person.email, person.company, person.segment,
          person.location, hoursAgo(person.ago), hoursAgo(120 + index * 15), hoursAgo(person.ago)]);

      for (const tag of person.tags) {
        db.prepare('INSERT INTO contact_tags (contact_id, tag) VALUES (?, ?)').run(contact, tag);
        db.prepare(`INSERT OR IGNORE INTO tag_definitions (name, category, campaign_name)
          VALUES (?, ?, ?)`).run(tag, ['Inbound'].includes(tag) ? 'campaign' : 'manual', tag === 'Inbound' ? 'Inbound orgânico' : null);
      }

      const conversation = insert(`INSERT INTO conversations
        (contact_id, assigned_to, status, mode, priority, intent, sentiment, summary, next_action,
         customer_window_until, unread_count, last_message_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [contact, person.owner, person.status, person.mode, person.priority, person.intent, person.sentiment,
          person.summary, person.next, hoursFromNow(Math.max(0, 24 - person.ago)), person.unread,
          hoursAgo(person.ago), hoursAgo(120 + index * 15), hoursAgo(person.ago)]);

      insert(`INSERT INTO deals
        (contact_id, stage_id, owner_id, title, value_cents, score, expected_close_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [contact, stages[person.stage], person.owner, `${person.company} · Plano Business`, person.value,
          person.score, hoursFromNow(24 * (4 + index * 3)), hoursAgo(96 + index * 8), hoursAgo(person.ago)]);

      const greeting = index === 0
        ? 'Olá! Vi o CRM de vocês e queria entender se funciona para uma clínica.'
        : index === 4
          ? 'Gostei da proposta, mas para fecharmos preciso de 15% de desconto.'
          : `Olá, gostaria de saber mais sobre o sistema para a ${person.company}.`;
      const triggerMessage = insert(`INSERT INTO messages
        (conversation_id, whatsapp_message_id, direction, sender_type, type, content, status, created_at)
        VALUES (?, ?, 'inbound', 'contact', 'text', ?, 'read', ?)`,
        [conversation, `demo-in-${index + 1}`, greeting, hoursAgo(person.ago + 0.2)]);

      if (index !== 4) {
        insert(`INSERT INTO messages
          (conversation_id, direction, sender_type, type, content, status, metadata, created_at)
          VALUES (?, 'outbound', 'ai', 'text', ?, 'delivered', ?, ?)`,
          [conversation,
            index === 0
              ? 'Olá, Marina! Funciona sim. Para recomendar a configuração certa, quantas pessoas atendem os pacientes pelo WhatsApp?'
              : `Olá, ${person.name.split(' ')[0]}! Vou ajudar. Pode me contar qual é o principal desafio da equipe hoje?`,
            JSON.stringify({ confidence: 0.91, run_type: 'autonomous' }), hoursAgo(person.ago + 0.12)]);
      }

      if (index === 0) {
        insert(`INSERT INTO messages
          (conversation_id, whatsapp_message_id, direction, sender_type, content, status, created_at)
          VALUES (?, 'demo-in-1b', 'inbound', 'contact', 'Somos 8 pessoas. Gostaria de ver uma demonstração amanhã à tarde.', 'received', ?)`,
          [conversation, hoursAgo(person.ago)]);
      }

      const runStatus = index === 4 ? 'handoff' : 'completed';
      const demoRun = insert(`INSERT INTO agent_runs
        (conversation_id, trigger_message_id, status, intent, confidence, reasoning_summary, action_count, duration_ms, completed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [conversation, triggerMessage, runStatus, person.intent.toLowerCase().replaceAll(' ', '_'), index === 4 ? 0.94 : 0.89,
          index === 4 ? 'Pedido de desconto fora da política; transferência humana acionada.' : 'Intenção identificada e contexto comercial atualizado.',
          index === 4 ? 1 : 2, 480 + index * 37, hoursAgo(person.ago + 0.1), hoursAgo(person.ago + 0.15)]);
      db.prepare(`INSERT INTO tool_calls (run_id, tool_name, arguments, result, status, completed_at)
        VALUES (?, ?, '{}', ?, 'completed', ?)`).run(demoRun, index === 4 ? 'transferir_para_humano' : 'consultar_conhecimento', JSON.stringify({ demo: true }), hoursAgo(person.ago + 0.1));
      if (index !== 4) {
        db.prepare(`INSERT INTO tool_calls (run_id, tool_name, arguments, result, status, completed_at)
          VALUES (?, 'criar_ou_atualizar_oportunidade', '{}', ?, 'completed', ?)`).run(demoRun, JSON.stringify({ demo: true }), hoursAgo(person.ago + 0.1));
      }

      insert(`INSERT INTO activities
        (contact_id, conversation_id, actor_type, action, description, created_at)
        VALUES (?, ?, 'ai', 'lead_qualified', ?, ?)`,
        [contact, conversation, person.summary, hoursAgo(person.ago + 0.05)]);
    }

    const docs = [
      ['Planos e preços', 'Comercial', 'Plano Essencial: R$ 249/mês para até 3 utilizadores. Plano Business: R$ 649/mês para até 10 utilizadores. Plano Scale: preço personalizado acima de 10 utilizadores. Todos os preços são mensais. Descontos acima de 5% exigem aprovação humana.'],
      ['Como funciona o produto', 'Produto', 'A Atenva centraliza conversas do WhatsApp, organiza contatos e oportunidades no pipeline, permite atendimento compartilhado e utiliza IA para qualificar leads, responder dúvidas e agendar reuniões.'],
      ['Demonstração', 'Comercial', 'A demonstração dura 25 minutos e ocorre por videochamada. Horários disponíveis em dias úteis entre 9h e 18h. A marcação precisa ser confirmada pelo cliente antes de ser criada.'],
      ['Política de atendimento', 'Políticas', 'O agente deve transferir para humano quando houver pedido explícito, reclamação, solicitação de desconto acima de 5%, questão jurídica ou confiança inferior a 72%. Nunca inventar preços ou prazos.']
    ];
    for (const [title, category, content] of docs) {
      db.prepare(`INSERT INTO knowledge_documents (title, category, content, updated_by)
        VALUES (?, ?, ?, ?)`).run(title, category, content, ana);
    }

    db.prepare(`INSERT INTO agent_config (id, name, company_name, autonomy_level) VALUES (1, 'Atenva', 'Atenva', 2)`).run();

    const templates = [
      ['followup_demo', 'Lembrete de demonstração', 'utility', 'Olá, {{1}}! Passando para confirmar nossa demonstração em {{2}}.'],
      ['retomar_interesse', 'Retomar interesse', 'marketing', 'Olá, {{1}}! Posso continuar a ajudar com a solução para sua equipe?']
    ];
    for (const [name, display, category, body] of templates) {
      db.prepare(`INSERT INTO message_templates (meta_name, display_name, category, body, status)
        VALUES (?, ?, ?, ?, 'approved')`).run(name, display, category, body);
    }

    const firstConversation = get('SELECT id FROM conversations ORDER BY id LIMIT 1').id;
    db.prepare(`INSERT INTO tasks (conversation_id, contact_id, assigned_to, title, description, due_at, type)
      SELECT c.id, c.contact_id, c.assigned_to, 'Confirmar demonstração', 'Cliente prefere amanhã à tarde.', ?, 'meeting'
      FROM conversations c WHERE c.id = ?`).run(hoursFromNow(3), firstConversation);

    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
      const index = 7 - offset;
      db.prepare(`INSERT OR IGNORE INTO meta_metrics_daily
        (date, conversations_started, messages_sent, messages_delivered, messages_read, messages_received, spend_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(date, 8 + index * 2, 24 + index * 4, 22 + index * 4, 17 + index * 3, 19 + index * 3, 1200 + index * 135);
    }

    for (const item of db.prepare("SELECT DISTINCT company_id,trim(company) AS name FROM contacts WHERE trim(COALESCE(company,''))<>''").all()) {
      db.prepare('INSERT OR IGNORE INTO organizations(company_id,name) VALUES (?,?)').run(item.company_id || 1,item.name);
    }
    db.exec(`UPDATE contacts SET organization_id=(SELECT o.id FROM organizations o WHERE o.company_id=contacts.company_id AND lower(o.name)=lower(trim(contacts.company)) LIMIT 1)
      WHERE organization_id IS NULL AND trim(COALESCE(company,''))<>''`);

    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const created = seed();
if (process.argv[1]?.endsWith('seed.js')) {
  console.log(created ? 'Banco criado com dados de demonstração.' : 'Banco já possui dados; seed ignorado.');
}

export { seed };
