import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const moduleAt=path=>pathToFileURL(resolve(path)).href;
const {run}=await import(moduleAt('src/db.js'));
const {seed}=await import(moduleAt('src/seed.js'));seed();
const {hashPassword}=await import(moduleAt('src/auth.js'));
const passwordHash=hashPassword(process.env.QA_PASSWORD);
for(let index=0;index<10;index++){
  const email=`team-${index}@qa.atenva.test`;
  let id;
  try{id=Number(run("INSERT INTO users(name,email,role,password_hash,is_active,active_company_id) VALUES (?,?,'agent',?,1,1)",[`Pessoa QA ${index}`,email,passwordHash]).lastInsertRowid);}
  catch{continue;}
  run("INSERT INTO user_company_memberships(company_id,user_id,role,is_active) VALUES (1,?,'agent',1)",[id]);
}
await import(moduleAt('server.js'));
