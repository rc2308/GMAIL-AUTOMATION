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
