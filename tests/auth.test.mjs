import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGather} from '../server.mjs';
import {upstreamMock} from './fixtures/upstreams.mjs';

const owner={name:'Owner',email:'owner@example.com',password:'a long test passphrase'};
async function setup(t, options={}) {
  const dataDir=mkdtempSync(join(tmpdir(),'gather-auth-'));
  const servers=[];
  t.after(async()=>{
    for(const server of servers)await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
    rmSync(dataDir,{recursive:true,force:true});
  });
  async function start() {
    const app=createGather({dataDir,env:{GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret'},...options});
    servers.push(app.server);
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const request=async(path,body,cookie='',headers={})=>{
      const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-gather-client':'1',cookie,...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual'});
      const text=await response.text();let json;try{json=JSON.parse(text);}catch{}
      return {status:response.status,body:json,text,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
    };
    return {server:app.server,request};
  }
  return {...await start(),dataDir,start};
}

test('spreadsheet jobs and provider credentials remain isolated even when accounts link the same sheet',async t=>{
  const mock=upstreamMock();mock.sourceTabs.set('shared-source-123',new Map([['Contacts',[['hello@example.com','Velvet Kite']]]]));
  const {request}=await setup(t,{fetchImpl:mock.fetchImpl});
  const first=await request('/api/auth/setup',owner),second=await request('/api/auth/register',{name:'Member',email:'member@example.com',password:'another long test passphrase'});
  const jobs=[],workspaces=[];
  for(const login of [first,second]){
    const start=await request('/api/connect/google',{kind:'sheets'},login.cookie),state=new URL(start.body.url).searchParams.get('state');
    assert.equal((await request(`/api/oauth/google/callback?state=${state}&code=sheets`,undefined,login.cookie+'; '+start.cookie)).status,303);
    const w=(await request('/api/workspaces',{name:'Private workspace'},login.cookie)).body;workspaces.push(w);
    const linked=await request(`/api/workspaces/${w.id}/sheet`,{mode:'existing',sheetId:'shared-source-123'},login.cookie);jobs.push(linked.body.jobId);
  }
  assert.notEqual(jobs[0],jobs[1]);
  await request('/api/settings',{provider:'anthropic',model:'private-choice',apiKey:'owner-private-key',enabled:false},first.cookie);
  assert.equal((await request(`/api/workspaces/${workspaces[0].id}/import-sheet`,{automatic:true,jobId:jobs[0]},second.cookie)).status,404);
  assert.equal((await request(`/api/workspaces/${workspaces[1].id}/import-sheet`,{automatic:true,jobId:jobs[0]},second.cookie)).status,404);
  for(let i=0;i<12;i++){
    const r=await request(`/api/workspaces/${workspaces[1].id}/import-sheet`,{automatic:true,jobId:jobs[1]},second.cookie);
    assert.equal(r.status,200);if(r.body.status==='waiting'){assert.match(r.body.error,/API key/);break;}
  }
  const member=(await request('/api/state',undefined,second.cookie)).body,ownerState=(await request('/api/state',undefined,first.cookie)).body;
  assert.equal(member.settings.hasKey,false);assert.equal(member.settings.model,'');assert.equal(member.workspaces.length,1);assert.equal(member.contacts.length,1);
  assert.ok(!JSON.stringify(member).includes(jobs[0]));assert.ok(!JSON.stringify(member).includes('private-choice'));
  assert.equal(ownerState.workspaces[0].sheetImport.jobId,jobs[0]);assert.equal(ownerState.workspaces[0].sheetImport.phase,'repair');
});

test('first visit is setup, all CRM APIs and assets require authentication, setup preserves data',async t=>{
  const {request,dataDir}=await setup(t);
  const page=await request('/');assert.match(page.text,/auth-form/);assert.ok(!page.text.includes('src="./app.js"'));
  assert.deepEqual((await request('/api/auth/session')).body,{authenticated:false,setupRequired:true,registrationOpen:true,googleConfigured:true,user:null});
  for(const path of ['/api/state','/api/oauth/google/callback?state=fake','/assets/private-image'])assert.equal((await request(path)).status,401,path);
  for(const path of ['/api/settings','/api/settings/models','/api/workspaces','/api/contacts','/api/uploads','/api/assets','/api/attachments','/api/templates','/api/connect/google','/api/disconnect','/api/import-legacy','/api/campaigns/fake/send'])assert.equal((await request(path,{})).status,401,path);
  assert.equal((await request('/api/auth/setup',{...owner,password:'short'})).status,400);
  assert.equal((await request('/api/auth/setup',owner,'',{origin:'https://attacker.example'})).status,403);
  assert.equal((await request('/api/auth/setup',owner,'',{'x-gather-client':''})).status,403);
  const created=await request('/api/auth/setup',owner);assert.equal(created.status,201);
  assert.match(created.headers.get('set-cookie'),/HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800/);
  const raw=readFileSync(join(dataDir,'auth.json'),'utf8');
  assert.ok(!raw.includes(owner.password));assert.ok(!raw.includes(created.cookie.split('=')[1]));
  assert.equal(statSync(join(dataDir,'auth.json')).mode & 0o777,0o600);
  assert.equal((await request('/api/auth/setup',owner)).status,409);
  assert.equal((await request('/api/auth/session',undefined,created.cookie)).body.user.email,owner.email);
  const ws=await request('/api/workspaces',{name:'Existing CRM'},created.cookie);assert.equal(ws.status,201);
  const state=await request('/api/state',undefined,created.cookie);
  assert.equal(state.body.workspaces[0].name,'Existing CRM');assert.equal(state.body.user.passwordHash,undefined);
  assert.ok(!state.text.includes('passwordHash'));assert.ok(!state.text.includes('sessions'));
  assert.match((await request('/',undefined,created.cookie)).text,/src=".\/app.js"/);
  assert.equal((await request('/login',undefined,created.cookie)).status,303);
  for(const path of ['/auth.mjs','/data/auth.json','/data/gather.json'])assert.equal((await request(path,undefined,created.cookie)).status,404);
  const asset=await request('/api/assets',{name:'pixel.png',mime:'image/png',data:'aGVsbG8='},created.cookie);
  assert.equal((await request('/assets/'+asset.body.id)).status,401);
  assert.equal((await request('/assets/'+asset.body.id,undefined,created.cookie)).status,200);
});

test('login rotates tokens, logout revokes only that session, and server restart retains accounts',async t=>{
  const {request,dataDir,start,server}=await setup(t);
  const created=await request('/api/auth/setup',owner);
  assert.equal((await request('/api/auth/login',{...owner,password:'wrong'})).status,401);
  assert.equal((await request('/api/auth/login',{...owner,email:'stranger@example.com'})).status,401);
  const login=await request('/api/auth/login',{...owner,email:'OWNER@example.com'},created.cookie);
  assert.equal(login.status,200);assert.notEqual(login.cookie,created.cookie);
  assert.equal((await request('/api/state',undefined,created.cookie)).status,401);
  const other=await request('/api/auth/login',owner);
  assert.equal((await request('/api/auth/logout',{},login.cookie)).status,200);
  assert.equal((await request('/api/state',undefined,login.cookie)).status,401);
  assert.equal((await request('/api/state',undefined,other.cookie)).status,200);
  assert.equal((await request('/api/state',undefined,'gather_session=forged-token')).status,401);
  await new Promise(resolve=>server.close(resolve));
  const restarted=await start();
  assert.equal((await restarted.request('/api/auth/session')).body.setupRequired,false);
  assert.equal((await restarted.request('/api/state',undefined,other.cookie)).status,200);
  assert.equal((await restarted.request('/api/auth/login',owner)).status,200);
  assert.ok(readFileSync(join(dataDir,'gather.json'),'utf8').length);
});

test('password change requires the current password and invalidates all previous sessions',async t=>{
  const {request}=await setup(t);
  const first=await request('/api/auth/setup',owner),other=await request('/api/auth/login',owner);
  const password='the replacement passphrase';
  assert.equal((await request('/api/auth/password',{currentPassword:'wrong',password},first.cookie)).status,400);
  assert.equal((await request('/api/state',undefined,first.cookie)).status,200);
  const changed=await request('/api/auth/password',{currentPassword:owner.password,password},first.cookie);assert.equal(changed.status,200);
  for(const cookie of [first.cookie,other.cookie])assert.equal((await request('/api/state',undefined,cookie)).status,401);
  assert.equal((await request('/api/state',undefined,changed.cookie)).status,200);
  assert.equal((await request('/api/auth/login',owner)).status,401);
  assert.equal((await request('/api/auth/login',{...owner,password})).status,200);
});

test('expired sessions fail on API, assets and HTML; Google callback is bound to the initiating login',async t=>{
  const {request,dataDir,start,server}=await setup(t);
  const first=await request('/api/auth/setup',owner),other=await request('/api/auth/login',owner);
  const google=await request('/api/connect/google',{kind:'gmail'},first.cookie);
  const state=new URL(google.body.url).searchParams.get('state');
  assert.equal((await request(`/api/oauth/google/callback?state=${state}&code=test`,undefined,other.cookie+'; '+google.cookie)).status,400);
  await new Promise(resolve=>server.close(resolve));
  const path=join(dataDir,'auth.json'),auth=JSON.parse(readFileSync(path,'utf8'));auth.sessions.forEach(s=>s.expiresAt=Date.now()-1);writeFileSync(path,JSON.stringify(auth));
  const restarted=await start();
  assert.equal((await restarted.request('/api/state',undefined,first.cookie)).status,401);
  assert.equal((await restarted.request('/assets/fake',undefined,first.cookie)).status,401);
  assert.match((await restarted.request('/',undefined,first.cookie)).text,/auth-form/);
});

test('repeated password failures are rate limited, including after restarting',async t=>{
  const {request,server,start}=await setup(t);
  await request('/api/auth/setup',owner);
  for(let i=0;i<10;i++)assert.equal((await request('/api/auth/login',{...owner,password:'wrong'})).status,401);
  assert.equal((await request('/api/auth/login',owner)).status,429);
  await new Promise(resolve=>server.close(resolve));
  const restarted=await start();assert.equal((await restarted.request('/api/auth/login',owner)).status,429);
});

test('parallel setup requests create exactly one owner, invalid auth payloads are rejected',async t=>{
  const {request}=await setup(t);
  assert.equal((await request('/api/auth/setup',null)).status,400);
  assert.equal((await request('/api/auth/setup',{...owner,password:'x'.repeat(9000)})).status,413);
  const results=await Promise.all([request('/api/auth/setup',owner),request('/api/auth/setup',{...owner,email:'second@example.com'})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
});

test('adding authentication to an existing installation preserves its CRM records',async t=>{
  const {server,dataDir,start}=await setup(t);
  await new Promise(resolve=>server.close(resolve));
  const path=join(dataDir,'gather.json'),data=JSON.parse(readFileSync(path,'utf8'));
  data.workspaces.push({id:'existing-workspace',name:'Previous event',sheetId:'existing-sheet'});
  data.contacts.push({id:'existing-contact',workspace:'existing-workspace',business:'Existing business',emails:['contact@example.com'],phones:['+919999999999']});
  writeFileSync(path,JSON.stringify(data));
  const {request}=await start();
  assert.equal((await request('/api/state')).status,401);
  const created=await request('/api/auth/setup',owner);
  const state=(await request('/api/state',undefined,created.cookie)).body;
  assert.deepEqual(state.workspaces,data.workspaces);assert.deepEqual(state.contacts,data.contacts);
});

function googleMock() {
  let identity={sub:'google-owner-123',email:'google@example.com',email_verified:true,name:'Google Owner'};
  const calls=[];
  return {calls,setIdentity:value=>{identity=value;},fetchImpl:async(url,init)=>{
    calls.push({url,init});
    if(url==='https://oauth2.googleapis.com/token')return new Response(JSON.stringify({access_token:'google-test-access'}),{status:200});
    if(url==='https://openidconnect.googleapis.com/v1/userinfo')return new Response(JSON.stringify(identity),{status:200});
    throw Error('Unexpected request');
  }};
}
async function googleStart(request,cookie='',body={}) {
  const started=await request('/api/auth/google',body,cookie);assert.equal(started.status,200);
  const url=new URL(started.body.url),state=url.searchParams.get('state');
  return {...started,url,callback:`/api/auth/google/callback?state=${state}&code=google-code`,cookies:[cookie,started.cookie].filter(Boolean).join('; ')};
}

test('Google creates the initial owner, uses PKCE and minimal scopes, and signs in by stable Google ID',async t=>{
  const mock=googleMock(),{request,dataDir}=await setup(t,{fetchImpl:mock.fetchImpl});
  const start=await googleStart(request,'',{returnHash:'#settings'});
  assert.equal(start.url.searchParams.get('scope'),'openid email profile');
  assert.equal(start.url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(new URL(start.url.searchParams.get('redirect_uri')).pathname,'/api/auth/google/callback');
  const callback=await request(start.callback,undefined,start.cookies);
  assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/#settings');
  const tokenForm=new URLSearchParams(mock.calls[0].init.body);
  assert.equal(tokenForm.get('code_verifier').length,43);assert.equal(tokenForm.get('client_secret'),'secret');
  assert.equal(mock.calls[1].init.headers.authorization,'Bearer google-test-access');
  const state=(await request('/api/state',undefined,callback.cookie)).body;
  assert.equal(state.user.email,'google@example.com');assert.equal(state.user.googleLinked,true);assert.equal(state.user.hasPassword,false);
  assert.equal(state.connections.gmail.connected,false);assert.equal(state.connections.sheets.connected,false);
  assert.ok(!readFileSync(join(dataDir,'auth.json'),'utf8').includes('google-test-access'));
  await request('/api/auth/logout',{},callback.cookie);
  mock.setIdentity({sub:'google-owner-123',email:'renamed@example.com',email_verified:true});
  const returning=await googleStart(request);const login=await request(returning.callback,undefined,returning.cookies);
  assert.equal(login.headers.get('location'),'/#workspaces');
  assert.equal((await request('/api/state',undefined,login.cookie)).status,200);
  const password='new password for Google';
  assert.equal((await request('/api/auth/password',{password},login.cookie)).status,200);
  assert.equal((await request('/api/auth/login',{email:'google@example.com',password})).status,200);
});

test('Google cannot take over a password account by email; owner explicitly links it while signed in',async t=>{
  const mock=googleMock(),{request}=await setup(t,{fetchImpl:mock.fetchImpl});
  mock.setIdentity({sub:'same-email-google',email:owner.email,email_verified:true});
  const created=await request('/api/auth/setup',owner);
  const unlinked=await googleStart(request);const denied=await request(unlinked.callback,undefined,unlinked.cookies);
  assert.equal(denied.headers.get('location'),'/login?google_error=link_required');
  assert.equal((await request('/api/auth/google',{mode:'link'})).status,401);
  const link=await googleStart(request,created.cookie,{mode:'link'});
  const linked=await request(link.callback,undefined,link.cookies);
  assert.equal((await request('/api/state',undefined,linked.cookie)).body.user.googleLinked,true);
  await request('/api/auth/logout',{},linked.cookie);
  const next=await googleStart(request),login=await request(next.callback,undefined,next.cookies);
  assert.equal((await request('/api/state',undefined,login.cookie)).status,200);
  mock.setIdentity({sub:'someone-else',email:owner.email,email_verified:true});
  const wrong=await googleStart(request),wrongResult=await request(wrong.callback,undefined,wrong.cookies);
  assert.equal(wrongResult.headers.get('location'),'/login?google_error=wrong_account');
});

test('Google callback rejects missing browser cookies, replay, revoked linking sessions and cancellation',async t=>{
  const mock=googleMock(),{request}=await setup(t,{fetchImpl:mock.fetchImpl});
  const missing=await googleStart(request);
  assert.equal((await request(missing.callback)).headers.get('location'),'/login?google_error=expired');
  assert.equal((await request(missing.callback,undefined,missing.cookies)).headers.get('location'),'/login?google_error=expired');
  const cancelled=await googleStart(request);
  assert.equal((await request(cancelled.callback+'&error=access_denied',undefined,cancelled.cookies)).headers.get('location'),'/login?google_error=cancelled');
  const created=await request('/api/auth/setup',owner),link=await googleStart(request,created.cookie,{mode:'link'});
  await request('/api/auth/logout',{},created.cookie);
  assert.equal((await request(link.callback,undefined,link.cookies)).headers.get('location'),'/login?google_error=expired');
  assert.equal(mock.calls.length,0);
});

test('Google verifies identity and rejects setup races and unsafe return URLs',async t=>{
  const mock=googleMock(),{request}=await setup(t,{fetchImpl:mock.fetchImpl});
  mock.setIdentity({sub:'unverified',email:'email@example.com',email_verified:false});
  const unverified=await googleStart(request,'',{returnHash:'//attacker.example'});
  assert.equal((await request(unverified.callback,undefined,unverified.cookies)).headers.get('location'),'/login?google_error=unverified');
  assert.equal((await request('/api/auth/session')).body.setupRequired,true);
  const pending=await googleStart(request);
  await request('/api/auth/setup',owner);
  assert.equal((await request(pending.callback,undefined,pending.cookies)).headers.get('location'),'/login?google_error=account_changed');
  assert.equal(mock.calls.length,2);
});

test('Google configuration and upstream failures give safe errors without changing account state',async t=>{
  const disabled=await setup(t,{env:{}});
  assert.equal((await disabled.request('/api/auth/session')).body.googleConfigured,false);
  assert.equal((await disabled.request('/api/auth/google',{})).status,409);
  const {request}=await setup(t,{fetchImpl:async()=>{throw Error('secret upstream error');}});
  const start=await googleStart(request),response=await request(start.callback,undefined,start.cookies);
  assert.equal(response.headers.get('location'),'/login?google_error=failed');
  assert.ok(!response.text.includes('secret'));
  assert.equal((await request('/api/auth/session')).body.setupRequired,true);
});

test('registration stays open; members have isolated workspaces, images, settings and templates',async t=>{
  const {request,start,server}=await setup(t);
  const admin=await request('/api/auth/setup',owner);
  const aw=(await request('/api/workspaces',{name:'Admin private'},admin.cookie)).body;
  const ai=(await request('/api/assets',{name:'admin.png',mime:'image/png',data:'YWRtaW4='},admin.cookie)).body;
  const at=(await request('/api/templates',{workspace:aw.id,name:'Admin template',subject:'Private',body:'Message',assetIds:[ai.id]},admin.cookie)).body;
  await request('/api/settings',{provider:'gemini',enabled:false,apiKey:'private-admin-key'},admin.cookie);
  const memberDetails={name:'Member',email:'member@example.com',password:'separate member password',role:'superadmin'};
  const member=await request('/api/auth/register',memberDetails);
  assert.equal(member.status,201);assert.equal(member.body.user.role,'member');
  assert.equal((await request('/api/auth/session')).body.registrationOpen,true);
  const empty=(await request('/api/state',undefined,member.cookie)).body;
  for(const name of ['workspaces','contacts','templates','assets','campaigns'])assert.deepEqual(empty[name],[]);
  assert.equal(empty.settings.hasKey,false);assert.equal(empty.connections.gmail.connected,false);
  assert.equal((await request('/assets/'+ai.id,undefined,member.cookie)).status,404);
  assert.equal((await request('/api/contacts',{workspace:aw.id,name:'Intruder'},member.cookie)).status,404);
  assert.equal((await request('/api/templates',{id:at.id,workspace:aw.id,name:'Overwrite',subject:'x',body:'x'},member.cookie)).status,404);
  assert.equal((await request('/api/copy',{source:aw.id,destination:aw.id,ids:[]},member.cookie)).status,404);
  assert.equal((await request('/api/import-legacy',{workspaces:[]},member.cookie)).status,403);
  const mw=(await request('/api/workspaces',{name:'Member private'},member.cookie)).body;
  assert.equal((await request('/api/templates',{workspace:mw.id,name:'Borrowed image',subject:'x',body:'x',assetIds:[ai.id]},member.cookie)).status,400);
  const mi=(await request('/api/assets',{name:'member.png',mime:'image/png',data:'bWVtYmVy'},member.cookie)).body;
  assert.equal((await request('/assets/'+mi.id,undefined,admin.cookie)).status,404);
  assert.equal((await request('/api/auth/register',{...memberDetails,email:'MEMBER@example.com'})).status,409);
  assert.equal((await request('/api/auth/login',{...memberDetails,password:owner.password})).status,401);
  assert.equal((await request('/api/settings',{provider:'gemini',enabled:false},member.cookie,{'x-gather-account':admin.body.user.id})).status,409);
  await new Promise(resolve=>server.close(resolve));
  const next=await start();
  assert.deepEqual((await next.request('/api/state',undefined,member.cookie)).body.workspaces.map(w=>w.name),['Member private']);
  assert.deepEqual((await next.request('/api/state',undefined,admin.cookie)).body.workspaces.map(w=>w.name),['Admin private']);
  assert.equal((await next.request('/assets/'+mi.id,undefined,member.cookie)).text,'member');
  assert.equal((await next.request('/api/auth/login',memberDetails)).status,200);
});

test('member password changes and lockouts do not revoke or lock other accounts',async t=>{
  const {request}=await setup(t);
  const admin=await request('/api/auth/setup',owner);
  const details={name:'Member',email:'member@example.com',password:'member old password'};
  const first=await request('/api/auth/register',details),other=await request('/api/auth/login',details);
  const changed=await request('/api/auth/password',{currentPassword:details.password,password:'member replacement password'},first.cookie);
  assert.equal(changed.status,200);
  assert.equal((await request('/api/state',undefined,other.cookie)).status,401);
  assert.equal((await request('/api/state',undefined,admin.cookie)).status,200);
  assert.equal((await request('/api/state',undefined,changed.cookie)).body.user.email,details.email);
  for(let i=0;i<10;i++)assert.equal((await request('/api/auth/login',{...details,password:'wrong'})).status,401);
  assert.equal((await request('/api/auth/login',{...details,password:'member replacement password'})).status,429);
  assert.equal((await request('/api/auth/login',owner)).status,200);
});

test('new Google users register independently and existing Google users return to their own data',async t=>{
  const mock=googleMock(),{request}=await setup(t,{fetchImpl:mock.fetchImpl});
  const admin=await request('/api/auth/setup',owner);
  await request('/api/workspaces',{name:'Admin private'},admin.cookie);
  const first=await googleStart(request),created=await request(first.callback,undefined,first.cookies);
  assert.equal(created.headers.get('location'),'/#workspaces');
  const state=(await request('/api/state',undefined,created.cookie)).body;
  assert.equal(state.user.role,'member');assert.equal(state.user.googleLinked,true);assert.deepEqual(state.workspaces,[]);
  await request('/api/workspaces',{name:'Google private'},created.cookie);
  await request('/api/auth/logout',{},created.cookie);
  const returning=await googleStart(request),loggedIn=await request(returning.callback,undefined,returning.cookies);
  assert.deepEqual((await request('/api/state',undefined,loggedIn.cookie)).body.workspaces.map(w=>w.name),['Google private']);
  const link=await googleStart(request,admin.cookie,{mode:'link'});
  const denied=await request(link.callback,undefined,link.cookies);
  assert.equal(denied.headers.get('location'),'/login?google_error=already_linked');
  assert.equal((await request('/api/state',undefined,admin.cookie)).body.user.googleLinked,false);
});

test('Google consent for a member cannot be completed using another account session',async t=>{
  const mock=googleMock(),{request}=await setup(t,{fetchImpl:mock.fetchImpl});
  const admin=await request('/api/auth/setup',owner);
  const member=await request('/api/auth/register',{name:'Member',email:'member@example.com',password:'private member password'});
  const link=await googleStart(request,member.cookie,{mode:'link'});
  const denied=await request(link.callback,undefined,admin.cookie+'; '+link.cookie);
  assert.equal(denied.headers.get('location'),'/login?google_error=expired');assert.equal(mock.calls.length,0);
  const connector=await request('/api/connect/google',{kind:'gmail'},member.cookie);
  const state=new URL(connector.body.url).searchParams.get('state');
  assert.equal((await request('/api/oauth/google/callback?state='+state+'&code=test',undefined,admin.cookie+'; '+connector.cookie)).status,400);
  assert.equal((await request('/api/state',undefined,admin.cookie)).body.connections.gmail.connected,false);
});

test('legacy owner sessions migrate without changing the owner data or assigning it to new users',async t=>{
  const {request,server,dataDir,start}=await setup(t);
  const admin=await request('/api/auth/setup',owner);
  const original=(await request('/api/workspaces',{name:'Legacy private'},admin.cookie)).body;
  await new Promise(resolve=>server.close(resolve));
  const path=join(dataDir,'auth.json'),auth=JSON.parse(readFileSync(path,'utf8'));
  delete auth.users;delete auth.accountFailures;delete auth.registrations;auth.sessions.forEach(s=>delete s.userId);
  writeFileSync(path,JSON.stringify(auth));
  const next=await start();
  assert.equal((await next.request('/api/state',undefined,admin.cookie)).body.workspaces[0].id,original.id);
  const member=await next.request('/api/auth/register',{name:'New',email:'new@example.com',password:'new account password'});
  assert.equal(member.status,201);assert.deepEqual((await next.request('/api/state',undefined,member.cookie)).body.workspaces,[]);
  assert.equal((await next.request('/api/state',undefined,admin.cookie)).body.user.role,'superadmin');
});
