import pg from 'pg';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';

export function storageKey(env=process.env) {
  const key=Buffer.from(env.GATHER_STORAGE_KEY || '', 'base64');
  if(key.length!==32)throw Error('GATHER_STORAGE_KEY must contain a base64-encoded 32-byte key.');
  return key;
}
export function seal(bytes,key) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
}
export function unseal(bytes,key) {
  const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);
}
export async function openStore(env=process.env) {
  // Session-level advisory locks require a direct connection, never PgBouncer.
  const connectionString=env.DATABASE_URL_UNPOOLED || env.POSTGRES_URL_NON_POOLING;
  if(!connectionString)throw Error('A direct PostgreSQL connection is required.');
  const parsed=new URL(connectionString);
  if(parsed.hostname.includes('-pooler.'))throw Error('Use the unpooled PostgreSQL connection.');
  parsed.searchParams.set('sslmode','verify-full');
  const key=storageKey(env);
  const client=new pg.Client({connectionString:parsed.href,connectionTimeoutMillis:10000,statement_timeout:15000,application_name:'gather-crm'});
  let broken=false;
  client.on('error',()=>{broken=true;});
  await client.connect();
  const query=async(...args)=>{if(broken)throw Error('Database connection was interrupted.');return client.query(...args);};
  let locked=false;
  try {
    // The same session holds the lock through all durable checkpoints and Google calls.
    // Every checkpoint is committed immediately, so an interrupted send is recoverable.
    for(let attempt=0;attempt<40;attempt++) {
      const result=await query('SELECT pg_try_advisory_lock(714032681) AS locked');
      if(result.rows[0].locked){locked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!locked)throw Object.assign(Error('Another operation is in progress. Please try again shortly.'),{status:503});
    return {
      client,
      async read(name){const result=await query('SELECT bytes FROM gather_files WHERE name=$1',[name]);return result.rows[0]?unseal(result.rows[0].bytes,key):null;},
      async write(name,bytes){await query('INSERT INTO gather_files(name,bytes) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET bytes=EXCLUDED.bytes',[name,seal(bytes,key)]);},
      async close(){try{if(!broken)await client.query('SELECT pg_advisory_unlock(714032681)');}finally{await client.end().catch(()=>{});}},
    };
  } catch(error) {await client.end().catch(()=>{});throw error;}
}
