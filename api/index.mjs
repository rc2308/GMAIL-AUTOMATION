import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createGather} from '../server.mjs';
import {openStore,storageKey} from '../cloud/postgres.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const files={'/about':['public-pages/about.html','text/html'],'/privacy':['public-pages/privacy.html','text/html'],'/terms':['public-pages/terms.html','text/html'],'/public.css':['public-pages/site.css','text/css'],'/':['index.html','text/html'],'/index.html':['index.html','text/html'],'/login':['auth.html','text/html'],'/auth.js':['auth.js','text/javascript'],'/app.js':['app.js','text/javascript'],'/core.js':['core.js','text/javascript'],'/model-picker.js':['model-picker.js','text/javascript'],'/styles.css':['styles.css','text/css']};

export default async function handler(req,res) {
  let store,dataDir;
  try {
    const pathname=new URL(req.url,'https://gather.invalid').pathname;
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');res.setHeader('strict-transport-security','max-age=31536000');
    if(files[pathname] && ['GET','HEAD'].includes(req.method)){
      const [file,type]=files[pathname];res.setHeader('content-type',type);return res.end(req.method==='HEAD'?'':readFileSync(join(root,file)));
    }
    if(!pathname.startsWith('/api/')&&!pathname.startsWith('/assets/')){res.statusCode=404;return res.end('Not found.');}
    const allowed=[process.env.GATHER_PUBLIC_ORIGIN,process.env.VERCEL_URL&&`https://${process.env.VERCEL_URL}`].filter(Boolean);
    if(!allowed.some(origin=>new URL(origin).host===req.headers.host))throw Object.assign(Error('Invalid request host.'),{status:403});
    if(req.headers.origin && !allowed.includes(req.headers.origin))throw Object.assign(Error('Invalid request origin.'),{status:403});
    store=await openStore();
    dataDir=mkdtempSync(join(tmpdir(),'gather-request-'));
    const auth=await store.read('auth.json'),data=await store.read('gather.json');
    if(!auth || !JSON.parse(auth).owner || !data)throw Error('The CRM database has not been initialized.');
    writeFileSync(join(dataDir,'auth.json'),auth,{mode:0o600});
    writeFileSync(join(dataDir,'gather.json'),data,{mode:0o600});
    writeFileSync(join(dataDir,'.secret-key'),storageKey(),{mode:0o600});
    const app=createGather({dataDir,env:{...process.env,GATHER_HOSTED:'1'},
      onPersist:name=>store.write(name,readFileSync(join(dataDir,name))),
      loadAccount:async(prefix,directory)=>{const bytes=await store.read(prefix+'gather.json');if(bytes)writeFileSync(join(directory,'gather.json'),bytes,{mode:0o600});},
      getAsset:async name=>await store.read(name)||Promise.reject(Object.assign(Error('Image not found.'),{status:404})),
    });
    await app.ready;
    await app.handler(req,res);
  } catch(error) {
    if(!res.headersSent){res.statusCode=error.status||503;res.setHeader('content-type','application/json');}
    if(!res.writableEnded)res.end(JSON.stringify({error:error.status?error.message:'The service is temporarily unavailable. Please try again shortly.'}));
    // Do not log database URLs, credentials, uploaded content, or OAuth responses.
    console.error('Gather request failed:',error.code||error.status||'BACKEND_UNAVAILABLE');
  } finally {
    if(store)await store.close().catch(()=>{});
    if(dataDir)rmSync(dataDir,{recursive:true,force:true});
  }
}
