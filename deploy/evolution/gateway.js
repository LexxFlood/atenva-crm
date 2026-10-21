import { createServer, request as httpRequest } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const port = Number(process.env.GATEWAY_PORT || 8787);
const upstream = new URL(process.env.EVOLUTION_UPSTREAM || 'http://evolution:8080');
const apiKey = String(process.env.EVOLUTION_API_KEY || '');
const maxBodyBytes = 5_000_000;

const allowedRoutes = [
  ['POST', /^\/instance\/create$/],
  ['GET', /^\/instance\/fetchInstances$/],
  ['GET', /^\/instance\/connectionState\/[A-Za-z0-9._-]+$/],
  ['GET', /^\/instance\/connect\/[A-Za-z0-9._-]+$/],
  ['POST', /^\/(?:event\/)?webhook\/set\/[A-Za-z0-9._-]+$/],
  ['DELETE', /^\/instance\/logout\/[A-Za-z0-9._-]+$/],
  ['POST', /^\/message\/sendText\/[A-Za-z0-9._-]+$/],
  ['POST', /^\/message\/sendWhatsAppAudio\/[A-Za-z0-9._-]+$/]
];

function authorized(value) {
  const supplied = Buffer.from(String(value || ''));
  const expected = Buffer.from(apiKey);
  return expected.length >= 32 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function allowed(method, pathname) {
  return allowedRoutes.some(([candidateMethod, expression]) => candidateMethod === method && expression.test(pathname));
}

function respond(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

createServer((incoming, outgoing) => {
  const url = new URL(incoming.url || '/', 'http://gateway.local');
  if (!authorized(incoming.headers.apikey)) return respond(outgoing, 401, { error: 'Não autorizado' });
  if (!allowed(incoming.method || 'GET', url.pathname)) return respond(outgoing, 404, { error: 'Rota indisponível' });

  let received = 0;
  const proxy = httpRequest({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: incoming.method,
    path: `${url.pathname}${url.search}`,
    headers: {
      apikey: apiKey,
      accept: 'application/json',
      origin: 'https://atenva.vercel.app',
      ...(incoming.headers['content-type'] ? { 'content-type': incoming.headers['content-type'] } : {})
    }
  }, upstreamResponse => {
    outgoing.writeHead(upstreamResponse.statusCode || 502, {
      'content-type': upstreamResponse.headers['content-type'] || 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    upstreamResponse.pipe(outgoing);
  });

  proxy.on('error', () => {
    if (!outgoing.headersSent) respond(outgoing, 502, { error: 'Evolution indisponível' });
    else outgoing.destroy();
  });
  incoming.on('data', chunk => {
    received += chunk.length;
    if (received > maxBodyBytes) {
      proxy.destroy();
      if (!outgoing.headersSent) respond(outgoing, 413, { error: 'Corpo muito grande' });
      incoming.destroy();
      return;
    }
    proxy.write(chunk);
  });
  incoming.on('end', () => proxy.end());
  incoming.on('error', () => proxy.destroy());
}).listen(port, '0.0.0.0', () => {
  console.log(`Gateway seguro da Evolution ativo na porta ${port}`);
});
