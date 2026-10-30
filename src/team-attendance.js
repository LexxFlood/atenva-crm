import {get,run,now} from './db.js';

export function requestHumanAttendance(conversationId,reason){
  const current=get('SELECT mode,human_pause_until FROM conversations WHERE id=?',[conversationId]);
  const last=get("SELECT action FROM activities WHERE conversation_id=? AND action IN ('human_handoff','human_takeover','human_reply') ORDER BY id DESC LIMIT 1",[conversationId]);
  run("UPDATE conversations SET mode='human',priority='high',human_pause_until=NULL,next_action=?,updated_at=? WHERE id=?",[`Aguardando atendimento humano: ${reason}`,now(),conversationId]);
  if(current?.mode!=='human'||current?.human_pause_until||last?.action!=='human_handoff')run(`INSERT INTO activities(contact_id,conversation_id,actor_type,action,description)
    SELECT contact_id,id,'system','human_handoff',? FROM conversations WHERE id=?`,[reason,conversationId]);
}

export function pauseForHumanReply(conversationId,userId=null){
  const until=new Date(Date.now()+60_000).toISOString();
  run(`UPDATE conversations SET mode='human',assigned_to=COALESCE(?,assigned_to),human_pause_until=?,
    next_action='Atendimento humano: IA pausada por 1 minuto após a última resposta.',updated_at=? WHERE id=?`,[userId,until,now(),conversationId]);
  return until;
}

export function resumeExpiredHumanPauses(){
  return run(`UPDATE conversations SET mode='autopilot',human_pause_until=NULL,
    next_action='Pausa encerrada; IA disponível para continuar o atendimento.',updated_at=?
    WHERE mode='human' AND status!='closed' AND human_pause_until IS NOT NULL AND datetime(human_pause_until)<=datetime('now')`,[now()]);
}
