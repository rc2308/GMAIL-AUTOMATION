import test from 'node:test';
import assert from 'node:assert/strict';
import '../core.js';
const C=globalThis.GatherCore;

test('multiple emails and phone numbers are retained and normalized',()=>{
  const result=C.contact({emails:' SALES@EXAMPLE.COM; owner@example.com\nsales@example.com',phones:'+91 90000 12345\n+91 90000 54321'});
  assert.deepEqual(result.emails,['sales@example.com','owner@example.com']);
  assert.equal(result.phones.length,2);
  assert.throws(()=>C.contact({emails:'not an email'}),/invalid email/);
});
test('duplicates match normalized emails, phone formatting and business names',()=>{
  const existing=[{id:'one',business:'ABC & Co',emails:['HELLO@example.com'],phones:['+91 (90000) 12345']}];
  const result=C.duplicates({business:'ABC Co',emails:['hello@example.com'],phones:['00919000012345']},existing);
  assert.equal(result.length,1);assert.deepEqual(result[0].reasons,['Same email','Same phone','Same business']);
});
test('merging retains existing names and all addresses without clearing exclusions',()=>{
  const merged=C.merge({id:'one',name:'Original',business:'ABC',emails:['sales@example.com'],phones:['+1 555 0100'],excludedEmails:['sales@example.com']},{name:'Incoming',emails:['sales@example.com','owner@example.com'],phones:['+1 555 0101']});
  assert.equal(merged.name,'Original');assert.equal(merged.emails.length,2);assert.equal(merged.phones.length,2);assert.deepEqual(merged.excludedEmails,['sales@example.com']);
});
test('campaign deduplication produces one recipient per email and respects exclusions',()=>{
  const result=C.recipients([{id:'one',emails:['hello@example.com','sales@example.com'],excludedEmails:['sales@example.com']},{id:'two',emails:['HELLO@example.com','owner@example.com']}]);
  assert.deepEqual(result.map(r=>r.email),['hello@example.com','owner@example.com']);
});
test('greetings do not assign one card name to every business address',()=>{
  assert.equal(C.personalise('Hello {{contact_name}} at {{business_name}}',{name:'Alice',business:'ABC'}),'Hello ABC team at ABC');
  assert.equal(C.personalise('Hello {{contact_name}}',{}),'Hello there');
});

test('campaigns divide arbitrary recipient counts into stable batches of 100',()=>{
  for(const total of [0,1,99,100,101,500,537,10001]) {
    const campaign={recipients:Array.from({length:total},()=>({status:'pending'}))};
    const progress=C.campaignProgress(campaign);
    assert.equal(progress.totalBatches,Math.ceil(total/100));assert.equal(progress.batchSize,100);
    assert.equal(progress.pending,total);assert.equal(progress.batchTotal,Math.min(total,100));
    campaign.recipients.forEach(r=>r.status='sent');
    assert.equal(C.campaignProgress(campaign).completedBatches,Math.ceil(total/100));
  }
  const campaign={batchSize:100,recipients:Array.from({length:537},(_,i)=>({status:i<500?'sent':'pending'}))};
  assert.deepEqual(C.campaignProgress(campaign),{sent:500,pending:37,failed:0,unknown:0,sending:0,total:537,batchSize:100,totalBatches:6,currentBatch:6,completedBatches:5,batchSent:0,batchTotal:37});
  campaign.recipients[501].status='unknown';
  assert.equal(C.campaignProgress(campaign).unknown,1);assert.equal(C.campaignProgress(campaign).completedBatches,5);
});

test('one campaign run advances every batch automatically and stops when complete',async()=>{
  let calls=0;const seen=[];
  const result=await C.runCampaign(async()=>({status:++calls===6?'sent':'paused',batch:calls}),{wait:async()=>{},onProgress:value=>seen.push(value.batch)});
  assert.equal(result.status,'sent');assert.equal(calls,6);assert.deepEqual(seen,[1,2,3,4,5,6]);
});

test('automatic sending waits until Gmail retry time and can pause during a long quota wait',async()=>{
  let time=1000,calls=0;const waits=[];
  const result=await C.runCampaign(async()=>{
    if(++calls===1)return {status:'waiting',retryAt:new Date(4500).toISOString()};
    assert.ok(time>=4500);return {status:'sent'};
  },{clock:()=>time,wait:async ms=>{waits.push(ms);time+=ms;}});
  assert.equal(result.status,'sent');assert.equal(calls,2);assert.deepEqual(waits,[1000,1000,1000,500]);
  let paused=false;calls=0;
  const stopped=await C.runCampaign(async()=>{calls++;return {status:'waiting',retryAt:new Date(86400000).toISOString()};},{clock:()=>5000,shouldPause:()=>paused,wait:async()=>{paused=true;}});
  assert.equal(stopped.status,'waiting');assert.equal(calls,1);
});

test('automatic sending never retries unknown outcomes, failed requests, or user-paused runs',async()=>{
  let calls=0;
  assert.equal((await C.runCampaign(async()=>{calls++;return {status:'needs_attention'};})).status,'needs_attention');assert.equal(calls,1);
  await assert.rejects(C.runCampaign(async()=>{calls++;throw Error('Response lost');}),/Response lost/);assert.equal(calls,2);
  assert.equal(await C.runCampaign(async()=>{throw Error('Must not send');},{shouldPause:()=>true}),null);
});

test('40 cards run in groups of 10 with one retry only for failed cards in each group',async()=>{
  const cards=Array.from({length:40},(_,i)=>({id:String(i),automaticAttempts:0})),calls=[],attempts=new Map(),progress=[];
  const result=await C.runCardBatches(cards,{wait:async()=>{},onProgress:p=>progress.push(p),extract:async card=>{
    calls.push(Number(card.id));const count=(attempts.get(card.id)||0)+1;attempts.set(card.id,count);
    if(card.id==='17'||(card.id==='2'&&count===1))throw Error('Unreadable card');
    return {status:'approved'};
  }});
  assert.equal(C.cardUploadLimit,40);assert.equal(C.cardBatchSize,10);assert.equal(result.totalBatches,4);
  assert.equal(result.completed,39);assert.deepEqual(result.failed,[{id:'17',error:'Unreadable card'}]);
  assert.deepEqual(calls.slice(0,11),[0,1,2,3,4,5,6,7,8,9,2]);
  assert.deepEqual(calls.slice(11,22),[10,11,12,13,14,15,16,17,18,19,17]);
  assert.equal(calls.length,42);assert.ok([...attempts.values()].every(count=>count<=2));
  assert.deepEqual(progress.filter(p=>p.attempt===2).map(p=>[p.card.id,p.batch]),[['2',1],['17',2]]);
});

test('a resumed card has only its remaining automatic attempt and does not retry successful cards',async()=>{
  const card={id:'retry',assetId:'image',status:'needs_attention',extractionState:'failed',automaticAttempts:1,automaticRetryPending:true};
  assert.equal(C.cardNeedsAutomaticRead(card),true);assert.equal(C.cardNeedsAutomaticRead({...card,automaticAttempts:2}),false);
  assert.equal(C.cardNeedsAutomaticRead({...card,status:'approved'}),false);
  let calls=0;const result=await C.runCardBatches([card],{extract:async()=>{calls++;return {status:'needs_attention',error:'Still unreadable'};},wait:async()=>{throw Error('No additional retry allowed');}});
  assert.equal(calls,1);assert.equal(result.failed.length,1);
});
