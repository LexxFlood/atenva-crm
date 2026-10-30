import { asJson, get, now, run } from './db.js';

export const profileLabels = {
  phone: 'telefone', email: 'e-mail', company: 'empresa', segment: 'segmento', location: 'cidade',
  name: 'nome', need: 'necessidade', budget: 'orçamento', timeframe: 'prazo', decision_role: 'participação na decisão'
};
const directFields = new Set(['name', 'email', 'company', 'segment', 'location']);
const commercialFields = new Set(['need', 'budget', 'timeframe', 'decision_role']);
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function validProfileValue(field, value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > 300 || /^(?:n[aã]o sei|n[aã]o informado|indefinido|null|undefined|n\/a|teste)$/i.test(text)) return false;
  if (field === 'phone') return /^\+?\d[\d ()-]{8,20}\d$/.test(text);
  if (field === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text);
  return (directFields.has(field) || commercialFields.has(field)) && text.length >= 2;
}

export function contactProfile(contact) {
  const commercial = asJson(contact.custom_fields, {}).commercial || {};
  return { ...contact, ...Object.fromEntries(Object.entries(commercial).map(([key, item]) => [key, item?.value])) };
}

// The source is always a customer's message. Model-generated assertions are not evidence.
export function collectProfileUpdates(contactId, message, proposed = []) {
  const contact = get('SELECT * FROM contacts WHERE id=?', [contactId]);
  if (!contact || message.direction !== 'inbound' || message.sender_type !== 'contact' || message.conversation_id == null) return [];
  const owner = get('SELECT contact_id FROM conversations WHERE id=?', [message.conversation_id]);
  if (owner?.contact_id !== contactId) return [];
  const text = String(message.content || '');
  const local = [];
  const email = text.match(/[^\s<>;,]+@[^\s<>;,]+\.[a-z]{2,}/i)?.[0];
  if (email) local.push({ field: 'email', value: email, evidence: email });
  for (const [field, pattern] of [
    ['company', /(?:minha empresa (?:é|se chama)|empresa:\s*)\s*([^\n.!?;]{2,120})/i],
    ['name', /(?:me chamo|meu nome é)\s+([^\n.!?;]{2,80})/i]
  ]) {
    const match = text.match(pattern);
    if (match) local.push({ field, value: match[1].trim(), evidence: match[0] });
  }
  const custom = asJson(contact.custom_fields, {});
  custom.commercial = { ...custom.commercial };
  custom.profile_sources = { ...custom.profile_sources };
  const changes = [];
  const applied = new Set();
  for (const item of [...local, ...(Array.isArray(proposed) ? proposed : [])].slice(0, 25)) {
    const { field } = item || {};
    let value = typeof item?.value === 'string' ? item.value.trim() : '';
    const evidence = typeof item?.evidence === 'string' ? item.evidence.trim() : '';
    // A commercial answer may be paraphrased by the model. Preserve the actual statement instead.
    if(commercialFields.has(field) && evidence && !normalize(evidence).includes(normalize(value)))value=evidence;
    if (applied.has(field) || !validProfileValue(field, value) || field === 'phone' || !evidence ||
        !normalize(text).includes(normalize(evidence)) || !normalize(evidence).includes(normalize(value))) continue;
    applied.add(field);
    const previous = directFields.has(field) ? contact[field] : custom.commercial[field]?.value;
    if (previous === value) continue;
    const source = { message_id: message.id, evidence, updated_at: now(), validation: 'format_and_customer_statement' };
    if (directFields.has(field)) {
      run(`UPDATE contacts SET ${field}=?,updated_at=? WHERE id=?`, [value, now(), contactId]);
      custom.profile_sources[field] = source;
    } else custom.commercial[field] = { value, ...source };
    changes.push({ field, value, ...source });
  }
  if (changes.length) {
    run('UPDATE contacts SET custom_fields=?,updated_at=? WHERE id=?', [JSON.stringify(custom), now(), contactId]);
    run(`INSERT INTO activities(contact_id,conversation_id,actor_type,action,description,metadata)
      VALUES (?,?,'ai','profile_collected',?,?)`, [contactId, message.conversation_id,
      `Dados informados pelo contato: ${changes.map(item => profileLabels[item.field]).join(', ')}.`, JSON.stringify({ changes })]);
  }
  return changes;
}

export function missingProfileFields(contact, fields) {
  const profile = contactProfile(contact);
  return fields.filter(field => !validProfileValue(field, profile[field]));
}

export function profileScore(contact) {
  const profile = contactProfile(contact);
  const weights = { phone: 10, name: 5, email: 5, company: 10, segment: 5, location: 5,
    need: 20, budget: 15, timeframe: 15, decision_role: 10 };
  return Object.entries(weights).reduce((score, [field, weight]) =>
    score + (validProfileValue(field, profile[field]) && !(field === 'name' && profile[field] === 'Novo contato') ? weight : 0), 0);
}
