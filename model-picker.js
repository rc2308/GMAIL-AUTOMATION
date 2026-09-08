/* Public Gemini choices are usable before account-specific model discovery.
 * Catalog verified against https://ai.google.dev/gemini-api/docs/models on 2026-09-08.
 * Account access is checked by Refresh list; the catalog is not an access guarantee. */
(() => {
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const geminiCatalog=[
    ['gemini-3.8-flash','Gemini 3.8 Flash'],
    ['gemini-3.7-flash','Gemini 3.7 Flash'],
    ['gemini-3.6-flash','Gemini 3.6 Flash'],
    ['gemini-3.5-flash','Gemini 3.5 Flash'],
    ['gemini-3.5-flash-lite','Gemini 3.5 Flash-Lite'],
    ['gemini-3.1-flash-lite','Gemini 3.1 Flash-Lite'],
    ['gemini-3.1-pro-preview','Gemini 3.1 Pro (Preview)'],
    ['gemini-3-flash-preview','Gemini 3 Flash (Preview)'],
    ['gemini-2.5-flash','Gemini 2.5 Flash'],
    ['gemini-2.5-flash-lite','Gemini 2.5 Flash-Lite'],
    ['gemini-2.5-pro','Gemini 2.5 Pro'],
  ].map(([id,name])=>({id,name,selectable:true}));
  const fallback=provider=>provider==='gemini'?[...geminiCatalog]:[];
  function options(models,current='',provider='gemini') {
    const extras=current&&!models.some(model=>model.id===current)
      ?`<option value="${escape(current)}" selected>${escape(current)} (saved)</option>`:'';
    return `<option value="">${models.length?'Choose a model':provider==='gemini'?'Choose a Gemini model':'Load your provider’s models'}</option>`+
      models.map(model=>`<option value="${escape(model.id)}" ${model.id===current?'selected':''} ${model.selectable?'':'disabled'}>${escape(model.name||model.id)}${model.selectable?'':' (not supported)'}</option>`).join('')+extras;
  }
  function field(settings) {
    return `<div class="field model-field"><label for="available-model">Model</label><select name="model" id="available-model" aria-describedby="model-list-status model-description">${options(fallback(settings.provider),settings.model,settings.provider)}</select><div class="model-picker-footer"><small id="model-list-status" role="status" aria-live="polite">${settings.provider==='gemini'?'Gemini catalog · account access not checked':'Load models from your provider.'}</small><button type="button" class="button text" id="load-models">↻ Refresh list</button></div><small id="model-description"></small></div>`;
  }
  function mount(settings) {
    const form=document.querySelector('#settings-form');if(!form)return;
    const select=form.querySelector('[name="model"]'),button=form.querySelector('#load-models');
    const status=form.querySelector('#model-list-status'),description=form.querySelector('#model-description');
    const baseField=form.elements.namedItem('baseUrl').closest('.field');
    let sequence=0,models=fallback(settings.provider),loading=false;
    const values=()=>Object.fromEntries(new FormData(form));
    const usingSavedKey=raw=>settings.hasKey&&!raw.clearKey&&raw.provider===settings.provider&&(raw.provider==='gemini'||String(raw.baseUrl||'').trim()===settings.baseUrl);
    const canLoad=raw=>raw.provider==='gemini'?Boolean(!raw.clearKey&&(raw.apiKey?.trim()||usingSavedKey(raw))):Boolean(raw.baseUrl?.trim());
    const explain=()=>{description.textContent=select.value||'';};
    const showProviderFields=()=>{baseField.hidden=form.elements.namedItem('provider').value==='gemini';};
    function reset(clearSelection=false) {
      sequence++;loading=false;button.disabled=false;button.textContent='↻ Refresh list';select.disabled=false;
      const raw=values(),old=clearSelection?'':select.value;models=fallback(raw.provider);
      select.innerHTML=options(models,old,raw.provider);select.value=old;
      status.classList.remove('inline-error');status.textContent=raw.provider==='gemini'?'Gemini catalog · account access not checked':'Load models from your provider.';
      showProviderFields();explain();
    }
    async function load() {
      if(loading)return;
      const raw=values(),requestId=++sequence;
      if(!canLoad(raw)) {
        status.classList.remove('inline-error');
        status.textContent=raw.provider==='gemini'?'Choose a Gemini model now; enter your key to check account access.':'Enter your provider base URL to load its models.';
        return;
      }
      loading=true;button.disabled=true;button.textContent='Refreshing…';status.classList.remove('inline-error');status.textContent='Checking models available to your account…';
      try {
        const response=await fetch('/api/settings/models',{method:'POST',headers:{'content-type':'application/json','x-gather-client':'1'},body:JSON.stringify({provider:raw.provider,apiKey:raw.apiKey,baseUrl:raw.baseUrl,clearKey:raw.clearKey==='on'})});
        const result=await response.json();if(!response.ok)throw Error(result.error||'Unable to load models.');
        if(requestId!==sequence||!form.isConnected)return;
        if(!Array.isArray(result.models))throw Error('The provider did not return a model list.');
        // Preserve a selection made while the request was in flight.
        const current=select.value;models=result.models;
        const known=models.some(model=>model.id===current);
        if(!models.length&&raw.provider==='gemini') {
          models=fallback(raw.provider);select.innerHTML=options(models,current,raw.provider);
          status.textContent='No account models returned. Showing the Gemini catalog.';
        } else {
          select.innerHTML=options(models,current,raw.provider);
          status.textContent=models.length?`${models.length} models from your account.${current&&!known?' Saved selection not listed.':''}`:'No models returned. Load a model on your local server or check account access.';
        }
        select.value=current;button.textContent='↻ Refresh list';explain();
      } catch(error) {
        if(requestId!==sequence||!form.isConnected)return;
        // Keep visible catalog options usable when the account request fails.
        status.textContent=`${error.message}${raw.provider==='gemini'?' You can still choose from the Gemini catalog.':''}`;
        status.classList.add('inline-error');button.textContent='↻ Try again';
      } finally {
        if(requestId===sequence&&form.isConnected){loading=false;button.disabled=false;}
      }
    }
    button.addEventListener('click',load);select.addEventListener('change',explain);
    for(const name of ['apiKey','baseUrl']) {
      const input=form.elements.namedItem(name);
      input.addEventListener('input',()=>reset(name==='baseUrl'));
      input.addEventListener('change',()=>{if(canLoad(values()))load();});
    }
    form.elements.namedItem('provider').addEventListener('change',()=>{reset(true);if(canLoad(values()))load();});
    form.elements.namedItem('clearKey').addEventListener('change',()=>reset());
    showProviderFields();explain();if(canLoad(values()))load();
  }
  globalThis.GatherModels={field,mount,geminiCatalog};
})();
