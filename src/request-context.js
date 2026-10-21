import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();

export function runWithRequestContext(request, callback) {
  const header = request?.headers?.['x-vercel-oidc-token'];
  const vercelOidcToken = Array.isArray(header) ? header[0] : header;
  return requestContext.run({ vercelOidcToken: String(vercelOidcToken || '') }, callback);
}

export function currentVercelOidcToken() {
  return requestContext.getStore()?.vercelOidcToken || '';
}
