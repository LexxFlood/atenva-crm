import {evolutionIsConfigured,evolutionProfilePicture} from './evolution.js';

const cache=new Map(),pending=new Map();
let active=0;
const waiters=[];
async function slot(operation){
  if(active>=2)await new Promise(resolve=>waiters.push(resolve));else active++;
  try{return await operation();}finally{const next=waiters.shift();if(next)next();else active--;}
}

export function allowedAvatarUrl(value){
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&['whatsapp.net','fbcdn.net','facebook.com'].some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain));}catch{return false;}
}

async function download(url){
  for(let redirects=0;redirects<3;redirects++){
    if(!allowedAvatarUrl(url))return null;
    const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(6000)});
    if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get('location'),url).href;await response.body?.cancel();continue;}
    const contentType=(response.headers.get('content-type')||'').split(';')[0];
    if(!response.ok||!['image/jpeg','image/png','image/webp'].includes(contentType)){await response.body?.cancel();return null;}
    const parts=[];let size=0;
    for await(const part of response.body){size+=part.length;if(size>2_000_000)throw new Error('Foto maior que o limite permitido.');parts.push(part);}
    return {contentType,bytes:Buffer.concat(parts)};
  }
  return null;
}

export async function contactAvatarImage(contact,companyId){
  const key=`${companyId}:${contact.id}`;
  const saved=cache.get(key);if(saved&&saved.expires>Date.now())return saved.image;
  if(pending.has(key))return pending.get(key);
  const operation=slot(async()=>{
    let image=null;
    try{
      if(contact.profile_picture_url)image=await download(contact.profile_picture_url);
      if(!image&&evolutionIsConfigured(companyId)){
        const number=String(contact.whatsapp_id||contact.phone||'').replace(/\D/g,'');
        if(/^\d{10,15}$/.test(number)){const url=await evolutionProfilePicture(number,companyId);if(url)image=await download(url);}
      }
    }catch{/* A privacidade do contato ou uma indisponibilidade mantém as iniciais. */}
    if(cache.size>=100)cache.delete(cache.keys().next().value);
    cache.set(key,{image,expires:Date.now()+(image?15*60_000:60_000)});
    return image;
  }).finally(()=>pending.delete(key));
  pending.set(key,operation);return operation;
}
