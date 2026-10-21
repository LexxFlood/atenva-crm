import { createHmac, timingSafeEqual } from 'node:crypto';
import { acceptsMetaVerifyToken, companyForMetaWebhook, metaConfig, metaIsConfigured } from './integrations.js';
import { evolutionIsConfigured, sendEvolutionAudio, sendEvolutionText } from './evolution.js';

function config(companyId=1) {
  const saved = metaConfig(companyId);
  return {
    token: saved.accessToken,
    phoneNumberId: saved.phoneNumberId,
    verifyToken: saved.verifyToken || 'troque-este-token',
    appSecret: saved.appSecret,
    apiVersion: saved.apiVersion
  };
}

export function verifyChallenge(query) {
  if (query['hub.mode'] === 'subscribe' && acceptsMetaVerifyToken(query['hub.verify_token'])) {
    return query['hub.challenge'];
  }
  return null;
}

export function verifySignature(rawBody, signatureHeader) {
  let payload={};try{payload=JSON.parse(Buffer.isBuffer(rawBody)?rawBody.toString('utf8'):String(rawBody||''));}catch{}
  const companyId=companyForMetaWebhook(payload)||1;
  const { appSecret } = config(companyId);
  if (!appSecret) return process.env.ALLOW_INSECURE_WEBHOOKS === 'true' && process.env.NODE_ENV !== 'production';
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const received = Buffer.from(signatureHeader.slice(7), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function sendWhatsAppText(to, body, companyId = 1) {
  if (!metaIsConfigured(companyId) && evolutionIsConfigured(companyId)) return sendEvolutionText(to, body, companyId);
  const cfg = config(companyId);
  if (!cfg.token || !cfg.phoneNumberId) {
    return { simulated: true, id: `local-${Date.now()}`, status: 'sent' };
  }

  const response = await fetch(
    `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body }
      })
    }
  );

  const result = await response.json();
  if (!response.ok) throw new Error(result?.error?.message || 'Falha ao enviar mensagem pelo WhatsApp');
  return { simulated: false, id: result.messages?.[0]?.id, status: 'sent', raw: result };
}

export async function sendWhatsAppAudio(to, audioBase64, companyId = 1) {
  if (!metaIsConfigured(companyId) && evolutionIsConfigured(companyId)) return sendEvolutionAudio(to, audioBase64, companyId);
  const cfg=config(companyId);if(!cfg.token||!cfg.phoneNumberId)throw Object.assign(new Error('Conecte o WhatsApp oficial antes de enviar áudio.'),{statusCode:503});
  const raw=String(audioBase64||'').replace(/^data:[^;]+;base64,/,'');const bytes=Buffer.from(raw,'base64');if(!bytes.length)throw Object.assign(new Error('Áudio vazio.'),{statusCode:400});
  const form=new FormData();form.set('messaging_product','whatsapp');form.set('type','audio/ogg');form.set('file',new Blob([bytes],{type:'audio/ogg'}),'audio.ogg');
  const upload=await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/media`,{method:'POST',headers:{Authorization:`Bearer ${cfg.token}`},body:form});const uploaded=await upload.json();if(!upload.ok||!uploaded.id)throw new Error(uploaded?.error?.message||'Falha ao enviar o áudio para a Meta.');
  const response=await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`,{method:'POST',headers:{Authorization:`Bearer ${cfg.token}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to,type:'audio',audio:{id:uploaded.id}})});const result=await response.json();if(!response.ok)throw new Error(result?.error?.message||'Falha ao enviar áudio pelo WhatsApp oficial.');return {simulated:false,id:result.messages?.[0]?.id,status:'sent',raw:result};
}

export async function sendWhatsAppTemplate(to, template, companyId = 1) {
  const cfg = config(companyId);
  if (!cfg.token || !cfg.phoneNumberId) {
    return { simulated: true, id: `local-template-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, status: 'sent' };
  }
  const variables = Array.isArray(template.variables) ? template.variables.filter(value => value !== undefined && value !== null).map(value => String(value)) : [];
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: template.name, language: { code: template.language || 'pt_BR' } }
  };
  if (variables.length) payload.template.components = [{ type: 'body', parameters: variables.map(text => ({ type: 'text', text })) }];
  const response = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error?.message || 'Falha ao enviar modelo pelo WhatsApp');
  return { simulated: false, id: result.messages?.[0]?.id, status: 'sent', raw: result };
}

export async function downloadWhatsAppMedia(mediaId, companyId=1) {
  const cfg=config(companyId);if(!cfg.token||!mediaId)return null;
  const metadataResponse=await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${encodeURIComponent(mediaId)}`,{headers:{Authorization:`Bearer ${cfg.token}`}});const metadata=await metadataResponse.json();if(!metadataResponse.ok||!metadata.url)throw new Error(metadata?.error?.message||'Não foi possível localizar a mídia recebida.');
  const fileResponse=await fetch(metadata.url,{headers:{Authorization:`Bearer ${cfg.token}`}});if(!fileResponse.ok)throw new Error('Não foi possível baixar a mídia recebida.');const bytes=Buffer.from(await fileResponse.arrayBuffer());return {base64:bytes.toString('base64'),mimeType:fileResponse.headers.get('content-type')||metadata.mime_type||'application/octet-stream',sha256:metadata.sha256||null,fileSize:bytes.length};
}

export function extractWebhookEvents(payload) {
  const events = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contactName = value.contacts?.[0]?.profile?.name;
      for (const message of value.messages || []) {
        let content = '';
        if (message.type === 'text') content = message.text?.body || '';
        else if (message.type === 'button') content = message.button?.text || '';
        else if (message.type === 'interactive') {
          content = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
        } else content = `[${message.type || 'mensagem'}]`;

        events.push({
          kind: 'message',
          externalId: message.id,
          from: message.from,
          contactName: contactName || 'Novo contato',
          type: message.type || 'text',
          content,
          timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
          raw: message,
          businessAccountId:entry.id,
          phoneNumberId:value.metadata?.phone_number_id,
          mediaId:message.audio?.id||message.image?.id||message.video?.id||message.document?.id||message.sticker?.id||null
        });
      }
      for (const status of value.statuses || []) {
        events.push({
          kind: 'status',
          externalId: status.id,
          status: status.status,
          timestamp: status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : new Date().toISOString(),
          raw: status,
          businessAccountId:entry.id,
          phoneNumberId:value.metadata?.phone_number_id
        });
      }
    }
  }
  return events;
}
