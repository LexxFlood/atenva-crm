const {chromium}=require(process.env.ATENVA_PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
  const qa=await require('./harness.cjs').startQA();
  const browser=await chromium.launch({headless:true,...(process.env.ATENVA_QA_BROWSER_PATH?{executablePath:process.env.ATENVA_QA_BROWSER_PATH}:{})});
  try{
  const context=await browser.newContext();
  await context.request.post(qa.base+'/api/auth/login',{data:{email:'qa-admin@atenva.test',password:qa.password}});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const fixture={id:987654,contact_id:987654,name:'Cliente QA local',phone:'5511000000000',company:'Teste',mode:'autopilot',status:'open',unread_count:1,waiting_human:0,handoff_id:null,tags:[],tasks:[],schedules:[],activities:[],score:0,qualification:'lead',messages:[],last_message:'Inicial',last_message_at:new Date().toISOString()};
  let liveRequests=0,claims=0,failures=false,hold=null;
  const pipelines=await (await context.request.get(qa.base+'/api/pipelines')).json();
  const pipelineFixture=await (await context.request.get(qa.base+`/api/pipeline?pipeline_id=${pipelines[0].id}`)).json();
  await page.route('**/api/**',async route=>{
    const req=route.request();const url=new URL(req.url());
    const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/conversations/live'){
      liveRequests++;
      if(failures)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Teste offline"}'});
      if(hold)await hold;
      return json({conversations:[fixture],selected:url.searchParams.has('selected')?fixture:null});
    }
    if(url.pathname==='/api/conversations')return json([fixture]);
    if(url.pathname==='/api/pipeline')return json(pipelineFixture);
    if(url.pathname===`/api/conversations/${fixture.id}`){
      if(req.method()==='PATCH'){claims++;fixture.waiting_human=0;fixture.mode='human';}
      return json(fixture);
    }
    if(req.method()!=='GET')return json({processed:0});
    const response=await context.request.get(req.url());
    return route.fulfill({status:response.status(),contentType:'application/json',body:await response.text()});
  });
  await page.addInitScript(()=>localStorage.setItem('atenva-system-tour-complete','true'));
  await page.goto(qa.base);
  await page.locator('#view-overview .metric-card').first().waitFor();
  await page.locator('[data-view=inbox]').click();
  await page.locator('#message-form textarea').waitFor();
  const composer=page.locator('#message-form textarea');
  await composer.fill('Rascunho que precisa permanecer');
  await composer.evaluate(el=>{el.selectionStart=3;el.selectionEnd=8;window.qaComposer=el;});
  const before=liveRequests;
  fixture.messages.push({id:1,direction:'inbound',sender_type:'contact',type:'text',content:'Mensagem recebida sem recarregar',created_at:new Date().toISOString(),status:'received',metadata:{}});
  fixture.last_message=fixture.messages[0].content;
  await page.getByText(fixture.last_message,{exact:true}).last().waitFor({timeout:10000});
  assert.ok(liveRequests>before);
  assert.equal(await composer.inputValue(),'Rascunho que precisa permanecer');
  assert.deepEqual(await composer.evaluate(el=>({same:el===window.qaComposer,start:el.selectionStart,end:el.selectionEnd})),{same:true,start:3,end:8});
  await page.locator('#conversation-search').fill('nao-encontra');
  fixture.waiting_human=1;fixture.handoff_id=87654;fixture.mode='human';
  await page.locator('.chat-header-copy span').filter({hasText:'Aguardando atendimento humano'}).waitFor({timeout:10000});
  await page.getByText('Cliente QA local está aguardando ser atendido pela equipe.',{exact:true}).waitFor();
  assert.equal(await page.locator('#conversation-list [data-conversation]').count(),0);
  assert.equal(await page.locator('#conversation-search').inputValue(),'nao-encontra');
  await page.locator('#toggle-mode').click();
  await page.locator('.chat-header-copy span').filter({hasText:'Atendimento humano'}).waitFor();
  assert.equal(claims,1);assert.equal(fixture.mode,'human');assert.equal(fixture.waiting_human,0);
  failures=true;await page.waitForTimeout(2500);failures=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  fixture.messages.push({...fixture.messages[0],id:2,content:'Mensagem após reconexão'});
  await page.getByText('Mensagem após reconexão',{exact:true}).waitFor({timeout:12000});
  for(let i=3;i<=35;i++)fixture.messages.push({...fixture.messages[0],id:i,content:`Histórico QA ${i}: `+'texto de leitura '.repeat(12)});
  await page.locator('[data-message-id="35"]').waitFor({timeout:10000});
  await page.locator('#message-scroll').evaluate(el=>el.scrollTop=0);
  fixture.messages.push({...fixture.messages[0],id:36,content:'Mensagem nova enquanto leio o histórico'});
  await page.locator('[data-message-id="36"]').waitFor({timeout:10000});
  assert.equal(await page.locator('#message-scroll').evaluate(el=>el.scrollTop),0);
  await page.locator('[data-view=pipeline]').click();
  const deal=pipelineFixture.deals[0];
  const target=pipelineFixture.stages.find(stage=>stage.id!==deal.stage_id&&!stage.is_closed);
  await page.locator(`.deal-item[data-deal="${deal.id}"]`).waitFor();
  deal.stage_id=target.id;
  await page.locator(`.stage-column[data-stage="${target.id}"] .deal-item[data-deal="${deal.id}"]`).waitFor({timeout:10000});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(require('node:path').join(qa.reportDirectory,'LOCAL-LIVE-CHECK.json'),JSON.stringify({passed:true,checks:['mensagem sem reload','rascunho, foco e seleção preservados','busca mantida','aviso de espera humana','assumir sem reativar IA','recuperação após falha de conexão','rolagem de leitura mantida','card movido sem reload'],errors},null,2));
  await context.close();
  console.log('Validação no navegador passou: sincronização, rascunho, filtros, handoff e reconexão.');
  }finally{await browser.close();qa.stop();}
})().catch(e=>{console.error(e);process.exit(1)});
