import {readFileSync, writeFileSync, existsSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes, randomUUID, createHash, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

const derive = promisify(scrypt);
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const failureWindow = 15 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(Error(message), {status}); };
const passwordHash = (password, salt) => derive(password, salt, 64, {N:131072, r:8, p:1, maxmem:256 * 1024 * 1024});
const validPassword = password => {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024)
    fail('Use a password with at least 12 characters and no more than 1,024 bytes.');
};

// Account records are shared; CRM data is selected separately using the authenticated user ID.
export function createAuth(dataDir, {env=process.env, fetchImpl=fetch, onPersist=async()=>{}} = {}) {
  const path = join(dataDir, 'auth.json');
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {owner:null, sessions:[], failures:[]};
  state.users ||= [];
  state.accountFailures ||= {};
  state.registrations ||= [];
  const accounts = () => [state.owner,...state.users].filter(Boolean);
  const ownerId = () => state.owner?.id;
  const persist = async () => {
    state.pendingGoogle=Object.fromEntries(pendingGoogle);
    writeFileSync(`${path}.tmp`, JSON.stringify(state), {mode:0o600});
    renameSync(`${path}.tmp`, path);
    await onPersist('auth.json');
  };
  const profile = req => {const user=account(req);return user ? {id:user.id,name:user.name,email:user.email,role:user.id===ownerId()?'superadmin':'member',hasPassword:Boolean(user.passwordHash),googleLinked:Boolean(user.googleSub)} : null;};
  const account = req => {const current=session(req);return current ? accounts().find(user=>user.id===current.userId) || null : null;};
  const googleConfigured = () => Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
  const pendingGoogle = new Map(Object.entries(state.pendingGoogle || {}));
  const secure = env.GATHER_HOSTED === '1' ? '; Secure' : '';
  const cookie = (res, token, age) => res.setHeader('set-cookie', `gather_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure}`);
  function session(req) {
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('gather_session='))?.slice(15);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const current=state.sessions.find(s => s.hash === hash(token) && s.expiresAt > Date.now());
    if(!current)return null;
    current.userId ||= ownerId(); // Preserve existing superadmin sessions on migration.
    return accounts().some(user=>user.id===current.userId) ? current : null;
  }
  function requireSession(req) {
    const current = session(req);
    if (!current) fail('Please sign in to continue.', 401);
    return current;
  }
  async function issue(res, user, method='password') {
    const token = randomBytes(32).toString('base64url');
    state.sessions = state.sessions.filter(s => s.expiresAt > Date.now());
    const own=state.sessions.filter(s=>(s.userId||ownerId())===user.id).slice(-19);
    state.sessions=state.sessions.filter(s=>(s.userId||ownerId())!==user.id).concat(own);
    state.sessions.push({userId:user.id,hash:hash(token), expiresAt:Date.now() + sessionLifetime, authenticatedAt:Date.now(), method});
    await persist();
    cookie(res, token, sessionLifetime / 1000);
  }
  function failureKey(email) {return hash(String(email || '').trim().toLowerCase());}
  function checkRate(email) {
    const key=failureKey(email);
    for(const [id,times] of Object.entries(state.accountFailures)) {
      const recent=times.filter(time=>time>Date.now()-failureWindow);
      if(recent.length)state.accountFailures[id]=recent;else delete state.accountFailures[id];
    }
    // Carry the old owner's lockout forward without affecting other accounts.
    state.failures=state.failures.filter(time=>time>Date.now()-failureWindow);
    const legacy=email===state.owner?.email ? state.failures.length : 0;
    if((state.accountFailures[key]?.length||0)+legacy>=10)fail('Too many unsuccessful attempts. Please try again in 15 minutes.',429);
  }
  async function verify(user,password,email) {
    checkRate(email);
    if(typeof password!=='string'||Buffer.byteLength(password)>1024)fail('Invalid password.');
    // Use the same expensive derivation even for an unknown email.
    const candidate=await passwordHash(password,user?.salt||'gather-unknown-account');
    return Boolean(user?.passwordHash)&&timingSafeEqual(candidate,Buffer.from(user.passwordHash,'hex'));
  }
  async function rejectCredentials(email,status=401) {
    const key=failureKey(email);(state.accountFailures[key] ||= []).push(Date.now());await persist();
    fail(status===400?'Your current password is incorrect.':'Email or password is incorrect.',status);
  }
  function clearFailures(email) {
    delete state.accountFailures[failureKey(email)];
    if(email===state.owner?.email)state.failures=[];
  }
  function checkRegistration(req) {
    const address=hash(req.socket?.remoteAddress||req.headers['x-forwarded-for']||'unknown');
    state.registrations=state.registrations.filter(r=>r.at>Date.now()-failureWindow);
    if(state.registrations.filter(r=>r.address===address).length>=20)fail('Too many account creations. Please try again later.',429);
    return address;
  }
  async function route(req, res, url, body) {
    const path = url.pathname, method = req.method;
    const respond = (value, status = 200) => {
      res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store'});
      res.end(JSON.stringify(value));
    };
    if (path === '/api/auth/session' && method === 'GET') {
      const current = session(req);
      return respond({authenticated:Boolean(current), setupRequired:!state.owner, registrationOpen:true, googleConfigured:googleConfigured(), user:current ? profile(req) : null});
    }
    if (path === '/api/auth/google' && method === 'POST') {
      if (!googleConfigured()) fail('Google sign-in needs the application’s Google OAuth client configured on the server.', 409);
      const linking = body.mode === 'link';
      const current = linking ? requireSession(req) : null;
      if (linking && account(req).googleSub) fail('Google sign-in is already linked to your account.', 409);
      for (const [key,value] of pendingGoogle) if(value.expiresAt <= Date.now()) pendingGoogle.delete(key);
      if (pendingGoogle.size >= 100) fail('Too many Google sign-in attempts. Please try again shortly.', 429);
      const requestState = randomBytes(32).toString('base64url'), browserNonce = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const redirectUri = env.GOOGLE_LOGIN_REDIRECT_URI || `${url.origin}/api/auth/google/callback`;
      // Only retain a known CRM hash; never allow caller-controlled redirect URLs.
      const returnHash = /^#(overview|workspaces|contacts|upload|communication|templates|connections|settings)$/.test(body.returnHash || '') ? body.returnHash : '#workspaces';
      pendingGoogle.set(requestState,{browserNonce,verifier,redirectUri,returnHash,linking,sessionHash:current?.hash,userId:current?.userId,initialOwner:!state.owner,ownerId:state.owner?.id || null,expiresAt:Date.now()+600000});
      await persist();
      res.setHeader('set-cookie',`gather_google_login=${browserNonce}; HttpOnly; SameSite=Lax; Path=/api/auth/google/callback; Max-Age=600${secure}`);
      const params = new URLSearchParams({client_id:env.GOOGLE_OAUTH_CLIENT_ID,redirect_uri:redirectUri,response_type:'code',scope:'openid email profile',state:requestState,prompt:'select_account',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
      return respond({url:'https://accounts.google.com/o/oauth2/v2/auth?'+params});
    }
    if (path === '/api/auth/google/callback' && method === 'GET') {
      const clearCookie = `gather_google_login=; HttpOnly; SameSite=Lax; Path=/api/auth/google/callback; Max-Age=0${secure}`;
      try {
        const requestState=url.searchParams.get('state'), pending=pendingGoogle.get(requestState);
        pendingGoogle.delete(requestState);
        await persist();
        if (!pending || pending.expiresAt <= Date.now() || !req.headers.cookie?.split(';').map(s=>s.trim()).includes(`gather_google_login=${pending.browserNonce}`)) fail('expired');
        if (url.searchParams.has('error')) fail('cancelled');
        if (pending.initialOwner && pending.ownerId !== (state.owner?.id || null)) fail('account_changed');
        if (pending.linking && (!session(req) || session(req).hash !== pending.sessionHash || session(req).userId !== (pending.userId||pending.ownerId))) fail('expired');
        const code=url.searchParams.get('code');if(!code || code.length>4096)fail('failed');
        const tokenResponse=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,client_id:env.GOOGLE_OAUTH_CLIENT_ID,client_secret:env.GOOGLE_OAUTH_CLIENT_SECRET,redirect_uri:pending.redirectUri,code_verifier:pending.verifier}),signal:AbortSignal.timeout(20000),redirect:'error'});
        const tokens=await tokenResponse.json();if(!tokenResponse.ok || !tokens.access_token)fail('failed');
        // Get identity directly from Google's authenticated HTTPS userinfo endpoint.
        // Never trust a browser-supplied email or an unverified decoded ID token.
        const response=await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo',{headers:{authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(20000),redirect:'error'});
        const identity=await response.json();
        if(!response.ok || identity.email_verified!==true || typeof identity.sub!=='string' || !identity.sub || typeof identity.email!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email))fail('unverified');
        let user=accounts().find(user=>user.googleSub===identity.sub);
        if(pending.linking) {
          const target=account(req);
          if(user && user.id!==target.id)fail('already_linked');
          if(target.googleSub && target.googleSub!==identity.sub)fail('wrong_account');
          target.googleSub=identity.sub;user=target;
        } else if(!user) {
          const email=identity.email.toLowerCase();
          const existing=accounts().find(user=>user.email===email);
          if(existing)fail(existing.googleSub?'wrong_account':'link_required');
          const address=checkRegistration(req);
          user={id:randomUUID(),name:String(identity.name||email.split('@')[0]).slice(0,100),email,googleSub:identity.sub};
          if(!state.owner)state.owner=user;else state.users.push(user);
          state.registrations.push({address,at:Date.now()});
        }
        const prior=session(req);if(prior)state.sessions=state.sessions.filter(s=>s!==prior);
        await issue(res,user,'google');
        res.setHeader('set-cookie',[res.getHeader('set-cookie'),clearCookie]);
        res.writeHead(303,{location:'/'+pending.returnHash,'cache-control':'no-store'});return res.end();
      } catch(error) {
        const known=['expired','cancelled','account_changed','unverified','wrong_account','link_required','already_linked'];
        const reason=known.includes(error.message)?error.message:'failed';
        res.writeHead(303,{location:`/login?google_error=${reason}`,'set-cookie':clearCookie,'cache-control':'no-store'});return res.end();
      }
    }
    if (['/api/auth/setup','/api/auth/register'].includes(path) && method === 'POST') {
      if (path==='/api/auth/setup' && state.owner) fail('The owner account is already set up. Please sign in.', 409);
      const name = String(body.name || '').trim(), email = String(body.email || '').trim().toLowerCase();
      if (!name || name.length > 100) fail('Enter your name (up to 100 characters).');
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email address.');
      validPassword(body.password);
      if(accounts().some(user=>user.email===email))fail('An account with this email already exists. Please sign in.',409);
      const address=checkRegistration(req);
      const salt = randomBytes(32).toString('hex');
      const password = await passwordHash(body.password, salt);
      const user={id:randomUUID(),name,email,salt,passwordHash:password.toString('hex')};
      if(!state.owner)state.owner=user;else state.users.push(user);
      state.registrations.push({address,at:Date.now()});
      await issue(res,user);
      return respond({user:{id:user.id,name,email,role:user.id===ownerId()?'superadmin':'member',hasPassword:true,googleLinked:false}},201);
    }
    if (path === '/api/auth/login' && method === 'POST') {
      if (!state.owner) fail('Create the owner account first.', 409);
      const email=String(body.email||'').trim().toLowerCase();
      const user=accounts().find(user=>user.email===email);
      const matches=await verify(user,body.password,email);
      if(!matches)await rejectCredentials(email);
      // Rotate an existing browser session as well as issuing fresh tokens on login.
      const prior = session(req);
      if (prior) state.sessions = state.sessions.filter(s => s !== prior);
      clearFailures(email);await issue(res,user);
      return respond({user:{id:user.id,name:user.name,email:user.email,role:user.id===ownerId()?'superadmin':'member',hasPassword:Boolean(user.passwordHash),googleLinked:Boolean(user.googleSub)}});
    }
    const current = requireSession(req);
    if (path === '/api/auth/logout' && method === 'POST') {
      state.sessions = state.sessions.filter(s => s !== current);await persist();cookie(res, '', 0);
      return respond({ok:true});
    }
    if (path === '/api/auth/password' && method === 'POST') {
      validPassword(body.password);
      const user=account(req);
      if (user.passwordHash) {
        if (!await verify(user,body.currentPassword,user.email)) await rejectCredentials(user.email,400);
      } else if (current.method!=='google' || current.authenticatedAt < Date.now()-600000) {
        fail('Sign out and sign in with Google again before adding a password.', 409);
      }
      const salt = randomBytes(32).toString('hex');
      const password = await passwordHash(body.password, salt);
      Object.assign(user, {salt, passwordHash:password.toString('hex')});
      state.sessions=state.sessions.filter(s=>(s.userId||ownerId())!==user.id);clearFailures(user.email);await issue(res,user);
      return respond({ok:true});
    }
    fail('Not found.', 404);
  }
  return {session, requireSession, profile, account, ownerId, route};
}
