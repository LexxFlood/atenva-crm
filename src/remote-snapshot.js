import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function configuration() {
  const endpoint = String(process.env.SUPABASE_SNAPSHOT_URL || '').replace(/\/$/, '');
  const key = process.env.SNAPSHOT_SYNC_KEY || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  const company = process.env.SNAPSHOT_COMPANY || 'atenva-demo';
  return endpoint && key && anonKey ? { endpoint, key, anonKey, company } : null;
}

function headers(config, additional = {}) {
  const result = { apikey: config.anonKey, 'x-atenva-sync-key': config.key, ...additional };
  // As chaves publicáveis modernas não são JWTs e não podem ser enviadas como
  // Bearer. Mantemos Authorization apenas para a chave anon legada.
  if (!config.anonKey.startsWith('sb_publishable_')) result.authorization = `Bearer ${config.anonKey}`;
  return result;
}

const retryDelays = [0, 200, 500, 1_000, 2_000];
let pendingPersistence = Promise.resolve();
let pendingRequest = Promise.resolve();
let activeLeaseToken = '';

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isTransientStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]) await wait(retryDelays[attempt]);
    try {
      const response = await fetch(url, options);
      if (!isTransientStatus(response.status) || attempt === retryDelays.length - 1) return response;
      await response.arrayBuffer().catch(() => {});
      lastError = new Error(`Serviço de persistência temporariamente indisponível (${response.status})`);
    } catch (error) {
      lastError = error;
      if (attempt === retryDelays.length - 1) throw error;
    }
  }
  throw lastError || new Error('Serviço de persistência indisponível');
}

export async function hydrateDatabaseFile(databasePath, leaseToken = '') {
  const config = configuration();
  if (!config) return false;
  const response = await fetchWithRetry(`${config.endpoint}?company=${encodeURIComponent(config.company)}`, {
    headers: headers(config, leaseToken ? { 'x-atenva-snapshot-lease': leaseToken } : {})
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Falha ao carregar banco persistente (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100 || bytes.subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('Snapshot persistente inválido');
  writeFileSync(databasePath, bytes);
  return true;
}

export async function persistDatabaseSnapshot(databasePath, database) {
  const config = configuration();
  if (!config || !existsSync(databasePath)) return false;
  const operation = async () => {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const response = await fetchWithRetry(`${config.endpoint}?company=${encodeURIComponent(config.company)}`, {
      method: 'PUT',
      headers: headers(config, {
        'content-type': 'application/octet-stream',
        ...(activeLeaseToken ? { 'x-atenva-snapshot-lease': activeLeaseToken } : {})
      }),
      body: readFileSync(databasePath)
    });
    if (!response.ok) throw new Error(`Falha ao salvar banco persistente (${response.status})`);
    return true;
  };

  // Evita que duas mutações simultâneas disputem o mesmo snapshot no Supabase.
  pendingPersistence = pendingPersistence.catch(() => {}).then(operation);
  return pendingPersistence;
}

async function acquireDatabaseLease() {
  const config = configuration();
  if (!config) return null;
  const owner = randomUUID();
  const delays = [0, 100, 250, 500, 1_000, 2_000, 4_000, 6_000];
  let lastError;
  for (const delay of delays) {
    if (delay) await wait(delay);
    const response = await fetch(`${config.endpoint}?action=acquire&company=${encodeURIComponent(config.company)}`, {
      method: 'POST',
      headers: headers(config, { 'content-type': 'application/json' }),
      body: JSON.stringify({ owner })
    });
    if (response.status === 423) {
      lastError = new Error('Outro processo está atualizando os dados. Tentando novamente.');
      continue;
    }
    if (!response.ok) throw new Error(`Falha ao reservar banco persistente (${response.status})`);
    const payload = await response.json();
    if (!payload?.lease) throw new Error('Serviço de persistência não retornou a reserva do banco.');
    return { config, token: payload.lease };
  }
  throw lastError || new Error('Banco persistente ocupado. Tente novamente em instantes.');
}

async function releaseDatabaseLease(lease) {
  if (!lease) return;
  await fetchWithRetry(`${lease.config.endpoint}?action=release&company=${encodeURIComponent(lease.config.company)}`, {
    method: 'DELETE',
    headers: headers(lease.config, { 'x-atenva-snapshot-lease': lease.token })
  }).then(async response => {
    if (!response.ok && response.status !== 404) {
      await response.arrayBuffer().catch(() => {});
      throw new Error(`Falha ao liberar banco persistente (${response.status})`);
    }
  });
}

// Serializa o acesso SQLite dentro da instância e usa uma reserva distribuída
// para mutações. Assim, duas Functions nunca sobrescrevem snapshots uma da outra.
export function withSynchronizedDatabase({ write = false, reload }, callback) {
  // A single persistent SQLite process can serve reads while an external model
  // request is awaiting I/O. Snapshot deployments still need the distributed lease.
  if(!configuration())return Promise.resolve().then(callback);
  const operation = async () => {
    const lease = write ? await acquireDatabaseLease() : null;
    activeLeaseToken = lease?.token || '';
    try {
      await reload(activeLeaseToken);
      return await callback();
    } finally {
      activeLeaseToken = '';
      try {
        await releaseDatabaseLease(lease);
      } catch (error) {
        console.error('Não foi possível liberar imediatamente a reserva do snapshot:', error);
      }
    }
  };
  const result = pendingRequest.catch(() => {}).then(operation);
  pendingRequest = result.then(() => undefined, () => undefined);
  return result;
}
