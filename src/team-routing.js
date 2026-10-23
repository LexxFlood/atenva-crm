import { all, asJson, get, now, run, transaction } from './db.js';

function eligibleOwners(companyId) {
  const base = `SELECT u.id,u.name,u.status FROM users u
    JOIN user_company_memberships m ON m.user_id=u.id
    WHERE m.company_id=? AND m.is_active=1 AND u.is_active=1 AND COALESCE(u.is_master,0)=0`;
  const available = all(`${base} AND u.status IN ('online','away') ORDER BY u.id`, [companyId]);
  return available.length ? available : all(`${base} ORDER BY u.id`, [companyId]);
}

export function nextLeadOwner(companyId) {
  return transaction(() => {
    const owners = eligibleOwners(companyId);
    if (!owners.length) return null;
    const key = `lead-round-robin:${companyId}`;
    const cursor = asJson(get('SELECT value FROM settings WHERE key=?', [key])?.value, {});
    const previousIndex = owners.findIndex(owner => Number(owner.id) === Number(cursor.last_user_id));
    const owner = owners[previousIndex >= 0 ? (previousIndex + 1) % owners.length : 0];
    const value = JSON.stringify({ last_user_id: owner.id, sequence: Number(cursor.sequence || 0) + 1 });
    run(`INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, [key, value, now()]);
    return owner;
  });
}

export function existingLeadOwner(contactId, companyId) {
  return get(`SELECT u.id,u.name,u.status FROM deals d
    JOIN contacts c ON c.id=d.contact_id
    JOIN users u ON u.id=d.owner_id
    JOIN user_company_memberships m ON m.user_id=u.id AND m.company_id=c.company_id AND m.is_active=1
    WHERE d.contact_id=? AND c.company_id=? AND d.status='open' AND u.is_active=1
    ORDER BY d.created_at,d.id LIMIT 1`, [contactId, companyId]);
}

export function appendHumanSignature(companyId, userId, content) {
  const text = String(content || '').trim();
  const company = get('SELECT slug FROM company_profiles WHERE id=?', [companyId]);
  if (company?.slug !== 'produtora-mais-tracao' || !userId) return text.slice(0, 4000);
  const user = get(`SELECT u.name FROM users u JOIN user_company_memberships m ON m.user_id=u.id
    WHERE u.id=? AND m.company_id=? AND m.is_active=1 AND u.is_active=1`, [userId, companyId]);
  const name = String(user?.name || '').trim();
  if (!name) return text.slice(0, 4000);
  const signature = `— ${name}`;
  if (text.endsWith(signature)) return text.slice(0, 4000);
  return `${text.slice(0, Math.max(0, 3998 - signature.length))}\n\n${signature}`;
}
