import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { all, get, now, run } from './db.js';

const integrationKey = companyId => `integration:meta-whatsapp:${Number(companyId) || 1}`;
const marketingKey = companyId => `integration:meta-marketing:${Number(companyId) || 1}`;

function key() {
  return createHash('sha256').update(process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'verde-local-integration-key').digest();
}

function encrypt(payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decrypt(value) {
  try {
    const [version, iv, tag, encrypted] = String(value || '').split('.');
    if (version !== 'v1') return {};
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8'));
  } catch {
    return {};
  }
}

function storedMetaConfig(companyId = 1) {
  return decrypt(get('SELECT value FROM settings WHERE key=?', [integrationKey(companyId)])?.value || (Number(companyId)===1 ? get('SELECT value FROM settings WHERE key=?',['integration:meta-whatsapp'])?.value : ''));
}

function persistMetaConfig(companyId, payload) {
  const encrypted = encrypt(payload);
  run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, [integrationKey(companyId), encrypted, now()]);
  if (Number(companyId) === 1) run(`INSERT INTO settings (key,value,updated_at) VALUES ('integration:meta-whatsapp',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, [encrypted, now()]);
}

function storedMetaMarketingConfig(companyId = 1) {
  return decrypt(get('SELECT value FROM settings WHERE key=?', [marketingKey(companyId)])?.value || '');
}

function persistMetaMarketingConfig(companyId, payload) {
  run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, [marketingKey(companyId), encrypt(payload), now()]);
}

function storedMarketingConfigs() {
  return all("SELECT key,value FROM settings WHERE key LIKE 'integration:meta-marketing:%'")
    .map(row => ({ companyId:Number(row.key.split(':').at(-1)), config:decrypt(row.value) }))
    .filter(item => Number.isInteger(item.companyId));
}

export function metaMarketingConfig(companyId = 1) {
  const stored = storedMetaMarketingConfig(companyId);
  // Migração compatível: versões anteriores gravavam o OAuth de anúncios no
  // mesmo cofre do WhatsApp. Recuperamos essa conexão até o próximo login,
  // mas nunca usamos um token criado pelo novo Embedded Signup como Ads.
  const legacy = storedMetaConfig(companyId);
  const legacyAccessToken = !stored.accessToken && legacy.accessToken && !legacy.onboardingMethod && !legacy.phoneNumberId && !legacy.businessAccountId ? legacy.accessToken : '';
  return {
    accessToken: stored.accessToken || legacyAccessToken || '',
    apiVersion: stored.apiVersion || process.env.WHATSAPP_API_VERSION || 'v23.0',
    connectedAt: stored.connectedAt || null,
    permissions: Array.isArray(stored.permissions) ? stored.permissions : [],
    pages: Array.isArray(stored.pages) ? stored.pages : [],
    accounts: Array.isArray(stored.accounts) ? stored.accounts : [],
    adSnapshots: Array.isArray(stored.adSnapshots) ? stored.adSnapshots : [],
    selectedBusinessId: stored.selectedBusinessId || '',
    lastSyncedAt: stored.lastSyncedAt || null,
    syncError: stored.syncError || null
  };
}

export function metaConfig(companyId = 1) {
  const stored = storedMetaConfig(companyId);
  const allowEnvironmentFallback = Number(companyId) === 1;
  return {
    accessToken: stored.accessToken || (allowEnvironmentFallback ? String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim() : ''),
    phoneNumberId: stored.phoneNumberId || (allowEnvironmentFallback ? String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim() : ''),
    businessAccountId: stored.businessAccountId || (allowEnvironmentFallback ? String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim() : ''),
    appSecret: stored.appSecret || (allowEnvironmentFallback ? String(process.env.WHATSAPP_APP_SECRET || '').trim() : '') || String(process.env.META_APP_SECRET || '').trim(),
    verifyToken: stored.verifyToken || String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim(),
    apiVersion: stored.apiVersion || String(process.env.WHATSAPP_API_VERSION || 'v23.0').trim(),
    connectedAt: stored.connectedAt || null,
    verifiedName: stored.verifiedName || null,
    displayPhoneNumber: stored.displayPhoneNumber || null,
    qualityRating: stored.qualityRating || null,
    webhooksSubscribed: Boolean(stored.webhooksSubscribed),
    lastCheckedAt: stored.lastCheckedAt || null,
    registrationPin: stored.registrationPin || null,
    onboardingMethod: stored.onboardingMethod || null
  };
}

function storedCompanyConfigs() {
  return all("SELECT key,value FROM settings WHERE key LIKE 'integration:meta-whatsapp:%'").map(row=>({companyId:Number(row.key.split(':').at(-1)),config:decrypt(row.value)})).filter(item=>Number.isInteger(item.companyId));
}

export function companyForMetaIdentifiers({phoneNumberId='',businessAccountId=''}={}) {
  const phone=String(phoneNumberId||'');const waba=String(businessAccountId||'');
  for(const item of storedCompanyConfigs())if((phone&&String(item.config.phoneNumberId||'')===phone)||(waba&&String(item.config.businessAccountId||'')===waba))return item.companyId;
  const primary=metaConfig(1);if((phone&&String(primary.phoneNumberId||'')===phone)||(waba&&String(primary.businessAccountId||'')===waba))return 1;
  return null;
}

export function companyForMetaWebhook(payload={}) {
  for(const entry of payload.entry||[]){for(const change of entry.changes||[]){const phoneNumberId=change.value?.metadata?.phone_number_id;const companyId=companyForMetaIdentifiers({phoneNumberId,businessAccountId:entry.id});if(companyId)return companyId;}}
  return null;
}

export function acceptsMetaVerifyToken(token) {
  const supplied=String(token||'');if(!supplied)return false;
  const environmentToken=String(process.env.WHATSAPP_VERIFY_TOKEN||'').trim();
  if(environmentToken&&supplied===environmentToken)return true;
  return storedCompanyConfigs().some(item=>item.config.verifyToken&&supplied===item.config.verifyToken)||supplied===metaConfig(1).verifyToken;
}

export function metaIsConfigured(companyId = 1) {
  const config = metaConfig(companyId);
  return Boolean(config.accessToken && config.phoneNumberId && config.businessAccountId && config.appSecret && config.verifyToken && config.connectedAt && config.webhooksSubscribed);
}

export function publicMetaConfig(companyId = 1) {
  const config = metaConfig(companyId);
  const marketing = metaMarketingConfig(companyId);
  return {
    connected: metaIsConfigured(companyId),
    oauth_connected: Boolean(marketing.accessToken),
    marketing_connected_at: marketing.connectedAt,
    marketing_last_synced_at: marketing.lastSyncedAt,
    marketing_sync_error: marketing.syncError,
    ad_accounts_connected: marketing.accounts.length,
    pages_connected: marketing.pages.length,
    lead_pages_subscribed: marketing.pages.filter(page => page.leadWebhookSubscribed).length,
    phone_number_id: config.phoneNumberId ? `••••${config.phoneNumberId.slice(-4)}` : null,
    business_account_id: config.businessAccountId ? `••••${config.businessAccountId.slice(-4)}` : null,
    verified_name: config.verifiedName,
    display_phone_number: config.displayPhoneNumber,
    quality_rating: config.qualityRating,
    connected_at: config.connectedAt,
    webhooks_subscribed: config.webhooksSubscribed,
    last_checked_at: config.lastCheckedAt,
    whatsapp_last_synced_at: storedMetaConfig(companyId).lastAnalyticsSyncedAt || null,
    whatsapp_sync_error: storedMetaConfig(companyId).analyticsSyncError || null,
    provider: config.accessToken && config.phoneNumberId ? 'meta_cloud_api' : null,
    onboarding_method: config.onboardingMethod,
    two_step_pin_configured: Boolean(config.registrationPin),
    verify_token_configured: Boolean(config.verifyToken),
    api_version: config.apiVersion
  };
}

function clean(input, max = 1000) {
  return String(input || '').trim().slice(0, max);
}

export function saveMetaConfig(input, companyId = 1) {
  const current = storedMetaConfig(companyId);
  const next = {
    accessToken: clean(input.access_token, 4096) || current.accessToken || '',
    phoneNumberId: clean(input.phone_number_id, 40) || current.phoneNumberId || '',
    businessAccountId: clean(input.business_account_id, 40) || current.businessAccountId || '',
    appSecret: clean(input.app_secret, 512) || current.appSecret || process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || '',
    verifyToken: clean(input.verify_token, 256) || current.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || randomBytes(24).toString('base64url'),
    apiVersion: /^v\d+\.\d+$/.test(clean(input.api_version, 12)) ? clean(input.api_version, 12) : current.apiVersion || 'v23.0',
    connectedAt: current.connectedAt || null,
    verifiedName: current.verifiedName || null,
    displayPhoneNumber: current.displayPhoneNumber || null,
    qualityRating: current.qualityRating || null,
    webhooksSubscribed: Boolean(current.webhooksSubscribed),
    lastCheckedAt: current.lastCheckedAt || null,
    onboardingMethod: current.onboardingMethod || 'manual'
  };
  if (!/^\d+$/.test(next.phoneNumberId)) throw Object.assign(new Error('Phone Number ID inválido'), { statusCode: 400 });
  if (next.businessAccountId && !/^\d+$/.test(next.businessAccountId)) throw Object.assign(new Error('Business Account ID inválido'), { statusCode: 400 });
  if (!next.accessToken || !next.appSecret || !next.verifyToken) throw Object.assign(new Error('Preencha token, App Secret e token de verificação'), { statusCode: 400 });
  persistMetaConfig(companyId, next);
  return publicMetaConfig(companyId);
}

export async function testMetaConnection(companyId = 1) {
  const config = metaConfig(companyId);
  if (!config.accessToken || !config.phoneNumberId || !config.businessAccountId) throw Object.assign(new Error('Informe token, Phone Number ID e WABA ID antes de testar.'), { statusCode: 400 });
  const fields = 'display_phone_number,verified_name,quality_rating';
  const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}?fields=${encodeURIComponent(fields)}`, {
    headers: { Authorization: `Bearer ${config.accessToken}` }
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || 'A Meta recusou as credenciais'), { statusCode: 400 });
  let webhooksSubscribed=false;
  if(config.businessAccountId){const subscription=await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.businessAccountId}/subscribed_apps`,{method:'POST',headers:{Authorization:`Bearer ${config.accessToken}`}});const subscriptionPayload=await subscription.json().catch(()=>({}));if(!subscription.ok)throw Object.assign(new Error(subscriptionPayload?.error?.message||'O número foi validado, mas a Meta recusou a inscrição do webhook.'),{statusCode:400});webhooksSubscribed=subscriptionPayload.success===true||subscriptionPayload.success==='true';}
  const stored = storedMetaConfig(companyId);
  const next = { ...stored, connectedAt: now(), lastCheckedAt:now(), webhooksSubscribed, verifiedName: payload.verified_name || null, displayPhoneNumber: payload.display_phone_number || null, qualityRating: payload.quality_rating || null };
  persistMetaConfig(companyId, next);
  const end=new Date().toISOString().slice(0,10);const startDate=new Date();startDate.setDate(startDate.getDate()-29);
  let initialSync;try{initialSync=await syncMetaAnalytics(startDate.toISOString().slice(0,10),end,companyId);}catch(error){persistMetaConfig(companyId,{...storedMetaConfig(companyId),analyticsSyncError:error.message,lastAnalyticsSyncAttemptAt:now()});initialSync={synced:false,points:0,warning:error.message};}
  return {...publicMetaConfig(companyId),initial_sync:initialSync};
}

export async function syncMetaAnalytics(start, end, companyId = 1) {
  const config = metaConfig(companyId);
  if (!config.accessToken || !config.businessAccountId) throw Object.assign(new Error('Informe também o Business Account ID para sincronizar métricas'), { statusCode: 400 });
  const startUnix = Math.floor(new Date(`${start}T00:00:00Z`).getTime() / 1000);
  const endUnix = Math.floor(new Date(`${end}T23:59:59Z`).getTime() / 1000);
  const analytics = `analytics.start(${startUnix}).end(${endUnix}).granularity(DAY)`;
  const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.businessAccountId}?fields=${encodeURIComponent(analytics)}`, { headers: { Authorization: `Bearer ${config.accessToken}` } });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || 'Não foi possível obter as métricas da Meta'), { statusCode: 400 });
  for (const point of payload.analytics?.data || []) {
    const date = new Date(Number(point.start || point.start_time || 0) * 1000).toISOString().slice(0, 10);
    const values = point.data_points?.[0] || point;
    run(`INSERT INTO company_meta_metrics_daily (company_id,date,conversations_started,messages_sent,messages_delivered,messages_read,messages_received,spend_cents,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,date) DO UPDATE SET conversations_started=excluded.conversations_started,messages_sent=excluded.messages_sent,messages_delivered=excluded.messages_delivered,messages_read=excluded.messages_read,messages_received=excluded.messages_received,spend_cents=excluded.spend_cents,updated_at=excluded.updated_at`,
    [companyId,date, Number(values.conversation || values.conversations || 0), Number(values.sent || 0), Number(values.delivered || 0), Number(values.read || 0), Number(values.received || 0), Math.round(Number(values.cost || 0) * 100), now()]);
  }
  persistMetaConfig(companyId,{...storedMetaConfig(companyId),lastAnalyticsSyncedAt:now(),lastAnalyticsSyncAttemptAt:now(),analyticsSyncError:null});
  return { synced: true, points: payload.analytics?.data?.length || 0 };
}

export async function metaAdAccounts(companyId = 1) {
  const config = metaMarketingConfig(companyId);
  if (!config.accessToken) return [];
  const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/me/adaccounts?fields=id,name,account_status,currency,timezone_name&limit=100`, { headers: { Authorization: `Bearer ${config.accessToken}` } });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || 'Não foi possível listar as contas de anúncio.'), { statusCode: 400 });
  return payload.data || [];
}

export async function metaBusinesses(companyId = 1) {
  const config = metaMarketingConfig(companyId);
  if (!config.accessToken) return [];
  const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/me/businesses?fields=id,name,verification_status,created_time&limit=100`, { headers: { Authorization: `Bearer ${config.accessToken}` } });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || 'Não foi possível listar os portfólios empresariais.'), { statusCode: 400 });
  return (payload.data || []).map(item => ({ ...item, active: String(item.id) === String(config.selectedBusinessId || '') }));
}

export async function selectMetaBusiness(companyId = 1, businessId = '') {
  const businesses = await metaBusinesses(companyId);
  const selected = businesses.find(item => String(item.id) === String(businessId));
  if (!selected) throw Object.assign(new Error('Este portfólio empresarial não foi autorizado neste login.'), { statusCode: 404 });
  persistMetaMarketingConfig(companyId, { ...storedMetaMarketingConfig(companyId), selectedBusinessId: String(selected.id) });
  return { ...selected, active: true };
}

export async function metaAdCampaigns(companyId = 1, accountId) {
  const config = metaMarketingConfig(companyId);
  if (!config.accessToken) return [];
  const normalized = String(accountId || '').replace(/^act_/, '');
  if (!/^\d+$/.test(normalized)) throw Object.assign(new Error('Conta de anúncio inválida.'), { statusCode: 400 });
  const fields = 'id,name,status,effective_status,objective,start_time,stop_time';
  const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/act_${normalized}/campaigns?fields=${encodeURIComponent(fields)}&limit=200`, { headers: { Authorization: `Bearer ${config.accessToken}` } });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || 'Não foi possível listar as campanhas.'), { statusCode: 400 });
  return payload.data || [];
}

export async function metaPages(companyId = 1, includeTokens = false) {
  const config=metaMarketingConfig(companyId);if(!config.accessToken)return [];
  const response=await fetch(`https://graph.facebook.com/${config.apiVersion}/me/accounts?fields=id,name,category,access_token,instagram_business_account{id,username,name,profile_picture_url}&limit=100`,{headers:{Authorization:`Bearer ${config.accessToken}`}});const payload=await response.json();
  if(!response.ok)throw Object.assign(new Error(payload?.error?.message||'Não foi possível listar as páginas.'),{statusCode:400});
  return (payload.data||[]).map(page=>({id:page.id,name:page.name,category:page.category,instagram:page.instagram_business_account||null,...(includeTokens?{access_token:page.access_token}:{})}));
}

export async function metaLeadForms(companyId = 1, pageId) {
  const pages=await metaPages(companyId,true);const page=pages.find(item=>String(item.id)===String(pageId));if(!page)throw Object.assign(new Error('Página não autorizada.'),{statusCode:404});
  const config=metaMarketingConfig(companyId);const response=await fetch(`https://graph.facebook.com/${config.apiVersion}/${page.id}/leadgen_forms?fields=id,name,status,created_time,leads_count&limit=100`,{headers:{Authorization:`Bearer ${page.access_token||config.accessToken}`}});const payload=await response.json();
  if(!response.ok)throw Object.assign(new Error(payload?.error?.message||'Não foi possível listar os formulários de lead.'),{statusCode:400});return payload.data||[];
}

export async function metaAdsInsights(companyId, accountId, start, end, campaignId = '') {
  const config = metaMarketingConfig(companyId);
  if (!config.accessToken) throw Object.assign(new Error('Conecte sua conta da Meta primeiro.'), { statusCode: 400 });
  const normalized = String(accountId || '').replace(/^act_/, '');
  if (!/^\d+$/.test(normalized)) throw Object.assign(new Error('Conta de anúncio inválida.'), { statusCode: 400 });
  const fields = 'date_start,date_stop,impressions,reach,clicks,spend,cpc,cpm,ctr,actions,cost_per_action_type';
  const params = new URLSearchParams({ fields, time_increment: '1', time_range: JSON.stringify({ since: start, until: end }), limit: '500' });
  if (campaignId) params.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'EQUAL', value: String(campaignId) }]));
  const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/act_${normalized}/insights?${params}`, { headers: { Authorization: `Bearer ${config.accessToken}` } });
  const payload = await response.json();
  if (!response.ok) {
    const cached=config.adSnapshots.find(item=>item.account_id===`act_${normalized}`);
    if(cached)return {...cached,cached:true,warning:payload?.error?.message||'Exibindo a última sincronização disponível.'};
    throw Object.assign(new Error(payload?.error?.message || 'Não foi possível carregar as métricas de anúncios.'), { statusCode: 400 });
  }
  const daily = payload.data || [];
  const sum = field => daily.reduce((total, row) => total + Number(row[field] || 0), 0);
  const firstAction = (row, types) => Number(types.map(type => (row.actions || []).find(action => action.action_type === type)?.value).find(value => value != null) || 0);
  const actionTotal = types => daily.reduce((total, row) => total + firstAction(row, types), 0);
  const totals = { impressions: sum('impressions'), reach: sum('reach'), clicks: sum('clicks'), spend: sum('spend'), leads: actionTotal(['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead']), purchases: actionTotal(['purchase','omni_purchase','offsite_conversion.fb_pixel_purchase']), messaging_conversations_started: actionTotal(['onsite_conversion.messaging_conversation_started_7d']) };
  totals.ctr = totals.impressions ? totals.clicks / totals.impressions * 100 : 0;
  totals.cpl = totals.leads ? totals.spend / totals.leads : 0;
  const adParams = new URLSearchParams({ fields: 'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,impressions,reach,clicks,spend,ctr,actions', level: 'ad', time_range: JSON.stringify({ since: start, until: end }), limit: '500' });
  if (campaignId) adParams.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'EQUAL', value: String(campaignId) }]));
  let ads=[];
  try {
    const adResponse=await fetch(`https://graph.facebook.com/${config.apiVersion}/act_${normalized}/insights?${adParams}`,{headers:{Authorization:`Bearer ${config.accessToken}`}});
    const adPayload=await adResponse.json();
    if(adResponse.ok)ads=(adPayload.data||[]).map(row=>{const leads=firstAction(row,['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead']);const purchases=firstAction(row,['purchase','omni_purchase','offsite_conversion.fb_pixel_purchase']);const spend=Number(row.spend||0);return {...row,impressions:Number(row.impressions||0),reach:Number(row.reach||0),clicks:Number(row.clicks||0),spend,ctr:Number(row.ctr||0),leads,purchases,cpl:leads?spend/leads:0};}).sort((a,b)=>(b.purchases-a.purchases)||(b.leads-a.leads)||(a.cpl-b.cpl));
  } catch {}
  const leads=all(`SELECT c.id,c.name,c.phone,c.email,c.company,c.created_at,c.custom_fields FROM contacts c WHERE c.company_id=? AND c.source='meta_ads' ORDER BY c.created_at DESC LIMIT 200`,[companyId]).map(item=>{let custom={};try{custom=JSON.parse(item.custom_fields||'{}')}catch{}return {id:item.id,name:item.name,phone:item.phone,email:item.email,company:item.company,created_at:item.created_at,campaign_id:custom.meta_campaign_id||null,campaign_name:custom.meta_campaign_name||null,ad_id:custom.meta_ad_id||null,ad_name:custom.meta_ad_name||null,form_id:custom.meta_form_id||null};}).filter(item=>!campaignId||String(item.campaign_id)===String(campaignId));
  const result={ account_id: `act_${normalized}`, campaign_id: campaignId || null, range: { start, end }, totals, daily, ads, leads, best_ad:ads[0]||null, synced_at:now() };
  const current=storedMetaMarketingConfig(companyId);const snapshots=(Array.isArray(current.adSnapshots)?current.adSnapshots:[]).filter(item=>item.account_id!==result.account_id);snapshots.push(result);
  persistMetaMarketingConfig(companyId,{...current,adSnapshots:snapshots.slice(-20),lastSyncedAt:now(),syncError:null});
  return result;
}

export async function syncMetaMarketing(companyId = 1) {
  const accounts=await metaAdAccounts(companyId);const pages=await metaPages(companyId,true);
  const end=new Date().toISOString().slice(0,10);const startDate=new Date();startDate.setDate(startDate.getDate()-29);const start=startDate.toISOString().slice(0,10);
  const reports=await Promise.allSettled(accounts.slice(0,10).map(account=>metaAdsInsights(companyId,account.id,start,end)));
  const current=storedMetaMarketingConfig(companyId);const previousPages=Array.isArray(current.pages)?current.pages:[];
  const mergedPages=pages.map(page=>({...previousPages.find(item=>String(item.id)===String(page.id)),...page}));
  const failures=reports.filter(result=>result.status==='rejected');
  persistMetaMarketingConfig(companyId,{...storedMetaMarketingConfig(companyId),accounts,pages:mergedPages,lastSyncedAt:now(),syncError:failures.length?`${failures.length} conta(s) de anúncio não puderam ser atualizadas.`:null});
  return {synced:true,accounts:accounts.length,pages:pages.length,reports:reports.filter(result=>result.status==='fulfilled').length,warnings:failures.length};
}

function oauthState(payload) { const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');const signature=createHmac('sha256',key()).update(encoded).digest('base64url');return `${encoded}.${signature}`; }
function parseOauthState(value) { const [encoded,signature]=String(value||'').split('.');const expected=createHmac('sha256',key()).update(encoded||'').digest();const received=Buffer.from(signature||'','base64url');if(!encoded||received.length!==expected.length||!timingSafeEqual(received,expected))throw Object.assign(new Error('Estado OAuth inválido.'),{statusCode:400});const payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));if(payload.expires<Date.now())throw Object.assign(new Error('Autorização expirada.'),{statusCode:400});return payload; }
function metaOauthConfig(){
  const requested=String(process.env.META_OAUTH_SCOPES||'ads_read,business_management,pages_show_list,pages_read_engagement').split(',').map(scope=>scope.trim()).filter(Boolean);
  // A Meta rejeita o diálogo inteiro quando leads_retrieval ainda não foi liberado
  // para o aplicativo. Mantemos a conexão básica funcional e habilitamos leads
  // somente após a aprovação explícita no painel da Meta.
  const allowLeadRetrieval=process.env.META_ENABLE_LEADS_RETRIEVAL==='true';
  const guarded=new Set(['leads_retrieval','pages_manage_metadata']);
  const scopes=[...new Set(requested.filter(scope=>!guarded.has(scope)||allowLeadRetrieval).concat(allowLeadRetrieval?['leads_retrieval','pages_manage_metadata']:[]))].join(',');
  const legacyConfigId=String(process.env.META_BUSINESS_LOGIN_CONFIG_ID||'').trim();
  const publicUrl=String(process.env.PUBLIC_URL||'https://atenva.vercel.app').trim().replace(/\/+$/,'');
  return {
    appId:String(process.env.META_APP_ID||'').trim(),
    appSecret:String(process.env.META_APP_SECRET||process.env.WHATSAPP_APP_SECRET||'').trim(),
    redirectUri:String(process.env.META_REDIRECT_URI||`${publicUrl}/api/integrations/meta/callback`).trim(),
    apiVersion:String(process.env.WHATSAPP_API_VERSION||'v23.0').trim(),
    // O login de Marketing e o Embedded Signup são configurações diferentes
    // no painel da Meta. Compartilhar um único ID faz o botão do WhatsApp abrir
    // somente ativos de anúncios, sem devolver WABA e número de telefone.
    marketingLoginConfigId:String(process.env.META_MARKETING_LOGIN_CONFIG_ID||legacyConfigId).trim(),
    whatsappEmbeddedSignupConfigId:String(process.env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID||'').trim(),
    techProviderApproved:process.env.META_TECH_PROVIDER_APPROVED==='true',
    scopes,
    leadRetrievalEnabled:allowLeadRetrieval&&requested.includes('leads_retrieval')
  };
}
export function metaOauthStatus(){const cfg=metaOauthConfig();return {
  configured:Boolean(cfg.appId&&cfg.appSecret),
  redirect_uri:cfg.redirectUri,
  lead_retrieval_enabled:cfg.leadRetrievalEnabled,
  app_id:cfg.appId,
  api_version:cfg.apiVersion,
  marketing_login_config_id:cfg.marketingLoginConfigId,
  whatsapp_embedded_signup_config_id:cfg.whatsappEmbeddedSignupConfigId,
  tech_provider_approved:cfg.techProviderApproved,
  // Mantém o contrato do cliente web durante a migração.
  business_login_config_id:cfg.whatsappEmbeddedSignupConfigId,
  marketing_login_configured:Boolean(cfg.appId&&cfg.appSecret),
  embedded_signup_configured:Boolean(cfg.appId&&cfg.appSecret&&cfg.whatsappEmbeddedSignupConfigId&&cfg.techProviderApproved)
};}
export function metaAuthorizationUrl(user,redirectUriOverride=''){const cfg=metaOauthConfig();if(!cfg.appId||!cfg.appSecret)throw Object.assign(new Error('O login Meta ainda não foi configurado pelo administrador.'),{statusCode:503});const redirectUri=String(redirectUriOverride||cfg.redirectUri).trim();const params=new URLSearchParams({client_id:cfg.appId,redirect_uri:redirectUri,response_type:'code',state:oauthState({userId:user.id,companyId:user.companyId,redirectUri,expires:Date.now()+10*60_000,nonce:randomBytes(10).toString('hex')})});if(cfg.marketingLoginConfigId){params.set('config_id',cfg.marketingLoginConfigId);params.set('override_default_response_type','true');}else params.set('scope',cfg.scopes);return `https://www.facebook.com/${cfg.apiVersion}/dialog/oauth?${params}`;}
export async function completeMetaAuthorization({code,state,user}){const parsed=parseOauthState(state);if(Number(parsed.userId)!==Number(user.id)||Number(parsed.companyId)!==Number(user.companyId))throw Object.assign(new Error('Esta autorização pertence a outro perfil.'),{statusCode:403});const cfg=metaOauthConfig();const redirectUri=String(parsed.redirectUri||cfg.redirectUri).trim();const params=new URLSearchParams({client_id:cfg.appId,client_secret:cfg.appSecret,redirect_uri:redirectUri,code});const response=await fetch(`https://graph.facebook.com/${cfg.apiVersion}/oauth/access_token?${params}`);const token=await response.json();if(!response.ok)throw Object.assign(new Error(token.error?.message||'A Meta recusou a autorização.'),{statusCode:400});persistMetaMarketingConfig(user.companyId,{...storedMetaMarketingConfig(user.companyId),accessToken:token.access_token,apiVersion:cfg.apiVersion,connectedAt:now()});if(cfg.leadRetrievalEnabled)await activateMetaLeadRetrieval(user.companyId);let initialSync;try{initialSync=await syncMetaMarketing(user.companyId);}catch(error){persistMetaMarketingConfig(user.companyId,{...storedMetaMarketingConfig(user.companyId),syncError:error.message,lastSyncAttemptAt:now()});initialSync={synced:false,accounts:0,pages:0,reports:0,warning:error.message};}return {...publicMetaConfig(user.companyId),initial_sync:initialSync};}

export function verifyMetaLeadSignature(rawBody, signature) {
  const secret=String(process.env.META_APP_SECRET||'').trim();
  if(!secret||!signature?.startsWith('sha256='))return false;
  const expected=createHmac('sha256',secret).update(rawBody).digest();
  const received=Buffer.from(signature.slice(7),'hex');
  return received.length===expected.length&&timingSafeEqual(received,expected);
}

export function verifyMetaLeadChallenge(query={}) {
  const expected=String(process.env.META_LEADS_VERIFY_TOKEN||process.env.WHATSAPP_VERIFY_TOKEN||'').trim();
  return query['hub.mode']==='subscribe'&&expected&&query['hub.verify_token']===expected ? String(query['hub.challenge']||'') : null;
}

export function companyForMetaPage(pageId) {
  const target=String(pageId||'');
  return storedMarketingConfigs().find(item=>item.config.pages?.some(page=>String(page.id)===target))?.companyId||null;
}

export async function activateMetaLeadRetrieval(companyId = 1) {
  const cfg=metaOauthConfig();
  if(!cfg.leadRetrievalEnabled)throw Object.assign(new Error('A permissão leads_retrieval ainda não foi liberada para este aplicativo na Meta.'),{statusCode:409});
  const marketing=metaMarketingConfig(companyId);
  if(!marketing.accessToken)throw Object.assign(new Error('Conecte a conta Meta antes de ativar os leads.'),{statusCode:400});
  const pages=await metaPages(companyId,true);
  const saved=[];
  for(const page of pages){
    const result=await graphJson(`https://graph.facebook.com/${marketing.apiVersion}/${encodeURIComponent(page.id)}/subscribed_apps?subscribed_fields=leadgen`,{method:'POST',headers:{Authorization:`Bearer ${page.access_token||marketing.accessToken}`}},`Não foi possível ativar leads da página ${page.name}.`);
    saved.push({...page,leadWebhookSubscribed:result.success===true||result.success==='true'});
  }
  persistMetaMarketingConfig(companyId,{...storedMetaMarketingConfig(companyId),accessToken:marketing.accessToken,apiVersion:marketing.apiVersion,connectedAt:marketing.connectedAt||now(),pages:saved,leadsActivatedAt:now()});
  return {active:saved.some(page=>page.leadWebhookSubscribed),pages:saved.map(({access_token,...page})=>page)};
}

export async function fetchMetaLead(companyId,pageId,leadgenId) {
  const marketing=metaMarketingConfig(companyId);
  const page=marketing.pages.find(item=>String(item.id)===String(pageId));
  if(!page?.access_token)throw Object.assign(new Error('A página do lead não está vinculada a esta empresa.'),{statusCode:404});
  const fields='id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data,platform';
  return graphJson(`https://graph.facebook.com/${marketing.apiVersion}/${encodeURIComponent(String(leadgenId))}?fields=${encodeURIComponent(fields)}`,{headers:{Authorization:`Bearer ${page.access_token}`}},'Não foi possível recuperar os dados deste lead na Meta.');
}

async function graphJson(url, options, fallbackMessage) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || fallbackMessage), { statusCode: 400, metaError: payload?.error || null });
  return payload;
}

export async function completeWhatsAppEmbeddedSignup({ code, wabaId, phoneNumberId, companyId = 1 }) {
  const cfg = metaOauthConfig();
  if (!cfg.appId || !cfg.appSecret || !cfg.whatsappEmbeddedSignupConfigId) throw Object.assign(new Error('O Embedded Signup ainda não foi configurado pela Atenva.'), { statusCode: 503 });
  if (!String(code || '').trim()) throw Object.assign(new Error('A Meta não devolveu o código de autorização.'), { statusCode: 400 });
  if (!/^\d+$/.test(String(wabaId || '')) || !/^\d+$/.test(String(phoneNumberId || ''))) throw Object.assign(new Error('A Meta não devolveu uma conta WhatsApp e um número válidos.'), { statusCode: 400 });

  const tokenParams = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, code: String(code) });
  const token = await graphJson(`https://graph.facebook.com/${cfg.apiVersion}/oauth/access_token?${tokenParams}`, {}, 'Não foi possível concluir o login do WhatsApp.');
  if (!token.access_token) throw Object.assign(new Error('A Meta não devolveu uma credencial de acesso.'), { statusCode: 400 });
  const headers = { Authorization: `Bearer ${token.access_token}` };

  await graphJson(`https://graph.facebook.com/${cfg.apiVersion}/${encodeURIComponent(String(wabaId))}?fields=id,name`, { headers }, 'A conta WhatsApp selecionada não está acessível.');
  const phones = await graphJson(`https://graph.facebook.com/${cfg.apiVersion}/${encodeURIComponent(String(wabaId))}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=100`, { headers }, 'Não foi possível consultar os números desta conta WhatsApp.');
  const phone = (phones.data || []).find(item => String(item.id) === String(phoneNumberId));
  if (!phone) throw Object.assign(new Error('O número selecionado não pertence à conta WhatsApp autorizada.'), { statusCode: 403 });

  const subscription = await graphJson(`https://graph.facebook.com/${cfg.apiVersion}/${encodeURIComponent(String(wabaId))}/subscribed_apps`, { method: 'POST', headers }, 'A Meta recusou a ativação do webhook para esta conta.');
  if (!(subscription.success === true || subscription.success === 'true')) throw Object.assign(new Error('A Meta não confirmou a ativação do webhook.'), { statusCode: 400 });

  const current = storedMetaConfig(companyId);
  const sameRegisteredNumber = String(current.phoneNumberId || '') === String(phoneNumberId) && Boolean(current.registrationPin);
  const registrationPin = sameRegisteredNumber ? current.registrationPin : String(randomInt(100000, 1000000));
  if (!sameRegisteredNumber) await graphJson(`https://graph.facebook.com/${cfg.apiVersion}/${encodeURIComponent(String(phoneNumberId))}/register`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin: registrationPin })
  }, 'O número foi autorizado, mas não pôde ser registrado na Cloud API.');

  persistMetaConfig(companyId, {
    ...current,
    accessToken: token.access_token,
    phoneNumberId: String(phoneNumberId),
    businessAccountId: String(wabaId),
    appSecret: cfg.appSecret,
    verifyToken: current.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || randomBytes(24).toString('base64url'),
    apiVersion: cfg.apiVersion,
    connectedAt: now(),
    lastCheckedAt: now(),
    webhooksSubscribed: true,
    verifiedName: phone.verified_name || null,
    displayPhoneNumber: phone.display_phone_number || null,
    qualityRating: phone.quality_rating || null,
    registrationPin,
    onboardingMethod: 'embedded_signup'
  });
  const end=new Date().toISOString().slice(0,10);const startDate=new Date();startDate.setDate(startDate.getDate()-29);
  let initialSync;try{initialSync=await syncMetaAnalytics(startDate.toISOString().slice(0,10),end,companyId);}catch(error){persistMetaConfig(companyId,{...storedMetaConfig(companyId),analyticsSyncError:error.message,lastAnalyticsSyncAttemptAt:now()});initialSync={synced:false,points:0,warning:error.message};}
  return {...publicMetaConfig(companyId),initial_sync:initialSync};
}

export async function disconnectWhatsAppOfficial(companyId = 1) {
  const config = metaConfig(companyId);
  if (config.accessToken && config.businessAccountId) {
    await fetch(`https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(config.businessAccountId)}/subscribed_apps`, { method: 'DELETE', headers: { Authorization: `Bearer ${config.accessToken}` } }).catch(() => null);
  }
  persistMetaConfig(companyId, { appSecret: process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET || '', verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || randomBytes(24).toString('base64url'), apiVersion: config.apiVersion });
  return publicMetaConfig(companyId);
}
