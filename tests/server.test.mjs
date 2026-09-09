import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGather} from '../server.mjs';
import {json,upstreamMock} from './fixtures/upstreams.mjs';

const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=';
const image={name:'test-card.png',mime:'image/png',data:pixel};
async function setup(t,options={}) {
  const dataDir=mkdtempSync(join(tmpdir(),'gather-test-'));
  let app=createGather({dataDir,...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.server.closeAllConnections();app.server.close(resolve);}));
  let base=`http://127.0.0.1:${app.server.address().port}`;
  if(options.env?.GATHER_HOSTED==='1')options.env.GATHER_PUBLIC_ORIGIN=base.replace('http:','https:');
  let sessionCookie='';
  const request=async(path,body,extra={})=>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-gather-client':'1',...extra.headers,cookie:[sessionCookie,extra.headers?.cookie].filter(Boolean).join('; ')},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual'});
    let json;try{json=await response.json();}catch{}
    return {status:response.status,body:json,headers:response.headers};
  };
  const owner=await request('/api/auth/setup',{name:'Test Owner',email:'owner@example.com',password:'test-only-passphrase'});
  assert.equal(owner.status,201);sessionCookie=owner.headers.get('set-cookie').split(';')[0];
  return {...app,dataDir,base,request,async restart(){
    app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));
    app=createGather({dataDir,...options});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    base=`http://127.0.0.1:${app.server.address().port}`;
    if(options.env?.GATHER_HOSTED==='1')options.env.GATHER_PUBLIC_ORIGIN=base.replace('http:','https:');
  }};
}
async function connect(request,kind){
  const start=await request('/api/connect/google',{kind});assert.equal(start.status,200);
  const state=new URL(start.body.url).searchParams.get('state');const cookie=start.headers.get('set-cookie').split(';')[0];
  const callback=await request(`/api/oauth/google/callback?state=${state}&code=${kind}`,undefined,{headers:{cookie}});assert.equal(callback.status,303);
}
async function finishImport(request,wid,options={}){
  let result;
  for(let i=0;i<300;i++){
    result=await request(`/api/workspaces/${wid}/import-sheet`,{automatic:true,...(i===0?options:{})});
    assert.equal(result.status,200,JSON.stringify(result.body));
    if(result.body.finished||result.body.status==='waiting')return result.body;
  }
  throw Error('Import did not finish');
}

for(const provider of ['anthropic','gemini','compatible'])test(`${provider} spreadsheet assistance uses the selected model and saved key with card extraction disabled`,async t=>{
  const mock=upstreamMock();let modelCalls=0;
  mock.sourceTabs.set('clear-contacts-123',new Map([['Contacts',[['Business','Email address'],['Aster & Alloy','clear@example.com']]]]));
  mock.sourceTabs.set('unclear-contacts-123',new Map([['Contacts',[['hello@example.com','Velvet Kite','Priya Rao']]]]));
  const {request,dataDir}=await setup(t,{env:{GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret'},fetchImpl:async(url,init)=>{
    if(!/api.anthropic.com|generativelanguage.googleapis.com|compatible.example/.test(url))return mock.fetchImpl(url,init);
    modelCalls++;const body=JSON.parse(init.body);
    assert.equal(init.headers[provider==='anthropic'?'x-api-key':provider==='gemini'?'x-goog-api-key':'authorization'],provider==='compatible'?'Bearer private-test-key':'private-test-key');
    if(provider==='gemini')assert.ok(url.includes('models/selected-test-model:generateContent'));else assert.equal(body.model,'selected-test-model');
    const prompt=provider==='gemini'?body.contents[0].parts[0].text:body.messages[0].content[0].text;
    if(modelCalls===1)return json({error:{message:'Temporary provider failure'}},503);
    const records=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));assert.equal(records.length,1);
    const output=JSON.stringify({records:records.map(r=>({key:r.key,business:r.cells.find(c=>c.text==='Velvet Kite'),name:r.cells.find(c=>c.text==='Priya Rao'),emails:['invented@example.com']}))});
    return json(provider==='anthropic'?{content:[{type:'text',text:output}]}:provider==='gemini'?{candidates:[{content:{parts:[{text:output}]}}]}:{choices:[{message:{content:output}}]});
  }});
  await request('/api/settings',{provider,model:'selected-test-model',apiKey:'private-test-key',baseUrl:provider==='compatible'?'https://compatible.example/v1':'',enabled:false});
  await connect(request,'sheets');
  const clear=(await request('/api/workspaces',{name:'Clear table'})).body;
  await request(`/api/workspaces/${clear.id}/sheet`,{mode:'existing',sheetId:'clear-contacts-123'});
  assert.equal((await finishImport(request,clear.id)).finished,true);assert.equal(modelCalls,0);
  const unclear=(await request('/api/workspaces',{name:'Unclear table'})).body;
  await request(`/api/workspaces/${unclear.id}/sheet`,{mode:'existing',sheetId:'unclear-contacts-123'});
  assert.equal((await finishImport(request,unclear.id)).finished,true);assert.equal(modelCalls,2);
  const state=(await request('/api/state')).body,c=state.contacts.find(c=>c.workspace===unclear.id);
  assert.equal(c.business,'Velvet Kite');assert.equal(c.name,'Priya Rao');assert.deepEqual(c.emails,['hello@example.com']);
  assert.equal(state.sheetImportJobs,undefined);assert.ok(!JSON.stringify(state).includes('private-test-key'));
  assert.ok(!readFileSync(join(dataDir,'gather.json'),'utf8').includes('private-test-key'));
});

test('provider errors keep emails durable and resume after configuration changes without accepting invented names',async t=>{
  const mock=upstreamMock();let mode='malformed',calls=0;
  mock.sourceTabs.set('unclear-failures-123',new Map([['Contacts',[['hello@example.com','Velvet Kite']]]]));
  const app=await setup(t,{env:{GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret'},fetchImpl:async(url,init)=>{
    if(!url.includes('api.anthropic.com'))return mock.fetchImpl(url,init);
    calls++;if(mode==='denied')return json({error:{message:'Invalid provider API key. Update Settings.'}},401);
    const prompt=JSON.parse(init.body).messages[0].content[0].text,[r]=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
    const output=mode==='malformed'?'not json':JSON.stringify({records:[{key:r.key,name:null,business:{row:1,col:2,text:mode==='invented'?'Invented Company':'Velvet Kite'}}]});
    return json({content:[{type:'text',text:output}]});
  }});
  const {request}=app;await connect(request,'sheets');
  const ws=(await request('/api/workspaces',{name:'Resumable errors'})).body;
  await request(`/api/workspaces/${ws.id}/sheet`,{mode:'existing',sheetId:'unclear-failures-123'});
  assert.equal((await finishImport(request,ws.id)).status,'waiting');assert.equal(calls,0);
  for(const failure of ['malformed','invented','denied']){
    mode=failure;await request('/api/settings',{provider:'anthropic',model:'chosen',apiKey:'test-key',enabled:false});
    const before=calls,result=await finishImport(request,ws.id);
    assert.equal(result.status,'waiting');assert.equal(result.pending,1);assert.equal(calls-before,1);
    const state=(await request('/api/state')).body;assert.deepEqual(state.contacts[0].emails,['hello@example.com']);assert.equal(state.contacts[0].business,'');
    await app.restart();assert.equal((await request('/api/state')).body.workspaces[0].sheetImport.jobId,result.jobId);
  }
  mode='valid';await request('/api/settings',{provider:'anthropic',model:'chosen',apiKey:'replacement',enabled:false});
  const done=await finishImport(request,ws.id);assert.equal(done.finished,true);assert.equal(done.pending,0);
  assert.equal((await request('/api/state')).body.contacts[0].business,'Velvet Kite');
});

test('repair keeps managed IDs, exclusions and frozen campaign snapshots, and bounds sync writes',async t=>{
  const mock=upstreamMock(),sheetId='repair-existing-123',headers=['Gather ID','Contact name','Business','Role','Email addresses','Phone numbers','Notes','Excluded emails'];
  const original=[['Business','Email'],...Array.from({length:405},(_,i)=>[`Studio ${i}`,`p${i}@example.com`])];
  mock.sourceTabs.set(sheetId,new Map([['Source',original]]));
  mock.sheets.set(sheetId,[headers,...original.slice(1).map((r,i)=>[`stored-${i}`,'','Role','',r[1],'+91 9999999999','Keep notes',i===0?r[1]:''])]);
  const app=await setup(t,{env:{GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret'},fetchImpl:async(url,init)=>{
    if(url.includes('values:batchUpdate'))assert.ok(JSON.parse(init.body).data.length<=200);
    return mock.fetchImpl(url,init);
  }});
  const {request,dataDir}=app;await connect(request,'sheets');
  const ws=(await request('/api/workspaces',{name:'Old workspace'})).body;
  // Seed the shape left by the previous production importer, before any new job exists.
  const path=join(dataDir,'gather.json'),db=JSON.parse(readFileSync(path,'utf8'));
  Object.assign(db.workspaces[0],{sheetId,sheetEmail:'sender@example.com'});
  db.contacts=mock.sheets.get(sheetId).slice(1).map(r=>({id:r[0],workspace:ws.id,name:r[1],business:r[2],role:r[3],emails:[r[4]],phones:[r[5]],notes:r[6],excludedEmails:r[7]?[r[7]]:[],dirty:false}));
  db.campaigns=[{id:'sent-campaign',workspace:ws.id,status:'sent',recipients:[{id:'delivery',contactId:'stored-1',email:'p1@example.com',business:'Role',status:'sent',gmailId:'already-sent',sentAt:'2026-09-09T08:30:00Z'}]}];
  const history=structuredClone(db.campaigns);writeFileSync(path,JSON.stringify(db));await app.restart();
  // Missing managed IDs must recover by unique email without oversized writes.
  mock.sheets.get(sheetId).slice(100,350).forEach(row=>row[0]='');
  const first=await request(`/api/workspaces/${ws.id}/import-sheet`,{automatic:true});
  assert.equal(first.body.needsContinuation,true);assert.equal((await request(`/api/workspaces/${ws.id}/sync`,{})).status,409);
  await app.restart();assert.equal((await finishImport(request,ws.id,{jobId:first.body.jobId})).finished,true);
  let state=(await request('/api/state')).body;assert.equal(state.contacts.length,405);assert.deepEqual(state.campaigns,history);
  assert.deepEqual(state.contacts.map(c=>c.id),original.slice(1).map((_,i)=>`stored-${i}`));
  assert.deepEqual(state.contacts.map(c=>c.business),original.slice(1).map(r=>r[0]));assert.deepEqual(state.contacts[0].excludedEmails,['p0@example.com']);
  assert.equal(state.contacts[0].notes,'Keep notes');assert.deepEqual(state.contacts[0].phones,['+91 9999999999']);
  assert.deepEqual(mock.sheets.get(sheetId).slice(1).map(r=>r[2]),original.slice(1).map(r=>r[0]));
  const before=structuredClone(state.contacts);await finishImport(request,ws.id,{restart:true});state=(await request('/api/state')).body;assert.deepEqual(state.contacts,before);assert.deepEqual(state.campaigns,history);
});

test('an existing spreadsheet can be reused across workspaces without changing its source tab',async t=>{
  const mock=upstreamMock(),sheetId='existing-contacts-123';
  const reordered=[['Expo directory'],[],['Reach at','Organisation / Studio','Attendee'],['Alice <Alice@Example.com>; sales@example.com','Acme Labs','Alice Rao'],['not an email','Ignored','Nobody']];
  const labelled=[['Company name','Beta Works','email address','sales@beta.example']];
  const unlabelled=[['hello@gamma-studio.com','Gamma Studio','Nina Shah'],['broken@example','Ignored']];
  const original=new Map([['Reordered columns',structuredClone(reordered)],['Labels beside values',structuredClone(labelled)],['No headings',structuredClone(unlabelled)]]);
  mock.sourceTabs.set(sheetId,new Map(original));
  const {request,dataDir}=await setup(t,{fetchImpl:mock.fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret'}});
  await connect(request,'sheets');
  const other=(await request('/api/workspaces',{name:'Other workspace'})).body;
  const target=(await request('/api/workspaces',{name:'Existing contacts'})).body;
  const local=(await request('/api/contacts',{workspace:target.id,name:'Local',emails:['local@example.com']})).body;
  const linked=await request(`/api/workspaces/${target.id}/sheet`,{mode:'existing',sheetId:`  https://docs.google.com/spreadsheets/d/${sheetId}/edit?usp=sharing#gid=42  `});
  assert.equal(linked.status,200);assert.equal(linked.body.sheetId,sheetId);assert.equal(linked.body.sheetEmail,'sender@example.com');
  assert.equal(linked.body.needsContinuation,true);assert.ok(linked.body.jobId);
  const imported=await finishImport(request,target.id);assert.equal(imported.imported,3);assert.equal(imported.tabsScanned,3);
  let state=(await request('/api/state')).body;
  assert.equal(state.contacts.length,4);assert.equal(state.uploads.length,0);assert.equal(mock.sheets.get(sheetId).length,5);
  const alice=state.contacts.find(c=>c.emails.includes('alice@example.com'));
  assert.deepEqual(alice.emails,['alice@example.com','sales@example.com']);assert.equal(alice.name,'Alice Rao');assert.equal(alice.business,'Acme Labs');
  const beta=state.contacts.find(c=>c.emails.includes('sales@beta.example'));
  assert.equal(beta.name,'');assert.equal(beta.business,'Beta Works');
  const nina=state.contacts.find(c=>c.emails.includes('hello@gamma-studio.com'));
  assert.equal(nina.name,'');assert.equal(nina.business,'');assert.equal(imported.pending,1);assert.match(imported.error,/API key/);
  assert.deepEqual(mock.sourceTabs.get(sheetId),original);
  const rescanned=await request(`/api/workspaces/${target.id}/import-sheet`,{automatic:true});
  assert.equal(rescanned.status,200);assert.equal(rescanned.body.jobId,linked.body.jobId);assert.equal((await request('/api/state')).body.contacts.length,4);
  const reused=await request(`/api/workspaces/${other.id}/sheet`,{mode:'existing',sheetId});
  assert.equal(reused.status,200);assert.equal(reused.body.sheetId,sheetId);assert.equal(reused.body.jobId,linked.body.jobId);
  await finishImport(request,other.id);
  state=(await request('/api/state')).body;
  assert.deepEqual(state.contacts.filter(c=>c.workspace===other.id).map(c=>c.id).sort(),state.contacts.filter(c=>c.workspace===target.id).map(c=>c.id).sort());
  await request('/api/contacts',{workspace:other.id,name:'Shared contact',emails:['shared@example.com']});
  assert.equal((await request(`/api/workspaces/${target.id}/sync`,{})).status,200);
  const restarted=createGather({dataDir});state=restarted.publicState();restarted.server.close();
  assert.equal(state.workspaces.find(w=>w.id===target.id).sheetId,sheetId);assert.equal(state.workspaces.find(w=>w.id===other.id).sheetId,sheetId);
  assert.ok(state.contacts.some(c=>c.workspace===target.id&&c.emails.includes('shared@example.com')));
  assert.ok(state.contacts.some(c=>c.workspace===other.id&&c.emails.includes('shared@example.com')));
});

test('bad sheet links and denied Google access leave the workspace available for a corrected link',async t=>{
  const mock=upstreamMock();let denied=true;
  const {request}=await setup(t,{fetchImpl:(url,init)=>url.includes('sheets.googleapis.com')&&denied?json({error:{message:'No permission to access this spreadsheet'}},403):mock.fetchImpl(url,init),env:{GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret'}});
  await connect(request,'sheets');const ws=(await request('/api/workspaces',{name:'Retry link'})).body;
  for(const sheetId of ['', 'short', 'https://example.com/spreadsheets/d/valid-looking-id/edit']){
    const invalid=await request(`/api/workspaces/${ws.id}/sheet`,{mode:'existing',sheetId});assert.equal(invalid.status,400);assert.match(invalid.body.error,/valid Google spreadsheet/);
  }
  const failed=await request(`/api/workspaces/${ws.id}/sheet`,{mode:'existing',sheetId:'existing-contacts-456'});assert.ok(failed.status>=400);
  assert.equal((await request('/api/state')).body.workspaces[0].sheetId,null);
  denied=false;
  assert.equal((await request(`/api/workspaces/${ws.id}/sheet`,{mode:'existing',sheetId:'  existing-contacts-456  '})).status,200);
  assert.equal((await request('/api/state')).body.workspaces.length,1);
});

test('invalid imported rows fail together, and correcting the source allows a clean retry',async t=>{
  const mock=upstreamMock(),sheetId='existing-invalid-123';
  mock.sourceTabs.set(sheetId,new Map([['Contacts',[['Name','Email'],['Good','good@example.com'],['Bad','not-an-email']]]]));
  const {request,dataDir}=await setup(t,{fetchImpl:mock.fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret'}});
  await connect(request,'sheets');const ws=(await request('/api/workspaces',{name:'Import retry'})).body;
  await request(`/api/workspaces/${ws.id}/sheet`,{mode:'existing',sheetId});
  const input={tab:'Contacts',columns:{name:'Name',emails:'Email',phones:''}};
  const invalid=await request(`/api/workspaces/${ws.id}/import-sheet`,input);assert.equal(invalid.status,400);assert.match(invalid.body.error,/Row 3:.*No rows were imported/);
  assert.equal((await request('/api/state')).body.uploads.length,0);assert.equal(JSON.parse(readFileSync(join(dataDir,'gather.json'),'utf8')).uploads.length,0);
  assert.equal((await request(`/api/workspaces/${ws.id}/import-sheet`,{...input,columns:{emails:'',phones:''}})).status,400);
  assert.ok((await request(`/api/workspaces/${ws.id}/import-sheet`,{...input,tab:'Missing'})).status>=400);
  mock.sourceTabs.get(sheetId).get('Contacts')[2][1]='fixed@example.com';
  const retried=await request(`/api/workspaces/${ws.id}/import-sheet`,input);assert.equal(retried.status,200);assert.equal(retried.body.count,2);
  assert.equal((await request('/api/state')).body.uploads.length,2);
  await request('/api/disconnect',{kind:'sheets'});
  assert.equal((await request(`/api/workspaces/${ws.id}/import-sheet`,input)).status,409);
});

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
test('templates upload resumable PDF and PPTX attachments and send frozen files through Gmail',async t=>{
  const mock=upstreamMock(),app=await setup(t,{fetchImpl:mock.fetchImpl,env:{GOOGLE_OAUTH_CLIENT_ID:'test-client',GOOGLE_OAUTH_CLIENT_SECRET:'test-secret',GATHER_TEST:'1'}}),{request,dataDir}=app;
  await connect(request,'gmail');await connect(request,'sheets');
  const ws=(await request('/api/workspaces',{name:'Attachments'})).body;await request(`/api/workspaces/${ws.id}/sheet`,{mode:'create'});
  const contact=(await request('/api/contacts',{workspace:ws.id,business:'Example',emails:['files@example.com']})).body;
  const pdf=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(2*1024*1024+17,0x41)]),pptx=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.from('[Content_Types].xml\0ppt/presentation.xml')]);
  async function upload(name,mime,bytes,{restart=false}={}){
    const started=await request('/api/attachments',{name,mime,size:bytes.length});assert.equal(started.status,201);
    assert.equal((await request('/api/state')).body.assets.some(a=>a.id===started.body.id),false);
    assert.equal((await request('/api/templates',{workspace:ws.id,name:'Incomplete',subject:'S',body:'B',assetIds:[started.body.id]})).status,400);
    const chunkSize=2*1024*1024;
    for(let index=0,offset=0;offset<bytes.length;index++,offset+=chunkSize){
      const data=bytes.subarray(offset,Math.min(offset+chunkSize,bytes.length)).toString('base64');
      const part=await request(`/api/attachments/${started.body.id}/chunks`,{index,data});assert.equal(part.status,200);
      if(index===0){assert.equal((await request(`/api/attachments/${started.body.id}/chunks`,{index,data})).status,200);if(restart)await app.restart();}
    }
    const complete=await request(`/api/attachments/${started.body.id}/complete`,{});assert.equal(complete.status,200);return complete.body;
  }
  const pdfAsset=await upload('proposal final.pdf','application/pdf',pdf,{restart:true});
  const pptxAsset=await upload('company deck.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation',pptx);
  const inline=(await request('/api/assets',image)).body;
  const state=(await request('/api/state')).body;assert.equal(state.limits.attachmentMB,25);assert.equal(state.limits.attachmentBytes,25_000_000);assert.equal(state.limits.attachmentChunkMB,2);
  assert.deepEqual(state.assets.filter(a=>[pdfAsset.id,pptxAsset.id].includes(a.id)).map(a=>a.kind),['attachment','attachment']);
  assert.ok(state.assets.every(a=>a.chunks===undefined&&a.uploadState===undefined));
  const template=(await request('/api/templates',{workspace:ws.id,name:'Documents',subject:'Requested files',body:'Please see the files.',assetIds:[inline.id,pdfAsset.id,pptxAsset.id]})).body;
  const campaign=(await request('/api/campaigns',{workspace:ws.id,name:'Files campaign',templateId:template.id,contactIds:[contact.id]})).body;
  await request('/api/templates',{...template,assetIds:[]});
  const sent=await request(`/api/campaigns/${campaign.id}/send`,{confirm:true});assert.equal(sent.status,200);assert.equal(sent.body.status,'sent');
  assert.equal(mock.sends.length,1);const message=mock.sends[0];
  assert.match(message,/Content-Type: multipart\/mixed/);assert.match(message,/Content-Type: multipart\/related/);
  assert.match(message,new RegExp(`Content-ID: <${inline.id}>`));assert.match(message,/Content-Disposition: inline/);
  assert.match(message,/Content-Type: application\/pdf; name="proposal final.pdf"/);assert.match(message,/Content-Disposition: attachment; filename="proposal final.pdf"/);
  assert.match(message,/Content-Type: application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation; name="company deck.pptx"/);
  assert.match(message,/Content-Disposition: attachment; filename="company deck.pptx"/);
  assert.ok(message.includes(pptx.toString('base64')));assert.deepEqual(sent.body.assetIds,[inline.id,pdfAsset.id,pptxAsset.id]);
  assert.equal(JSON.parse(readFileSync(join(dataDir,'gather.json'),'utf8')).campaigns[0].assetIds.length,3);
});
test('attachment validation rejects disguised files, oversized uploads and templates over 25 MB',async t=>{
  const app=await setup(t),{request,dataDir}=app;
  const ws=(await request('/api/workspaces',{name:'Attachment limits'})).body;
  assert.equal((await request('/api/attachments',{name:'wrong.exe',mime:'application/pdf',size:10})).status,400);
  assert.equal((await request('/api/attachments',{name:'large.pdf',mime:'application/pdf',size:25*1024*1024+1})).status,400);
  const bad=(await request('/api/attachments',{name:'disguised.pdf',mime:'application/pdf',size:8})).body;
  await request(`/api/attachments/${bad.id}/chunks`,{index:0,data:Buffer.from('not-pdf!').toString('base64')});
  assert.equal((await request(`/api/attachments/${bad.id}/complete`,{})).status,400);
  assert.equal((await request('/api/state')).body.assets.some(asset=>asset.id===bad.id),false);
  const zip=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.from('ordinary archive')]);
  const fakeDeck=(await request('/api/attachments',{name:'disguised.pptx',mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation',size:zip.length})).body;
  await request(`/api/attachments/${fakeDeck.id}/chunks`,{index:0,data:zip.toString('base64')});
  assert.equal((await request(`/api/attachments/${fakeDeck.id}/complete`,{})).status,400);
  const stale=(await request('/api/attachments',{name:'abandoned.pdf',mime:'application/pdf',size:5})).body;
  await request(`/api/attachments/${stale.id}/chunks`,{index:0,data:Buffer.from('%PDF-').toString('base64')});
  const path=join(dataDir,'gather.json'),before=JSON.parse(readFileSync(path,'utf8')),staleAsset=before.assets.find(asset=>asset.id===stale.id);
  staleAsset.createdAt='2000-01-01T00:00:00.000Z';writeFileSync(path,JSON.stringify(before));assert.equal(existsSync(join(dataDir,staleAsset.chunks[0].name)),true);
  await app.restart();assert.equal(existsSync(join(dataDir,staleAsset.chunks[0].name)),false);
  const db=JSON.parse(readFileSync(path,'utf8'));assert.equal(db.assets.some(asset=>asset.id===stale.id),false);
  db.assets.push({id:'large-a',name:'a.pdf',mime:'application/pdf',size:13*1024*1024,kind:'attachment'},{id:'large-b',name:'b.pptx',mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation',size:13*1024*1024,kind:'attachment'});
  writeFileSync(path,JSON.stringify(db));await app.restart();
  const tooLarge=await request('/api/templates',{workspace:ws.id,name:'Too large',subject:'S',body:'B',assetIds:['large-a','large-b']});
  assert.equal(tooLarge.status,413);assert.match(tooLarge.body.error,/25 MB/);
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

test('Anthropic model discovery loads every page, respects vision capabilities, and never saves a typed key',async t=>{
  const calls=[];
  const {request,dataDir}=await setup(t,{fetchImpl:async(url,init)=>{
    calls.push({url,init});const endpoint=new URL(url);
    assert.equal(endpoint.origin,'https://api.anthropic.com');assert.equal(endpoint.pathname,'/v1/models');
    assert.equal(endpoint.searchParams.get('limit'),'1000');assert.equal(endpoint.searchParams.has('after'),false);
    return json(endpoint.searchParams.get('after_id')?{data:[{id:'claude-test-sonnet',display_name:'Claude Test Sonnet'},{id:'claude-test-opus',display_name:'Claude Test Opus',capabilities:{image_input:{supported:true}}}],has_more:false}
      :{data:[{id:'claude-test-sonnet',display_name:'Claude Test Sonnet'},{id:'text-only',display_name:'Text Only',capabilities:{image_input:{supported:false}}}],has_more:true,last_id:'text-only'});
  }});
  assert.equal((await request('/api/settings/models',{provider:'anthropic'})).status,409);assert.equal(calls.length,0);
  const result=await request('/api/settings/models',{provider:'anthropic',apiKey:' typed-anthropic-key ',baseUrl:'https://unrelated.example/v1'});
  assert.equal(result.status,200);assert.equal(result.body.models.length,3);assert.equal(calls.length,2);
  assert.equal(new URL(calls[1].url).searchParams.get('after_id'),'text-only');
  assert.deepEqual(result.body.models.find(m=>m.id==='claude-test-opus'),{id:'claude-test-opus',name:'Claude Test Opus',description:'',selectable:true});
  assert.equal(result.body.models.find(m=>m.id==='text-only').selectable,false);
  assert.ok(calls.every(c=>c.init.headers['x-api-key']==='typed-anthropic-key'&&c.init.headers['anthropic-version']==='2023-06-01'&&!c.init.headers.authorization&&!c.url.includes('typed-anthropic-key')&&c.init.redirect==='error'));
  assert.ok(!readFileSync(join(dataDir,'gather.json'),'utf8').includes('typed-anthropic-key'));
  assert.equal((await request('/api/state')).body.settings.hasKey,false);
});

test('Anthropic settings encrypt the key, retain model choices, and isolate credentials between providers',async t=>{
  const calls=[];
  const {request,dataDir}=await setup(t,{fetchImpl:async(url,init)=>{
    calls.push({url,init});return json(new URL(url).pathname==='/v1/models'?{data:[{id:'claude-test',display_name:'Claude Test'}],has_more:false}:{content:[{type:'text',text:'{"ok":true}'}],stop_reason:'end_turn'});
  }});
  assert.equal((await request('/api/settings',{provider:'anthropic',enabled:true,model:'claude-test',apiKey:' saved-anthropic-key '})).status,200);
  let state=(await request('/api/state')).body;
  assert.equal(state.settings.provider,'anthropic');assert.equal(state.settings.model,'claude-test');assert.equal(state.settings.hasKey,true);assert.equal(state.settings.secret,undefined);
  assert.ok(!JSON.stringify(state).includes('saved-anthropic-key'));assert.ok(!readFileSync(join(dataDir,'gather.json'),'utf8').includes('saved-anthropic-key'));
  assert.equal((await request('/api/settings/models',{provider:'anthropic',baseUrl:'https://ignored.example/v1'})).status,200);
  assert.equal(calls[0].init.headers['x-api-key'],'saved-anthropic-key');
  assert.equal((await request('/api/settings/models',{provider:'anthropic',clearKey:true})).status,409);
  assert.equal((await request('/api/settings/models',{provider:'gemini'})).status,409);
  assert.equal(calls.length,1);
  await request('/api/settings/models',{provider:'compatible',baseUrl:'https://other.example/v1'});
  assert.equal(calls[1].init.headers.authorization,undefined);assert.equal(calls[1].init.headers['x-api-key'],undefined);
  await request('/api/settings',{provider:'anthropic',enabled:true,model:'claude-another-choice'});
  assert.equal((await request('/api/settings/test',{})).status,200);
  const call=calls.at(-1),payload=JSON.parse(call.init.body);
  assert.equal(call.url,'https://api.anthropic.com/v1/messages');assert.equal(call.init.headers['x-api-key'],'saved-anthropic-key');
  assert.equal(payload.model,'claude-another-choice');assert.equal(payload.messages[0].content.length,1);assert.equal(payload.messages[0].content[0].type,'text');assert.ok(payload.max_tokens>0);
  state=(await request('/api/state')).body;assert.equal(state.settings.model,'claude-another-choice');assert.equal(state.settings.hasKey,true);
  await request('/api/settings',{provider:'anthropic',enabled:false,model:'claude-another-choice',clearKey:true});
  assert.equal((await request('/api/state')).body.settings.hasKey,false);
  await request('/api/settings',{provider:'anthropic',enabled:true,model:'claude-test',apiKey:'saved-anthropic-key'});
  await request('/api/settings',{provider:'gemini',enabled:true,model:'gemini-test'});
  assert.equal((await request('/api/state')).body.settings.hasKey,false);
  await request('/api/settings',{provider:'gemini',enabled:true,model:'gemini-test',apiKey:'gemini-key'});
  await request('/api/settings',{provider:'anthropic',enabled:true,model:'claude-test'});
  assert.equal((await request('/api/state')).body.settings.hasKey,false);
});

test('Anthropic reads card images using the selected model and approves complete contact details',async t=>{
  const calls=[],contact={name:'Test Person',business:'Example Studio',role:'Designer',emails:['one@example.com','two@example.com'],phones:['+1 202 555 0101','+1 202 555 0102'],notes:''};
  const {request}=await setup(t,{fetchImpl:async(url,init)=>{
    calls.push({url,init});const text=JSON.stringify(contact),split=text.indexOf(',');
    return json({content:[{type:'thinking',thinking:'This is not contact data.'},{type:'text',text:'```json\n'+text.slice(0,split)},{type:'text',text:text.slice(split)+'\n```'}],stop_reason:'end_turn'});
  }});
  const ws=(await request('/api/workspaces',{name:'Claude cards'})).body;
  await request('/api/settings',{provider:'anthropic',enabled:true,model:'claude-user-selected',apiKey:'anthropic-test-key'});
  for(const mime of ['image/png','image/jpeg','image/webp']) {
    const uploaded=(await request('/api/uploads',{workspace:ws.id,files:[{...image,mime}]})).body[0];
    const result=await request(`/api/uploads/${uploaded.id}/extract`,{automatic:true});
    assert.equal(result.status,200);assert.equal(result.body.status,'approved');assert.equal(result.body.extractionState,'complete');
    assert.deepEqual(result.body.fields.emails,contact.emails);assert.deepEqual(result.body.fields.phones,contact.phones);
    const call=calls.at(-1),payload=JSON.parse(call.init.body);
    assert.equal(call.url,'https://api.anthropic.com/v1/messages');assert.equal(call.init.headers['x-api-key'],'anthropic-test-key');assert.equal(call.init.headers['anthropic-version'],'2023-06-01');assert.equal(call.init.headers.authorization,undefined);assert.equal(call.init.redirect,'error');
    assert.equal(payload.model,'claude-user-selected');assert.equal(payload.messages[0].role,'user');assert.ok(payload.max_tokens>0);assert.equal(payload.temperature,undefined);
    assert.deepEqual(payload.messages[0].content[0],{type:'image',source:{type:'base64',media_type:mime,data:pixel}});
    assert.match(payload.messages[0].content[1].text,/Read this business card/);
    await request(`/api/uploads/${uploaded.id}/extract`,{automatic:true});
  }
  assert.equal(calls.length,3);const state=(await request('/api/state')).body;assert.equal(state.contacts.length,1);assert.deepEqual(state.contacts[0].emails,contact.emails);
});

test('Anthropic failures leave cards for attention and reject incomplete model lists',async t=>{
  let mode='error';
  const {request}=await setup(t,{fetchImpl:async()=>{
    if(mode==='error')return json({error:{type:'authentication_error',message:'Invalid Anthropic API key'}},401);
    if(mode==='loop')return json({data:[],has_more:true,last_id:'same'});
    if(mode==='missing')return json({data:[],has_more:true});
    if(mode==='empty-list')return json({data:[],has_more:false});
    return json({content:mode==='empty'?[]:[{type:'text',text:'{"business":"Incomplete","emails":["one@example.com"]}'}],stop_reason:mode});
  }});
  const ws=(await request('/api/workspaces',{name:'Claude errors'})).body;
  await request('/api/settings',{provider:'anthropic',enabled:true,model:'claude-test',apiKey:'test-key'});
  for(const [failure,message] of [['error',/Invalid Anthropic API key/],['empty',/no readable result/],['max_tokens',/response limit/],['refusal',/declined/]]) {
    mode=failure;const upload=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
    const result=await request(`/api/uploads/${upload.id}/extract`,{automatic:true});
    assert.equal(result.status,502);assert.match(result.body.error,message);
    const state=(await request('/api/state')).body,row=state.uploads.find(u=>u.id===upload.id);
    assert.equal(row.status,'needs_attention');assert.equal(row.extractionState,'failed');assert.equal(state.contacts.length,0);
  }
  for(const [failure,message] of [['error',/Invalid Anthropic API key/],['loop',/repeated/],['missing',/next-page cursor/]]) {
    mode=failure;const result=await request('/api/settings/models',{provider:'anthropic'});assert.equal(result.status,502);assert.match(result.body.error,message);
  }
  mode='empty-list';assert.deepEqual((await request('/api/settings/models',{provider:'anthropic'})).body.models,[]);
});

test('hosted campaigns checkpoint sending before Gmail and resume only untouched recipients',async t=>{
  const mock=upstreamMock();let dataDir;
  const fetchImpl=async(url,init)=>{
    if(url.startsWith('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send')) {
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

test('automatic reading failures preserve cards and allow one automatic retry',async t=>{
  let calls=0;
  const {request}=await setup(t,{fetchImpl:async()=>{calls++;return calls===1?json({error:{message:'Provider quota exceeded'}},429):json({candidates:[{content:{parts:[{text:'{"business":"Recovered","emails":["hello@example.com"]}'}]}}]});}});
  const ws=(await request('/api/workspaces',{name:'Retry scanning'})).body;
  await request('/api/settings',{provider:'gemini',enabled:true,model:'vision-test',apiKey:'test-key'});
  const upload=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  assert.equal((await request(`/api/uploads/${upload.id}/extract`,{automatic:true})).status,502);
  let row=(await request('/api/state')).body.uploads[0];assert.equal(row.extractionState,'failed');assert.equal(row.status,'needs_attention');assert.equal(row.assetId,upload.assetId);
  assert.equal(row.automaticRetryPending,true);assert.equal(row.automaticAttempts,1);
  const retried=await request(`/api/uploads/${upload.id}/extract`,{automatic:true});assert.equal(retried.body.extractionState,'complete');assert.equal(calls,2);
  assert.equal(retried.body.automaticRetryPending,false);assert.equal(retried.body.assetId,undefined);assert.ok(retried.body.imageRemovedAt);
  await request(`/api/uploads/${upload.id}/extract`,{automatic:true});assert.equal(calls,2);
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

async function batchFixture(t,count,{hosted=false,intercept}={}) {
  const mock=upstreamMock();
  const app=await setup(t,{fetchImpl:async(url,init)=>url.startsWith('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send')&&intercept?intercept(url,init,mock):mock.fetchImpl(url,init),
    env:{GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret',GATHER_TEST:'1',...(hosted?{GATHER_HOSTED:'1'}:{})}});
  const {request}=app;await connect(request,'gmail');await connect(request,'sheets');
  const ws=(await request('/api/workspaces',{name:'Automatic batches'})).body;
  const sheet=(await request(`/api/workspaces/${ws.id}/sheet`,{mode:'create'})).body.sheetId;
  mock.sheets.get(sheet).push(...Array.from({length:count},(_,i)=>['',`Contact ${i}`,'Business','','person'+i+'@example.com','','','']));
  mock.sheets.get(sheet).push(['','Duplicate','','','PERSON0@example.com','','',''],['','Excluded','','','excluded@example.com','','','']);
  const template=(await request('/api/templates',{workspace:ws.id,name:'Batch template',subject:'Frozen subject',body:'Hello {{business_name}}',assetIds:[]})).body;
  const created=await request('/api/campaigns',{workspace:ws.id,name:'Entire sheet',templateId:template.id,audience:'workspace',excludedEmails:['excluded@example.com'],batchSize:1});
  assert.equal(created.status,201);assert.equal(created.body.recipients.length,count);assert.equal(created.body.batchSize,100);assert.equal(mock.sends.length,0);
  return {...app,mock,campaign:created.body,template,ws};
}

test('40 uploaded cards process in groups of 10, retry once, and delete only successfully saved card images',async t=>{
  let dataDir;const calls=new Map(),order=[];
  const app=await setup(t,{fetchImpl:async()=>{
    const stored=JSON.parse(readFileSync(join(dataDir,'gather.json'),'utf8')),card=stored.uploads.find(u=>u.extractionState==='extracting');
    const count=(calls.get(card.filename)||0)+1;calls.set(card.filename,count);order.push(card.filename);
    if(card.filename==='card-17.png'||(card.filename==='card-2.png'&&count===1))return json({error:{message:'Temporary model failure'}},503);
    const number=card.filename.match(/\d+/)[0];
    return json({candidates:[{content:{parts:[{text:JSON.stringify({name:'Person '+number,emails:[`person${number}@example.com`]})}]}}]});
  }});
  dataDir=app.dataDir;const {request}=app;
  const ws=(await request('/api/workspaces',{name:'40 cards'})).body;
  await request('/api/settings',{provider:'gemini',enabled:true,model:'test-card-reader',apiKey:'test-key'});
  const added=await request('/api/uploads',{workspace:ws.id,files:Array.from({length:40},(_,i)=>({...image,name:`card-${i}.png`}))});
  assert.equal(added.status,201);assert.equal(added.body.length,40);
  assert.equal((await request('/api/uploads',{workspace:ws.id,files:Array(41).fill(image)})).status,400);
  const result=await globalThis.GatherCore.runCardBatches(added.body,{wait:async()=>{},extract:async card=>{
    const response=await request(`/api/uploads/${card.id}/extract`,{automatic:true});
    if(response.status!==200)throw Error(response.body.error);return response.body;
  }});
  assert.equal(result.totalBatches,4);assert.equal(result.completed,39);assert.equal(result.failed.length,1);
  assert.deepEqual(order.slice(0,11),[...Array.from({length:10},(_,i)=>`card-${i}.png`),'card-2.png']);
  const state=(await request('/api/state')).body;assert.equal(state.limits.maxCardUploads,40);assert.equal(state.contacts.length,39);assert.equal(state.assets.length,1);
  for(const original of added.body) {
    const saved=state.uploads.find(u=>u.id===original.id),failed=original.filename==='card-17.png';
    assert.equal(existsSync(join(dataDir,original.assetId)),failed);
    if(failed){assert.equal(saved.assetId,original.assetId);assert.equal(saved.automaticAttempts,2);assert.equal(saved.automaticRetryPending,false);assert.equal(saved.status,'needs_attention');}
    else {assert.equal(saved.status,'approved');assert.equal(saved.assetId,undefined);assert.ok(saved.imageRemovedAt);assert.equal((await request('/assets/'+original.assetId)).status,404);}
  }
  await request(`/api/uploads/${result.failed[0].id}/extract`,{automatic:true});assert.equal(calls.get('card-17.png'),2);
});

test('automatic retry budgets survive restart and an interrupted second attempt cannot run again',async t=>{
  let calls=0;
  const {request,restart,dataDir}=await setup(t,{fetchImpl:async()=>{calls++;return json({error:{message:'Provider unavailable'}},503);}});
  const ws=(await request('/api/workspaces',{name:'Retry budget'})).body;
  await request('/api/settings',{provider:'gemini',enabled:true,model:'test',apiKey:'test-key'});
  const card=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  await request(`/api/uploads/${card.id}/extract`,{automatic:true});await restart();
  let saved=(await request('/api/state')).body.uploads[0];assert.equal(saved.automaticRetryPending,true);assert.equal(saved.automaticAttempts,1);
  await request(`/api/uploads/${card.id}/extract`,{automatic:true});assert.equal(calls,2);
  const file=join(dataDir,'gather.json'),db=JSON.parse(readFileSync(file,'utf8'));db.uploads[0].extractionState='extracting';writeFileSync(file,JSON.stringify(db));await restart();
  saved=(await request('/api/state')).body.uploads[0];assert.equal(saved.automaticRetryPending,false);assert.equal(saved.automaticAttempts,2);
  await request(`/api/uploads/${card.id}/extract`,{automatic:true});assert.equal(calls,2);assert.equal(existsSync(join(dataDir,card.assetId)),true);
});

test('image cleanup checkpoints the contact before deleting and retries deletion without re-reading the card',async t=>{
  let dataDir,deletions=0,modelCalls=0;
  const {request,dataDir:directory}=await setup(t,{fetchImpl:async()=>{modelCalls++;return json({candidates:[{content:{parts:[{text:'{"name":"Saved contact","emails":["saved@example.com"]}'}]}}]});},
    onDelete:async aid=>{
      deletions++;const db=JSON.parse(readFileSync(join(dataDir,'gather.json'),'utf8')),upload=db.uploads.find(u=>u.assetId===aid);
      assert.equal(upload.status,'approved');assert.equal(upload.imageCleanupPending,true);assert.ok(db.contacts.some(c=>c.id===upload.contactId));
      if(deletions===1)throw Error('Storage deletion temporarily unavailable');
    }});
  dataDir=directory;
  const ws=(await request('/api/workspaces',{name:'Cleanup'})).body;
  await request('/api/settings',{provider:'gemini',enabled:true,model:'test',apiKey:'key'});
  const card=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  const result=await request(`/api/uploads/${card.id}/extract`,{automatic:true});
  assert.equal(result.status,200);assert.equal(result.body.status,'approved');assert.equal(result.body.imageCleanupPending,true);assert.equal(existsSync(join(dataDir,card.assetId)),true);
  const state=(await request('/api/state')).body;
  assert.equal(deletions,2);assert.equal(modelCalls,1);assert.equal(state.uploads[0].assetId,undefined);assert.equal(state.contacts.length,1);assert.equal(existsSync(join(dataDir,card.assetId)),false);
});

test('cleanup can recover when the image was removed but its final metadata checkpoint failed',async t=>{
  let dataDir,failOnce=true,deletions=0,modelCalls=0;
  const app=await setup(t,{fetchImpl:async()=>{modelCalls++;return json({candidates:[{content:{parts:[{text:'{"name":"Saved","emails":["saved@example.com"]}'}]}}]});},onDelete:async()=>{deletions++;},onPersist:async name=>{
    if(dataDir&&name==='gather.json'&&failOnce&&JSON.parse(readFileSync(join(dataDir,name),'utf8')).uploads.some(u=>u.imageRemovedAt)){failOnce=false;throw Error('Checkpoint unavailable');}
  }});
  dataDir=app.dataDir;const {request,restart}=app;
  const ws=(await request('/api/workspaces',{name:'Interrupted cleanup'})).body;
  await request('/api/settings',{provider:'gemini',enabled:true,model:'test',apiKey:'key'});
  const card=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  const result=await request(`/api/uploads/${card.id}/extract`,{automatic:true});
  assert.equal(result.body.status,'approved');assert.equal(result.body.imageCleanupPending,true);assert.equal(existsSync(join(dataDir,card.assetId)),false);
  await restart();const state=(await request('/api/state')).body;
  assert.ok(state.uploads[0].imageRemovedAt);assert.equal(state.uploads[0].assetId,undefined);assert.equal(state.assets.length,0);assert.equal(state.contacts.length,1);assert.equal(deletions,2);assert.equal(modelCalls,1);
});

test('a failed contact checkpoint keeps the original card and never starts image cleanup',async t=>{
  let dataDir,deletions=0,failOnce=true;
  const app=await setup(t,{fetchImpl:upstreamMock().fetchImpl,onDelete:async()=>{deletions++;},onPersist:async name=>{
    if(dataDir&&name==='gather.json'&&failOnce&&JSON.parse(readFileSync(join(dataDir,name),'utf8')).uploads.some(u=>u.status==='approved')){failOnce=false;throw Error('Contact checkpoint unavailable');}
  }});
  dataDir=app.dataDir;const {request}=app;const ws=(await request('/api/workspaces',{name:'Failed save'})).body;
  await request('/api/settings',{provider:'gemini',enabled:true,model:'test',apiKey:'key'});
  const card=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0];
  assert.equal((await request(`/api/uploads/${card.id}/extract`,{automatic:true})).status,500);
  assert.equal(deletions,0);assert.equal(existsSync(join(dataDir,card.assetId)),true);
});

test('cleanup preserves card images referenced by an email template and unrelated attachments',async t=>{
  const {request,dataDir}=await setup(t,{fetchImpl:upstreamMock().fetchImpl});
  const ws=(await request('/api/workspaces',{name:'Shared image'})).body;
  await request('/api/settings',{provider:'gemini',enabled:true,model:'test',apiKey:'key'});
  const card=(await request('/api/uploads',{workspace:ws.id,files:[image]})).body[0],attachment=(await request('/api/assets',image)).body;
  await request('/api/templates',{workspace:ws.id,name:'Shared photo',subject:'Hello',body:'Message',assetIds:[card.assetId,attachment.id]});
  const result=await request(`/api/uploads/${card.id}/extract`,{automatic:true});assert.equal(result.body.status,'approved');
  assert.equal(result.body.assetId,card.assetId);assert.equal(existsSync(join(dataDir,card.assetId)),true);assert.equal(existsSync(join(dataDir,attachment.id)),true);
  assert.equal((await request('/api/state')).body.assets.length,2);
});

test('537 spreadsheet emails send automatically as six batches after one confirmation flow',async t=>{
  const {request,mock,campaign,template}=await batchFixture(t,537);const steps=[];
  assert.equal((await request(`/api/campaigns/${campaign.id}/send`,{compact:true})).status,400);
  assert.equal(mock.sends.length,0);
  await request('/api/templates',{...template,subject:'Must not replace the approved draft'});
  const result=await globalThis.GatherCore.runCampaign(async()=>{
    const response=await request(`/api/campaigns/${campaign.id}/send`,{confirm:true,compact:true});
    assert.equal(response.status,200);assert.equal(response.body.recipients,undefined);
    return response.body;
  },{wait:async()=>{},onProgress:r=>steps.push(r.progress.sent)});
  assert.equal(result.status,'sent');assert.deepEqual(steps,[100,200,300,400,500,537]);
  assert.equal(result.progress.totalBatches,6);assert.equal(result.progress.completedBatches,6);assert.equal(result.progress.batchTotal,37);
  const addresses=mock.sends.map(m=>m.match(/To: ([^\r]+)/)[1]);assert.equal(addresses.length,537);assert.equal(new Set(addresses).size,537);assert.ok(!addresses.includes('excluded@example.com'));
  assert.ok(mock.sends.every(m=>m.includes(`Subject: =?UTF-8?B?${Buffer.from('Frozen subject').toString('base64')}?=`)));
  const saved=(await request('/api/state')).body.campaigns[0];assert.ok(saved.confirmedAt);assert.equal(saved.recipients.filter(r=>r.messageId&&r.sentAt).length,537);
  assert.equal((await request(`/api/campaigns/${campaign.id}/send`,{confirm:true})).status,409);assert.equal(mock.sends.length,537);
});

test('hosted sending crosses batch boundaries and resumes after restart without repeating recipients',async t=>{
  const {request,mock,campaign,restart}=await batchFixture(t,103,{hosted:true});let requests=0,confirmedAt;
  const result=await globalThis.GatherCore.runCampaign(async()=>{
    const response=await request(`/api/campaigns/${campaign.id}/send`,{confirm:true,compact:true});requests++;
    assert.equal(response.status,200);assert.equal(response.body.progress.sent,requests);
    if(requests===100)assert.equal(response.body.progress.completedBatches,1);
    if(requests===101){confirmedAt=(await request('/api/state')).body.campaigns[0].confirmedAt;await restart();}
    return response.body;
  },{wait:async()=>{}});
  assert.equal(result.status,'sent');assert.equal(result.progress.completedBatches,2);assert.equal(requests,103);assert.equal(mock.sends.length,103);
  assert.equal(new Set(mock.sends.map(m=>m.match(/To: ([^\r]+)/)[1])).size,103);
  assert.equal((await request('/api/state')).body.campaigns[0].confirmedAt,confirmedAt);
});

test('Gmail quota pauses the current batch, persists cooldown, and retries only the rejected recipient',async t=>{
  for(const status of [429,403])await t.test(`HTTP ${status}`,async t=>{
    let rejected=false,attempts=0;
    const {request,mock,campaign,dataDir,restart}=await batchFixture(t,103,{intercept:async(url,init,mock)=>{
      attempts++;
      if(mock.sends.length===100&&!rejected){rejected=true;return new Response(JSON.stringify({error:{message:'Gmail quota reached',errors:[{reason:'userRateLimitExceeded'}]}}),{status,headers:{'content-type':'application/json','retry-after':'120'}});}
      return mock.fetchImpl(url,init);
    }});
    assert.equal((await request(`/api/campaigns/${campaign.id}/send`,{confirm:true})).body.status,'paused');assert.equal(mock.sends.length,100);
    let response=await request(`/api/campaigns/${campaign.id}/send`,{confirm:true,compact:true});
    assert.equal(response.body.status,'waiting');assert.equal(response.body.progress.sent,100);assert.equal(response.body.progress.pending,3);assert.equal(response.body.progress.failed,0);assert.ok(Date.parse(response.body.retryAt)>Date.now()+110000);
    await restart();response=await request(`/api/campaigns/${campaign.id}/send`,{confirm:true});
    assert.equal(response.body.status,'waiting');assert.equal(response.body.recipients[100].status,'pending');assert.equal(attempts,101);
    const file=join(dataDir,'gather.json'),db=JSON.parse(readFileSync(file,'utf8'));db.campaigns[0].retryAt=new Date(Date.now()-1000).toISOString();writeFileSync(file,JSON.stringify(db));
    await restart();response=await request(`/api/campaigns/${campaign.id}/send`,{confirm:true,compact:true});
    assert.equal(response.body.status,'sent');assert.equal(response.body.retryAt,undefined);assert.equal(mock.sends.length,103);assert.equal(attempts,104);
    assert.equal(new Set(mock.sends.map(m=>m.match(/To: ([^\r]+)/)[1])).size,103);
  });
});

test('unknown deliveries and permission failures stop later batches without an automatic retry',async t=>{
  for(const mode of ['unknown','permission'])await t.test(mode,async t=>{
    let attempts=0;
    const {request,mock,campaign}=await batchFixture(t,205,{intercept:async(url,init,mock)=>{
      attempts++;
      if(attempts===102){if(mode==='unknown')throw Error('Transport lost after Gmail submission');return json({error:{message:'Permission denied',errors:[{reason:'domainPolicy'}]}},403);}
      return mock.fetchImpl(url,init);
    }});
    const result=await globalThis.GatherCore.runCampaign(async()=>{
      const response=await request(`/api/campaigns/${campaign.id}/send`,{confirm:true,compact:true});assert.equal(response.status,200);return response.body;
    },{wait:async()=>{}});
    assert.equal(result.status,'needs_attention');assert.equal(result.progress.sent,101);assert.equal(result.progress.pending,103);assert.equal(result.progress[mode==='unknown'?'unknown':'failed'],1);assert.equal(attempts,102);
    assert.equal((await request(`/api/campaigns/${campaign.id}/send`,{confirm:true})).status,409);assert.equal(attempts,102);assert.equal(mock.sends.length,101);
  });
});
