import './src/env.js';
import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processScheduledMessages, routeApi } from './src/api.js';
import { seed } from './src/seed.js';
import { verifyChallenge, verifySignature, whatsappDeliveryStatus } from './src/whatsapp.js';
import { authenticate, clearCookie, ensureAdminCredentials, login, logout, promoteConfiguredMasters, refreshCookie } from './src/auth.js';
import { completeMetaAuthorization, metaIsConfigured, metaOauthStatus, verifyMetaLeadChallenge, verifyMetaLeadSignature } from './src/integrations.js';
import { recalculateQualifications } from './src/qualification.js';
import { db, databasePath, get, reloadDatabaseFromSnapshot } from './src/db.js';
import { persistDatabaseSnapshot, withSynchronizedDatabase } from './src/remote-snapshot.js';
import { evolutionConfig, evolutionIsConfigured, evolutionStatus } from './src/evolution.js';
import { completeGoogleAuthorization } from './src/google-calendar.js';
import { agentModelStatus } from './src/agent.js';
import { processPendingInboundMessages } from './src/agent.js';
import { runWithRequestContext } from './src/request-context.js';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 3210);
seed();
ensureAdminCredentials();
recalculateQualifications();

const rateBuckets = new Map();
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function securityHeaders(contentType = '') {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=()',
    // O Embedded Signup da Meta abre um popup e devolve os dados por postMessage.
    // `same-origin` isolava o popup e a CSP impedia o SDK oficial de carregar.
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://connect.facebook.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.facebook.com https://*.fbcdn.net; connect-src 'self' https://graph.facebook.com https://www.facebook.com; frame-src https://www.facebook.com https://web.facebook.com; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  };
  if (process.env.NODE_ENV === 'production') headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

function clientIp(request) {
  if (process.env.TRUST_PROXY === 'true') return String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket.remoteAddress || '';
  return request.socket.remoteAddress || '';
}

function allowRate(key, limit, windowMs) {
  const timestamp = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || timestamp >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: timestamp + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; }
  catch { return false; }
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(response, status, payload, additionalHeaders = {}) {
  response.writeHead(status, { ...securityHeaders('application/json; charset=utf-8'), 'Cache-Control': 'no-store', ...additionalHeaders });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 3_000_000) {
        reject(Object.assign(new Error('Corpo da requisição demasiado grande'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(publicDir, 'index.html');
  const content = readFileSync(filePath);
  response.writeHead(200, {
    ...securityHeaders(mimeTypes[extname(filePath)] || 'application/octet-stream'),
    // Os assets não possuem nomes com hash; cache poderia misturar HTML, CSS e JS de versões diferentes.
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0'
  });
  response.end(content);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const ip = clientIp(request);
  try {
    const rateAuth=url.pathname.startsWith('/api/')?authenticate(request):null;
    const rateKey=rateAuth?.user?`user:${rateAuth.user.id}`:`anonymous:${ip}`;
    if (!allowRate(rateKey, rateAuth?.user?600:240, 60_000)) return sendJson(response, 429, { error: 'Muitas solicitações. Aguarde um minuto.' }, { 'Retry-After': '60' });

    if (request.method === 'GET' && url.pathname === '/api/webhooks/whatsapp') {
      const query = Object.fromEntries(url.searchParams);
      const challenge = verifyChallenge(query);
      if (challenge === null) return sendJson(response, 403, { error: 'Token de verificação inválido' });
      response.writeHead(200, securityHeaders('text/plain; charset=utf-8'));
      return response.end(challenge);
    }
    if (request.method === 'GET' && url.pathname === '/api/webhooks/meta-leads') {
      const challenge=verifyMetaLeadChallenge(Object.fromEntries(url.searchParams));
      if(challenge===null)return sendJson(response,403,{error:'Token de verificação inválido'});
      response.writeHead(200,securityHeaders('text/plain; charset=utf-8'));
      return response.end(challenge);
    }

    if (url.pathname.startsWith('/api/')) {
      const rawBody = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await readBody(request) : Buffer.alloc(0);
      if (url.pathname === '/api/webhooks/whatsapp' && request.method === 'POST' && !verifySignature(rawBody, request.headers['x-hub-signature-256'])) {
        return sendJson(response, 401, { error: 'Assinatura do webhook inválida' });
      }
      if (url.pathname === '/api/webhooks/meta-leads' && request.method === 'POST' && !verifyMetaLeadSignature(rawBody,request.headers['x-hub-signature-256'])) {
        return sendJson(response,401,{error:'Assinatura do webhook de leads inválida'});
      }
      if (url.pathname.startsWith('/api/webhooks/evolution/') && request.method === 'POST') {
        const [suppliedSecret] = url.pathname.slice('/api/webhooks/evolution/'.length).split('/').map(decodeURIComponent);
        if (!evolutionIsConfigured() || suppliedSecret !== evolutionConfig().webhookSecret) return sendJson(response, 401, { error: 'Webhook Evolution não autorizado' });
      }
      let body = {};
      if (rawBody.length) {
        try { body = JSON.parse(rawBody.toString('utf8')); }
        catch { throw Object.assign(new Error('JSON inválido'), { statusCode: 400 }); }
      }

      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        const loginIdentity=String(body.email||'').trim().toLowerCase().slice(0,254);
        if (!allowRate(`login:${ip}:${loginIdentity}`, 8, 15 * 60_000)||!allowRate(`login-network:${ip}`,60,15*60_000)) return sendJson(response, 429, { error: 'Muitas tentativas. Tente novamente em 15 minutos.' }, { 'Retry-After': '900' });
        const result = login({ email: body.email, password: body.password, companySlug: body.company_slug, ip, userAgent: request.headers['user-agent'] });
        if (!result || result.locked || result.tenantDenied) {
          const status = result?.locked ? 423 : result?.tenantDenied ? 403 : 401;
          const error = result?.locked ? 'Conta temporariamente bloqueada. Aguarde 15 minutos.' : result?.tenantDenied ? 'Este acesso não pertence a esta empresa.' : 'E-mail ou senha incorretos.';
          return sendJson(response, status, { error });
        }
        await persistDatabaseSnapshot(databasePath, db);
        return sendJson(response, 200, { user: result.user, csrfToken: result.csrfToken }, { 'Set-Cookie': result.cookie });
      }

      if (url.pathname === '/api/cron/scheduled-messages' && request.method === 'GET') {
        const secret=String(process.env.CRON_SECRET||'');
        if(!secret)return sendJson(response,503,{error:'Executor de agendamentos não configurado.'});
        if(request.headers.authorization!==`Bearer ${secret}`)return sendJson(response,401,{error:'Executor não autorizado.'});
        const result=await processScheduledMessages();
        await persistDatabaseSnapshot(databasePath,db);
        return sendJson(response,200,result);
      }

      const publicCompanyMatch = url.pathname.match(/^\/api\/public\/companies\/([a-z0-9-]+)$/);
      if (publicCompanyMatch && request.method === 'GET') {
        const company = get(`SELECT name,slug,status,plan FROM company_profiles
          WHERE slug=? AND (status='active' OR (status='trial' AND (trial_ends_at IS NULL OR trial_ends_at>?)))`, [publicCompanyMatch[1],new Date().toISOString()]);
        if (!company) return sendJson(response, 404, { error: 'Ambiente do cliente não encontrado ou indisponível.' });
        return sendJson(response, 200, company);
      }

      const auth = authenticate(request);
      if (url.pathname === '/api/integrations/google/callback' && request.method === 'GET') {
        if (!auth) { response.writeHead(302, { Location: '/?integration=google&status=login-required' }); return response.end(); }
        try { const result=await completeGoogleAuthorization({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), user: auth.user }); await persistDatabaseSnapshot(databasePath, db); const sync=result.initial_sync||{}; response.writeHead(302, { Location: `/?integration=google&status=connected&synced=${sync.synced?'1':'0'}&items=${Number(sync.events||0)}${sync.warning?`&message=${encodeURIComponent(sync.warning)}`:''}` }); return response.end(); }
        catch (error) { response.writeHead(302, { Location: `/?integration=google&status=error&message=${encodeURIComponent(error.message)}` }); return response.end(); }
      }
      if (url.pathname === '/api/integrations/meta/callback' && request.method === 'GET') {
        if (!auth) { response.writeHead(302, { Location: '/?integration=meta&status=login-required' }); return response.end(); }
        try { const result=await completeMetaAuthorization({ code:url.searchParams.get('code'), state:url.searchParams.get('state'), user:auth.user }); await persistDatabaseSnapshot(databasePath,db); const sync=result.initial_sync||{}; response.writeHead(302,{Location:`/?integration=meta&status=connected&synced=${sync.synced?'1':'0'}&items=${Number(sync.accounts||0)}${sync.warning?`&message=${encodeURIComponent(sync.warning)}`:''}`}); return response.end(); }
        catch(error){response.writeHead(302,{Location:`/?integration=meta&status=error&message=${encodeURIComponent(error.message)}`});return response.end();}
      }
      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        if (!auth) return sendJson(response, 401, { error: 'Sessão não autenticada' });
        const renewedCookie = refreshCookie(request);
        return sendJson(response, 200, { user: auth.user, csrfToken: auth.csrfToken }, renewedCookie ? { 'Set-Cookie': renewedCookie } : {});
      }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        const companyId=auth?.user?.companyId||1;
        const official=metaIsConfigured(companyId);
        const officialReady=metaOauthStatus().configured;
        const officialState=official?'connected':'awaiting_connection';
        const evolution=!official&&evolutionIsConfigured(companyId)?await evolutionStatus(companyId):null;
        const whatsappConnected=official||Boolean(evolution?.connected);
        return sendJson(response, 200, {
          status: 'ok',
          demo: process.env.NODE_ENV !== 'production',
          authenticated: Boolean(auth),
          whatsapp: whatsappConnected,
          whatsappDelivery: whatsappDeliveryStatus(companyId),
          whatsappProvider: official?'meta_cloud_api':evolution?'evolution':officialReady?'meta_cloud_api':null,
          whatsappReachable: official||Boolean(evolution?.reachable),
          whatsappConnected,
          whatsappState: evolution?.state||(officialReady?officialState:'not_configured'),
          whatsappLifecycle: evolution?.lifecycle||(officialReady?officialState:'not_configured'),
          ai: agentModelStatus().configured,
          aiModel: agentModelStatus().model,
          time: new Date().toISOString()
        });
      }

      const isWebhook = url.pathname === '/api/webhooks/whatsapp' || url.pathname === '/api/webhooks/meta-leads' || url.pathname.startsWith('/api/webhooks/evolution/');
      const isPublicInvitation = /^\/api\/invitations\/[A-Za-z0-9_-]+(?:\/accept)?$/.test(url.pathname);
      if (!isWebhook && !isPublicInvitation && !auth) return sendJson(response, 401, { error: 'Inicie sessão para continuar.' });
      if (!isWebhook && !isPublicInvitation && unsafeMethods.has(request.method)) {
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Origem da solicitação recusada.' });
        if (request.headers['x-csrf-token'] !== auth.csrfToken) return sendJson(response, 403, { error: 'Proteção de sessão inválida. Atualize a página.' });
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        logout(auth, ip);
        await persistDatabaseSnapshot(databasePath, db);
        return sendJson(response, 200, { loggedOut: true }, { 'Set-Cookie': clearCookie(), 'Clear-Site-Data': '"cache"' });
      }

      const payload = await routeApi(request, response, url, body, auth);
      if (unsafeMethods.has(request.method)) await persistDatabaseSnapshot(databasePath, db);
      return sendJson(response, 200, payload);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Método não permitido' });
    serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error.message || 'Erro interno' });
  }
}

const server = createServer((request, response) => runWithRequestContext(request, async () => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return handleRequest(request, response);
  const writesDatabase = unsafeMethods.has(request.method)
    || url.pathname === '/api/cron/scheduled-messages'
    || url.pathname === '/api/integrations/google/callback'
    || url.pathname === '/api/integrations/meta/callback';
  try {
    return await withSynchronizedDatabase(
      { write: writesDatabase, reload: reloadDatabaseFromSnapshot },
      () => {
        if (writesDatabase) promoteConfiguredMasters();
        return handleRequest(request, response);
      }
    );
  } catch (error) {
    console.error(error);
    if (!response.headersSent) return sendJson(response, 503, { error: 'Dados temporariamente indisponíveis. Tente novamente.' });
  }
}));

const host = process.env.HOST || (process.env.VERCEL ? '0.0.0.0' : '127.0.0.1');
server.listen(port, host, () => {
  console.log(`Atenva disponível em http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`WhatsApp oficial: ${metaIsConfigured() ? 'Meta Cloud API configurada' : metaOauthStatus().configured ? 'aguardando conexão' : 'desconectado'}`);
  console.log(`IA externa: ${agentModelStatus().configured ? agentModelStatus().model : 'motor local de contingência'}`);
});

// Persistent hosts acknowledge webhooks after enqueueing, then drain the durable
// queue separately. Three slots keep a slow model from stopping other clients.
let activeQueueWorkers=0;
let queueTimer=null;
if(!process.env.VERCEL){
  queueTimer=setInterval(()=>{
    while(activeQueueWorkers<3){
      activeQueueWorkers++;
      withSynchronizedDatabase({write:true,reload:reloadDatabaseFromSnapshot},()=>processPendingInboundMessages())
        .catch(error=>console.error('[fila de atendimento]',error.message))
        .finally(()=>{activeQueueWorkers--;});
    }
  },1000);
  queueTimer.unref();
}

function shutdown() {
  clearInterval(queueTimer);
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
