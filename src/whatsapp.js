import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { acceptsMetaVerifyToken, companyForMetaWebhook, metaConfig, metaIsConfigured } from './integrations.js';
import { evolutionIsConfigured, sendEvolutionAudio, sendEvolutionText } from './evolution.js';
import { get } from './db.js';

export function whatsappDeliveryStatus(companyId=1) {
  const cfg=config(companyId);
  const official=metaIsConfigured(companyId);
  const evolution=evolutionIsConfigured(companyId);
  const simulated=process.env.WHATSAPP_SIMULATE==='true' && process.env.NODE_ENV!=='production';
  return {configured:official||evolution,provider:official?'meta':evolution?'evolution':simulated?'simulation':null,simulated,
    credentials_present:Boolean(cfg.token&&cfg.phoneNumberId)};
}

function simulationOrThrow(companyId) {
  if(whatsappDeliveryStatus(companyId).simulated)return {simulated:true,id:`simulation-${randomUUID()}`,status:'queued'};
  throw Object.assign(new Error('WhatsApp desconectado. Conecte e valide um número antes de enviar mensagens.'),{statusCode:503,code:'WHATSAPP_NOT_CONNECTED',retryable:false});
}

export function customerWindowIsOpen(value,at=Date.now()) {
  if(!value)return false;
  const timestamp=String(value).trim();
  const milliseconds=Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(timestamp)?timestamp:timestamp.replace(' ','T')+'Z');
  return Number.isFinite(milliseconds)&&milliseconds>at;
}

function validateRecipient(to,companyId,{template=false,conversationId}={}) {
  if(!/^\d{10,15}$/.test(String(to)))throw Object.assign(new Error('Telefone de destino inválido.'),{statusCode:400,retryable:false});
  const contact=get(`SELECT * FROM contacts WHERE company_id=? AND (whatsapp_id=? OR replace(replace(replace(replace(replace(phone,'+',''),' ',''),'-',''),'(',''),')','')=?)`,[companyId,String(to),String(to)]);
  if(contact?.consent_status==='revoked')throw Object.assign(new Error('Contato recusou o recebimento de mensagens.'),{statusCode:400,retryable:false});
  if(!template && metaIsConfigured(companyId)){
    const conversation=contact && (conversationId ? get('SELECT customer_window_until FROM conversations WHERE id=? AND contact_id=?',[conversationId,contact.id]) : get('SELECT customer_window_until FROM conversations WHERE contact_id=? ORDER BY id DESC LIMIT 1',[contact.id]));
    if(!customerWindowIsOpen(conversation?.customer_window_until))
      throw Object.assign(new Error('Janela de atendimento encerrada. Use um modelo aprovado pela Meta para retomar o contato.'),{statusCode:400,code:'WHATSAPP_WINDOW_CLOSED',retryable:false});
  }
}

async function providerRequest(url,options) {
  let response;
  try{response=await fetch(url,{...options,signal:AbortSignal.timeout(20_000)});}
  catch(error){throw Object.assign(new Error('Não foi possível confirmar o envio. Confira o histórico do WhatsApp antes de reenviar.'),{cause:error,code:'DELIVERY_UNKNOWN',retryable:false});}
  let result;
  try{result=await response.json();}catch{throw Object.assign(new Error('O provedor não confirmou o resultado do envio.'),{code:'DELIVERY_UNKNOWN',retryable:false});}
  if(!response.ok)throw Object.assign(new Error(result?.error?.message||'Falha ao enviar mensagem pelo WhatsApp'),{upstreamStatus:response.status,retryable:response.status===429||response.status>=500});
  if(!result.messages?.[0]?.id)throw Object.assign(new Error('O provedor não retornou o identificador da mensagem.'),{code:'DELIVERY_UNKNOWN',retryable:false});
  return {simulated:false,id:result.messages[0].id,status:'sent',raw:result};
}

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

export async function sendWhatsAppText(to, body, companyId = 1, options = {}) {
  validateRecipient(to,companyId,options);
  if(!String(body||'').trim())throw Object.assign(new Error('Mensagem vazia.'),{statusCode:400,retryable:false});
  if (!metaIsConfigured(companyId) && evolutionIsConfigured(companyId)) return sendEvolutionText(to, body, companyId);
  const cfg = config(companyId);
  if (!cfg.token || !cfg.phoneNumberId) {
    return simulationOrThrow(companyId);
  }
  if(!metaIsConfigured(companyId))return simulationOrThrow(companyId);

  return providerRequest(
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

}

export async function sendWhatsAppAudio(to, audioBase64, companyId = 1, mimeType = 'audio/ogg') {
  validateRecipient(to,companyId);
  if (!metaIsConfigured(companyId) && evolutionIsConfigured(companyId)) return sendEvolutionAudio(to, audioBase64, companyId);
  const cfg=config(companyId);if(!metaIsConfigured(companyId))throw Object.assign(new Error('Conecte o WhatsApp oficial antes de enviar áudio.'),{statusCode:503});
  const mediaType=String(mimeType).split(';')[0];
  const extensions={'audio/ogg':'ogg','audio/mp4':'m4a','audio/aac':'aac','audio/mpeg':'mp3','audio/amr':'amr'};
  if(!extensions[mediaType])throw Object.assign(new Error('Formato de áudio não suportado pelo WhatsApp. Use OGG, M4A, AAC, MP3 ou AMR.'),{statusCode:400});
  const raw=String(audioBase64||'').replace(/^data:[^;]+;base64,/,'');const bytes=Buffer.from(raw,'base64');if(!bytes.length)throw Object.assign(new Error('Áudio vazio.'),{statusCode:400});
  const form=new FormData();form.set('messaging_product','whatsapp');form.set('type',mediaType);form.set('file',new Blob([bytes],{type:mediaType}),`audio.${extensions[mediaType]}`);
  const upload=await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/media`,{method:'POST',headers:{Authorization:`Bearer ${cfg.token}`},body:form});const uploaded=await upload.json();if(!upload.ok||!uploaded.id)throw new Error(uploaded?.error?.message||'Falha ao enviar o áudio para a Meta.');
  return providerRequest(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`,{method:'POST',headers:{Authorization:`Bearer ${cfg.token}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to,type:'audio',audio:{id:uploaded.id}})});
}

export async function sendWhatsAppTemplate(to, template, companyId = 1) {
  validateRecipient(to,companyId,{template:true});
  const cfg = config(companyId);
  if (!cfg.token || !cfg.phoneNumberId) {
    return simulationOrThrow(companyId);
  }
  if(!metaIsConfigured(companyId))return simulationOrThrow(companyId);
  const variables = Array.isArray(template.variables) ? template.variables.filter(value => value !== undefined && value !== null).map(value => String(value)) : [];
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: template.name, language: { code: template.language || 'pt_BR' } }
  };
  if (variables.length) payload.template.components = [{ type: 'body', parameters: variables.map(text => ({ type: 'text', text })) }];
  return providerRequest(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
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
