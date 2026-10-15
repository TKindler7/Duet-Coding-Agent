import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPreviewManager } from '../src/preview.mjs';
async function fixture(t){const project=await mkdtemp(path.join(os.tmpdir(),'duet-preview-'));const manager=createPreviewManager();t.after(async()=>{await manager.close();await rm(project,{recursive:true,force:true});});return{project,manager};}
test('static preview stays separate from workspace, blocks private files/links and closes its server',async t=>{
 const {project,manager}=await fixture(t);await writeFile(path.join(project,'index.html'),'<h1>Preview works</h1>');await writeFile(path.join(project,'.env'),'secret');await writeFile(path.join(project,'secrets.json'),'secret');await symlink('.env',path.join(project,'leak.txt'));
 const result=await manager.start('chat',project,{appOrigin:'http://127.0.0.1:12345'});assert.match(result.url,/http:\/\/localhost:/);const response=await fetch(result.url);assert.equal(response.status,200);assert.match(await response.text(),/Preview works/);assert.match(response.headers.get('content-security-policy'),/frame-ancestors http:\/\/127.0.0.1:12345/);
 for(const file of ['.env','secrets.json','leak.txt','%2e%2e%2f.env'])assert.equal((await fetch(result.url+file)).status,404);
 assert.equal((await fetch(result.url,{method:'POST'})).status,405);
 assert.equal((await manager.start('chat',project,{appOrigin:'http://127.0.0.1:12345'})).url,result.url);await manager.stop('chat');assert.equal(manager.status('chat').status,'stopped');await assert.rejects(fetch(result.url));
});
test('preview chooses built assets and reports missing entry points without running code',async t=>{
 const {project,manager}=await fixture(t);await writeFile(path.join(project,'package.json'),JSON.stringify({scripts:{dev:'touch should-not-run'}}));await assert.rejects(manager.start('chat',project,{appOrigin:'http://127.0.0.1:12345'}),/No built web page/);
 await mkdir(path.join(project,'dist'));await writeFile(path.join(project,'dist/index.html'),'Built output');const preview=await manager.start('chat',project,{appOrigin:'http://127.0.0.1:12345'});assert.equal(await(await fetch(preview.url)).text(),'Built output');
});

test('preview rejects a linked project and a root replaced by a symlink after startup', async t => {
 const { project, manager } = await fixture(t);
 const external = await mkdtemp(path.join(os.tmpdir(), 'duet-preview-outside-'));
 const link = `${project}-link`;
 t.after(async () => { await rm(link, { force: true }); await rm(external, { recursive: true, force: true }); });
 await writeFile(path.join(external, 'index.html'), 'private external document');
 await writeFile(path.join(project, 'index.html'), 'local document');
 await symlink(project, link);
 await assert.rejects(manager.start('linked', link, { appOrigin: 'http://127.0.0.1:12345' }), /linked folders/);
 await mkdir(path.join(project, 'dist'));
 await writeFile(path.join(project, 'dist/index.html'), 'built document');
 const preview = await manager.start('chat', project, { appOrigin: 'http://127.0.0.1:12345' });
 await rm(path.join(project, 'dist'), { recursive: true });
 await symlink(external, path.join(project, 'dist'));
 const response = await fetch(preview.url);
 assert.equal(response.status, 404);
 assert.doesNotMatch(await response.text(), /private external/);
});

test('preview denies common provider credential files and hosts other than localhost', async t => {
 const { project, manager } = await fixture(t);
 await writeFile(path.join(project, 'index.html'), 'Preview');
 const privateFiles = ['auth.json', 'token.json', 'service-account.json', 'credentials.json'];
 for (const name of privateFiles) await writeFile(path.join(project, name), 'private');
 const preview = await manager.start('chat', project, { appOrigin: 'http://127.0.0.1:12345' });
 for (const name of privateFiles) assert.equal((await fetch(preview.url + name)).status, 404);
 assert.equal((await fetch(preview.url.replace('localhost', '127.0.0.1'))).status, 403);
 assert.equal((await fetch(preview.url, { method: 'HEAD' })).status, 200);
});

test('restored projects cannot reuse stale generated output or uncompiled source',async t=>{
  const {project,manager}=await fixture(t);
  const {utimes}=await import('node:fs/promises');
  await mkdir(path.join(project,'dist'));const entry=path.join(project,'dist/index.html');await writeFile(entry,'<h1>Old build</h1>');await utimes(entry,1,1);
  await writeFile(path.join(project,'index.html'),'<script type="module" src="/src/main.tsx"></script>');
  await assert.rejects(manager.start('chat',project,{appOrigin:'http://127.0.0.1:12345',builtAfter:'2026-10-08T00:00:00Z'}),/restored/);
  await writeFile(path.join(project,'index.html'),'<h1>Restored static source</h1>');
  const result=await manager.start('chat',project,{appOrigin:'http://127.0.0.1:12345',builtAfter:'2026-10-08T00:00:00Z'});
  const response=await fetch(result.url);assert.match(response.headers.get('content-type'),/charset=utf-8/);assert.match(await response.text(),/Restored static source/);
});
