const badRequest = message => Object.assign(new Error(message), { statusCode: 400 });

export function validateAgentConfig(input) {
  const result={};
  for(const key of ['name','company_name','tone','objective'])if(input[key]!==undefined){
    if(typeof input[key]!=='string'||!input[key].trim())throw badRequest('Preencha os textos da configuração do agente.');
    result[key]=input[key].trim().slice(0,key==='objective'?2000:500);
  }
  for(const [key,min,max] of [['autonomy_level',0,3],['confidence_threshold',0,1],['max_tool_steps',1,20]])if(input[key]!==undefined){
    const value=Number(input[key]);if(!Number.isFinite(value)||value<min||value>max||(key!=='confidence_threshold'&&!Number.isInteger(value)))throw badRequest(`Valor inválido para ${key}.`);
    result[key]=value;
  }
  if(input.business_hours!==undefined){
    const hours=input.business_hours;
    if(!hours||!Array.isArray(hours.weekdays)||!hours.weekdays.length||hours.weekdays.some(day=>!Number.isInteger(day)||day<0||day>6)||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.end)||hours.start>=hours.end)throw badRequest('Informe dias e horários de atendimento válidos.');
    try{new Intl.DateTimeFormat('pt-BR',{timeZone:hours.timezone}).format();}catch{throw badRequest('Fuso horário inválido.');}
    result.business_hours=JSON.stringify({timezone:hours.timezone,weekdays:[...new Set(hours.weekdays)],start:hours.start,end:hours.end});
  }
  if(input.followup_rules!==undefined){
    const rules=input.followup_rules;
    if(!rules||typeof rules.enabled!=='boolean'||!Array.isArray(rules.delays_hours)||rules.delays_hours.length>5||
      rules.delays_hours.some(delay=>!Number.isFinite(delay)||delay<1||delay>720)||!Number.isInteger(rules.max_attempts)||rules.max_attempts<0||rules.max_attempts>5||
      (rules.template_id!=null&&(!Number.isInteger(rules.template_id)||rules.template_id<1)))throw badRequest('Regras de acompanhamento inválidas.');
    result.followup_rules=JSON.stringify({enabled:rules.enabled,delays_hours:[...new Set(rules.delays_hours)].sort((a,b)=>a-b),max_attempts:rules.max_attempts,template_id:rules.template_id||null});
  }
  return result;
}

export function nextBusinessTime(date, hours) {
  if(!hours?.timezone || !hours.weekdays?.length)return new Date(date).toISOString();
  const formatter=new Intl.DateTimeFormat('en-US',{timeZone:hours.timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const candidate=new Date(Math.ceil(new Date(date).getTime()/60_000)*60_000);
  for(let minutes=0;minutes<8*24*60;minutes++){
    const parts=Object.fromEntries(formatter.formatToParts(candidate).map(part=>[part.type,part.value]));
    const clock=`${parts.hour}:${parts.minute}`;
    if(hours.weekdays.includes(days.indexOf(parts.weekday))&&clock>=hours.start&&clock<hours.end)return candidate.toISOString();
    candidate.setTime(candidate.getTime()+60_000);
  }
  throw new Error('Não foi possível encontrar um horário de atendimento disponível.');
}
