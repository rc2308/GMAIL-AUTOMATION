import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../model-picker.js',import.meta.url),'utf8');
// Exercise the standalone controller's events without opening a browser or using credentials.
function harness({settings={},fetchImpl=async()=>{throw Error('Unexpected provider request');}}={}) {
  const config={provider:'gemini',model:'',hasKey:false,baseUrl:'',...settings};
  function element(value='') {
    const listeners={};
    return {value,innerHTML:'',textContent:'',disabled:false,hidden:false,classList:{add(){},remove(){}},
      addEventListener(name,fn){(listeners[name]||=[]).push(fn);},
      async fire(name){for(const fn of listeners[name]||[])await fn();}};
  }
  const fields={provider:element(config.provider),model:element(config.model),apiKey:element(),baseUrl:element(config.baseUrl),clearKey:element()};
  const button=element(),status=element(),description=element(),baseField=element();
  fields.baseUrl.closest=()=>baseField;
  const form={isConnected:true,elements:{namedItem:name=>fields[name]},querySelector:selector=>({'[name="model"]':fields.model,'#load-models':button,'#model-list-status':status,'#model-description':description}[selector])};
  const sandbox={document:{querySelector:()=>form},fetch:fetchImpl,FormData:class{*[Symbol.iterator](){for(const [key,item] of Object.entries(fields))yield [key,item.value];}}};
  vm.runInNewContext(source,sandbox);
  const controller=sandbox.GatherModels;
  fields.model.innerHTML=controller.field(config);
  return {config,controller,fields,button,status,description,baseField,mount:()=>controller.mount(config)};
}

test('Gemini choices are present on first render without a key or network request',()=>{
  const h=harness();const html=h.controller.field(h.config);
  assert.match(html,/>Gemini 2\.5 Flash</);assert.match(html,/>Gemini 2\.5 Pro</);assert.match(html,/>Gemini 3\.8 Flash</);
  assert.match(html,/Choose a model/);assert.match(html,/account access not checked/);
  assert.equal(h.controller.geminiCatalog.length,11);h.mount();assert.equal(h.baseField.hidden,true);
});
test('typing a key does not empty the Gemini model choices or selected model',async()=>{
  const h=harness({settings:{model:'gemini-2.5-flash'}});h.mount();
  h.fields.apiKey.value='typed-key';await h.fields.apiKey.fire('input');
  assert.equal(h.fields.model.value,'gemini-2.5-flash');assert.match(h.fields.model.innerHTML,/>Gemini 2\.5 Pro</);
});
test('refresh without a key explains account access without hiding available choices',async()=>{
  const h=harness();h.mount();await h.button.fire('click');
  assert.match(h.status.textContent,/Choose a Gemini model now/);assert.match(h.fields.model.innerHTML,/gemini-2.5-flash/);
  assert.equal(h.button.disabled,false);
});
test('a failed provider lookup preserves selected Gemini model and choices',async()=>{
  const h=harness({settings:{model:'gemini-2.5-pro'},fetchImpl:async()=>({ok:false,json:async()=>({error:'Invalid API key'})})});
  h.mount();h.fields.apiKey.value='bad-key';await h.button.fire('click');
  assert.equal(h.fields.model.value,'gemini-2.5-pro');assert.match(h.fields.model.innerHTML,/gemini-2.5-flash/);
  assert.match(h.status.textContent,/Invalid API key/);assert.equal(h.button.disabled,false);
});
test('provider switching shows only the relevant base URL and catalog',async()=>{
  const h=harness();h.mount();assert.equal(h.baseField.hidden,true);
  h.fields.provider.value='compatible';await h.fields.provider.fire('change');
  assert.equal(h.baseField.hidden,false);assert.ok(!h.fields.model.innerHTML.includes('gemini-2.5'));
  h.fields.provider.value='gemini';await h.fields.provider.fire('change');
  assert.equal(h.baseField.hidden,true);assert.match(h.fields.model.innerHTML,/gemini-2.5-flash/);
});
test('a choice made while account models load is not overwritten by the response',async()=>{
  let resolve;const response=new Promise(r=>resolve=r);
  const h=harness({fetchImpl:()=>response});h.mount();h.fields.apiKey.value='key';
  const pending=h.button.fire('click');h.fields.model.value='gemini-2.5-pro';
  resolve({ok:true,json:async()=>({models:[{id:'gemini-2.5-pro',name:'Gemini 2.5 Pro',selectable:true}]})});await pending;
  assert.equal(h.fields.model.value,'gemini-2.5-pro');assert.match(h.status.textContent,/1 models from your account/);
});

test('Claude choices render immediately with no key and no compatible base URL',async()=>{
  const h=harness({settings:{provider:'anthropic',model:'claude-sonnet-5'}});h.mount();
  const html=h.controller.field(h.config);
  for(const name of ['Claude Sonnet 5','Claude Opus 5','Claude Haiku 4.5','Claude Fable 5.1'])assert.ok(html.includes(name));
  assert.equal(h.baseField.hidden,true);assert.equal(h.fields.baseUrl.disabled,true);assert.equal(h.fields.model.value,'claude-sonnet-5');
  assert.match(h.fields.apiKey.placeholder,/Anthropic API key/);assert.match(html,/account access not checked/);
  await h.button.fire('click');assert.match(h.status.textContent,/enter your Anthropic API key/);
});

test('Claude account refresh uses a typed key and preserves a model selected during loading',async()=>{
  const calls=[];let resolve;
  const h=harness({settings:{provider:'anthropic'},fetchImpl:(url,init)=>{calls.push({url,init});return new Promise(r=>resolve=r);}});h.mount();
  h.fields.apiKey.value='typed-anthropic-key';await h.fields.apiKey.fire('input');
  const pending=h.button.fire('click');h.fields.model.value='claude-new-model';
  resolve({ok:true,json:async()=>({models:[{id:'claude-new-model',name:'Claude New Model',selectable:true},{id:'text-model',name:'Text Model',selectable:false}]})});await pending;
  assert.equal(calls[0].url,'/api/settings/models');assert.deepEqual(JSON.parse(calls[0].init.body),{provider:'anthropic',apiKey:'typed-anthropic-key',baseUrl:'',clearKey:false});
  assert.equal(h.fields.model.value,'claude-new-model');assert.match(h.fields.model.innerHTML,/Claude New Model/);assert.match(h.fields.model.innerHTML,/disabled>Text Model/);
  assert.match(h.status.textContent,/2 models from your account/);
});

test('a saved Anthropic key refreshes automatically and keeps a saved model absent from the account list',async()=>{
  const calls=[];
  const h=harness({settings:{provider:'anthropic',model:'claude-saved-alias',hasKey:true},fetchImpl:async(url,init)=>{calls.push(JSON.parse(init.body));return {ok:true,json:async()=>({models:[{id:'claude-account-model',name:'Claude Account Model',selectable:true}]})};}});
  h.mount();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);assert.equal(calls[0].apiKey,'');assert.equal(calls[0].provider,'anthropic');
  assert.equal(h.fields.model.value,'claude-saved-alias');assert.match(h.fields.model.innerHTML,/claude-saved-alias \(saved\)/);assert.match(h.status.textContent,/Saved selection not listed/);
  assert.match(h.fields.apiKey.placeholder,/Key saved/);
  h.fields.clearKey.value='on';await h.fields.clearKey.fire('change');await h.button.fire('click');
  assert.equal(calls.length,1);assert.match(h.fields.apiKey.placeholder,/Anthropic API key/);
});

test('Claude catalog and selection survive failed and empty account refreshes',async()=>{
  let failure=true;
  const h=harness({settings:{provider:'anthropic',model:'claude-sonnet-5'},fetchImpl:async()=>({ok:!failure,json:async()=>failure?{error:'Invalid Anthropic key'}:{models:[]}})});h.mount();
  h.fields.apiKey.value='test-key';await h.button.fire('click');
  assert.match(h.status.textContent,/Invalid Anthropic key.*still choose from the Claude catalog/);assert.equal(h.fields.model.value,'claude-sonnet-5');assert.match(h.fields.model.innerHTML,/Claude Opus 5/);
  failure=false;await h.button.fire('click');
  assert.match(h.status.textContent,/Showing the Claude catalog/);assert.equal(h.fields.model.value,'claude-sonnet-5');assert.match(h.fields.model.innerHTML,/Claude Haiku 4.5/);
});

test('switching to Claude discards another provider’s typed key and ignores stale model responses',async()=>{
  let resolve;const calls=[];
  const h=harness({settings:{model:'gemini-2.5-pro'},fetchImpl:(url,init)=>{calls.push(JSON.parse(init.body));return new Promise(r=>resolve=r);}});h.mount();
  h.fields.apiKey.value='gemini-key';const pending=h.button.fire('click');
  h.fields.provider.value='anthropic';await h.fields.provider.fire('change');
  assert.equal(h.fields.apiKey.value,'');assert.equal(h.fields.model.value,'');assert.equal(h.baseField.hidden,true);assert.match(h.fields.model.innerHTML,/Claude Sonnet 5/);
  assert.ok(!h.fields.model.innerHTML.includes('gemini-'));assert.equal(calls.length,1);
  resolve({ok:true,json:async()=>({models:[{id:'gemini-old-response',name:'Gemini Old Response',selectable:true}]})});await pending;
  assert.match(h.fields.model.innerHTML,/Claude Sonnet 5/);assert.ok(!h.fields.model.innerHTML.includes('gemini-old-response'));
  h.fields.apiKey.value='anthropic-key';h.fields.provider.value='compatible';await h.fields.provider.fire('change');
  assert.equal(h.fields.apiKey.value,'');assert.equal(h.baseField.hidden,false);assert.equal(h.fields.baseUrl.disabled,false);assert.ok(!h.fields.model.innerHTML.includes('claude-'));
});
