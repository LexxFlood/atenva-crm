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
    ...(structuredLead?{
      tools:[{type:'function',function:{name:'crm_lead_response',description:'Entregue a resposta ao cliente e a análise como dados estruturados. Esta função apenas retorna dados e não executa ações.',parameters:responseSchema}}],
      tool_choice:{type:'function',function:{name:'crm_lead_response'}},parallel_tool_calls:false
    }:{response_format:{type:'json_object'}})
  };
  return {max_tokens:maxTokens,response_format:{type:'json_object'}};
}

export function parseLeadModelOutput(message){
  const calls=message?.tool_calls;
  let content=message?.content?.trim();
  if(calls?.length){
    if(calls.length!==1||calls[0]?.type!=='function'||calls[0]?.function?.name!=='crm_lead_response')throw new Error('A IA retornou uma ferramenta não permitida.');
    content=calls[0].function.arguments;
  }
  if(typeof content!=='string'||!content.trim())throw new Error('A IA retornou uma resposta vazia.');
  const parsed=JSON.parse(content);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||typeof parsed.response!=='string'||!parsed.response.trim())throw new Error('A IA retornou uma resposta inválida.');
  return parsed;
}
