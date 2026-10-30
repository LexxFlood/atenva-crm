const {spawn}=require('node:child_process');
const {resolve,join}=require('node:path');
const {tmpdir}=require('node:os');
const repoRoot=resolve(__dirname,'../..');
const {randomBytes}=require('node:crypto');
const fs=require('node:fs');
exports.startQA=async function(options={}){
  const password=randomBytes(24).toString('base64url');
  const directory=fs.mkdtempSync(join(tmpdir(),'atenva-qa-'));
  const reportDirectory=resolve(process.env.QA_REPORT_DIR||join(repoRoot,'reports/qa'));fs.mkdirSync(reportDirectory,{recursive:true});
  const env={...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'3211',PUBLIC_URL:'http://localhost:3211',DATABASE_PATH:join(directory,'qa.db'),QA_PASSWORD:password,ADMIN_EMAIL:'qa-admin@atenva.test',ADMIN_PASSWORD:password,WHATSAPP_SIMULATE:'true',SESSION_SECRET:randomBytes(32).toString('hex')};
  for(const key of ['SUPABASE_SNAPSHOT_URL','SUPABASE_ANON_KEY','SNAPSHOT_SYNC_KEY','AI_API_URL','AI_API_KEY','AI_MODEL','AI_GATEWAY_API_KEY','VERCEL_OIDC_TOKEN','OPENAI_API_KEY','EVOLUTION_API_URL','EVOLUTION_API_KEY','WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','VERCEL'])env[key]='';
  if(options.provider){
    if(new URL(options.provider).hostname!=='127.0.0.1')throw Error('QA aceita apenas provedor fictício em loopback.');
    Object.assign(env,{AI_API_URL:options.provider+'/v1/chat/completions',AI_API_KEY:'qa-only',AI_MODEL:'qa-model',EVOLUTION_API_URL:options.provider,EVOLUTION_API_KEY:randomBytes(32).toString('hex'),EVOLUTION_WEBHOOK_SECRET:'qa-queue-webhook'});
  }
  function launch(){const log=fs.openSync(join(directory,'server.log'),'a');const process=spawn(require('node:process').execPath,[join(__dirname,'server.mjs')],{cwd:repoRoot,env,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);return process;}
  let child=launch();
  async function waitReady(){
  let ready=false;
  for(let n=0;n<100;n++){
    if(child.exitCode!==null)throw Error('Servidor QA encerrou: '+fs.readFileSync(join(directory,'server.log'),'utf8'));
    try{const r=await fetch('http://127.0.0.1:3211/api/health');if(r.ok){ready=true;break}}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  if(!ready){child.kill();throw Error('Servidor QA não iniciou.');}
  }
  await waitReady();
  return {base:'http://127.0.0.1:3211',password,directory,reportDirectory,stop:()=>child.kill(),restart:async()=>{
    await new Promise(resolve=>{child.once('exit',resolve);child.kill();});child=launch();await waitReady();
  }};
};
