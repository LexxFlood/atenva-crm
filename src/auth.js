import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { get, now, run } from './db.js';

const isProduction = process.env.NODE_ENV === 'production';
const sessionCookie = isProduction ? '__Host-verde_session' : 'verde_session';
// Mantém o usuário conectado por trinta dias por padrão. A sessão continua
// assinada, segura e pode ser reduzida por ambiente com SESSION_HOURS.
const configuredSessionHours = Number(process.env.SESSION_HOURS || 24 * 30);
const sessionHours = Number.isFinite(configuredSessionHours) && configuredSessionHours > 0 ? configuredSessionHours : 24 * 30;
const dummySalt = '00000000000000000000000000000000';
const dummyHash = `scrypt$${dummySalt}$${scryptSync('invalid-password', dummySalt, 64).toString('hex')}`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function signSession(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', process.env.SESSION_SECRET || 'local-only').update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySignedSession(token = '') {
  const [payload, suppliedSignature, extra] = String(token).split('.');
  if (!payload || !suppliedSignature || extra) return null;
  const expectedSignature = createHmac('sha256', process.env.SESSION_SECRET || 'local-only').update(payload).digest('base64url');
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isInteger(claims.u) || !claims.c || !claims.e || new Date(claims.e) <= new Date()) return null;
    return claims;
  } catch { return null; }
}

function ipHash(ip = '') {
  return sha256(`${process.env.SESSION_SECRET || 'local-only'}:${ip}`).slice(0, 32);
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export function verifyPassword(password, stored = '') {
  const [algorithm, salt, expectedHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function ensureAdminCredentials() {
  const hasExplicitAdmin = Boolean(process.env.ADMIN_EMAIL);
  const email = (process.env.ADMIN_EMAIL || 'ana@verdecrm.local').trim().toLowerCase();
  const name = (process.env.ADMIN_NAME || 'Administrador Atenva').trim().slice(0, 120);
  const password = process.env.ADMIN_PASSWORD_B64
    ? Buffer.from(process.env.ADMIN_PASSWORD_B64, 'base64').toString('utf8')
    : (process.env.ADMIN_PASSWORD || 'VerdeDemo!2026');
  if (isProduction && (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_B64 || password === 'VerdeDemo!2026')) {
    throw new Error('Defina ADMIN_PASSWORD com uma senha exclusiva antes de iniciar em produção.');
  }
  if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error('Defina SESSION_SECRET antes de iniciar em produção.');
  }
  let user = get('SELECT id, password_hash FROM users WHERE lower(email)=?', [email]);
  if (!user) {
    const created = run(`INSERT INTO users (name,email,role,avatar,status,is_active,is_master,active_company_id)
      VALUES (?,?, 'admin', ?, 'online', 1, ?, 1)`, [name, email, name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase(), hasExplicitAdmin ? 1 : 0]);
    user = { id: Number(created.lastInsertRowid), password_hash: null };
  } else if (hasExplicitAdmin) {
    run("UPDATE users SET role='admin',is_active=1,is_master=1,active_company_id=COALESCE(active_company_id,1) WHERE id=?", [user.id]);
  }
  if (!user.password_hash || process.env.RESET_ADMIN_PASSWORD === 'true') {
    run('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(password), user.id]);
  }
  run(`INSERT OR IGNORE INTO user_company_memberships (company_id,user_id,role,is_active)
    SELECT 1,id,CASE WHEN role='admin' THEN 'owner' ELSE role END,1 FROM users`);
  run('UPDATE users SET active_company_id=1 WHERE active_company_id IS NULL');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function cookieValue(token, maxAge) {
  const secure = isProduction ? '; Secure' : '';
  const expires = new Date(Date.now() + Math.max(0, maxAge) * 1000).toUTCString();
  // OAuth providers return through a top-level cross-site GET. Lax keeps the
  // session available on that callback while still blocking cross-site POSTs.
  return `${sessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Expires=${expires}${secure}`;
}

function userWithCompany(id) {
  return get(`SELECT u.*, cp.name AS company_name, cp.status AS company_status, cp.plan AS company_plan,
    cp.trial_ends_at AS company_trial_ends_at, m.role AS company_role
    FROM users u
    LEFT JOIN company_profiles cp ON cp.id=u.active_company_id
    LEFT JOIN user_company_memberships m ON m.user_id=u.id AND m.company_id=u.active_company_id AND m.is_active=1
    WHERE u.id=?`, [id]);
}

function companyAccessIsActive(user) {
  if (user?.company_status === 'active') return true;
  if (user?.company_status !== 'trial') return false;
  return !user.company_trial_ends_at || new Date(user.company_trial_ends_at) > new Date();
}

function publicUser(user) {
  return {
    id: user.user_id ?? user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, status: user.status,
    isMaster: Boolean(user.is_master), isOnboardingManager: Boolean(user.is_master), companyId: user.active_company_id || null,
    companyName: user.company_name || null, companyRole: user.company_role || null,
    companyStatus: user.company_status || null, companyPlan: user.company_plan || null,
    companyTrialEndsAt: user.company_trial_ends_at || null
  };
}

export function login({ email, password, ip, userAgent, companySlug = '' }) {
  const normalizedEmail = String(email || '').trim().toLowerCase().slice(0, 254);
  const user = get('SELECT * FROM users WHERE lower(email)=?', [normalizedEmail]);
  const hashedIp = ipHash(ip);
  const suppliedPassword = String(password || '');
  const passwordMatches = verifyPassword(suppliedPassword.slice(0, 256), user?.password_hash || dummyHash);

  if (!user || !user.is_active || suppliedPassword.length > 256 || !passwordMatches) {
    run(`INSERT INTO security_events (event_type, ip_hash, details) VALUES ('login_failed', ?, ?)`, [hashedIp, JSON.stringify({ email: normalizedEmail })]);
    if (!user || !user.is_active) return null;
    const failures = user.failed_login_count + 1;
    const lockedUntil = failures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    run('UPDATE users SET failed_login_count=?, locked_until=? WHERE id=?', [failures, lockedUntil, user.id]);
    run(`INSERT INTO security_events (user_id, event_type, ip_hash, details) VALUES (?, 'login_failed', ?, ?)`, [user.id, hashedIp, JSON.stringify({ attempts: failures })]);
    return lockedUntil ? { locked: true } : null;
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) return { locked: true };

  const requestedSlug = String(companySlug || '').trim().toLowerCase().slice(0, 100);
  if (requestedSlug) {
    const requestedCompany = get(`SELECT cp.id FROM company_profiles cp
      WHERE cp.slug=? AND (cp.status='active' OR (cp.status='trial' AND (cp.trial_ends_at IS NULL OR cp.trial_ends_at>?)))`, [requestedSlug, now()]);
    const membership = requestedCompany && (user.is_master || get(`SELECT 1 FROM user_company_memberships
      WHERE company_id=? AND user_id=? AND is_active=1`, [requestedCompany.id, user.id]));
    if (!requestedCompany || !membership) return { tenantDenied: true };
    if (Number(requestedCompany.id) !== Number(user.active_company_id)) run('UPDATE users SET active_company_id=? WHERE id=?', [requestedCompany.id, user.id]);
  } else if (!user.is_master) {
    const activeCompany = get(`SELECT cp.id FROM company_profiles cp JOIN user_company_memberships m ON m.company_id=cp.id
      WHERE m.user_id=? AND m.is_active=1 AND (cp.status='active' OR (cp.status='trial' AND (cp.trial_ends_at IS NULL OR cp.trial_ends_at>?)))
      ORDER BY CASE WHEN cp.id=? THEN 0 ELSE 1 END,cp.id LIMIT 1`, [user.id, now(), user.active_company_id || 0]);
    if (!activeCompany) return null;
    if (Number(activeCompany.id) !== Number(user.active_company_id)) run('UPDATE users SET active_company_id=? WHERE id=?', [activeCompany.id, user.id]);
  }

  run('DELETE FROM sessions WHERE user_id=? OR expires_at < ?', [user.id, now()]);
  const nonce = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionHours * 3_600_000).toISOString();
  const createdSession = run(`INSERT INTO sessions (user_id, token_hash, csrf_token, ip_hash, user_agent, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [user.id, sha256(nonce), csrfToken, hashedIp, String(userAgent || '').slice(0, 300), expiresAt]);
  const token = signSession({ u: user.id, c: csrfToken, e: expiresAt, s: Number(createdSession.lastInsertRowid) });
  run('UPDATE users SET failed_login_count=0, locked_until=NULL, last_login_at=? WHERE id=?', [now(), user.id]);
  run(`INSERT INTO security_events (user_id, event_type, ip_hash) VALUES (?, 'login_success', ?)`, [user.id, hashedIp]);
  return { user: publicUser(userWithCompany(user.id)), csrfToken, cookie: cookieValue(token, sessionHours * 3600) };
}

export function authenticate(request) {
  const token = parseCookies(request.headers.cookie)[sessionCookie];
  if (!token || token.length > 1000) return null;
  const claims = verifySignedSession(token);
  if (!claims) return null;
  const user = userWithCompany(claims.u);
  if (!user?.is_active) return null;
  if (!user.is_master && !companyAccessIsActive(user)) return null;
  return { sessionId: claims.s || null, csrfToken: claims.c, user: publicUser(user) };
}

export function logout(auth, ip) {
  if (!auth) return;
  run('DELETE FROM sessions WHERE id=?', [auth.sessionId]);
  run(`INSERT INTO security_events (user_id, event_type, ip_hash) VALUES (?, 'logout', ?)`, [auth.user.id, ipHash(ip)]);
}

export function clearCookie() {
  return cookieValue('', 0);
}

export function refreshCookie(request) {
  const token = parseCookies(request.headers.cookie)[sessionCookie];
  return token && token.length <= 1000 ? cookieValue(token, sessionHours * 3600) : null;
}

export function requireRole(auth, allowed) {
  if (!auth || !allowed.includes(auth.user.role)) {
    throw Object.assign(new Error('Você não tem permissão para esta ação'), { statusCode: 403 });
  }
}
