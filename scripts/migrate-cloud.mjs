import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {openStore,storageKey} from '../cloud/postgres.mjs';

const dataDir=join(process.cwd(),'data');
const localKey=readFileSync(join(dataDir,'.secret-key'));
if(!timingSafeEqual(localKey,storageKey()))throw Error('The deployment encryption key must match the local installation key.');
const db=JSON.parse(readFileSync(join(dataDir,'gather.json'),'utf8'));
const auth=JSON.parse(readFileSync(join(dataDir,'auth.json'),'utf8'));
if(!auth.owner)throw Error('Create the local owner account before migration.');
auth.sessions=[];auth.failures=[];auth.pendingGoogle={};db.pendingOAuth={};
if(db.campaigns.some(c=>c.status==='sending'))throw Error('Wait for active campaigns to finish before migrating.');
const store=await openStore();
try {
  await store.client.query('BEGIN');
  await store.client.query('CREATE TABLE IF NOT EXISTS gather_files (name text PRIMARY KEY, bytes bytea NOT NULL)');
  if(await store.read('auth.json'))throw Error('A cloud account already exists. Migration stopped without replacing it.');
  for(const asset of db.assets)await store.write(asset.id,readFileSync(join(dataDir,asset.id)));
  await store.write('gather.json',Buffer.from(JSON.stringify(db)));
  await store.write('auth.json',Buffer.from(JSON.stringify(auth)));
  await store.client.query('COMMIT');
  console.log(JSON.stringify({migrated:true,workspaces:db.workspaces.length,contacts:db.contacts.length,images:db.assets.length,ownerEmail:auth.owner.email}));
} catch(error) {await store.client.query('ROLLBACK').catch(()=>{});throw error;}
finally {await store.close();}
