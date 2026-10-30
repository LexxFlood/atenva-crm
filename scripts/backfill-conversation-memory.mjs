import {all} from '../src/db.js';
import {conversationContext} from '../src/conversation-context.js';
const conversations=all(`SELECT c.id,ct.company_id,(SELECT MAX(id) FROM messages WHERE conversation_id=c.id AND direction='inbound') AS last_message_id
  FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.status!='closed'`);
const eligible=conversations.filter(item=>item.last_message_id);
if(!process.argv.includes('--apply')){
  console.log(JSON.stringify({eligible:eligible.length,applied:false}));
}else{
  for(const conversation of eligible)conversationContext(conversation.id,conversation.company_id,conversation.last_message_id);
  console.log(JSON.stringify({organized:eligible.length,modelCalls:0,messagesSent:0}));
}
