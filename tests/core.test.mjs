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
