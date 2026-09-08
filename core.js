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
  globalThis.GatherCore = {contact, duplicates, merge, recipients, personalise, email, validEmail, phoneKey};
})();
