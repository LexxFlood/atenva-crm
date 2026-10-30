import { createRelationshipModule } from './relationships.js';

const state = {
  user: null,
  view: 'overview',
  dashboard: null,
  conversations: [],
  selectedConversation: null,
  pipeline: null,
  contacts: [],
  tasks: [],
  taskOwnerFilter: '',
  taskRange: null,
  users: [],
  pipelines: [],
  selectedPipelineId: null,
  dashboardPreferences: null,
  dashboardRange: null,
  qualification: null,
  knowledge: [],
  agentConfig: null,
  agentRuns: [],
  agentLearning: [],
  agentCommandSessions: [],
  agentCommandSessionId: null,
  companies: [],
  invitations: [],
  selectedCampaignId: null,
  selectedContacts: new Set(),
  relationshipSelected: new Set(),
  relationshipFilter: 'all',
  selectedTasks: new Set(),
  taskView: 'list',
  taskCalendarDate: new Date(),
  trafficChart: 'bars',
  funnelOrientation: 'vertical',
  inboxRequestId: 0,
  conversationsLoadedAt: 0,
  sidebarCollapsed: localStorage.getItem('atenva-sidebar-preference-v2') == null
    ? window.innerWidth > 820 && window.innerWidth <= 1120
    : localStorage.getItem('atenva-sidebar-preference-v2') === 'true'
};
let scheduledMessageHeartbeat = null;
let liveHeartbeat = null;
let liveInFlight = false;
let liveRetryAt = 0;
let liveFailures = 0;
let liveSignature = '';
let liveViewRefreshAt = 0;
const notifiedHandoffs = new Set();

function resetCompanyScopedState() {
  liveSignature = '';
  notifiedHandoffs.clear();
  state.dashboard = null;
  state.dashboardPreferences = null;
  state.dashboardRange = null;
  state.conversations = [];
  state.conversationsLoadedAt = 0;
  state.inboxRequestId += 1;
  state.selectedConversation = null;
  state.pipeline = null;
  state.pipelines = [];
  state.selectedPipelineId = null;
  state.contacts = [];
  state.tasks = [];
  state.taskRange = null;
  state.users = [];
  state.qualification = null;
  state.knowledge = [];
  state.agentConfig = null;
  state.agentRuns = [];
  state.agentLearning = [];
  state.agentCommandSessions = [];
  state.agentCommandSessionId = null;
  state.invitations = [];
  state.selectedCampaignId = null;
  state.selectedContacts.clear();
  state.relationshipSelected.clear();
  state.selectedTasks.clear();
}

const entryProfiles = {
  '/mais-tracao': { slug: 'mais-tracao', title: 'Mais Tração · Gestão de Tráfego', description: 'Acesse o CRM da Mais Tração para acompanhar mídia, leads e oportunidades.' },
  '/gestao-mais-tracao': { slug: 'mais-tracao', title: 'Mais Tração · Gestão de Tráfego', description: 'Acesse o CRM da Mais Tração para acompanhar mídia, leads e oportunidades.' },
  '/mais-tracao-gestao-de-trafego': { slug: 'mais-tracao', title: 'Mais Tração · Gestão de Tráfego', description: 'Acesse o CRM da Mais Tração para acompanhar mídia, leads e oportunidades.' },
  '/produtora-mais-tracao': { slug: 'produtora-mais-tracao', title: 'Produtora Mais Tração', description: 'Acesse o CRM da Produtora Mais Tração para acompanhar projetos, leads e oportunidades.' }
};

const reservedEntryPaths = new Set(['api','assets','favicon.ico','login','logout','admin','administracao','integracoes','convites','c','atenva']);

function entryProfile() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (entryProfiles[path]) return entryProfiles[path];
  const legacyDynamic = path.match(/^\/c\/([a-z0-9-]+)$/);
  if (legacyDynamic) return { slug: legacyDynamic[1], title: null, description: null, dynamic: true };
  const cleanDynamic = path.match(/^\/([a-z0-9-]+)$/);
  if (cleanDynamic && !reservedEntryPaths.has(cleanDynamic[1])) return { slug: cleanDynamic[1], title: null, description: null, dynamic: true };
  const hostname=location.hostname.toLowerCase();
  const hostIsIp=/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)||hostname.includes(':');
  const hostParts=hostname.split('.');
  const isAtenvaRoot=hostname==='atenva.com.br'||hostname==='www.atenva.com.br';
  if(path==='/'&&!hostIsIp&&!isAtenvaRoot&&hostParts.length>=3&&!hostname.endsWith('.vercel.app')&&!['www','app','api','hooks'].includes(hostParts[0]))return {slug:hostParts[0],title:null,description:null,dynamic:true,subdomain:true};
  if (path === '/' && location.hostname.startsWith('mais-tracao-atenva')) return entryProfiles['/gestao-mais-tracao'];
  return null;
}

async function applyEntryProfileBranding() {
  const profile = entryProfile();
  if (!profile) return;
  if (profile.dynamic) {
    try {
      const response = await fetch(`/api/public/companies/${encodeURIComponent(profile.slug)}`, { headers: { Accept: 'application/json' } });
      if (response.ok) {
        const company = await response.json();
        profile.title = company.name;
        profile.description = `Acesse o ambiente exclusivo da ${company.name} na Atenva.`;
      }
    } catch { /* a tela de login continua disponível com a marca Atenva */ }
  }
  if (!profile.title) return;
  document.title = `${profile.title} · Atenva`;
  const title = document.querySelector('#login-title');
  const description = document.querySelector('#login-description');
  if (title) title.textContent = `Bem-vindo à ${profile.title}`;
  if (description) description.textContent = profile.description;
}

let csrfToken = '';

const icons = {
  home: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  building: '<path d="M4 21V4h11v17M15 9h5v12M8 8h3M8 12h3M8 16h3M18 13h.01M18 17h.01M2 21h20"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
  pipeline: '<path d="M4 4v16M4 7h6a2 2 0 0 1 2 2v0a2 2 0 0 0 2 2h6M4 17h6a2 2 0 0 0 2-2v0a2 2 0 0 1 2-2h6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  spark: '<path d="m12 3-1.7 4.3L6 9l4.3 1.7L12 15l1.7-4.3L18 9l-4.3-1.7zM5 16l-.8 2.2L2 19l2.2.8L5 22l.8-2.2L8 19l-2.2-.8zM19 14l-.8 2.2L16 17l2.2.8L19 20l.8-2.2L22 17l-2.2-.8z"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 5.5v14M8 7h8M8 11h6"/>',
  whatsapp: '<path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 20.5l1.5-5.4A8.5 8.5 0 1 1 21 11.5Z"/><path d="M8.2 7.5c.2-.4.4-.4.7-.4h.4c.1 0 .3 0 .4.4l.7 1.7c.1.2.1.4 0 .5l-.6.8c-.1.1-.2.3 0 .5.5.9 1.2 1.6 2.1 2.1.2.1.4.1.5-.1l.8-1c.2-.2.3-.2.5-.1l1.8.9c.2.1.4.2.4.3 0 .1 0 .8-.4 1.4-.4.6-1.3 1-1.8 1.1-.5 0-1.2.1-2.9-.6-2.4-1-3.9-3.5-4-3.7-.1-.2-1-1.4-1-2.7s.7-2 1-2.3c.3-.3.6-.4.9-.4"/>',
  meta: '<path d="M3.2 15.8c1.8-6 4-9 6.1-9 3.2 0 4.7 10.4 7.8 10.4 1.7 0 3.1-2.1 3.7-4.3"/><path d="M20.8 8.2c-1.8 6-4 9-6.1 9-3.2 0-4.7-10.4-7.8-10.4-1.7 0-3.1 2.1-3.7 4.3"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/>',
  pie: '<path d="M21 12a9 9 0 1 1-9-9v9z"/><path d="M12 3a9 9 0 0 1 9 9h-9z"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  send: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trend: '<path d="m3 17 6-6 4 4 8-9M15 6h6v6"/>',
  money: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h.01M17 15h.01M12 9v6M10 11h3a1 1 0 0 1 0 2h-3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  bot: '<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  paperclip: '<path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.5-9.5a4 4 0 0 1 5.7 5.7l-9.5 9.5a2 2 0 0 1-2.8-2.8l8.8-8.8"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'
  ,calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'
  ,chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'
  ,tag: '<path d="M20 12 12 20 4 12V4h8z"/><path d="M8 8h.01"/>'
  ,settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>'
  ,moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>'
  ,sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>'
  ,qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h.01"/>'
  ,refresh: '<path d="M20 11a8 8 0 1 0 2 5M20 4v7h-7"/>'
  ,link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/>'
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
}

document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });

function applyTheme(theme) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  localStorage.setItem('atenva-theme', selected);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', selected === 'dark' ? '#0b1510' : '#f6f8f3');
  document.querySelectorAll('.theme-toggle').forEach(button => {
    const nextLabel = selected === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro';
    button.setAttribute('aria-label', nextLabel);
    button.setAttribute('title', nextLabel);
    button.innerHTML = icon(selected === 'dark' ? 'sun' : 'moon');
  });
}

const textSizeOptions = {
  standard: { label: 'Padrão', zoom: 1, description: 'Tamanho original da plataforma' },
  large: { label: 'Grande', zoom: 1.12, description: 'Textos e controles 12% maiores' },
  extra: { label: 'Muito grande', zoom: 1.22, description: 'Leitura ampliada em 22%' }
};

function textSizeStorageKey() {
  const identity = state.user?.id || state.user?.email || 'usuario';
  const company = state.user?.companyId || 'geral';
  return `atenva-text-size:${identity}:${company}`;
}

function applyTextSize(size = 'standard', persist = true) {
  const selected = textSizeOptions[size] ? size : 'standard';
  const zoom = textSizeOptions[selected].zoom;
  document.documentElement.style.setProperty('--ui-zoom', String(zoom));
  document.body.style.zoom = String(zoom);
  document.documentElement.dataset.textSize = selected;
  if (persist) localStorage.setItem(textSizeStorageKey(), selected);
}

function loadTextSizePreference() {
  applyTextSize(localStorage.getItem(textSizeStorageKey()) || 'standard', false);
}

function openTextSizeSettings() {
  const current = textSizeOptions[document.documentElement.dataset.textSize] ? document.documentElement.dataset.textSize : 'standard';
  const host = document.querySelector('#detail-modal-content');
  host.innerHTML = `<div class="modal-icon">${icon('settings')}</div><p class="overline">Acessibilidade</p><h2>Tamanho dos textos</h2><p class="text-size-intro">Escolha o tamanho mais confortável. A preferência fica salva para este usuário e perfil de empresa.</p><div class="text-size-options">${Object.entries(textSizeOptions).map(([key,option]) => `<button type="button" class="text-size-option ${key === current ? 'active' : ''}" data-text-size="${key}"><span class="text-size-sample ${key}">Aa</span><span><strong>${option.label}</strong><small>${option.description}</small></span><i aria-hidden="true"></i></button>`).join('')}</div><div class="text-size-preview"><small>Prévia</small><strong>Assim ficará a leitura no sistema.</strong><p>Contatos, conversas, tarefas e métricas acompanham o tamanho escolhido.</p></div>`;
  host.querySelectorAll('[data-text-size]').forEach(button => button.addEventListener('click', () => {
    applyTextSize(button.dataset.textSize);
    host.querySelectorAll('[data-text-size]').forEach(option => option.classList.toggle('active', option === button));
    toast('Tamanho atualizado', `${textSizeOptions[button.dataset.textSize].label} foi aplicado ao sistema.`);
  }));
  openModal('detail-modal');
}

applyTheme(document.documentElement.dataset.theme);
applyEntryProfileBranding().catch(() => {});
document.querySelectorAll('.theme-toggle').forEach(button => button.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}));

let sessionRefreshPromise = null;

async function refreshSession() {
  if (!sessionRefreshPromise) {
    sessionRefreshPromise = fetch('/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Sessão indisponível');
        csrfToken = payload.csrfToken || '';
        if (payload.user) state.user = payload.user;
        return payload;
      })
      .finally(() => { sessionRefreshPromise = null; });
  }
  return sessionRefreshPromise;
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const dealMatch=method==='PATCH'&&path.match(/^\/api\/deals\/(\d+)$/);
  const cachedDeal=dealMatch&&state.pipeline?.deals.find(item=>item.id===Number(dealMatch[1]));
  if(cachedDeal&&options.body&&options.body.expected_revision===undefined)options={...options,body:{...options.body,expected_revision:cachedDeal.revision}};
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),Number(options.timeoutMs)||12_000);
  const {timeoutMs,_authRetried=false,...fetchOptions}=options;
  let response;
  try{response=await fetch(path, {
    ...fetchOptions,
    credentials:'same-origin',
    signal:controller.signal,
    headers: { 'Content-Type': 'application/json', ...(csrfToken && !['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': csrfToken } : {}), ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });}catch(error){if(error.name==='AbortError'){const timeoutError=new Error('A conexão demorou demais. Tente novamente.');timeoutError.status=408;throw timeoutError;}throw error;}finally{clearTimeout(timeout);}
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/me') {
    if (!_authRetried) {
      try {
        await refreshSession();
        return api(path, { ...options, _authRetried: true });
      } catch {}
    }
    const error = new Error('Sua sessão expirou. Entre novamente para continuar.');
    error.sessionExpired = true;
    showLogin(error.message);
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload.error || `Erro ${response.status}`);
    error.status = response.status;
    error.retryAfterMs=Number(response.headers.get('Retry-After')||0)*1000;
    throw error;
  }
  if(cachedDeal&&payload.revision!==undefined)Object.assign(cachedDeal,payload);
  return payload;
}

function showLogin(message = '') {
  clearInterval(liveHeartbeat);liveHeartbeat=null;
  clearInterval(scheduledMessageHeartbeat);scheduledMessageHeartbeat=null;
  state.user = null;
  csrfToken = '';
  document.documentElement.style.setProperty('--ui-zoom', '1');
  document.body.style.zoom = '1';
  document.querySelector('#app-boot').hidden = true;
  document.querySelector('#app-shell').hidden = true;
  document.querySelector('#login-screen').hidden = false;
  document.querySelector('#invite-accept-form').hidden = true;
  document.querySelector('#login-form').hidden = false;
  const errorBox = document.querySelector('#login-error');
  errorBox.textContent = message;
  errorBox.hidden = !message;
  document.querySelector('#login-form input[name=email]').focus();
}

function showApp(user) {
  state.user = user;
  document.querySelector('#app-boot').hidden = true;
  loadTextSizePreference();
  document.querySelector('#login-screen').hidden = true;
  document.querySelector('#app-shell').hidden = false;
  applySidebarState();
  const role = user.isMaster ? 'Onboarding Manager' : { admin: 'Administradora', manager: 'Gestora', agent: 'Atendente' }[user.role] || user.role;
  document.querySelector('#sidebar-user-name').textContent = user.name;
  document.querySelector('#sidebar-user-role').textContent = role;
  document.querySelector('#sidebar-user-avatar').textContent = initials(user.name);
  document.querySelector('#profile-role').textContent = user.isMaster ? 'Central Atenva · todas as contas' : 'Perfil atual';
  document.querySelector('#profile-context-label').textContent = user.isMaster ? 'Central de clientes' : 'Perfil da empresa';
  document.querySelectorAll('.admin-only').forEach(element => { element.hidden = !(user.isMaster || user.role === 'admin' || ['owner','admin'].includes(user.companyRole)); });
  document.querySelector('#new-company-button').hidden = !user.isMaster;
  document.querySelector('#eyebrow').textContent = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }).format(new Date());
  loadCompanySwitcher();
  api('/api/agent/config').then(config=>{state.agentConfig=config;document.querySelector('#agent-nav-name').textContent=`Agente ${config.name}`;}).catch(()=>{});
  refreshNotifications(false);
  clearInterval(scheduledMessageHeartbeat);
  const processScheduledMessages=()=>api('/api/scheduled-messages/process',{method:'POST',body:{}}).catch(()=>{});
  processScheduledMessages();
  scheduledMessageHeartbeat=setInterval(processScheduledMessages,60_000);
  clearInterval(liveHeartbeat);
  liveHeartbeat=setInterval(refreshLiveData,2000);
}

// Read-only synchronization: never runs the model or sends WhatsApp messages.
async function refreshLiveData() {
  if(liveInFlight||!state.user||document.hidden||Date.now()<liveRetryAt||state.inboxLoading)return;
  const revision=`${state.user.companyId}:${navigationToken}:${state.inboxRequestId}`;
  const current=()=>state.user&&revision===`${state.user.companyId}:${navigationToken}:${state.inboxRequestId}`;
  const selectedId=state.view==='inbox'?state.selectedConversation?.id:null;
  liveInFlight=true;
  try {
    const payload=await api(`/api/conversations/live${selectedId?`?selected=${selectedId}&version=${encodeURIComponent(state.liveSelectedVersion||'')}`:''}`);
    if(!current())return;
    liveFailures=0;liveRetryAt=0;
    const signature=JSON.stringify(payload.conversations);
    const changed=signature!==liveSignature;
    liveSignature=signature;
    state.conversations=payload.conversations;
    state.conversationsLoadedAt=Date.now();
    const unread=document.querySelector('#nav-unread');if(unread)unread.textContent=payload.conversations.filter(item=>item.unread_count>0).length;
    for(const item of payload.conversations.filter(item=>item.waiting_human)){
      const key=`${item.id}:${item.handoff_id}`;
      if(!notifiedHandoffs.has(key)){
        notifiedHandoffs.add(key);
        toast('Atendimento humano necessário',`${item.name} está aguardando ser atendido pela equipe.`);
      }
    }
    if(state.view==='inbox'){
      refreshConversationRows();
      if(selectedId){
        state.liveSelectedVersion=payload.selected_version||'';
        if(payload.selected&&Number(payload.selected.id)===Number(state.selectedConversation?.id))applyLiveConversation(payload.selected);
        else if(state.selectedConversation)applyLiveConversation(state.selectedConversation);
      }
    }
    if(changed)refreshNotifications(!document.querySelector('#notification-panel').hidden);
    // Refresh the visible board without interrupting typing, dialogs or a drag.
    const canRefreshView=()=>!document.querySelector('.modal-backdrop:not([hidden]), .dragging, .is-dragging')&&!document.activeElement?.matches('input,textarea,select');
    if(state.view==='pipeline'&&canRefreshView()){
      const pipelineId=state.selectedPipelineId;
      if(pipelineId){
        const data=await api(`/api/pipeline?pipeline_id=${pipelineId}`);
        if(current()&&canRefreshView()&&pipelineId===state.selectedPipelineId&&JSON.stringify(data)!==JSON.stringify(state.pipeline)){
          const board=document.querySelector('.pipeline-board');const left=board?.scrollLeft||0;
          await renderPipeline(data);
          const updated=document.querySelector('.pipeline-board');if(updated)updated.scrollLeft=left;
        }
      }
    }
    if(Date.now()>=liveViewRefreshAt&&canRefreshView()){
      liveViewRefreshAt=Date.now()+5000;
      const view=state.view;
      if(view==='overview'){
        const data=await api(`/api/dashboard?${new URLSearchParams(state.dashboardRange||{})}`);
        if(current()&&canRefreshView()&&JSON.stringify(data)!==JSON.stringify(state.dashboard))await renderOverview(data);
      }else if(view==='contacts'){
        const data=await Promise.all([api('/api/contacts'),api('/api/organizations')]);
        if(current()&&canRefreshView()&&JSON.stringify(data)!==JSON.stringify([state.contacts,state.organizations])){
          const fields=[...document.querySelectorAll('#view-contacts input:not([type=checkbox]),#view-contacts select')].map(field=>({id:field.id,value:field.value}));
          await renderContacts(data);
          for(const {id,value} of fields){const field=id&&document.getElementById(id);if(field){field.value=value;field.dispatchEvent(new Event(field.tagName==='SELECT'?'change':'input',{bubbles:true}));}}
        }
      }else if(view==='tasks'){
        const query=new URLSearchParams(state.taskRange||{});if(state.taskOwnerFilter)query.set('assigned_to',state.taskOwnerFilter);
        const internal=await api(`/api/tasks?${query}`);
        const data=[...internal,...state.tasks.filter(task=>task.source==='google')];
        if(current()&&canRefreshView()&&JSON.stringify(data)!==JSON.stringify(state.tasks))await renderTasks(data);
      }
    }
  } catch(error) {
    if(current()){liveFailures++;liveRetryAt=Date.now()+Math.max(error.retryAfterMs||0,Math.min(30000,2000*2**liveFailures));}
  } finally {liveInFlight=false;}
}

document.addEventListener('visibilitychange',()=>{if(!document.hidden){liveRetryAt=0;refreshLiveData();}});
window.addEventListener('online',()=>{liveRetryAt=0;refreshLiveData();});

function refreshConversationRows(){
  const host=document.querySelector('#conversation-list');if(!host)return;
  const query=(document.querySelector('#conversation-search')?.value||'').toLowerCase();
  const filter=document.querySelector('[data-filter].active')?.dataset.filter||'all';
  const items=state.conversations.filter(c=>(filter!=='unread'||c.unread_count)&&(filter!=='human'||c.mode==='human')&&(filter!=='waiting'||c.waiting_human)&&`${c.name} ${c.company} ${c.last_message}`.toLowerCase().includes(query));
  const markup=conversationRows(items,state.selectedConversation?.id);
  if(host.innerHTML!==markup){const top=host.scrollTop;host.innerHTML=markup;host.scrollTop=top;}
  document.querySelector('.conversation-tools-heading div>span').textContent=`${state.conversations.length} contatos`;
}

function applyLiveConversation(conversation){
  const previous=state.selectedConversation;
  state.selectedConversation=conversation;
  const scroll=document.querySelector('#message-scroll');
  if(!scroll)return;
  const atBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<80;
  const oldTop=scroll.scrollTop;
  const previousMessages=new Map(previous.messages.map(message=>[message.id,JSON.stringify(message)]));
  let messagesChanged=false;
  let anchor=scroll.querySelector('.date-divider');
  for(const message of conversation.messages){
    let node=scroll.querySelector(`[data-message-id="${Number(message.id)}"]`);
    if(!node||previousMessages.get(message.id)!==JSON.stringify(message)){
      const template=document.createElement('template');template.innerHTML=renderMessage(message,conversation);const updated=template.content.firstElementChild;
      if(node)node.replaceWith(updated);node=updated;messagesChanged=true;
    }
    if(anchor?.nextElementSibling!==node){anchor.after(node);messagesChanged=true;}
    anchor=node;
  }
  const ids=new Set(conversation.messages.map(message=>String(message.id)));
  scroll.querySelectorAll('[data-message-id]').forEach(node=>{if(!ids.has(node.dataset.messageId)){node.remove();messagesChanged=true;}});
  if(messagesChanged)scroll.scrollTop=atBottom?scroll.scrollHeight:oldTop;
  const status=document.querySelector('.chat-header-copy span');
  const pauseSeconds=conversation.human_pause_until?Math.max(0,Math.ceil((new Date(conversation.human_pause_until)-Date.now())/1000)):0;
  if(status)status.textContent=conversation.waiting_human?'Aguardando atendimento humano':pauseSeconds?`Atendimento humano · IA retoma em ${pauseSeconds}s`:conversation.mode==='human'?'Atendimento humano':conversation.mode==='copilot'?'IA em modo copiloto':`${agentLabel()} está atendendo`;
  const modeButton=document.querySelector('#toggle-mode');
  if(modeButton)modeButton.innerHTML=conversation.waiting_human?`${icon('users')} Assumir atendimento`:conversation.mode==='human'?`${icon('spark')} Devolver para o ${escapeHtml(agentLabel())}`:`${icon('users')} Assumir conversa`;
  const banner=document.querySelector('.mode-banner');
  if(banner)banner.innerHTML=`${icon(conversation.mode==='human'?'users':'spark')} ${conversation.waiting_human?'Cliente aguardando atendimento da equipe':conversation.mode==='human'?'Você assumiu esta conversa':'Ao responder, a conversa passa para atendimento humano'}`;
  const name=document.querySelector('.chat-header-copy strong');if(name)name.textContent=conversation.name;
  const summary=document.querySelector('.ai-summary');
  if(summary){summary.querySelector('p').textContent=conversation.summary||'Ainda não há informações suficientes.';summary.querySelectorAll('p')[1].textContent=conversation.next_action||'Aguardar nova mensagem.';}
  if(JSON.stringify([previous.score,previous.stage_id,previous.qualification,previous.value_cents])!==JSON.stringify([conversation.score,conversation.stage_id,conversation.qualification,conversation.value_cents])){
    const template=document.createElement('template');template.innerHTML=renderContactDetail(conversation);
    const deal=document.querySelector('#contact-detail .deal-card');if(deal)deal.replaceWith(template.content.querySelector('.deal-card'));
  }
}

function notificationItem({ iconName='info', title, text, view, conversationId='', tone='' }) {
  return `<button type="button" class="notification-item ${tone}" data-notification-view="${escapeHtml(view)}" ${conversationId ? `data-notification-conversation="${Number(conversationId)}"` : ''}><span class="notification-item-icon">${icon(iconName)}</span><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(text)}</small></span>${icon('chevron')}</button>`;
}

async function refreshNotifications(renderPanel = true) {
  const badge = document.querySelector('#notification-badge');
  const list = document.querySelector('#notification-list');
  if (!state.user || !badge || !list) return;
  const companyId=state.user.companyId;
  if (renderPanel) list.innerHTML = '<p class="notification-loading">Carregando notificações…</p>';
  try {
    const [dashboard, health, google] = await Promise.all([
      api('/api/dashboard'),
      api('/api/health').catch(() => ({ whatsappReachable:false, whatsappConnected:false, whatsappState:'unavailable' })),
      api('/api/integrations/google/status').catch(() => ({ configured:false, connected:false }))
    ]);
    if(!state.user||state.user.companyId!==companyId)return;
    const items = [];
    const conversations=state.conversations.length?state.conversations:dashboard.conversations;
    conversations.filter(item=>item.waiting_human).forEach(item=>items.push({iconName:'users',title:item.name,text:'Está aguardando atendimento humano. Clique para abrir a conversa e assumir.',view:'inbox',conversationId:item.id,tone:'urgent'}));
    const unread = conversations.filter(item => Number(item.unread_count) > 0);
    unread.slice(0, 4).forEach(item => items.push({ iconName:'message', title:item.name, text:`${item.unread_count} mensagem${Number(item.unread_count)===1?'':'s'} não lida${Number(item.unread_count)===1?'':'s'} · ${item.last_message || 'Nova conversa'}`, view:'inbox', conversationId:item.id }));
    const hiddenUnread = Math.max(0, Number(dashboard.metrics.unread_conversations || 0) - unread.length);
    if (hiddenUnread) items.push({ iconName:'message', title:`Mais ${hiddenUnread} conversa${hiddenUnread===1?'':'s'} não lida${hiddenUnread===1?'':'s'}`, text:'Abra a caixa de entrada para revisar.', view:'inbox' });
    const nowTime = Date.now(); const nextDay = nowTime + 24 * 60 * 60 * 1000;
    dashboard.tasks.filter(task => task.due_at && new Date(task.due_at).getTime() <= nextDay).slice(0, 4).forEach(task => {
      const due = new Date(task.due_at); const overdue = due.getTime() < nowTime;
      items.push({ iconName:'calendar', title:task.title, text:overdue ? `Tarefa vencida ${relativeTime(task.due_at)}` : `Prazo ${relativeTime(task.due_at)}`, view:'tasks', tone:overdue?'urgent':'' });
    });
    if (!health.whatsappReachable) items.push({ iconName:'whatsapp', title:'WhatsApp indisponível', text:'Conecte e valide a WhatsApp Cloud API oficial.', view:'meta', tone:'urgent' });
    else if (!health.whatsappConnected) items.push({ iconName:'link', title:'WhatsApp ainda não conectado', text:'Valide as credenciais e ative o webhook oficial.', view:'meta' });
    if (google.configured && !google.connected) items.push({ iconName:'calendar', title:'Google Agenda desconectado', text:'Entre com o Google para sincronizar tarefas e reuniões.', view:'meta' });
    const count = Math.min(99, items.length);
    badge.hidden = count === 0; badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.toggle('has-count', count > 0);
    if (renderPanel) {
      list.innerHTML = items.length ? items.map(notificationItem).join('') : `<div class="notification-empty">${icon('check')}<strong>Tudo em dia</strong><span>Não há pendências no momento.</span></div>`;
      list.querySelectorAll('[data-notification-view]').forEach(button => button.addEventListener('click', async () => {
        closeNotifications();
        const conversationId = button.dataset.notificationConversation ? Number(button.dataset.notificationConversation) : undefined;
        await navigate(button.dataset.notificationView, conversationId);
      }));
    }
  } catch (error) {
    if (renderPanel) list.innerHTML = `<div class="notification-empty error">${icon('info')}<strong>Não foi possível carregar</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

function closeNotifications() {
  const panel = document.querySelector('#notification-panel'); const button = document.querySelector('#notification-button');
  panel.hidden = true; button.setAttribute('aria-expanded', 'false');
}

document.querySelector('#notification-button').addEventListener('click', async event => {
  event.stopPropagation(); const panel = document.querySelector('#notification-panel'); const opening = panel.hidden;
  panel.hidden = !opening; event.currentTarget.setAttribute('aria-expanded', String(opening));
  if (opening) await refreshNotifications(true);
});
document.querySelector('#close-notifications').addEventListener('click', closeNotifications);
document.querySelector('#notification-panel').addEventListener('click', event => event.stopPropagation());
document.addEventListener('click', event => { if (!event.target.closest('.notification-wrap')) closeNotifications(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeNotifications(); });

async function loadCompanySwitcher() {
  try {
    state.companies = await api('/api/companies');
    const active = state.companies.find(company => Number(company.id) === Number(state.user?.companyId)) || state.companies[0];
    if (active) {
      document.querySelector('#profile-name').textContent = active.name;
      document.querySelector('#profile-company-avatar').textContent = initials(active.name);
    }
    const host = document.querySelector('#company-switcher');
    host.innerHTML = `<small>Trocar perfil</small>${state.companies.map(company => `<button type="button" class="company-option ${Number(company.id) === Number(state.user?.companyId) ? 'active' : ''}" data-company-switch="${company.id}"><span>${initials(company.name)}</span><strong>${escapeHtml(company.name)}</strong>${Number(company.id) === Number(state.user?.companyId) ? '<em>Atual</em>' : ''}</button>`).join('')}`;
    host.querySelectorAll('[data-company-switch]').forEach(button => button.addEventListener('click', async event => {
      event.stopPropagation();
      const companyId = Number(button.dataset.companySwitch);
      const company = state.companies.find(item => Number(item.id) === companyId);
      if (companyId === Number(state.user?.companyId)) {
        document.querySelector('#profile-popover').hidden = true;
        return;
      }
      button.disabled = true;
      try {
        await api(`/api/companies/${companyId}/activate`, { method: 'POST', body: {} });
        if (company?.slug) history.replaceState({}, '', Number(company.id)===1&&state.user?.isMaster?'/':`/${company.slug}`);
        const session = await api('/api/auth/me');
        csrfToken = session.csrfToken;
        resetCompanyScopedState();
        showApp(session.user);
        await loadHealth();
        await navigate(state.view || 'overview');
        document.querySelector('#profile-popover').hidden = true;
        toast('Perfil trocado', `Você está no perfil ${company?.name || 'selecionado'}.`);
      } catch (error) {
        toast('Não foi possível trocar o perfil', error.message, 'error');
        button.disabled = false;
      }
    }));
  }
  catch { /* perfis são opcionais para usuários sem permissão */ }
}

async function applyEntryProfile() {
  const profile = entryProfile();
  if (!state.user) return;
  const companies = state.companies.length ? state.companies : await api('/api/companies');
  const target = profile ? companies.find(company => company.slug === profile.slug) : state.user.isMaster ? companies.find(company => Number(company.id)===1) : null;
  if (!target || Number(target.id) === Number(state.user.companyId)) return;
  await api(`/api/companies/${target.id}/activate`, { method: 'POST', body: {} });
  const session = await api('/api/auth/me');
  csrfToken = session.csrfToken;
  resetCompanyScopedState();
  showApp(session.user);
}

function money(cents = 0, compact = false) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: compact ? 'compact' : 'standard', maximumFractionDigits: 0 }).format(cents / 100);
}

function relativeTime(date) {
  if (!date) return '—';
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  const units = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [amount, unit] of units) if (Math.abs(seconds) >= amount) return formatter.format(Math.round(seconds / amount), unit);
  return 'agora';
}

function initials(name = '') {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
}
function contactAvatar(contact, className='conversation-avatar') { return contact?.profile_picture_url ? `<span class="${className} photo"><img src="${escapeHtml(contact.profile_picture_url)}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.classList.remove('photo');this.parentElement.textContent='${initials(contact.name)}'" /></span>` : `<span class="${className}">${initials(contact?.name)}</span>`; }
function agentLabel(){ return state.agentConfig?.name || 'Atenva'; }

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function parseJson(value, fallback={}) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

function toast(title, message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `${icon(type === 'error' ? 'info' : 'check')}<div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
  document.querySelector('#toasts').append(item);
  setTimeout(() => item.remove(), 4200);
}

function setLoading(id) {
  const host = document.querySelector(id);
  if (!host.innerHTML.trim()) host.innerHTML = '<div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:280px;margin-top:14px"></div>';
  host.classList.add('is-loading');
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    const label = document.querySelector('#connection-label');
    if (label) label.textContent = health.whatsappConnected ? (health.whatsappProvider === 'evolution' ? 'WhatsApp conectado' : 'Cloud API conectada') : health.whatsappProvider === 'evolution' && !health.whatsappReachable ? 'Evolution indisponível' : health.whatsappProvider === 'evolution' ? 'Evolution online · WhatsApp desconectado' : 'WhatsApp desconectado';
  } catch { const label = document.querySelector('#connection-label'); if (label) label.textContent = 'Servidor indisponível'; }
}

async function renderOverview(liveData=null) {
  if(!liveData)setLoading('#view-overview');
  if (!state.dashboardRange) {
    const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 29);
    state.dashboardRange = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  const query = new URLSearchParams(state.dashboardRange);
  if(liveData)state.dashboard=liveData;
  else [state.dashboard, state.dashboardPreferences] = await Promise.all([api(`/api/dashboard?${query}`), api('/api/dashboard/preferences')]);
  const { metrics, stages, recentActivities, tasks, conversations } = state.dashboard;
  document.querySelector('#nav-unread').textContent = metrics.unread_conversations;
  const cardDefinitions = {
    new_contacts: ['users', 'Novos contatos', metrics.new_contacts, 'no período selecionado'],
    open_conversations: ['message', 'Conversas em andamento', metrics.open_conversations, `${metrics.handoffs} com atendimento humano`],
    unanswered_conversations: ['clock', 'Não respondidas', metrics.unanswered_conversations, 'aguardando sua equipe'],
    response_minutes: ['trend', 'Tempo de resposta', `${Math.round(metrics.response_minutes || 0)} min`, 'média do período'],
    pipeline_value: ['money', 'Funis', money(metrics.pipeline_value, true), `${metrics.won_deals} negócios ganhos`],
    won_deals: ['check', 'Negócios ganhos', metrics.won_deals, 'conversões acumuladas'],
    active_leads: ['users', 'Leads ativos', metrics.active_leads, 'em acompanhamento'],
    handoffs: ['spark', 'Transferências', metrics.handoffs, 'IA para humano']
    ,mqls: ['trend', 'MQLs', metrics.mqls, 'leads qualificados por marketing']
    ,sqls: ['check', 'SQLs', metrics.sqls, 'prontos para abordagem comercial']
  };
  const visibleCards = state.dashboardPreferences.cards?.length ? state.dashboardPreferences.cards : Object.keys(cardDefinitions).slice(0, 5);
  const maxTrend = Math.max(1, ...state.dashboard.trend.flatMap(item => [item.inbound, item.outbound]));
  document.querySelector('#view-overview').innerHTML = `
    <div class="section-head dashboard-head"><div><h2>Bom trabalho, ${escapeHtml((state.user?.name || 'Ana').split(' ')[0])}.</h2><p>Acompanhe conversas, vendas e desempenho em um só lugar.</p></div><div class="dashboard-actions"><label>De <input id="dashboard-start" type="date" value="${state.dashboardRange.start}"></label><label>Até <input id="dashboard-end" type="date" value="${state.dashboardRange.end}"></label><button class="ghost-button" id="customize-dashboard">${icon('sliders')} Personalizar</button></div></div>
    <div class="metric-grid">
      ${visibleCards.map((key, index) => metricCard(key, ...cardDefinitions[key], index === visibleCards.length - 1)).join('')}
    </div>
    <div class="chart-grid">
      <div class="panel interactive-chart" data-chart-panel><div class="panel-header"><div><h3>Volume de conversas</h3><span>Passe o mouse em qualquer coluna para ver os valores</span></div><div class="chart-tools"><div class="chart-legend"><i class="received"></i>Recebidas <i class="sent"></i>Enviadas</div><button class="icon-button" id="toggle-traffic-chart" title="Alternar gráfico">${icon(state.trafficChart === 'bars' ? 'pie' : 'chart')}</button><button class="icon-button" id="expand-traffic-chart" title="Visualizar gráfico maior">${icon('arrow')}</button></div></div>${state.trafficChart === 'bars' ? `<div class="bar-chart">${state.dashboard.trend.map(item => { const label=new Date(`${item.day}T12:00:00`).toLocaleDateString('pt-BR',{day:'2-digit',month:'short'}); return `<div class="bar-group chart-hover-target" tabindex="0" data-chart-tip="${label} · ${item.inbound} recebidas · ${item.outbound} enviadas"><div class="bars"><i class="received" style="height:${Math.max(4, item.inbound / maxTrend * 100)}%"></i><i class="sent" style="height:${Math.max(4, item.outbound / maxTrend * 100)}%"></i></div><span>${label}</span></div>`;}).join('')}</div>` : trafficPie(state.dashboard.trend)}</div>
      <div class="panel"><div class="panel-header"><div><h3>Funil de vendas</h3><span>Resumo das oportunidades que entraram nos funis</span></div><button class="link-button" data-view-link="pipeline">Ver funis completos →</button></div><div class="funnel visual-funnel">${stages.map(stage => `<div class="funnel-row chart-hover-target" tabindex="0" data-chart-tip="${escapeHtml(stage.name)} · ${stage.deal_count} negócio${stage.deal_count===1?'':'s'} · ${money(stage.value_cents)}"><label>${escapeHtml(stage.name)}</label><div class="funnel-track"><div class="funnel-fill" style="width:${Math.max(8, stages[0]?.deal_count ? stage.deal_count / stages[0].deal_count * 100 : 8)}%;background:${stage.color}"></div></div><b>${stage.deal_count}</b></div>`).join('')}</div></div>
    </div>
    <div class="overview-grid">
      <div>
        <div class="panel" style="margin-bottom:17px">
          <div class="panel-header"><div><h3>Conversas em destaque</h3><span>Prioridade calculada pelo agente</span></div><button class="link-button" data-view-link="inbox">Abrir caixa de entrada</button></div>
          <div class="conversation-preview-list">
            ${conversations.map(c => `<button class="conversation-preview conversation-row" data-open-conversation="${c.id}" style="grid-template-columns:38px 1fr auto;padding-inline:4px;border:0;border-bottom:1px solid #edf0eb">
              ${contactAvatar(c)}
              <span><strong>${escapeHtml(c.name)} <small style="color:var(--muted);font-weight:500">· ${escapeHtml(c.company || '')}</small></strong><p>${escapeHtml(c.last_message)}</p></span>
              <span class="conversation-meta"><time>${relativeTime(c.last_message_at)}</time>${c.unread_count ? `<b class="unread">${c.unread_count}</b>` : `<span class="stage-badge" style="margin-top:7px">${escapeHtml(c.stage_name || 'Novo')}</span>`}</span>
            </button>`).join('')}
          </div>
        </div>
        <div class="panel"><div class="panel-header"><div><h3>Automação do funil</h3><span>Status atualizado pelo ${escapeHtml(agentLabel())}</span></div><div class="agent-live compact"><span></span>Ativa</div></div><div class="automation-summary">A IA interpreta intenção e avanço comercial para mover leads entre <strong>Novo lead</strong>, <strong>Qualificado</strong> e <strong>Demonstração</strong>. Alterações ficam registradas no histórico.</div></div>
      </div>
      <div>
        <div class="panel" style="margin-bottom:17px">
          <div class="panel-header"><div><h3>Próximas tarefas</h3><span>Criadas pela equipe e pela IA</span></div></div>
          <div class="task-list">${tasks.length ? tasks.map(task => `<div class="task-item"><button class="task-check" data-complete-task="${task.id}" aria-label="Concluir"></button><div><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.contact_name || 'Tarefa interna')} · ${escapeHtml(task.company || '')}</span></div><time>${relativeTime(task.due_at)}</time></div>`).join('') : '<div class="empty-state"><p>Nenhuma tarefa pendente.</p></div>'}</div>
        </div>
        <div class="panel">
          <div class="panel-header"><div><h3>Atividade recente</h3><span>Decisões e alterações</span></div></div>
          <div class="activity-list">${recentActivities.slice(0, 6).map(item => `<div class="activity-item"><span class="activity-icon">${icon(item.actor_type === 'ai' ? 'spark' : 'check')}</span><div><strong>${escapeHtml(item.contact_name || 'Sistema')}</strong><span>${escapeHtml(item.description)}</span></div><time>${relativeTime(item.created_at)}</time></div>`).join('')}</div>
        </div>
      </div>
    </div>`;
  bindViewLinks();
  bindPieTooltips(document.querySelector('#view-overview'));
  document.querySelector('#dashboard-start').addEventListener('change', updateDashboardRange);
  document.querySelector('#dashboard-end').addEventListener('change', updateDashboardRange);
  document.querySelector('#customize-dashboard').addEventListener('click', openDashboardPreferences);
  document.querySelector('#toggle-traffic-chart').addEventListener('click', () => { state.trafficChart = state.trafficChart === 'bars' ? 'pie' : 'bars'; renderOverview(); });
  document.querySelector('#expand-traffic-chart').addEventListener('click', () => openChartPreview('Volume de conversas', document.querySelector('[data-chart-panel]')));
  document.querySelectorAll('[data-metric]').forEach(card => card.addEventListener('click', () => openMetricSummary(card.dataset.metric, cardDefinitions[card.dataset.metric])));
  document.querySelectorAll('[data-metric]').forEach(card => card.addEventListener('keydown', event => { if (event.key==='Enter'||event.key===' ') { event.preventDefault(); openMetricSummary(card.dataset.metric, cardDefinitions[card.dataset.metric]); } }));
  document.querySelectorAll('[data-complete-task]').forEach(button => button.addEventListener('click', () => completeTask(button.dataset.completeTask)));
  document.querySelectorAll('[data-open-conversation]').forEach(button => button.addEventListener('click', () => navigate('inbox', Number(button.dataset.openConversation))));
}

function updateDashboardRange() {
  state.dashboardRange = { start: document.querySelector('#dashboard-start').value, end: document.querySelector('#dashboard-end').value };
  renderOverview();
}

function openDashboardPreferences() {
  const labels = { new_contacts: 'Novos contatos', open_conversations: 'Conversas em andamento', unanswered_conversations: 'Não respondidas', response_minutes: 'Tempo de resposta', pipeline_value: 'Valor dos funis', won_deals: 'Negócios ganhos', active_leads: 'Leads ativos', mqls: 'MQLs', sqls: 'SQLs', handoffs: 'Transferências para humano' };
  const selected = state.dashboardPreferences.cards?.length ? state.dashboardPreferences.cards : Object.keys(labels).slice(0,5);
  const ordered = [...selected, ...Object.keys(labels).filter(key => !selected.includes(key))];
  document.querySelector('#dashboard-card-options').innerHTML = ordered.map(key => `<div class="dashboard-order-item" draggable="true" data-card-option="${key}"><button type="button" class="drag-handle" data-drag-handle aria-label="Arrastar ${escapeHtml(labels[key])}" title="Arraste para reordenar">⠿</button><label><input type="checkbox" name="cards" value="${key}" ${selected.includes(key) ? 'checked' : ''}><span>${escapeHtml(labels[key])}</span></label><span class="dashboard-order-controls"><button type="button" data-card-up="${key}" aria-label="Subir ${escapeHtml(labels[key])}" title="Subir">↑</button><button type="button" data-card-down="${key}" aria-label="Descer ${escapeHtml(labels[key])}" title="Descer">↓</button></span></div>`).join('');
  bindDashboardOrdering();
  openModal('dashboard-modal');
}

function bindDashboardOrdering() {
  const list = document.querySelector('#dashboard-card-options');
  let draggedRow = null;
  const moveRow = (row, target, clientY) => {
    if (!row || !target || row === target) return;
    const bounds = target.getBoundingClientRect();
    list.insertBefore(row, clientY < bounds.top + bounds.height / 2 ? target : target.nextElementSibling);
  };
  list.querySelectorAll('[data-card-up],[data-card-down]').forEach(button => button.addEventListener('click', () => {
    const row = button.closest('.dashboard-order-item');
    if (button.dataset.cardUp && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    if (button.dataset.cardDown && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
  }));
  list.querySelectorAll('.dashboard-order-item').forEach(row => {
    row.addEventListener('dragstart', event => { draggedRow = row; row.classList.add('is-dragging'); event.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; moveRow(draggedRow, row, event.clientY); });
    row.addEventListener('drop', event => { event.preventDefault(); });
    row.addEventListener('dragend', () => { row.classList.remove('is-dragging'); draggedRow = null; });
  });
  let pointerRow = null;
  const finishPointerDrag = () => { pointerRow?.classList.remove('is-dragging'); pointerRow = null; };
  list.querySelectorAll('[data-drag-handle]').forEach(handle => {
    handle.addEventListener('pointerdown', event => { pointerRow = handle.closest('.dashboard-order-item'); pointerRow.classList.add('is-dragging'); handle.setPointerCapture?.(event.pointerId); });
    handle.addEventListener('pointermove', event => {
      if (!pointerRow) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.dashboard-order-item');
      moveRow(pointerRow, target, event.clientY);
    });
    handle.addEventListener('pointerup', finishPointerDrag);
    handle.addEventListener('pointercancel', finishPointerDrag);
  });
}

function trafficPie(trend) {
  const received = trend.reduce((sum,item)=>sum+item.inbound,0); const sent = trend.reduce((sum,item)=>sum+item.outbound,0); const total = Math.max(1, received + sent); const receivedPercent = received / total * 100; const sentPercent = sent / total * 100;
  return `<div class="pie-chart-wrap"><div class="pie-chart" aria-label="${received} mensagens recebidas e ${sent} enviadas"><svg viewBox="0 0 42 42" role="img"><circle class="pie-track" cx="21" cy="21" r="15.9155"></circle><circle class="pie-sector received" tabindex="0" cx="21" cy="21" r="15.9155" pathLength="100" stroke-dasharray="${receivedPercent} ${100-receivedPercent}" data-pie-tip="Recebidas · ${received} mensagens · ${Math.round(receivedPercent)}%"></circle><circle class="pie-sector sent" tabindex="0" cx="21" cy="21" r="15.9155" pathLength="100" stroke-dasharray="${sentPercent} ${100-sentPercent}" stroke-dashoffset="-${receivedPercent}" data-pie-tip="Enviadas · ${sent} mensagens · ${Math.round(sentPercent)}%"></circle></svg><div class="pie-center"><strong>${received + sent}</strong><span>mensagens</span></div><output class="pie-floating-tip" aria-live="polite"></output></div><div class="pie-legend-list"><p class="chart-hover-target" tabindex="0" data-chart-tip="${Math.round(receivedPercent)}% do volume total"><i class="received"></i><strong>${received}</strong> recebidas</p><p class="chart-hover-target" tabindex="0" data-chart-tip="${Math.round(sentPercent)}% do volume total"><i class="sent"></i><strong>${sent}</strong> enviadas</p></div></div>`;
}

function bindPieTooltips(root=document){
  root.querySelectorAll('.pie-chart').forEach(chart=>{const tooltip=chart.querySelector('.pie-floating-tip');chart.querySelectorAll('[data-pie-tip]').forEach(sector=>{const show=event=>{tooltip.textContent=sector.dataset.pieTip;tooltip.hidden=false;const bounds=chart.getBoundingClientRect();tooltip.style.left=`${Math.max(12,Math.min(bounds.width-12,event.clientX-bounds.left))}px`;tooltip.style.top=`${Math.max(8,event.clientY-bounds.top-12)}px`;};sector.addEventListener('pointerenter',show);sector.addEventListener('pointermove',show);sector.addEventListener('focus',()=>{tooltip.textContent=sector.dataset.pieTip;tooltip.hidden=false;tooltip.style.left='50%';tooltip.style.top='8px';});const hide=()=>{tooltip.hidden=true;};sector.addEventListener('pointerleave',hide);sector.addEventListener('blur',hide);});});
}

function openMetricSummary(key, definition) {
  const [,label,value,change] = definition;
  const descriptions = { new_contacts:'Pessoas adicionadas no período selecionado.',open_conversations:'Conversas abertas que ainda exigem acompanhamento.',unanswered_conversations:'Conversas cuja última mensagem veio do contato.',response_minutes:'Tempo médio até a primeira resposta da equipe.',pipeline_value:'Soma das oportunidades comerciais abertas.',won_deals:'Negócios marcados como ganhos.',active_leads:'Leads ativos em acompanhamento.',handoffs:'Conversas transferidas da IA para pessoas.',mqls:'Leads que atingiram os critérios de marketing.',sqls:'Leads prontos para abordagem comercial.' };
  const items=state.dashboard?.metricDetails?.[key]||[];
  const links={new_contacts:['contacts','Abrir contatos'],open_conversations:['inbox','Abrir conversas'],unanswered_conversations:['inbox','Ver não respondidas'],pipeline_value:['pipeline','Abrir funis']};
  const rows=items.map(item=>{const isPipeline=key==='pipeline_value';const primary=isPipeline?(item.contact_name||item.title):(item.name||item.contact_name||item.title||'Sem nome');const secondary=isPipeline?[item.title,item.stage_name].filter(Boolean).join(' · '):(item.company||item.stage_name||item.source||'');return `<button class="metric-detail-row ${isPipeline?'pipeline-summary-row':''}" type="button" ${item.id&&key.includes('conversations')?`data-open-metric-conversation="${item.id}"`:''}><span><strong>${escapeHtml(primary)}</strong><small>${escapeHtml(secondary)}</small></span><span>${isPipeline?`<strong class="metric-detail-money">${money(item.value_cents)}</strong>`:`<small>${escapeHtml(item.last_message||'')}</small>`}<time>${relativeTime(item.last_message_at||item.created_at)}</time></span></button>`;}).join('');
  const link=links[key];
  document.querySelector('#detail-modal-content').innerHTML = `<div class="modal-icon">${icon('trend')}</div><p class="overline">Resumo da métrica</p><h2>${escapeHtml(label)}</h2><div class="metric-detail-value">${value}</div><p>${escapeHtml(descriptions[key] || '')}</p>${rows?`<div class="metric-detail-list">${rows}</div>`:''}<div class="metric-insight">${icon('spark')}<span>${escapeHtml(change)}. Use o período do dashboard para recalcular esta leitura.</span></div>${link?`<div class="modal-actions"><button class="primary-button" data-metric-link="${link[0]}">${link[1]} →</button></div>`:''}`;
  openModal('detail-modal');
  document.querySelector('[data-metric-link]')?.addEventListener('click',event=>{closeModals();navigate(event.currentTarget.dataset.metricLink);});
  document.querySelectorAll('[data-open-metric-conversation]').forEach(button=>button.addEventListener('click',()=>{closeModals();navigate('inbox',Number(button.dataset.openMetricConversation));}));
}

function metricCard(key, iconName, label, value, change, highlight = false) {
  return `<article class="metric-card ${highlight ? 'highlight' : ''}" data-metric="${key}" tabindex="0" role="button"><span class="metric-icon">${icon(iconName)}</span><span class="metric-label">${label}</span><div class="metric-row"><strong class="metric-value">${value}</strong><span class="metric-change">${change}</span></div></article>`;
}

function inboxLoadingRows() {
  return Array.from({ length: 7 }, () => '<div class="conversation-row-skeleton"><i></i><span><b></b><small></small></span></div>').join('');
}

function paintInbox(selectedId = null, options = {}) {
  const { listLoading = false, detailLoading = false } = options;
  const selected = Number(state.selectedConversation?.id) === Number(selectedId) ? state.selectedConversation : null;
  const host = document.querySelector('#view-inbox');
  if (!host) return;
  const search=host.querySelector('#conversation-search')?.value||'';
  const filter=host.querySelector('[data-filter].active')?.dataset.filter||'all';
  host.innerHTML = `
    <div class="inbox-layout ${selectedId ? 'chat-open' : 'list-open'} ${listLoading ? 'inbox-loading' : ''}">
      <aside class="conversation-column">
        <div class="conversation-tools"><div class="conversation-tools-heading"><div><strong>Conversas</strong><span>${listLoading ? 'Carregando contatos…' : `${state.conversations.length} contatos`}</span></div><span class="whatsapp-channel-badge">${icon('message')} WhatsApp</span></div><div class="inbox-search">${icon('search')}<input id="conversation-search" placeholder="Pesquisar ou iniciar nova conversa" ${listLoading ? 'disabled' : ''} /></div><div class="inbox-filters"><button class="filter-chip active" data-filter="all">Todas</button><button class="filter-chip" data-filter="unread">Não lidas</button><button class="filter-chip" data-filter="human">Humano</button></div></div>
        <div class="conversation-list" id="conversation-list">${listLoading ? inboxLoadingRows() : conversationRows(state.conversations, selectedId)}</div>
      </aside>
      ${selected ? renderChat(selected) : detailLoading ? '<section class="chat-column chat-loading"><div class="chat-loading-header"><i></i><span><b></b><small></small></span></div><div class="chat-loading-body"><span></span><span></span><span></span></div></section>' : '<div class="empty-state inbox-empty"><h3>Selecione uma conversa</h3><p>Escolha um contato para abrir o atendimento.</p></div>'}
      ${selected ? renderContactDetail(selected) : ''}
    </div>`;
  host.querySelector('.inbox-filters').insertAdjacentHTML('beforeend','<button class="filter-chip" data-filter="waiting">Aguardando equipe</button>');
  bindInbox();
  host.querySelector('#conversation-search').value=search;
  host.querySelectorAll('[data-filter]').forEach(button=>button.classList.toggle('active',button.dataset.filter===filter));
  if(!listLoading)refreshConversationRows();
}

async function renderInbox(preselectedId) {
  const requestId = ++state.inboxRequestId;
  state.liveSelectedVersion='';
  state.inboxLoading=true;
  try {
  const mobile = window.matchMedia('(max-width: 820px)').matches;
  const listIsFresh = state.conversations.length && Date.now() - state.conversationsLoadedAt < 30000;
  let selectedId = preselectedId || (!mobile ? state.selectedConversation?.id || state.conversations[0]?.id : null);

  paintInbox(selectedId, { listLoading: !state.conversations.length, detailLoading: Boolean(selectedId && Number(state.selectedConversation?.id) !== Number(selectedId)) });

  if (!listIsFresh) {
    try {
      state.conversations = await api('/api/conversations');
      state.conversationsLoadedAt = Date.now();
    } catch (error) {
      if (requestId === state.inboxRequestId) toast('Não foi possível carregar as conversas', error.message, 'error');
      return;
    }
    if (requestId !== state.inboxRequestId) return;
    selectedId = preselectedId || (!mobile ? state.selectedConversation?.id || state.conversations[0]?.id : null);
  }

  const cached = Number(state.selectedConversation?.id) === Number(selectedId) ? state.selectedConversation : null;
  paintInbox(selectedId, { detailLoading: Boolean(selectedId && !cached) });
  if (!selectedId) return;

  try {
    const conversation = await api(`/api/conversations/${selectedId}`);
    if (requestId !== state.inboxRequestId) return;
    state.selectedConversation = conversation;
    paintInbox(selectedId);
  } catch (error) {
    if (requestId !== state.inboxRequestId) return;
    paintInbox(null);
    toast('Não foi possível abrir a conversa', error.message, 'error');
  }
  } finally {if(requestId===state.inboxRequestId)state.inboxLoading=false;}
}

function conversationRows(items, selectedId) {
  return items.map(c => `<button class="conversation-row ${c.id === selectedId ? 'active' : ''}" data-conversation="${c.id}">
    ${contactAvatar(c)}
    <span><strong>${escapeHtml(c.name)}</strong>${c.waiting_human?'<small class="handoff-waiting">Aguardando atendimento humano</small>':''}<p>${c.last_sender === 'ai' ? `${escapeHtml(agentLabel())}: ` : ''}${escapeHtml(c.last_message || '')}</p></span>
    <span class="conversation-meta"><time>${relativeTime(c.last_message_at)}</time>${c.unread_count ? `<b class="unread">${c.unread_count}</b>` : ''}</span>
  </button>`).join('');
}

function renderChat(c) {
  return `<section class="chat-column">
    <header class="chat-header"><button class="back-to-list" id="back-to-list" aria-label="Voltar para conversas">${icon('chevron')}</button>${contactAvatar(c)}<div class="chat-header-copy"><strong>${escapeHtml(c.name)}</strong><span>${c.mode === 'human' ? 'Atendimento humano' : c.mode === 'copilot' ? 'IA em modo copiloto' : `${escapeHtml(agentLabel())} está atendendo`}</span></div><div class="chat-header-actions"><button title="Agendar follow-up ou lembrete" id="schedule-conversation">${icon('calendar')}<span>Agendar</span></button><button title="Ligar para o contato" aria-label="Ligar para o contato">${icon('phone')}</button><button title="Dados, negócio e lembretes" aria-label="Abrir dados do contato" id="toggle-details">${icon('info')}</button></div></header>
    <div class="messages" id="message-scroll"><div class="date-divider">Hoje</div>${c.messages.map(message => renderMessage(message, c)).join('')}</div>
    <form class="chat-composer" id="message-form"><div class="mode-banner">${icon(c.mode === 'human' ? 'users' : 'spark')} ${c.mode === 'human' ? 'Você assumiu esta conversa' : 'Ao responder, a conversa passa para atendimento humano'}</div><div class="composer-box"><div class="composer-leading"><button type="button" id="toggle-emoji" title="Emoji" aria-label="Escolher emoji" aria-expanded="false">${icon('smile')}</button><div class="emoji-picker" id="emoji-picker" hidden>${['😀','😂','😍','👍','🙏','🎉','❤️','✅'].map(emoji=>`<button type="button" data-chat-emoji="${emoji}" aria-label="Inserir ${emoji}">${emoji}</button>`).join('')}</div><button type="button" title="Anexar" aria-label="Anexar arquivo">${icon('paperclip')}</button></div><textarea name="content" rows="1" placeholder="Digite uma mensagem" required></textarea><div class="composer-actions"><button type="button" id="record-audio" title="Gravar áudio" aria-label="Gravar áudio">${icon('mic')}</button><span class="recording-status" id="recording-status"></span><button type="submit" class="send-button" title="Enviar mensagem" aria-label="Enviar mensagem"><span>Enviar</span>${icon('send')}</button></div></div></form>
  </section>`;
}

function renderMessage(message, conversation) {
  const outbound = message.direction === 'outbound';
  const ai = message.sender_type === 'ai';
  return `<div data-message-id="${Number(message.id)}" class="message ${outbound ? 'outbound' : ''} ${ai ? 'ai' : ''}">
    ${outbound ? `<span class="avatar ${ai ? '' : 'avatar-dark'}">${ai ? 'IA' : message.sender_avatar || 'AM'}</span>` : `<span class="avatar">${initials(conversation.name)}</span>`}
    <div class="message-bubble">${ai ? `<span class="ai-label">${icon('spark')} Resposta autónoma</span>` : ''}${message.type === 'audio' ? `<span class="audio-message">${icon('mic')} Áudio ${message.metadata?.transcribed?'transcrito pela IA':''}</span>${message.metadata?.audio_data?`<audio controls preload="metadata" src="${message.metadata.audio_data}"></audio>`:''}` : ''}<p>${escapeHtml(message.content)}</p>${ai?`<button type="button" class="ai-correction-button" data-correct-ai="${message.id}">${icon('settings')} Ajustar aprendizado</button>`:''}<div class="message-info"><time>${new Date(message.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time>${outbound ? `<span class="message-status" aria-label="${message.metadata?.simulated?'Simulação':escapeHtml(message.status)}">${message.metadata?.simulated?'Simulação':({queued:'Na fila',sent:'Enviada ✓',delivered:'Entregue ✓✓',read:'Lida ✓✓',failed:'Falha no envio'})[message.status]||escapeHtml(message.status)}</span>` : ''}</div></div>
  </div>`;
}

function renderContactDetail(c) {
  return `<aside class="detail-column" id="contact-detail"><button class="detail-close" id="detail-close" aria-label="Fechar detalhes">${icon('x')}</button><div class="detail-profile">${contactAvatar(c)}<h3>${escapeHtml(c.name)}</h3><p>${escapeHtml(c.company || 'Sem empresa informada')}</p><div class="tags">${c.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div></div>
    <div class="detail-section"><h4>Contato</h4><div class="detail-field"><span>WhatsApp</span><strong>${escapeHtml(c.phone)}</strong></div><div class="detail-field"><span>E-mail</span><strong>${escapeHtml(c.email || '—')}</strong></div><div class="detail-field"><span>Segmento</span><strong>${escapeHtml(c.segment || '—')}</strong></div><div class="detail-field"><span>Local</span><strong>${escapeHtml(c.location || '—')}</strong></div></div>
    <div class="detail-section"><h4>Oportunidade</h4><div class="deal-card"><div><strong>${escapeHtml(c.stage_name || 'Novo lead')}</strong><b>${money(c.value_cents)}</b></div><span class="qualification-badge ${c.qualification}">${String(c.qualification || 'lead').toUpperCase()}</span><p>Fit comercial: ${c.score || 0}/100</p><div class="score-bar"><span style="width:${c.score || 0}%"></span></div></div></div>
    <div class="detail-section"><h4>Resumo do ${escapeHtml(agentLabel())}</h4><div class="ai-summary"><p>${escapeHtml(c.summary || 'Ainda não há informações suficientes.')}</p><strong>Próxima ação</strong><p>${escapeHtml(c.next_action || 'Aguardar nova mensagem.')}</p><button class="link-button" id="refresh-summary">${icon('spark')} Atualizar resumo</button></div></div>
    <div class="detail-section"><h4>Agendamentos e lembretes</h4><div class="conversation-reminder-list">${c.schedules?.filter(item=>item.status==='scheduled').map(item=>`<span><i>${icon('send')}</i><span><b>Follow-up no WhatsApp</b><small>${escapeHtml(item.payload?.content||'')}</small><time>${new Date(item.send_at).toLocaleString('pt-BR')}</time></span><button type="button" data-cancel-schedule="${item.id}" title="Cancelar">${icon('x')}</button></span>`).join('')||''}${c.tasks?.filter(task=>task.status==='pending').map(task=>`<span><i>${icon('calendar')}</i><span><b>${task.google_event_id?'Google Agenda':escapeHtml(task.title)}</b><small>${escapeHtml(task.description||'Lembrete interno')}</small><time>${task.due_at?new Date(task.due_at).toLocaleString('pt-BR'):'Sem data'}</time></span></span>`).join('')||''}${!c.schedules?.some(item=>item.status==='scheduled')&&!c.tasks?.some(task=>task.status==='pending')?'<p>Nenhum agendamento pendente.</p>':''}</div><div class="conversation-reminder-actions"><button class="soft-button" id="schedule-conversation-side">${icon('calendar')} Agendar sequência</button><button class="soft-button" id="chat-new-task">${icon('plus')} Criar tarefa</button></div></div>
    <div class="detail-section"><h4>Adicionar tag</h4><form class="tag-form" id="contact-tag-form"><input name="tag" placeholder="Etapa ou campanha" required><select name="category"><option value="manual">Manual</option><option value="stage">Funil</option><option value="campaign">Campanha</option></select><button>${icon('plus')}</button></form></div>
    <div class="detail-section"><button class="soft-button" id="toggle-mode" style="width:100%">${c.mode === 'human' ? `${icon('spark')} Devolver para o ${escapeHtml(agentLabel())}` : `${icon('users')} Assumir conversa`}</button></div>
  </aside>`;
}

function bindInbox() {
  document.querySelector('#conversation-list')?.addEventListener('click',event=>{const button=event.target.closest('[data-conversation]');if(button)renderInbox(Number(button.dataset.conversation));});
  const scroll = document.querySelector('#message-scroll'); if (scroll) scroll.scrollTop = scroll.scrollHeight;
  if(state.selectedConversation)applyLiveConversation(state.selectedConversation);
  document.querySelector('#message-form')?.addEventListener('submit', sendMessage);
  document.querySelector('#record-audio')?.addEventListener('click', toggleAudioRecording);
  document.querySelector('#message-form textarea')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form.requestSubmit(); }
  });
  document.querySelector('#toggle-emoji')?.addEventListener('click', event => {
    const picker=document.querySelector('#emoji-picker');picker.hidden=!picker.hidden;event.currentTarget.setAttribute('aria-expanded',String(!picker.hidden));
  });
  document.querySelectorAll('[data-chat-emoji]').forEach(button=>button.addEventListener('click',()=>{const textarea=document.querySelector('#message-form textarea');const start=textarea.selectionStart??textarea.value.length;const end=textarea.selectionEnd??start;textarea.value=`${textarea.value.slice(0,start)}${button.dataset.chatEmoji}${textarea.value.slice(end)}`;textarea.focus();textarea.selectionStart=textarea.selectionEnd=start+button.dataset.chatEmoji.length;document.querySelector('#emoji-picker').hidden=true;document.querySelector('#toggle-emoji').setAttribute('aria-expanded','false');}));
  document.querySelector('#toggle-mode')?.addEventListener('click', toggleConversationMode);
  document.querySelector('#schedule-conversation')?.addEventListener('click', openConversationScheduler);
  document.querySelector('#schedule-conversation-side')?.addEventListener('click', openConversationScheduler);
  document.querySelector('#back-to-list')?.addEventListener('click', () => { state.selectedConversation = null; renderInbox(); });
  document.querySelector('#toggle-details')?.addEventListener('click', () => document.querySelector('#contact-detail')?.classList.toggle('open'));
  document.querySelector('#detail-close')?.addEventListener('click', () => document.querySelector('#contact-detail')?.classList.remove('open'));
  document.querySelector('#chat-new-task')?.addEventListener('click', () => openTaskModal(state.selectedConversation));
  document.querySelectorAll('[data-cancel-schedule]').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('Cancelar este follow-up agendado?'))return;await api(`/api/scheduled-messages/${button.dataset.cancelSchedule}`,{method:'DELETE'});toast('Agendamento cancelado','A mensagem não será enviada.');await renderInbox(state.selectedConversation.id);}));
  scroll?.addEventListener('click',event=>{const button=event.target.closest('[data-correct-ai]');if(button)openAiCorrection(Number(button.dataset.correctAi));});
  document.querySelector('#refresh-summary')?.addEventListener('click', async () => { await api(`/api/conversations/${state.selectedConversation.id}/summary`, { method: 'POST' }); toast('Resumo atualizado', `${agentLabel()} consolidou o progresso mais recente.`); await renderInbox(state.selectedConversation.id); });
  document.querySelector('#contact-tag-form')?.addEventListener('submit', async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); await api(`/api/contacts/${state.selectedConversation.contact_id}/tags`, { method: 'POST', body: data }); toast('Tag adicionada', 'O contato foi atualizado.'); await renderInbox(state.selectedConversation.id); });
  document.querySelector('#conversation-search')?.addEventListener('input', event => {
    refreshConversationRows();
  });
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach(item => item.classList.remove('active')); button.classList.add('active');
    refreshConversationRows();
  }));
}

function conversationScheduleRow(index,values={}){
  const date=new Date(Date.now()+(index+1)*24*60*60*1000);const day=values.day||new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,10);const time=values.time||'10:00';
  return `<div class="conversation-schedule-row" data-schedule-row><header><strong>Etapa ${index+1}</strong><button type="button" data-remove-schedule aria-label="Remover etapa">${icon('trash')}</button></header><div class="form-grid-two"><label>Tipo<select data-schedule-kind><option value="followup" ${values.kind==='followup'||!values.kind?'selected':''}>Mensagem de follow-up</option><option value="reminder" ${values.kind==='reminder'?'selected':''}>Lembrete interno</option><option value="calendar" ${values.kind==='calendar'?'selected':''}>Compromisso no Google Agenda</option></select></label><label>Dia e horário<span class="schedule-datetime"><input type="date" data-schedule-date value="${day}" required><input type="time" data-schedule-time value="${time}" required></span></label></div><label>Modelo aprovado para WhatsApp<select data-schedule-template><option value="">Texto livre dentro da janela de atendimento</option>${(state.scheduleTemplates||[]).map(item=>`<option value="${item.id}">${escapeHtml(item.display_name)}</option>`).join('')}</select></label><label>Valores das variáveis do modelo (um por linha)<textarea data-schedule-variables rows="2" placeholder="Preencha na ordem das variáveis do modelo"></textarea></label><small>Fora da janela de atendimento, selecione um modelo aprovado. O conteúdo do modelo será enviado conforme aprovado pela Meta.</small><label><span data-schedule-content-label>${values.kind==='followup'||!values.kind?'Mensagem':'Descrição'}</span><textarea data-schedule-content rows="3" maxlength="4000" placeholder="${values.kind==='followup'||!values.kind?'Escreva a mensagem que será enviada automaticamente…':'Descreva o que precisa ser lembrado…'}" required>${escapeHtml(values.content||'')}</textarea></label></div>`;
}

function bindConversationScheduleRows(){
  const host=document.querySelector('#conversation-schedule-rows');
  host.querySelectorAll('[data-schedule-template]').forEach(select=>select.onchange=()=>{const row=select.closest('[data-schedule-row]');const template=(state.scheduleTemplates||[]).find(item=>item.id===Number(select.value));if(template)row.querySelector('[data-schedule-content]').value=template.body;});
  host.querySelectorAll('[data-remove-schedule]').forEach(button=>button.onclick=()=>{if(host.children.length===1)return toast('Mantenha uma etapa','A sequência precisa ter pelo menos um item.','error');button.closest('[data-schedule-row]').remove();[...host.children].forEach((row,index)=>row.querySelector('header strong').textContent=`Etapa ${index+1}`);});
  host.querySelectorAll('[data-schedule-kind]').forEach(select=>select.onchange=()=>{const row=select.closest('[data-schedule-row]'),message=select.value==='followup';row.querySelector('[data-schedule-content-label]').textContent=message?'Mensagem':'Descrição';row.querySelector('[data-schedule-content]').placeholder=message?'Escreva a mensagem que será enviada automaticamente…':'Descreva o que precisa ser lembrado…';});
}

async function openConversationScheduler(){
  try{state.scheduleTemplates=(await api('/api/message-templates')).filter(item=>item.source==='meta');}catch(error){return toast('Não foi possível carregar os modelos',error.message,'error');}
  const conversation=state.selectedConversation;if(!conversation)return;
  const host=document.querySelector('#detail-modal-content');host.innerHTML=`<div class="modal-icon">${icon('calendar')}</div><p class="overline">${escapeHtml(conversation.name)}</p><h2>Follow-ups e lembretes</h2><p>Monte uma sequência de mensagens, lembretes internos ou compromissos sincronizados com o Google Agenda.</p><form id="conversation-schedule-form"><div id="conversation-schedule-rows">${conversationScheduleRow(0)}</div><button type="button" class="ghost-button add-schedule-row" id="add-conversation-schedule">${icon('plus')} Adicionar outra etapa ou outro dia</button><div class="modal-actions"><button type="button" class="ghost-button" data-close-modal>Cancelar</button><button type="submit" class="primary-button">Salvar agendamentos</button></div></form>`;openModal('detail-modal');bindConversationScheduleRows();
  host.querySelectorAll('[data-close-modal]').forEach(button=>button.addEventListener('click',closeModals));
  host.querySelector('#add-conversation-schedule').onclick=()=>{const rows=host.querySelector('#conversation-schedule-rows');if(rows.children.length>=12)return toast('Limite da sequência','Use no máximo 12 itens por conversa.','error');rows.insertAdjacentHTML('beforeend',conversationScheduleRow(rows.children.length));bindConversationScheduleRows();};
  host.querySelector('#conversation-schedule-form').onsubmit=async event=>{event.preventDefault();const button=event.currentTarget.querySelector('[type=submit]');const items=[...host.querySelectorAll('[data-schedule-row]')].map(row=>({kind:row.querySelector('[data-schedule-kind]').value,send_at:new Date(`${row.querySelector('[data-schedule-date]').value}T${row.querySelector('[data-schedule-time]').value}:00`).toISOString(),variables:row.querySelector('[data-schedule-variables]').value.split('\n').map(value=>value.trim()).filter(Boolean),template_id:Number(row.querySelector('[data-schedule-template]').value)||null,content:row.querySelector('[data-schedule-template]').value?(state.scheduleTemplates.find(item=>item.id===Number(row.querySelector('[data-schedule-template]').value))?.body||'Modelo aprovado'):row.querySelector('[data-schedule-content]').value.trim()}));button.disabled=true;button.textContent='Salvando…';try{const result=await api(`/api/conversations/${conversation.id}/schedules`,{method:'POST',body:{items}});const warnings=result.created.filter(item=>item.calendar_sync_warning);closeModals();toast('Agendamentos salvos',warnings.length?'Os lembretes foram criados, mas um compromisso ainda não sincronizou com o Google.':`${result.created.length} item(ns) programado(s).`);await renderInbox(conversation.id);}catch(error){toast('Não foi possível agendar',error.message,'error');button.disabled=false;button.textContent='Salvar agendamentos';}};
}

function openAiCorrection(messageId) {
  const messages=state.selectedConversation?.messages||[];const index=messages.findIndex(message=>Number(message.id)===Number(messageId));const message=messages[index];if(!message)return;
  const question=[...messages.slice(0,index)].reverse().find(item=>item.direction==='inbound')?.content||'';const host=document.querySelector('#detail-modal-content');
  host.innerHTML=`<div class="modal-icon">${icon('spark')}</div><p class="overline">Autoevolução supervisionada</p><h2>Ensinar com esta conversa</h2><p>Registre o ajuste como uma instrução viva. Depois de salvar, ele passa a orientar as próximas respostas.</p><div class="learning-example"><small>Mensagem do lead</small><p>${escapeHtml(question||'Contexto não identificado')}</p><small>Resposta do agente</small><p>${escapeHtml(message.content)}</p></div><form id="conversation-learning-form" class="learning-feedback-form"><label>O que o agente deve aprender?<textarea name="instruction" rows="3" required placeholder="Ex.: Termine todas as respostas comerciais com uma pergunta relevante."></textarea></label><label>Resposta ideal para este caso<textarea name="corrected_response" rows="3" placeholder="Escreva um exemplo melhor, se quiser."></textarea></label><label>Onde essa regra vale?<input name="applies_to" placeholder="Ex.: Toda a jornada, negociação ou objeções" value="Toda a jornada comercial" required></label><div class="modal-actions"><button type="button" class="ghost-button" data-close-modal>Cancelar</button><button class="primary-button" type="submit">Salvar e aplicar agora</button></div></form>`;openModal('detail-modal');
  host.querySelectorAll('[data-close-modal]').forEach(button=>button.addEventListener('click',closeModals));
  host.querySelector('#conversation-learning-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('[type=submit]');button.disabled=true;try{const data=Object.fromEntries(new FormData(event.currentTarget));await api('/api/agent/learning',{method:'POST',body:{...data,source_type:'conversation',source_message_id:message.id,example_question:question,original_response:message.content,approve:true}});closeModals();toast('Aprendizado aplicado','A nova instrução já orienta as próximas respostas do agente.');}catch(error){toast('Não foi possível salvar',error.message,'error');button.disabled=false;}});
}

let activeRecorder = null; let audioChunks = [];
async function toggleAudioRecording(event) {
  const button=event.currentTarget; const status=document.querySelector('#recording-status');
  if(activeRecorder?.state==='recording'){ activeRecorder.stop(); return; }
  try { const stream=await navigator.mediaDevices.getUserMedia({audio:true}); audioChunks=[]; const recordingType=['audio/mp4','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));if(!recordingType){stream.getTracks().forEach(track=>track.stop());throw new Error('Este navegador não grava um formato aceito pelo WhatsApp. Use uma versão atualizada do navegador.');}activeRecorder=new MediaRecorder(stream,{mimeType:recordingType}); activeRecorder.ondataavailable=e=>audioChunks.push(e.data); activeRecorder.onstop=async()=>{button.classList.remove('recording');status.textContent='Transcrevendo…';stream.getTracks().forEach(t=>t.stop());const blob=new Blob(audioChunks,{type:activeRecorder.mimeType||'audio/webm'});const buffer=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<buffer.length;i+=32768)binary+=String.fromCharCode(...buffer.subarray(i,i+32768));try{await api(`/api/conversations/${state.selectedConversation.id}/audio`,{method:'POST',body:{data_base64:btoa(binary),mime_type:blob.type}});state.conversations=[];await renderInbox(state.selectedConversation.id);toast('Áudio enviado','A IA registrou a transcrição na conversa.');}catch(error){toast('Falha no áudio',error.message,'error');status.textContent='';}};activeRecorder.start();button.classList.add('recording');status.textContent='Gravando… clique para enviar'; }
  catch(error){toast('Microfone indisponível','Autorize o acesso ao microfone no navegador.','error');}
}

async function sendMessage(event) {
  event.preventDefault();
  const textarea = event.currentTarget.elements.content;
  const content = textarea.value.trim(); if (!content) return;
  textarea.disabled = true;
  try { await api(`/api/conversations/${state.selectedConversation.id}/messages`, { method: 'POST', body: { content } }); state.conversations = []; await renderInbox(state.selectedConversation.id); toast('Mensagem enviada', 'A conversa passou para atendimento humano.'); }
  catch (error) { toast('Não foi possível enviar', error.message, 'error'); textarea.disabled = false; }
}

async function toggleConversationMode() {
  const next = state.selectedConversation.mode === 'human' && !state.selectedConversation.waiting_human ? 'autopilot' : 'human';
  await api(`/api/conversations/${state.selectedConversation.id}`, { method: 'PATCH', body: { mode: next } });
  state.conversations = [];
  await renderInbox(state.selectedConversation.id);
  toast(next === 'human' ? 'Conversa assumida' : 'Piloto automático ativado', next === 'human' ? `${agentLabel()} pausou as respostas automáticas nesta conversa.` : `${agentLabel()} voltará a responder novas mensagens.`);
}

async function renderPipeline(liveData=null) {
  if(!liveData)setLoading('#view-pipeline');
  if (!state.pipelines.length || !state.users.length) [state.pipelines, state.users] = await Promise.all([api('/api/pipelines'), api('/api/users')]);
  state.selectedPipelineId ||= state.pipelines[0]?.id;
  state.pipeline = liveData||await api(`/api/pipeline?pipeline_id=${state.selectedPipelineId}`);
  document.querySelector('#view-pipeline').innerHTML = `<div class="section-head"><div class="funnel-title-area"><h2>Funis</h2><p>Arraste oportunidades entre etapas ou até a bandeja inferior para excluir, perder ou ganhar.</p><div class="funnel-switcher"><button type="button" id="funnel-switcher" aria-expanded="false" aria-haspopup="listbox"><span><small>Funil atual</small><strong>${escapeHtml(state.pipeline.pipeline.name)}</strong></span>${icon('arrow')}</button><div class="funnel-switcher-menu" id="funnel-switcher-menu" role="listbox" hidden>${state.pipelines.map(item => `<button type="button" role="option" data-funnel-id="${item.id}" aria-selected="${item.id === state.selectedPipelineId}"><span>${icon('pipeline')}</span><span><strong>${escapeHtml(item.name)}</strong><small>${item.id === state.selectedPipelineId ? 'Em exibição' : 'Abrir este funil'}</small></span>${item.id === state.selectedPipelineId ? icon('check') : ''}</button>`).join('')}</div></div></div><div class="pipeline-actions"><button class="ghost-button" id="new-deal">${icon('plus')} Novo negócio</button><button class="ghost-button" id="edit-pipeline">${icon('sliders')} Editar funil</button><button class="primary-button" id="new-pipeline">${icon('plus')} Novo funil</button></div></div><div class="pipeline-stats"><span><b>${state.pipeline.deals.filter(item => item.status === 'open').length}</b> em andamento</span><span class="won"><b>${state.pipeline.closed?.won||0}</b> ganhos</span><span class="lost"><b>${state.pipeline.closed?.lost||0}</b> perdidos</span></div><div class="pipeline-board" style="grid-template-columns:repeat(${Math.max(3, state.pipeline.stages.length)},minmax(230px,1fr))">${state.pipeline.stages.map((stage, index) => renderStage(stage, state.pipeline.deals.filter(deal => deal.stage_id === stage.id), index === 0)).join('')}</div><div class="pipeline-drop-actions" id="pipeline-drop-actions"><div class="delete" data-deal-drop="delete">${icon('trash')}<strong>Excluir</strong><small>Apagar negócio</small></div><div class="lost" data-deal-drop="lost">${icon('x')}<strong>Perda</strong><small>Registrar motivo</small></div><div class="won" data-deal-drop="won">${icon('check')}<strong>Ganho</strong><small>Enviar para clientes</small></div></div>`;
  const switcher=document.querySelector('#funnel-switcher'),menu=document.querySelector('#funnel-switcher-menu');
  switcher.addEventListener('click',event=>{event.stopPropagation();const open=menu.hidden;menu.hidden=!open;switcher.setAttribute('aria-expanded',String(open));});
  document.querySelectorAll('[data-funnel-id]').forEach(button=>button.addEventListener('click',()=>{state.selectedPipelineId=Number(button.dataset.funnelId);renderPipeline();}));
  document.addEventListener('click',()=>{if(menu?.isConnected){menu.hidden=true;switcher.setAttribute('aria-expanded','false');}},{once:true});
  document.querySelector('#new-pipeline').addEventListener('click', () => openModal('pipeline-modal'));
  document.querySelector('#new-deal').addEventListener('click', () => openNewDeal());
  document.querySelector('#edit-pipeline').addEventListener('click', openPipelineEditor);
  document.querySelectorAll('[data-new-deal-stage]').forEach(button => button.addEventListener('click', () => openNewDeal(Number(button.dataset.newDealStage))));
  bindDragAndDrop();
}

function pipelineStageRow(stage = {}, triggerPhrases = []) {
  const count = stage.id ? state.pipeline.deals.filter(deal => deal.stage_id === stage.id).length : 0;
  return `<div class="pipeline-stage-row" data-stage-id="${stage.id || ''}"><div class="pipeline-stage-main"><span class="stage-grip">${icon('menu')}</span><input data-stage-name aria-label="Nome da etapa" maxlength="80" value="${escapeHtml(stage.name || '')}" placeholder="Nome da etapa" required><small>${count} negócio(s)</small><div><button type="button" data-stage-up aria-label="Mover para cima">↑</button><button type="button" data-stage-down aria-label="Mover para baixo">↓</button><button type="button" data-remove-stage aria-label="Remover etapa" ${count ? 'title="Mova os negócios antes de remover"' : ''}>${icon('trash')}</button></div></div><label class="conversation-trigger-field">${icon('spark')}<span><strong>Avançar pela conversa</strong><small>Palavras ou frases separadas por vírgula</small></span><input data-stage-triggers value="${escapeHtml(triggerPhrases.join(', '))}" placeholder="Ex.: quero uma proposta, pode enviar o orçamento"></label></div>`;
}

function bindPipelineEditorRows() {
  const host = document.querySelector('#pipeline-stage-editor');
  host.querySelectorAll('[data-stage-up]').forEach(button => button.onclick = () => { const row=button.closest('.pipeline-stage-row'); if(row.previousElementSibling)host.insertBefore(row,row.previousElementSibling); });
  host.querySelectorAll('[data-stage-down]').forEach(button => button.onclick = () => { const row=button.closest('.pipeline-stage-row'); if(row.nextElementSibling)host.insertBefore(row.nextElementSibling,row); });
  host.querySelectorAll('[data-remove-stage]').forEach(button => button.onclick = () => { const row=button.closest('.pipeline-stage-row'); const count=Number(row.querySelector('small').textContent.match(/\d+/)?.[0]||0); if(count)return toast('Etapa em uso','Mova os negócios desta coluna antes de removê-la.','error'); if(host.children.length===1)return toast('Mantenha uma etapa','O funil precisa ter pelo menos uma coluna.','error'); row.remove(); });
}

async function openPipelineEditor() {
  try{const [allStages,rules,conversationRules]=await Promise.all([api('/api/pipeline-stages'),api(`/api/pipeline-outcome-rules?pipeline_id=${state.selectedPipelineId}`),api(`/api/pipeline-conversation-rules?pipeline_id=${state.selectedPipelineId}`)]);const triggerMap=new Map(conversationRules.map(rule=>[rule.stage_id,rule.trigger_phrases]));document.querySelector('#pipeline-stage-editor').innerHTML=state.pipeline.stages.map(stage=>pipelineStageRow(stage,triggerMap.get(stage.id)||[])).join('');bindPipelineEditorRows();const options=allStages.map(stage=>`<option value="${stage.id}">${escapeHtml(stage.pipeline_name)} · ${escapeHtml(stage.name)}</option>`).join('');const won=rules.find(rule=>rule.outcome==='won')?.target_stage_id||'';const lost=rules.find(rule=>rule.outcome==='lost')?.target_stage_id||'';document.querySelector('#won-outcome-stage').innerHTML=`<option value="">Padrão: funil de clientes</option>${options}`;document.querySelector('#lost-outcome-stage').innerHTML=`<option value="">Padrão: tratamento escolhido na perda</option>${options}`;document.querySelector('#won-outcome-stage').value=String(won);document.querySelector('#lost-outcome-stage').value=String(lost);}catch(error){document.querySelector('#pipeline-stage-editor').innerHTML=state.pipeline.stages.map(stage=>pipelineStageRow(stage)).join('');bindPipelineEditorRows();toast('Não foi possível carregar as automações',error.message,'error');}
  openModal('edit-pipeline-modal');
}

document.querySelector('#add-pipeline-stage').addEventListener('click', () => {
  const host=document.querySelector('#pipeline-stage-editor'); if(host.children.length>=12)return toast('Limite de etapas','Use no máximo 12 colunas por funil.','error');
  host.insertAdjacentHTML('beforeend',pipelineStageRow()); bindPipelineEditorRows(); host.lastElementChild.querySelector('[data-stage-name]').focus();
});

function renderStage(stage, deals, showCreateCard = false) {
  const createCard = showCreateCard ? `<button class="new-deal-card" type="button" data-new-deal-stage="${stage.id}">${icon('plus')}<span><strong>Criar novo negócio</strong><small>Adicionar oportunidade nesta etapa</small></span></button>` : '';
  return `<section class="stage-column" data-stage="${stage.id}"><header class="stage-header"><i class="stage-dot" style="background:${stage.color}"></i><strong>${escapeHtml(stage.name)}</strong><b>${deals.length}</b><span>${money(deals.reduce((sum, deal) => sum + deal.value_cents, 0), true)}</span></header>${createCard}${deals.map(deal => `<article class="deal-item ${deal.status}" draggable="${deal.status === 'open'}" data-deal="${deal.id}">${deal.status === 'open' ? `<button type="button" class="deal-task-button" data-create-deal-task="${deal.id}" aria-label="Criar tarefa para ${escapeHtml(deal.title)}" title="Criar tarefa">${icon('calendar')}</button>` : ''}<div class="company"><span class="mini-avatar">${initials(deal.company || deal.contact_name)}</span>${escapeHtml(deal.company || deal.contact_name || 'Contato sem empresa')}</div><h3>${escapeHtml(deal.title)}</h3>${deal.status !== 'open' ? `<span class="deal-status ${deal.status}">${deal.status === 'won' ? 'Ganho' : `Perdido · ${escapeHtml(deal.lost_reason || '')}`}</span>` : ''}<div class="deal-bottom"><span class="deal-value">${money(deal.value_cents)}</span><span class="score-pill">${deal.score || 0}% fit</span></div><label class="deal-owner-control"><span class="mini-avatar">${escapeHtml(deal.owner_avatar || initials(deal.owner_name || 'AM'))}</span><span>Responsável</span><select data-deal-owner="${deal.id}" aria-label="Responsável pelo negócio ${escapeHtml(deal.title)}">${state.users.map(user=>`<option value="${user.id}" ${Number(user.id)===Number(deal.owner_id)?'selected':''}>${escapeHtml(user.name)}</option>`).join('')}</select></label><label class="mobile-stage-control">Mover para<select data-deal-stage="${deal.id}">${state.pipeline.stages.map(option => `<option value="${option.id}" ${option.id === deal.stage_id ? 'selected' : ''}>${escapeHtml(option.name)}</option>`).join('')}</select></label></article>`).join('')}</section>`;
}

async function openNewDeal(stageId = null) {
  const form = document.querySelector('#deal-form');
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    state.contacts = await api('/api/contacts');
    const selectedStage = stageId || state.pipeline.stages[0]?.id;
    document.querySelector('#deal-contact').innerHTML = `<option value="">+ Criar um novo lead agora</option>${state.contacts.map(contact => `<option value="${contact.id}">${escapeHtml(contact.name)}${contact.company ? ` · ${escapeHtml(contact.company)}` : ''}</option>`).join('')}`;
    document.querySelector('#deal-stage').innerHTML = state.pipeline.stages.map(stage => `<option value="${stage.id}" ${stage.id === selectedStage ? 'selected' : ''}>${escapeHtml(stage.name)}</option>`).join('');
    form.reset();
    document.querySelector('#deal-stage').value = String(selectedStage);
    toggleDealContactFields();
    openModal('deal-modal');
  } catch (error) {
    toast('Não foi possível preparar o negócio', error.message, 'error');
  } finally {
    submit.disabled = false;
  }
}

function toggleDealContactFields() {
  const creating=!document.querySelector('#deal-contact').value; const fields=document.querySelector('#new-deal-contact-fields');
  fields.hidden=!creating;
}
document.querySelector('#deal-contact').addEventListener('change',toggleDealContactFields);

function bindDragAndDrop() {
  let dragged; let moved = false;
  document.querySelectorAll('.deal-item').forEach(item => {
    item.addEventListener('dragstart', event => { dragged = item; moved = true; item.classList.add('dragging'); document.body.classList.add('pipeline-drag-active'); event.dataTransfer.effectAllowed='move'; event.dataTransfer.setData('text/plain',item.dataset.deal); });
    item.addEventListener('dragend', () => { item.classList.remove('dragging'); document.body.classList.remove('pipeline-drag-active'); document.querySelectorAll('.stage-column,[data-deal-drop]').forEach(c=>c.classList.remove('dragover')); setTimeout(()=>{moved=false;},40); });
    item.addEventListener('click', event => { if (!moved && !event.target.closest('button,select,label')) { const deal=state.pipeline.deals.find(entry=>entry.id===Number(item.dataset.deal)); if(deal)openDealEditor(deal); } });
  });
  document.querySelectorAll('.stage-column').forEach(column => {
    column.addEventListener('dragover', event => { event.preventDefault(); column.classList.add('dragover'); });
    column.addEventListener('dragleave', () => column.classList.remove('dragover'));
    column.addEventListener('drop', async event => {
      event.preventDefault(); column.classList.remove('dragover'); if (!dragged) return;
      const previous = dragged.parentElement; column.append(dragged); dragged.classList.add('just-moved');
      try { await api(`/api/deals/${dragged.dataset.deal}`, { method: 'PATCH', body: { stage_id: Number(column.dataset.stage) } }); toast('Funil atualizado', 'A oportunidade foi movida para a nova etapa.'); }
      catch(error){ previous.append(dragged); toast('Não foi possível mover',error.message,'error'); }
      finally { setTimeout(()=>dragged?.classList.remove('just-moved'),350); }
    });
  });
  document.querySelectorAll('[data-deal-stage]').forEach(select => select.addEventListener('change', async () => {
    select.disabled = true;
    await api(`/api/deals/${select.dataset.dealStage}`, { method: 'PATCH', body: { stage_id: Number(select.value) } });
    toast('Funil atualizado', 'A oportunidade foi movida para a nova etapa.');
    await renderPipeline();
  }));
  document.querySelectorAll('[data-deal-owner]').forEach(select=>select.addEventListener('change',async event=>{
    event.stopPropagation();select.disabled=true;
    try{const updated=await api(`/api/deals/${select.dataset.dealOwner}`,{method:'PATCH',body:{owner_id:Number(select.value)}});const deal=state.pipeline.deals.find(item=>item.id===Number(select.dataset.dealOwner));if(deal)Object.assign(deal,updated);toast('Responsável alterado',`${updated.owner_name || 'A pessoa escolhida'} agora cuida deste negócio.`);await renderPipeline();}
    catch(error){select.disabled=false;toast('Não foi possível alterar',error.message,'error');}
  }));
  document.querySelectorAll('[data-create-deal-task]').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    const deal=state.pipeline.deals.find(item=>item.id===Number(button.dataset.createDealTask));
    if(deal)await openTaskModal(null,null,deal);
  }));
  document.querySelectorAll('[data-deal-drop]').forEach(zone=>{
    zone.addEventListener('dragover',event=>{event.preventDefault();event.stopPropagation();zone.classList.add('dragover');});
    zone.addEventListener('dragleave',()=>zone.classList.remove('dragover'));
    zone.addEventListener('drop',async event=>{event.preventDefault();event.stopPropagation();zone.classList.remove('dragover');if(!dragged)return;const id=Number(dragged.dataset.deal);document.body.classList.remove('pipeline-drag-active');
      if(zone.dataset.dealDrop==='won'){try{await api(`/api/deals/${id}`,{method:'PATCH',body:{status:'won'}});toast('Negócio ganho','O contato foi enviado para clientes.');await renderPipeline();}catch(error){toast('Não foi possível concluir',error.message,'error');}}
      if(zone.dataset.dealDrop==='lost')await openLossDialog(id);
      if(zone.dataset.dealDrop==='delete'&&confirm('Excluir este negócio definitivamente? O contato continuará salvo.')){try{await api(`/api/deals/${id}`,{method:'DELETE'});toast('Negócio excluído','O card foi removido e o contato foi mantido.');await renderPipeline();}catch(error){toast('Não foi possível excluir',error.message,'error');}}
    });
  });
}

async function openLossDialog(dealId){const reasons=await api('/api/loss-reasons');document.querySelector('#loss-form [name=deal_id]').value=dealId;document.querySelector('#loss-reason-select').innerHTML=`<option value="">Selecione…</option>${reasons.map(reason=>`<option>${escapeHtml(reason.name)}</option>`).join('')}`;openModal('loss-modal');}

function openDealDetail(id) {
  const deal = state.pipeline.deals.find(item => item.id === id); if (!deal) return;
  const stageName = deal.stage_name || state.pipeline.stages.find(stage => stage.id === deal.stage_id)?.name || '—';
  document.querySelector('#detail-modal-content').innerHTML = `<div class="modal-icon">${icon('pipeline')}</div><p class="overline">Oportunidade</p><h2>${escapeHtml(deal.title)}</h2><div class="detail-summary-grid"><span><small>Contato</small><strong>${escapeHtml(deal.contact_name || '—')}</strong></span><span><small>Empresa</small><strong>${escapeHtml(deal.company || '—')}</strong></span><span><small>Valor</small><strong>${money(deal.value_cents)}</strong></span><span><small>Fit</small><strong>${deal.score || 0}%</strong></span><span><small>Etapa</small><strong>${escapeHtml(stageName)}</strong></span><span><small>Status</small><strong>${deal.status === 'open' ? 'Em andamento' : deal.status === 'won' ? 'Ganho' : 'Perdido'}</strong></span></div><div class="ai-deal-summary"><div><small>Resumo da IA</small><p>${escapeHtml(deal.ai_summary || 'Ainda não há interações suficientes para gerar um resumo.')}</p><strong>Próxima ação: ${escapeHtml(deal.next_action || 'Aguardar nova interação.')}</strong></div></div><div class="modal-actions"><button class="ghost-button" type="button" data-edit-deal="${deal.id}">${icon('sliders')} Editar lead</button>${deal.conversation_id ? `<button class="ghost-button detail-conversation-button" data-open-deal-conversation="${deal.conversation_id}">${icon('message')} Ir para a conversa</button>` : ''}</div>`;
  openModal('detail-modal');
  document.querySelector('[data-edit-deal]')?.addEventListener('click',()=>openDealEditor(deal));
  document.querySelector('[data-open-deal-conversation]')?.addEventListener('click', event => { closeModals(); navigate('inbox', Number(event.currentTarget.dataset.openDealConversation)); });
}

function openDealEditor(deal){
  const host=document.querySelector('#detail-modal-content');const phone=String(deal.phone||'').startsWith('manual:')?'':deal.phone||'';const sourceOptions=[['manual','Cadastro manual'],['whatsapp','WhatsApp'],['instagram','Instagram'],['facebook','Facebook'],['meta_ads','Meta Ads'],['google_ads','Google Ads'],['indicacao','Indicação'],['organico','Orgânico'],['outro','Outro']];
  host.innerHTML=`<div class="deal-edit-top"><div><div class="modal-icon">${icon('sliders')}</div><p class="overline">Editar oportunidade</p></div>${deal.conversation_id?`<button type="button" class="ghost-button deal-conversation-top" data-open-deal-conversation="${deal.conversation_id}">${icon('message')} Ir para a conversa</button>`:''}</div><h2>${escapeHtml(deal.title)}</h2><p>Atualize os dados do negócio e do contato. Somente o nome do negócio e a etapa são obrigatórios.</p><form id="deal-edit-form" class="deal-edit-form"><label>Nome do negócio<input name="title" maxlength="160" value="${escapeHtml(deal.title)}" required></label><div class="form-grid-two"><label>Contato<input name="contact_name" maxlength="120" value="${escapeHtml(deal.contact_name||'')}"></label><label>Empresa<input name="company" maxlength="120" value="${escapeHtml(deal.company||'')}"></label></div><div class="form-grid-two"><label>Telefone<input name="phone" maxlength="30" value="${escapeHtml(phone)}"></label><label>E-mail<input name="email" type="email" maxlength="160" value="${escapeHtml(deal.email||'')}"></label></div><div class="form-grid-two"><label>Canal de origem<select name="source">${sourceOptions.map(([value,label])=>`<option value="${value}" ${deal.source===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Segmento<input name="segment" maxlength="100" value="${escapeHtml(deal.segment||'')}"></label></div><div class="form-grid-two"><label>Etapa<select name="stage_id" required>${state.pipeline.stages.map(stage=>`<option value="${stage.id}" ${stage.id===deal.stage_id?'selected':''}>${escapeHtml(stage.name)}</option>`).join('')}</select></label><label>Valor estimado (R$)<input name="value" type="number" min="0" step="0.01" value="${(Number(deal.value_cents)||0)/100}"></label></div><div class="form-grid-two"><label>Previsão de fechamento<input name="expected_close_at" type="date" value="${escapeHtml(String(deal.expected_close_at||'').slice(0,10))}"></label><label>Fit comercial (%)<input name="score" type="number" min="0" max="100" value="${Number(deal.score)||0}"></label></div><label class="sdr-notes-field"><span>Anotação do SDR</span><textarea name="sdr_notes" rows="4" maxlength="1000" placeholder="Registre contexto da abordagem, objeções, combinados e próximos passos…">${escapeHtml(deal.sdr_notes||'')}</textarea><small>Esta anotação fica vinculada ao contato e disponível para toda a equipe.</small></label><div class="modal-actions"><button type="button" class="ghost-button" data-cancel-deal-edit>Cancelar</button><button type="submit" class="primary-button">Salvar alterações</button></div></form>`;
  openModal('detail-modal');
  host.querySelector('[data-cancel-deal-edit]').addEventListener('click',closeModals);
  host.querySelector('[data-open-deal-conversation]')?.addEventListener('click',event=>{closeModals();navigate('inbox',Number(event.currentTarget.dataset.openDealConversation));});
  host.querySelector('#deal-edit-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('[type=submit]');const values=Object.fromEntries(new FormData(form));button.disabled=true;button.textContent='Salvando…';try{await api(`/api/deals/${deal.id}`,{method:'PATCH',body:{title:values.title,stage_id:Number(values.stage_id),value_cents:Math.round(Number(values.value||0)*100),score:Number(values.score||0),expected_close_at:values.expected_close_at||null,contact:{name:values.contact_name,company:values.company,phone:values.phone,email:values.email,source:values.source,segment:values.segment,notes:values.sdr_notes}}});closeModals();toast('Lead atualizado','As alterações já aparecem no funil.');await renderPipeline();}catch(error){toast('Não foi possível editar',error.message,'error');button.disabled=false;button.textContent='Salvar alterações';}});
}

async function renderContacts(liveData=null) {
  if(!liveData)setLoading('#view-contacts'); [state.contacts,state.organizations] = liveData||await Promise.all([api('/api/contacts'),api('/api/organizations')]); state.contactView ||= 'people';
  if(state.contactView==='companies'){
    document.querySelector('#view-contacts').innerHTML=`<div class="section-head"><div><h2>Empresas</h2><p>Cada empresa pode reunir vários contatos e oportunidades.</p></div><div class="section-actions"><div class="view-switch"><button data-contact-view="people">Pessoas</button><button class="active" data-contact-view="companies">Empresas</button></div><button class="primary-button" id="new-organization">${icon('plus')} Nova empresa</button></div></div><div class="organization-grid">${state.organizations.map(org=>`<article class="panel organization-card"><span class="mini-avatar">${initials(org.name)}</span><div><h3>${escapeHtml(org.name)}</h3><p>${org.contact_count} contato(s) · ${money(org.pipeline_value)} em aberto</p>${org.segment?`<span class="stage-badge">${escapeHtml(org.segment)}</span>`:''}</div></article>`).join('')||'<div class="empty-state"><h3>Nenhuma empresa</h3><p>Crie a primeira empresa e vincule seus contatos.</p></div>'}</div>`;
    document.querySelectorAll('[data-contact-view]').forEach(button=>button.addEventListener('click',()=>{state.contactView=button.dataset.contactView;renderContacts();}));
    document.querySelector('#new-organization').addEventListener('click',async()=>{const name=prompt('Nome da empresa');if(!name)return;try{await api('/api/organizations',{method:'POST',body:{name}});toast('Empresa criada','Agora ela pode receber vários contatos.');await renderContacts();}catch(error){toast('Não foi possível criar',error.message,'error');}});return;
  }
  state.selectedContacts = new Set([...state.selectedContacts].filter(id => state.contacts.some(c => c.id === id)));
  document.querySelector('#view-contacts').innerHTML = `<div class="section-head"><div><h2>Contatos</h2><p>Uma visão única de cada pessoa, seu canal de aquisição e o funil atual.</p></div><span class="stage-badge">${state.contacts.length} contatos</span></div><div class="table-panel"><div class="table-toolbar"><div class="contact-search-group"><span class="contact-filter-control"><select id="contact-search-scope" aria-label="Pesquisar por"><option value="all">Nome ou empresa</option><option value="name">Somente contato</option><option value="company">Somente empresa</option></select></span><div class="inbox-search">${icon('search')}<input id="contact-search" placeholder="Pesquisar nome ou empresa" /></div></div><div class="bulk-actions"><button class="ghost-button" id="contacts-to-campaign" disabled>${icon('send')} Disparo</button><button class="ghost-button" id="export-contacts" disabled>${icon('chart')} CSV/XLS</button><button class="ghost-button danger-outline" id="delete-contacts" disabled>${icon('trash')} Excluir</button></div></div><div style="overflow:auto"><table class="data-table contact-table"><thead><tr><th><input type="checkbox" id="select-all-contacts" aria-label="Selecionar todos"></th><th>Contato</th><th>Empresa</th><th>Funil</th><th>Etapa</th><th>Canal de aquisição</th><th>Valor</th><th>Fit</th></tr></thead><tbody id="contact-body">${contactRows(state.contacts)}</tbody></table></div></div>`;
  document.querySelector('.section-head').insertAdjacentHTML('beforeend',`<div class="view-switch"><button class="active" data-contact-view="people">Pessoas</button><button data-contact-view="companies">Empresas</button></div>`);
  document.querySelector('.table-toolbar').insertAdjacentHTML('afterend',`<section class="contact-filters" aria-label="Filtros de contatos"><header class="contact-filters-heading"><div>${icon('sliders')}<span><strong>Filtrar contatos</strong><small>Refine a lista sem perder a visão geral.</small></span></div><button type="button" id="clear-contact-filters">Limpar filtros</button></header><div class="contact-filter-grid"><label><span>Empresa</span><span class="contact-filter-control"><select id="contact-company-filter"><option value="">Todas</option>${state.organizations.map(org=>`<option value="${org.id}">${escapeHtml(org.name)}</option>`).join('')}</select></span></label><label><span>Funil</span><span class="contact-filter-control"><select id="contact-pipeline-filter"><option value="">Todos</option>${[...new Map(state.contacts.filter(c=>c.pipeline_id).map(c=>[c.pipeline_id,c.pipeline_name])).entries()].map(([id,name])=>`<option value="${id}">${escapeHtml(name)}</option>`).join('')}</select></span></label><label><span>Etapa comercial</span><span class="contact-filter-control"><select id="contact-stage-filter"><option value="">Todas</option>${[...new Set(state.contacts.map(c=>c.stage_name).filter(Boolean))].map(value=>`<option>${escapeHtml(value)}</option>`).join('')}</select></span></label><label><span>Canal de aquisição</span><span class="contact-filter-control"><select id="contact-acquisition-filter"><option value="">Todos</option>${[...new Set(state.contacts.map(c=>c.acquisition_channel).filter(Boolean))].map(value=>`<option>${escapeHtml(value)}</option>`).join('')}</select></span></label><label><span>Qualificação</span><span class="contact-filter-control"><select id="contact-qualification-filter"><option value="">Todas</option><option value="lead">Lead</option><option value="mql">MQL</option><option value="sql">SQL</option><option value="customer">Cliente</option></select></span></label><label><span>Ciclo</span><span class="contact-filter-control"><select id="contact-lifecycle-filter"><option value="">Todos</option><option value="lead">Em prospecção</option><option value="customer">Cliente</option><option value="inactive">Inativo/retomada</option></select></span></label></div></section>`);
  bindViewLinks();
  bindContactRows();
  const applyContactFilters=()=>{const q=document.querySelector('#contact-search').value.trim().toLowerCase(),scope=document.querySelector('#contact-search-scope').value,company=document.querySelector('#contact-company-filter').value,pipeline=document.querySelector('#contact-pipeline-filter').value,stage=document.querySelector('#contact-stage-filter').value,acquisition=document.querySelector('#contact-acquisition-filter').value,qualification=document.querySelector('#contact-qualification-filter').value,lifecycle=document.querySelector('#contact-lifecycle-filter').value;const haystack=c=>scope==='name'?c.name:scope==='company'?c.company:`${c.name} ${c.company}`;const filtered=state.contacts.filter(c=>(!q||String(haystack(c)||'').toLowerCase().includes(q))&&(!company||String(c.organization_id)===company)&&(!pipeline||String(c.pipeline_id)===pipeline)&&(!stage||c.stage_name===stage)&&(!acquisition||c.acquisition_channel===acquisition)&&(!qualification||c.qualification===qualification)&&(!lifecycle||c.lifecycle===lifecycle));document.querySelector('#contact-body').innerHTML=contactRows(filtered);bindContactRows();};
  document.querySelector('#contact-search').addEventListener('input',applyContactFilters);document.querySelector('#contact-search-scope').addEventListener('change',event=>{const labels={all:'Pesquisar nome ou empresa',name:'Pesquisar nome do contato',company:'Pesquisar nome da empresa'};document.querySelector('#contact-search').placeholder=labels[event.target.value];applyContactFilters();});document.querySelectorAll('.contact-filters select').forEach(select=>select.addEventListener('change',applyContactFilters));document.querySelector('#clear-contact-filters').addEventListener('click',()=>{document.querySelectorAll('.contact-filters select').forEach(select=>{select.value='';});document.querySelector('#contact-search').value='';applyContactFilters();});document.querySelectorAll('[data-contact-view]').forEach(button=>button.addEventListener('click',()=>{state.contactView=button.dataset.contactView;renderContacts();}));
  document.querySelector('#select-all-contacts').addEventListener('change', event => { state.selectedContacts = new Set(event.target.checked ? state.contacts.map(c=>c.id) : []); document.querySelectorAll('[data-select-contact]').forEach(box=>{box.checked=event.target.checked;}); updateBulkActions(); });
  document.querySelector('#contacts-to-campaign').addEventListener('click', () => navigate('campaigns'));
  document.querySelector('#export-contacts').addEventListener('click', exportSelectedContacts);
  document.querySelector('#delete-contacts').addEventListener('click', deleteSelectedContacts);
}

function contactRows(items) {
  return items.map(c => `<tr class="contact-row-clickable" data-contact="${c.id}"><td><input type="checkbox" data-select-contact="${c.id}" ${state.selectedContacts.has(c.id) ? 'checked' : ''} aria-label="Selecionar ${escapeHtml(c.name)}"></td><td><div class="contact-cell">${contactAvatar(c,'avatar')}<span><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.phone)}</span></span></div></td><td>${escapeHtml(c.company || '—')}</td><td><span class="funnel-badge">${escapeHtml(c.pipeline_name || 'Sem funil')}</span></td><td><span class="stage-badge">${escapeHtml(c.stage_name || 'Sem oportunidade')}</span></td><td><span class="acquisition-badge">${escapeHtml(c.acquisition_channel || 'Cadastro manual')}</span></td><td><strong>${money(c.value_cents)}</strong></td><td><span class="score-pill">${c.score || 0}%</span></td></tr>`).join('');
}

function bindContactRows() {
  document.querySelectorAll('[data-select-contact]').forEach(box => box.addEventListener('click', event => event.stopPropagation()));
  document.querySelectorAll('[data-select-contact]').forEach(box => box.addEventListener('change', () => { const id=Number(box.dataset.selectContact); box.checked ? state.selectedContacts.add(id) : state.selectedContacts.delete(id); updateBulkActions(); }));
  document.querySelectorAll('[data-contact]').forEach(row => row.addEventListener('click', () => openContactDetail(Number(row.dataset.contact))));
  updateBulkActions();
}

function updateBulkActions() { const active=state.selectedContacts.size>0; ['contacts-to-campaign','export-contacts','delete-contacts'].forEach(id=>{const el=document.querySelector(`#${id}`);if(el) el.disabled=!active;}); }

function openContactDetail(id) {
  const c=state.contacts.find(item=>item.id===id); if(!c)return;
  const fields=parseJson(c.custom_fields);const temperature=({cold:'Frio',warm:'Morno',hot:'Quente'})[fields.lead_temperature]||'Não classificado';
  document.querySelector('#detail-modal-content').innerHTML=`<div class="contact-popup-head">${contactAvatar(c,'avatar')}<div><p class="overline">Contato desde ${new Date(c.created_at).toLocaleDateString('pt-BR')}</p><h2>${escapeHtml(c.name)}</h2><p>${escapeHtml(c.company||'Sem empresa')} · ${escapeHtml(c.phone)}</p></div><button class="ghost-button" id="edit-contact">Editar</button></div><div class="detail-summary-grid"><span><small>Funil</small><strong>${escapeHtml(c.pipeline_name||'Sem funil')}</strong></span><span><small>Etapa</small><strong>${escapeHtml(c.stage_name||'Sem oportunidade')}</strong></span><span><small>Temperatura</small><strong>${escapeHtml(temperature)}</strong></span><span><small>Canal de aquisição</small><strong>${escapeHtml(c.acquisition_channel||'Cadastro manual')}</strong></span><span><small>E-mail do contato</small><strong>${escapeHtml(c.email||'—')}</strong></span><span><small>Rede social</small><strong>${escapeHtml(fields.social||'—')}</strong></span><span><small>Telefone da empresa</small><strong>${escapeHtml(c.company_phone||'—')}</strong></span><span><small>E-mail da empresa</small><strong>${escapeHtml(c.company_email||'—')}</strong></span><span><small>Redes da empresa</small><strong>${escapeHtml(c.company_socials||'—')}</strong></span><span><small>Segmento</small><strong>${escapeHtml(c.company_segment||c.segment||'—')}</strong></span><span><small>Site</small><strong>${escapeHtml(c.company_website||'—')}</strong></span><span><small>Valor</small><strong>${money(c.value_cents)}</strong></span></div><h3 class="timeline-title">Linha do tempo</h3><div class="contact-timeline"><span><i></i><div><strong>Contato criado</strong><small>${new Date(c.created_at).toLocaleString('pt-BR')}</small></div></span><span><i></i><div><strong>Última atualização</strong><small>${new Date(c.updated_at||c.created_at).toLocaleString('pt-BR')}</small></div></span><span><i></i><div><strong>${escapeHtml(c.pipeline_name||'Sem funil')} · ${escapeHtml(c.stage_name||'Sem oportunidade')}</strong><small>Canal: ${escapeHtml(c.acquisition_channel||'Cadastro manual')}</small></div></span></div>`; openModal('detail-modal');
  document.querySelector('#edit-contact').addEventListener('click',()=>{const host=document.querySelector('#detail-modal-content');host.innerHTML=`<p class="overline">Editar pessoa</p><h2>${escapeHtml(c.name)}</h2><form id="contact-edit-form"><label>Nome<input name="name" value="${escapeHtml(c.name)}" required></label><label>Telefone<input name="phone" value="${escapeHtml(c.phone)}" required></label><label>E-mail<input name="email" type="email" value="${escapeHtml(c.email||'')}"></label><label>Empresa<select name="organization_id"><option value="">Sem empresa</option>${state.organizations.map(org=>`<option value="${org.id}" ${Number(org.id)===Number(c.organization_id)?'selected':''}>${escapeHtml(org.name)}</option>`).join('')}</select></label><label>Segmento<input name="segment" value="${escapeHtml(c.segment||'')}"></label><label>Observações<textarea name="notes" rows="3">${escapeHtml(c.notes||'')}</textarea></label><div class="modal-actions"><button type="button" class="ghost-button" data-close-modal>Cancelar</button><button class="primary-button">Salvar</button></div></form>`;host.querySelector('[data-close-modal]').addEventListener('click',closeModals);host.querySelector('#contact-edit-form').addEventListener('submit',async event=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));body.organization_id=body.organization_id?Number(body.organization_id):null;try{await api(`/api/contacts/${c.id}`,{method:'PATCH',body});closeModals();toast('Contato atualizado','A pessoa continua vinculada ao histórico e às oportunidades.');await renderContacts();}catch(error){toast('Não foi possível salvar',error.message,'error');}});});
}

function exportSelectedContacts() { openContactExportModal(); }

function downloadTextFile(filename, contents, mime = 'text/csv;charset=utf-8') {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([contents], { type: mime }));
  link.download = filename;
  document.body.append(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 0);
}

function openContactExportModal() {
  const selected = state.contacts.filter(contact => state.selectedContacts.has(contact.id));
  if (!selected.length) return;
  const fields = [['name','Nome'],['phone','Telefone'],['email','E-mail'],['company','Empresa'],['pipeline_name','Funil'],['stage_name','Etapa'],['acquisition_channel','Canal de aquisição'],['value_cents','Valor'],['score','Fit']];
  const host = document.querySelector('#detail-modal-content');
  host.innerHTML = `<div class="modal-icon">${icon('chart')}</div><p class="overline">Exportação personalizada</p><h2>Baixar ${selected.length} contato(s)</h2><p>Escolha o formato e somente os campos que deseja incluir.</p><form id="contact-export-form"><div class="export-format"><label><input type="radio" name="format" value="meta" checked> CSV para Meta</label><label><input type="radio" name="format" value="csv"> CSV comum</label><label><input type="radio" name="format" value="xls"> Excel (.xls)</label></div><fieldset><legend>Campos da planilha</legend><div class="check-grid">${fields.map(([key,label]) => `<label><input type="checkbox" name="fields" value="${key}" ${['name','phone','email','company'].includes(key)?'checked':''}>${label}</label>`).join('')}</div></fieldset><div class="modal-actions"><button type="button" class="ghost-button" data-close-modal>Cancelar</button><button class="primary-button" type="submit">Baixar arquivo</button></div></form>`;
  openModal('detail-modal');
  document.querySelector('#contact-export-form').addEventListener('submit', event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget); const format = values.get('format'); let selectedFields = values.getAll('fields');
    if (format === 'meta') selectedFields = ['email','phone','name'];
    if (!selectedFields.length) return toast('Selecione um campo', 'A planilha precisa ter pelo menos uma coluna.', 'error');
    const quote = value => `"${String(value ?? '').replaceAll('"','""')}"`;
    const headers = format === 'meta' ? ['email','phone','fn','ln'] : selectedFields.map(key => fields.find(([field])=>field===key)?.[1] || key);
    const rows = selected.map(contact => {
      if (format === 'meta') { const parts=String(contact.name||'').trim().split(/\s+/); return [contact.email||'',contact.phone||'',parts.shift()||'',parts.join(' ')]; }
      return selectedFields.map(key => key === 'value_cents' ? (Number(contact[key]||0)/100).toFixed(2).replace('.',',') : contact[key] || '');
    });
    if (format === 'xls') {
      const table = `<table><thead><tr>${headers.map(item=>`<th>${escapeHtml(item)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(item=>`<td>${escapeHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      downloadTextFile('contatos-atenva.xls', `\ufeff${table}`, 'application/vnd.ms-excel;charset=utf-8');
    } else {
      downloadTextFile(format === 'meta' ? 'contatos-meta.csv' : 'contatos-atenva.csv', `\ufeff${[headers,...rows].map(row=>row.map(quote).join(',')).join('\r\n')}`);
    }
    closeModals(); toast('Planilha pronta', 'O arquivo foi baixado com os campos escolhidos.');
  });
}

function openChartPreview(title, panel) {
  const chart = panel?.querySelector('.bar-chart,.pie-chart-wrap');
  if (!chart) return;
  const host = document.querySelector('#detail-modal-content');
  host.innerHTML = `<div class="modal-icon">${icon('chart')}</div><p class="overline">Visualização ampliada</p><h2>${escapeHtml(title)}</h2><div class="chart-preview-large"></div>`;
  host.querySelector('.chart-preview-large').append(chart.cloneNode(true));
  bindPieTooltips(host);
  openModal('detail-modal');
}

async function deleteSelectedContacts() { if(!confirm(`Excluir ${state.selectedContacts.size} contato(s)?`))return; await api('/api/contacts/bulk',{method:'DELETE',body:{ids:[...state.selectedContacts]}});state.selectedContacts.clear();toast('Contatos excluídos','A seleção foi removida.');await renderContacts(); }

async function openTaskModal(conversation = null, task = null, deal = null) {
  if (!state.users.length) state.users = await api('/api/users');
  const form = document.querySelector('#task-form'); form.reset();
  form.elements.task_id.value = task?.id || '';
  form.elements.contact_id.value = task?.contact_id || deal?.contact_id || conversation?.contact_id || '';
  form.elements.conversation_id.value = task?.conversation_id || conversation?.id || '';
  form.elements.deal_id.value = task?.deal_id || deal?.id || '';
  const nextHour = new Date(Date.now() + 3_600_000); nextHour.setMinutes(0, 0, 0);
  const localDate=value=>{const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16)};
  const scheduledAt = localDate(task?.due_at || nextHour);
  form.elements.due_date.value = scheduledAt.slice(0,10);
  form.elements.due_time.value = scheduledAt.slice(11,16);
  document.querySelector('#task-assignee').innerHTML = state.users.map(user => `<option value="${user.id}" ${user.id === state.user.id ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join('');
  if(task){form.elements.title.value=task.title||'';form.elements.description.value=task.description||'';form.elements.assigned_to.value=task.assigned_to||state.user.id;form.elements.priority.value=task.priority||'normal';form.elements.type.value=task.type||'followup';}
  else if(deal){form.elements.title.value=`Follow-up · ${deal.title}`;form.elements.description.value=`Tarefa vinculada ao negócio “${deal.title}”.`;}
  document.querySelector('#task-modal-title').textContent=task?'Editar tarefa':'Nova tarefa'; document.querySelector('#task-submit').textContent=task?'Salvar alterações':'Criar tarefa'; document.querySelector('#delete-task').hidden=!task;
  openModal('task-modal');
}

async function renderTasks(liveData=null) {
  if(!liveData)setLoading('#view-tasks');
  if (!state.users.length) state.users = await api('/api/users');
  if(!state.taskRange){const start=new Date();start.setDate(start.getDate()-30);const end=new Date();end.setDate(end.getDate()+30);state.taskRange={start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)};}
  const taskQuery=new URLSearchParams({start:state.taskRange.start,end:state.taskRange.end});if(state.taskOwnerFilter)taskQuery.set('assigned_to',state.taskOwnerFilter);
  state.tasks = liveData||await api(`/api/tasks?${taskQuery}`);
  const calendarStart=state.taskRange.start,calendarEnd=state.taskRange.end;
  if(!liveData)try{const google=await api('/api/integrations/google/status');state.googleCalendar=google;if(google.connected){const events=await api(`/api/integrations/google/events?start=${calendarStart}&end=${calendarEnd}`);const existing=new Set(state.tasks.filter(task=>task.google_event_id).map(task=>`${task.google_calendar_id||'primary'}:${task.google_event_id}`));state.tasks=[...state.tasks,...events.filter(event=>!existing.has(`${event.google_calendar_id||'primary'}:${event.google_event_id}`))];}}catch(error){state.googleCalendar={...(state.googleCalendar||{}),sync_error:error.message};}
  const internalTaskIds=new Set(state.tasks.filter(task=>task.source!=='google').map(task=>String(task.id)));state.selectedTasks=new Set([...state.selectedTasks].filter(id=>internalTaskIds.has(String(id))));
  const pending = state.tasks.filter(task => task.status === 'pending');
  const grouped = pending.reduce((groups, task) => { const day = task.due_at ? new Date(task.due_at).toLocaleDateString('en-CA') : 'Sem data'; (groups[day] ||= []).push(task); return groups; }, {});
  const taskGroups = Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b));
  const taskMarkup = task => `<article class="calendar-task ${task.source==='google'?'google-event':''} ${task.status==='completed'?'completed':''} ${state.selectedTasks.has(String(task.id))?'selected':''}" ${task.source==='google'?'':`draggable="true" data-task-drag="${task.id}" data-edit-task="${task.id}"`}>${task.source==='google'?`<span class="google-event-mark">G</span>`:`<input type="checkbox" class="task-select" data-select-task="${task.id}" aria-label="Selecionar ${escapeHtml(task.title)}" ${state.selectedTasks.has(String(task.id))?'checked':''}>`}<div><span class="priority-badge ${task.priority||'normal'}">${task.source==='google'?'Google Agenda':({urgent:'Urgente',high:'Alta',normal:'Média',low:'Baixa'})[task.priority||'normal']}</span><span class="task-type">${escapeHtml(task.type)}</span><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.location || task.contact_name || 'Tarefa interna')} · ${escapeHtml(task.assigned_name || (task.source==='google'?'Agenda conectada':'Sem responsável'))}</p>${task.description?`<p class="task-description">${escapeHtml(task.description)}</p>`:''}</div><div class="task-card-actions"><time>${task.due_at ? new Date(task.due_at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '—'}</time>${task.source==='google'?'':`<div class="task-item-actions" role="group" aria-label="Ações de ${escapeHtml(task.title)}"><button type="button" class="task-action-button edit" data-task-edit-button="${task.id}">${icon('sliders')} Editar</button><button type="button" class="task-action-button delete" data-task-delete-button="${task.id}">${icon('trash')} Excluir</button><button type="button" class="task-action-button complete" data-task-complete-button="${task.id}">${icon(task.status==='completed'?'refresh':'check')} ${task.status==='completed'?'Reabrir':'Concluir'}</button></div>`}</div></article>`;
  const listMarkup = `<div class="calendar-grid list">${taskGroups.map(([day, items]) => `<section class="calendar-day"><header><strong>${day === 'Sem data' ? day : new Date(`${day}T12:00:00`).toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'long'})}</strong><b>${items.length}</b></header>${items.map(taskMarkup).join('')}</section>`).join('') || '<div class="empty-state"><h3>Agenda livre</h3><p>Crie uma tarefa para começar.</p></div>'}</div>`;
  const month = new Date(state.taskCalendarDate.getFullYear(),state.taskCalendarDate.getMonth(),1); const first = new Date(month); first.setDate(1-((month.getDay()+6)%7));
  const cells = Array.from({length:42},(_,index)=>{const date=new Date(first);date.setDate(first.getDate()+index);const key=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;const items=grouped[key]||[];const muted=date.getMonth()!==month.getMonth();const today=key===new Date().toLocaleDateString('en-CA');return `<div class="month-cell ${muted?'muted':''} ${today?'today':''}"><span>${date.getDate()}</span>${items.slice(0,3).map(task=>`<button class="month-event ${task.priority||'normal'} ${task.source==='google'?'google':''}" ${task.source==='google'?'':`draggable="true" data-task-drag="${task.id}"`} data-calendar-task="${escapeHtml(task.id)}" title="${escapeHtml(task.title)}"><b>${new Date(task.due_at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</b> ${escapeHtml(task.title)}</button>`).join('')}${items.length>3?`<small>+${items.length-3} tarefas</small>`:''}</div>`}).join('');
  const calendarMarkup=`<section class="month-calendar"><header><button class="icon-button" id="calendar-prev" aria-label="Mês anterior">‹</button><h3>${month.toLocaleDateString('pt-BR',{month:'long',year:'numeric'})}</h3><button class="icon-button" id="calendar-next" aria-label="Próximo mês">›</button></header><div class="month-weekdays">${['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'].map(day=>`<span>${day}</span>`).join('')}</div><div class="month-grid">${cells}</div></section>`;
  const completed=state.tasks.filter(task=>task.status==='completed');
  document.querySelector('#view-tasks').innerHTML = `<div class="section-head"><div><h2>Calendário e tarefas</h2><p>Selecione um período, aja em lote ou arraste uma tarefa para uma ação rápida.</p></div><div class="section-actions task-head-actions"><div class="task-date-range"><label>De <input id="task-start" type="date" value="${state.taskRange.start}"></label><label>Até <input id="task-end" type="date" value="${state.taskRange.end}"></label></div><div class="view-switch"><button data-task-view="list" class="${state.taskView==='list'?'active':''}">Lista</button><button data-task-view="calendar" class="${state.taskView==='calendar'?'active':''}">Calendário</button></div><button class="primary-button" id="new-task">${icon('plus')} Nova tarefa</button></div></div><div class="task-summary"><span><b>${pending.length}</b> pendentes</span><span><b>${completed.length}</b> concluídas</span><label>Responsável<select id="task-owner-filter"><option value="">Toda a equipe</option>${state.users.map(user => `<option value="${user.id}" ${String(user.id) === String(state.taskOwnerFilter) ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join('')}</select></label></div>${state.taskView==='list'&&internalTaskIds.size?`<div class="task-selection-guide"><label><input type="checkbox" id="select-visible-tasks" ${state.selectedTasks.size===internalTaskIds.size?'checked':''}> Selecionar todas as tarefas exibidas</label><span>Depois de selecionar, escolha uma ação na barra abaixo.</span></div>`:''}<div class="task-bulk-toolbar" id="task-bulk-toolbar" ${state.selectedTasks.size?'':'hidden'}><strong id="task-selection-count">${state.selectedTasks.size} selecionada${state.selectedTasks.size===1?'':'s'}</strong><div><button data-task-bulk="complete">${icon('check')} Concluir</button><button data-task-bulk="edit">${icon('sliders')} Responsável/data</button><button data-task-bulk="reschedule">${icon('calendar')} Reagendar</button><button data-task-bulk="move">${icon('arrow')} Mover</button><button class="danger" data-task-bulk="delete">${icon('trash')} Excluir</button><button class="quiet" data-task-bulk="clear">Limpar seleção</button></div></div>${state.taskView==='calendar'?calendarMarkup:listMarkup}${state.taskView==='list'&&completed.length?`<details class="completed-tasks"><summary>Concluídas (${completed.length})</summary>${completed.map(taskMarkup).join('')}</details>`:''}<div class="task-drop-actions" aria-label="Ações rápidas para tarefa"><div class="delete" data-task-drop="delete">${icon('trash')}<strong>Excluir</strong><small>Apagar tarefa</small></div><div data-task-drop="tomorrow">${icon('calendar')}<strong>Amanhã</strong><small>Manter horário</small></div><div data-task-drop="two-days">${icon('clock')}<strong>Em dois dias</strong><small>Manter horário</small></div><div data-task-drop="next-monday">${icon('calendar')}<strong>Próxima segunda</strong><small>Reagendar</small></div><div data-task-drop="next-month">${icon('calendar')}<strong>Próximo mês</strong><small>Mesmo dia</small></div><div class="done" data-task-drop="done">${icon('check')}<strong>Feito</strong><small>Marcar concluída</small></div></div>`;
  document.querySelector('#new-task').addEventListener('click', () => openTaskModal());
  const updateTaskRange=async()=>{const start=document.querySelector('#task-start').value,end=document.querySelector('#task-end').value;if(!start||!end||start>end){toast('Período inválido','A data inicial precisa ser anterior à data final.','error');return;}state.taskRange={start,end};state.taskCalendarDate=new Date(`${start}T12:00:00`);await renderTasks();};
  document.querySelector('#task-start').addEventListener('change',updateTaskRange);document.querySelector('#task-end').addEventListener('change',updateTaskRange);
  document.querySelector('#task-owner-filter').addEventListener('change', async event => { state.taskOwnerFilter = event.target.value; await renderTasks(); });
  document.querySelectorAll('[data-task-view]').forEach(button => button.addEventListener('click',()=>{state.taskView=button.dataset.taskView;renderTasks();}));
  document.querySelectorAll('[data-select-task]').forEach(input=>input.addEventListener('click',event=>event.stopPropagation()));
  document.querySelectorAll('[data-select-task]').forEach(input=>input.addEventListener('change',()=>{const id=String(input.dataset.selectTask);if(input.checked)state.selectedTasks.add(id);else state.selectedTasks.delete(id);input.closest('.calendar-task')?.classList.toggle('selected',input.checked);const all=document.querySelectorAll('[data-select-task]');const master=document.querySelector('#select-visible-tasks');if(master){master.checked=[...all].every(item=>item.checked);master.indeterminate=[...all].some(item=>item.checked)&&![...all].every(item=>item.checked);}renderTaskBulkToolbar();}));
  document.querySelector('#select-visible-tasks')?.addEventListener('change',event=>{document.querySelectorAll('[data-select-task]').forEach(input=>{input.checked=event.currentTarget.checked;const id=String(input.dataset.selectTask);if(input.checked)state.selectedTasks.add(id);else state.selectedTasks.delete(id);input.closest('.calendar-task')?.classList.toggle('selected',input.checked);});renderTaskBulkToolbar();});
  document.querySelectorAll('[data-task-bulk]').forEach(button=>button.addEventListener('click',()=>handleTaskBulkAction(button.dataset.taskBulk)));
  document.querySelectorAll('[data-edit-task]').forEach(card=>card.addEventListener('click',()=>{if(!taskDragClickSuppressed)openTaskModal(null,state.tasks.find(item=>String(item.id)===String(card.dataset.editTask)));}));
  document.querySelectorAll('[data-task-edit-button]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();openTaskModal(null,state.tasks.find(item=>String(item.id)===String(button.dataset.taskEditButton)));}));
  document.querySelectorAll('[data-task-delete-button]').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();const task=state.tasks.find(item=>String(item.id)===String(button.dataset.taskDeleteButton));if(!task||!confirm(`Excluir a tarefa “${task.title}”?`))return;try{await api(`/api/tasks/${task.id}`,{method:'DELETE'});state.selectedTasks.delete(String(task.id));toast('Tarefa excluída','A tarefa foi removida com sucesso.');await renderTasks();}catch(error){toast('Não foi possível excluir',error.message,'error');}}));
  document.querySelectorAll('[data-task-complete-button]').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();const task=state.tasks.find(item=>String(item.id)===String(button.dataset.taskCompleteButton));if(task)await completeTask(task.id,task.status!=='completed');}));
  document.querySelector('#calendar-prev')?.addEventListener('click',()=>{state.taskCalendarDate=new Date(month.getFullYear(),month.getMonth()-1,1);renderTasks();});
  document.querySelector('#calendar-next')?.addEventListener('click',()=>{state.taskCalendarDate=new Date(month.getFullYear(),month.getMonth()+1,1);renderTasks();});
  document.querySelectorAll('[data-calendar-task]').forEach(button=>button.addEventListener('click',()=>{if(taskDragClickSuppressed)return;const task=state.tasks.find(item=>String(item.id)===String(button.dataset.calendarTask));if(task?.source!=='google')return openTaskModal(null,task);toast(task?.title||'Tarefa',`Google Agenda · ${task?.due_at?new Date(task.due_at).toLocaleString('pt-BR'):'Sem data'}`);}));
  bindTaskDragAndDrop();
}

function selectedTaskItems() {
  return state.tasks.filter(task=>task.source!=='google'&&state.selectedTasks.has(String(task.id)));
}

function renderTaskBulkToolbar() {
  const toolbar=document.querySelector('#task-bulk-toolbar');const count=document.querySelector('#task-selection-count');
  if(!toolbar||!count)return;
  const total=selectedTaskItems().length;toolbar.hidden=!total;count.textContent=`${total} selecionada${total===1?'':'s'}`;
}

async function submitTaskBulk(action, payload={}) {
  const ids=selectedTaskItems().map(task=>task.id);if(!ids.length){toast('Selecione tarefas','Marque ao menos uma tarefa para continuar.','error');return;}
  try{
    const method=action==='delete'?'DELETE':'PATCH';const body=action==='delete'?{ids}:{ids,action,...payload};
    const result=await api('/api/tasks/bulk',{method,body});state.selectedTasks.clear();closeModals();
    const labels={complete:'Tarefas concluídas',update:'Tarefas atualizadas',reschedule:'Tarefas reagendadas',move:'Tarefas movidas',delete:'Tarefas excluídas'};
    const amount=result.deleted||result.updated||ids.length;toast(labels[action],`${amount} tarefa${amount===1?' foi atualizada':'s foram atualizadas'}${result.calendar_sync_warnings?'; algumas alterações não sincronizaram com o Google Agenda.':'.'}`);await renderTasks();
  }catch(error){toast('Não foi possível aplicar a ação',error.message,'error');}
}

function openTaskBulkDialog(action) {
  const total=selectedTaskItems().length;if(!total)return;
  const host=document.querySelector('#detail-modal-content');
  if(action==='edit')host.innerHTML=`<div class="modal-icon">${icon('sliders')}</div><p class="overline">Ação em lote · ${total} tarefa${total===1?'':'s'}</p><h2>Editar responsável ou data</h2><p>Preencha somente os campos que deseja alterar em todas as tarefas selecionadas.</p><form id="task-bulk-form"><label>Novo responsável<select name="assigned_to"><option value="">Manter responsável atual</option>${state.users.map(user=>`<option value="${user.id}">${escapeHtml(user.name)}</option>`).join('')}</select></label><div class="form-grid"><label>Nova data<input type="date" name="date"></label><label>Horário<input type="time" name="time" value="09:00"></label></div><div class="modal-actions"><button type="button" class="ghost-button" data-close-modal>Cancelar</button><button class="primary-button">Aplicar alterações</button></div></form>`;
  if(action==='reschedule')host.innerHTML=`<div class="modal-icon">${icon('calendar')}</div><p class="overline">Ação em lote · ${total} tarefa${total===1?'':'s'}</p><h2>Reagendar tarefas</h2><form id="task-bulk-form"><label>Novo prazo<select name="reschedule" required><option value="tomorrow">Amanhã</option><option value="two-days">Em dois dias</option><option value="next-monday">Próxima segunda-feira</option><option value="next-month">Próximo mês</option></select></label><div class="modal-actions"><button type="button" class="ghost-button" data-close-modal>Cancelar</button><button class="primary-button">Reagendar selecionadas</button></div></form>`;
  if(action==='move')host.innerHTML=`<div class="modal-icon">${icon('arrow')}</div><p class="overline">Ação em lote · ${total} tarefa${total===1?'':'s'}</p><h2>Mover para outro tipo</h2><form id="task-bulk-form"><label>Tipo da tarefa<select name="type" required><option value="followup">Follow-up</option><option value="meeting">Reunião</option><option value="call">Ligação</option><option value="other">Outro</option></select></label><div class="modal-actions"><button type="button" class="ghost-button" data-close-modal>Cancelar</button><button class="primary-button">Mover selecionadas</button></div></form>`;
  openModal('detail-modal');host.querySelectorAll('[data-close-modal]').forEach(button=>button.addEventListener('click',closeModals));
  host.querySelector('#task-bulk-form')?.addEventListener('submit',async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));if(action==='edit'){const payload={};if(values.assigned_to)payload.assigned_to=Number(values.assigned_to);if(values.date)payload.due_at=new Date(`${values.date}T${values.time||'09:00'}`).toISOString();if(payload.assigned_to===undefined&&!payload.due_at){toast('Nada para alterar','Escolha um responsável ou uma nova data.','error');return;}await submitTaskBulk('update',payload);}if(action==='reschedule')await submitTaskBulk('reschedule',{reschedule:values.reschedule});if(action==='move')await submitTaskBulk('move',{type:values.type});});
}

async function handleTaskBulkAction(action) {
  if(action==='clear'){state.selectedTasks.clear();document.querySelectorAll('[data-select-task]').forEach(input=>{input.checked=false;input.closest('.calendar-task')?.classList.remove('selected');});renderTaskBulkToolbar();return;}
  const tasks=selectedTaskItems();if(!tasks.length)return;
  if(action==='delete'){if(confirm(`Excluir ${tasks.length} tarefa${tasks.length===1?'':'s'} selecionada${tasks.length===1?'':'s'}?`))await submitTaskBulk('delete');return;}
  if(action==='complete'){await submitTaskBulk('complete');return;}
  openTaskBulkDialog(action);
}

let taskDragClickSuppressed=false;
function rescheduledTaskDate(task, action) {
  const original=task?.due_at?new Date(task.due_at):new Date(); const now=new Date(); let target=new Date(now);
  target.setHours(original.getHours(),original.getMinutes(),0,0);
  if(action==='tomorrow')target.setDate(now.getDate()+1);
  if(action==='two-days')target.setDate(now.getDate()+2);
  if(action==='next-monday'){const days=((8-now.getDay())%7)||7;target.setDate(now.getDate()+days);}
  if(action==='next-month'){const desiredDay=now.getDate();target.setDate(1);target.setMonth(now.getMonth()+1);const lastDay=new Date(target.getFullYear(),target.getMonth()+1,0).getDate();target.setDate(Math.min(desiredDay,lastDay));}
  return target.toISOString();
}

async function applyTaskDrop(task, action) {
  if(action==='delete'){if(!confirm(`Excluir a tarefa “${task.title}”?`))return;await api(`/api/tasks/${task.id}`,{method:'DELETE'});toast('Tarefa excluída','Ela também foi removida do Google Agenda, quando sincronizada.');}
  else if(action==='done'){await api(`/api/tasks/${task.id}`,{method:'PATCH',body:{status:'completed'}});toast('Tarefa concluída','A tarefa foi movida para Concluídas.');}
  else {const labels={tomorrow:'amanhã','two-days':'daqui a dois dias','next-monday':'para a próxima segunda-feira','next-month':'para o próximo mês'};await api(`/api/tasks/${task.id}`,{method:'PATCH',body:{due_at:rescheduledTaskDate(task,action),status:'pending'}});toast('Tarefa reagendada',`Novo prazo: ${labels[action]}.`);}
  await renderTasks();
}

function bindTaskDragAndDrop() {
  let draggedTask=null;
  document.querySelectorAll('[data-task-drag]').forEach(source=>{
    source.addEventListener('dragstart',event=>{draggedTask=state.tasks.find(item=>String(item.id)===String(source.dataset.taskDrag));if(!draggedTask||draggedTask.source==='google'){event.preventDefault();return;}taskDragClickSuppressed=true;source.classList.add('dragging');document.body.classList.add('task-drag-active');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',String(draggedTask.id));});
    source.addEventListener('dragend',()=>{source.classList.remove('dragging');document.body.classList.remove('task-drag-active');document.querySelectorAll('[data-task-drop]').forEach(zone=>zone.classList.remove('dragover'));setTimeout(()=>{taskDragClickSuppressed=false;},80);});
  });
  document.querySelectorAll('[data-task-drop]').forEach(zone=>{
    zone.addEventListener('dragover',event=>{event.preventDefault();zone.classList.add('dragover');});
    zone.addEventListener('dragleave',()=>zone.classList.remove('dragover'));
    zone.addEventListener('drop',async event=>{event.preventDefault();zone.classList.remove('dragover');document.body.classList.remove('task-drag-active');if(!draggedTask)return;try{await applyTaskDrop(draggedTask,zone.dataset.taskDrop);}catch(error){toast('Não foi possível atualizar',error.message,'error');}});
  });
}

function campaignStatus(status) {
  return ({ draft: 'Rascunho', running: 'Enviando', paused: 'Pausada', completed: 'Concluída', cancelled: 'Cancelada', failed: 'Falhou', ready: 'Pronto', queued: 'Na fila', sent: 'Enviada', delivered: 'Entregue', read: 'Lida', skipped: 'Ignorado' })[status] || status;
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler a planilha.'));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result); let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });
}
function textAsBase64(text) { const bytes=new TextEncoder().encode(text);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary); }

function campaignDetailMarkup(detail, connected, demo) {
  if (!detail) return '<div class="empty-state campaign-empty"><h3>Importe sua primeira planilha</h3><p>A prévia aparecerá aqui antes de qualquer envio.</p></div>';
  const c = detail.campaign;
  const actionAllowed = ['draft', 'paused'].includes(c.status) && c.ready_count > 0;
  return `<div class="campaign-detail-head"><div><span class="campaign-status ${c.status}">${campaignStatus(c.status)}</span><h3>${escapeHtml(c.name)}</h3><p>Modelo: ${escapeHtml(c.template_name)} · ${escapeHtml(c.source_file || '')}</p></div><button class="link-button" id="refresh-campaign">Atualizar</button></div>
    <div class="campaign-totals"><span><b>${c.total_rows}</b> linhas</span><span class="ready"><b>${c.ready_count}</b> prontas</span><span><b>${c.sent_count}</b> enviadas</span><span><b>${c.delivered_count}</b> entregues</span><span><b>${c.read_count}</b> lidas</span><span class="blocked"><b>${c.skipped_count + c.failed_count}</b> bloqueadas</span></div>
    <div class="campaign-template-preview"><span>Mensagem aprovada pela Meta</span><p>${escapeHtml(c.template_body)}</p></div>
    ${actionAllowed ? `<label class="campaign-confirm"><input type="checkbox" id="campaign-compliance" /><span><strong>Confirmo que estes contatos autorizaram mensagens da empresa</strong><small>O envio usa somente o modelo aprovado acima. Contatos sem consentimento foram bloqueados.</small></span></label><div class="campaign-actions">${connected ? `<button class="primary-button" id="start-campaign">${icon('send')} Iniciar disparo</button>` : `<button class="ghost-button" data-view-link="meta">Conectar WhatsApp</button>${demo ? '<button class="primary-button" id="simulate-campaign">Simular sem enviar</button>' : ''}`}</div>` : ''}
    ${c.status === 'running' ? '<div class="campaign-running"><i></i><span>Envio em andamento com intervalo entre mensagens.</span><button class="link-button" id="cancel-campaign">Cancelar restantes</button></div>' : ''}
    <div class="campaign-recipient-table"><div class="campaign-recipient-row head"><span>Linha</span><span>Contato</span><span>Telefone</span><span>Status</span><span>Motivo</span></div>${detail.recipients.map(row => `<div class="campaign-recipient-row"><span>${row.source_row}</span><span>${escapeHtml(row.name || 'Sem nome')}</span><span>${escapeHtml(row.phone || 'Inválido')}</span><span><em class="recipient-status ${row.status}">${campaignStatus(row.status)}</em></span><span>${escapeHtml(row.skip_reason || row.error || '—')}</span></div>`).join('')}</div>`;
}

async function renderCampaigns(selectedId = state.selectedCampaignId) {
  setLoading('#view-campaigns');
  const [campaigns, templates, meta, health, contacts] = await Promise.all([api('/api/campaigns'), api('/api/message-templates'), api('/api/meta/status'), api('/api/health'),api('/api/contacts')]); state.contacts=contacts;
  const usableTemplates = meta.connected ? templates.filter(template => template.source === 'meta') : templates;
  const selectedExisting=state.contacts.filter(contact=>state.selectedContacts.has(contact.id));
  state.selectedCampaignId = selectedId || campaigns[0]?.id || null;
  const detail = state.selectedCampaignId ? await api(`/api/campaigns/${state.selectedCampaignId}`) : null;
  document.querySelector('#view-campaigns').innerHTML = `<div class="section-head"><div><h2>Disparos pelo WhatsApp</h2><p>Escolha contatos, importe uma planilha e use um modelo salvo ou crie um novo.</p></div><div class="section-actions"><button class="ghost-button" id="new-template">${icon('plus')} Novo modelo</button><span class="connection-pill ${meta.connected ? 'connected' : ''}"><i></i>${meta.connected ? 'WhatsApp conectado' : 'Conecte o WhatsApp para enviar'}</span></div></div>
    <div class="campaign-safety">${icon('info')}<div><strong>Proteção contra bloqueios e spam</strong><p>O CRM exclui duplicados, telefones inválidos, contatos sem autorização e opt-outs. Para iniciar conversas, somente modelos aprovados pela Meta podem ser usados.</p></div></div>
    <div class="campaign-steps" aria-label="Etapas do disparo"><span class="active"><b>1</b> Escolher público</span><span><b>2</b> Definir mensagem</span><span><b>3</b> Revisar e enviar</span></div>
    <div class="campaign-layout"><section class="panel campaign-import"><div class="panel-header campaign-compose-head"><div><span class="compact-feature-icon">${icon('send')}</span><div><h3>Nova campanha</h3><span>Escolha uma origem, um modelo e revise antes de enviar.</span></div></div>${meta.connected ? '<button class="link-button" id="sync-templates">Sincronizar modelos</button>' : '<span class="campaign-connection-hint">Conecte o WhatsApp para enviar</span>'}</div>${selectedExisting.length?`<div class="selected-contact-source">${icon('users')}<div><strong>${selectedExisting.length} contatos selecionados</strong><span>A seleção feita em Contatos será usada neste disparo.</span></div></div>`:''}${meta.connected && !usableTemplates.length ? '<div class="template-sync-warning">Sincronize os modelos aprovados da sua conta Meta antes de importar.</div>' : ''}<form id="campaign-import-form"><label>Nome da campanha<input name="name" required maxlength="120" placeholder="Ex.: Reativação setembro" /></label><label>Origem dos contatos<select name="contact_source"><option value="selected">Selecionados em Contatos</option><option value="all">Todos com consentimento</option><option value="retomada">Lista: Retomada</option><option value="remarketing">Lista: Remarketing</option>${[...new Set(contacts.map(c=>c.stage_name).filter(Boolean))].map(stage=>`<option value="stage:${escapeHtml(stage)}">Etapa: ${escapeHtml(stage)}</option>`).join('')}</select></label><label>Modelo salvo<select name="template_id" id="campaign-template" required ${!usableTemplates.length ? 'disabled' : ''}><option value="">Selecione</option>${usableTemplates.map(t => `<option value="${t.id}" data-body="${escapeHtml(t.body)}">${escapeHtml(t.display_name)} · ${escapeHtml(t.category)}</option>`).join('')}</select></label><div class="selected-template" id="selected-template">Selecione um modelo para visualizar a mensagem.</div><label class="campaign-file"><input type="file" name="file" accept=".xlsx,.csv,.tsv" /><span>${icon('chart')}<b>Ou importar planilha externa</b><small>Formatos XLSX, CSV ou TSV</small></span></label><div id="campaign-file-name" class="file-name"></div><button type="submit" class="primary-button" ${!usableTemplates.length ? 'disabled' : ''}>Montar campanha</button><button type="button" class="link-button" id="download-campaign-model">Baixar planilha modelo (.csv)</button></form><details class="campaign-help"><summary>Como preencher a planilha</summary><div class="campaign-columns"><code>telefone</code><span>Com DDD; o código +55 é adicionado quando necessário.</span><code>nome</code><span>Usado como variável 1 quando o modelo solicitar.</span><code>consentimento</code><span>Use “sim” somente para quem autorizou mensagens.</span><code>variavel_1, variavel_2…</code><span>Campos personalizados exigidos pelo modelo.</span></div></details></section>
    <section class="panel campaign-review" id="campaign-review">${campaignDetailMarkup(detail, meta.connected, health.demo)}</section></div>
    <section class="panel campaign-history"><div class="panel-header"><div><h3>Histórico de campanhas</h3><span>${campaigns.length} campanhas criadas</span></div></div><div class="campaign-list">${campaigns.map(c => `<button data-campaign-id="${c.id}" class="${c.id === state.selectedCampaignId ? 'active' : ''}"><span><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.template_name)} · ${new Date(c.created_at).toLocaleDateString('pt-BR')}</small></span><span class="campaign-status ${c.status}">${campaignStatus(c.status)}</span><b>${c.sent_count}/${c.ready_count}</b></button>`).join('') || '<p class="empty-inline">Nenhuma campanha criada.</p>'}</div></section>`;
  const templateSelect = document.querySelector('#campaign-template');
  document.querySelector('#new-template')?.addEventListener('click',()=>{document.querySelector('#template-form').reset();openModal('template-modal');});
  templateSelect.addEventListener('change', () => { document.querySelector('#selected-template').textContent = templateSelect.selectedOptions[0]?.dataset.body || 'Selecione um modelo para visualizar a mensagem.'; });
  document.querySelector('#sync-templates')?.addEventListener('click', async event => { event.currentTarget.disabled = true; try { const result = await api('/api/message-templates/sync', { method: 'POST', body: {} }); toast('Modelos sincronizados', `${result.count} modelos aprovados encontrados na Meta.`); await renderCampaigns(state.selectedCampaignId); } catch (error) { toast('Falha ao sincronizar', error.message, 'error'); event.currentTarget.disabled = false; } });
  document.querySelector('[name=file]').addEventListener('change', event => { document.querySelector('#campaign-file-name').textContent = event.target.files[0]?.name || ''; });
  document.querySelector('#download-campaign-model').addEventListener('click', () => {
    const csv = '\uFEFFtelefone;nome;consentimento;variavel_1;variavel_2\n11999999999;Maria Silva;sim;Maria Silva;15/09 às 14h\n';
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = 'modelo-disparo-whatsapp.csv'; link.click(); URL.revokeObjectURL(link.href);
  });
  document.querySelector('#campaign-import-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type=submit]'); const file = form.elements.file.files[0];
    button.disabled = true; button.textContent = 'Validando planilha…';
    try { let fileName=file?.name; let dataBase64=file?await fileAsBase64(file):''; if(!file){const source=form.elements.contact_source.value;let chosen=source==='selected'?selectedExisting:source==='all'?contacts:source==='retomada'?contacts.filter(c=>String(c.tags||'').includes('Retomada')):source==='remarketing'?contacts.filter(c=>String(c.tags||'').includes('Remarketing')):source.startsWith('stage:')?contacts.filter(c=>c.stage_name===source.slice(6)):[];if(chosen.length){const csv='telefone;nome;consentimento\n'+chosen.map(c=>`${c.phone};"${String(c.name).replaceAll('"','""')}";sim`).join('\n');fileName=`lista-${source.replace(/[^a-z0-9]/gi,'-')}.csv`;dataBase64=textAsBase64(csv);}} if(!dataBase64)throw new Error('A lista escolhida está vazia; selecione contatos ou importe uma planilha.'); const result = await api('/api/campaigns/import', { method: 'POST', body: { name: form.elements.name.value, template_id: Number(form.elements.template_id.value), file_name:fileName, data_base64:dataBase64 } }); toast('Contatos validados', `${result.campaign.ready_count} contatos prontos e ${result.campaign.skipped_count} bloqueados.`); state.selectedCampaignId = result.campaign.id; state.selectedContacts.clear(); await renderCampaigns(result.campaign.id); }
    catch (error) { toast('Não foi possível importar', error.message, 'error'); button.disabled = false; button.textContent = 'Importar e validar'; }
  });
  document.querySelectorAll('[data-campaign-id]').forEach(button => button.addEventListener('click', () => renderCampaigns(Number(button.dataset.campaignId))));
  document.querySelector('#refresh-campaign')?.addEventListener('click', () => renderCampaigns(state.selectedCampaignId));
  bindViewLinks();
  async function start(simulate) {
    if (!document.querySelector('#campaign-compliance')?.checked) return toast('Confirmação necessária', 'Marque a confirmação de consentimento antes de continuar.', 'error');
    const button = document.querySelector(simulate ? '#simulate-campaign' : '#start-campaign'); button.disabled = true;
    try { await api(`/api/campaigns/${state.selectedCampaignId}/start`, { method: 'POST', body: { confirm_compliance: true, simulate } }); toast(simulate ? 'Simulação iniciada' : 'Disparo iniciado', 'Acompanhe o progresso nesta tela.'); await renderCampaigns(state.selectedCampaignId); }
    catch (error) { toast('Não foi possível iniciar', error.message, 'error'); button.disabled = false; }
  }
  document.querySelector('#start-campaign')?.addEventListener('click', () => start(false));
  document.querySelector('#simulate-campaign')?.addEventListener('click', () => start(true));
  document.querySelector('#cancel-campaign')?.addEventListener('click', async () => { await api(`/api/campaigns/${state.selectedCampaignId}/cancel`, { method: 'POST', body: {} }); toast('Campanha cancelada', 'Os contatos restantes não serão enviados.'); await renderCampaigns(state.selectedCampaignId); });
}

async function renderMetaAds() {
  setLoading('#view-meta-ads');
  let accounts=[];try{accounts=await api('/api/meta/ads/accounts');}catch(error){document.querySelector('#view-meta-ads').innerHTML=`<div class="empty-state"><h3>Conecte a Meta para ver anúncios</h3><p>${escapeHtml(error.message)}</p><button class="primary-button" data-view-link="meta">Abrir Integrações</button></div>`;bindViewLinks();return;}
  if(!accounts.length){document.querySelector('#view-meta-ads').innerHTML=`<div class="section-head"><div><h2>Meta Ads</h2><p>Métricas de mídia paga e funil em uma visão única.</p></div></div><div class="empty-state"><h3>Nenhuma conta de anúncio conectada</h3><p>Conecte uma conta Meta com permissão de leitura de anúncios.</p><button class="primary-button" data-view-link="meta">Conectar Meta</button></div>`;bindViewLinks();return;}
  const selected=accounts.some(a=>a.id===localStorage.getItem('atenva-meta-ad-account'))?localStorage.getItem('atenva-meta-ad-account'):accounts[0].id;
  const defaultEnd=new Date().toISOString().slice(0,10);const defaultStartDate=new Date();defaultStartDate.setDate(defaultStartDate.getDate()-29);
  const start=localStorage.getItem('atenva-meta-start')||defaultStartDate.toISOString().slice(0,10);const end=localStorage.getItem('atenva-meta-end')||defaultEnd;
  let campaigns=[];try{campaigns=await api(`/api/meta/ads/campaigns?account_id=${encodeURIComponent(selected)}`);}catch{}
  const selectedCampaign=campaigns.some(item=>String(item.id)===localStorage.getItem('atenva-meta-campaign'))?localStorage.getItem('atenva-meta-campaign'):'';
  let report;try{report=await api(`/api/meta/ads/insights?account_id=${encodeURIComponent(selected)}&start=${start}&end=${end}${selectedCampaign?`&campaign_id=${encodeURIComponent(selectedCampaign)}`:''}`);}catch(error){document.querySelector('#view-meta-ads').innerHTML=`<div class="section-head"><div><h2>Meta Ads</h2><p>Métricas de mídia paga e funil em uma visão única.</p></div></div><div class="empty-state"><h3>Permissão de anúncios necessária</h3><p>${escapeHtml(error.message)}</p><button class="ghost-button" data-view-link="meta">Revisar integração</button></div>`;bindViewLinks();return;}
  const integer=value=>Number(value||0).toLocaleString('pt-BR');const currency=value=>Number(value||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const summaries={impressions:'Quantidade de vezes que os anúncios apareceram.',reach:'Pessoas únicas alcançadas no período.',clicks:'Cliques registrados nos anúncios.',ctr:'Percentual de impressões que geraram clique.',spend:'Valor investido na conta e período selecionados.',leads:'Leads atribuídos pela Meta e recebidos pela Atenva.',cpl:'Investimento médio necessário para gerar um lead.',purchases:'Compras atribuídas pela Meta.'};
  const definitions=[['impressions','Impressões',integer(report.totals.impressions)],['reach','Alcance',integer(report.totals.reach)],['clicks','Cliques',integer(report.totals.clicks)],['ctr','CTR',`${Number(report.totals.ctr||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}%`],['spend','Investimento',currency(report.totals.spend)],['leads','Leads',integer(report.totals.leads)],['cpl','Custo por lead',currency(report.totals.cpl)],['purchases','Vendas',integer(report.totals.purchases)]];
  let visible;try{visible=JSON.parse(localStorage.getItem('atenva-meta-metrics')||'null')}catch{}if(!Array.isArray(visible)||!visible.length)visible=definitions.map(item=>item[0]);
  const cards=definitions.filter(item=>visible.includes(item[0])).map(([key,label,value])=>`<article class="meta-ad-card" tabindex="0"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${new Date(`${start}T12:00:00`).toLocaleDateString('pt-BR')} a ${new Date(`${end}T12:00:00`).toLocaleDateString('pt-BR')}</small><div class="meta-card-summary"><b>${escapeHtml(label)}</b><p>${escapeHtml(summaries[key])}</p></div></article>`).join('');
  const funnel=[['Impressões',report.totals.impressions],['Cliques',report.totals.clicks],['Leads',report.totals.leads],['Vendas',report.totals.purchases]];
  const maxClicks=Math.max(...report.daily.map(row=>Number(row.clicks||0)),1);const selectedAccount=accounts.find(item=>item.id===selected)||accounts[0];
  document.querySelector('#view-meta-ads').innerHTML=`<div class="section-head meta-ads-heading"><div><h2>Meta Ads</h2><p>Resultados reais por conta, campanha, anúncio e lead.</p></div><button class="ghost-button" id="customize-meta-metrics">${icon('settings')} Personalizar</button></div>
  <form class="meta-ads-filters" id="meta-ads-filters"><label class="meta-account-picker"><span>Conta de anúncios</span><select id="meta-ad-account">${accounts.map(a=>`<option value="${a.id}" ${a.id===selected?'selected':''}>${escapeHtml(a.name)} · ${escapeHtml(a.currency||'')}</option>`).join('')}</select><small>${escapeHtml(selectedAccount.timezone_name||'Fuso da conta')} · ${selectedAccount.account_status===1?'Ativa':'Status '+selectedAccount.account_status}</small></label><label><span>Campanha</span><select id="meta-campaign"><option value="">Todas as campanhas</option>${campaigns.map(item=>`<option value="${item.id}" ${String(item.id)===selectedCampaign?'selected':''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label><span>De</span><input type="date" id="meta-start" value="${start}" max="${end}"></label><label><span>Até</span><input type="date" id="meta-end" value="${end}" min="${start}" max="${defaultEnd}"></label><button class="primary-button" type="submit">Aplicar filtros</button></form>
  <div class="meta-ad-grid">${cards}</div><div class="meta-ads-layout"><section class="panel"><div class="panel-header"><div><h3>Desempenho diário</h3><span>Passe o mouse ou toque em uma coluna para ver o detalhe.</span></div></div><div class="meta-ad-bars">${report.daily.map(day=>`<button type="button" style="--bar-height:${Math.max(4,Math.min(100,Number(day.clicks||0)/maxClicks*100))}%"><i></i><small>${new Date(`${day.date_start}T12:00:00`).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}</small><span class="meta-data-tooltip"><b>${integer(day.clicks)} cliques</b><em>${currency(day.spend)} investidos</em><em>${integer(day.impressions)} impressões</em></span></button>`).join('')}</div></section><section class="panel"><div class="panel-header"><div><h3>Funil de anúncios</h3><span>Conversão entre cada etapa.</span></div></div><div class="ads-funnel">${funnel.map(([label,value],index)=>{const previous=index?Number(funnel[index-1][1]||0):0;const conversion=index&&previous?Number(value||0)/previous*100:100;return `<button type="button" style="--ads-width:${100-index*18}%"><span>${label}</span><strong>${integer(value)}</strong><span class="meta-data-tooltip"><b>${escapeHtml(label)}</b><em>${index?conversion.toLocaleString('pt-BR',{maximumFractionDigits:2})+'% da etapa anterior':'Topo do funil'}</em></span></button>`}).join('')}</div></section></div>
  <div class="meta-detail-grid"><section class="panel meta-best-ad"><div class="panel-header"><div><h3>Anúncio com melhor retorno</h3><span>Priorizado por vendas, leads e custo por lead.</span></div></div>${report.best_ad?`<article><p class="overline">${escapeHtml(report.best_ad.campaign_name||'Campanha')}</p><h3>${escapeHtml(report.best_ad.ad_name||'Anúncio sem nome')}</h3><div><span><b>${integer(report.best_ad.leads)}</b> leads</span><span><b>${integer(report.best_ad.purchases)}</b> vendas</span><span><b>${currency(report.best_ad.spend)}</b> investidos</span><span><b>${currency(report.best_ad.cpl)}</b> por lead</span></div></article>`:'<p class="empty-inline">Ainda não há anúncios com entrega neste filtro.</p>'}</section><section class="panel"><div class="panel-header"><div><h3>Leads recebidos</h3><span>${report.leads.length} registro(s) encontrados no CRM.</span></div></div><div class="meta-lead-list">${report.leads.slice(0,30).map(lead=>`<button type="button" data-contact-id="${lead.id}"><span><b>${escapeHtml(lead.name||'Lead sem nome')}</b><small>${escapeHtml(lead.campaign_name||'Campanha não identificada')} · ${escapeHtml(lead.ad_name||'Anúncio não identificado')}</small></span><time>${new Date(lead.created_at).toLocaleDateString('pt-BR')}</time></button>`).join('')||`<p class="empty-inline">${report.totals.leads?'A Meta atribuiu leads, mas o acesso lead a lead ainda depende da permissão leads_retrieval.':'Nenhum lead neste período.'}</p>`}</div></section></div>`;
  document.querySelector('#meta-ad-account').addEventListener('change',e=>{localStorage.setItem('atenva-meta-ad-account',e.target.value);renderMetaAds();});
  document.querySelector('#meta-campaign').addEventListener('change',e=>{localStorage.setItem('atenva-meta-campaign',e.target.value);renderMetaAds();});
  document.querySelector('#meta-ads-filters').addEventListener('submit',event=>{event.preventDefault();const from=document.querySelector('#meta-start').value;const to=document.querySelector('#meta-end').value;if(from>to)return toast('Período inválido','A data inicial deve ser anterior à final.','error');localStorage.setItem('atenva-meta-start',from);localStorage.setItem('atenva-meta-end',to);renderMetaAds();});
  document.querySelectorAll('[data-contact-id]').forEach(button=>button.addEventListener('click',()=>{state.view='contacts';navigate('contacts');}));
  document.querySelector('#customize-meta-metrics').addEventListener('click',()=>{const host=document.querySelector('#detail-modal-content');host.innerHTML=`<div class="modal-icon">${icon('settings')}</div><p class="overline">Meta Ads</p><h2>Escolha suas métricas</h2><div class="meta-metric-picker">${definitions.map(([key,label])=>`<label><input type="checkbox" value="${key}" ${visible.includes(key)?'checked':''}> ${escapeHtml(label)}</label>`).join('')}</div><button class="primary-button" id="save-meta-metrics">Salvar visualização</button>`;openModal('detail-modal');host.querySelector('#save-meta-metrics').onclick=()=>{const next=[...host.querySelectorAll('input:checked')].map(input=>input.value);localStorage.setItem('atenva-meta-metrics',JSON.stringify(next));closeModals();renderMetaAds();};});
}

async function renderMeta() {
  setLoading('#view-meta'); const end = new Date().toISOString().slice(0,10); const startDate = new Date(); startDate.setDate(startDate.getDate()-29); const start = startDate.toISOString().slice(0,10);
  const integrationResults = await Promise.allSettled([api('/api/meta/status'), api(`/api/meta/metrics?start=${start}&end=${end}`), api('/api/integrations/google/status'),api('/api/evolution/status')]);
  const status = integrationResults[0].status === 'fulfilled' ? integrationResults[0].value : {connected:false,oauth_connected:false,oauth:{configured:false,lead_retrieval_enabled:false},ad_accounts_connected:0,pages_connected:0,lead_pages_subscribed:0};
  const report = integrationResults[1].status === 'fulfilled' ? integrationResults[1].value : {demo:false,totals:{conversations_started:0,messages_sent:0,messages_delivered:0,messages_read:0,spend_cents:0},daily:[]};
  const google = integrationResults[2].status === 'fulfilled' ? integrationResults[2].value : {connected:false,configured:false};
  const evolution=integrationResults[3].status==='fulfilled'?integrationResults[3].value:null;
  const integrationErrors = integrationResults.map((result,index)=>result.status==='rejected'?`${['Meta/WhatsApp','métricas','Google Agenda','Evolution'][index]}: ${result.reason?.message||'indisponível'}`:'').filter(Boolean);
  let googleCalendars=[];let googleCalendarError='';if(google.connected){try{googleCalendars=await api('/api/integrations/google/calendars');}catch(error){googleCalendarError=error.message;}}
  let metaPages=[],metaBusinesses=[];if(status.oauth_connected){const assets=await Promise.allSettled([api('/api/meta/pages'),api('/api/meta/businesses')]);metaPages=assets[0].status==='fulfilled'?assets[0].value:[];metaBusinesses=assets[1].status==='fulfilled'?assets[1].value:[];}
  const deliveryRate = report.totals.messages_sent ? Math.round(report.totals.messages_delivered / report.totals.messages_sent * 100) : 0;
  const readRate = report.totals.messages_delivered ? Math.round(report.totals.messages_read / report.totals.messages_delivered * 100) : 0;
  document.querySelector('#view-meta').innerHTML = `<div class="section-head"><div><h2>Integrações</h2><p>Google, Meta Ads e WhatsApp oficial conectados por cliente.</p></div><span class="connection-pill ${status.connected ? 'connected' : ''}"><i></i>${status.connected?'WhatsApp oficial conectado':'WhatsApp oficial pendente'}</span></div>
  ${integrationErrors.length?`<div class="integration-load-warning">${icon('info')}<div><strong>Alguns dados não responderam agora</strong><span>${escapeHtml(integrationErrors.join(' · '))}. As demais conexões continuam disponíveis.</span></div><button class="ghost-button" id="retry-integrations">Tentar novamente</button></div>`:''}
  <section class="panel google-integration-card ${google.connected?'is-connected':''}"><div class="google-integration-icon">G</div><div><p class="overline">Agenda e reuniões</p><h3>${google.connected?'Google Agenda conectado':'Conectar Google Agenda'}</h3><p>${google.connected?`Conta ${escapeHtml(google.email||'Google')} conectada. ${google.last_synced_at?`Última atualização ${relativeTime(google.last_synced_at)} · ${google.imported_events} evento(s).`:'A primeira sincronização será concluída automaticamente.'}`:'Entre com seu e-mail Google uma vez; reuniões e compromissos aparecerão automaticamente no calendário.'}</p>${googleCalendars.length?`<div class="google-calendar-list">${googleCalendars.map(calendar=>`<span><i style="background:${escapeHtml(calendar.color)}"></i>${escapeHtml(calendar.name)}${calendar.primary?' · principal':''}</span>`).join('')}</div>`:''}${googleCalendarError||google.sync_error?`<small class="integration-error">${escapeHtml(googleCalendarError||google.sync_error)}</small>`:''}</div><div>${google.connected?`${google.needs_reconnect||googleCalendarError?'<button class="primary-button" id="connect-google">Reconectar Google</button>':'<button class="ghost-button" id="sync-google">Sincronizar agora</button>'}<button class="ghost-button" id="disconnect-google">Desconectar</button>`:`<button class="primary-button" id="connect-google" ${google.configured?'':'disabled'}>Entrar com Google</button>${google.configured?'':'<small>Configuração do Google pendente no servidor.</small>'}`}</div></section>
  <section class="panel meta-login-card ${status.oauth_connected?'is-connected':''}"><div class="meta-login-icon">M</div><div><p class="overline">Facebook, Instagram e Lead Ads</p><h3>${status.oauth_connected?'Conta Meta conectada':'Conectar Meta com um login'}</h3><p>${status.oauth_connected?`${status.ad_accounts_connected} conta(s) de anúncio e ${status.pages_connected} página(s) atualizadas automaticamente. Captação de leads: ${status.lead_pages_subscribed?'ativa em '+status.lead_pages_subscribed+' página(s)':status.oauth?.lead_retrieval_enabled?'pronta para ativar':'aguardando aprovação da Meta'}.`:'Entre com Facebook e escolha as contas de anúncio e páginas que deseja acompanhar.'}</p>${status.marketing_sync_error?`<small class="integration-error">Última tentativa: ${escapeHtml(status.marketing_sync_error)}</small>`:''}</div><div><button class="primary-button" id="connect-meta-oauth" ${status.oauth?.configured?'':'disabled'}>${status.oauth_connected?'Reconectar Facebook':'Entrar com Facebook'}</button>${status.oauth_connected&&status.oauth?.lead_retrieval_enabled&&!status.lead_pages_subscribed?'<button class="ghost-button" id="activate-meta-leads">Ativar leads dos formulários</button>':''}${!status.oauth?.configured?'<small>OAuth da Meta pendente no servidor.</small>':!status.oauth?.lead_retrieval_enabled?'<small>A conexão básica segue funcionando. Para captar formulários, falta liberar leads_retrieval no aplicativo da Meta.</small>':status.lead_pages_subscribed?'<small>Novos formulários entram automaticamente em Contatos, Funis e Tarefas.</small>':'<small>Reconecte e ative as páginas após a aprovação.</small>'}</div></section>
  ${status.oauth_connected?`<section class="panel meta-assets"><div class="panel-header"><div><h3>Portfólios empresariais e ativos</h3><span>Escolha a BM ativa e gerencie as páginas liberadas neste login.</span></div><button class="ghost-button" id="refresh-meta-assets">${icon('refresh')} Atualizar ativos</button></div><div class="meta-business-list">${metaBusinesses.map(business=>`<button type="button" data-meta-business="${business.id}" class="${business.active?'active':''}"><span><strong>${escapeHtml(business.name)}</strong><small>${escapeHtml(business.verification_status||'Status não informado')}</small></span><b>${business.active?'Ativa':'Usar esta BM'}</b></button>`).join('')||'<p class="empty-inline">Nenhuma BM foi liberada para este login.</p>'}</div><div class="meta-page-list">${metaPages.map(page=>`<article><div><strong>${escapeHtml(page.name)}</strong><span>${escapeHtml(page.category||'Página')} ${page.instagram?`· @${escapeHtml(page.instagram.username||page.instagram.name||'Instagram')}`:''}</span></div><button class="ghost-button" data-meta-page="${page.id}">Ver formulários</button></article>`).join('')||'<p class="empty-inline">Nenhuma página foi liberada para este login.</p>'}</div><div id="meta-form-list"></div></section>`:''}
  <details class="official-meta-details" open><summary>WhatsApp oficial · canal principal em tempo real</summary><div class="meta-layout"><section class="panel connection-setup"><div class="panel-header"><div><h3>Conectar WhatsApp Cloud API</h3><span>Credenciais isoladas por cliente e criptografadas</span></div>${icon('link')}</div>${status.connected ? `<div class="connected-account"><span class="conversation-avatar">${icon('check')}</span><div><strong>${escapeHtml(status.verified_name || 'WhatsApp Business')}</strong><p>${escapeHtml(status.display_phone_number || status.phone_number_id || '')} · Webhook ${status.webhooks_subscribed?'ativo':'pendente'} · Qualidade ${escapeHtml(status.quality_rating || 'não informada')}</p></div></div>` : ''}<form class="meta-config-form" id="meta-config-form"><label>Token permanente <input type="password" name="access_token" autocomplete="off" placeholder="${status.oauth_connected ? '•••••••• (manter atual)' : 'EAAG…'}"></label><div class="field-pair"><label>Phone Number ID<input name="phone_number_id" inputmode="numeric" placeholder="${escapeHtml(status.phone_number_id || 'ID do telefone')}"></label><label>Business Account ID<input name="business_account_id" inputmode="numeric" placeholder="${escapeHtml(status.business_account_id || 'ID da conta WABA')}"></label></div><label>App Secret<input type="password" name="app_secret" autocomplete="off" placeholder="${status.oauth_connected ? '•••••••• (configurado pela Atenva)' : 'Segredo do app'}"></label><div class="field-pair"><label>Token de verificação<input name="verify_token" autocomplete="off" placeholder="${status.verify_token_configured?'Configurado pela Atenva':'Frase secreta'}"></label><label>Versão da API<input name="api_version" value="${escapeHtml(status.api_version || 'v23.0')}"></label></div><div class="connection-form-actions"><button type="submit" class="primary-button">Salvar credenciais</button><button type="button" class="ghost-button" id="test-meta">Validar e ativar webhook</button></div></form></section><section><div class="meta-metric-grid">${metricCard('conversations','message','Conversas iniciadas',report.totals.conversations_started,'últimos 30 dias')}${metricCard('sent','send','Mensagens enviadas',report.totals.messages_sent,`${deliveryRate}% entregues`)}${metricCard('read','check','Taxa de leitura',`${readRate}%`,`${report.totals.messages_read} mensagens lidas`)}${metricCard('spend','money','Custo Meta',money(report.totals.spend_cents),'estimativa do período',true)}</div><div class="panel"><div class="panel-header"><div><h3>Desempenho diário</h3><span>${report.demo ? 'Dados ilustrativos até conectar a Meta' : 'Dados sincronizados da Meta'}</span></div>${status.connected ? '<button class="link-button" id="sync-meta">Sincronizar agora</button>' : ''}</div><div class="meta-table"><div class="meta-row head"><span>Data</span><span>Recebidas</span><span>Enviadas</span><span>Entregues</span><span>Lidas</span></div>${report.daily.slice(-10).reverse().map(day => `<div class="meta-row"><span>${new Date(`${day.date}T12:00:00`).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}</span><b>${day.messages_received}</b><b>${day.messages_sent}</b><b>${day.messages_delivered}</b><b>${day.messages_read}</b></div>`).join('')}</div></div><div class="connection-guide-options"><button id="open-meta-tutorial"><b>▶ Tutorial explicado</b><span>Veja as etapas completas.</span></button><button id="open-meta-guided"><b>→ Conexão assistida</b><span>Siga com links e progresso salvo.</span></button></div></section></div></details>`;
  installOfficialWhatsAppConnect(status);
  if(evolution?.configured){
    document.querySelector('#view-meta').insertAdjacentHTML('afterbegin',`<section class="panel google-integration-card ${evolution.connected?'is-connected':''}"><div class="google-integration-icon">${icon('qr')}</div><div><p class="overline">WhatsApp por QR Code</p><h3>${escapeHtml(evolution.status_title||'Evolution')}</h3><p>${escapeHtml(evolution.status_message||'Vincule seu aparelho para receber e responder mensagens no CRM.')}</p></div><div>${evolution.connected?'<button class="ghost-button" id="disconnect-evolution">Desconectar aparelho</button>':`<button class="primary-button" id="connect-evolution" ${evolution.reachable?'':'disabled'}>Conectar por QR Code</button>`}<button class="ghost-button" id="refresh-evolution">Atualizar conexão</button></div></section>`);
    document.querySelector('#connect-evolution')?.addEventListener('click',connectEvolutionFlow);
    document.querySelector('#refresh-evolution')?.addEventListener('click',()=>renderMeta());
    document.querySelector('#disconnect-evolution')?.addEventListener('click',async()=>{try{await api('/api/evolution/disconnect',{method:'POST',body:{}});toast('Aparelho desconectado','Você pode vincular novamente pelo QR Code.');await loadHealth();await renderMeta();}catch(error){toast('Não foi possível desconectar',error.message,'error');}});
  }
  document.querySelector('#retry-integrations')?.addEventListener('click',()=>renderMeta());
  document.querySelector('#connect-google')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;try{const result=await api('/api/integrations/google/start');location.href=result.url;}catch(error){toast('Não foi possível conectar',error.message,'error');event.currentTarget.disabled=false;}});
  document.querySelector('#sync-google')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;try{const result=await api('/api/integrations/google/sync',{method:'POST',body:{},timeoutMs:45_000});toast('Agendas sincronizadas',`${result.events} evento(s) de ${result.calendars} agenda(s) atualizados.`);await renderMeta();}catch(error){toast('Não foi possível sincronizar',error.message,'error');event.currentTarget.disabled=false;}});
  document.querySelector('#disconnect-google')?.addEventListener('click',async()=>{await api('/api/integrations/google/disconnect',{method:'POST',body:{}});toast('Agenda desconectada','Os eventos do Google deixaram de ser sincronizados.');renderMeta();});
  document.querySelector('#connect-meta-oauth')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;try{const result=await api('/api/meta/oauth/start');location.href=result.url;}catch(error){toast('Não foi possível conectar',error.message,'error');event.currentTarget.disabled=false;}});
  document.querySelector('#activate-meta-leads')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;try{const result=await api('/api/meta/leads/activate',{method:'POST',body:{}});toast('Captação de leads ativada',`${result.pages.filter(page=>page.leadWebhookSubscribed).length} página(s) conectada(s).`);await renderMeta();}catch(error){toast('Não foi possível ativar os leads',error.message,'error');event.currentTarget.disabled=false;}});
  document.querySelector('#refresh-meta-assets')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;try{await api('/api/meta/marketing/sync',{method:'POST',body:{},timeoutMs:45_000});toast('Ativos atualizados','Contas, páginas e métricas foram sincronizadas.');await renderMeta();}catch(error){toast('Falha ao atualizar',error.message,'error');event.currentTarget.disabled=false;}});
  document.querySelectorAll('[data-meta-business]').forEach(button=>button.addEventListener('click',async()=>{try{await api('/api/meta/businesses/active',{method:'PUT',body:{business_id:button.dataset.metaBusiness}});toast('BM atualizada','O portfólio empresarial foi definido como ativo.');await renderMeta();}catch(error){toast('Não foi possível alterar a BM',error.message,'error');}}));
  document.querySelectorAll('[data-meta-page]').forEach(button=>button.addEventListener('click',async()=>{const host=document.querySelector('#meta-form-list');host.innerHTML='<p>Carregando formulários…</p>';try{const forms=await api(`/api/meta/lead-forms?page_id=${encodeURIComponent(button.dataset.metaPage)}`);host.innerHTML=`<div class="meta-form-grid">${forms.map(form=>`<article><strong>${escapeHtml(form.name)}</strong><span>${escapeHtml(form.status||'ativo')} · ${Number(form.leads_count||0)} leads</span></article>`).join('')||'<p class="empty-inline">Nenhum formulário nesta página.</p>'}</div>`;}catch(error){host.innerHTML=`<p class="integration-error">${escapeHtml(error.message)}</p>`;}}));
  document.querySelector('#meta-config-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.currentTarget.querySelector('[type=submit]'); button.disabled = true; try { await api('/api/meta/config', { method: 'PUT', body: Object.fromEntries(new FormData(event.currentTarget)) }); toast('Credenciais protegidas', 'Agora teste a conexão com a Meta.'); await renderMeta(); } catch (error) { toast('Não foi possível salvar', error.message, 'error'); } finally { button.disabled = false; } });
  document.querySelector('#test-meta').addEventListener('click', async event => { event.currentTarget.disabled = true; try { const result = await api('/api/meta/test', { method: 'POST' }); toast('Meta conectada', `${result.verified_name || 'Conta'} validada com sucesso.`); await renderMeta(); } catch (error) { toast('Falha na conexão', error.message, 'error'); } finally { event.currentTarget.disabled = false; } });
  document.querySelector('#sync-meta')?.addEventListener('click', async event => { event.currentTarget.disabled = true; try { const result = await api(`/api/meta/sync?start=${start}&end=${end}`, { method: 'POST' }); toast('Métricas sincronizadas', `${result.points} períodos recebidos da Meta.`); await renderMeta(); } catch (error) { toast('Falha na sincronização', error.message, 'error'); } finally { event.currentTarget.disabled = false; } });
  document.querySelector('#open-meta-tutorial')?.addEventListener('click', openMetaTutorial);
  document.querySelector('#open-meta-guided')?.addEventListener('click', openGuidedSetup);
}

let facebookSdkPromise = null;
function loadFacebookSdk(appId, apiVersion = 'v23.0') {
  if (window.FB) return Promise.resolve(window.FB);
  if (facebookSdkPromise) return facebookSdkPromise;
  facebookSdkPromise = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => { window.FB.init({ appId, cookie:true, xfbml:false, version:apiVersion }); resolve(window.FB); };
    const script=document.createElement('script');script.id='facebook-jssdk';script.async=true;script.defer=true;script.crossOrigin='anonymous';script.src='https://connect.facebook.net/pt_BR/sdk.js';script.onerror=()=>reject(new Error('Não foi possível carregar o login seguro da Meta.'));
    document.head.append(script);
  });
  return facebookSdkPromise;
}

function embeddedSignupResult(FB, configId) {
  return new Promise((resolve, reject) => {
    let authorizationCode='';let signupData=null;let settled=false;
    const finish=()=>{if(!settled&&authorizationCode&&signupData){settled=true;cleanup();resolve({code:authorizationCode,...signupData});}};
    const cleanup=()=>{window.removeEventListener('message',listener);clearTimeout(timeout);};
    const listener=event=>{
      try{const host=new URL(event.origin).hostname;if(!(host==='facebook.com'||host.endsWith('.facebook.com')))return;}catch{return;}
      let payload=event.data;try{if(typeof payload==='string')payload=JSON.parse(payload);}catch{return;}
      if(payload?.type!=='WA_EMBEDDED_SIGNUP')return;
      if(payload.event==='FINISH'){signupData={waba_id:String(payload.data?.waba_id||''),phone_number_id:String(payload.data?.phone_number_id||'')};finish();}
      else if(['CANCEL','ERROR'].includes(payload.event)){settled=true;cleanup();reject(new Error(payload.event==='CANCEL'?'Conexão cancelada antes da conclusão.':payload.data?.error_message||'A Meta não concluiu a configuração do WhatsApp.'));}
    };
    window.addEventListener('message',listener);
    const timeout=setTimeout(()=>{if(!settled){settled=true;cleanup();reject(new Error('A Meta não devolveu os dados do número. Abra a conexão novamente.'));}},90_000);
    FB.login(response=>{
      authorizationCode=String(response?.authResponse?.code||'');
      if(!authorizationCode&&!settled){settled=true;cleanup();reject(new Error('O login foi fechado ou não autorizou o WhatsApp.'));return;}
      finish();
    },{config_id:configId,response_type:'code',override_default_response_type:true,extras:{setup:{},feature:'whatsapp_embedded_signup',sessionInfoVersion:'3'}});
  });
}

function installOfficialWhatsAppConnect(status) {
  const setup=document.querySelector('.connection-setup');const form=document.querySelector('#meta-config-form');if(!setup||!form)return;
  const automaticReady=Boolean(status.oauth?.embedded_signup_configured);const numbers=Array.isArray(status.whatsapp_numbers)?status.whatsapp_numbers:[];const numberList=numbers.length?`<div class="whatsapp-number-list">${numbers.map(number=>`<button type="button" data-whatsapp-number="${escapeHtml(number.phone_number_id)}" class="${number.active?'active':''}"><span><b>${escapeHtml(number.verified_name||'WhatsApp Business')}</b><small>${escapeHtml(number.display_phone_number||`final ${number.phone_number_id.slice(-4)}`)}</small></span><em>${number.active?'Número de envio':'Usar para enviar'}</em></button>`).join('')}</div>`:'';const box=document.createElement('div');box.className=`embedded-signup-box ${automaticReady?'':'is-pending'}`;box.innerHTML=`<span class="embedded-signup-icon">${icon(status.connected?'check':'whatsapp')}</span><div><strong>${status.connected?`${numbers.length||1} número(s) conectado(s)`:automaticReady?'Conecte em poucos cliques':'Conexão oficial disponível'}</strong><p>${status.connected?'Todos recebem em tempo real. Escolha abaixo qual número será usado nos envios.':automaticReady?'Entre com o Facebook, escolha a empresa e o número. A Atenva configura o restante automaticamente.':'A configuração manual da Cloud API já funciona. O login automático será liberado quando a Meta concluir o credenciamento da Atenva como Tech Provider.'}</p>${numberList}</div><button type="button" class="primary-button" id="connect-whatsapp-official" ${automaticReady?'':'disabled'}>${status.connected?'Adicionar outro número':'Conectar automaticamente'}</button>${!automaticReady?'<small>O bloqueio visto no Facebook é externo: a Meta restringe o Embedded Signup a BSPs/Tech Providers aprovados. Use “Configuração oficial manual” abaixo enquanto a aprovação está pendente.</small>':''}`;
  form.before(box);
  const advanced=document.createElement('details');advanced.className='manual-meta-config';advanced.open=!automaticReady&&!status.connected;advanced.innerHTML='<summary>Configuração oficial manual</summary>';form.before(advanced);advanced.append(form);
  box.querySelector('#connect-whatsapp-official')?.addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;button.textContent='Abrindo Meta…';
    try{
      const FB=await loadFacebookSdk(status.oauth.app_id,status.oauth.api_version);
      const result=await embeddedSignupResult(FB,status.oauth.business_login_config_id);
      button.textContent='Ativando webhook…';
      const connected=await api('/api/meta/whatsapp/embedded-signup',{method:'POST',body:result,timeoutMs:45_000});
      toast('WhatsApp oficial conectado',`${connected.verified_name||'Número'} está em tempo real e ${connected.initial_sync?.synced?'as métricas já foram atualizadas':'a atualização automática continuará em segundo plano'}.`);
      await loadHealth();await renderMeta();
    }catch(error){toast('Não foi possível conectar',error.message,'error');button.disabled=false;button.textContent=status.connected?'Reconectar número':'Entrar com Facebook';}
  });
  box.querySelectorAll('[data-whatsapp-number]').forEach(button=>button.addEventListener('click',async()=>{if(button.classList.contains('active'))return;try{await api('/api/meta/whatsapp/numbers/active',{method:'PUT',body:{phone_number_id:button.dataset.whatsappNumber}});toast('Número de envio alterado','As próximas mensagens sairão pelo número selecionado.');await renderMeta();}catch(error){toast('Não foi possível alterar o número',error.message,'error');}}));
}

let evolutionPoll = null;
async function connectEvolutionFlow(event) {
  // O QR Code usa um modal próprio. Feche o tour antes de abri-lo para que
  // a camada do tutorial não esconda o modal de conexão.
  if (!document.querySelector('#product-tour')?.hidden) stopSystemTour(false);
  const button = event.currentTarget; button.disabled = true; button.innerHTML = 'Gerando QR Code…';
  try {
    const result = await api('/api/evolution/connect', { method: 'POST', body: {} });
    if (result.connected) { toast('WhatsApp conectado', 'A Evolution já está recebendo mensagens.'); return renderMeta(); }
    if (!result.qr_code) throw new Error('A Evolution ainda não devolveu o QR Code. Tente novamente em alguns segundos.');
    let backdrop = document.querySelector('#evolution-qr-modal');
    if (!backdrop) { backdrop = document.createElement('div'); backdrop.id = 'evolution-qr-modal'; backdrop.className = 'modal-backdrop'; document.body.append(backdrop); }
    backdrop.hidden = false;
    backdrop.innerHTML = `<div class="modal evolution-qr-modal"><button class="modal-close" aria-label="Fechar">${icon('x')}</button><div class="modal-icon">${icon('qr')}</div><p class="overline">Último passo</p><h2>Escaneie com o WhatsApp</h2><p>No celular, abra WhatsApp → Aparelhos conectados → Conectar aparelho e aponte a câmera para este código.</p><div class="qr-frame"><img src="${result.qr_code}" alt="QR Code para conectar o WhatsApp"></div>${result.webhook_configured === false ? '<p class="qr-warning">O QR já está disponível. A sincronização das mensagens está sendo finalizada em segundo plano.</p>' : ''}<div class="qr-wait"><i></i><span>Aguardando a leitura do QR Code…</span></div></div>`;
    backdrop.querySelector('.modal-close').addEventListener('click', () => { backdrop.hidden = true; clearInterval(evolutionPoll); });
    clearInterval(evolutionPoll);
    const companyId=state.user?.companyId;
    let polling=false;let qrGeneratedAt=Date.now();
    evolutionPoll = setInterval(async () => {
      if(polling)return;
      if(backdrop.hidden||!state.user||state.user.companyId!==companyId){clearInterval(evolutionPoll);backdrop.hidden=true;return;}
      polling=true;
      try {
        const current = await api('/api/evolution/status');
        if(backdrop.hidden||state.user?.companyId!==companyId)return;
        if (current.connected) { clearInterval(evolutionPoll); backdrop.hidden = true; toast('WhatsApp conectado', 'A conexão foi concluída e já está ativa.'); await loadHealth(); await renderMeta(); }
        else if(Date.now()-qrGeneratedAt>=25_000){
          const fresh=await api('/api/evolution/connect',{method:'POST',body:{}});
          if(!backdrop.hidden&&state.user?.companyId===companyId&&fresh.qr_code){backdrop.querySelector('.qr-frame img').src=fresh.qr_code;qrGeneratedAt=Date.now();}
        }
      } catch {} finally {polling=false;}
    }, 3000);
  } catch (error) { toast('Não foi possível conectar', error.message, 'error'); }
  finally {button.disabled=false;button.innerHTML='Conectar por QR Code';}
}

async function renderQualification() {
  setLoading('#view-qualification'); [state.qualification,state.insights,state.pipelineAutomations,state.allPipelineStages] = await Promise.all([api('/api/qualification/config'),api('/api/insights'),api('/api/pipeline-automations'),api('/api/pipeline-stages')]);
  const { config, stages, totals } = state.qualification;
  const funnelOrientation = localStorage.getItem('atenva-funnel-orientation') === 'horizontal' ? 'horizontal' : 'vertical';
  const fieldLabels = { phone: 'Telefone', email: 'E-mail', company: 'Empresa', segment: 'Segmento', location: 'Localização', need: 'Necessidade', budget: 'Orçamento informado', timeframe: 'Prazo', decision_role: 'Participação na decisão' };
  const maxTotal=Math.max(1,totals.lead,totals.mql,totals.sql,totals.customer); const agentName=state.agentConfig?.name||'Atenva';
  document.querySelector('#view-qualification').innerHTML = `<div class="section-head"><div><h2>Funil de leads</h2><p>Regras sugeridas pelo playbook e editáveis pela equipe.</p></div><div class="funnel-head-actions"><div class="segmented"><button data-funnel-orientation="vertical" class="${funnelOrientation==='vertical'?'active':''}">Vertical</button><button data-funnel-orientation="horizontal" class="${funnelOrientation==='horizontal'?'active':''}">Horizontal</button></div><button class="ghost-button" id="recalculate-qualification">${icon('spark')} Recalcular contatos</button></div></div><div class="dynamic-funnel ${funnelOrientation}">${[['Impressões',totals.lead+totals.mql+totals.sql],['Leads',totals.lead],['MQLs',totals.mql],['SQLs',totals.sql],['Clientes',totals.customer]].map(([label,value],index)=>`<article style="--funnel-width:${Math.max(35,100-index*13)}%"><span class="animated-data-icon">${icon(['trend','users','spark','check','money'][index])}</span><strong>${label}</strong><b>${value}</b></article>`).join('')}</div><div class="qualification-summary"><article class="lead"><span>Lead</span><strong>${totals.lead}</strong><p>Contato capturado, ainda em descoberta.</p></article><article class="mql"><span>MQL</span><strong>${totals.mql}</strong><p>Atende aos critérios mínimos de marketing.</p></article><article class="sql"><span>SQL</span><strong>${totals.sql}</strong><p>Pronto para abordagem comercial.</p></article><article class="customer"><span>Cliente</span><strong>${totals.customer}</strong><p>Oportunidade marcada como ganha.</p></article></div><div class="qualification-layout"><section class="panel"><div class="panel-header"><div><h3>Critérios da empresa</h3><span>Sincronizados com o playbook e editáveis</span></div></div><form class="qualification-form" id="qualification-form"><div class="rule-block mql"><header><span>MQL</span><p>Lead qualificado por marketing</p></header><label>Pontuação mínima<input type="number" name="mql_min_score" min="0" max="100" value="${config.mql_min_score}" required></label><label>Ou chegou à etapa<select name="mql_stage_id"><option value="">Não usar etapa</option>${stages.map(stage => `<option value="${stage.id}" ${stage.id === config.mql_stage_id ? 'selected' : ''}>${escapeHtml(stage.name)}</option>`).join('')}</select></label></div><div class="rule-block sql"><header><span>SQL</span><p>Lead qualificado para vendas</p></header><label>Pontuação mínima<input type="number" name="sql_min_score" min="0" max="100" value="${config.sql_min_score}" required></label><label>Ou chegou à etapa<select name="sql_stage_id"><option value="">Não usar etapa</option>${stages.map(stage => `<option value="${stage.id}" ${stage.id === config.sql_stage_id ? 'selected' : ''}>${escapeHtml(stage.name)}</option>`).join('')}</select></label></div><fieldset><legend>Dados obrigatórios para qualificar</legend><div class="check-grid">${Object.entries(fieldLabels).map(([field,label]) => `<label><input type="checkbox" name="required_fields" value="${field}" ${config.required_fields.includes(field) ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset><fieldset><legend>Dados adicionais obrigatórios para SQL</legend><div class="check-grid">${Object.entries(fieldLabels).map(([field,label]) => `<label><input type="checkbox" name="sql_required_fields" value="${field}" ${(config.sql_required_fields||[]).includes(field) ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset><label class="automation-toggle"><input type="checkbox" name="auto_move" ${config.auto_move ? 'checked' : ''}><span><strong>Mover cards automaticamente</strong><small>Avança etapas quando os dados exigidos estão preenchidos. A classificação é recalculada mesmo com a movimentação desligada.</small></span></label><div class="form-footer"><button class="primary-button" type="submit">Salvar regras</button></div></form></section><section class="panel kanban-map"><div class="panel-header"><div><h3>Como o Kanban influencia</h3><span>${escapeHtml(state.qualification.pipeline?.name || 'Funil de vendas')}</span></div></div><div class="qualification-flow">${stages.map(stage => { const label = stage.local_position >= (stages.find(item => item.id === config.sql_stage_id)?.local_position || 999) ? 'SQL' : stage.local_position >= (stages.find(item => item.id === config.mql_stage_id)?.local_position || 999) ? 'MQL' : 'Lead'; return `<div><i></i><strong>${escapeHtml(stage.name)}</strong><span class="qualification-badge ${label.toLowerCase()}">${label}</span></div>`; }).join('')}</div><div class="ai-explanation">${icon('spark')}<p><strong>O ${escapeHtml(agentName)} cruza três sinais:</strong> posição no Kanban, fit comercial e dados obrigatórios. O playbook pode atualizar os limites automaticamente.</p></div></section></div>`;
  const insightHost=document.querySelector('#view-qualification'); const maxLoss=Math.max(1,...state.insights.loss_reasons.map(item=>item.value));
  insightHost.insertAdjacentHTML('beforeend',`<div class="insights-grid"><section class="panel"><div class="panel-header"><div><h3>Motivos de perda</h3><span>Estatísticas das oportunidades encerradas</span></div></div><div class="insight-bars">${state.insights.loss_reasons.map(item=>`<div><span>${escapeHtml(item.label)}</span><i><b style="width:${item.value/maxLoss*100}%"></b></i><strong>${item.value}</strong></div>`).join('')||'<p class="empty-inline">Nenhuma perda registrada.</p>'}</div></section><section class="panel"><div class="panel-header"><div><h3>Retomada x remarketing</h3><span>Tratamento dado aos não clientes</span></div></div><div class="recovery-stats">${state.insights.recovery.map(item=>`<article><strong>${item.value}</strong><span>${escapeHtml(({retomada:'Retomada comercial',remarketing:'Remarketing',arquivar:'Arquivados'})[item.label]||item.label)}</span></article>`).join('')||'<p class="empty-inline">Nenhum histórico ainda.</p>'}</div></section></div><section class="panel automation-panel"><div class="panel-header"><div><h3>Automações entre etapas e funis</h3><span>Mova negócios, crie tarefas ou aplique tags quando uma etapa for alcançada.</span></div></div><form id="pipeline-automation-form" class="automation-form"><input name="name" required placeholder="Nome da automação"><select name="trigger_stage_id" required><option value="">Quando entrar em…</option>${state.allPipelineStages.map(s=>`<option value="${s.id}">${escapeHtml(s.pipeline_name)} · ${escapeHtml(s.name)}</option>`).join('')}</select><select name="action_type"><option value="move_deal">Mover para etapa/funil</option><option value="create_task">Criar tarefa</option><option value="add_tag">Adicionar tag</option></select><select name="target_stage_id"><option value="">Etapa de destino</option>${state.allPipelineStages.map(s=>`<option value="${s.id}" data-pipeline="${s.pipeline_id}">${escapeHtml(s.pipeline_name)} · ${escapeHtml(s.name)}</option>`).join('')}</select><input name="action_value" placeholder="Título da tarefa ou tag"><button class="primary-button">Criar automação</button></form><div class="automation-list">${state.pipelineAutomations.map(item=>`<span><strong>${escapeHtml(item.name)}</strong><button data-delete-automation="${item.id}">${icon('trash')}</button></span>`).join('')||'<p class="empty-inline">Nenhuma automação personalizada.</p>'}</div></section>`);
  document.querySelectorAll('[data-funnel-orientation]').forEach(button=>button.addEventListener('click',()=>{localStorage.setItem('atenva-funnel-orientation',button.dataset.funnelOrientation);renderQualification();}));
  document.querySelector('#qualification-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); const body = Object.fromEntries(values); body.required_fields = values.getAll('required_fields'); body.sql_required_fields = values.getAll('sql_required_fields'); body.mql_stage_id = body.mql_stage_id ? Number(body.mql_stage_id) : null; body.sql_stage_id = body.sql_stage_id ? Number(body.sql_stage_id) : null; body.mql_min_score = Number(body.mql_min_score); body.sql_min_score = Number(body.sql_min_score); body.auto_move = values.has('auto_move'); try { await api('/api/qualification/config', { method: 'PUT', body }); toast('Regras atualizadas', 'Todos os contatos foram reclassificados.'); await renderQualification(); } catch (error) { toast('Não foi possível salvar', error.message, 'error'); } });
  document.querySelector('#recalculate-qualification').addEventListener('click', async () => { await api('/api/qualification/recalculate', { method: 'POST' }); toast('Qualificação atualizada', 'Lead, MQL e SQL foram recalculados.'); await renderQualification(); });
  document.querySelector('#pipeline-automation-form').addEventListener('submit',async event=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));body.trigger_stage_id=Number(body.trigger_stage_id);body.target_stage_id=body.target_stage_id?Number(body.target_stage_id):null;body.target_pipeline_id=state.allPipelineStages.find(item=>item.id===body.target_stage_id)?.pipeline_id||null;try{await api('/api/pipeline-automations',{method:'POST',body});toast('Automação criada','Ela será executada nas próximas movimentações, inclusive entre funis.');await renderQualification();}catch(error){toast('Não foi possível criar',error.message,'error');}});
  document.querySelectorAll('[data-delete-automation]').forEach(button=>button.addEventListener('click',async()=>{await api(`/api/pipeline-automations/${button.dataset.deleteAutomation}`,{method:'DELETE'});await renderQualification();}));
}

async function renderAgent() {
  setLoading('#view-agent');
  [state.agentConfig,state.agentCommandSessions,state.agentLearning]=await Promise.all([api('/api/agent/config'),api('/api/agent/command/sessions'),api('/api/agent/learning')]);
  const config = state.agentConfig;
  const modelStatus=config.model_status||{configured:false,provider:'Motor local',model:null};
  if(state.agentCommandSessionId&&!state.agentCommandSessions.some(item=>Number(item.id)===Number(state.agentCommandSessionId)))state.agentCommandSessionId=null;
  state.agentCommandSessionId=state.agentCommandSessionId||state.agentCommandSessions[0]?.id||null;
  const session=state.agentCommandSessionId?await api(`/api/agent/command/sessions/${state.agentCommandSessionId}`):null;
  document.querySelector('#agent-nav-name').textContent=`Agente ${config.name}`; document.querySelector('#page-title').textContent=`Agente ${config.name}`;
  const actionsByMessage=new Map();for(const action of session?.actions||[]){const list=actionsByMessage.get(Number(action.message_id))||[];list.push(action);actionsByMessage.set(Number(action.message_id),list);}
  const latestModel=[...(session?.messages||[])].reverse().map(message=>message.metadata?.model).find(Boolean)||null;
  const modelMessage=latestModel?.error?'Modelo indisponível · contingência local ativa':latestModel?.live?`Modelo real ativo · ${latestModel.provider} · ${latestModel.model}`:modelStatus.configured?`Modelo pronto · ${modelStatus.provider} · ${modelStatus.model}`:'Motor local de contingência';
  const modelHealthy=!latestModel?.error;
  const messages=(session?.messages||[]).map(message=>{const model=message.metadata?.model;const questions=Array.isArray(message.metadata?.questions)?message.metadata.questions:[];return `<article class="agent-command-message ${message.role}"><span class="agent-command-avatar">${message.role==='assistant'?icon('spark'):initials(state.user?.name)}</span><div><header><strong>${message.role==='assistant'?escapeHtml(config.name):escapeHtml(state.user?.name||'Você')}</strong><time>${relativeTime(message.created_at)}</time></header><p>${escapeHtml(message.content)}</p>${message.role==='assistant'&&model?`<small class="agent-message-model ${model.error?'error':''}">${model.error?`${icon('info')} Resposta local: o modelo real não respondeu.`:`${icon('spark')} ${escapeHtml(model.provider)} · ${escapeHtml(model.model||'modelo real')}`}</small>`:''}${questions.length?`<div class="agent-followup-questions">${questions.map(question=>`<button type="button" data-agent-suggestion="${escapeHtml(question)}">${escapeHtml(question)}</button>`).join('')}</div>`:''}${(actionsByMessage.get(Number(message.id))||[]).map(agentCommandActionCard).join('')}</div></article>`;}).join('');
  document.querySelector('#view-agent').innerHTML=`<div class="agent-command-shell">
    <aside class="agent-session-sidebar"><button class="primary-button" id="new-agent-session">${icon('plus')} Nova sessão</button><div class="agent-session-label"><span>Sessões</span><small>${state.agentCommandSessions.length}</small></div><nav>${state.agentCommandSessions.map(item=>`<button data-agent-session="${item.id}" class="${Number(item.id)===Number(state.agentCommandSessionId)?'active':''}"><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.last_message||'Sessão pronta para começar')}</small></span>${item.pending_actions?`<b>${item.pending_actions}</b>`:''}</button>`).join('')||'<p class="agent-session-empty">Crie uma sessão para começar o laboratório.</p>'}</nav><details class="agent-control-panel"><summary>${icon('settings')} Configuração do WhatsApp</summary><form id="agent-form"><label>Nome<input name="name" value="${escapeHtml(config.name)}"></label><label>Tom de voz<textarea name="tone" rows="2">${escapeHtml(config.tone)}</textarea></label><label>Objetivo<textarea name="objective" rows="3">${escapeHtml(config.objective)}</textarea></label><label>Autonomia<select name="autonomy_level">${[0,1,2,3].map(level=>`<option value="${level}" ${Number(config.autonomy_level)===level?'selected':''}>${autonomyLabel(level)}</option>`).join('')}</select></label><label>Confiança mínima<input name="confidence_threshold" type="number" min="0" max="1" step="0.01" value="${config.confidence_threshold}"></label><label><input type="checkbox" name="followup_enabled" ${config.followup_rules?.enabled?'checked':''}> Acompanhamento automático</label><label>Modelo aprovado para retomada<select name="followup_template_id"><option value="">Criar apenas tarefa para a equipe</option>${(config.followup_templates||[]).map(item=>`<option value="${item.id}" ${item.id===config.followup_rules?.template_id?'selected':''}>${escapeHtml(item.display_name)}</option>`).join('')}</select></label><label>Retomar após quantas horas<input name="followup_delays" value="${escapeHtml((config.followup_rules?.delays_hours||[24,72]).join(', '))}" placeholder="24, 72"></label><label>Máximo de tentativas<input name="followup_max_attempts" type="number" min="0" max="5" value="${config.followup_rules?.max_attempts??2}"></label><label>Início do atendimento<input name="business_start" type="time" value="${escapeHtml(config.business_hours?.start||'09:00')}"></label><label>Fim do atendimento<input name="business_end" type="time" value="${escapeHtml(config.business_hours?.end||'18:00')}"></label><button class="primary-button">Salvar configuração</button></form></details></aside>
    <section class="agent-command-chat"><header><div><span class="agent-command-orb">${icon('spark')}</span><div><strong>${escapeHtml(session?.title||'Laboratório do agente')}</strong><small>${escapeHtml(modelMessage)}</small></div></div><span class="agent-live ${modelHealthy?'':'warning'}"><i></i>${modelHealthy?'Agente disponível':'Usando contingência'}</span></header><div class="agent-command-messages" id="agent-command-messages">${messages||`<div class="agent-command-welcome"><span>${icon('spark')}</span><h2>Olá, ${escapeHtml((state.user?.name||'').split(' ')[0]||'Daniel')}</h2><p>Use este chat para testar o atendimento, ensinar regras e comandar alterações no agente do WhatsApp.</p><div><button data-agent-suggestion="Sempre termine respostas comerciais com uma pergunta que avance a conversa.">Ensinar uma regra</button><button data-agent-suggestion="Quero mudar o tom de voz para consultivo, humano e objetivo.">Ajustar o tom</button><button data-agent-suggestion="Adicione ao conhecimento as informações que vou enviar a seguir.">Adicionar conhecimento</button><button data-agent-suggestion="Crie uma tarefa para revisar o playbook amanhã às 10h.">Criar tarefa</button></div></div>`}</div><form class="agent-command-composer" id="agent-command-form"><textarea name="content" rows="1" placeholder="Dê um comando, teste uma resposta ou peça uma alteração…" required></textarea><div><span>${icon('info')} Alterações sensíveis pedem sua confirmação</span><button class="agent-command-send" aria-label="Enviar">${icon('arrow')}</button></div></form></section>
    <aside class="agent-command-context"><div><p class="overline">Agente do WhatsApp</p><h3>${escapeHtml(config.name)}</h3><span class="agent-command-status"><i></i>${autonomyLabel(config.autonomy_level)}</span></div><dl><dt>Objetivo</dt><dd>${escapeHtml(config.objective)}</dd><dt>Tom</dt><dd>${escapeHtml(config.tone)}</dd><dt>WhatsApp</dt><dd>${config.whatsapp_status?.simulated?'Simulação de desenvolvimento':config.whatsapp_status?.configured?'Número configurado':'Conecte um número para enviar'}</dd><dt>Acompanhamentos</dt><dd>${config.automation_status?.healthy?'Executor ativo':'Executor sem confirmação recente'}</dd><dt>Última execução</dt><dd>${config.automation_status?.last_run_at?new Date(config.automation_status.last_run_at).toLocaleString('pt-BR'):'Ainda não executado'}</dd><dt>Playbook vivo</dt><dd>${state.agentLearning.filter(item=>item.status==='approved').length} comandos ativos</dd></dl><button class="ghost-button" data-view-link="knowledge">Abrir conhecimento →</button><p class="agent-command-note">As propostas aplicadas aqui passam a orientar o mesmo agente que responde aos contatos no WhatsApp.</p></aside>
  </div>`;
  bindViewLinks();bindAgentCommand();
}

function agentCommandActionCard(action){const labels={update_agent_config:'Comportamento',add_learning_rule:'Playbook vivo',add_knowledge:'Conhecimento',create_task:'Tarefa'};const details=Object.entries(action.arguments||{}).map(([key,value])=>`${key.replaceAll('_',' ')}: ${value}`).join(' · ');return `<section class="agent-action-card ${action.status}"><header><span>${icon(action.action_type==='create_task'?'calendar':action.action_type==='add_knowledge'?'book':'sliders')} ${labels[action.action_type]||'Ação proposta'}</span><em>${action.status==='pending'?'Aguardando confirmação':action.status==='applied'?'Aplicada':'Recusada'}</em></header><strong>${escapeHtml(action.label)}</strong><p>${escapeHtml(details)}</p>${action.status==='pending'?`<footer><button class="ghost-button" data-agent-action-reject="${action.id}">Descartar</button><button class="primary-button" data-agent-action-apply="${action.id}">Aplicar alteração</button></footer>`:''}</section>`;}

function bindAgentCommand(){
  const failures=state.agentConfig.automation_status?.failures||[];
  if(failures.length)document.querySelector('.agent-command-context').insertAdjacentHTML('beforeend',`<section aria-label="Falhas na automação"><h4>Precisam de revisão</h4>${failures.map(item=>`<details><summary>${escapeHtml(item.name)} · falha</summary><p>${escapeHtml(item.error||'Confira o histórico antes de tentar novamente.')}</p>${['admin','manager'].includes(state.user.role)?`<button class="ghost-button" data-retry-automation="${item.kind}/${item.id}">Revisar e tentar novamente</button>`:''}</details>`).join('')}</section>`);
  document.querySelectorAll('[data-retry-automation]').forEach(button=>button.onclick=async()=>{
    if(!confirm('Confira no WhatsApp se a mensagem já foi enviada. Se já houve envio, cancele esta ação. Você verificou e deseja autorizar uma nova tentativa?'))return;
    try{await api(`/api/automations/${button.dataset.retryAutomation}/retry`,{method:'POST',body:{reviewed_delivery:true}});toast('Nova tentativa autorizada','O executor processará a mensagem.');await renderAgent();}
    catch(error){toast('Não foi possível tentar novamente',error.message,'error');}
  });
  document.querySelector('#new-agent-session')?.addEventListener('click',async()=>{const session=await api('/api/agent/command/sessions',{method:'POST',body:{}});state.agentCommandSessionId=session.id;await renderAgent();});
  document.querySelectorAll('[data-agent-session]').forEach(button=>button.addEventListener('click',()=>{state.agentCommandSessionId=Number(button.dataset.agentSession);renderAgent();}));
  document.querySelectorAll('[data-agent-suggestion]').forEach(button=>button.addEventListener('click',()=>{const textarea=document.querySelector('#agent-command-form textarea');textarea.value=button.dataset.agentSuggestion;textarea.focus();}));
  document.querySelector('#agent-command-form')?.addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button');const content=form.elements.content.value.trim();if(!content)return;button.disabled=true;try{if(!state.agentCommandSessionId){const session=await api('/api/agent/command/sessions',{method:'POST',body:{}});state.agentCommandSessionId=session.id;}await api(`/api/agent/command/sessions/${state.agentCommandSessionId}/messages`,{method:'POST',body:{content}});await renderAgent();requestAnimationFrame(()=>{const host=document.querySelector('#agent-command-messages');if(host)host.scrollTop=host.scrollHeight;});}catch(error){toast('Não foi possível enviar',error.message,'error');button.disabled=false;}});
  document.querySelectorAll('[data-agent-action-apply]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await api(`/api/agent/command/actions/${button.dataset.agentActionApply}/apply`,{method:'POST',body:{}});toast('Alteração aplicada','O agente do WhatsApp já recebeu esta atualização.');await renderAgent();}catch(error){toast('Não foi possível aplicar',error.message,'error');button.disabled=false;}}));
  document.querySelectorAll('[data-agent-action-reject]').forEach(button=>button.addEventListener('click',async()=>{await api(`/api/agent/command/actions/${button.dataset.agentActionReject}/reject`,{method:'POST',body:{}});await renderAgent();}));
  document.querySelector('#agent-form')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget;const data=Object.fromEntries(new FormData(form));
    data.autonomy_level=Number(data.autonomy_level);data.confidence_threshold=Number(data.confidence_threshold);
    data.followup_rules={enabled:form.elements.followup_enabled.checked,delays_hours:data.followup_delays.split(',').map(value=>Number(value.trim())),max_attempts:Number(data.followup_max_attempts),template_id:Number(data.followup_template_id)||null};
    data.business_hours={...state.agentConfig.business_hours,start:data.business_start,end:data.business_end};
    try{await api('/api/agent/config',{method:'PUT',body:data});toast('Configuração salva','O agente do WhatsApp usará esta configuração.');await renderAgent();}
    catch(error){toast('Não foi possível salvar',error.message,'error');}
  });
}

function autonomyLabel(level) { return ['Desativado', 'Copiloto', 'Autonomia segura', 'Autonomia elevada'][Number(level)] || 'Autonomia segura'; }
function runItem(run) { return `<article class="run-item"><div class="run-top"><span class="run-status ${run.status}"></span><strong>${escapeHtml(run.contact_name)}</strong><span class="status-badge">${escapeHtml(run.intent || 'análise')}</span><time>${relativeTime(run.created_at)}</time></div><p>${escapeHtml(run.reasoning_summary || 'Processamento concluído.')}</p><div class="run-tools">${run.tools || 0} ferramentas · ${escapeHtml(run.tool_names || 'nenhuma ação')}</div></article>`; }
function learningRuleItem(rule){return `<article class="learning-rule ${rule.status}"><div><span>${escapeHtml(rule.applies_to)}</span><em>${rule.status==='approved'?'Ativa':rule.status==='proposed'?'Aguardando aprovação':'Rejeitada'}</em></div><strong>${escapeHtml(rule.instruction)}</strong>${rule.corrected_response?`<p>Exemplo: ${escapeHtml(rule.corrected_response)}</p>`:''}<footer><small>${escapeHtml(({conversation:'Correção em conversa',preview:'Teste no laboratório',manual:'Instrução manual'})[rule.source_type]||rule.source_type)} · ${relativeTime(rule.updated_at)}</small><button type="button" data-delete-learning="${rule.id}" title="Remover instrução">${icon('trash')}</button></footer></article>`;}

function bindAgentForm() {
  const form = document.querySelector('#agent-form'); const range = form.elements.autonomy_level;
  const fields=document.querySelector('#agent-fields'); const edit=document.querySelector('#edit-agent-config'); const save=document.querySelector('.agent-save'); edit.addEventListener('click',()=>{const editing=fields.disabled;fields.disabled=!editing;save.hidden=!editing;edit.textContent=editing?'Cancelar':'Editar';});
  range.addEventListener('input', () => { document.querySelector('#autonomy-label').textContent = autonomyLabel(range.value); document.querySelectorAll('.autonomy-step').forEach((step, i) => step.classList.toggle('active', i <= Number(range.value))); });
  form.addEventListener('submit', async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); data.autonomy_level = Number(data.autonomy_level); await api('/api/agent/config', { method: 'PUT', body: data }); document.querySelector('#agent-nav-name').textContent=`Agente ${data.name}`; document.querySelector('#page-title').textContent=`Agente ${data.name}`; fields.disabled=true;save.hidden=true;edit.textContent='Editar';toast('Configuração guardada', `${data.name} usará estas regras nas próximas conversas.`); });
}

function bindAgentLearning(){
  let lastPreview=null;const previewForm=document.querySelector('#agent-preview-form');const feedbackForm=document.querySelector('#preview-learning-form');const result=document.querySelector('#agent-preview-result');
  document.querySelector('#generate-test-question').addEventListener('click',()=>{const samples=['O valor ficou acima do que eu esperava. Por que vale a pena?','Preciso pensar e falar com meu sócio antes de decidir.','Já uso outra solução. O que vocês fazem de diferente?','Quero entender como funciona o acompanhamento depois da contratação.'];previewForm.elements.question.value=samples[Math.floor(Math.random()*samples.length)];previewForm.elements.question.focus();});
  previewForm.addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('[type=submit]');button.disabled=true;try{lastPreview=await api('/api/agent/preview',{method:'POST',body:{question:event.currentTarget.elements.question.value}});document.querySelector('#agent-preview-response').textContent=lastPreview.response;const generation=lastPreview.generation||{};const modelLabel=generation.live?`${generation.provider} · ${generation.model}`:'Motor local de contingência';const ruleLabel=lastPreview.applied_rules.length?`Regras realmente aplicadas: ${lastPreview.applied_rules.map(rule=>rule.instruction).join(' · ')}`:'Nenhuma regra evolutiva foi aplicada nesta resposta';document.querySelector('#agent-preview-sources').textContent=`${modelLabel} · Intenção: ${lastPreview.intent.replaceAll('_',' ')} · ${ruleLabel}`;result.hidden=false;feedbackForm.hidden=true;}catch(error){toast('Não foi possível testar',error.message,'error');}finally{button.disabled=false;}});
  document.querySelector('#improve-preview').addEventListener('click',()=>{feedbackForm.hidden=false;feedbackForm.elements.instruction.focus();});
  feedbackForm.addEventListener('submit',async event=>{event.preventDefault();if(!lastPreview)return;const button=event.currentTarget.querySelector('[type=submit]');button.disabled=true;try{const data=Object.fromEntries(new FormData(event.currentTarget));await api('/api/agent/learning',{method:'POST',body:{...data,source_type:'preview',example_question:previewForm.elements.question.value,original_response:lastPreview.response,approve:true}});toast('Agente atualizado','A instrução já vale para os próximos testes e conversas.');await renderAgent();}catch(error){toast('Não foi possível aplicar',error.message,'error');button.disabled=false;}});
  document.querySelector('#manual-learning-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;try{await api('/api/agent/learning',{method:'POST',body:{...Object.fromEntries(new FormData(event.currentTarget)),source_type:'manual',approve:true}});toast('Instrução adicionada','O playbook vivo foi atualizado.');await renderAgent();}catch(error){toast('Não foi possível adicionar',error.message,'error');button.disabled=false;}});
  document.querySelectorAll('[data-delete-learning]').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('Remover esta instrução do agente?'))return;await api(`/api/agent/learning/${button.dataset.deleteLearning}`,{method:'DELETE'});toast('Instrução removida','O agente deixou de aplicar esta orientação.');await renderAgent();}));
}

async function renderKnowledge() {
  const host=document.querySelector('#view-knowledge'); setLoading('#view-knowledge');
  try{state.knowledge=await api('/api/knowledge');}catch(error){host.innerHTML=`<div class="section-head"><div><h2>Conhecimento</h2><p>Playbooks e informações usadas pelo agente.</p></div></div><div class="knowledge-load-error">${icon('info')}<div><h3>Não foi possível carregar o conhecimento</h3><p>${escapeHtml(error.message)}</p><button class="primary-button" id="retry-knowledge">Tentar novamente</button></div></div>`;host.querySelector('#retry-knowledge').addEventListener('click',renderKnowledge);return;}
  const agentName=state.agentConfig?.name||'Atenva';
  const activeDocuments=state.knowledge.filter(doc=>doc.status==='active');
  host.innerHTML = `<div class="section-head"><div><h2>Conhecimento do ${escapeHtml(agentName)}</h2><p>O agente prioriza fontes oficiais e sinaliza conteúdos conflitantes antes de responder.</p></div><button class="primary-button" data-add-knowledge>${icon('plus')} Adicionar fonte</button></div>${activeDocuments.length?`<div class="knowledge-grid">${activeDocuments.map(doc => `<article class="knowledge-card ${doc.conflict_count?'has-conflict':''}"><header><span class="doc-icon">${icon('book')}</span><span class="knowledge-actions"><button data-edit-doc="${doc.id}" title="Editar">${icon('settings')}</button><button data-archive-doc="${doc.id}" title="Arquivar">${icon('trash')}</button></span></header><div><span class="status-badge">${escapeHtml(doc.category)}</span>${doc.is_authoritative?'<span class="source-badge official">Fonte oficial</span>':''}${doc.conflict_count?`<span class="source-badge conflict">${doc.conflict_count} conflito(s)</span>`:''}</div><h3>${escapeHtml(doc.title)}</h3><p>${escapeHtml(doc.content)}</p><div class="knowledge-footer"><span>Prioridade ${doc.priority} · versão ${doc.version}</span><span>Atualizado ${relativeTime(doc.updated_at)}</span></div></article>`).join('')}</div>`:`<div class="knowledge-empty">${icon('book')}<h3>Comece pelo playbook da empresa</h3><p>Adicione orientações comerciais, serviços, objeções, preços e regras. O ${escapeHtml(agentName)} usará esse conteúdo nas conversas e qualificações.</p><button class="primary-button" data-add-knowledge>${icon('plus')} Adicionar primeiro conhecimento</button></div>`}`;
  host.querySelectorAll('[data-add-knowledge]').forEach(button=>button.addEventListener('click', () => { const form=document.querySelector('#knowledge-form');form.reset();form.elements.id.value='';document.querySelector('#knowledge-modal-title').textContent='Novo conhecimento';openModal('knowledge-modal'); }));
  document.querySelectorAll('[data-edit-doc]').forEach(button=>button.addEventListener('click',()=>{const doc=state.knowledge.find(item=>item.id===Number(button.dataset.editDoc));const form=document.querySelector('#knowledge-form');form.elements.id.value=doc.id;form.elements.title.value=doc.title;form.elements.category.value=doc.category;form.elements.content.value=doc.content;form.elements.priority.value=doc.priority||50;form.elements.is_authoritative.checked=Boolean(doc.is_authoritative);document.querySelector('#knowledge-modal-title').textContent='Editar conhecimento';openModal('knowledge-modal');}));
  document.querySelectorAll('[data-archive-doc]').forEach(button => button.addEventListener('click', async () => { await api(`/api/knowledge/${button.dataset.archiveDoc}`, { method: 'DELETE' }); toast('Fonte arquivada', `${agentLabel()} deixou de usar este conteúdo.`); await renderKnowledge(); }));
}

async function renderAdministration() {
  const canManage = state.user?.isMaster || state.user?.role === 'admin' || ['owner', 'admin'].includes(state.user?.companyRole);
  if (!canManage) throw new Error('Somente administradores podem acessar esta área.');
  [state.users, state.companies, state.invitations] = await Promise.all([api('/api/users'), api('/api/companies'), api('/api/invitations')]);
  const isMaster = Boolean(state.user?.isMaster);
  const roleLabels = { master: 'Onboarding Manager', owner: 'Proprietário', admin: 'Administrador', manager: 'Gestor', agent: 'Atendente' };
  const statusLabel = invitation => invitation.revoked_at ? 'Revogado' : invitation.accepted_at ? 'Aceito' : new Date(invitation.expires_at) < new Date() ? 'Expirado' : 'Pendente';
  const companyOptions = state.companies.map(company => `<option value="${company.id}" ${Number(company.id) === Number(state.user?.companyId) ? 'selected' : ''}>${escapeHtml(company.name)}</option>`).join('');
  const directAccessPanel = isMaster ? `<details class="admin-section" id="admin-direct-access"><summary><span class="admin-section-icon">${icon('user-plus')}</span><span><strong>Criar acesso direto</strong><small>Ative um administrador com senha provisória</small></span>${icon('chevron')}</summary><div class="admin-section-body">
    <form class="config-form" id="admin-direct-form">
      <label>Nome<input name="name" required maxlength="120" autocomplete="off" /></label>
      <label>E-mail<input name="email" type="email" required autocomplete="off" /></label>
      <label>Senha provisória<input name="password" type="password" required minlength="10" autocomplete="new-password" /></label>
      <label>Permissão<select name="role"><option value="master">Onboarding Manager Atenva</option><option value="admin" selected>Administrador</option><option value="manager">Gestor</option><option value="agent">Atendente</option></select></label>
      <label>Empresa<select name="company_id">${companyOptions}</select></label>
      <label>Segundo nome (opcional)<input name="name_2" maxlength="120" autocomplete="off" /></label>
      <label>Segundo e-mail (opcional)<input name="email_2" type="email" autocomplete="off" /></label>
      <label>Segunda senha provisória<input name="password_2" type="password" minlength="10" autocomplete="new-password" /></label>
      <label class="full"><input name="replace_existing" type="checkbox" /> Redefinir acessos existentes informados acima</label>
      <div class="full admin-form-actions"><button class="primary-button" type="submit">${icon('plus')} Criar e ativar acesso</button></div>
    </form>
  </div></details>` : '';
  const planLabels = { starter:'Inicial', business:'Profissional', scale:'Escala' };
  const tenantPanel = isMaster ? `<details class="admin-section client-provision-panel" id="admin-clients"><summary><span class="admin-section-icon">${icon('building')}</span><span><strong>Clientes e ambientes</strong><small>Cadastre um cliente ou gerencie plano, usuários e status</small></span><span class="stage-badge">${state.companies.length} clientes</span>${icon('chevron')}</summary><div class="admin-section-body"><div class="admin-section-heading"><h3>Novo cliente</h3><p>Crie o ambiente isolado e o primeiro acesso administrativo em uma única etapa.</p></div>
    <form class="config-form client-provision-form" id="client-provision-form">
      <label>Empresa<input name="name" required maxlength="120" placeholder="Ex.: Clínica Horizonte" /></label>
      <label>Administrador<input name="admin_name" required maxlength="120" placeholder="Nome da pessoa responsável" /></label>
      <label class="full">E-mail de acesso<input name="admin_email" type="email" required autocomplete="off" placeholder="admin@cliente.com" /></label>
      <label>Plano<select name="plan"><option value="starter">Inicial · 3 usuários</option><option value="business" selected>Profissional · 10 usuários</option><option value="scale">Escala · 30 usuários</option></select></label>
      <label>Início<select name="status"><option value="trial" selected>Teste por 14 dias</option><option value="active">Ativar agora</option></select></label>
      <label>Limite de usuários<input name="max_users" type="number" min="1" max="500" value="10" required /></label>
      <div class="admin-scope-note">${icon('spark')} O ambiente nasce com funis, agente, regras e integrações separados dos outros clientes.</div>
      <div class="full admin-form-actions"><button class="primary-button" type="submit">${icon('plus')} Criar cliente e acesso</button></div>
    </form>
    <div class="invite-result client-provision-result" id="client-provision-result" hidden><strong>Cliente pronto para entrar</strong><span id="client-provision-summary"></span><label>Link do ambiente<div><input id="client-access-link" readonly /><button type="button" class="ghost-button" data-copy-client="access">Copiar</button></div></label><label>Convite do administrador<div><input id="client-invite-link" readonly /><button type="button" class="ghost-button" data-copy-client="invite">Copiar</button></div></label><small>O administrador define a própria senha e depois pode criar os acessos da equipe em Administração → Convites.</small></div>
    <div class="admin-table-wrap client-table"><table class="data-table"><thead><tr><th>Cliente</th><th>Plano</th><th>Usuários</th><th>Status</th><th>Acesso</th></tr></thead><tbody>${state.companies.map(company=>`<tr><td><strong>${escapeHtml(company.name)}</strong><small class="table-subtitle">${escapeHtml(company.slug)}</small></td><td><select data-client-plan="${company.id}"><option value="starter" ${company.plan==='starter'?'selected':''}>Inicial</option><option value="business" ${company.plan==='business'||!company.plan?'selected':''}>Profissional</option><option value="scale" ${company.plan==='scale'?'selected':''}>Escala</option></select></td><td>${Number(company.member_count||0)} / ${Number(company.max_users||10)}</td><td><select data-client-status="${company.id}"><option value="trial" ${company.status==='trial'?'selected':''}>Teste</option><option value="active" ${company.status==='active'?'selected':''}>Ativo</option><option value="suspended" ${company.status==='suspended'?'selected':''}>Suspenso</option><option value="cancelled" ${company.status==='cancelled'?'selected':''}>Cancelado</option></select></td><td><button class="table-action" data-copy-url="${escapeHtml(company.access_url||`${location.origin}/${company.slug}`)}">Copiar link</button></td></tr>`).join('')}</tbody></table></div></div></details>` : '';
  document.querySelector('#view-administration').innerHTML = `<div class="section-head"><div><h2>${isMaster ? 'Central de clientes Atenva' : 'Equipe da empresa'}</h2><p>${isMaster ? 'Escolha uma área para cadastrar clientes, convidar pessoas ou revisar acessos.' : 'Escolha uma área para gerenciar a equipe desta empresa.'}</p></div><span class="stage-badge">${state.users.length} usuários</span></div>
    <div class="admin-quick-grid"><button type="button" data-open-admin="admin-users">${icon('users')}<span><strong>Usuários</strong><small>${state.users.length} acessos ativos</small></span></button><button type="button" data-open-admin="admin-invites">${icon('send')}<span><strong>Convites</strong><small>${state.invitations.length} registros</small></span></button>${isMaster?`<button type="button" data-open-admin="admin-clients">${icon('building')}<span><strong>Clientes</strong><small>${state.companies.length} ambientes</small></span></button>`:''}<button type="button" id="admin-text-size">${icon('text')}<span><strong>Tamanho do texto</strong><small>Ajustar leitura do sistema</small></span></button></div>
    ${tenantPanel}
    <div class="admin-access-grid">
      ${directAccessPanel}
      <details class="admin-section" id="admin-invites"><summary><span class="admin-section-icon">${icon('send')}</span><span><strong>Convidar novo usuário</strong><small>Crie um link individual válido por 7 dias</small></span>${icon('chevron')}</summary><div class="admin-section-body">
        <form class="config-form" id="admin-invite-form">
          <label class="full">E-mail da pessoa<input name="email" type="email" autocomplete="off" placeholder="nome@empresa.com" required /></label>
          <label>Permissão<select name="role">${isMaster ? '<option value="master">Onboarding Manager Atenva</option>' : ''}<option value="admin">Administrador</option><option value="manager">Gestor</option><option value="agent">Atendente</option></select></label>
          ${isMaster ? `<label>Empresa<select name="company_id">${companyOptions}</select></label>` : ''}
          <div class="admin-scope-note full">${isMaster ? `${icon('spark')} Onboarding Managers podem criar e acessar todas as empresas da Atenva.` : `${icon('users')} O convite ficará limitado a <strong>${escapeHtml(state.user.companyName || 'sua empresa')}</strong>.`}</div>
          <div class="full admin-form-actions"><button class="primary-button" type="submit">${icon('send')} Gerar convite seguro</button></div>
        </form>
        <div class="invite-result" id="invite-result" hidden><strong>Convite pronto</strong><span>Copie e envie este link para a pessoa:</span><div><input id="invite-link" readonly /><button type="button" class="ghost-button" id="copy-invite">Copiar link</button></div></div>
      </div></details>
      <details class="admin-section" id="admin-users"><summary><span class="admin-section-icon">${icon('users')}</span><span><strong>Acessos ativos</strong><small>${isMaster ? 'Onboarding Managers administram todas as empresas' : 'Acessos vinculados à sua empresa'}</small></span><span class="stage-badge">${state.users.length}</span>${icon('chevron')}</summary><div class="admin-section-body"><div class="admin-table-wrap"><table class="data-table"><thead><tr><th>Pessoa</th><th>E-mail</th><th>Empresa</th><th>Permissão</th><th>Status</th><th></th></tr></thead><tbody>${state.users.map(user => {const own=Number(user.id)===Number(state.user.id);const role=user.company_role||user.role;return `<tr><td><strong>${escapeHtml(user.name)}</strong></td><td>${escapeHtml(user.email || '—')}</td><td>${escapeHtml(user.company_name || user.companyName || 'Todas as empresas')}</td><td>${user.is_master?`<span class="stage-badge">${roleLabels.master}</span>`:`<select class="admin-role-select" data-user-role="${user.id}" ${own?'disabled':''}><option value="admin" ${role==='admin'||role==='owner'?'selected':''}>Administrador</option><option value="manager" ${role==='manager'?'selected':''}>Gestor</option><option value="agent" ${role==='agent'?'selected':''}>Atendente</option></select>`}</td><td><button class="user-status ${user.is_active?'active':'inactive'}" data-user-status="${user.id}" data-active="${user.is_active?1:0}" ${own?'disabled':''}>${user.is_active?'Ativo':'Inativo'}</button></td><td>${own||user.is_master&&!isMaster?'':`<button class="table-action danger" data-delete-user="${user.id}">Excluir</button>`}</td></tr>`;}).join('')}</tbody></table></div></div></details>
    </div>
    <details class="admin-section admin-invitations-panel"><summary><span class="admin-section-icon">${icon('clock')}</span><span><strong>Histórico de convites</strong><small>Acompanhe ou revogue convites ainda não utilizados</small></span><span class="stage-badge">${state.invitations.length}</span>${icon('chevron')}</summary><div class="admin-section-body"><div class="admin-table-wrap"><table class="data-table"><thead><tr><th>E-mail</th><th>Empresa</th><th>Permissão</th><th>Criado por</th><th>Validade</th><th>Status</th><th></th></tr></thead><tbody>${state.invitations.length ? state.invitations.map(invitation => { const status = statusLabel(invitation); return `<tr><td><strong>${escapeHtml(invitation.email)}</strong></td><td>${escapeHtml(invitation.company_name || 'Todas as empresas')}</td><td>${escapeHtml(roleLabels[invitation.role] || invitation.role)}</td><td>${escapeHtml(invitation.inviter_name || '—')}</td><td>${relativeTime(invitation.expires_at)}</td><td><span class="invitation-status ${status.toLowerCase()}">${status}</span></td><td>${status === 'Pendente' ? `<button class="table-action" data-revoke-invite="${invitation.id}">Revogar</button>` : ''}</td></tr>`; }).join('') : '<tr><td colspan="7" class="empty-table">Nenhum convite criado ainda.</td></tr>'}</tbody></table></div></div></details>`;
  document.querySelectorAll('[data-open-admin]').forEach(button=>button.addEventListener('click',()=>{const section=document.querySelector(`#${button.dataset.openAdmin}`);if(section){section.open=true;section.scrollIntoView({behavior:'smooth',block:'start'});}}));
  document.querySelectorAll('.admin-section').forEach(section=>section.addEventListener('toggle',()=>{if(!section.open)return;document.querySelectorAll('.admin-section').forEach(other=>{if(other!==section)other.open=false;});}));
  document.querySelector('#admin-text-size')?.addEventListener('click',openTextSizeSettings);
  document.querySelector('#admin-direct-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form=event.currentTarget;const button=form.querySelector('[type=submit]');button.disabled=true;
    try{const data=Object.fromEntries(new FormData(form));const users=[{name:data.name,email:data.email,password:data.password,role:data.role,company_id:data.company_id}];if(data.email_2)users.push({name:data.name_2,email:data.email_2,password:data.password_2,role:data.role,company_id:data.company_id});await api('/api/users',{method:'POST',body:{users,replace_existing:data.replace_existing==='on'}});toast(users.length>1?'Acessos criados':'Acesso criado',users.length>1?'Os administradores já podem entrar no Atenva.':'O administrador já pode entrar no Atenva.');await renderAdministration();document.querySelector('#admin-users').open=true;}
    catch(error){toast('Não foi possível criar o acesso',error.message,'error');}
    finally{button.disabled=false;}
  });
  const provisionForm = document.querySelector('#client-provision-form');
  provisionForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const form=event.currentTarget;const button=form.querySelector('[type=submit]');button.disabled=true;
    try {
      const result=await api('/api/clients',{method:'POST',body:Object.fromEntries(new FormData(form))});
      await renderAdministration();
      document.querySelector('#admin-clients').open=true;
      document.querySelector('#client-access-link').value=result.company.access_url;
      document.querySelector('#client-invite-link').value=result.invitation.invite_url;
      document.querySelector('#client-provision-summary').textContent=`${result.company.name} foi criado no plano ${planLabels[result.company.plan]||result.company.plan}.`;
      document.querySelector('#client-provision-result').hidden=false;
      document.querySelectorAll('[data-copy-client]').forEach(copy=>copy.onclick=async()=>{const input=document.querySelector(copy.dataset.copyClient==='access'?'#client-access-link':'#client-invite-link');await navigator.clipboard.writeText(input.value);toast('Link copiado','Pronto para enviar ao cliente.');});
      toast('Cliente criado','O ambiente isolado e o convite do administrador estão prontos.');
    } catch(error){toast('Não foi possível criar o cliente',error.message,'error');}
    finally{button.disabled=false;}
  });
  document.querySelectorAll('[data-copy-url]').forEach(button=>button.addEventListener('click',async()=>{await navigator.clipboard.writeText(button.dataset.copyUrl);toast('Link copiado','Envie este endereço para o cliente acessar.');}));
  document.querySelectorAll('[data-client-plan]').forEach(select=>select.addEventListener('change',async()=>{try{await api(`/api/companies/${select.dataset.clientPlan}`,{method:'PATCH',body:{plan:select.value}});toast('Plano atualizado','A alteração já está valendo.');}catch(error){toast('Não foi possível alterar',error.message,'error');await renderAdministration();}}));
  document.querySelectorAll('[data-client-status]').forEach(select=>select.addEventListener('change',async()=>{try{await api(`/api/companies/${select.dataset.clientStatus}`,{method:'PATCH',body:{status:select.value}});toast('Status atualizado',select.value==='suspended'?'O acesso do cliente foi suspenso.':'A alteração já está valendo.');}catch(error){toast('Não foi possível alterar',error.message,'error');await renderAdministration();}}));
  document.querySelector('#admin-invite-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget; const button = form.querySelector('[type=submit]'); button.disabled = true;
    try {
      const result = await api('/api/invitations', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      const resultBox = document.querySelector('#invite-result'); const linkInput = document.querySelector('#invite-link');
      linkInput.value = result.invite_url; resultBox.hidden = false;
      document.querySelector('#copy-invite').onclick = async () => { await navigator.clipboard.writeText(linkInput.value); toast('Link copiado', 'Agora envie o convite para a pessoa.'); };
      toast(result.email_sent ? 'Convite enviado por e-mail' : 'Convite criado', result.email_sent ? 'A pessoa recebeu um link individual válido por 7 dias.' : 'O provedor de e-mail ainda não está configurado; copie o link para enviar manualmente.');
      state.invitations = await api('/api/invitations');
    } catch (error) { toast('Não foi possível convidar', error.message, 'error'); }
    finally { button.disabled = false; }
  });
  document.querySelectorAll('[data-revoke-invite]').forEach(button => button.addEventListener('click', async () => { await api(`/api/invitations/${button.dataset.revokeInvite}/revoke`, { method: 'POST' }); toast('Convite revogado', 'Este link não poderá mais ser utilizado.'); await renderAdministration(); }));
  document.querySelectorAll('[data-user-role]').forEach(select=>select.addEventListener('change',async()=>{try{await api(`/api/users/${select.dataset.userRole}`,{method:'PATCH',body:{role:select.value}});toast('Permissão atualizada','O novo nível de acesso já está valendo.');}catch(error){toast('Não foi possível alterar',error.message,'error');await renderAdministration();}}));
  document.querySelectorAll('[data-user-status]').forEach(button=>button.addEventListener('click',async()=>{try{await api(`/api/users/${button.dataset.userStatus}`,{method:'PATCH',body:{is_active:button.dataset.active!=='1'}});await renderAdministration();}catch(error){toast('Não foi possível alterar',error.message,'error');}}));
  document.querySelectorAll('[data-delete-user]').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('Remover este acesso? A pessoa precisará ser convidada novamente.'))return;try{await api(`/api/users/${button.dataset.deleteUser}`,{method:'DELETE'});toast('Acesso removido','O usuário não possui mais acesso a esta empresa.');await renderAdministration();}catch(error){toast('Não foi possível excluir',error.message,'error');}}));
}

async function completeTask(id, completed = true) { await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: completed ? 'completed' : 'pending' } }); toast(completed?'Tarefa concluída':'Tarefa reaberta', 'O histórico e o calendário foram atualizados.'); await (state.view==='tasks'?renderTasks():renderOverview()); }

const {renderRelationships}=createRelationshipModule({state,api,escapeHtml,icon,openModal,closeModals,toast,initials,money,relativeTime,setLoading});
const renderers = { overview: renderOverview, inbox: renderInbox, pipeline: renderPipeline, qualification: renderQualification, contacts: renderContacts, relationships:renderRelationships, tasks: renderTasks, campaigns: renderCampaigns, agent: renderAgent, knowledge: renderKnowledge, 'meta-ads': renderMetaAds, meta: renderMeta, administration: renderAdministration };
const titles = { overview: 'Visão geral', inbox: 'Conversas', pipeline: 'Funis', qualification: 'Insights', contacts: 'Contatos', relationships:'Relacionamento', tasks: 'Tarefas', campaigns: 'Disparos', agent: 'Agente Atenva', knowledge: 'Conhecimento', 'meta-ads': 'Meta Ads', meta: 'Integrações', administration: 'Administração' };

let navigationToken = 0;

async function navigate(view, payload) {
  if (!renderers[view]) return;
  const token = ++navigationToken;
  state.view = view;
  document.querySelector('#page-title').textContent = titles[view];
  closeMobileSidebar();
  const target = document.querySelector(`#view-${view}`);
  document.querySelectorAll('.view').forEach(item => item.classList.toggle('active', item === target));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  try {
    await renderers[view](payload);
    if (token !== navigationToken) return;
    bindViewLinks();
  } catch (error) {
    if (token !== navigationToken) return;
    if (!error.sessionExpired) {
      if(target){target.innerHTML=`<div class="view-load-error">${icon('info')}<div><h3>Esta área não pôde ser aberta</h3><p>${escapeHtml(error.message)}</p><button class="primary-button" data-retry-view="${escapeHtml(view)}">Tentar novamente</button></div></div>`;document.querySelectorAll('.view').forEach(item=>item.classList.toggle('active',item===target));document.querySelectorAll('.nav-item').forEach(item=>item.classList.toggle('active',item.dataset.view===view));target.querySelector('[data-retry-view]')?.addEventListener('click',()=>navigate(view,payload));}
      toast('Não foi possível carregar', error.message, 'error');
    }
  } finally {
    target?.classList.remove('is-loading');
  }
}

function bindViewLinks() { document.querySelectorAll('[data-view-link]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.viewLink))); }
document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
document.querySelectorAll('.nav-item').forEach(button=>button.title=button.querySelector('span')?.textContent?.trim()||'');
function applySidebarState(){const shell=document.querySelector('#app-shell');const button=document.querySelector('#sidebar-collapse');if(!shell||!button)return;const collapsed=state.sidebarCollapsed&&window.innerWidth>820;shell.classList.toggle('sidebar-collapsed',collapsed);button.setAttribute('aria-label',collapsed?'Expandir menu lateral':'Recolher menu lateral');button.title=collapsed?'Expandir menu lateral':'Recolher menu lateral';button.setAttribute('aria-expanded',String(!collapsed));}
document.querySelector('#sidebar-collapse').addEventListener('click',()=>{state.sidebarCollapsed=!state.sidebarCollapsed;localStorage.setItem('atenva-sidebar-preference-v2',String(state.sidebarCollapsed));localStorage.setItem('atenva-sidebar-collapsed',String(state.sidebarCollapsed));applySidebarState();});
function closeMobileSidebar(){document.querySelector('#sidebar').classList.remove('open');document.querySelector('#sidebar-scrim').hidden=true;document.body.classList.remove('mobile-menu-open');document.querySelector('#mobile-menu').setAttribute('aria-expanded','false');}
document.querySelector('#mobile-menu').addEventListener('click', event => {const open=!document.querySelector('#sidebar').classList.contains('open');document.querySelector('#sidebar').classList.toggle('open',open);document.querySelector('#sidebar-scrim').hidden=!open;document.body.classList.toggle('mobile-menu-open',open);event.currentTarget.setAttribute('aria-expanded',String(open));});
document.querySelector('#sidebar-scrim').addEventListener('click',closeMobileSidebar);
window.addEventListener('resize',()=>{if(window.innerWidth>820)closeMobileSidebar();applySidebarState();});

let tutorialSteps = [];
let tutorialIndex = 0;
let tutorialTimer = null;

function buildTutorialSteps() {
  const webhook = document.querySelector('.webhook-box code')?.textContent?.trim() || `${location.origin}/api/webhooks/whatsapp`;
  const path = label => `<span class="tutorial-path">${label}</span>`;
  return [
    {
      title: 'Antes de começar: confira o que você precisa',
      text: 'Separe de 15 a 30 minutos e use um computador. Você precisa ser administrador do negócio no Meta Business e ter um número que possa receber SMS ou ligação.',
      details: ['Login pessoal do Facebook com acesso de administrador', 'Empresa criada no Meta Business Portfolio', 'Número de telefone ainda não conectado a outro WhatsApp'],
      tip: 'Se o número já está no WhatsApp comum ou Business, não avance sem planejar a migração: ele pode precisar ser removido do aplicativo atual.',
      visual: '<div class="tutorial-checklist"><b>Checklist inicial</b><i>✓ Acesso de administrador</i><i>✓ Empresa no Meta</i><i>✓ Número disponível</i></div>'
    },
    {
      title: 'Crie o aplicativo da empresa',
      text: 'Abra o Meta for Developers, clique em “Meus apps” e depois em “Criar aplicativo”. Quando a Meta perguntar o caso de uso, escolha uma opção relacionada a empresa/Business e vincule o portfólio empresarial correto.',
      details: ['Dê um nome fácil, como “WhatsApp Atenva”', 'Informe um e-mail de contato válido', 'Confirme o portfólio empresarial da sua empresa'],
      tip: 'Os nomes dos botões podem mudar um pouco conforme a versão do painel da Meta.',
      visual: `<span class="tutorial-logo">f</span><div><b>Criar aplicativo</b>${path('Meus apps → Criar aplicativo → Empresa')}</div>`
    },
    {
      title: 'Adicione o produto WhatsApp',
      text: 'Dentro do painel do aplicativo, localize a seção de produtos. Ao lado de WhatsApp, clique em “Configurar”. Depois abra WhatsApp → Configuração da API no menu lateral.',
      details: ['Selecione a conta empresarial pedida pela Meta', 'Aceite os termos, se forem exibidos', 'Você verá uma tela com token temporário e número de teste'],
      tip: 'O número de teste serve só para validar o fluxo. Para atendimento real, adicione o número da empresa nas próximas etapas.',
      visual: `<span class="tutorial-logo whatsapp">◉</span><div><b>WhatsApp</b>${path('Produtos → WhatsApp → Configurar')}</div>`
    },
    {
      title: 'Adicione o número que atenderá os clientes',
      text: 'Em Configuração da API, procure “Adicionar número de telefone”. Preencha nome de exibição, categoria, fuso horário e o número com DDD. A Meta enviará um código por SMS ou ligação.',
      details: ['Digite o código recebido para confirmar o número', 'Anote o nome de exibição enviado para análise', 'Ative a verificação em duas etapas se a Meta solicitar'],
      tip: 'O nome de exibição deve representar claramente a empresa. A aprovação desse nome é feita pela Meta, não pelo CRM.',
      visual: `<div class="tutorial-form-mock"><b>Adicionar telefone</b><i>Nome da empresa</i><i>+55 (DDD) número</i><span>Receber código</span></div>`
    },
    {
      title: 'Copie os dois IDs corretos',
      text: 'Na tela WhatsApp → Configuração da API, copie “ID do número de telefone” e “ID da conta do WhatsApp Business”. São sequências numéricas diferentes; não copie o número de telefone visível.',
      details: ['ID do número de telefone → campo Phone Number ID no CRM', 'ID da conta do WhatsApp Business → campo Business Account ID', 'Cole apenas números, sem espaços ou aspas'],
      tip: 'Erro comum: usar o App ID no lugar do WABA ID. Confira o rótulo antes de copiar.',
      visual: '<div class="credential-map"><b>Meta</b><i>ID do número</i><i>ID da conta do WhatsApp</i></div><span class="map-arrow">→</span><div class="credential-map"><b>CRM</b><i>Phone Number ID</i><i>Business Account ID</i></div>'
    },
    {
      title: 'Crie um token permanente',
      text: 'Não use o token temporário da tela de testes: ele expira. No Meta Business, abra Configurações do negócio → Usuários → Usuários do sistema, crie um usuário Administrador e atribua a ele o aplicativo e a conta do WhatsApp.',
      details: ['Clique em “Gerar novo token” e selecione seu aplicativo', 'Marque whatsapp_business_messaging e whatsapp_business_management', 'Gere o token e copie-o imediatamente para “Token permanente” no CRM'],
      tip: 'A Meta mostra o token completo uma única vez. Guarde-o em local seguro e nunca envie por chat ou e-mail.',
      visual: `<span class="tutorial-lock">●●●</span><div><b>Token permanente</b>${path('Configurações do negócio → Usuários do sistema')}</div>`
    },
    {
      title: 'Encontre o App Secret',
      text: 'Volte ao painel do aplicativo no Meta for Developers. Abra Configurações do app → Básico, localize “Chave secreta do aplicativo” e clique em “Mostrar”. A Meta pode pedir sua senha novamente.',
      details: ['Copie a chave para o campo App Secret do CRM', 'Não confunda App Secret com App ID', 'O CRM armazena este segredo de forma criptografada'],
      tip: 'Nunca publique o App Secret. Ele será usado para validar que os webhooks recebidos realmente vieram da Meta.',
      visual: `<div class="secret-mock"><b>Chave secreta do aplicativo</b><i>••••••••••••••••</i><span>Mostrar</span></div>`
    },
    {
      title: 'Salve primeiro as credenciais no CRM',
      text: 'Volte à tela Integrações e preencha Token permanente, Phone Number ID, Business Account ID e App Secret. No Token de verificação, invente uma frase difícil de adivinhar e anote-a.',
      details: ['Exemplo de formato: verde-crm-webhook-2026-segredo', 'Mantenha a versão da API sugerida pelo sistema', 'Clique em “Salvar credenciais” antes de configurar o webhook'],
      tip: 'O token de verificação é criado por você. Ele não é o token permanente e não vem da Meta.',
      visual: '<div class="tutorial-form-mock crm"><b>Credenciais no CRM</b><i>Token permanente</i><i>Phone Number ID · WABA ID</i><span>Salvar credenciais</span></div>'
    },
    {
      title: 'Cadastre o webhook na Meta',
      text: 'No aplicativo da Meta, abra WhatsApp → Configuração → Webhooks e clique em “Editar”. Em URL de retorno de chamada, cole exatamente a URL abaixo. Em Verificar token, digite exatamente o token que você criou no CRM.',
      details: [`URL para copiar: ${webhook}`, 'O token diferencia maiúsculas, minúsculas, hífens e espaços', 'Clique em “Verificar e salvar” e aguarde a confirmação da Meta'],
      tip: 'A URL precisa estar pública e começar com https://. Se o link temporário mudar, atualize o webhook na Meta.',
      visual: `<div class="webhook-mock"><b>URL de retorno de chamada</b><i>${escapeHtml(webhook)}</i><span>Verificar e salvar</span></div>`
    },
    {
      title: 'Assine o evento messages',
      text: 'Ainda na área de Webhooks, localize o objeto WhatsApp Business Account. Clique em “Gerenciar” ou “Assinar campos” e ative o campo messages.',
      details: ['Confirme que messages aparece como “Assinado”', 'Não é necessário assinar todos os campos', 'Esse evento traz mensagens recebidas, enviadas, entregues e lidas'],
      tip: 'Sem a assinatura de messages, o teste de credenciais pode funcionar, mas novas conversas não chegarão ao CRM.',
      visual: '<div class="event-mock"><b>Campos de webhook</b><i><span>✓</span> messages</i><i>□ message_template_status_update</i></div>'
    },
    {
      title: 'Teste a conexão e faça uma prova real',
      text: 'No CRM, clique em “Testar conexão”. Depois envie uma mensagem de outro celular para o número conectado. A conversa deve aparecer na aba Conversas; responda por lá para confirmar o envio.',
      details: ['Conexão validada mostra nome e número da conta', 'Mensagem recebida cria ou atualiza o contato sem duplicar', 'Sincronizar agora atualiza as métricas disponíveis'],
      tip: 'Se falhar, confira nesta ordem: token permanente, Phone Number ID, webhook público, token de verificação e assinatura de messages.',
      visual: '<span class="success-orb">✓</span><div><b>Conexão concluída</b><i>Receber → responder → conferir métricas</i></div>'
    }
  ];
}

function renderTutorialStep() {
  const step = tutorialSteps[tutorialIndex];
  document.querySelector('#tutorial-screen').innerHTML = `<div class="tutorial-scene scene-${tutorialIndex}">${step.visual}</div>`;
  document.querySelector('#tutorial-caption').innerHTML = `<div class="tutorial-step-label">ETAPA ${tutorialIndex + 1} DE ${tutorialSteps.length}</div><strong>${step.title}</strong><p>${step.text}</p><ol>${step.details.map(detail => `<li>${escapeHtml(detail)}</li>`).join('')}</ol><aside><b>Dica importante</b>${escapeHtml(step.tip)}</aside>`;
  document.querySelector('#tutorial-time').textContent = `${tutorialIndex + 1} de ${tutorialSteps.length}`;
  document.querySelector('#tutorial-progress').style.width = `${(tutorialIndex + 1) / tutorialSteps.length * 100}%`;
  document.querySelector('#tutorial-prev').disabled = tutorialIndex === 0;
  const next = document.querySelector('#tutorial-next');
  next.disabled = tutorialIndex === tutorialSteps.length - 1;
  next.textContent = tutorialIndex === tutorialSteps.length - 1 ? '✓' : '›';
}

function stopTutorial() { if (tutorialTimer) clearInterval(tutorialTimer); tutorialTimer = null; const play = document.querySelector('#tutorial-play'); if (play) play.textContent = '▶ Continuar'; }
function openMetaTutorial() {
  tutorialSteps = buildTutorialSteps(); tutorialIndex = 0; renderTutorialStep(); openModal('meta-tutorial-modal');
  document.querySelector('#tutorial-prev').onclick = () => { stopTutorial(); tutorialIndex = Math.max(0, tutorialIndex - 1); renderTutorialStep(); };
  document.querySelector('#tutorial-next').onclick = () => { stopTutorial(); tutorialIndex = Math.min(tutorialSteps.length - 1, tutorialIndex + 1); renderTutorialStep(); };
  document.querySelector('#tutorial-play').onclick = event => { if (tutorialTimer) return stopTutorial(); event.currentTarget.textContent = '❚❚ Pausar'; tutorialTimer = setInterval(() => { if (tutorialIndex >= tutorialSteps.length - 1) return stopTutorial(); tutorialIndex += 1; renderTutorialStep(); }, 11000); };
}

let guidedSteps = [];
let guidedIndex = 0;
let guidedCompleted = new Set();

function buildGuidedSteps() {
  const webhook = document.querySelector('.webhook-box code')?.textContent?.trim() || `${location.origin}/api/webhooks/whatsapp`;
  return [
    { title: 'Confirmar seus acessos', text: 'Primeiro, confirme que você consegue administrar a empresa no Meta. Abra as configurações e procure seu nome em Usuários → Pessoas.', route: 'Meta Business → Configurações → Usuários → Pessoas', checks: ['Seu nome aparece na lista', 'A opção “Controle total” está ativa', 'Você sabe qual portfólio empresarial será usado'], warning: 'Se você não tiver controle total, peça acesso ao proprietário antes de continuar.', href: 'https://business.facebook.com/settings/', cta: 'Abrir configurações do negócio' },
    { title: 'Criar ou escolher o aplicativo', text: 'Abra “Meus Apps”. Se já existe um aplicativo exclusivo para o WhatsApp da empresa, selecione-o. Caso contrário, crie um aplicativo empresarial.', route: 'Meta for Developers → Meus Apps → Criar aplicativo', checks: ['Nomeie o aplicativo de forma reconhecível', 'Use um e-mail corporativo', 'Vincule o portfólio empresarial correto'], warning: 'Não use um aplicativo de outra empresa ou cliente.', href: 'https://developers.facebook.com/apps/', cta: 'Abrir Meus Apps' },
    { title: 'Adicionar o produto WhatsApp', text: 'Dentro do aplicativo escolhido, encontre WhatsApp na lista de produtos e clique em Configurar.', route: 'Painel do aplicativo → Adicionar produtos → WhatsApp → Configurar', checks: ['O produto WhatsApp aparece no menu lateral', 'A conta empresarial correta está selecionada', 'A tela “Configuração da API” abre normalmente'], warning: 'Se WhatsApp não aparecer, confirme se o aplicativo foi criado para uso empresarial.', href: 'https://developers.facebook.com/apps/', cta: 'Voltar aos aplicativos da Meta' },
    { title: 'Cadastrar o número da empresa', text: 'Na Configuração da API, adicione o número que será usado no atendimento e confirme o código recebido por SMS ou ligação.', route: 'WhatsApp → Configuração da API → Adicionar número de telefone', checks: ['Preencha o nome de exibição da empresa', 'Informe o número com país e DDD', 'Digite o código de verificação recebido'], warning: 'Um número ainda conectado ao aplicativo WhatsApp pode exigir migração antes de ser usado na Cloud API.', href: 'https://developers.facebook.com/apps/', cta: 'Abrir o painel do aplicativo' },
    { title: 'Copiar os IDs da conta', text: 'Na mesma página, localize os dois identificadores numéricos. Deixe a página aberta: você os colará no CRM em seguida.', route: 'WhatsApp → Configuração da API → Configuração da API', checks: ['Copie o ID do número de telefone', 'Copie o ID da conta do WhatsApp Business', 'Não copie o App ID nem o telefone com DDD'], warning: 'Phone Number ID e Business Account ID são números diferentes.', href: 'https://developers.facebook.com/apps/', cta: 'Localizar os IDs na Meta' },
    { title: 'Gerar o token permanente', text: 'Crie um Usuário do sistema com função Administrador, atribua o aplicativo e a conta do WhatsApp e gere um token para esse aplicativo.', route: 'Configurações do negócio → Usuários → Usuários do sistema', checks: ['Permissão whatsapp_business_messaging marcada', 'Permissão whatsapp_business_management marcada', 'Token copiado e guardado com segurança'], warning: 'Não use o token temporário da Configuração da API: ele expira rapidamente.', href: 'https://business.facebook.com/settings/system-users', cta: 'Abrir Usuários do sistema' },
    { title: 'Copiar o App Secret', text: 'No painel do aplicativo, abra as configurações básicas e mostre a chave secreta. A Meta pode pedir sua senha.', route: 'Configurações do app → Básico → Chave secreta do aplicativo', checks: ['Copie a Chave secreta do aplicativo', 'Não copie o App ID', 'Não compartilhe essa chave com ninguém'], warning: 'O App Secret protege a validação das notificações enviadas pela Meta.', href: 'https://developers.facebook.com/apps/', cta: 'Abrir configurações do aplicativo' },
    { title: 'Preencher e salvar no CRM', text: 'Agora volte ao formulário da Atenva. Cole os quatro dados e crie um token de verificação próprio. Depois clique em Salvar credenciais.', route: 'Atenva → Integrações → Conectar conta da Meta', checks: ['Token permanente preenchido', 'Phone Number ID e Business Account ID preenchidos', 'App Secret e token de verificação preenchidos'], warning: 'O token de verificação é uma frase criada por você; não reutilize o token permanente.', action: 'crm', cta: 'Ir para o formulário do CRM' },
    { title: 'Configurar o webhook', text: 'Volte ao aplicativo da Meta, abra Webhooks e informe a URL e o mesmo token de verificação salvo no CRM.', route: 'WhatsApp → Configuração → Webhooks → Editar', checks: [`Cole esta URL: ${webhook}`, 'Digite exatamente o token de verificação criado por você', 'Clique em Verificar e salvar'], warning: 'A URL pública pode mudar enquanto o projeto usa um link temporário. Se mudar, atualize-a na Meta.', href: 'https://developers.facebook.com/apps/', cta: 'Abrir a Meta para cadastrar', copyValue: webhook },
    { title: 'Assinar o campo messages', text: 'Na configuração de Webhooks, gerencie os campos da WhatsApp Business Account e assine messages.', route: 'Webhooks → WhatsApp Business Account → Gerenciar', checks: ['O campo messages está marcado', 'O status aparece como Assinado', 'As alterações foram salvas'], warning: 'Sem essa assinatura, as mensagens recebidas não aparecem no CRM.', href: 'https://developers.facebook.com/apps/', cta: 'Abrir Webhooks na Meta' },
    { title: 'Testar com uma mensagem real', text: 'Volte ao CRM, teste a conexão e mande uma mensagem de outro celular para o número cadastrado.', route: 'Atenva → Integrações → Testar conexão', checks: ['O CRM mostra “Cloud API conectada”', 'A mensagem apareceu em Conversas', 'Uma resposta enviada pelo CRM chegou ao celular'], warning: 'Se algo falhar, volte à etapa correspondente; seu progresso continuará salvo.', action: 'crm-test', cta: 'Voltar e testar a conexão' }
  ];
}

function saveGuidedProgress() {
  localStorage.setItem('atenva-meta-guided', JSON.stringify({ index: guidedIndex, completed: [...guidedCompleted] }));
}

function renderGuidedStep() {
  const step = guidedSteps[guidedIndex];
  const percent = Math.round(guidedCompleted.size / guidedSteps.length * 100);
  document.querySelector('#guided-percent').textContent = `${percent}%`;
  document.querySelector('#guided-progress').style.width = `${percent}%`;
  document.querySelector('#guided-current').textContent = `ETAPA ${guidedIndex + 1} DE ${guidedSteps.length}`;
  document.querySelector('#guided-step-title').textContent = step.title;
  document.querySelector('#guided-step-text').textContent = step.text;
  document.querySelector('#guided-route').textContent = step.route;
  document.querySelector('#guided-checklist').innerHTML = step.checks.map(item => `<li><i>✓</i><span>${escapeHtml(item)}</span></li>`).join('');
  document.querySelector('#guided-warning').innerHTML = `<b>Atenção</b><span>${escapeHtml(step.warning)}</span>`;
  document.querySelector('#guided-step-list').innerHTML = guidedSteps.map((item, index) => `<button type="button" class="${index === guidedIndex ? 'active' : ''} ${guidedCompleted.has(index) ? 'done' : ''}" data-guided-step="${index}"><i>${guidedCompleted.has(index) ? '✓' : index + 1}</i><span>${escapeHtml(item.title)}</span></button>`).join('');
  const pageAction = document.querySelector('#guided-page-action');
  pageAction.innerHTML = `${step.href ? `<a class="primary-button" href="${step.href}" target="_blank" rel="noopener">${escapeHtml(step.cta)} ↗</a>` : `<button type="button" class="primary-button" data-guided-action="${step.action}">${escapeHtml(step.cta)}</button>`}${step.copyValue ? '<button type="button" class="ghost-button" id="copy-guided-webhook">Copiar URL do webhook</button>' : ''}<small>A página será aberta em outra aba. Deixe este guia aberto para voltar e continuar.</small>`;
  document.querySelector('#guided-prev').disabled = guidedIndex === 0;
  const complete = document.querySelector('#guided-complete');
  complete.textContent = guidedIndex === guidedSteps.length - 1 ? 'Finalizar configuração ✓' : (guidedCompleted.has(guidedIndex) ? 'Etapa concluída →' : 'Concluí esta etapa →');
  document.querySelectorAll('[data-guided-step]').forEach(button => button.onclick = () => { guidedIndex = Number(button.dataset.guidedStep); saveGuidedProgress(); renderGuidedStep(); });
  document.querySelector('.guided-step-list button.active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  document.querySelector('[data-guided-action="crm"]')?.addEventListener('click', () => { closeModals(); document.querySelector('#meta-config-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.querySelector('#meta-config-form input')?.focus(); });
  document.querySelector('[data-guided-action="crm-test"]')?.addEventListener('click', () => { closeModals(); document.querySelector('#test-meta')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.querySelector('#test-meta')?.focus(); });
  document.querySelector('#copy-guided-webhook')?.addEventListener('click', async event => { try { await navigator.clipboard.writeText(step.copyValue); event.currentTarget.textContent = 'URL copiada ✓'; toast('Webhook copiado', 'Agora cole a URL no campo de Webhooks da Meta.'); } catch { toast('Não foi possível copiar', 'Selecione a URL exibida no checklist e copie manualmente.', 'error'); } });
}

function openGuidedSetup() {
  guidedSteps = buildGuidedSteps();
  try { const saved = JSON.parse(localStorage.getItem('atenva-meta-guided') || localStorage.getItem('verde-meta-guided') || '{}'); guidedIndex = Math.min(Number(saved.index) || 0, guidedSteps.length - 1); guidedCompleted = new Set((saved.completed || []).filter(index => Number.isInteger(index) && index >= 0 && index < guidedSteps.length)); } catch { guidedIndex = 0; guidedCompleted = new Set(); }
  renderGuidedStep(); openModal('meta-guided-modal');
  document.querySelector('#guided-prev').onclick = () => { guidedIndex = Math.max(0, guidedIndex - 1); saveGuidedProgress(); renderGuidedStep(); };
  document.querySelector('#guided-complete').onclick = () => { guidedCompleted.add(guidedIndex); if (guidedIndex < guidedSteps.length - 1) guidedIndex += 1; else toast('Guia concluído', 'Agora confirme o recebimento e o envio de uma mensagem real.'); saveGuidedProgress(); renderGuidedStep(); };
}

function openModal(id) { document.querySelector(`#${id}`).hidden = false; document.querySelector(`#${id} input, #${id} textarea`)?.focus(); }
function closeModals() { stopTutorial(); document.querySelectorAll('.modal-backdrop').forEach(modal => { modal.hidden = true; }); }
document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', closeModals));
document.querySelectorAll('.modal-backdrop').forEach(modal => modal.addEventListener('click', event => { if (event.target === modal) closeModals(); }));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModals(); if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.querySelector('#global-search').click(); } });
document.querySelector('#global-search').addEventListener('click', () => { navigate('inbox').then(() => document.querySelector('#conversation-search')?.focus()); });

document.querySelector('#knowledge-form').addEventListener('submit', async event => {
  event.preventDefault(); const form=event.currentTarget; const values=new FormData(form); const file=values.get('playbook'); if(file?.size){ values.set('content',await file.text()); if(!values.get('title'))values.set('title',file.name.replace(/\.[^.]+$/,'')); values.set('category','Playbook'); } const data={id:values.get('id'),title:values.get('title'),category:values.get('category'),content:values.get('content')};
  data.priority=Number(values.get('priority')||50);data.is_authoritative=values.has('is_authoritative');
  try { await api(data.id?`/api/knowledge/${data.id}`:'/api/knowledge', { method: data.id?'PUT':'POST', body: data }); closeModals(); form.reset(); toast('Playbook atualizado', 'O agente e o funil já receberam as novas orientações.'); await renderKnowledge(); }
  catch (error) { toast('Não foi possível adicionar', error.message, 'error'); }
});

document.querySelector('#task-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form));
  data.contact_id = data.contact_id ? Number(data.contact_id) : null; data.conversation_id = data.conversation_id ? Number(data.conversation_id) : null; data.deal_id = data.deal_id ? Number(data.deal_id) : null; data.assigned_to = Number(data.assigned_to); data.due_at = new Date(`${data.due_date}T${data.due_time}`).toISOString(); delete data.due_date; delete data.due_time;
  const taskId=data.task_id;delete data.task_id;
  try { const result=await api(taskId?`/api/tasks/${taskId}`:'/api/tasks', { method: taskId?'PATCH':'POST', body: data }); closeModals(); toast(taskId?'Tarefa atualizada':'Tarefa criada', result.calendar_sync_warning||(result.deal_id?'A tarefa ficou vinculada ao negócio e ao contato.':'A alteração foi sincronizada com o calendário.')); if (state.view === 'inbox') await renderInbox(state.selectedConversation.id); else if(state.view === 'pipeline') await renderPipeline(); else await renderTasks(); }
  catch (error) { toast(taskId?'Não foi possível atualizar':'Não foi possível criar', error.message, 'error'); }
});

document.querySelector('#delete-task').addEventListener('click',async()=>{const id=document.querySelector('#task-form').elements.task_id.value;if(!id||!confirm('Excluir esta tarefa?'))return;try{await api(`/api/tasks/${id}`,{method:'DELETE'});closeModals();toast('Tarefa excluída','Ela também foi removida do Google Agenda, quando sincronizada.');await renderTasks();}catch(error){toast('Não foi possível excluir',error.message,'error');}});

document.querySelector('#pipeline-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); data.stages = data.stages.split(',').map(item => item.trim()).filter(Boolean);
  try { const pipeline = await api('/api/pipelines', { method: 'POST', body: data }); state.pipelines = []; state.selectedPipelineId = pipeline.id; closeModals(); toast('Funil criado', 'O novo fluxo já está disponível.'); await renderPipeline(); }
  catch (error) { toast('Não foi possível criar', error.message, 'error'); }
});

document.querySelector('#deal-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget; const button = form.querySelector('[type=submit]'); const values = Object.fromEntries(new FormData(form));
  const value = Number(values.value || 0);
  const body = { title: values.title, contact_id: values.contact_id ? Number(values.contact_id) : null, contact: values.contact_id ? null : { first_name:values.contact_first_name, last_name:values.contact_last_name, name:`${values.contact_first_name||''} ${values.contact_last_name||''}`.trim(), phone:values.contact_phone, email:values.contact_email, social:values.contact_social, company:values.contact_company, company_phone:values.company_phone, company_email:values.company_email, company_socials:values.company_socials, company_website:values.company_website, source:values.contact_source, temperature:values.lead_temperature, tags:values.contact_tags, segment:values.contact_segment, notes:values.contact_notes, client_type:values.client_type, budget:values.budget, payment_method:values.payment_method, objective:values.client_objective }, stage_id: Number(values.stage_id), value_cents: Math.round(value * 100), score: Number(values.score || 0), expected_close_at: values.expected_close_at || null };
  button.disabled = true; button.textContent = 'Criando…';
  try {
    await api('/api/deals', { method: 'POST', body });
    closeModals(); form.reset(); toast('Negócio criado', 'O novo card já está disponível no funil.'); await renderPipeline();
  } catch (error) { toast('Não foi possível criar o negócio', error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Criar negócio'; }
});

document.querySelector('#edit-pipeline-form').addEventListener('submit', async event => {
  event.preventDefault(); const form=event.currentTarget; const button=form.querySelector('[type=submit]');
  const rows=[...document.querySelectorAll('#pipeline-stage-editor .pipeline-stage-row')];
  const stages=rows.map(row=>({id:row.dataset.stageId?Number(row.dataset.stageId):null,name:row.querySelector('[data-stage-name]').value.trim()}));
  if(stages.some(stage=>!stage.name))return toast('Nome obrigatório','Preencha o nome de todas as etapas.','error');
  button.disabled=true;button.textContent='Salvando…';
  try{const updated=await api(`/api/pipelines/${state.selectedPipelineId}/stages`,{method:'PUT',body:{stages}});const conversationRules=updated.stages.map((stage,index)=>({stage_id:stage.id,trigger_phrases:rows[index].querySelector('[data-stage-triggers]').value.split(/[,;\n]/).map(value=>value.trim()).filter(Boolean)}));await Promise.all([api('/api/pipeline-outcome-rules',{method:'PUT',body:{pipeline_id:state.selectedPipelineId,won_stage_id:Number(form.elements.won_stage_id.value)||null,lost_stage_id:Number(form.elements.lost_stage_id.value)||null}}),api('/api/pipeline-conversation-rules',{method:'PUT',body:{pipeline_id:state.selectedPipelineId,rules:conversationRules}})]);closeModals();toast('Funil atualizado','Etapas, resultados e avanços automáticos pela conversa foram salvos.');await renderPipeline();}
  catch(error){toast('Não foi possível editar',error.message,'error');}
  finally{button.disabled=false;button.textContent='Salvar funil';}
});

document.querySelector('#loss-form').addEventListener('submit', async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
  try { await api(`/api/deals/${data.deal_id}`, { method: 'PATCH', body: { status: 'lost', lost_reason: data.lost_reason, recovery_strategy:data.recovery_strategy } }); closeModals(); toast('Perda registrada', data.recovery_strategy==='retomada'?'Uma nova oportunidade foi criada no funil Retomada.':'O contato recebeu o tratamento comercial escolhido.'); await renderPipeline(); }
  catch (error) { toast('Não foi possível encerrar', error.message, 'error'); }
});

document.querySelector('#dashboard-form').addEventListener('submit', async event => {
  event.preventDefault(); const cards = new FormData(event.currentTarget).getAll('cards');
  if (!cards.length) return toast('Escolha pelo menos um card', 'O dashboard precisa de um indicador.', 'error');
  state.dashboardPreferences = await api('/api/dashboard/preferences', { method: 'PUT', body: { cards } }); closeModals(); toast('Dashboard personalizado', 'Sua seleção foi salva.'); await renderOverview();
});

document.querySelector('#new-company-button').addEventListener('click',async event=>{event.stopPropagation();document.querySelector('#profile-popover').hidden=true;await navigate('administration');document.querySelector('#client-provision-form input[name=name]')?.focus();});
document.querySelector('#company-form').addEventListener('submit',async event=>{event.preventDefault();try{const company=await api('/api/companies',{method:'POST',body:Object.fromEntries(new FormData(event.currentTarget))});await api(`/api/companies/${company.id}/activate`,{method:'POST',body:{}});location.reload();}catch(error){toast('Não foi possível criar',error.message,'error');}});
document.querySelector('#template-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('[type=submit]');button.disabled=true;try{await api('/api/message-templates',{method:'POST',body:Object.fromEntries(new FormData(event.currentTarget))});closeModals();toast('Modelo salvo','A mensagem já pode ser selecionada em uma campanha.');await renderCampaigns(state.selectedCampaignId);}catch(error){toast('Não foi possível salvar',error.message,'error');}finally{button.disabled=false;}});

const systemTourSteps=[
  {title:'Bem-vindo à Visão geral',text:'Aqui você acompanha os números principais. Abra um card para ver o resumo do indicador.',view:'overview',selector:'.metric-grid .metric-card',required:true,instruction:'Clique no card destacado para continuar.'},
  {title:'Personalize suas métricas',text:'Escolha quais indicadores aparecem e defina a ordem com as setas.',view:'overview',selector:'#customize-dashboard',required:true,instruction:'Clique em Personalizar para conhecer as opções.'},
  {title:'Gráficos interativos',text:'Alterne entre barras e pizza e use o botão de ampliar para analisar com mais espaço.',view:'overview',selector:'#toggle-traffic-chart',required:true,instruction:'Clique no botão destacado para trocar o tipo de gráfico.'},
  {title:'Conversas do WhatsApp',text:'Atenda contatos, envie áudio e consulte o resumo criado pela IA. Se ainda não conectou o WhatsApp, você poderá fazer isso em Integrações.',view:'inbox',selector:'#toggle-details',required:true,instruction:'Clique no botão de detalhes para abrir o resumo do contato.'},
  {title:'Funis comerciais',text:'Arraste oportunidades entre as colunas. Clique em um lead para editar os dados e acessar a conversa.',view:'pipeline',selector:'.deal-item',required:true,instruction:'Clique em um lead para editar a oportunidade.'},
  {title:'Funil e qualificação',text:'As regras de Lead, MQL e SQL são sugeridas pelo playbook e continuam editáveis pela equipe.',view:'qualification',selector:'[data-funnel-orientation="horizontal"]',required:true,instruction:'Clique em Horizontal para experimentar outra visualização.'},
  {title:'Ações em contatos',text:'Selecione vários contatos para disparar, excluir ou exportar CSV para Meta e Excel escolhendo os campos.',view:'contacts',selector:'#select-all-contacts',required:true,instruction:'Clique em selecionar todos para liberar as ações em massa.'},
  {title:'Tarefas e calendário',text:'Veja compromissos em lista ou no calendário mensal, com prioridade e responsável.',view:'tasks',selector:'[data-task-view="calendar"]',required:true,instruction:'Clique em Calendário para abrir a visão mensal.'},
  {title:'Disparos',text:'Use contatos existentes ou importe uma planilha, escolha um modelo e confira a prévia antes de enviar.',view:'campaigns',selector:'#new-template',required:true,instruction:'Clique em Novo modelo para conhecer o editor.'},
  {title:'Seu agente de IA',text:'O nome, o tom e o objetivo vêm do playbook. Use Editar quando precisar ajustar uma exceção.',view:'agent',selector:'#edit-agent-config',required:true,instruction:'Clique em Editar para liberar os campos controlados pelo playbook.'},
  {title:'Conhecimento',text:'Envie um playbook ou edite as fontes existentes. O agente e o funil são atualizados juntos.',view:'knowledge',selector:'[data-add-knowledge]',required:true,instruction:'Clique em Adicionar fonte para ver onde enviar o playbook.'},
  {title:'Métricas da Meta',text:'Escolha uma conta de anúncios, acompanhe as métricas reais, personalize os cards e analise o funil de mídia.',view:'meta-ads',selector:'#customize-meta-metrics',required:true,instruction:'Quando a Meta estiver conectada, clique em Personalizar para escolher as métricas.'},
  {title:'Integrações',text:'Conecte WhatsApp oficial, Meta e Google Agenda. O canal principal funciona em tempo real pela Cloud API.',view:'meta',selector:'.official-meta-details',required:false,instruction:'Aqui ficam as credenciais e a validação do webhook oficial. Você pode configurar agora ou voltar depois.'}
]; let systemTourIndex=0; let activeTourTarget=null; let activeTourClickHandler=null;
function clearTourTarget(){if(activeTourTarget&&activeTourClickHandler)activeTourTarget.removeEventListener('click',activeTourClickHandler,true);activeTourTarget?.classList.remove('tour-target');activeTourTarget=null;activeTourClickHandler=null;}
function stopSystemTour(completed=false){const host=document.querySelector('#product-tour');host.hidden=true;clearTourTarget();if(completed){localStorage.setItem('atenva-system-tour-complete','1');localStorage.setItem('atenva-system-tour',String(systemTourSteps.length));toast('Tour concluído','Você pode reabrir o tutorial quando quiser.');}}
function positionTour(target){
  const focus=document.querySelector('#product-tour-focus');const card=document.querySelector('#product-tour-card');const rect=target.getBoundingClientRect();
  const edge=16;const focusGap=10;const cardGap=18;const viewportWidth=document.documentElement.clientWidth;const viewportHeight=document.documentElement.clientHeight;
  const focusLeft=Math.max(6,rect.left-focusGap);const focusTop=Math.max(6,rect.top-focusGap);const focusRight=Math.min(viewportWidth-6,rect.right+focusGap);const focusBottom=Math.min(viewportHeight-6,rect.bottom+focusGap);
  focus.style.left=`${focusLeft}px`;focus.style.top=`${focusTop}px`;focus.style.width=`${Math.max(0,focusRight-focusLeft)}px`;focus.style.height=`${Math.max(0,focusBottom-focusTop)}px`;
  if(matchMedia('(max-width: 700px)').matches){card.style.left=`${edge}px`;card.style.top='auto';return;}
  const cardWidth=Math.min(card.offsetWidth||390,viewportWidth-edge*2);const cardHeight=Math.min(card.offsetHeight||260,viewportHeight-edge*2);
  const clamp=(value,min,max)=>Math.min(Math.max(value,min),Math.max(min,max));
  const candidates=[
    {space:viewportHeight-focusBottom,top:focusBottom+cardGap,left:clamp(rect.left,edge,viewportWidth-cardWidth-edge)},
    {space:focusTop,top:focusTop-cardHeight-cardGap,left:clamp(rect.left,edge,viewportWidth-cardWidth-edge)},
    {space:viewportWidth-focusRight,left:focusRight+cardGap,top:clamp(rect.top,edge,viewportHeight-cardHeight-edge)},
    {space:focusLeft,left:focusLeft-cardWidth-cardGap,top:clamp(rect.top,edge,viewportHeight-cardHeight-edge)}
  ];
  const fitting=candidates.find((candidate,index)=>candidate.space>=(index<2?cardHeight:cardWidth)+cardGap);
  const position=fitting||{left:viewportWidth-cardWidth-edge,top:viewportHeight-cardHeight-edge};
  card.style.left=`${clamp(position.left,edge,viewportWidth-cardWidth-edge)}px`;card.style.top=`${clamp(position.top,edge,viewportHeight-cardHeight-edge)}px`;
}
async function renderSystemTour(){const step=systemTourSteps[systemTourIndex];clearTourTarget();await navigate(step.view);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const selected=document.querySelector(step.selector);const target=selected||document.querySelector(`#view-${step.view}`);const requiresClick=Boolean(step.required&&selected);target.scrollIntoView({behavior:'smooth',block:'center'});await new Promise(resolve=>setTimeout(resolve,220));activeTourTarget=target;target.classList.add('tour-target');document.querySelector('#product-tour-title').textContent=step.title;document.querySelector('#product-tour-text').textContent=step.text;document.querySelector('#product-tour-instruction').textContent=requiresClick?step.instruction:(selected?step.instruction:'Esta ação ficará disponível quando houver dados ou uma integração conectada. Use Próximo para continuar.');document.querySelector('#product-tour-count').textContent=`PASSO ${systemTourIndex+1} DE ${systemTourSteps.length}`;document.querySelector('#system-tour-progress').style.width=`${(systemTourIndex+1)/systemTourSteps.length*100}%`;document.querySelector('#system-tour-prev').disabled=systemTourIndex===0;const next=document.querySelector('#system-tour-next');next.disabled=requiresClick;next.textContent=requiresClick?'Clique na área destacada':systemTourIndex===systemTourSteps.length-1?'Concluir ✓':'Próximo →';document.querySelector('#product-tour').hidden=false;positionTour(target);localStorage.setItem('atenva-system-tour',String(systemTourIndex));if(requiresClick){activeTourClickHandler=()=>{next.disabled=false;next.textContent=systemTourIndex===systemTourSteps.length-1?'Concluir ✓':'Continuar →';document.querySelector('#product-tour-instruction').textContent='Perfeito — ação concluída.';setTimeout(()=>{document.querySelectorAll('.modal-backdrop:not([hidden])').forEach(modal=>{modal.hidden=true;});if(systemTourIndex===systemTourSteps.length-1)stopSystemTour(true);else{systemTourIndex++;renderSystemTour();}},420);};target.addEventListener('click',activeTourClickHandler,{capture:true,once:true});}}
function startSystemTour(){systemTourIndex=Number(localStorage.getItem('atenva-system-tour')||0);if(systemTourIndex>=systemTourSteps.length)systemTourIndex=0;renderSystemTour();}
document.querySelector('#system-tour-button').addEventListener('click',startSystemTour);
document.querySelectorAll('[data-tour-exit]').forEach(button=>button.addEventListener('click',()=>stopSystemTour(false)));
document.querySelector('#system-tour-prev').addEventListener('click',()=>{systemTourIndex=Math.max(0,systemTourIndex-1);renderSystemTour();});
document.querySelector('#system-tour-next').addEventListener('click',()=>{if(systemTourIndex===systemTourSteps.length-1)return stopSystemTour(true);systemTourIndex++;renderSystemTour();});
addEventListener('resize',()=>{if(!document.querySelector('#product-tour').hidden&&activeTourTarget)positionTour(activeTourTarget);});
addEventListener('scroll',()=>{if(!document.querySelector('#product-tour').hidden&&activeTourTarget)positionTour(activeTourTarget);},{passive:true});

document.querySelector('#toggle-password').addEventListener('click', event => {
  const password = document.querySelector('#login-form input[name=password]');
  password.type = password.type === 'password' ? 'text' : 'password';
  event.currentTarget.textContent = password.type === 'password' ? 'Mostrar' : 'Ocultar';
});

let activeInviteToken = '';

async function showInvitation(token) {
  activeInviteToken = token;
  state.user = null;
  csrfToken = '';
  document.querySelector('#app-boot').hidden = true;
  document.querySelector('#app-shell').hidden = true;
  document.querySelector('#login-screen').hidden = false;
  document.querySelector('#login-form').hidden = true;
  const form = document.querySelector('#invite-accept-form');
  const errorBox = document.querySelector('#invite-error');
  form.hidden = false;
  errorBox.hidden = true;
  try {
    const invitation = await api(`/api/invitations/${encodeURIComponent(token)}`);
    const role = { master: 'Onboarding Manager Atenva', admin: 'Administrador', manager: 'Gestor', agent: 'Atendente' }[invitation.role] || invitation.role;
    form.querySelector('[name=email]').value = invitation.email;
    document.querySelector('#invite-description').textContent = `${invitation.inviter_name || 'A equipe Atenva'} convidou você para ${invitation.company_name} como ${role}.`;
    form.querySelector('[name=name]').focus();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    form.querySelector('[type=submit]').disabled = true;
  }
}

document.querySelector('#invite-accept-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget; const button = form.querySelector('[type=submit]'); const errorBox = document.querySelector('#invite-error');
  button.disabled = true; button.textContent = 'A criar seu acesso…'; errorBox.hidden = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    const result = await api(`/api/invitations/${encodeURIComponent(activeInviteToken)}/accept`, { method: 'POST', body: { name: data.name, password: data.password } });
    history.replaceState({}, '', `${location.pathname}${location.hash}`);
    showLogin();
    document.querySelector('#login-form input[name=email]').value = result.email;
    document.querySelector('#login-form input[name=password]').focus();
    toast('Convite aceito', 'Seu acesso foi criado. Entre com a senha que você acabou de definir.');
  } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  finally { button.disabled = false; button.innerHTML = `Aceitar convite ${icon('arrow')}`; }
});

document.querySelector('#back-to-login').addEventListener('click', () => {
  history.replaceState({}, '', `${location.pathname}${location.hash}`);
  showLogin();
});

document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type=submit]');
  const errorBox = document.querySelector('#login-error');
  button.disabled = true;
  button.textContent = 'A verificar…';
  errorBox.hidden = true;
  try {
    const loginBody = Object.fromEntries(new FormData(form));
    loginBody.company_slug = entryProfile()?.slug || '';
    const result = await api('/api/auth/login', { method: 'POST', body: loginBody });
    csrfToken = result.csrfToken;
    showApp(result.user);
    await applyEntryProfile();
    await loadHealth();
    await navigate('overview');
    if (!localStorage.getItem('atenva-system-tour-complete')) setTimeout(startSystemTour, 450);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.innerHTML = `Entrar com segurança ${icon('arrow')}`;
  }
});

document.querySelector('#profile-menu-button').addEventListener('click', event => {
  event.stopPropagation();
  const popover = document.querySelector('#profile-popover');
  popover.hidden = !popover.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!popover.hidden));
});
document.querySelector('#text-size-button').addEventListener('click', event => {
  event.stopPropagation();
  document.querySelector('#profile-popover').hidden = true;
  document.querySelector('#profile-menu-button').setAttribute('aria-expanded','false');
  openTextSizeSettings();
});
document.addEventListener('click', () => { document.querySelector('#profile-popover').hidden = true; document.querySelector('#profile-menu-button').setAttribute('aria-expanded','false'); });
async function endSession(event){
  event.stopPropagation();
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* A sessão local será encerrada mesmo se a rede falhar. */ }
  showLogin();
  toast('Sessão encerrada', 'Seu acesso foi terminado com segurança.');
}
document.querySelector('#logout-button').addEventListener('click',endSession);
document.querySelector('#sidebar-logout-button').addEventListener('click',endSession);

async function bootstrap() {
  const invitationToken = new URLSearchParams(location.search).get('invite');
  if (invitationToken) {
    await showInvitation(invitationToken);
    return;
  }
  const boot=document.querySelector('#app-boot');const retry=document.querySelector('#retry-bootstrap');const bootMessage=document.querySelector('#app-boot-message');
  boot.hidden=false;retry.hidden=true;bootMessage.textContent='Abrindo seu ambiente…';
  try {
    let session=null;let sessionError=null;
    for(let attempt=0;attempt<2;attempt+=1){try{session=await api('/api/auth/me',{timeoutMs:6_000});break;}catch(error){sessionError=error;if(error.status===401)break;if(attempt<1)await new Promise(resolve=>setTimeout(resolve,450));}}
    const health = await api('/api/health',{timeoutMs:5_000}).catch(()=>null);
    if (health?.demo) {
      document.querySelector('#login-form input[name=email]').value = 'ana@verdecrm.local';
      document.querySelector('#login-form input[name=password]').value = 'VerdeDemo!2026';
      document.querySelector('#demo-hint').hidden = false;
    }
    if (!session) {
      if(sessionError?.status!==401)throw sessionError||new Error('Não foi possível restaurar sua sessão.');
      showLogin();
      return;
    }
    csrfToken = session.csrfToken;
    showApp(session.user);
    await applyEntryProfile();
    await loadHealth();
    await navigate('overview');
    const integrationParams=new URLSearchParams(location.search);if(['google','meta'].includes(integrationParams.get('integration'))){const providerKey=integrationParams.get('integration');const provider=providerKey==='google'?'Google Agenda':'Meta';const ok=integrationParams.get('status')==='connected';const synced=integrationParams.get('synced')==='1';const items=Number(integrationParams.get('items')||0);if(ok)await navigate('meta');toast(ok?`${provider} conectado`:`Falha ao conectar ${provider}`,ok?(synced?`Conexão concluída e dados atualizados automaticamente${items?` (${items} item${items===1?'':'s'})`:''}.`:`A conta foi conectada. ${integrationParams.get('message')||'A sincronização automática será repetida.'}`):integrationParams.get('message')||'Tente novamente pela área de Integrações.',ok?'success':'error');history.replaceState({},'',location.pathname);}
  } catch {
    boot.hidden=false;bootMessage.textContent='Não foi possível reconectar agora. Sua sessão continua salva.';retry.hidden=false;
  }
}

document.querySelector('#retry-bootstrap').addEventListener('click',bootstrap);

bootstrap();
