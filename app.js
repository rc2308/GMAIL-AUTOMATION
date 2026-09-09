/* Gather: workspaces, capture, communication, templates and configuration. */
(() => {
  const C=globalThis.GatherCore, app=document.querySelector('#app');
  const $=selector=>document.querySelector(selector);
  const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let data={workspaces:[],contacts:[],uploads:[],templates:[],campaigns:[],assets:[],connections:{gmail:{connected:false},sheets:{connected:false}},settings:{provider:'gemini',model:'',enabled:false},oauthConfigured:false};
  const labels={overview:'Overview',workspaces:'Workspaces',contacts:'Contacts',upload:'Upload cards',communication:'Communication',templates:'Templates',connections:'Connections',settings:'Settings'};
  const icons={overview:'◫',workspaces:'▦',contacts:'♙',upload:'↥',communication:'✉',templates:'▤',connections:'⇄',settings:'⚙'};
  let view=Object.hasOwn(labels,location.hash.slice(1))?location.hash.slice(1):'workspaces';
  let selected='', online=false,busy=false,search='',mailFilter='all',approvingExisting=false;
  const expandedCampaigns=new Set();
  let templateDraft=null,reviewAction='',reviewTarget='',pauseCampaign=false;
  const attemptedExtraction=new Set(),extractionErrors=new Map();
  const aiReady=()=>Boolean(data.settings.extractionReady ?? (data.settings.enabled&&data.settings.model&&data.settings.hasKey));
  const queuedCards=()=>data.uploads.filter(u=>C.cardNeedsAutomaticRead(u)&&!attemptedExtraction.has(u.id));
  const uploadStatus=u=>['approved','skipped'].includes(u.status)?u.status:extractionErrors.has(u.id)?'Retry needed':u.automaticRetryPending?'Retry queued':({queued:'Queued for AI',needs_setup:'AI setup needed',extracting:'Reading with AI…',complete:'Ready to review',failed:'Needs attention'}[u.extractionState]||u.status);
  const selectedContacts=new Set(),excludedEmails=new Set();
  const workspaceStorageKey=()=>`gather-workspace-v2:${data.user?.id||'anonymous'}`;
  const ws=()=>data.workspaces.find(w=>w.id===selected);
  const scoped=(key,wid=selected)=>data[key].filter(r=>r.workspace===wid);
  const asset=aid=>data.assets.find(a=>a.id===aid);
  const pending=(wid=selected)=>scoped('uploads',wid).filter(u=>!['approved','skipped'].includes(u.status));
  const date=value=>value?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'—';
  const button=(text,action,kind='secondary',attrs='')=>`<button class="button ${kind}" type="button" data-action="${action}" ${attrs}>${text}</button>`;
  const badge=(text,tone='gray')=>`<span class="pill ${tone}">${e(String(text).replaceAll('_',' '))}</span>`;
  const field=(label,name,value='',attrs='')=>`<label class="field"><span>${e(label)}</span><input name="${name}" value="${e(value)}" ${attrs}></label>`;
  const workspaceSelect=(name,value=selected)=>`<select name="${name}" aria-label="${name==='uploadWorkspace'?'Upload destination workspace':'Workspace'}">${data.workspaces.length?data.workspaces.map(w=>`<option value="${w.id}" ${w.id===value?'selected':''}>${e(w.name)}</option>`).join(''):'<option value="">Create a workspace first</option>'}</select>`;
  const title=(heading,description,actions='')=>`<div class="view-head"><div><div class="eyebrow">${['connections','settings','workspaces'].includes(view)?'Your outreach hub':e(ws()?.name||'Your outreach hub')}</div><h1>${heading}</h1><p>${description}</p></div><div class="top-actions">${actions}</div></div>`;
  const empty=(heading,description,action='')=>`<section class="empty-state"><div class="empty-icon">${icons[view]}</div><h2>${heading}</h2><p>${description}</p>${action}</section>`;
  const requireWorkspace=()=>empty('Start with a workspace','Give an occasion or project its own contacts, spreadsheet, templates, and outreach history.',button('+ Create workspace','new-workspace','primary'));
  const stat=(name,count,detail)=>`<article class="stat"><div class="stat-label">${name}</div><div class="stat-value">${count}</div><div class="stat-foot">${detail}</div></article>`;
  function sidebar(){
    const groups=[['WORKSPACE',['overview','workspaces','contacts','upload']],['OUTREACH',['communication','templates']],['CONFIGURATION',['connections','settings']]];
    return `<aside class="sidebar"><a class="brand" href="#workspaces"><span class="brand-mark"></span>Gather<span class="brand-label">CRM</span></a><div class="workspace-card"><div class="eyebrow">Current workspace</div>${workspaceSelect('workspace')}</div><nav aria-label="Main navigation">${groups.map(([name,items])=>`<div class="nav-group"><div class="eyebrow">${name}</div><div class="nav">${items.map(key=>`<a href="#${key}" class="${view===key?'active':''}" ${view===key?'aria-current="page"':''}><span class="nav-icon" aria-hidden="true">${icons[key]}</span><span>${labels[key]}</span>${key==='upload'&&pending().length?badge(pending().length):''}</a>`).join('')}</div></div>`).join('')}</nav><div class="side-footer"><span class="avatar">G</span><div><strong>${e(data.user?.name||'Gather account')}</strong><small>${e(data.user?.email||'')}</small><small><a href="/privacy" target="_blank" rel="noopener">Privacy</a> · <a href="/terms" target="_blank" rel="noopener">Terms</a></small></div></div></aside>`;
  }
  function topbar(){const ready=data.connections.gmail.connected&&data.connections.sheets.connected;return `<header class="topbar"><span class="breadcrumb">Gather <span>/</span> ${labels[view]}</span><div class="top-actions"><a href="#connections" class="connection"><span class="dot ${ready?'':'off'}"></span>${ready?'Google accounts connected':'Set up connections'}</a>${button('↻ Refresh','refresh','text')}${button(e(data.user?.name||'Account'),'account','text account-trigger')}${button('Sign out','logout','secondary')}</div></header>`;}
  function overview(){
    if(!ws())return requireWorkspace();const deliveries=scoped('campaigns').flatMap(c=>c.recipients);
    const steps=[['1','Connect your accounts',data.connections.gmail.connected&&data.connections.sheets.connected,'connections','Gmail for sending, Google Sheets for contacts.'],['2','Connect this workspace’s spreadsheet',Boolean(ws().sheetId),'workspaces','One spreadsheet for this occasion.'],['3','Upload and review cards',scoped('contacts').length>0,'upload','Check every email and phone number before saving.'],['4','Create an email template',scoped('templates').length>0,'templates','Your message, subject, and images.']];
    return title('Workspace overview','A clear view of your contacts and outreach.',button('Upload cards','go-upload')+button('Send bulk email','compose-all','primary'))+`<section class="stats">${stat('Contacts',scoped('contacts').length,'In this workspace')}${stat('Email addresses',C.recipients(scoped('contacts')).length,'Unique approved addresses')}${stat('Emails sent',deliveries.filter(r=>r.status==='sent').length,'Confirmed by Gmail')}${stat('Cards to review',pending().length,'Waiting for your review')}</section><div class="dashboard-grid"><article class="card"><div class="card-head"><h2>Get this workspace ready</h2></div>${steps.map(([n,name,done,target,copy])=>`<a href="#${target}" class="setup-step"><span class="step-number ${done?'complete':''}">${done?'✓':n}</span><div><strong>${name}</strong><p>${copy}</p></div><span>↗</span></a>`).join('')}</article><article class="card form-card"><div class="eyebrow">WORKSPACE SPREADSHEET</div><h2 class="section-title">${e(ws().sheetName)}</h2><p class="muted">${ws().sheetId?'Linked to this workspace':'No Google spreadsheet connected yet.'}</p>${ws().sheetId?`<a class="button secondary" href="https://docs.google.com/spreadsheets/d/${e(ws().sheetId)}" target="_blank" rel="noopener">Open spreadsheet ↗</a><p class="muted">New and updated contacts sync automatically.</p><p class="muted">Last synced: ${date(ws().syncedAt)}</p>${button(ws().syncError?'Retry sync':'Refresh from sheet','sync-sheet','secondary')}`:button('Connect spreadsheet','bind-sheet','primary',`data-id="${selected}"`)}${ws().syncError?`<p class="inline-error">${e(ws().syncError)}</p>`:''}</article></div>`;
  }
  function workspaces(){return title('Workspaces','One occasion. One contact list. One spreadsheet.',button('Link existing spreadsheet','link-existing-sheet')+button('+ Create workspace','new-workspace','primary'))+(data.workspaces.length?`<section class="workspace-grid">${data.workspaces.map(w=>`<article class="card workspace-item ${w.id===selected?'chosen':''}"><div class="workspace-heading"><span class="workspace-symbol">▦</span>${badge(w.id===selected?'Current workspace':'Workspace',w.id===selected?'':'gray')}</div><h2>${e(w.name)}</h2><p>${e(w.purpose||'Contacts and outreach')}</p><div class="workspace-numbers"><strong>${scoped('contacts',w.id).length}</strong> contacts <span>·</span> <strong>${scoped('templates',w.id).length}</strong> templates</div><div class="spreadsheet"><span>▦</span><div><strong>${e(w.sheetName)}</strong><small>${w.sheetId?'Connected · '+e(w.sheetEmail):'Spreadsheet not connected'}</small></div></div><div class="workspace-buttons">${button('Open workspace →','open-workspace','primary',`data-id="${w.id}"`)}${w.sheetId?`<a href="https://docs.google.com/spreadsheets/d/${e(w.sheetId)}" target="_blank" rel="noopener" class="button secondary">Sheet ↗</a>${button('Scan for contacts','import-sheet','secondary',`data-id="${w.id}"`)}`:button('Link existing spreadsheet','link-existing-sheet','secondary',`data-id="${w.id}"`)+button('Create new spreadsheet','create-sheet','text',`data-id="${w.id}"`)}</div></article>`).join('')}</section><div class="card import-banner"><div><h2>Bring contacts into another workspace</h2><p>Choose contacts to copy, then resolve duplicates in the destination workspace.</p></div>${button('Copy contacts','copy-contacts')}</div>`:requireWorkspace());}
  function contactRows(rows){return rows.map(c=>`<tr><td><input type="checkbox" class="checkbox" aria-label="Select ${e(c.business||c.name)}" data-contact-select="${c.id}" ${selectedContacts.has(c.id)?'checked':''}></td><td><div class="contact-name"><span class="contact-avatar">${e((c.name||c.business||'?').slice(0,2).toUpperCase())}</span><div>${e(c.name||'—')}<small>${e(c.role)}</small></div></div></td><td><strong>${e(c.business||'—')}</strong></td><td><div class="email-stack">${c.emails.map(address=>`<span class="${c.excludedEmails?.includes(address)?'excluded':'email'}">${e(address)}</span>`).join('')||'<span class="muted">No email address</span>'}</div></td><td><div class="email-stack">${c.phones.map(n=>`<span>${e(n)}</span>`).join('')||'—'}</div></td><td>${badge(c.dirty?(ws()?.sheetId?'Sync pending':'Awaiting spreadsheet'):'Synced',c.dirty?'cream':'')}</td><td>${button('Edit','edit-contact','text',`data-id="${c.id}"`)}</td></tr>`).join('');}
  const filteredContacts=()=>scoped('contacts').filter(c=>[c.name,c.business,...c.emails,...c.phones].join(' ').toLowerCase().includes(search.toLowerCase()));
  function syncSaveMessage(wid,prefix){
    const workspace=data.workspaces.find(w=>w.id===wid);
    return prefix+' '+(!workspace?.sheetId?'It will sync automatically when you connect a spreadsheet.':workspace.syncError?'Spreadsheet sync needs attention. Open Contacts to retry; your contact data is saved.':'Contacts synced automatically to the spreadsheet.');
  }
  function sheetImportMessage(wid,result,prefix='Spreadsheet connected.'){
    const imported=Number(result?.imported||0),updated=Number(result?.updated||0);
    const summary=imported?`${imported} contact${imported===1?'':'s'} imported automatically.`:updated?`${updated} existing contact${updated===1?' was':'s were'} updated.`:'No new email contacts were found.';
    const skipped=result?.skippedTabs?.length?' Some tabs could not be read; scan again after checking their access.':'';
    return syncSaveMessage(wid,`${prefix} ${summary}${skipped}`);
  }
  function syncNotice(){
    return ws().syncError?`<div class="notice" role="alert"><strong>Your contacts are saved. Spreadsheet sync needs attention.</strong> ${e(ws().syncError)} Use Retry sync after resolving the issue.</div>`:`<div class="notice">${ws().sheetId?'New and updated contacts sync automatically. Use Refresh from sheet to import changes made in Google Sheets.':'Contacts are saved here and will sync automatically when you connect a workspace spreadsheet.'}</div>`;
  }
  function contacts(){
    if(!ws())return requireWorkspace();
    return title('Contacts','All email addresses and phone numbers, together under the right business.',button('Add contact','add-contact')+button(ws().syncError?'Retry sync':'Refresh from sheet','sync-sheet','secondary',ws().sheetId?'':'disabled'))+`${syncNotice()}<div class="toolbar"><input class="search" id="contact-search" aria-label="Search contacts" placeholder="Search name, business, or email" value="${e(search)}"><div class="top-actions">${button('Copy to workspace','copy-contacts')}${button('Scan spreadsheet','import-sheet','secondary',ws().sheetId?'':'disabled')}</div></div>`+(scoped('contacts').length?`<div class="card table-wrap"><table class="data-table"><thead><tr><th><span class="sr-only">Select</span></th><th>Contact</th><th>Business</th><th>Email addresses</th><th>Phone numbers</th><th>Spreadsheet</th><th></th></tr></thead><tbody id="contacts-body">${contactRows(filteredContacts())}</tbody></table></div>`:empty('Your contact list starts here','Upload visiting cards or add a contact manually.',button('Upload cards','go-upload','primary')));
  }
  function upload(){
    if(!ws())return requireWorkspace();const rows=scoped('uploads');
    return title('Upload visiting cards','Upload your cards. AI reads and approves valid contact details automatically.',button('Retry unread cards','extract-all','secondary',aiReady()&&pending().some(u=>u.assetId&&u.status!=='review')?'':'disabled'))+`<section class="upload-controls card"><label class="field"><span>Upload to workspace</span>${workspaceSelect('uploadWorkspace')}</label><div class="upload-destination"><span>▦</span><div><strong>${e(ws().sheetName)}</strong><small>${ws().sheetId?'Approved contacts sync here automatically.':'Connect the spreadsheet from Workspaces.'}</small></div></div>${badge(`${pending().length} awaiting processing`,'cream')}</section><div class="dropzone" id="dropzone"><span class="drop-illustration">↥</span><div><h2>Drop your visiting card photos here</h2><p>JPEG, PNG, or WebP · ${data.limits?.imageMB||8} MB per image · ${data.limits?.maxCardUploads||C.cardUploadLimit} cards per upload · groups of ${C.cardBatchSize}</p></div><label class="button primary upload-label">Choose photos<input type="file" id="card-files" accept="image/jpeg,image/png,image/webp" multiple></label></div>${!aiReady()?`<div class="notice"><strong>Set up AI once to read cards automatically.</strong> <a href="#settings">Choose a model, save your provider key, and enable extraction in Settings.</a> You can upload now; your cards will wait and start automatically after setup.</div>`:'<div class="notice">AI processes cards in groups of 10 and retries failed reads once. After valid contacts are saved, their card images are removed to free storage. Cards that still fail keep their images for review.</div>'}<div class="card table-wrap"><table class="data-table"><thead><tr><th>Card / source</th><th>Business</th><th>Email addresses</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(u=>{const dup=C.duplicates({...u.fields,id:u.id},[...scoped('contacts'),...pending().filter(v=>v.id!==u.id).map(v=>({...v.fields,id:v.id}))]);return `<tr><td><div class="upload-file">${u.assetId&&!u.imageCleanupPending?`<img src="/assets/${u.assetId}" alt="${e(u.filename)}" class="card-thumbnail">`:'<span class="source-icon">▤</span>'}<span>${e(u.filename)}${u.imageRemovedAt?'<small>Image removed after extraction</small>':u.imageCleanupPending?`<small>${e(u.imageCleanupError||'Image cleanup pending')}</small>`:''}</span></div></td><td>${e(u.fields.business||u.fields.name||'Awaiting details')}</td><td>${e(u.fields.emails.join(', ')||'—')}</td><td>${badge(uploadStatus(u),u.status==='approved'?'':u.error||extractionErrors.has(u.id)?'peach':'gray')}${dup.length&&!['approved','skipped'].includes(u.status)?badge('Possible duplicate','cream'):''}${u.error||extractionErrors.has(u.id)?`<small class="inline-error">${e(u.error||extractionErrors.get(u.id))}</small>`:''}</td><td>${!['approved','skipped'].includes(u.status)?`${button('Review','review-upload','primary',`data-id="${u.id}"`)}${u.assetId&&aiReady()&&(['failed','complete'].includes(u.extractionState)||extractionErrors.has(u.id)||(!u.extractionState&&u.status!=='uploaded'))?button(u.status==='review'?'Re-extract':'Retry AI','extract-upload','text',`data-id="${u.id}"`):''}`:'✓ Resolved'}</td></tr>`;}).join('')||'<tr><td colspan="5" class="table-empty">Your uploads and imported contacts will appear here.</td></tr>'}</tbody></table></div>`;
  }
  function templateEditor(){
    if(!ws())return requireWorkspace();const templates=scoped('templates');
    if(!templateDraft||templateDraft.workspace!==selected)templateDraft=templates[0]?structuredClone(templates[0]):{workspace:selected,name:'',subject:'',body:'',assetIds:[]};
    const t=templateDraft;
    return title('Email templates','Write once. Personalise every email. Keep templates separate for each workspace.',button('+ New template','new-template','primary'))+`<div class="templates-layout"><aside class="card template-list"><div class="card-head"><h2>Saved templates <span class="count">${templates.length}</span></h2></div>${templates.map(item=>`<button class="template-list-item ${item.id===t.id?'active':''}" type="button" data-action="select-template" data-id="${item.id}"><span>▤</span><div><strong>${e(item.name)}</strong><small>${e(item.subject)}</small></div></button>`).join('')||'<p class="muted empty-copy">Your saved templates will appear here.</p>'}</aside><form id="template-form" class="card form-card"><div class="editor-heading"><h2>${t.id?'Edit template':'Create a template'}</h2>${badge(t.id?'Saved template':'New template')}</div>${field('Template name','name',t.name,'required placeholder="e.g. Exhibition follow-up"')}${field('Subject','subject',t.subject,'required placeholder="Great meeting your team"')}<label class="field"><span>Message</span><textarea name="body" required rows="11" placeholder="Hello {{contact_name}},">${e(t.body)}</textarea><small>Fields: {{contact_name}}, {{business_name}}, {{email}}. An unassigned name uses the business team as the greeting.</small></label><div class="image-section"><div><strong>Images in your email</strong><p>Images are embedded below your message.</p></div><label class="button secondary upload-label">+ Add images<input id="template-images" type="file" accept="image/jpeg,image/png,image/webp" multiple></label></div><div class="image-strip">${t.assetIds.map(aid=>`<div class="attachment-card"><img src="/assets/${aid}" alt="${e(asset(aid)?.name)}"><span>${e(asset(aid)?.name)}</span>${button('Remove','remove-template-image','text',`data-id="${aid}"`)}</div>`).join('')}</div><div class="form-footer">${button('Preview email','preview-template')}<button class="button primary" type="submit">Save template</button></div></form></div>`;
  }
  const deliveryFilters=[['all','All messages'],['sent','Sent'],['pending','Pending'],['failed','Failed'],['unknown','Unknown']];
  const deliveryTone=status=>status==='sent'?'':status==='failed'||status==='unknown'?'peach':'gray';
  function campaignStatusPanel(c,p){
    const rows=c.recipients.map((r,index)=>({...r,index})).filter(r=>mailFilter==='all'||r.status===mailFilter);
    const statusCount=status=>c.recipients.filter(r=>r.status===status).length;
    return `<div class="campaign-status-panel" id="campaign-status-${e(c.id)}"><div class="campaign-status-head"><div><strong>Email statuses</strong><small>${p.sent} sent · ${p.pending} pending · ${statusCount('failed')+statusCount('unknown')} need attention</small></div><div class="campaign-status-metrics">${['sent','pending','failed','unknown'].map(status=>`<span>${e(status)} <strong>${statusCount(status)}</strong></span>`).join('')}</div></div><div class="toolbar campaign-filter-toolbar"><div class="tabs" role="group" aria-label="Filter ${e(c.name)} delivery status">${deliveryFilters.map(([key,label])=>`<button type="button" data-action="mail-filter" data-id="${key}" class="${mailFilter===key?'active':''}">${label}</button>`).join('')}</div></div><div class="campaign-status-table"><table class="data-table"><thead><tr><th>Email ID</th><th>Contact</th><th>Status</th><th>Email sent</th><th>Batch</th><th>Gmail</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${e(r.email)}</strong></td><td>${e(r.business||r.name||'—')}</td><td>${badge(r.status,deliveryTone(r.status))}${r.error?`<small class="inline-error">${e(r.error)}</small>`:''}</td><td>${date(r.sentAt)}</td><td>Batch ${Math.floor(r.index/p.batchSize)+1}</td><td>${r.messageId?`<a href="https://mail.google.com/mail/u/?authuser=${encodeURIComponent(c.sender)}#all/${encodeURIComponent(r.messageId)}" target="_blank" rel="noopener">Open</a>`:'—'}</td></tr>`).join('')||'<tr><td colspan="6" class="table-empty">No emails match this status filter.</td></tr>'}</tbody></table></div></div>`;
  }
  function communication(){
    if(!ws())return requireWorkspace();const campaigns=scoped('campaigns');
    const campaignIds=new Set(campaigns.map(c=>c.id));expandedCampaigns.forEach(id=>{if(!campaignIds.has(id))expandedCampaigns.delete(id);});
    const recipients=campaigns.flatMap(c=>c.recipients.map(r=>({...r,campaign:c})));
    const count=status=>recipients.filter(r=>r.status===status).length;
    return title('Communication','Send through Gmail and see exactly which addresses received your message.',button('Send bulk email','compose-all','primary'))+`<div class="sender-bar card"><span class="service-icon gmail">M</span><div><strong>${data.connections.gmail.connected?e(data.connections.gmail.email):'No Gmail account connected'}</strong><small>Each approved address receives a separate email.</small></div><a href="#connections" class="button secondary">Manage connection</a></div><section class="stats">${stat('Campaigns',campaigns.length,'This workspace')}${stat('Sent',count('sent'),'Confirmed by Gmail')}${stat('Pending',count('pending'),'Not submitted to Gmail')}${stat('Needs attention',count('failed')+count('unknown'),'Check delivery details')}</section>${campaigns.length?`<div class="campaign-queue">${campaigns.map(c=>{const p=C.campaignProgress(c),open=expandedCampaigns.has(c.id),needsSend=['draft','paused','waiting'].includes(c.status);return `<article class="card campaign-card ${open?'open':''}"><div class="campaign-card-header"><div class="campaign-card-main"><strong>${e(c.name)}</strong><small>${p.sent} / ${p.total} emails sent · ${p.completedBatches} / ${p.totalBatches} batches complete${c.status==='waiting'?` · Waiting until ${date(c.retryAt)}`:''}</small></div><div class="campaign-card-actions">${badge(c.status,c.status==='sent'?'':c.status==='needs_attention'?'peach':'gray')}${needsSend?button(c.status==='draft'?'Review & send':'Resume campaign','view-campaign','primary',`data-id="${c.id}"`):''}${button(open?'Hide campaign':'View campaign','toggle-campaign','secondary campaign-toggle',`data-id="${c.id}" aria-expanded="${open}" aria-controls="campaign-status-${e(c.id)}"`)}</div></div>${open?campaignStatusPanel(c,p):''}</article>`;}).join('')}</div>`:empty('No campaigns yet','Create a template, then send your first campaign from this workspace.',button('Send bulk email','compose-all','primary'))}`;
  }
  function connections(){
    return title('Connections','Connect Gmail and Google Sheets with Google sign-in. No Gmail or Sheets API keys to paste.')+`<div class="connector-grid">${[['gmail','Gmail','Send your templates from your own Gmail address.','M'],['sheets','Google Sheets','Keep one spreadsheet connected to each workspace.','▦']].map(([kind,name,copy,mark])=>{const connection=data.connections[kind];return `<article class="card connection-card"><div class="connector-heading"><span class="service-icon ${kind}">${mark}</span>${badge(connection.connected?'Connected':'Not connected',connection.connected?'':'gray')}</div><h2>${name}</h2><p>${copy}</p><div class="account-detail">${connection.email?`<strong>${e(connection.email)}</strong>`:'No account connected'}${connection.error?`<p class="inline-error">${e(connection.error)}</p>`:''}</div><div class="form-footer">${button(connection.connected?'Reconnect Google account':`Connect ${name}`,'connect','primary',`data-kind="${kind}"`)}${connection.email?button('Disconnect','disconnect','text',`data-kind="${kind}"`):''}</div></article>`;}).join('')}</div><article class="card form-card connection-guide"><h2>Your accounts, your workspaces</h2><div class="guide-grid"><div><strong>1. Connect accounts</strong><p>Grant Gmail sending access and Google Sheets read/write access.</p></div><div><strong>2. Choose a spreadsheet</strong><p>Create or link one spreadsheet from each workspace’s card.</p></div><div><strong>3. Start your outreach</strong><p>Save contacts, choose a template, and review your recipient list.</p></div></div></article>${!data.oauthConfigured?`<details class="card setup-details" open><summary>Google sign-in needs a one-time application setup</summary><p>Your developer must configure the Google OAuth client on this server. Customers only use the Connect buttons above.</p><dl><dt>Required APIs</dt><dd>Gmail API and Google Sheets API</dd><dt>Redirect URL</dt><dd><code>http://localhost:3088/api/oauth/google/callback</code></dd><dt>Server configuration</dt><dd><code>GOOGLE_OAUTH_CLIENT_ID</code> and <code>GOOGLE_OAUTH_CLIENT_SECRET</code> in the local <code>.env</code> file.</dd></dl><p>Restart the server after changing this configuration. No Google credentials are entered into this page.</p></details>`:''}`;
  }
  function settings(){const s=data.settings;return title('Settings','Choose the LLM that reads your visiting cards.')+`<div class="settings-layout"><form class="card form-card" id="settings-form"><div class="editor-heading"><div><h2>LLM configuration</h2><p class="muted">Extract names, email addresses, and phone numbers.</p></div>${badge(s.enabled?'Enabled':'Disabled',s.enabled?'':'gray')}</div><label class="switch-row"><span><strong>Enable card extraction</strong><small>Automatically read and approve valid new and waiting card uploads.</small></span><input type="checkbox" name="enabled" class="switch" ${s.enabled?'checked':''}></label><div class="split-fields"><label class="field"><span>Provider</span><select name="provider"><option value="gemini" ${s.provider==='gemini'?'selected':''}>Google Gemini</option><option value="anthropic" ${s.provider==='anthropic'?'selected':''}>Anthropic Claude</option><option value="compatible" ${s.provider==='compatible'?'selected':''}>Compatible API / local vision model</option></select></label>${globalThis.GatherModels.field(s)}</div>${field('Provider API key','apiKey','','type="password" autocomplete="new-password" placeholder="'+(s.hasKey?'Key saved — leave blank to keep it':'Enter your LLM provider key')+'"')}<p class="field-help">${s.hasKey?'An encrypted key is stored on this server.':'The key is encrypted on this server and is never stored in browser storage.'}</p>${field('Base URL (compatible providers only)','baseUrl',s.baseUrl,'type="url" placeholder="https://your-provider.example/v1"')}<label class="check-row"><input type="checkbox" name="clearKey"> Remove the stored key when saving</label><div class="form-footer">${button('Test saved configuration','test-model')}<button type="submit" class="button primary">Save configuration</button></div></form><aside><article class="card form-card"><span class="source-icon">⌁</span><h2 class="section-title">AI reads and approves.</h2><p class="muted">Valid extracted details become contacts automatically and sync to the workspace spreadsheet. Cards with invalid or insufficient data stay available for attention.</p><ul class="plain-list"><li>All visible email addresses and phone numbers are retained.</li><li>Each card stays in its chosen workspace.</li><li>Sending saved templates still requires confirmation.</li></ul></article>${data.user?.role==='superadmin'?`<article class="card form-card" style="margin-top:16px"><h2>Earlier prototype data</h2><p class="muted">Import contacts and templates from the earlier build. Previous simulated sending counts are not imported.</p>${button('Import earlier data','import-legacy','secondary',data.workspaces.length?'disabled':'')}</article>`:''}</aside></div>`;}
  const pages={overview,workspaces,contacts,upload,communication,templates:templateEditor,connections,settings};
  function render(){
    const warning=!online?`<div class="server-banner"><strong>Open Gather through its local server to save changes and use connections.</strong><span>Run <code>npm start</code> from the project folder, then open <a href="http://localhost:3088">http://localhost:3088</a>.</span></div>`:'';
    app.innerHTML=`<div class="app-shell">${sidebar()}<main class="main">${topbar()}${warning}<div class="content">${pages[view]()}</div></main></div>`;
    if(!$('#toast-region'))document.body.insertAdjacentHTML('beforeend','<div id="toast-region" role="status" aria-live="polite"></div>');
    if(view==='settings')globalThis.GatherModels.mount(data.settings);
  }
  function toast(message,isError=false){const el=document.createElement('div');const dialog=$('#modal');el.className=dialog?`dialog-message ${isError?'error':''}`:`toast ${isError?'error':''}`;el.setAttribute('role',isError?'alert':'status');el.textContent=message;if(dialog)dialog.prepend(el);else $('#toast-region')?.append(el);setTimeout(()=>el.remove(),6500);}
  async function api(path,body){
    if(location.protocol==='file:')throw Error('Open http://localhost:3088 to use the application.');
    const response=await fetch(`/api${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-gather-client':'1',...(data.user?.id?{'x-gather-account':data.user.id}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json();if(response.status===409&&result.error==='Your account changed in another tab. Refresh before continuing.'){app.replaceChildren();close();location.reload();await new Promise(()=>{});}if(response.status===401){app.replaceChildren();close();location.replace('/login'+location.hash);await new Promise(()=>{});}if(!response.ok)throw Error(result.error||'The request failed.');return result;
  }
  async function refresh(){const previous=data.user?.id;data=await api('/state');if(!approvingExisting&&data.uploads.some(upload=>upload.status==='review'&&upload.extractionState==='complete'&&!upload.autoApprovalAttempted)){approvingExisting=true;try{await api('/uploads/approve-extracted',{});data=await api('/state');}finally{approvingExisting=false;}}if(previous!==data.user?.id){selected=localStorage.getItem(workspaceStorageKey())||'';templateDraft=null;selectedContacts.clear();excludedEmails.clear();attemptedExtraction.clear();extractionErrors.clear();expandedCampaigns.clear();search='';close();}online=true;if(!ws()){selected=data.workspaces[0]?.id||'';localStorage.setItem(workspaceStorageKey(),selected);}}
  async function run(action,message){
    if(busy)return;busy=true;document.body.classList.add('busy');let result,error;
    document.body.insertAdjacentHTML('beforeend','<div class="working" id="working" role="status">Working…</div>');
    try{result=await action();}catch(caught){error=caught;}
    try{await refresh();}catch(caught){error ||= caught;}
    busy=false;document.body.classList.remove('busy');$('#working')?.remove();render();
    if(error)toast(error.message,true);else if(message)toast(typeof message==='function'?message():message);queueMicrotask(startAutomaticExtraction);return result;
  }
  async function readCardGroups(cards,automatic=true){
    return run(async()=>{
      const result=await C.runCardBatches(automatic?cards:cards.map(card=>({...card,automaticAttempts:0})),{
        extract:card=>api(`/uploads/${card.id}/extract`,{automatic}),
        onProgress:({card,batch,totalBatches,attempt,completed,total})=>{
          attemptedExtraction.add(card.id);extractionErrors.delete(card.id);
          const row=data.uploads.find(u=>u.id===card.id);if(row){row.extractionState='extracting';row.error='';}
          render();$('#working').textContent=`Card batch ${batch} of ${totalBatches} · ${completed} of ${total} saved · ${attempt===2?'Retrying once':'Reading'} ${card.filename}…`;
        },
        onResult:async(card,result,error)=>{
          const row=data.uploads.find(u=>u.id===card.id);
          if(result&&row)Object.assign(row,result);
          if(error){extractionErrors.set(card.id,error.message);if(row){row.extractionState='failed';row.status='needs_attention';}}
          else extractionErrors.delete(card.id);
          render();
        },
      });
      if(result.failed.length)throw Error(`${result.failed.length} card${result.failed.length===1?'':'s'} still need attention after one retry. Their images are kept for review.`);
    },'Card batches finished. Valid contacts are saved; image cleanup status is shown below.');
  }
  async function startAutomaticExtraction(){
    if(busy||!online||!aiReady()||$('#modal')||!queuedCards().length)return;
    await readCardGroups(queuedCards());
  }
  const navigate=key=>{location.hash=key;};
  function chooseWorkspace(wid){selected=wid;localStorage.setItem(workspaceStorageKey(),wid);selectedContacts.clear();excludedEmails.clear();expandedCampaigns.clear();search='';templateDraft=null;render();}
  function close(){const dialog=$('#modal');if(dialog){dialog.close();dialog.remove();}}
  function modal(heading,copy,html,footer='',contextName=ws()?.name||'Gather'){
    close();document.body.insertAdjacentHTML('beforeend',`<dialog id="modal" class="modal" aria-labelledby="modal-heading"><div class="modal-title"><div><div class="eyebrow">${e(contextName)}</div><h2 id="modal-heading">${heading}</h2></div><button type="button" class="icon-button" data-action="close" aria-label="Close dialog">×</button></div><p>${copy}</p>${html}${footer?`<div class="modal-actions">${footer}</div>`:''}</dialog>`);$('#modal').showModal();
  }
  const formValues=form=>Object.fromEntries(new FormData(form));
  function spreadsheetOptions(mode='existing',creating=false){
    const choices=[['existing','Link an existing spreadsheet'],['create','Create a new Google spreadsheet'],...(creating?[['later','Set up a spreadsheet later']]:[])];
    return `<label class="field"><span>Workspace spreadsheet</span><select name="mode">${choices.map(([value,label])=>`<option value="${value}" ${mode===value?'selected':''}>${label}</option>`).join('')}</select></label><div data-sheet-option="existing">${field('Google spreadsheet URL or ID','sheetId','','required placeholder="https://docs.google.com/spreadsheets/d/…" autocomplete="off" spellcheck="false"')}<p class="field-help">Paste any Google spreadsheet link. Gather scans every tab for email addresses and automatically identifies nearby business and contact names, even when columns are reordered or headings appear lower in the sheet. The same spreadsheet can be linked to multiple workspaces.</p></div>${creating?`<div data-sheet-option="create">${field('Spreadsheet name','sheetName','','placeholder="Your workspace name + Contacts"')}</div>`:''}<p class="field-help" data-sheet-option="existing create">${data.connections.sheets.connected?`Use a spreadsheet that <strong>${e(data.connections.sheets.email)}</strong> can edit. Imported contacts sync to a “Gather Contacts” tab; your original tabs stay unchanged.`:'Connect your Google Sheets account before linking or creating a spreadsheet. '+button('Connect Google Sheets','sheet-connections','text')}</p>`;
  }
  function updateSpreadsheetOptions(form){
    const mode=form.elements.mode.value;
    form.querySelectorAll('[data-sheet-option]').forEach(section=>{section.hidden=!section.dataset.sheetOption.split(' ').includes(mode);section.querySelectorAll('input').forEach(input=>input.disabled=section.hidden);});
    const submit=form.querySelector('[type="submit"]');
    submit.disabled=mode!=='later'&&!data.connections.sheets.connected;
    submit.textContent=form.id==='workspace-form'?(form.dataset.workspace?'Connect spreadsheet':mode==='existing'?'Create workspace & link sheet':mode==='create'?'Create workspace & spreadsheet':'Create workspace'):mode==='existing'?'Link spreadsheet':'Create spreadsheet';
  }
  function newWorkspace(mode='later'){
    modal('Create a workspace','Give this occasion its own spreadsheet and outreach history.',`<form id="workspace-form"><div data-workspace-details>${field('Workspace name','name','','required placeholder="e.g. Trade Expo 2026"')}${field('Occasion or purpose','purpose','','placeholder="Exhibition follow-up"')}</div>${spreadsheetOptions(mode,true)}<div class="modal-actions"><button type="submit" class="button primary">Create workspace</button></div></form>`,'','Gather');
    updateSpreadsheetOptions($('#workspace-form'));
  }
  function bindSheet(wid,mode='existing'){
    const w=data.workspaces.find(r=>r.id===wid);
    modal('Connect a spreadsheet',`Link an existing contact list or start a new spreadsheet for ${e(w.name)}.`,`<form id="sheet-form" data-workspace="${wid}">${spreadsheetOptions(mode)}<div class="modal-actions"><button class="button primary" type="submit">Link spreadsheet</button></div></form>`,'',w.name);
    updateSpreadsheetOptions($('#sheet-form'));
  }
  function contactForm(c={}){return `<div class="split-fields">${field('Contact name','name',c.name||'')}${field('Business name','business',c.business||'')}</div>${field('Role / designation','role',c.role||'')}<label class="field"><span>Email addresses</span><textarea name="emails" rows="3" placeholder="One per line, or separated by commas">${e((c.emails||[]).join('\n'))}</textarea></label><label class="field"><span>Phone numbers</span><textarea name="phones" rows="2" placeholder="Include the country code when known">${e((c.phones||[]).join('\n'))}</textarea></label><label class="field"><span>Notes</span><textarea name="notes" rows="2">${e(c.notes||'')}</textarea></label>`;}
  function editContact(cid){const c=data.contacts.find(r=>r.id===cid)||{};modal(cid?'Edit contact':'Add a contact','Keep all addresses and phone numbers under this business.',`<form id="contact-form" data-id="${cid||''}">${contactForm(c)}<label class="field"><span>Addresses excluded from campaigns</span><textarea name="excludedEmails" rows="2">${e((c.excludedEmails||[]).join('\n'))}</textarea><small>Optional. These addresses stay on the contact but are not selected for sending.</small></label><div class="modal-actions"><button class="button primary" type="submit">Save contact</button></div></form>`);}
  function reviewUpload(uid){
    const upload=data.uploads.find(u=>u.id===uid);reviewAction='';reviewTarget='';
    modal('Review card details','Approve the information you want to keep. Missing details can be entered manually.',`<div class="review-layout"><div>${upload.assetId?`<a href="/assets/${upload.assetId}" target="_blank" rel="noopener"><img class="review-photo" src="/assets/${upload.assetId}" alt="${e(upload.filename)}"></a>`:`<div class="notice">${e(upload.filename)}</div>`}<div class="notice review-note">Multiple email addresses are preserved. Each approved address receives its own private email when you send a campaign.</div></div><form id="review-form" data-id="${uid}">${contactForm(upload.fields)}<div id="duplicate-review"></div><div class="modal-actions">${button('Skip card','skip-upload','text',`data-id="${uid}"`)}<button type="submit" class="button primary">Approve contact</button></div></form></div>`);$('#modal').classList.add('wide');updateDuplicateReview();
  }
  function updateDuplicateReview(){
    const form=$('#review-form');if(!form)return;const upload=data.uploads.find(u=>u.id===form.dataset.id),raw=formValues(form);
    let candidate;try{candidate=C.contact(raw);}catch{candidate={...raw,emails:String(raw.emails).split(/[,;\n]/)};}
    const matches=C.duplicates({...candidate,id:upload.id},scoped('contacts',upload.workspace));
    const batch=C.duplicates({...candidate,id:upload.id},pending(upload.workspace).filter(u=>u.id!==upload.id).map(u=>({...u.fields,id:u.id})));
    const target=data.contacts.find(c=>c.id===reviewTarget),merged=target?C.merge(target,{...candidate,emails:(candidate.emails||[]).filter(C.validEmail)}):null;
    $('#duplicate-review').innerHTML=matches.length?`<div class="duplicate-panel"><strong>Possible duplicate</strong>${matches.map(m=>`<p>${e(m.name)} · ${e(m.reasons.join(', '))}</p>`).join('')}<label class="field"><span>Choose how to save this contact</span><select name="resolution"><option value="">Choose a resolution</option><option value="merge" ${reviewAction==='merge'?'selected':''}>Merge into an existing contact</option><option value="keep" ${reviewAction==='keep'?'selected':''}>Keep as a separate contact</option></select></label>${reviewAction==='merge'?`<label class="field"><span>Merge into</span><select name="mergeTarget"><option value="">Choose contact</option>${matches.map(m=>`<option value="${m.id}" ${reviewTarget===m.id?'selected':''}>${e(m.name)}</option>`).join('')}</select></label>${merged?`<div class="merge-preview"><strong>After merging</strong><p>${e(merged.name)} · ${e(merged.business)}</p><p>${e(merged.emails.join(', '))}</p><p>${e(merged.phones.join(', '))}</p><small>Existing names and roles are retained; new addresses and numbers are added.</small></div>`:''}`:''}</div>`:batch.length?'<div class="notice">Another card in this batch has matching details. Approve one first; the next card will offer a merge.</div>':'';
  }
  function copyContacts(){
    if(data.workspaces.length<2)return toast('Create another workspace before copying contacts.',true);
    modal('Copy contacts to a workspace','The source stays unchanged. Copies enter the destination’s review list for duplicate checking.',`<form id="copy-form"><label class="field"><span>Source workspace</span>${workspaceSelect('source')}</label><label class="field"><span>Destination workspace</span><select name="destination">${data.workspaces.filter(w=>w.id!==selected).map(w=>`<option value="${w.id}">${e(w.name)}</option>`).join('')}</select></label><div class="notice">${selectedContacts.size?`${selectedContacts.size} selected contacts`:'All contacts in the source workspace'} will be copied for review.</div><div class="modal-actions"><button class="button primary" type="submit">Copy for review</button></div></form>`);
  }
  function compose(all=false){
    if(!scoped('templates').length)return toast('Create a template in Templates first.',true);
    if(!data.connections.gmail.connected)return toast('Connect Gmail from Connections first.',true);
    if(!ws().sheetId)return toast('Connect the workspace’s Google spreadsheet first.',true);
    const recipients=C.recipients(scoped('contacts').filter(c=>all||!selectedContacts.size||selectedContacts.has(c.id)));
    if(!recipients.length)return toast('Add contacts with approved email addresses first.',true);excludedEmails.clear();
    modal(all?'Send bulk email':'Compose a campaign',all?'All eligible addresses in this workspace’s Gather Contacts sheet are included. Choose your message below.':'Review the template and choose which addresses should receive an individual email.',`<form id="compose-form" data-audience="${all?'workspace':'selected'}">${field('Campaign name','name','','required placeholder="e.g. September exhibition follow-up"')}<label class="field"><span>Template from ${e(ws().name)}</span><select name="templateId">${scoped('templates').map(t=>`<option value="${t.id}">${e(t.name)}</option>`).join('')}</select></label><div class="recipient-heading"><strong>${recipients.length} unique email addresses</strong><span>From ${e(data.connections.gmail.email)}</span></div><div class="recipient-list">${recipients.map(r=>`<label><input type="checkbox" data-recipient="${e(r.email)}" checked><div><strong>${e(r.email)}</strong><small>${e(r.business||r.name)}</small></div></label>`).join('')}</div><p class="field-help">The spreadsheet is refreshed again before the final preview. Duplicate addresses and excluded emails are skipped. All selected addresses are divided automatically into batches of up to 100. Review the sender, message, and recipients, then confirm once to send every batch. Keep this tab open while sending.</p><div class="modal-actions"><button type="submit" class="button primary">Save draft & preview</button></div></form>`);
  }
  function emailPreview(t,recipient){const r=recipient||{business:'Example business',email:'contact@example.com'};return `<article class="preview-email"><div class="email-top"><div><strong>To</strong> ${e(r.email)}</div><div><strong>Subject</strong> ${e(C.personalise(t.subject,r))}</div></div><div class="email-content">${e(C.personalise(t.body,r))}</div>${(t.assetIds||[]).map(aid=>`<img class="email-image" src="/assets/${aid}" alt="${e(asset(aid)?.name)}">`).join('')}</article>`;}
  function campaignSummary(c){
    const p=C.campaignProgress(c);
    return `<div class="notice"><strong>${p.total} emails · ${p.totalBatches} ${p.totalBatches===1?'batch':'batches'} of up to ${p.batchSize}</strong><br>${p.sent} sent · ${p.pending} pending · ${p.completedBatches} of ${p.totalBatches} batches complete.${c.status==='waiting'?`<br>Waiting for Gmail. Retry after ${date(c.retryAt)}. ${e(c.pauseMessage||'')}`:''}${['draft','paused','waiting'].includes(c.status)?'<br>One confirmation covers the entire list. Keep this tab open to continue automatically. If you close it, reopen this campaign and resume remaining emails.':''}</div>`;
  }
  function showCampaign(cid){
    const c=data.campaigns.find(r=>r.id===cid),p=C.campaignProgress(c);
    modal(e(c.name),`${e(c.sender)} · ${p.total} individual recipients`,`${campaignSummary(c)}${emailPreview(c,c.recipients[0])}<div class="recipient-list campaign-recipients">${c.recipients.map((r,index)=>`<div><span>${e(r.email)}</span><small class="recipient-batch">Batch ${Math.floor(index/p.batchSize)+1}</small>${badge(r.status,r.status==='sent'?'':'gray')}${r.messageId?`<a href="https://mail.google.com/mail/u/?authuser=${encodeURIComponent(c.sender)}#all/${encodeURIComponent(r.messageId)}" target="_blank" rel="noopener">Open in Gmail ↗</a>`:''}${r.error?`<small class="inline-error">${e(r.error)}</small>`:''}</div>`).join('')}</div>`,['draft','paused','waiting'].includes(c.status)?button(`${c.status==='draft'?'Confirm & send':'Resume remaining'} ${p.pending} emails`,'send-campaign','primary',`data-id="${cid}"`):button('Close','close'));
  }
  async function imageData(file){
    if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error(`${file.name}: use JPEG, PNG, or WebP.`);
    if(file.size>(data.limits?.imageMB||8)*1024*1024)throw Error(`${file.name}: keep each image under ${data.limits?.imageMB||8} MB.`);
    const encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(Error('The image could not be read.'));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});
    return {name:file.name,mime:file.type,data:encoded};
  }
  async function uploadFiles(files){
    const target=selected,list=[...files];if(!list.length)return;if(list.length>(data.limits?.maxCardUploads||C.cardUploadLimit))return toast(`Upload up to ${data.limits?.maxCardUploads||C.cardUploadLimit} cards at a time.`,true);
    await run(async()=>{for(let i=0;i<list.length;i+=(data.limits?.uploadBatch||2)){$('#working').textContent=`Uploading cards ${i+1}–${Math.min(i+(data.limits?.uploadBatch||2),list.length)} of ${list.length}…`;await api('/uploads',{workspace:target,files:await Promise.all(list.slice(i,i+(data.limits?.uploadBatch||2)).map(imageData))});}},`${list.length} photos saved to ${data.workspaces.find(w=>w.id===target).name}. ${aiReady()?'AI will read them automatically.':'They will be read automatically after you configure AI in Settings.'}`);
  }
  document.addEventListener('click',event=>{const target=event.target.closest('[data-action]');if(target)handleAction(target.dataset.action,target).catch(error=>toast(error.message,true));});
  async function handleAction(action,target){
    if(action==='pause-campaign'){pauseCampaign=true;target.disabled=true;target.textContent='Pausing…';return;}
    if(busy)return;
    switch(action){
      case 'logout':await api('/auth/logout',{});app.replaceChildren();close();location.replace('/login');return;
      case 'link-google':{const result=await api('/auth/google',{mode:'link',returnHash:location.hash});location.assign(result.url);return;}
      case 'account':return modal('Your account','Changing your password signs out other sessions.',`<p class="muted">${e(data.user?.name)} · ${e(data.user?.email)}</p><div class="account-google"><strong>Google sign-in</strong><p>${data.user?.googleLinked?'Your Google account is linked. You can use Continue with Google on the sign-in screen.':'Link your Google account to sign in without typing your password.'}</p>${data.user?.googleLinked?badge('Google linked'):button('Link Google account','link-google','secondary')}</div><form id="password-form">${data.user?.hasPassword?field('Current password','currentPassword','','type="password" required autocomplete="current-password" maxlength="1024"'):''}${field('New password','password','','type="password" required minlength="12" maxlength="1024" autocomplete="new-password"')}${field('Confirm new password','confirmPassword','','type="password" required minlength="12" maxlength="1024" autocomplete="new-password"')}<p class="field-help">Use at least 12 characters.${data.user?.hasPassword?'':' Add a password within 10 minutes of signing in with Google, or sign in again.'}</p><div class="modal-actions"><button class="button primary" type="submit">${data.user?.hasPassword?'Change password':'Set password'}</button></div></form>`);
      case 'close':return close();
      case 'refresh':return run(async()=>{},'Up to date.');
      case 'new-workspace':return newWorkspace();
      case 'link-existing-sheet':return target.dataset.id?bindSheet(target.dataset.id,'existing'):newWorkspace('existing');
      case 'create-sheet':return bindSheet(target.dataset.id,'create');
      case 'sheet-connections':close();return navigate('connections');
      case 'open-workspace':chooseWorkspace(target.dataset.id);return navigate('overview');
      case 'go-upload':return navigate('upload');
      case 'bind-sheet':return bindSheet(target.dataset.id||selected);
      case 'add-contact':return editContact();
      case 'edit-contact':return editContact(target.dataset.id);
      case 'copy-contacts':return copyContacts();
      case 'import-sheet':{const targetWorkspace=target.dataset.id||selected;let result;return run(async()=>{$('#working').textContent='Scanning every spreadsheet tab for contacts…';result=await api(`/workspaces/${targetWorkspace}/import-sheet`,{automatic:true});chooseWorkspace(targetWorkspace);},()=>sheetImportMessage(targetWorkspace,result,'Spreadsheet scanned.'));}
      case 'sync-sheet':return run(()=>api(`/workspaces/${selected}/sync`,{}),'Contacts synced with the workspace spreadsheet.');
      case 'connect':return run(async()=>{const result=await api('/connect/google',{kind:target.dataset.kind});location.assign(result.url);});
      case 'disconnect':return run(()=>api('/disconnect',{kind:target.dataset.kind}),'Account disconnected from Gather.');
      case 'test-model':return run(()=>api('/settings/test',{}),'The saved model configuration responded successfully.');
      case 'new-template':templateDraft={workspace:selected,name:'',subject:'',body:'',assetIds:[]};return render();
      case 'select-template':templateDraft=structuredClone(data.templates.find(t=>t.id===target.dataset.id));return render();
      case 'remove-template-image':templateDraft.assetIds=templateDraft.assetIds.filter(a=>a!==target.dataset.id);return render();
      case 'preview-template':return modal('Email preview','Example personalisation. Save your template before composing a campaign.',emailPreview(templateDraft),button('Close','close'));
      case 'review-upload':return reviewUpload(target.dataset.id);
      case 'skip-upload':return run(async()=>{await api(`/uploads/${target.dataset.id}/review`,{action:'skip'});close();},'Card skipped. Its image remains in upload history.');
      case 'extract-upload':extractionErrors.delete(target.dataset.id);return run(()=>api(`/uploads/${target.dataset.id}/extract`,{}),'Card extracted and approved automatically.');
      case 'extract-all':return readCardGroups(pending().filter(u=>u.assetId&&u.status!=='review'),false);
      case 'compose':return compose();
      case 'compose-all':{
        if(!ws())return toast('Choose a workspace first.',true);
        if(!scoped('templates').length)return toast('Create a template in Email templates first.',true);
        if(!data.connections.gmail.connected)return toast('Connect Gmail from Connections first.',true);
        if(!ws().sheetId)return toast('Connect the workspace’s Google spreadsheet first.',true);
        return run(async()=>{$('#working').textContent='Loading recipients from the workspace spreadsheet…';await api(`/workspaces/${selected}/sync`,{});return true;}).then(ready=>{if(ready)compose(true);});
      }
      case 'toggle-campaign':expandedCampaigns.has(target.dataset.id)?expandedCampaigns.delete(target.dataset.id):expandedCampaigns.add(target.dataset.id);return render();
      case 'view-campaign':return showCampaign(target.dataset.id);
      case 'mail-filter':mailFilter=target.dataset.id;return render();
      case 'send-campaign':{
        pauseCampaign=false;let outcome;
        return run(async()=>{
          close();$('#working').innerHTML=`<span>Starting automatic batches…</span>${button('Pause sending','pause-campaign','secondary')}`;
          outcome=await C.runCampaign(()=>api(`/campaigns/${target.dataset.id}/send`,{confirm:true,compact:true}),{
            shouldPause:()=>pauseCampaign,
            onProgress:result=>{
              const p=result.progress;
              const message=result.status==='waiting'?`Waiting for Gmail until ${date(result.retryAt)}. ${p.sent} of ${p.total} emails sent.`:`Batch ${p.currentBatch} of ${p.totalBatches} · ${p.sent} of ${p.total} emails sent.`;
              $('#working').innerHTML=`<span>${e(message)}</span>${button(pauseCampaign?'Pausing…':'Pause sending','pause-campaign','secondary',pauseCampaign?'disabled':'')}`;
            },
          });
          if(outcome?.status==='needs_attention')throw Error('Sending stopped because a delivery needs attention. Check the campaign before continuing; confirmed sends will not be repeated.');
        },()=>outcome?.status==='sent'?`Gmail confirmed all ${outcome.progress.total} emails across ${outcome.progress.totalBatches} batches.`:'Sending paused. Open this campaign to resume remaining emails.');
      }
      case 'import-legacy':{let old;try{old=JSON.parse(localStorage.getItem('gather-state')||'null');}catch{}if(!old)return toast('No earlier prototype data was found in this browser.',true);return run(()=>api('/import-legacy',old),'Earlier contacts and templates imported. Connect the workspaces to real spreadsheets next.');}
    }
  }
  document.addEventListener('submit',event=>{
    const form=event.target;if(!['password-form','workspace-form','sheet-form','contact-form','review-form','copy-form','template-form','settings-form','compose-form'].includes(form.id))return;
    event.preventDefault();const values=formValues(form),wid=selected;
    switch(form.id){
      case 'password-form':if(values.password!==values.confirmPassword)return toast('The new passwords do not match.',true);return run(async()=>{await api('/auth/password',{currentPassword:values.currentPassword,password:values.password});form.reset();close();},'Password changed. Other sessions have been signed out.');
      case 'workspace-form':{let sheetResult;return run(async()=>{
        if(!form.dataset.workspace){
          const created=await api('/workspaces',values);form.dataset.workspace=created.id;
          form.querySelectorAll('[data-workspace-details] input').forEach(input=>input.disabled=true);
          updateSpreadsheetOptions(form);
        }
        const targetWorkspace=form.dataset.workspace;
        if(values.mode!=='later')sheetResult=await api(`/workspaces/${targetWorkspace}/sheet`,values);
        chooseWorkspace(targetWorkspace);close();return targetWorkspace;
      },()=>values.mode==='later'?'Workspace created. You can link a spreadsheet from its card.':values.mode==='existing'?sheetImportMessage(form.dataset.workspace,sheetResult,'Workspace created and spreadsheet connected.'):syncSaveMessage(form.dataset.workspace,'Workspace created and spreadsheet connected.'));}
      case 'sheet-form':{const targetWorkspace=form.dataset.workspace;let result;return run(async()=>{$('#working').textContent='Connecting and scanning every spreadsheet tab…';result=await api(`/workspaces/${targetWorkspace}/sheet`,values);close();return targetWorkspace;},()=>values.mode==='existing'?sheetImportMessage(targetWorkspace,result):syncSaveMessage(targetWorkspace,'Spreadsheet connected.'));}
      case 'contact-form':return run(async()=>{$('#working').textContent='Saving contact and syncing spreadsheet…';await api('/contacts',{...values,id:form.dataset.id||undefined,workspace:wid});close();},()=>syncSaveMessage(wid,'Contact saved.'));
      case 'review-form':return run(async()=>{$('#working').textContent='Approving contact and syncing spreadsheet…';await api(`/uploads/${form.dataset.id}/review`,{contact:values,action:reviewAction||'save',targetId:reviewTarget});close();},()=>syncSaveMessage(wid,'Contact approved.'));
      case 'copy-form':return run(async()=>{const ids=scoped('contacts',values.source).filter(c=>values.source!==selected||!selectedContacts.size||selectedContacts.has(c.id)).map(c=>c.id);await api('/copy',{...values,ids});selected=values.destination;selectedContacts.clear();close();view='upload';location.hash='upload';},'Contacts copied to the destination review list.');
      case 'template-form':return run(async()=>{templateDraft=await api('/templates',{...templateDraft,...values,workspace:wid});},'Template saved in this workspace.');
      case 'settings-form':return run(()=>api('/settings',{...values,enabled:values.enabled==='on',clearKey:values.clearKey==='on'}),'LLM configuration saved securely on the server.');
      case 'compose-form':return run(async()=>{const contactIds=scoped('contacts').filter(c=>!selectedContacts.size||selectedContacts.has(c.id)).map(c=>c.id);const result=await api('/campaigns',{...values,workspace:wid,audience:form.dataset.audience,contactIds,excludedEmails:[...excludedEmails]});close();return result;},'Campaign draft saved. No emails have been sent.').then(result=>{if(result)showCampaign(result.id);});
    }
  });
  document.addEventListener('change',event=>{
    const el=event.target;
    if(el.name==='mode'&&el.closest('#workspace-form, #sheet-form')){updateSpreadsheetOptions(el.form);return;}
    if(['workspace','uploadWorkspace'].includes(el.name)){chooseWorkspace(el.value);return;}
    if(el.dataset.contactSelect){if(el.checked)selectedContacts.add(el.dataset.contactSelect);else selectedContacts.delete(el.dataset.contactSelect);return;}
    if(el.dataset.recipient){if(el.checked)excludedEmails.delete(el.dataset.recipient);else excludedEmails.add(el.dataset.recipient);return;}
    if(el.name==='resolution'){reviewAction=el.value;reviewTarget='';updateDuplicateReview();return;}
    if(el.name==='mergeTarget'){reviewTarget=el.value;updateDuplicateReview();return;}
    if(el.id==='card-files')return uploadFiles(el.files);
    if(el.id==='template-images'){const files=[...el.files];if(!files.length)return;return run(async()=>{for(const file of files){const image=await api('/assets',await imageData(file));templateDraft.assetIds.push(image.id);}},'Images added to your template draft. Save the template to keep them.');}
    if(el.name==='source'&&el.closest('#copy-form'))$('#copy-form select[name="destination"]').innerHTML=data.workspaces.filter(w=>w.id!==el.value).map(w=>`<option value="${w.id}">${e(w.name)}</option>`).join('');
  });
  document.addEventListener('input',event=>{
    const el=event.target;if(el.id==='contact-search'){search=el.value;$('#contacts-body').innerHTML=contactRows(filteredContacts());}
    if(el.closest('#template-form')&&el.name&&templateDraft)templateDraft[el.name]=el.value;
    if(el.closest('#review-form')&&!['resolution','mergeTarget'].includes(el.name))updateDuplicateReview();
  });
  app.addEventListener('dragover',event=>{if(event.target.closest('#dropzone')){event.preventDefault();$('#dropzone').classList.add('dragging');}});
  app.addEventListener('dragleave',event=>{if(event.target.closest('#dropzone'))$('#dropzone').classList.remove('dragging');});
  app.addEventListener('drop',event=>{if(event.target.closest('#dropzone')){event.preventDefault();uploadFiles(event.dataTransfer.files);}});
  window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(Object.hasOwn(labels,next))view=next;render();});
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  // Recheck sessions when returning to a tab that may have been signed out elsewhere.
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)api('/auth/session').then(state=>{if(!state.authenticated){app.replaceChildren();close();location.replace('/login'+location.hash);}}).catch(()=>{});});
  if(location.protocol==='file:'){app.innerHTML='<main class="auth-panel"><p>Open <a href="http://localhost:3088">Gather on localhost</a> to sign in.</p></main>';}
  else refresh().then(()=>{render();startAutomaticExtraction();}).catch(error=>{app.innerHTML='<main class="auth-panel"><p>Unable to load Gather. Check the local server and refresh this page.</p></main>';});
})();
