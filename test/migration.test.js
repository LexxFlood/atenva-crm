import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';

test('migra snapshot antigo a cada recarga sem perder contatos ou repetir colunas',async()=>{
  const file=join(process.cwd(),'data','automation-migration.test.db');
  process.env.DATABASE_PATH=file;
  for(const suffix of ['', '-wal', '-shm'])if(existsSync(file+suffix))unlinkSync(file+suffix);
  const database=await import('../src/db.js');
  const originalFetch=globalThis.fetch;
  try{
    database.run("INSERT INTO contacts(company_id,phone,name) VALUES (1,'+5511999988877','Contato preservado')");
    database.db.exec(`DROP TABLE inbound_agent_jobs;DROP TABLE automation_health;
      ALTER TABLE company_qualification_config DROP COLUMN sql_required_fields;
      ALTER TABLE scheduled_messages DROP COLUMN claimed_at;
      ALTER TABLE scheduled_messages DROP COLUMN attempts;
      ALTER TABLE scheduled_messages DROP COLUMN last_error;
      ALTER TABLE relationship_cadence_enrollments DROP COLUMN claimed_at;
      PRAGMA wal_checkpoint(TRUNCATE);`);
    const snapshot=readFileSync(file);
    Object.assign(process.env,{SUPABASE_SNAPSHOT_URL:'https://snapshot.invalid/test',SUPABASE_ANON_KEY:'test-anon',SNAPSHOT_SYNC_KEY:'test-sync'});
    globalThis.fetch=async()=>new Response(snapshot,{status:200});
    for(let attempt=0;attempt<2;attempt++){
      await database.reloadDatabaseFromSnapshot('test-lease');
      assert.equal(database.get("SELECT name FROM contacts WHERE phone='+5511999988877'").name,'Contato preservado');
      assert.ok(database.get("SELECT name FROM sqlite_master WHERE type='table' AND name='inbound_agent_jobs'"));
      assert.ok(database.all('PRAGMA table_info(company_qualification_config)').some(column=>column.name==='sql_required_fields'));
      assert.equal(database.all('PRAGMA table_info(scheduled_messages)').filter(column=>column.name==='claimed_at').length,1);
    }
  }finally{
    globalThis.fetch=originalFetch;database.closeDatabase();
    for(const key of ['SUPABASE_SNAPSHOT_URL','SUPABASE_ANON_KEY','SNAPSHOT_SYNC_KEY'])delete process.env[key];
    for(const suffix of ['', '-wal', '-shm'])if(existsSync(file+suffix))unlinkSync(file+suffix);
  }
});
