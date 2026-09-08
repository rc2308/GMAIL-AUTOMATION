(() => {
  const $ = selector => document.querySelector(selector), form = $('#auth-form');
  let setup = new URLSearchParams(location.search).get('mode') === 'signup';
  let submitting = false, state = null;
  const enter = () => {
    const target='/'+location.hash;
    if(location.pathname+location.search+location.hash===target)location.reload();
    else location.replace(target);
  };
  const error = message => { $('#auth-error').textContent = message; $('#auth-error').hidden = false; };
  function render() {
    const closed = setup && !state.registrationOpen && !state.setupRequired;
    document.title = `${setup ? 'Create your account' : 'Sign in'} · Gather CRM`;
    $('#auth-title').textContent = setup ? 'Make yourself at home.' : 'Welcome back.';
    $('#auth-description').textContent = setup ? 'Create your account and bring your connections together.' : 'Sign in to continue to your contacts and workspaces.';
    $('#auth-eyebrow').textContent = setup ? 'LET’S GET YOU SET UP' : 'YOUR PRIVATE WORKSPACE';
    $('.auth-modes').hidden = false;
    $('#mode-login').setAttribute('aria-pressed',String(!setup));
    $('#mode-signup').setAttribute('aria-pressed',String(setup));
    $('#auth-name-field').hidden = $('#auth-confirm-field').hidden = $('#password-help').hidden = !setup;
    form.elements.name.required = form.elements.confirmPassword.required = setup;
    form.elements.name.disabled = form.elements.confirmPassword.disabled = !setup;
    form.elements.password.autocomplete = setup ? 'new-password' : 'current-password';
    form.elements.password.minLength = setup ? 12 : 1;
    $('#auth-submit').textContent = setup ? 'Create account →' : 'Sign in →';
    $('#auth-footnote').textContent = setup ? 'Your account starts with its own private workspaces, contacts, templates, and connections.' : 'New here? Choose Create account above. Gmail and Sheets are connected separately inside the app.';
    $('#registration-closed').hidden = !closed;
    $('#auth-google-section').hidden = closed;
    $('#google-setup-note').hidden = state.googleConfigured;
    form.hidden = closed;
  }
  async function load() {
    $('#auth-retry').hidden = true;
    try {
      const response = await fetch('/api/auth/session', {cache:'no-store'});
      if (!response.ok) throw Error('Could not check your account. Please try again.');
      state = await response.json();
      if (state.authenticated) return enter();
      render();
    } catch (caught) {
      $('#auth-description').textContent = caught.message;
      $('#auth-retry').hidden = false;
    }
  }
  function switchMode(create) {
    if(submitting || !state)return;
    setup=create;$('#auth-error').hidden=true;
    form.elements.password.value=form.elements.confirmPassword.value='';
    form.elements.password.type='password';
    $('#toggle-password').textContent='Show';$('#toggle-password').setAttribute('aria-label','Show password');$('#toggle-password').setAttribute('aria-pressed','false');
    const url = new URL(location.href);url.searchParams.delete('google_error');
    if(setup)url.searchParams.set('mode','signup');else url.searchParams.delete('mode');
    history.replaceState(null,'',url.pathname+url.search+url.hash);
    render();
  }
  $('#mode-login').addEventListener('click',()=>switchMode(false));
  $('#mode-signup').addEventListener('click',()=>switchMode(true));
  $('#google-login').addEventListener('click',async()=>{
    if(submitting)return;
    $('#auth-error').hidden=true;
    if(!state.googleConfigured)return error('Google sign-in is not configured yet. Ask the app administrator to configure Google OAuth. You can use email and password now.');
    submitting=true;$('#google-login').disabled=$('#auth-submit').disabled=true;
    try {
      const response=await fetch('/api/auth/google',{method:'POST',headers:{'content-type':'application/json','x-gather-client':'1'},body:JSON.stringify({returnHash:location.hash})});
      const result=await response.json();if(!response.ok)throw Error(result.error||'Could not start Google sign-in.');
      location.assign(result.url);
    } catch(caught) {error(caught.message);}
    finally {submitting=false;$('#google-login').disabled=$('#auth-submit').disabled=false;}
  });
  $('#toggle-password').addEventListener('click', () => {
    const shown = form.elements.password.type === 'password';
    form.elements.password.type = shown ? 'text' : 'password';
    $('#toggle-password').textContent = shown ? 'Hide' : 'Show';
    $('#toggle-password').setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    $('#toggle-password').setAttribute('aria-pressed', String(shown));
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();if(submitting)return;
    $('#auth-error').hidden=true;
    const body=Object.fromEntries(new FormData(form));
    if(setup && body.password!==body.confirmPassword){error('The passwords do not match.');form.elements.confirmPassword.focus();return;}
    delete body.confirmPassword;
    submitting=true;$('#auth-submit').disabled=$('#google-login').disabled=true;
    $('#auth-submit').textContent=setup?'Creating your account…':'Signing in…';
    try {
      const response=await fetch(`/api/auth/${setup?'register':'login'}`,{method:'POST',headers:{'content-type':'application/json','x-gather-client':'1'},body:JSON.stringify(body)});
      const result=await response.json();
      if(!response.ok){if(response.status===409)await load();throw Error(result.error||'Unable to sign in. Please try again.');}
      form.reset();enter();
    } catch(caught){error(caught.message);}
    finally{submitting=false;$('#auth-submit').disabled=$('#google-login').disabled=false;$('#auth-submit').textContent=setup?'Create account →':'Sign in →';}
  });
  const googleErrors={expired:'Google sign-in expired. Please try again.',cancelled:'Google sign-in was cancelled. Try again or use your password.',account_changed:'An account was created while you were signing in. Please sign in again.',unverified:'Google did not return a verified account. Please try another account.',wrong_account:'Use the Google account linked to this email, or sign in with your password.',already_linked:'This Google account is already linked to another Gather account. Choose a different Google account.',link_required:'This email already has a password account. Sign in with your password first, then open your account menu to link Google.',failed:'Google sign-in could not be completed. Please try again or use your password.'};
  const reason=new URLSearchParams(location.search).get('google_error');
  if(reason)error(googleErrors[reason]||googleErrors.failed);
  $('#auth-retry').addEventListener('click',load);
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  load();
})();
