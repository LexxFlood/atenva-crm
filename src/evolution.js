import { randomBytes } from 'node:crypto';

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function evolutionConfig(companyId = 1) {
  const baseInstance = String(process.env.EVOLUTION_INSTANCE_NAME || 'atenva').trim().replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60);
  return {
    baseUrl: cleanBaseUrl(process.env.EVOLUTION_API_URL),
    apiKey: String(process.env.EVOLUTION_API_KEY || '').trim(),
    instanceName: Number(companyId) === 1 && process.env.EVOLUTION_INSTANCE_NAME ? baseInstance : `${baseInstance}-empresa-${Number(companyId) || 1}`,
    webhookSecret: String(process.env.EVOLUTION_WEBHOOK_SECRET || '').trim()
  };
}

export function evolutionIsConfigured(companyId = 1) {
  const config = evolutionConfig(companyId);
  return Boolean(config.baseUrl && config.apiKey && config.webhookSecret);
}

async function evolutionRequest(path, options = {}, companyId = 1) {
  const config = evolutionConfig(companyId);
  if (!evolutionIsConfigured(companyId)) {
    throw Object.assign(new Error('O servidor Evolution ainda não foi provisionado.'), { statusCode: 503 });
  }
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: config.apiKey,
      Accept: 'application/json',
      // A instância aceita somente chamadas originadas do domínio da Atenva.
      // Evolution v2 aplica essa verificação também em chamadas servidor-servidor.
      Origin: cleanBaseUrl(String(process.env.PUBLIC_URL || 'https://atenva.vercel.app').trim()),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
  if (!response.ok) {
    const detail = payload?.response?.message || payload?.message || payload?.error || `Evolution respondeu HTTP ${response.status}`;
    const message = Array.isArray(detail) ? detail.join(', ') : String(detail);
    throw Object.assign(new Error(message), { statusCode: response.status >= 500 ? 502 : 400, upstreamStatus: response.status, payload });
  }
  return payload;
}

function publicBaseUrl(request) {
  return String(process.env.PUBLIC_URL || `${request.headers['x-forwarded-proto'] || 'http'}://${request.headers.host || 'localhost:3210'}`).trim().replace(/\/+$/, '');
}

function webhookUrl(request, companyId) {
  const { webhookSecret } = evolutionConfig(companyId);
  const base=cleanBaseUrl(process.env.EVOLUTION_WEBHOOK_BASE_URL)||publicBaseUrl(request);
  return `${base}/api/webhooks/evolution/${encodeURIComponent(webhookSecret)}/${Number(companyId) || 1}`;
}

function normalizeConnection(payload) {
  const state = String(payload?.instance?.state || payload?.instance?.status || payload?.state || payload?.connectionStatus || '').toLowerCase();
  if (['open', 'connected', 'online'].includes(state)) return 'connected';
  if (['connecting', 'qr', 'pairing'].includes(state)) return 'connecting';
  return state || 'disconnected';
}

export function describeEvolutionState(state, options = {}) {
  const configured = options.configured !== false;
  const checkedAt = new Date().toISOString();
  if (!configured) return {
    reachable: false, connected: false, instance_created: false, needs_qr: false,
    lifecycle: 'setup_required', severity: 'warning', status_title: 'Infraestrutura não configurada',
    status_message: 'A configuração segura da Evolution precisa ser concluída pelo administrador.', checked_at: checkedAt
  };
  const definitions = {
    connected: { reachable:true, connected:true, instance_created:true, needs_qr:false, lifecycle:'connected', severity:'success', status_title:'WhatsApp conectado', status_message:'A infraestrutura e a sessão do WhatsApp estão online.' },
    connecting: { reachable:true, connected:false, instance_created:true, needs_qr:true, lifecycle:'awaiting_qr', severity:'progress', status_title:'Aguardando leitura do QR Code', status_message:'A infraestrutura está online; falta vincular o aparelho do WhatsApp.' },
    not_created: { reachable:true, connected:false, instance_created:false, needs_qr:true, lifecycle:'ready_to_create', severity:'ready', status_title:'Pronto para conectar', status_message:'A infraestrutura está online e criará a instância ao gerar o QR Code.' },
    disconnected: { reachable:true, connected:false, instance_created:true, needs_qr:true, lifecycle:'disconnected', severity:'warning', status_title:'WhatsApp desconectado', status_message:'A infraestrutura está online, mas a sessão precisa ser vinculada novamente.' },
    unavailable: { reachable:false, connected:false, instance_created:null, needs_qr:false, lifecycle:'infrastructure_offline', severity:'error', status_title:'Infraestrutura indisponível', status_message:'O servidor Evolution não respondeu. A conexão será liberada quando o serviço voltar.' }
  };
  return { ...(definitions[state] || definitions.disconnected), checked_at: checkedAt };
}

function qrFrom(payload) {
  const raw = payload?.base64 || payload?.qrcode?.base64 || payload?.qr?.base64 || payload?.data?.base64 || '';
  if (!raw) return null;
  return raw.startsWith('data:image/') ? raw : `data:image/png;base64,${raw}`;
}

async function findInstance(companyId) {
  const { instanceName } = evolutionConfig(companyId);
  try {
    const payload = await evolutionRequest(`/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`, {}, companyId);
    const instance = Array.isArray(payload) ? payload[0] : payload;
    return instance || null;
  } catch (error) {
    if ([400, 404].includes(error.upstreamStatus)) return null;
    throw error;
  }
}

async function configureWebhook(request, companyId) {
  const { instanceName } = evolutionConfig(companyId);
  const webhook = {
    enabled: true,
    url: webhookUrl(request, companyId),
    webhookByEvents: false,
    webhookBase64: true,
    events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
  };
  const candidates = [
    { path: `/webhook/set/${encodeURIComponent(instanceName)}`, body: { webhook } },
    { path: `/webhook/set/${encodeURIComponent(instanceName)}`, body: webhook },
    { path: `/event/webhook/set/${encodeURIComponent(instanceName)}`, body: { webhook } }
  ];
  let lastError;
  for (const candidate of candidates) {
    try { return await evolutionRequest(candidate.path, { method: 'POST', body: candidate.body }, companyId); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function evolutionStatus(companyId = 1) {
  const config = evolutionConfig(companyId);
  if (!evolutionIsConfigured(companyId)) return { provider: 'evolution', configured: false, state: 'not_configured', instance_name: config.instanceName, ...describeEvolutionState('not_configured', { configured:false }) };
  const startedAt = Date.now();
  try {
    const payload = await evolutionRequest(`/instance/connectionState/${encodeURIComponent(config.instanceName)}`, {}, companyId);
    const state = normalizeConnection(payload);
    return { provider: 'evolution', configured: true, state, instance_name: config.instanceName, response_time_ms:Date.now()-startedAt, ...describeEvolutionState(state) };
  } catch (error) {
    if ([400, 404].includes(error.upstreamStatus)) return { provider: 'evolution', configured: true, state: 'not_created', instance_name: config.instanceName, response_time_ms:Date.now()-startedAt, ...describeEvolutionState('not_created') };
    return { provider: 'evolution', configured: true, state: 'unavailable', instance_name: config.instanceName, response_time_ms:Date.now()-startedAt, error: error.message, ...describeEvolutionState('unavailable') };
  }
}

export async function connectEvolution(request, companyId = 1) {
  const config = evolutionConfig(companyId);
  if (!evolutionIsConfigured(companyId)) throw Object.assign(new Error('A infraestrutura Evolution ainda não está configurada no servidor.'), { statusCode: 503 });
  let instance = await findInstance(companyId);
  let createdPayload = null;
  if (!instance) {
    createdPayload = await evolutionRequest('/instance/create', {
      method: 'POST',
      body: {
        instanceName: config.instanceName,
        token: randomBytes(24).toString('hex'),
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        webhook: {
          enabled: true,
          url: webhookUrl(request, companyId),
          webhookByEvents: false,
          webhookBase64: true,
          events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
        }
      }
    }, companyId);
  }
  const status = await evolutionStatus(companyId);
  if (status.connected) return { ...status, qr_code: null };
  let connectPayload = createdPayload;
  if (!qrFrom(connectPayload)) connectPayload = await evolutionRequest(`/instance/connect/${encodeURIComponent(config.instanceName)}`, {}, companyId);
  const qrCode = qrFrom(connectPayload);
  if (!qrCode) {
    throw Object.assign(new Error('A Evolution respondeu sem um QR Code válido. Tente novamente em alguns segundos.'), { statusCode: 502 });
  }

  let webhookConfigured = true;
  let webhookWarning = null;
  try {
    await configureWebhook(request, companyId);
  } catch (error) {
    // O QR precisa continuar disponível mesmo quando o túnel/webhook estiver
    // temporariamente indisponível. A conexão pode ser refeita sem recriar a instância.
    webhookConfigured = false;
    webhookWarning = error.message;
    console.error('[evolution] QR criado, mas o webhook ainda não foi configurado', {
      instance: config.instanceName,
      error: error.message,
      upstreamStatus: error.upstreamStatus || null
    });
  }

  return {
    ...status,
    state: 'connecting',
    qr_code: qrCode,
    pairing_code: connectPayload?.pairingCode || connectPayload?.code || null,
    webhook_configured: webhookConfigured,
    webhook_warning: webhookWarning
  };
}

export async function disconnectEvolution(companyId = 1) {
  const { instanceName } = evolutionConfig(companyId);
  await evolutionRequest(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: 'DELETE' }, companyId);
  return { disconnected: true };
}

export async function sendEvolutionText(to, text, companyId = 1) {
  const { instanceName } = evolutionConfig(companyId);
  const payload = await evolutionRequest(`/message/sendText/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: { number: String(to).replace(/\D/g, ''), text }
  }, companyId);
  if(!payload?.key?.id && !payload?.messageId && !payload?.id)throw Object.assign(new Error('A Evolution não confirmou o identificador da mensagem. Confira o envio antes de tentar novamente.'),{code:'DELIVERY_UNKNOWN',retryable:false});
  return {
    simulated: false,
    id: payload?.key?.id || payload?.messageId || payload?.id,
    status: 'sent',
    raw: payload
  };
}

export async function sendEvolutionAudio(to, audioBase64, companyId = 1) {
  const { instanceName } = evolutionConfig(companyId);
  const payload = await evolutionRequest(`/message/sendWhatsAppAudio/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: { number: String(to).replace(/\D/g, ''), audio: String(audioBase64).replace(/^data:[^;]+;base64,/, ''), encoding: true }
  }, companyId);
  if(!payload?.key?.id && !payload?.messageId && !payload?.id)throw Object.assign(new Error('A Evolution não confirmou o identificador do áudio. Confira o envio antes de tentar novamente.'),{code:'DELIVERY_UNKNOWN',retryable:false});
  return {
    simulated: false,
    id: payload?.key?.id || payload?.messageId || payload?.id,
    status: 'sent',
    raw: payload
  };
}

function messageText(message = {}) {
  return message.conversation || message.extendedTextMessage?.text || message.buttonsResponseMessage?.selectedDisplayText || message.listResponseMessage?.title || message.imageMessage?.caption || message.videoMessage?.caption || message.documentMessage?.caption || '';
}

export function extractEvolutionWebhookEvents(payload) {
  const event = String(payload?.event || '').toLowerCase();
  const data = payload?.data || {};
  if (event.includes('messages.update')) {
    const updates = Array.isArray(data) ? data : [data];
    return updates.map(item => {
      const status=item?.update?.status??item?.status??'';
      const normalized=({0:'error',1:'pending',2:'server_ack',3:'delivered',4:'read',5:'played'})[status]||String(status).toLowerCase();
      return {kind:'status',externalId:item?.key?.id||item?.id,status:normalized};
    }).filter(item=>item.externalId);
  }
  if (!event.includes('messages.upsert')) return [];
  const entries = Array.isArray(data) ? data : [data];
  return entries.filter(item => !item?.key?.fromMe && item?.key?.remoteJid && !String(item.key.remoteJid).endsWith('@g.us')).map(item => {
    let rawMessage = item.message || {};
    for(let depth=0;depth<4;depth++){
      const wrapped=rawMessage.ephemeralMessage?.message||rawMessage.viewOnceMessage?.message||rawMessage.viewOnceMessageV2?.message||rawMessage.documentWithCaptionMessage?.message;
      if(!wrapped)break;rawMessage=wrapped;
    }
    const jid = String(item.key.remoteJid);
    const from = jid.split('@')[0].replace(/\D/g, '');
    const typeKey = Object.keys(rawMessage).find(key=>!['messageContextInfo','senderKeyDistributionMessage'].includes(key)) || 'text';
    const type = ({conversation:'text',extendedTextMessage:'text',buttonsResponseMessage:'button',listResponseMessage:'interactive'})[typeKey]||typeKey.replace(/Message$/, '').toLowerCase();
    return {
      kind: 'message',
      externalId: item.key.id,
      from,
      contactName: item.pushName || data.pushName || 'Novo contato',
      profilePictureUrl: item.profilePictureUrl || data.profilePictureUrl || null,
      type,
      content: rawMessage?.audioMessage?.speechToText || item?.message?.speechToText || messageText(rawMessage) || `[${type}]`,
      audioBase64: type === 'audio' ? (rawMessage?.audioMessage?.base64 || item?.message?.base64 || item?.base64 || null) : null,
      audioMimeType: rawMessage?.audioMessage?.mimetype || 'audio/ogg',
      timestamp: item.messageTimestamp ? new Date(Number(item.messageTimestamp) * 1000).toISOString() : new Date().toISOString(),
      raw: item
    };
  });
}
