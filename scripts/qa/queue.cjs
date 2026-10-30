const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createServer}=require('node:http');
(async()=>{
  let active=0,maxActive=0,modelCalls=0,sends=0;
  const provider=createServer((req,res)=>{
    let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
      res.setHeader('content-type','application/json');
      if(req.url==='/v1/chat/completions'){
        active++;maxActive=Math.max(maxActive,active);modelCalls++;
        setTimeout(()=>{active--;res.end(JSON.stringify({model:'qa-model',choices:[{message:{content:JSON.stringify({response:'Resposta fictícia de QA',applied_rule_ids:[],analysis:{intent:'preco',confidence:.95,handoff_reason:null,summary:'Cliente em teste de fila'},contact_updates:[]})}}]}))},2000);
      }else if(req.url.startsWith('/message/sendText/')){sends++;res.end(JSON.stringify({key:{id:'qa-send-'+sends}}));}
      else if(req.url.startsWith('/instance/connectionState/'))res.end(JSON.stringify({instance:{state:'close'}}));
      else {res.statusCode=404;res.end('{}');}
    });
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const qa=await require('./harness.cjs').startQA({provider:`http://127.0.0.1:${provider.address().port}`});
  try{
    const login=await fetch(qa.base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'qa-admin@atenva.test',password:qa.password})});
    const session=await login.json();const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    const headers={cookie,'content-type':'application/json','x-csrf-token':session.csrfToken};
    const read=async path=>{const response=await fetch(qa.base+path,{headers});assert.equal(response.status,200);return response.json()};
    const webhook=async(index,id=`qa-inbound-${index}`)=>{
      const start=performance.now();
      const response=await fetch(qa.base+'/api/webhooks/evolution/qa-queue-webhook/1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'messages.upsert',data:{key:{fromMe:false,remoteJid:`551190000000${index}@s.whatsapp.net`,id},pushName:`Fila QA ${index}`,message:{conversation:'Quanto custa para minha equipe?'},messageTimestamp:Math.floor(Date.now()/1000)}})});
      assert.equal(response.status,200);await response.json();return performance.now()-start;
    };
    const webhookTimes=await Promise.all([0,1,2,3,4,0,0,0].map(index=>webhook(index)));
    assert.ok(Math.max(...webhookTimes)<1000,'Webhook deve confirmar a fila antes da conclusão do modelo lento.');
    const initial=await read('/api/conversations/live');const conversations=initial.conversations.filter(item=>item.name.startsWith('Fila QA '));assert.equal(conversations.length,5);
    const readTimes=[];const deadline=Date.now()+20000;
    let completed=false;
    while(Date.now()<deadline){
      const start=performance.now();await read('/api/conversations/live');readTimes.push(performance.now()-start);
      const details=await Promise.all(conversations.map(item=>read(`/api/conversations/${item.id}`)));
      if(details.every(item=>item.messages.filter(message=>message.direction==='outbound').length===1)){completed=true;break}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(completed,'Fila deve concluir as cinco conversas.');
    assert.equal(modelCalls,5);assert.equal(sends,5);assert.ok(maxActive<=3);assert.ok(maxActive>=2);
    const target=conversations[0];
    const human=await fetch(qa.base+`/api/conversations/${target.id}/messages`,{method:'POST',headers,body:JSON.stringify({content:'Resposta humana fictícia.'})});assert.equal(human.status,200);
    const afterHuman=await read(`/api/conversations/${target.id}`);const resumeAt=new Date(afterHuman.human_pause_until).getTime();
    await webhook(Number(target.name.split(' ').at(-1)),'qa-after-human');
    const callsBeforePause=modelCalls;
    await new Promise(resolve=>setTimeout(resolve,2000));
    assert.equal(modelCalls,callsBeforePause);
    await qa.restart();
    assert.equal((await read(`/api/conversations/${target.id}`)).human_pause_until,afterHuman.human_pause_until);
    console.log('Fila passou: cinco conversas paralelas, sem duplicação. Validando o minuto completo de pausa humana.');
    let resumed=false;
    while(Date.now()<resumeAt+12000){
      const detail=await read(`/api/conversations/${target.id}`);
      if(detail.mode==='autopilot'&&detail.messages.filter(message=>message.sender_type==='ai').length===2){resumed=true;break}
      if(Date.now()<resumeAt-1000)assert.equal(modelCalls,callsBeforePause);
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.ok(resumed,'A IA deve retomar e responder ao cliente pendente após o minuto.');
    const report={passed:true,conversations:5,duplicateWebhookCopies:3,maxConcurrentModels:maxActive,modelCallsBeforeHumanPause:5,webhookMaxMs:Math.round(Math.max(...webhookTimes)),readMaxMsWhileModelsRun:Math.round(Math.max(...readTimes)),realMinutePauseValidated:true,aiResumedAutomatically:true,queueAndPauseSurvivedServerRestart:true,externalAiCalls:0,realWhatsAppMessages:0};
    fs.writeFileSync(require('node:path').join(qa.reportDirectory,'LOCAL-QUEUE-CHECK.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{qa.stop();await new Promise(resolve=>provider.close(resolve));}
})().catch(error=>{console.error(error);process.exit(1)});
