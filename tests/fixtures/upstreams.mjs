import assert from 'node:assert/strict';
export const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
export function upstreamMock(){
  let counter=0,scope='',sends=[],failure=false;const sheets=new Map(),sourceTabs=new Map();
  const fetchImpl=async(url,init={})=>{
    if(url==='https://oauth2.googleapis.com/token') {
      const form=new URLSearchParams(init.body);scope=form.get('code');
      return json({access_token:'access-'+scope,refresh_token:'refresh-'+scope,expires_in:3600,scope:`openid email https://www.googleapis.com/auth/${scope==='gmail'?'gmail.send':'spreadsheets'}`});
    }
    if(url==='https://openidconnect.googleapis.com/v1/userinfo')return json({email:'sender@example.com',email_verified:true});
    if(url==='https://sheets.googleapis.com/v4/spreadsheets'){
      const id='spreadsheet-'+(++counter);sheets.set(id,[]);return json({spreadsheetId:id,properties:{title:JSON.parse(init.body).properties.title},sheets:[{properties:{title:'Gather Contacts'}}]});
    }
    if(url.includes('sheets.googleapis.com')){
      const path=new URL(url).pathname,id=path.split('/spreadsheets/')[1].split('/')[0].split(':')[0],rows=sheets.get(id)||[];
      if(url.includes('values:batchUpdate')) {
        for(const item of JSON.parse(init.body).data){const index=Number(item.range.match(/!A(\d+)/)[1])-1;item.values.forEach((row,i)=>{rows[index+i] ||= [];row.forEach((value,column)=>{rows[index+i][column]=value;});});}sheets.set(id,rows);return json({});
      }
      if(url.includes(':append')){rows.push(...JSON.parse(init.body).values);sheets.set(id,rows);return json({});}
      if(url.includes('/values/')){
        const range=decodeURIComponent(path.split('/values/')[1]),tab=range.match(/^'(.*)'!/)?.[1].replaceAll("''","'"),bounds=range.match(/!A(\d+):[A-Z]+(\d+)$/);
        const values=tab==='Gather Contacts'?rows:sourceTabs.get(id)?.get(tab);
        if(!values)return json({error:{message:'Source tab not found'}},400);
        return json({values:bounds?values.slice(Number(bounds[1])-1,Number(bounds[2])):values});
      }
      if(url.includes(':batchUpdate')){assert.deepEqual(JSON.parse(init.body),{requests:[{addSheet:{properties:{title:'Gather Contacts'}}}]});sheets.set(id,[]);return json({});}
      return json({spreadsheetId:id,properties:{title:'Existing'},sheets:[...sourceTabs.get(id)?.keys()||[],...(sheets.has(id)?['Gather Contacts']:[])].map((title,sheetId)=>({properties:{title,sheetId,gridProperties:{rowCount:Math.max(1,(title==='Gather Contacts'?rows:sourceTabs.get(id).get(title)).length),columnCount:26}}}))});
    }
    if(url.startsWith('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media')) {
      assert.equal(init.headers['content-type'],'message/rfc822');
      sends.push(Buffer.from(init.body).toString());
      if(failure)throw Error('Transport lost after submission');
      return json({id:'gmail-message-'+sends.length});
    }
    if(url.includes('generativelanguage.googleapis.com'))return json({candidates:[{content:{parts:[{text:JSON.stringify({name:'Person',business:'Example business',role:'Director',emails:['one@example.com','two@example.com'],phones:['+91 9000012345','+91 9000054321']})}]}}]});
    throw Error('Unexpected upstream URL: '+url);
  };
  return {fetchImpl,sheets,sourceTabs,sends,setFailure:()=>failure=true};
}
