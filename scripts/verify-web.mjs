import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchStudioBrowser} from '../dist/capture/browser.js';

const origin=process.env.STUDIO_TEST_URL??'http://127.0.0.1:4317';
if(new URL(origin).hostname!=='127.0.0.1')throw new Error('This verification script only targets a local loopback server.');
const output=resolve('.studio-data/verification');await mkdir(output,{recursive:true});
const {browser}=await launchStudioBrowser();const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto(origin,{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'Open demo project'}).click();
  await page.waitForURL('**/p/**');
  await page.getByText('Ready · isolated runtime',{exact:true}).waitFor({timeout:30000});
  const frame=page.frameLocator('iframe[title="Isolated widget preview"]');
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
  await frame.locator('#messages').getByText('Ready when you are!').waitFor();
  await page.screenshot({path:resolve(output,'editor.png'),fullPage:true});
  await page.getByLabel('Test message',{exact:true}).fill('Browser verification message');
  await page.getByRole('button',{name:'Send event',exact:true}).click();
  await frame.locator('#messages').getByText('Browser verification message').waitFor();
  await page.getByRole('button',{name:'Theme gallery',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('iframe').length===3);
  await page.waitForFunction(()=>[...document.querySelectorAll('.preview-meta')].every(e=>e.textContent.includes('Ready')),{},{timeout:30000});
  await page.screenshot({path:resolve(output,'theme-gallery.png'),fullPage:true});
  await page.getByRole('button',{name:'Theme gallery',exact:true}).click();
  const id=new URL(page.url()).pathname.split('/').at(-1);const token=await page.evaluate(id=>sessionStorage.getItem(`studio:key:${id}`),id);
  const api=async(path,init={})=>{
    const response=await fetch(origin+path,{...init,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...init.headers}});
    const value=await response.json();return {status:response.status,value};
  };
  const projectPath=`/api/v1/projects/${id}`;const current=await api(projectPath);assert.equal(current.status,200);
  assert.equal((await fetch(origin+projectPath)).status,403);
  const stale=await api(projectPath,{method:'PUT',headers:{'If-Match':'"old"'},body:JSON.stringify(current.value.revision.snapshot)});assert.equal(stale.status,409);
  const initialRevision=current.value.revision.id;
  const nextSnapshot=structuredClone(current.value.revision.snapshot);nextSnapshot.name='Verified Studio chat';
  const saved=await api(projectPath,{method:'PUT',headers:{'If-Match':current.value.etag},body:JSON.stringify(nextSnapshot)});assert.equal(saved.status,200);assert.notEqual(saved.value.revision.id,initialRevision);
  const restored=await api(`/api/studio/projects/${id}/restore`,{method:'POST',headers:{'If-Match':saved.value.etag},body:JSON.stringify({revisionId:initialRevision})});assert.equal(restored.status,200);assert.equal(restored.value.revision.snapshot.name,'Studio chat');
  const start=async(kind,selection)=>{
    const result=await api(`/api/studio/projects/${id}/jobs`,{method:'POST',body:JSON.stringify({kind,selection})});assert.equal(result.status,202,JSON.stringify(result.value));
    for(let i=0;i<150;i++) {
      await new Promise(r=>setTimeout(r,1000));const {value}=await api(`/api/studio/projects/${id}/jobs`);const job=value.find(j=>j.id===result.value.id);
      if(['completed','failed'].includes(job.status)){assert.equal(job.status,'completed',job.error);return job;}
    }
    throw new Error('Job verification timed out.');
  };
  const smoke=await start('test','all');console.log('PASS: opaque preview, events, theme gallery, capability authorization, CAS, restore, smoke job');
  const images=await start('render','theme-gallery');assert.equal(images.artifacts.filter(a=>a.contentType==='image/png').length,7);
  const video=await start('render','preview-video');const clip=video.artifacts.find(a=>a.contentType==='video/mp4');assert.ok(clip);
  const media=await fetch(`${origin}/api/studio/projects/${id}/artifacts/${clip.id}`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(media.status,200);
  await writeFile(resolve(output,'preview.mp4'),Buffer.from(await media.arrayBuffer()));
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  const report={verifiedAt:new Date().toISOString(),projectId:id,revisionId:restored.value.revision.id,checks:['opaque-origin preview','synthetic events','three-theme gallery','capability authorization','stale save rejected','immutable restore','smoke scenario','screenshots','thumbnails','contact sheet','silent MP4','mobile layout'],jobs:[smoke,images,video].map(j=>({id:j.id,status:j.status,artifacts:j.artifacts.map(a=>({name:a.name,bytes:a.bytes,sha256:a.sha256}))}))};
  await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:'passed',output,checks:report.checks}));
}finally{await context.close();await browser.close();}
