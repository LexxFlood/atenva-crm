import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { get, now, run } from './db.js';

const calendarListScope = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const scopes = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.events', calendarListScope];

function secretKey() {
  return createHash('sha256').update(process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'atenva-local-integration-key').digest();
}

function encrypt(payload) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

function decrypt(value) {
  try { const [v, iv, tag, data] = String(value || '').split('.'); if (v !== 'v1') return {}; const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64url')); decipher.setAuthTag(Buffer.from(tag, 'base64url')); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')); } catch { return {}; }
}

function config() {
  const publicUrl = String(process.env.PUBLIC_URL || 'https://atenva.vercel.app').trim().replace(/\/+$/, '');
  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    redirectUri: String(process.env.GOOGLE_REDIRECT_URI || `${publicUrl}/api/integrations/google/callback`).trim()
  };
}

function storageKey(companyId) { return `integration:google-calendar:${Number(companyId) || 1}`; }
function stored(companyId) { return decrypt(get('SELECT value FROM settings WHERE key=?', [storageKey(companyId)])?.value); }
function save(companyId, value) { run(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, [storageKey(companyId), encrypt(value), now()]); }

function signedState(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secretKey()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function readState(value) {
  const [encoded, signature] = String(value || '').split('.');
  const expected = createHmac('sha256', secretKey()).update(encoded || '').digest();
  const received = Buffer.from(signature || '', 'base64url');
  if (!encoded || received.length !== expected.length || !timingSafeEqual(received, expected)) throw Object.assign(new Error('Estado OAuth inválido.'), { statusCode: 400 });
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (payload.expires < Date.now()) throw Object.assign(new Error('A autorização expirou. Tente conectar novamente.'), { statusCode: 400 });
  return payload;
}

export function googleStatus(companyId) {
  const cfg = config(); const value = stored(companyId);
  const grantedScopes = String(value.scope || '').split(/\s+/).filter(Boolean);
  return { configured: Boolean(cfg.clientId && cfg.clientSecret), connected: Boolean(value.refresh_token || (value.access_token && value.expires_at > Date.now())), email: value.email || null, connected_at: value.connected_at || null, last_synced_at: value.last_synced_at || null, sync_error: value.sync_error || null, imported_events: Number(value.imported_events || 0), calendar_count: Number(value.calendar_count || 0), needs_reconnect: Boolean(value.refresh_token && !grantedScopes.includes(calendarListScope)) };
}

export function googleAuthorizationUrl(user, redirectUriOverride = '') {
  const cfg = config();
  if (!cfg.clientId || !cfg.clientSecret) throw Object.assign(new Error('A integração Google ainda não foi configurada pelo administrador.'), { statusCode: 503 });
  const redirectUri = String(redirectUriOverride || cfg.redirectUri).trim();
  const state = signedState({ userId: user.id, companyId: user.companyId, redirectUri, expires: Date.now() + 10 * 60_000, nonce: randomBytes(10).toString('hex') });
  const params = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent', state });
  if (user.email) params.set('login_hint', user.email);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function completeGoogleAuthorization({ code, state, user }) {
  const parsed = readState(state);
  if (Number(parsed.userId) !== Number(user.id) || Number(parsed.companyId) !== Number(user.companyId)) throw Object.assign(new Error('Esta autorização pertence a outro perfil.'), { statusCode: 403 });
  const cfg = config();
  const redirectUri = String(parsed.redirectUri || cfg.redirectUri).trim();
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
  const token = await response.json(); if (!response.ok) throw Object.assign(new Error(token.error_description || 'O Google recusou a autorização.'), { statusCode: 400 });
  const current = stored(user.companyId); const next = { ...current, ...token, scope: token.scope || scopes.join(' '), refresh_token: token.refresh_token || current.refresh_token, expires_at: Date.now() + Number(token.expires_in || 3600) * 1000, connected_at: now() };
  if (token.id_token) { try { next.email = JSON.parse(Buffer.from(token.id_token.split('.')[1], 'base64url').toString('utf8')).email || null; } catch {} }
  save(user.companyId, next);
  let initialSync;
  try { initialSync = await syncGoogleCalendar(user.companyId, user.id); }
  catch (error) {
    save(user.companyId, { ...stored(user.companyId), sync_error: error.message, last_sync_attempt_at: now() });
    initialSync = { synced: false, imported: 0, warning: error.message };
  }
  return { ...googleStatus(user.companyId), initial_sync: initialSync };
}

async function accessToken(companyId) {
  const current = stored(companyId); if (current.access_token && current.expires_at > Date.now() + 60_000) return current.access_token;
  if (!current.refresh_token) throw Object.assign(new Error('Conecte a Agenda Google primeiro.'), { statusCode: 401 });
  const cfg = config(); const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: current.refresh_token, grant_type: 'refresh_token' }) });
  const token = await response.json(); if (!response.ok) throw Object.assign(new Error(token.error_description || 'Não foi possível renovar o acesso ao Google.'), { statusCode: 401 });
  const next = { ...current, ...token, refresh_token: current.refresh_token, expires_at: Date.now() + Number(token.expires_in || 3600) * 1000 }; save(companyId, next); return next.access_token;
}

async function googleGet(companyId, path, params = {}) {
  const token = await accessToken(companyId);
  const query = new URLSearchParams(params);
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const denied = response.status === 401 || response.status === 403;
    throw Object.assign(new Error(denied ? 'Reconecte o Google para liberar a leitura de todas as agendas.' : (payload.error?.message || 'Não foi possível carregar a agenda.')), { statusCode: denied ? 401 : 400, needsReconnect: denied });
  }
  return payload;
}

export async function googleCalendars(companyId) {
  const items = []; let pageToken = '';
  do {
    const payload = await googleGet(companyId, '/users/me/calendarList', { maxResults: '250', minAccessRole: 'reader', ...(pageToken ? { pageToken } : {}) });
    items.push(...(payload.items || [])); pageToken = payload.nextPageToken || '';
  } while (pageToken);
  return items.filter(item => !item.deleted && !item.hidden).map(item => ({ id: item.id, name: item.summaryOverride || item.summary || 'Agenda sem nome', primary: Boolean(item.primary), selected: item.selected !== false || Boolean(item.primary), access_role: item.accessRole || 'reader', color: item.backgroundColor || '#4285f4', time_zone: item.timeZone || null }));
}

export async function googleCalendarEvents(companyId, start, end) {
  const calendars = await googleCalendars(companyId);
  const events = [];
  for (const calendar of calendars.filter(item => item.selected)) {
    let pageToken = '';
    do {
      const payload = await googleGet(companyId, `/calendars/${encodeURIComponent(calendar.id)}/events`, { timeMin: new Date(`${start}T00:00:00-03:00`).toISOString(), timeMax: new Date(`${end}T23:59:59-03:00`).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', ...(pageToken ? { pageToken } : {}) });
      events.push(...(payload.items || []).filter(item => item.status !== 'cancelled').map(item => ({ id: `google:${encodeURIComponent(calendar.id)}:${item.id}`, google_event_id: item.id, google_calendar_id: calendar.id, calendar_name: calendar.name, calendar_color: calendar.color, title: item.summary || 'Evento do Google', description: item.description || '', due_at: item.start?.dateTime || `${item.start?.date}T09:00:00`, end_at: item.end?.dateTime || `${item.end?.date}T10:00:00`, status: 'pending', priority: 'normal', type: item.eventType === 'workingLocation' ? 'reminder' : 'meeting', source: 'google', html_link: item.htmlLink || null, location: item.location || null })));
      pageToken = payload.nextPageToken || '';
    } while (pageToken);
  }
  return events.sort((left, right) => String(left.due_at).localeCompare(String(right.due_at)));
}

function calendarWindow() {
  const start = new Date(); const end = new Date();
  start.setDate(start.getDate() - 30); end.setDate(end.getDate() + 90);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export async function syncGoogleCalendar(companyId, userId, range = calendarWindow()) {
  const availableCalendars = await googleCalendars(companyId);
  const events = await googleCalendarEvents(companyId, range.start, range.end);
  let imported = 0; let updated = 0;
  for (const event of events) {
    const existing = get("SELECT id FROM tasks WHERE company_id=? AND google_event_id=? AND COALESCE(google_calendar_id,'primary')=?", [companyId, event.google_event_id, event.google_calendar_id]);
    if (existing) {
      run(`UPDATE tasks SET title=?,description=?,due_at=?,type=?,assigned_to=COALESCE(assigned_to,?) WHERE id=?`, [event.title,event.description,event.due_at,event.type,userId||null,existing.id]);
      updated += 1;
    } else {
      run(`INSERT INTO tasks (company_id,assigned_to,title,description,due_at,type,priority,status,created_by,google_event_id,google_calendar_id)
        VALUES (?,?,?,?,?,?,?,'pending','system',?,?)`, [companyId,userId||null,event.title,event.description,event.due_at,event.type,event.priority,event.google_event_id,event.google_calendar_id]);
      imported += 1;
    }
  }
  const current = stored(companyId);
  save(companyId, { ...current, last_synced_at: now(), last_sync_attempt_at: now(), sync_error: null, imported_events: events.length, calendar_count: availableCalendars.length });
  return { synced: true, imported, updated, events: events.length, calendars: availableCalendars.length, range };
}

async function calendarRequest(companyId, path, options = {}) {
  const token = await accessToken(companyId);
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error?.message || 'Não foi possível sincronizar a tarefa com o Google Agenda.'), { statusCode: 400 });
  return payload;
}

function taskEvent(task) {
  const start = task.due_at ? new Date(task.due_at) : new Date(Date.now() + 3_600_000);
  const end = new Date(start.getTime() + (task.type === 'meeting' ? 60 : 30) * 60_000);
  return { summary: task.title, description: task.description || 'Criado pelo Atenva', start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' }, end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' } };
}

export async function createGoogleTaskEvent(companyId, task) {
  if (!googleStatus(companyId).connected || !task.due_at) return null;
  return calendarRequest(companyId, '/calendars/primary/events', { method: 'POST', body: JSON.stringify(taskEvent(task)) });
}

export async function updateGoogleTaskEvent(companyId, task) {
  if (!task.google_event_id || !googleStatus(companyId).connected) return null;
  const calendarId = task.google_calendar_id || 'primary';
  return calendarRequest(companyId, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(task.google_event_id)}`, { method: 'PATCH', body: JSON.stringify(taskEvent(task)) });
}

export async function deleteGoogleTaskEvent(companyId, eventId, calendarId = 'primary') {
  if (!eventId || !googleStatus(companyId).connected) return null;
  return calendarRequest(companyId, `/calendars/${encodeURIComponent(calendarId || 'primary')}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
}

export function disconnectGoogle(companyId) { run('DELETE FROM settings WHERE key=?', [storageKey(companyId)]); return { disconnected: true }; }
