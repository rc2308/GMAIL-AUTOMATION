import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createGather} from '../server.mjs';
import {seal,unseal,storageKey} from '../cloud/postgres.mjs';

async function setup(t,{fetchImpl=fetch,onDelete=async()=>{}}={}) {
  const saved=new Map(),dataDir=mkdtempSync(join(tmpdir(),'gather-hosting-'));
  const env={GATHER_HOSTED:'1',GATHER_PUBLIC_ORIGIN:'https://gather.example',GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret',GATHER_TEST:'1'};
  const saves=[];let failSave=false;
  const onPersist=async name=>{if(failSave)throw Error('Durable storage unavailable');await new Promise(r=>setTimeout(r,1));const value=readFileSync(join(dataDir,name));saved.set(name,value);saves.push(name);};
  const remove=async name=>{await onDelete(name,saved);saved.delete(name);};
  const getAsset=async name=>saved.get(name);
  let app=createGather({dataDir,env,onPersist,fetchImpl,onDelete:remove,getAsset});await app.ready;
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const request=async(path,body,cookie='',host='gather.example')=>{
    const {Readable}=await import('node:stream');
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    req.url=path;req.method=body===undefined?'GET':'POST';req.headers={host,cookie,'x-gather-client':'1'};
    const headers={};let status=200,text='';
    const res={headersSent:false,writableEnded:false,setHeader(k,v){headers[k.toLowerCase()]=v;},getHeader(k){return headers[k.toLowerCase()];},writeHead(code,h={}){status=code;Object.assign(headers,h);this.headersSent=true;},end(value=''){text+=value;this.writableEnded=true;}};
    await app.handler(req,res);let json;try{json=JSON.parse(text);}catch{}
    return {status,body:json,text,headers,cookie:headers['set-cookie']?.split(';')[0]};
  };
  return {request,saved,saves,dataDir,failSaves:()=>{failSave=true;},async restart(){app=createGather({dataDir,env,onPersist,fetchImpl,onDelete:remove,getAsset});await app.ready;}};
}

test('hosted authentication survives reconstruction, uses Secure cookies, and binds the public origin',async t=>{
  const {request,restart,saved}=await setup(t);
  const signup=await request('/api/auth/setup',{name:'Cloud Owner',email:'cloud@example.com',password:'test cloud password'});
  assert.equal(signup.status,201);assert.match(signup.headers['set-cookie'],/; Secure/);
  assert.ok(saved.has('auth.json'));
  await restart();
  assert.equal((await request('/api/state',undefined,signup.cookie)).status,200);
  assert.equal((await request('/api/state',undefined,signup.cookie,'attacker.example')).status,403);
  const google=await request('/api/auth/google',{},signup.cookie);
  assert.match(google.headers['set-cookie'],/; Secure/);
  assert.equal(new URL(google.body.url).searchParams.get('redirect_uri'),'https://gather.example/api/auth/google/callback');
  const state=new URL(google.body.url).searchParams.get('state');
  await restart();
  const callback=await request(`/api/auth/google/callback?state=${state}&error=access_denied`,undefined,signup.cookie+'; '+google.cookie);
  assert.equal(callback.headers.location,'/login?google_error=cancelled');
  assert.ok(!JSON.stringify((await request('/api/state',undefined,signup.cookie)).body).includes('browserNonce'));
});

test('hosted upload limits fit serverless payloads and images persist before success',async t=>{
  const {request,saved}=await setup(t);
  const account=await request('/api/auth/setup',{name:'Owner',email:'owner@example.com',password:'cloud test password'});
  const state=await request('/api/state',undefined,account.cookie);assert.equal(state.body.limits.imageMB,3);assert.equal(state.body.limits.uploadBatch,1);
  const image=await request('/api/assets',{name:'card.png',mime:'image/png',data:Buffer.from('example').toString('base64')},account.cookie);
  assert.equal(image.status,201);assert.equal(saved.get(image.body.id).toString(),'example');
  const oversized=await request('/api/assets',{mime:'image/png',data:Buffer.alloc(3*1024*1024+1).toString('base64')},account.cookie);
  assert.equal(oversized.status,400);assert.match(oversized.body.error,/3 MB/);
});

test('failed durable writes do not report a successful account creation',async t=>{
  const {request,failSaves,saved}=await setup(t);failSaves();
  const result=await request('/api/auth/setup',{name:'Owner',email:'owner@example.com',password:'cloud test password'});
  assert.equal(result.status,500);assert.equal(result.headers['set-cookie'],undefined);assert.equal(saved.has('auth.json'),false);
});

test('database records are authenticated ciphertext, and wrong keys or tampering fail closed',()=>{
  const key=randomBytes(32),bytes=Buffer.from('private CRM data');
  const encrypted=seal(bytes,key);
  assert.ok(!encrypted.includes(bytes));assert.deepEqual(unseal(encrypted,key),bytes);
  assert.throws(()=>unseal(encrypted,randomBytes(32)));
  encrypted[encrypted.length-1]^=1;assert.throws(()=>unseal(encrypted,key));
  assert.throws(()=>storageKey({GATHER_STORAGE_KEY:'invalid'}));
});

test('separate accounts survive fresh serverless directories and cannot read each other’s images',async t=>{
  const saved=new Map(),key=randomBytes(32),directories=[];
  const env={GATHER_HOSTED:'1',GATHER_PUBLIC_ORIGIN:'https://gather.example'};
  t.after(()=>directories.forEach(dir=>rmSync(dir,{recursive:true,force:true})));
  async function request(path,body,cookie=''){
    const dir=mkdtempSync(join(tmpdir(),'gather-isolated-cloud-'));directories.push(dir);
    for(const name of ['auth.json','gather.json'])if(saved.has(name))writeFileSync(join(dir,name),saved.get(name),{mode:0o600});
    writeFileSync(join(dir,'.secret-key'),key,{mode:0o600});
    const app=createGather({dataDir:dir,env,
      onPersist:async name=>{saved.set(name,readFileSync(join(dir,name)));},
      loadAccount:async(prefix,directory)=>{if(saved.has(prefix+'gather.json'))writeFileSync(join(directory,'gather.json'),saved.get(prefix+'gather.json'));},
      getAsset:async name=>saved.get(name),
    });
    const {Readable}=await import('node:stream');
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    req.url=path;req.method=body===undefined?'GET':'POST';req.headers={host:'gather.example',cookie,'x-gather-client':'1'};
    let status=200,text='';const headers={};
    const res={headersSent:false,writableEnded:false,setHeader(k,v){headers[k.toLowerCase()]=v;},getHeader(k){return headers[k.toLowerCase()];},writeHead(code,h={}){status=code;Object.assign(headers,h);this.headersSent=true;},end(value=''){text+=value;this.writableEnded=true;}};
    await app.handler(req,res);let json;try{json=JSON.parse(text);}catch{}
    return {status,body:json,text,cookie:headers['set-cookie']?.split(';')[0]};
  }
  const admin=await request('/api/auth/setup',{name:'Owner',email:'owner@example.com',password:'private admin password'});
  await request('/api/workspaces',{name:'Admin workspace'},admin.cookie);
  const member=await request('/api/auth/register',{name:'Member',email:'member@example.com',password:'private member password'});
  assert.equal(member.status,201);
  assert.deepEqual((await request('/api/state',undefined,member.cookie)).body.workspaces,[]);
  await request('/api/workspaces',{name:'Member workspace'},member.cookie);
  const asset=await request('/api/assets',{name:'member.png',mime:'image/png',data:'bWVtYmVy'},member.cookie);
  assert.equal(asset.status,201);
  const prefix=`accounts/${member.body.user.id}/`;
  assert.equal(saved.get(prefix+asset.body.id).toString(),'member');
  assert.equal(saved.has(asset.body.id),false);
  assert.equal((await request('/assets/'+asset.body.id,undefined,member.cookie)).text,'member');
  assert.equal((await request('/assets/'+asset.body.id,undefined,admin.cookie)).status,404);
  assert.deepEqual((await request('/api/state',undefined,admin.cookie)).body.workspaces.map(w=>w.name),['Admin workspace']);
  assert.deepEqual((await request('/api/state',undefined,member.cookie)).body.workspaces.map(w=>w.name),['Member workspace']);
});

test('unstarted AI cards stay queued after restart; interrupted readings require retry',async t=>{
  const {request,restart,dataDir}=await setup(t);
  const account=await request('/api/auth/setup',{name:'Reader',email:'reader@example.com',password:'private reading password'});
  await request('/api/settings',{provider:'gemini',enabled:true,model:'test-model',apiKey:'test-key'},account.cookie);
  const workspace=await request('/api/workspaces',{name:'Card queue'},account.cookie);
  const uploaded=await request('/api/uploads',{workspace:workspace.body.id,files:[{name:'one.png',mime:'image/png',data:'b25l'},{name:'two.png',mime:'image/png',data:'dHdv'}]},account.cookie);
  assert.ok(uploaded.body.every(u=>u.extractionState==='queued'));
  const file=join(dataDir,'gather.json'),data=JSON.parse(readFileSync(file,'utf8'));
  data.uploads[0].extractionState='extracting';writeFileSync(file,JSON.stringify(data));
  await restart();
  const state=(await request('/api/state',undefined,account.cookie)).body;
  assert.equal(state.uploads[0].extractionState,'failed');assert.match(state.uploads[0].error,/interrupted/);
  assert.equal(state.uploads[1].extractionState,'queued');
  const retry=await request('/api/uploads/'+state.uploads[0].id+'/extract',{automatic:true},account.cookie);
  assert.equal(retry.status,200);assert.equal(retry.body.extractionState,'failed');
});

test('hosted extraction deletes only the member’s stored card after its contact is durably saved',async t=>{
  let memberId;const removed=[];
  const {request,saved,dataDir}=await setup(t,{fetchImpl:async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:'{"name":"Member contact","emails":["member-contact@example.com"]}'}]}}]}),{headers:{'content-type':'application/json'}}),
    onDelete:async(name,records)=>{
      const prefix=`accounts/${memberId}/`;assert.ok(name.startsWith(prefix));removed.push(name);
      const data=JSON.parse(records.get(prefix+'gather.json').toString());assert.equal(data.contacts.length,1);assert.equal(data.uploads[0].status,'approved');assert.equal(data.uploads[0].imageCleanupPending,true);
    }});
  const admin=await request('/api/auth/setup',{name:'Owner',email:'owner@example.com',password:'private owner password'});
  const ownerWorkspace=await request('/api/workspaces',{name:'Owner cards'},admin.cookie);
  const ownerCard=await request('/api/uploads',{workspace:ownerWorkspace.body.id,files:[{name:'owner.png',mime:'image/png',data:'b3duZXI='}]},admin.cookie);
  const member=await request('/api/auth/register',{name:'Member',email:'member@example.com',password:'private member password'});memberId=member.body.user.id;
  const workspace=await request('/api/workspaces',{name:'Member cards'},member.cookie);
  await request('/api/settings',{provider:'gemini',enabled:true,model:'test',apiKey:'test-key'},member.cookie);
  const uploaded=await request('/api/uploads',{workspace:workspace.body.id,files:[{name:'member.png',mime:'image/png',data:'bWVtYmVy'}]},member.cookie),card=uploaded.body[0];
  const remoteName=`accounts/${memberId}/${card.assetId}`;assert.ok(saved.has(remoteName));
  // The next request must read the image from cloud storage, with no local copy.
  rmSync(join(dataDir,remoteName),{force:true});
  const result=await request(`/api/uploads/${card.id}/extract`,{automatic:true},member.cookie);
  assert.equal(result.status,200);assert.equal(result.body.status,'approved');assert.ok(result.body.imageRemovedAt);assert.equal(result.body.assetId,undefined);
  assert.deepEqual(removed,[remoteName]);assert.equal(saved.has(remoteName),false);assert.equal(saved.has(ownerCard.body[0].assetId),true);
  assert.equal((await request('/assets/'+card.assetId,undefined,member.cookie)).status,404);
  assert.equal((await request('/assets/'+ownerCard.body[0].assetId,undefined,admin.cookie)).text,'owner');
  const memberData=JSON.parse(saved.get(`accounts/${memberId}/gather.json`).toString());assert.equal(memberData.assets.length,0);assert.equal(memberData.contacts[0].emails[0],'member-contact@example.com');
});
