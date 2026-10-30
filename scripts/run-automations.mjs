import '../src/env.js';

const endpoint=new URL('/api/cron/scheduled-messages',process.env.CRON_PUBLIC_URL||process.env.PUBLIC_URL||'http://127.0.0.1:3210');
if(endpoint.protocol!=='https:' && !['localhost','127.0.0.1'].includes(endpoint.hostname))throw new Error('O executor remoto exige HTTPS.');
const secret=process.env.CRON_SECRET;
if(!secret)throw new Error('Defina CRON_SECRET antes de iniciar o executor.');
async function tick(){
  const response=await fetch(endpoint,{headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(115_000)});
  if(!response.ok)throw new Error(`Executor respondeu HTTP ${response.status}.`);
  const result=await response.json();
  console.log(JSON.stringify({time:new Date().toISOString(),processed:result.processed,sent:result.sent,failed:result.failed}));
  if(result.failed)throw new Error('Há falhas na automação. Revise o histórico no CRM.');
}
do {
  try{await tick();}catch(error){console.error(error.message);if(process.argv.includes('--once'))process.exitCode=1;}
  if(process.argv.includes('--once'))break;
  await new Promise(resolve=>setTimeout(resolve,60_000));
}while(true);
