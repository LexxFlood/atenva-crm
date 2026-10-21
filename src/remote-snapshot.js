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

export async function hydrateDatabaseFile(databasePath) {
  const config = configuration();
  if (!config) return false;
  const response = await fetchWithRetry(`${config.endpoint}?company=${encodeURIComponent(config.company)}`, {
    headers: headers(config)
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
      headers: headers(config, { 'content-type': 'application/octet-stream' }),
      body: readFileSync(databasePath)
    });
    if (!response.ok) throw new Error(`Falha ao salvar banco persistente (${response.status})`);
    return true;
  };

  // Evita que duas mutações simultâneas disputem o mesmo snapshot no Supabase.
  pendingPersistence = pendingPersistence.catch(() => {}).then(operation);
  return pendingPersistence;
}
