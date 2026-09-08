import {mkdirSync,cpSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';

const output='.vercel/output',destination=join(output,'functions/gather.func');
rmSync(output,{recursive:true,force:true});mkdirSync(destination,{recursive:true});
// An allowlist prevents local account files and deployment credentials entering a build.
for(const name of ['api','cloud','public-pages','server.mjs','auth.mjs','core.js','model-picker.js','app.js','auth.js','index.html','auth.html','styles.css','package.json','node_modules'])cpSync(name,join(destination,name),{recursive:true});
writeFileSync(join(destination,'.vc-config.json'),JSON.stringify({runtime:'nodejs22.x',handler:'api/index.mjs',launcherType:'Nodejs',maxDuration:300,regions:['sin1']},null,2));
writeFileSync(join(output,'config.json'),JSON.stringify({version:3,routes:[{src:'/(.*)',dest:'/gather'}]},null,2));
console.log('Vercel function built. Local data and secrets are excluded.');
