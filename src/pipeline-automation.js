import {all,get,now,run} from './db.js';

export function runStageAutomations(dealId,stageId,companyId,userId=null){
  const deal=get('SELECT d.* FROM deals d JOIN contacts ct ON ct.id=d.contact_id WHERE d.id=? AND ct.company_id=?',[dealId,companyId]);
  if(!deal)return;
  const automations=all("SELECT * FROM pipeline_automations WHERE company_id=? AND is_active=1 AND trigger_type='stage_entered' AND trigger_stage_id=?",[companyId,stageId]);
  for(const automation of automations){
    if(automation.action_type==='move_deal'&&automation.target_stage_id&&automation.target_stage_id!==stageId){
      const target=get('SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.id=? AND p.company_id=?',[automation.target_stage_id,companyId]);
      if(!target)continue;
      run('UPDATE deals SET stage_id=?,updated_at=? WHERE id=?',[target.id,now(),dealId]);
    }
    if(automation.action_type==='add_tag'&&automation.action_value)run('INSERT OR IGNORE INTO contact_tags(contact_id,tag) VALUES (?,?)',[deal.contact_id,automation.action_value]);
    if(automation.action_type==='create_task')run(`INSERT INTO tasks(company_id,contact_id,deal_id,assigned_to,title,due_at,type,created_by)
      VALUES (?,?,?,?,?,?,'followup','system')`,[companyId,deal.contact_id,dealId,deal.owner_id,automation.action_value||`Acompanhar ${deal.title}`,new Date(Date.now()+24*3600000).toISOString()]);
    run("INSERT INTO activities(contact_id,deal_id,actor_type,actor_id,action,description) VALUES (?,?,'system',?,'pipeline_automation',?)",[deal.contact_id,dealId,userId,`Automação executada: ${automation.name}.`]);
  }
}
