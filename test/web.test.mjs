import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebApp } from '../src/web.mjs';
import http from 'node:http';
const ready = async () => ({ claude: { ready: true }, codex: { ready: true } });
async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'duet-web-'));
  const app = await createWebApp({ dataDir, projectRoot: path.join(dataDir, 'projects'), health: ready, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  const request = (route, data, headers = {}) => fetch(origin + route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${app.token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { ...app, dataDir, origin, request };
}
test('local UI loads; API requires a token and rejects foreign origins and hosts', async t => {
  const app = await setup(t);
  assert.match(await (await fetch(app.origin)).text(), /Duet/i);
  assert.equal((await fetch(app.origin + '/api/state')).status, 401);
  assert.equal((await app.request('/api/state', undefined, { Origin: 'https://evil.example' })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    http.get(app.origin + '/api/state', { headers: { Host: 'evil.example', Authorization: `Bearer ${app.token}` } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await app.request('/api/state')).status, 200);
  assert.equal((await app.request('/api/runs', {}, { 'Content-Type': 'text/plain' })).status, 415);
});
test('web build creates a missing folder, shares progress, and retains the result', async t => {
  let observed;
  const app = await setup(t, { run: async opts => {
    observed = opts;
    opts.onProgress('claude-code-1');
    opts.onState({ status: 'building', rounds: [{ round: 1, claudeBuild: 'Wrote UI' }] });
    return { status: 'approved', rounds: [{ round: 1, claudeBuild: 'Wrote UI', build: { summary: 'Wrote logic', checks: ['Passed'], run_instructions: 'npm start' } }] };
  } });
  const project = path.join(app.dataDir, 'new-project');
  const response = await app.request('/api/runs', { project, prompt: 'Build my app\nWith both agents', rounds: 3, createFolder: true });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  const result = (await (await app.request('/api/state')).json()).jobs.find(j => j.id === id);
  assert.equal(result.status, 'approved');
  assert.equal(result.events[0].label, 'claude-code-1');
  assert.ok(observed.prompt.endsWith('Build my app\nWith both agents'));
  assert.ok((await stat(project)).isDirectory());
  await app.close();
  const saved = JSON.parse(await readFile(path.join(app.dataDir, 'conversations.json')));
  assert.equal(saved.jobs[0].status, 'approved');
});
test('legacy run requests prevent overlapping builds in the same project and support cancellation', async t => {
  const app = await setup(t, { run: opts => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
  }) });
  const input = { project: app.dataDir, prompt: 'Build', rounds: 1 };
  const first = await app.request('/api/runs', input);
  const { id } = await first.json();
  assert.equal((await app.request('/api/runs', input)).status, 409);
  assert.equal((await app.request(`/api/runs/${id}/stop`, {})).status, 200);
  const state = await (await app.request('/api/state')).json();
  assert.equal(state.jobs[0].status, 'cancelled');
});
test('web blocks missing credentials, invalid prompts and arbitrary native actions', async t => {
  const app = await setup(t, { health: async () => ({ claude: { ready: false }, codex: { ready: true } }) });
  assert.equal((await app.request('/api/runs', { project: app.dataDir, prompt: '', rounds: 1 })).status, 400);
  assert.equal((await app.request('/api/runs', { project: app.dataDir, prompt: 'Build', rounds: 1 })).status, 400);
  assert.equal((await app.request('/api/login', { agent: '$(touch oops)' })).status, 400);
});
test('folder selection uses the native chooser while sign-in stays in the managed browser flow', async t => {
  const calls = [], logins = [];
  const authManager = {
    snapshot: () => ({}),
    start: async agent => { logins.push(agent); return { status: 'starting' }; },
    cancel: async () => ({ status: 'cancelled' }),
    submitCode: async () => ({ status: 'waiting' }),
    close: async () => {},
  };
  const app = await setup(t, {
    health: async () => ({ claude: { installed: true, ready: false }, codex: { installed: true, ready: false } }),
    authManager,
    native: async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: '/tmp/project/\n' }; },
  });
  assert.equal((await (await app.request('/api/folder', {})).json()).path, '/tmp/project');
  const login = await app.request('/api/login', { agent: 'claude' });
  assert.equal(login.status, 202);
  assert.deepEqual(await login.json(), { status: 'starting' });
  assert.deepEqual(logins, ['claude']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/usr/bin/osascript');
  assert.match(calls[0].args[1], /choose folder/);
});

test('coordinator settings reach the run, survive in the chat, and retries cannot change them', async t => {
  let observed;
  const app = await setup(t, { run: async options => { observed = options; return {status:'approved',rounds:[]}; } });
  const { id } = await (await app.request('/api/chats', {})).json();
  const route = `/api/chats/${id}/messages`;
  assert.equal((await app.request(route,{text:'Build',optimization:'invalid'})).status,400);
  assert.equal((await app.request(route,{text:'Build',maxCalls:-1})).status,400);
  const input={text:'Build',optimization:'economy',maxCalls:5,tokenLimit:20000,clientMessageId:'routing-test'};
  assert.equal((await app.request(route,input)).status,202);
  assert.equal(observed.optimization,'economy');assert.equal(observed.maxCalls,5);assert.equal(observed.tokenLimit,20000);
  assert.equal((await app.request(route,{...input,optimization:'quality'})).status,409);
  const state=await (await app.request('/api/state')).json();
  assert.deepEqual(state.chats.find(chat=>chat.id===id).routing,{optimization:'economy',maxCalls:5,tokenLimit:20000});
  const saved=JSON.parse(await readFile(path.join(app.dataDir,'conversations.json')));
  assert.equal(saved.chats.find(chat=>chat.id===id).routing.optimization,'economy');
});

test('project decisions stay with their chat; preview and checkpoint restore preserve a recovery copy', async t => {
  const {writeFile}=await import('node:fs/promises');
  let context;
  const app=await setup(t,{run:async options=>{context=options.prompt;return{status:'needs_attention',rounds:[],coordinator:{mode:'quality',calls:[],callsWithUsage:0,reportedTokens:0}};}});
  const project=path.join(app.dataDir,'sample-project');
  const {id}=await(await app.request('/api/chats',{project})).json();
  const patch=decisions=>fetch(app.origin+`/api/chats/${id}`,{method:'PATCH',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},body:JSON.stringify({decisions})});
  assert.equal((await patch('Use an accessible green theme.')).status,200);
  assert.equal((await patch('x'.repeat(6001))).status,400);
  const started=await(await app.request(`/api/chats/${id}/messages`,{text:'Build a page'})).json();
  await app.request('/api/state');assert.match(context,/accessible green theme/);
  await writeFile(path.join(project,'index.html'),'<h1>Original</h1>');
  const checkpoint=await(await app.request(`/api/chats/${id}/checkpoints`,{})).json();assert.ok(checkpoint.checkpoint.id);
  await writeFile(path.join(project,'index.html'),'<h1>Changed</h1>');
  const preview=await(await app.request(`/api/chats/${id}/preview`,{})).json();assert.match(await(await fetch(preview.url)).text(),/Changed/);
  assert.equal((await app.request(`/api/runs/${started.id}/feedback`,{outcome:'works'})).status,200);
  const restored=await(await app.request(`/api/chats/${id}/checkpoints/${checkpoint.checkpoint.id}/restore`,{})).json();assert.ok(restored.backup.id);
  assert.match(await readFile(path.join(project,'index.html'),'utf8'),/Original/);
  assert.equal((await(await app.request(`/api/chats/${id}/preview`)).json()).status,'stopped');
  assert.equal((await app.request(`/api/runs/${started.id}/feedback`,{outcome:'works'})).status,409);
  const checkpoints=await(await app.request(`/api/chats/${id}/checkpoints`)).json();assert.equal(checkpoints.checkpoints.length,2);
  const state=await(await app.request('/api/state')).json();assert.ok(state.chats[0].restoredAt);assert.equal(state.chats[0].decisions,'Use an accessible green theme.');
});
test('checkpoint changes cannot overlap an active build or cross workspace origins',async t=>{
  const app=await setup(t,{run:options=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true}))});
  const {id}=await(await app.request('/api/chats',{project:path.join(app.dataDir,'project')})).json();
  await app.request(`/api/chats/${id}/messages`,{text:'Build'});
  assert.equal((await app.request(`/api/chats/${id}/checkpoints`,{})).status,409);
  assert.equal((await app.request(`/api/chats/${id}/preview`,{}, {Origin:'http://localhost:1234'})).status,403);
});
