const responseSchema={
  type:'object',additionalProperties:false,required:['response','applied_rule_ids','analysis','contact_updates'],
  properties:{
    response:{type:'string'},applied_rule_ids:{type:'array',items:{type:'integer'}},
    analysis:{type:'object',additionalProperties:false,required:['intent','confidence','handoff_reason','summary','stage_id','stage_evidence'],properties:{
      intent:{type:'string',enum:['saudacao','produto','preco','agendamento','duvida_geral','pedido_humano','reclamacao','desconto']},
      confidence:{type:'number'},handoff_reason:{type:['string','null'],enum:['pedido_humano','reclamacao','desconto','baixa_confianca',null]},
      summary:{type:'string'},stage_id:{type:['integer','null']},stage_evidence:{type:'string'}
    }},
    contact_updates:{type:'array',items:{type:'object',additionalProperties:false,required:['field','value','evidence'],properties:{
      field:{type:'string',enum:['name','email','company','segment','location','need','budget','timeframe','decision_role']},
      value:{type:'string'},evidence:{type:'string'}
    }}}
  }
};

export function modelRequestOptions(endpoint,model,{structuredLead=false}={}) {
  const isGroq=new URL(endpoint).hostname==='api.groq.com';
  const configured=Number(process.env.AI_MAX_OUTPUT_TOKENS||1200);
  const maxTokens=Number.isInteger(configured)?Math.min(2000,Math.max(256,configured)):1200;
  if(isGroq && /^openai\/gpt-oss-/.test(model))return {
    max_completion_tokens:maxTokens,reasoning_effort:'low',
    response_format:structuredLead?{type:'json_schema',json_schema:{name:'crm_lead_response',strict:true,schema:responseSchema}}:{type:'json_object'}
  };
  return {max_tokens:maxTokens,response_format:{type:'json_object'}};
}
