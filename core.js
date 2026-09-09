/* Shared business rules, usable in the browser and in Node. */
(() => {
  const clean = value => String(value ?? '').trim();
  const email = value => clean(value).toLowerCase();
  const validEmail = value => /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(value) && !/[\r\n]/.test(value);
  const list = value => Array.isArray(value) ? value : clean(value).split(/[,;\n]/);
  const unique = values => [...new Set(values.filter(Boolean))];
  const phones = value => unique(list(value).map(clean));
  const phoneKey = value => clean(value).replace(/\D/g, '').replace(/^00/, '');
  function contact(raw) {
    const emails = unique(list(raw.emails).map(email));
    if (emails.some(value => !validEmail(value))) throw Error('Correct invalid email addresses before saving.');
    return {
      name: clean(raw.name), business: clean(raw.business), role: clean(raw.role),
      emails, phones: phones(raw.phones ?? raw.phone), notes: clean(raw.notes),
      excludedEmails: unique(list(raw.excludedEmails).map(email)).filter(value => emails.includes(value)),
    };
  }
  function duplicates(candidate, existing) {
    const candidates = list(candidate.emails).map(email);
    const numbers = phones(candidate.phones ?? candidate.phone).map(phoneKey).filter(Boolean);
    const company = clean(candidate.business).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    return existing.filter(row => row.id !== candidate.id).flatMap(row => {
      const reasons = [];
      if (list(row.emails).some(value => candidates.includes(email(value)))) reasons.push('Same email');
      if (phones(row.phones ?? row.phone).some(value => numbers.includes(phoneKey(value)))) reasons.push('Same phone');
      if (company && company === clean(row.business).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) reasons.push('Same business');
      return reasons.length ? [{id: row.id, name: row.business || row.name || 'Unnamed contact', reasons}] : [];
    });
  }
  function merge(existing, incoming) {
    const old = contact(existing), added = contact(incoming);
    return {...existing, ...old, name: old.name || added.name, business: old.business || added.business,
      role: old.role || added.role, notes: unique([old.notes, added.notes]).join('\n'),
      emails: unique([...old.emails, ...added.emails]), phones: unique([...old.phones, ...added.phones]),
      excludedEmails: unique([...old.excludedEmails, ...added.excludedEmails]),
    };
  }
  function recipients(contacts) {
    const used = new Set();
    return contacts.flatMap(row => list(row.emails).map(email).filter(address => {
      if (!validEmail(address) || used.has(address) || (row.excludedEmails || []).includes(address)) return false;
      used.add(address); return true;
    }).map(address => ({email: address, contactId: row.id, name: row.name, business: row.business})));
  }
  function personalise(text, recipient) {
    // A card's contact name is not proof that every address belongs to that person.
    const greeting = recipient.business ? `${recipient.business} team` : 'there';
    return String(text || '').replaceAll('{{contact_name}}', recipient.addressName || greeting)
      .replaceAll('{{business_name}}', recipient.business || 'your business')
      .replaceAll('{{email}}', recipient.email || '');
  }
  const cardUploadLimit=40,cardBatchSize=10;
  const cardNeedsAutomaticRead=card=>Boolean(card.assetId && (
    (card.status==='uploaded'&&card.extractionState==='queued') ||
    (card.status==='needs_attention'&&card.extractionState==='failed'&&card.automaticRetryPending&&card.automaticAttempts<2)
  ));
  async function runCardBatches(cards,{extract,onProgress=()=>{},onResult=async()=>{},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
    const failed=new Map();let completed=0;
    const totalBatches=Math.ceil(cards.length/cardBatchSize);
    async function read(card,batch,attempt) {
      onProgress({card,batch,totalBatches,attempt,total:cards.length,completed});
      let result,error;
      try {
        result=await extract(card);
        if(result.status!=='approved')throw Error(result.error||'This card still needs attention.');
        completed++;failed.delete(card.id);
      } catch(caught){error=caught;failed.set(card.id,caught.message);}
      await onResult(card,result,error);
      return !error;
    }
    for(let start=0;start<cards.length;start+=cardBatchSize) {
      const group=cards.slice(start,start+cardBatchSize),retry=[],batch=start/cardBatchSize+1;
      for(const card of group) {
        const attempt=card.automaticAttempts>0?2:1;
        if(!await read(card,batch,attempt)&&attempt===1)retry.push(card);
      }
      if(retry.length){await wait(1000);for(const card of retry)await read(card,batch,2);}
    }
    return {total:cards.length,completed,totalBatches,failed:[...failed].map(([id,error])=>({id,error}))};
  }
  const campaignBatchSize=100;
  function campaignProgress(campaign) {
    const rows=campaign.recipients,batchSize=campaign.batchSize||campaignBatchSize;
    const counts={sent:0,pending:0,failed:0,unknown:0,sending:0};
    for(const row of rows)if(Object.hasOwn(counts,row.status))counts[row.status]++;
    const totalBatches=Math.ceil(rows.length/batchSize),firstUnsent=rows.findIndex(row=>row.status!=='sent');
    const currentBatch=firstUnsent<0?totalBatches:Math.floor(firstUnsent/batchSize)+1;
    const current=rows.slice(Math.max(0,currentBatch-1)*batchSize,currentBatch*batchSize);
    return {...counts,total:rows.length,batchSize,totalBatches,currentBatch,
      completedBatches:firstUnsent<0?totalBatches:currentBatch-1,
      batchSent:current.filter(row=>row.status==='sent').length,batchTotal:current.length};
  }
  // One user confirmation starts the entire frozen list. Each request advances
  // only the server's pending recipients; transport errors are never retried here.
  async function runCampaign(send,{onProgress=()=>{},shouldPause=()=>false,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),clock=()=>Date.now()}={}) {
    let result=null;
    while(!shouldPause()) {
      result=await send();onProgress(result);
      if(!['paused','waiting'].includes(result.status))return result;
      if(result.status==='waiting') {
        const retryAt=Date.parse(result.retryAt);
        if(!Number.isFinite(retryAt))throw Error('Gmail did not provide a valid retry time. Resume this campaign later.');
        while(clock()<retryAt&&!shouldPause())await wait(Math.min(1000,retryAt-clock()));
      } else if(!shouldPause())await wait(300);
    }
    return result;
  }
  globalThis.GatherCore = {contact, duplicates, merge, recipients, personalise, email, validEmail, phoneKey, cardUploadLimit, cardBatchSize, cardNeedsAutomaticRead, runCardBatches, campaignBatchSize, campaignProgress, runCampaign};
})();
