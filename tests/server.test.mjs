import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGather} from '../server.mjs';

const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=';
const image={name:'test-card.png',mime:'image/png',data:pixel};
async function setup(t,options={}) {
  const dataDir=mkdtempSync(join(tmpdir(),'gather-test-'));
  const app=createGather({dataDir,...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.server.closeAllConnections();app.server.close(resolve);}));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  if(options.env?.GATHER_HOSTED==='1')options.env.GATHER_PUBLIC_ORIGIN=base.replace('http:','https:');
  let sessionCookie='';
  const request=async(path,body,extra={})=>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-gather-client':'1',...extra.headers,cookie:[sessionCookie,extra.headers?.cookie].filter(Boolean).join('; ')},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual'});
    let json;try{json=await response.json();}catch{}
    return {status:response.status,body:json,headers:response.headers};
  };
  const owner=await request('/api/auth/setup',{name:'Test Owner',email:'owner@example.com',password:'test-only-passphrase'});
  assert.equal(owner.status,201);sessionCookie=owner.headers.get('set-cookie').split(';')[0];
  return {...app,dataDir,base,request};
}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function upstreamMock(){
  let counter=0,scope='',sends=[],failure=false;const sheets=new Map();
  const fetchImpl=async(url,init={})=>{
    if(url==='https://oauth2.googleapis.com/token') {
      const form=new URLSearchParams(init.body);scope=form.get('code');
      return json({access_token:'access-'+scope,refresh_token:'refresh-'+scope,expires_in:3600,scope:`openid email https://www.googleapis.com/auth/${scope==='gmail'?'gmail.send':'spreadsheets'}`});
    }
    if(url==='https://openidconnect.googleapis.com/v1/userinfo')return json({email:'sender@example.com',email_verified:true});
    if(url==='https://sheets.googleapis.com/v4/spreadsheets'){
      const id='spreadsheet-'+(++counter);sheets.set(id,[]);return json({spreadsheetId:id,properties:{title:JSON.parse(init.body).properties.title},sheets:[{properties:{title:'Gather Contacts'}}]});
    }
    if(url.includes('sheets.googleapis.com')){
      const id=url.split('/spreadsheets/')[1].split('/')[0],rows=sheets.get(id)||[];
      if(url.includes('values:batchUpdate')) {
        for(const item of JSON.parse(init.body).data){const index=Number(item.range.match(/!A(\d+)/)[1])-1;item.values.forEach((row,i)=>{rows[index+i] ||= [];row.forEach((value,column)=>{rows[index+i][column]=value;});});}sheets.set(id,rows);return json({});
      }
      if(url.includes(':append')){rows.push(...JSON.parse(init.body).values);sheets.set(id,rows);return json({});}
      if(url.includes('/values/'))return json({values:rows});
      return json({spreadsheetId:id,properties:{title:'Existing'},sheets:[{properties:{title:'Gather Contacts'}}]});
    }
    if(url==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      sends.push(Buffer.from(JSON.parse(init.body).raw,'base64url').toString());
      if(failure)throw Error('Transport lost after submission');
      return json({id:'gmail-message-'+sends.length});
    }
    if(url.includes('generativelanguage.googleapis.com'))return json({candidates:[{content:{parts:[{text:JSON.stringify({name:'Person',business:'Example business',role:'Director',emails:['one@example.com','two@example.com'],phones:['+91 9000012345','+91 9000054321']})}]}}]});
    throw Error('Unexpected upstream URL: '+url);
  };
  return {fetchImpl,sheets,sends,setFailure:()=>failure=true};
}
async function connect(request,kind){
  const start=await request('/api/connect/google',{kind});assert.equal(start.status,200);
  const state=new URL(start.body.url).searchParams.get('state');const cookie=start.headers.get('set-cookie').split(';')[0];
  const callback=await request(`/api/oauth/google/callback?state=${state}&code=${kind}`,undefined,{headers:{cookie}});assert.equal(callback.status,303);
}

test('separate workspaces, templates and copied contacts persist across restart',async t=>{
  const {request,dataDir,server}=await setup(t);
  const one=(await request('/api/workspaces',{name:'Expo'})).body;
  const two=(await request('/api/workspaces',{name:'Diwali'})).body;
  const contact=(await request('/api/contacts',{workspace:one.id,name:'Alice',business:'Example',emails:['alice@example.com','sales@example.com'],phones:['+91 9000012345']})).body;
  const template=await request('/api/templates',{workspace:one.id,name:'Hello',subject:'Hello',body:'Hi {{contact_name}}',assetIds:[]});assert.equal(template.status,200);
  assert.equal((await request('/api/copy',{source:one.id,destination:two.id,ids:[contact.id]})).body.count,1);
  let state=(await request('/api/state')).body;
  assert.equal(state.contacts.length,1);assert.equal(state.uploads[0].workspace,two.id);assert.equal(state.templates[0].workspace,one.id);
  await request(`/api/uploads/${state.uploads[0].id}/review`,{action:'save',contact:state.uploads[0].fields});
  state=(await request('/api/state')).body;assert.equal(state.contacts.length,2);assert.notEqual(state.contacts[0].workspace,state.contacts[1].workspace);
  const restarted=createGather({dataDir});assert.equal(restarted.publicState().contacts.length,2);restarted.server.close();
  assert.equal((await request('/data/gather.json')).status,404);
});
test('uploaded images survive without an LLM and duplicate resolution never drops pending rows',async t=>{
  const {request}=await setup(t);const ws=(await request('/api/workspaces',{name:'Expo'})).body;
  const uploads=(await request('/api/uploads',{workspace:ws.id,files:[image,image]})).body;
  assert.equal(uploads.length,2);assert.equal((await request(`/api/uploads/${uploads[0].id}/extract`,{})).status,409);
  const contact={business:'Example',name:'Alice',emails:['sales@example.com','alice@example.com'],phones:['+91 9000012345']};
  await request(`/api/uploads/${uploads[0].id}/review`,{action:'save',contact});
  assert.equal((await request(`/api/uploads/${uploads[1].id}/review`,{action:'save',contact})).status,409);
  let state=(await request('/api/state')).body;assert.equal(state.uploads.length,2);assert.notEqual(state.uploads[1].status,'approved');
  const result=await request(`/api/uploads/${uploads[1].id}/review`,{action:'merge',targetId:state.contacts[0].id,contact:{...contact,emails:['sales@example.com','other@example.com']}});assert.equal(result.status,200);
  state=(await request('/api/state')).body;assert.equal(state.contacts.length,1);assert.equal(state.contacts[0].emails.length,3);
  assert.equal((await request(`/api/uploads/${uploads[1].id}/review`,{action:'save',contact})).status,409);
});
test('settings store encrypted LLM credentials, redact them, and clear on provider changes',async t=>{
  const mock=upstreamMock();const {request,dataDir}=await setup(t,{fetchImpl:mock.fetchImpl});
  await request('/api/settings',{provider:'gemini',enabled:true,model:'test-vision-model',apiKey:'secret-test-key'});
  const state=(await request('/api/state')).body;
  assert.equal(state.settings.hasKey,true);assert.equal(state.settings.secret,undefined);
  assert.ok(!readFileSync(join(dataDir,'gather.json'),'utf8').includes('secret-test-key'));
  assert.equal((await request('/api/settings/test',{})).status,200);
  await request('/api/settings',{provider:'compatible',enabled:true,model:'local-vision',baseUrl:'http://localhost:1234/v1'});
  assert.equal((await request('/api/state')).body.settings.hasKey,false);
});
test('Google OAuth validates browser binding and exposes real connection state only',async t=>{
  const mock=upstreamMock();const {request}=await setup(t,{fetchImpl:mock.fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'test-client',GOOGLE_OAUTH_CLIENT_SECRET:'test-secret'}});
  assert.equal((await request('/api/state')).body.connections.gmail.connected,false);
  const start=await request('/api/connect/google',{kind:'gmail'});const state=new URL(start.body.url).searchParams.get('state');
  assert.equal((await request(`/api/oauth/google/callback?state=${state}&code=gmail`)).status,400);
  await connect(request,'gmail');
  const publicConnection=(await request('/api/state')).body.connections.gmail;
  assert.equal(publicConnection.connected,true);assert.equal(publicConnection.email,'sender@example.com');assert.equal(publicConnection.access,undefined);
  await request('/api/disconnect',{kind:'gmail'});assert.equal((await request('/api/state')).body.connections.gmail.connected,false);
});
test('card extraction keeps all returned emails and phone numbers and approves the contact',async t=>{
  const mock=upstreamMock();const {request}=await setup(t,{fetchImpl:mock.fetchImpl});
  const ws=(await request('/api/workspaces',{name:'Expo'})).body;
  await request('/api/settings',{provider:'gemini',enabled:true,model:'vision-test',apiKey:'fake-key'});
  const uploaded=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  const result=await request(`/api/uploads/${uploaded.id}/extract`,{});
  assert.equal(result.status,200);assert.equal(result.body.fields.emails.length,2);assert.equal(result.body.fields.phones.length,2);assert.equal(result.body.status,'approved');
  const state=(await request('/api/state')).body;assert.equal(state.contacts.length,1);assert.deepEqual(state.contacts[0].emails,['one@example.com','two@example.com']);
});
test('Sheets sync, frozen templates, distinct Gmail messages, images and repeat-send protection',async t=>{
  const mock=upstreamMock();const {request}=await setup(t,{fetchImpl:mock.fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'test-client',GOOGLE_OAUTH_CLIENT_SECRET:'test-secret',GATHER_TEST:'1'}});
  await connect(request,'gmail');await connect(request,'sheets');
  const ws=(await request('/api/workspaces',{name:'Expo'})).body;
  await request(`/api/workspaces/${ws.id}/sheet`,{mode:'create'});
  assert.equal((await request(`/api/workspaces/${ws.id}/sheet`,{mode:'create'})).status,400);
  const c1=(await request('/api/contacts',{workspace:ws.id,business:'Example',emails:['sales@example.com','owner@example.com'],phones:['+91 9000012345']})).body;
  const c2=(await request('/api/contacts',{workspace:ws.id,business:'Example 2',emails:['SALES@example.com']})).body;
  const asset=(await request('/api/assets',image)).body;
  const template=(await request('/api/templates',{workspace:ws.id,name:'First',subject:'Subject',body:'Hi {{contact_name}}, <script>alert(1)</script>',assetIds:[asset.id]})).body;
  const created=await request('/api/campaigns',{workspace:ws.id,name:'Campaign',templateId:template.id,contactIds:[c1.id,c2.id]});
  assert.equal(created.status,201);const campaign=created.body;assert.equal(campaign.recipients.length,2);assert.equal(mock.sends.length,0);
  assert.equal(mock.sheets.get('spreadsheet-1').length,3);
  await request('/api/templates',{...template,subject:'Changed later'});
  assert.equal((await request(`/api/campaigns/${campaign.id}/send`,{})).status,400);
  const sent=await request(`/api/campaigns/${campaign.id}/send`,{confirm:true});assert.equal(sent.body.status,'sent');assert.equal(mock.sends.length,2);
  assert.match(mock.sends[0],/To: sales@example.com\r\n/);assert.match(mock.sends[1],/To: owner@example.com\r\n/);
  assert.ok(!mock.sends[0].includes('Bcc:'));assert.match(mock.sends[0],/Content-ID:/);assert.match(mock.sends[0],/multipart\/related/);
  assert.equal(sent.body.subject,'Subject');assert.ok(sent.body.recipients.every(r=>r.messageId&&r.sentAt));
  assert.equal((await request(`/api/campaigns/${campaign.id}/send`,{confirm:true})).status,409);assert.equal(mock.sends.length,2);
});
test('uncertain delivery is not labelled sent and cannot be retried automatically',async t=>{
  const mock=upstreamMock();const {request}=await setup(t,{fetchImpl:mock.fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'test-client',GOOGLE_OAUTH_CLIENT_SECRET:'test-secret',GATHER_TEST:'1'}});
  await connect(request,'gmail');await connect(request,'sheets');const ws=(await request('/api/workspaces',{name:'Expo'})).body;await request(`/api/workspaces/${ws.id}/sheet`,{mode:'create'});
  const contact=(await request('/api/contacts',{workspace:ws.id,business:'ABC',emails:['a@example.com','b@example.com']})).body;
  const template=(await request('/api/templates',{workspace:ws.id,name:'T',subject:'S',body:'B',assetIds:[]})).body;
  const campaign=(await request('/api/campaigns',{workspace:ws.id,templateId:template.id,name:'Uncertain',contactIds:[contact.id]})).body;
  mock.setFailure();const result=(await request(`/api/campaigns/${campaign.id}/send`,{confirm:true})).body;
  assert.equal(result.status,'needs_attention');assert.equal(result.recipients[0].status,'unknown');assert.equal(result.recipients[1].status,'pending');assert.equal(mock.sends.length,1);
  assert.equal((await request(`/api/campaigns/${campaign.id}/send`,{confirm:true})).status,409);
});
test('local endpoints reject cross-origin writes and unconfigured sends',async t=>{
  const {request,base}=await setup(t);
  assert.equal((await request('/api/workspaces',{name:'bad'},{headers:{origin:'https://other.example'}})).status,403);
  const denied=await fetch(base+'/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'bad'})});assert.equal(denied.status,403);
  assert.equal((await request('/api/connect/google',{kind:'gmail'})).status,409);
  assert.equal((await request('/api/state')).body.workspaces.length,0);
});

test('model discovery loads every Gemini page without saving the typed key',async t=>{
  const calls=[];
  const {request,dataDir}=await setup(t,{fetchImpl:async(url,init)=>{
    calls.push({url,init});const page=new URL(url).searchParams.get('pageToken');
    return json(page?{models:[{name:'models/vision-pro',displayName:'Vision Pro',supportedGenerationMethods:['generateContent']},{name:'models/vision-fast',displayName:'Vision Fast',supportedGenerationMethods:['generateContent']}]}
      :{models:[{name:'models/vision-fast',displayName:'Vision Fast',description:'Fast image understanding',supportedGenerationMethods:['generateContent']},{name:'models/embed-only',displayName:'Embeddings',supportedGenerationMethods:['embedContent']}],nextPageToken:'page-two'});
  }});
  const result=await request('/api/settings/models',{provider:'gemini',apiKey:'typed-secret'});
  assert.equal(result.status,200);assert.equal(result.body.models.length,3);assert.equal(calls.length,2);
  assert.equal(result.body.models.find(m=>m.id==='embed-only').selectable,false);
  assert.equal(result.body.models.find(m=>m.id==='vision-pro').selectable,true);
  assert.ok(calls.every(c=>c.init.headers['x-goog-api-key']==='typed-secret'&&!c.url.includes('typed-secret')));
  assert.ok(!readFileSync(join(dataDir,'gather.json'),'utf8').includes('typed-secret'));
  assert.equal((await request('/api/state')).body.settings.hasKey,false);
});

test('model discovery uses a saved key only for its saved provider and endpoint',async t=>{
  const calls=[];
  const {request}=await setup(t,{fetchImpl:async(url,init)=>{calls.push({url,init});return json({data:[{id:'local-vision',name:'Local Vision'}]});}});
  await request('/api/settings',{provider:'compatible',enabled:true,model:'local-vision',baseUrl:'https://one.example/v1',apiKey:'saved-secret'});
  let result=await request('/api/settings/models',{provider:'compatible',baseUrl:'https://one.example/v1'});
  assert.equal(result.body.models[0].id,'local-vision');assert.equal(calls[0].init.headers.authorization,'Bearer saved-secret');
  assert.equal(calls[0].url,'https://one.example/v1/models');assert.equal(calls[0].init.redirect,'error');
  await request('/api/settings/models',{provider:'compatible',baseUrl:'https://two.example/v1'});
  assert.equal(calls[1].init.headers.authorization,undefined);
  result=await request('/api/settings/models',{provider:'gemini'});assert.equal(result.status,409);assert.equal(calls.length,2);
  assert.equal((await request('/api/state')).body.settings.model,'local-vision');
});

test('model discovery reports credential errors, empty catalogs and repeated pagination',async t=>{
  let mode='error';
  const {request}=await setup(t,{fetchImpl:async()=>mode==='error'?json({error:{message:'Invalid provider key'}},401):mode==='empty'?json({models:[]}):json({models:[],nextPageToken:'same-page'})});
  let result=await request('/api/settings/models',{provider:'gemini',apiKey:'bad-key'});
  assert.equal(result.status,502);assert.match(result.body.error,/Invalid provider key/);
  mode='empty';result=await request('/api/settings/models',{provider:'gemini',apiKey:'test-key'});assert.deepEqual(result.body.models,[]);
  mode='loop';result=await request('/api/settings/models',{provider:'gemini',apiKey:'test-key'});assert.equal(result.status,502);assert.match(result.body.error,/repeated/);
});

test('hosted campaigns checkpoint sending before Gmail and resume only untouched recipients',async t=>{
  const mock=upstreamMock();let dataDir;
  const fetchImpl=async(url,init)=>{
    if(url==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      const db=JSON.parse(readFileSync(join(dataDir,'gather.json'),'utf8'));
      assert.equal(db.campaigns[0].recipients.filter(r=>r.status==='sending').length,1);
    }
    return mock.fetchImpl(url,init);
  };
  const app=await setup(t,{fetchImpl,env:{GATHER_HOSTED:'1',GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret',GATHER_TEST:'1'}});
  dataDir=app.dataDir;const {request}=app;
  await connect(request,'gmail');await connect(request,'sheets');
  const ws=(await request('/api/workspaces',{name:'Hosted campaign'})).body;
  await request(`/api/workspaces/${ws.id}/sheet`,{mode:'create'});
  const contact=(await request('/api/contacts',{workspace:ws.id,business:'Example',emails:['one@example.com','two@example.com','three@example.com']})).body;
  const template=(await request('/api/templates',{workspace:ws.id,name:'Template',subject:'Hi',body:'Hello',assetIds:[]})).body;
  const campaign=(await request('/api/campaigns',{workspace:ws.id,name:'Hosted send',templateId:template.id,contactIds:[contact.id]})).body;
  for(let i=1;i<=3;i++) {
    const result=await request(`/api/campaigns/${campaign.id}/send`,{confirm:true});
    assert.equal(result.status,200);assert.equal(mock.sends.length,i);
    assert.equal(result.body.status,i===3?'sent':'paused');
    assert.equal(result.body.recipients.filter(r=>r.status==='sent').length,i);
  }
  assert.equal((await request(`/api/campaigns/${campaign.id}/send`,{confirm:true})).status,409);
  assert.equal(new Set(mock.sends.map(m=>m.match(/To: ([^\r]+)/)[1])).size,3);
});

test('card uploads queue automatically, wait for AI setup, and repeated queue requests do not re-read results',async t=>{
  let calls=0;
  const {request}=await setup(t,{fetchImpl:async()=>{calls++;return json({candidates:[{content:{parts:[{text:JSON.stringify({name:'Card Name',business:'Sample Studio',emails:['first@example.com','second@example.com'],phones:['+1 202-555-0101'],notes:''})}]}}]});}});
  const ws=(await request('/api/workspaces',{name:'Auto scan'})).body;
  const upload=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  assert.equal(upload.extractionState,'needs_setup');assert.equal(calls,0);
  await request('/api/settings',{provider:'gemini',enabled:true,model:'vision-test',apiKey:'test-key'});
  let state=(await request('/api/state')).body;
  assert.equal(state.settings.extractionReady,true);assert.equal(state.uploads[0].extractionState,'queued');
  const result=await request(`/api/uploads/${upload.id}/extract`,{automatic:true});
  assert.equal(result.body.status,'approved');assert.equal(result.body.extractionState,'complete');assert.equal(result.body.fields.emails.length,2);
  await request(`/api/uploads/${upload.id}/extract`,{automatic:true});assert.equal(calls,1);
  state=(await request('/api/state')).body;assert.equal(state.contacts.length,1);assert.equal(state.contacts[0].name,'Card Name');
  await request(`/api/uploads/${upload.id}/extract`,{automatic:true});assert.equal(calls,1);
  assert.equal((await request('/api/state')).body.contacts[0].name,'Card Name');
  const waiting=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];assert.equal(waiting.extractionState,'queued');
  await request('/api/settings',{provider:'gemini',enabled:false,model:'vision-test'});
  assert.equal((await request('/api/state')).body.uploads[1].extractionState,'needs_setup');
});

test('automatic reading failures preserve cards and require an explicit retry',async t=>{
  let calls=0;
  const {request}=await setup(t,{fetchImpl:async()=>{calls++;return calls===1?json({error:{message:'Provider quota exceeded'}},429):json({candidates:[{content:{parts:[{text:'{"business":"Recovered","emails":["hello@example.com"]}'}]}}]});}});
  const ws=(await request('/api/workspaces',{name:'Retry scanning'})).body;
  await request('/api/settings',{provider:'gemini',enabled:true,model:'vision-test',apiKey:'test-key'});
  const upload=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  assert.equal((await request(`/api/uploads/${upload.id}/extract`,{automatic:true})).status,502);
  let row=(await request('/api/state')).body.uploads[0];assert.equal(row.extractionState,'failed');assert.equal(row.status,'needs_attention');assert.equal(row.assetId,upload.assetId);
  await request(`/api/uploads/${upload.id}/extract`,{automatic:true});assert.equal(calls,1);
  const retried=await request(`/api/uploads/${upload.id}/extract`,{});assert.equal(retried.body.extractionState,'complete');assert.equal(calls,2);
});

test('automatic extraction approves, merges a unique phone duplicate, and syncs the spreadsheet',async t=>{
  const mock=upstreamMock();const {request}=await setup(t,{fetchImpl:mock.fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'test-client',GOOGLE_OAUTH_CLIENT_SECRET:'test-secret'}});
  await connect(request,'sheets');
  const ws=(await request('/api/workspaces',{name:'Automatic approval'})).body;
  const sheet=(await request(`/api/workspaces/${ws.id}/sheet`,{mode:'create'})).body.sheetId;
  const existing=(await request('/api/contacts',{workspace:ws.id,name:'Existing name',business:'Example business',emails:['existing@example.com'],phones:['+91 9000012345']})).body;
  await request('/api/settings',{provider:'gemini',enabled:true,model:'vision-test',apiKey:'test-key'});
  const upload=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  const extracted=await request(`/api/uploads/${upload.id}/extract`,{automatic:true});
  assert.equal(extracted.status,200);assert.equal(extracted.body.status,'approved');assert.equal(extracted.body.contactId,existing.id);
  const state=(await request('/api/state')).body;
  assert.equal(state.contacts.length,1);assert.equal(state.uploads[0].status,'approved');
  assert.deepEqual(state.contacts[0].emails,['existing@example.com','one@example.com','two@example.com']);
  assert.deepEqual(state.contacts[0].phones,['+91 9000012345','+91 9000054321']);
  assert.equal(mock.sheets.get(sheet).length,2);assert.equal(mock.sheets.get(sheet)[1][0],existing.id);
  assert.match(mock.sheets.get(sheet)[1][4],/two@example.com/);assert.equal(mock.sends.length,0);
});

test('automatic extraction does not merge contacts using only a shared business name',async t=>{
  let calls=0;const {request}=await setup(t,{fetchImpl:async()=>{calls++;return json({candidates:[{content:{parts:[{text:JSON.stringify({name:'Second person',business:'Shared Company',emails:['second@example.com'],phones:['+1 202-555-0199']})}]}}]});}});
  const ws=(await request('/api/workspaces',{name:'Business names'})).body;
  await request('/api/contacts',{workspace:ws.id,name:'First person',business:'Shared Company',emails:['first@example.com'],phones:['+1 202-555-0101']});
  await request('/api/settings',{provider:'gemini',enabled:true,model:'vision-test',apiKey:'test-key'});
  const upload=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  const extracted=await request(`/api/uploads/${upload.id}/extract`,{automatic:true});
  assert.equal(extracted.status,200);assert.equal(extracted.body.status,'approved');assert.equal(calls,1);
  const state=(await request('/api/state')).body;assert.equal(state.contacts.length,2);
  assert.deepEqual(state.contacts.map(contact=>contact.emails[0]).sort(),['first@example.com','second@example.com']);
});

test('AI-completed cards from the previous review flow approve once without another model request',async t=>{
  let modelCalls=0;const {request,publicState}=await setup(t,{fetchImpl:async()=>{modelCalls++;return json({});}});
  const ws=(await request('/api/workspaces',{name:'Existing reviews'})).body;
  const existing=(await request('/api/contacts',{workspace:ws.id,name:'Rounak',business:'Harbor Digital Studio',emails:['first@example.com'],phones:['+1 202-555-0102']})).body;
  const upload=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  const stored=publicState().uploads.find(row=>row.id===upload.id);
  Object.assign(stored,{status:'review',extractionState:'complete',fields:{name:'Rounak',business:'Harbor Digital Studio',role:'Project Consultant',emails:['second@example.com'],phones:['+1 202-555-0102'],notes:'',excludedEmails:[]}});
  const result=await request('/api/uploads/approve-extracted',{});
  assert.equal(result.status,200);assert.deepEqual(result.body,{approved:1,needsAttention:0});assert.equal(modelCalls,0);
  let state=(await request('/api/state')).body;assert.equal(state.uploads[0].status,'approved');assert.equal(state.uploads[0].contactId,existing.id);
  assert.deepEqual(state.contacts[0].emails,['first@example.com','second@example.com']);
  assert.deepEqual((await request('/api/uploads/approve-extracted',{})).body,{approved:0,needsAttention:0});
  state=(await request('/api/state')).body;assert.equal(state.contacts.length,1);assert.equal(modelCalls,0);
});

test('contact saves and edits automatically sync only their workspace, including contacts saved before linking',async t=>{
  const mock=upstreamMock();const {request}=await setup(t,{fetchImpl:mock.fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'test-client',GOOGLE_OAUTH_CLIENT_SECRET:'test-secret'}});
  const one=(await request('/api/workspaces',{name:'Expo'})).body;
  const two=(await request('/api/workspaces',{name:'Occasion'})).body;
  const first=(await request('/api/contacts',{workspace:one.id,name:'First',emails:['first@example.com','second@example.com'],phones:['+1 202-555-0101']})).body;
  assert.equal(first.dirty,true);assert.equal(mock.sheets.size,0);
  await connect(request,'sheets');
  const linked=await request(`/api/workspaces/${one.id}/sheet`,{mode:'create'});
  assert.equal(linked.status,200);assert.ok(linked.body.syncedAt);
  const rows=mock.sheets.get(linked.body.sheetId);
  assert.equal(rows.length,2);assert.equal(rows[1][0],first.id);assert.equal(rows[1][4],'first@example.com; second@example.com');
  const secondSheet=(await request(`/api/workspaces/${two.id}/sheet`,{mode:'create'})).body.sheetId;
  const second=(await request('/api/contacts',{workspace:two.id,business:'Another business',emails:['another@example.com']})).body;
  assert.equal(second.dirty,false);assert.equal(rows.length,2);assert.equal(mock.sheets.get(secondSheet)[1][0],second.id);
  const edited=await request('/api/contacts',{...first,name:'Updated name',phones:['+1 202-555-0102']});
  assert.equal(edited.status,200);assert.equal(edited.body.dirty,false);
  assert.equal(rows.length,2);assert.equal(rows[1][1],'Updated name');assert.equal(rows[1][5],'+1 202-555-0102');
  assert.equal(mock.sheets.get(secondSheet)[1][2],'Another business');
  assert.equal((await request('/api/state')).body.contacts.filter(c=>c.dirty).length,0);
  assert.equal(mock.sends.length,0);
});

test('approved scans, duplicate merges and copied contacts sync automatically, while unapproved cards do not',async t=>{
  const mock=upstreamMock();const {request}=await setup(t,{fetchImpl:mock.fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'test-client',GOOGLE_OAUTH_CLIENT_SECRET:'test-secret'}});
  await connect(request,'sheets');
  const ws=(await request('/api/workspaces',{name:'Cards'})).body;
  const sheet=(await request(`/api/workspaces/${ws.id}/sheet`,{mode:'create'})).body.sheetId;
  const uploads=(await request('/api/uploads',{workspace:ws.id,files:[image,image]})).body;
  assert.equal(mock.sheets.get(sheet).length,1);
  const contact={name:'Card name',emails:['card@example.com'],phones:['+1 202-555-0100']};
  const approval=await request(`/api/uploads/${uploads[0].id}/review`,{action:'save',contact});
  assert.equal(approval.status,200);assert.equal(mock.sheets.get(sheet).length,2);
  assert.equal(mock.sheets.get(sheet)[1][0],approval.body.contactId);
  await request(`/api/uploads/${uploads[1].id}/review`,{action:'merge',targetId:approval.body.contactId,contact:{...contact,emails:['card@example.com','sales@example.com']}});
  assert.equal(mock.sheets.get(sheet).length,2);assert.match(mock.sheets.get(sheet)[1][4],/sales@example.com/);
  const destination=(await request('/api/workspaces',{name:'Copy destination'})).body;
  const destSheet=(await request(`/api/workspaces/${destination.id}/sheet`,{mode:'create'})).body.sheetId;
  await request('/api/copy',{source:ws.id,destination:destination.id,ids:[approval.body.contactId]});
  assert.equal(mock.sheets.get(destSheet).length,1);
  const copied=(await request('/api/state')).body.uploads.find(u=>u.workspace===destination.id);
  await request(`/api/uploads/${copied.id}/review`,{action:'save',contact:copied.fields});
  assert.equal(mock.sheets.get(destSheet).length,2);assert.equal(mock.sheets.get(sheet).length,2);
  assert.notEqual(mock.sheets.get(destSheet)[1][0],approval.body.contactId);
  assert.equal(mock.sends.length,0);
});

test('automatic sync preserves saved contacts on failures and reconciles a lost append response without duplicates',async t=>{
  const mock=upstreamMock();let loseAppend=false,unavailable=false;
  const fetchImpl=async(url,init)=>{
    if(unavailable&&url.includes('sheets.googleapis.com'))return json({error:{message:'Sheets temporarily unavailable'}},503);
    const response=await mock.fetchImpl(url,init);
    if(loseAppend&&url.includes(':append')){loseAppend=false;throw Error('Lost response after append');}
    return response;
  };
  const {request,dataDir}=await setup(t,{fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'test-client',GOOGLE_OAUTH_CLIENT_SECRET:'test-secret'}});
  await connect(request,'sheets');const ws=(await request('/api/workspaces',{name:'Retry'})).body;
  const sheet=(await request(`/api/workspaces/${ws.id}/sheet`,{mode:'create'})).body.sheetId;
  loseAppend=true;
  const saved=await request('/api/contacts',{workspace:ws.id,name:'Saved first',emails:['saved@example.com']});
  assert.equal(saved.status,200);assert.equal(saved.body.dirty,true);assert.equal(mock.sheets.get(sheet).length,2);
  let persisted=JSON.parse(readFileSync(join(dataDir,'gather.json'),'utf8'));
  assert.equal(persisted.contacts.length,1);assert.equal(persisted.contacts[0].dirty,true);assert.ok(persisted.workspaces[0].syncError);
  const next=await request('/api/contacts',{workspace:ws.id,name:'Saved second',emails:['next@example.com']});
  assert.equal(next.status,200);assert.equal(next.body.dirty,false);
  assert.equal(mock.sheets.get(sheet).length,3);assert.equal(mock.sheets.get(sheet).filter(r=>r[0]===saved.body.id).length,1);
  const upload=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];unavailable=true;
  const approved=await request(`/api/uploads/${upload.id}/review`,{action:'save',contact:{name:'Saved approval',emails:['approved@example.com']}});
  assert.equal(approved.status,200);assert.equal(approved.body.status,'approved');
  persisted=JSON.parse(readFileSync(join(dataDir,'gather.json'),'utf8'));
  assert.equal(persisted.contacts.length,3);assert.equal(persisted.uploads[0].status,'approved');assert.match(persisted.workspaces[0].syncError,/unavailable/);
  unavailable=false;assert.equal((await request(`/api/workspaces/${ws.id}/sync`,{})).status,200);
  assert.equal(mock.sheets.get(sheet).length,4);
  const state=(await request('/api/state')).body;assert.ok(state.contacts.every(c=>!c.dirty));assert.equal(state.workspaces[0].syncError,'');
  assert.equal(mock.sends.length,0);
});

test('bulk audience includes fresh spreadsheet addresses, respects exclusions and stays in the chosen workspace',async t=>{
  const mock=upstreamMock();const {request}=await setup(t,{fetchImpl:mock.fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'test-client',GOOGLE_OAUTH_CLIENT_SECRET:'test-secret',GATHER_TEST:'1'}});
  await connect(request,'gmail');await connect(request,'sheets');
  const ws=(await request('/api/workspaces',{name:'Bulk workspace'})).body;
  const other=(await request('/api/workspaces',{name:'Other workspace'})).body;
  const sheet=(await request(`/api/workspaces/${ws.id}/sheet`,{mode:'create'})).body.sheetId;
  const existing=(await request('/api/contacts',{workspace:ws.id,name:'Existing',emails:['existing@example.com','excluded@example.com'],excludedEmails:['excluded@example.com']})).body;
  await request('/api/contacts',{workspace:other.id,name:'Other account',emails:['other@example.com']});
  const template=(await request('/api/templates',{workspace:ws.id,name:'Bulk message',subject:'Hello {{business_name}}',body:'This is the saved message.',assetIds:[]})).body;
  // These rows were added directly in Sheets after the browser selected contacts.
  mock.sheets.get(sheet).push(['','Fresh sheet row','Fresh business','','fresh@example.com; second@example.com; existing@example.com','','','']);
  mock.sheets.get(sheet).push(['','Do not email','','','unchecked@example.com','','','']);
  const created=await request('/api/campaigns',{workspace:ws.id,name:'Everyone in the spreadsheet',templateId:template.id,audience:'workspace',contactIds:[existing.id],excludedEmails:['unchecked@example.com']});
  assert.equal(created.status,201);assert.equal(created.body.sender,'sender@example.com');
  assert.deepEqual(created.body.recipients.map(r=>r.email).sort(),['existing@example.com','fresh@example.com','second@example.com']);
  assert.equal(created.body.body,template.body);assert.equal(created.body.status,'draft');assert.equal(mock.sends.length,0);
  assert.equal((await request(`/api/campaigns/${created.body.id}/send`,{})).status,400);
  const sent=await request(`/api/campaigns/${created.body.id}/send`,{confirm:true});
  assert.equal(sent.status,200);assert.equal(sent.body.status,'sent');assert.equal(mock.sends.length,3);
  assert.ok(mock.sends.every(m=>m.includes('From: sender@example.com\r\n')));
});
