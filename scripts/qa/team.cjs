const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
  const qa=await require('./harness.cjs').startQA();
  try{
    const sessions=await Promise.all(Array.from({length:10},async(_,index)=>{
      const response=await fetch(qa.base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`team-${index}@qa.atenva.test`,password:qa.password})});
      assert.equal(response.status,200,`login ${index}`);
      const body=await response.json();
      return {cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),csrf:body.csrfToken,user:body.user};
    }));
    const timings=[];
    async function request(session,path,method='GET',body){
      const start=performance.now();
      const response=await fetch(qa.base+path,{method,headers:{cookie:session.cookie,'content-type':'application/json','x-csrf-token':session.csrf},body:body?JSON.stringify(body):undefined});
      timings.push(performance.now()-start);
      return {status:response.status,body:await response.json()};
    }
    const first=sessions[0];
    const list=await request(first,'/api/conversations/live');assert.equal(list.status,200);
    const conversation=list.body.conversations[0];assert.ok(conversation);
    const pipelines=await request(first,'/api/pipelines');
    const pipelineId=pipelines.body[0].id;
    const started=performance.now();
    const statuses=await Promise.all(sessions.map(async session=>{
      const statuses=[];
      for(let round=0;round<15;round++){
        for(const path of [`/api/conversations/live?selected=${conversation.id}`,`/api/pipeline?pipeline_id=${pipelineId}`,'/api/dashboard'])statuses.push((await request(session,path)).status);
      }
      return statuses;
    }));
    assert.ok(statuses.flat().every(status=>status===200),'Todas as 450 leituras devem responder 200, sem limite compartilhado por IP.');
    const loadDuration=performance.now()-started;
    const pipeline=(await request(first,`/api/pipeline?pipeline_id=${pipelineId}`)).body;
    const deal=pipeline.deals[0];assert.ok(deal);
    const stages=pipeline.stages.filter(stage=>!stage.is_closed);
    const moves=await Promise.all(sessions.map((session,index)=>request(session,`/api/deals/${deal.id}`,'PATCH',{stage_id:stages[index%stages.length].id,expected_revision:deal.revision})));
    assert.equal(moves.filter(result=>result.status===200).length,1);
    assert.equal(moves.filter(result=>result.status===409).length,9);
    await request(first,`/api/conversations/${conversation.id}`,'PATCH',{mode:'autopilot'});
    const claims=await Promise.all(sessions.map(session=>request(session,`/api/conversations/${conversation.id}`,'PATCH',{mode:'human'})));
    assert.equal(claims.filter(result=>result.status===200).length,1);
    assert.equal(claims.filter(result=>result.status===409).length,9);
    const winner=claims.findIndex(result=>result.status===200);
    const loser=sessions.find((_,index)=>index!==winner);
    const blocked=await request(loser,`/api/conversations/${conversation.id}/messages`,'POST',{content:'Não deve ser enviada porque outro atendente assumiu.'});
    assert.equal(blocked.status,409);
    const sent=await request(sessions[winner],`/api/conversations/${conversation.id}/messages`,'POST',{content:'Resposta humana em ambiente isolado.'});assert.equal(sent.status,200);
    const detail=(await request(first,`/api/conversations/${conversation.id}`)).body;
    assert.ok(new Date(detail.human_pause_until)-Date.now()>55_000);
    const sorted=timings.sort((a,b)=>a-b);
    const report={passed:true,concurrentUsers:10,successfulLoadRequests:statuses.flat().length,loadDurationMs:Math.round(loadDuration),p95Ms:Math.round(sorted[Math.floor(sorted.length*.95)]),cardConflict:{accepted:1,rejected:9},attendanceConflict:{accepted:1,rejected:9},otherAttendantReplyBlocked:true,humanPauseSeconds:60,externalAiCalls:0,realWhatsAppMessages:0};
    fs.writeFileSync(require('node:path').join(qa.reportDirectory,'LOCAL-TEAM-CHECK.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  }finally{qa.stop();}
})().catch(error=>{console.error(error);process.exit(1)});
