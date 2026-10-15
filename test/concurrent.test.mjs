import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebApp } from '../src/web.mjs';

const ready = () => ({ claude: { ready: true }, codex: { ready: true } });
const complete = { status: 'approved', rounds: [] };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check, description) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  assert.fail(`Timed out: ${description}`);
}
function controlledRunner() {
  const calls = [];
  const run = options => {
    const work = deferred();
    const entry = { ...work, options };
    calls.push(entry);
    options.signal.addEventListener('abort', () => work.reject(new Error('Stopped by user')), { once: true });
    if (options.signal.aborted) work.reject(new Error('Stopped by user'));
    options.onProgress('claude-code-1');
    return work.promise;
  };
  return { run, calls };
}
async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duet-concurrency-'));
  const dataDir = path.join(root, 'data'), projectRoot = path.join(root, 'projects');
  const control = controlledRunner();
  const app = await createWebApp({ dataDir, projectRoot, health: async () => ready(), run: control.run, ask: control.run, ...options });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const request = (route, input) => fetch(origin + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${app.token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const state = async () => (await request('/api/state')).json();
  const chat = async (input = {}) => {
    const response = await request('/api/chats', input);
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).id;
  };
  const send = async (chatId, text = 'Build this project') => {
    const response = await request(`/api/chats/${chatId}/messages`, { text, mode: 'build', rounds: 1 });
    assert.equal(response.status, 202, await response.clone().text());
    return response.json();
  };
  const finish = async id => until(async () => {
    const snapshot = await state();
    const job = snapshot.jobs.find(job => job.id === id);
    return job?.finishedAt && !snapshot.activeOperations.some(operation => operation.id === id) && { job, snapshot };
  }, `turn ${id} finishing`);
  return { ...app, ...control, root, dataDir, projectRoot, request, state, chat, send, finish, close };
}

test('different chats build concurrently up to the default limit without mixing state', async t => {
  const app = await setup(t);
  const chats = await Promise.all(Array.from({ length: 4 }, () => app.chat()));
  const turns = await Promise.all(chats.slice(0, 3).map((id, index) => app.send(id, `Unique build ${index}`)));
  await until(() => app.calls.length === 3, 'three concurrent runners');
  const state = await app.state();
  assert.deepEqual(state.concurrency, { limit: 3, running: 3 });
  assert.equal(state.activeOperations.length, 3);
  assert.ok(turns.some(turn => turn.id === state.active));
  for (const turn of turns) {
    const operation = state.activeOperations.find(operation => operation.id === turn.id);
    assert.equal(operation.chatId, turn.chatId);
    assert.equal(operation.kind, 'turn');
    assert.equal(operation.phase, 'running');
    assert.ok(path.isAbsolute(operation.project));
    const ownChat = state.chats.find(chat => chat.id === turn.chatId);
    assert.deepEqual(ownChat.runIds, [turn.id]);
    assert.equal(ownChat.messages.length, 1);
  }
  const fourth = await app.request(`/api/chats/${chats[3]}/messages`, { text: 'Wait for a slot', mode: 'build' });
  assert.equal(fourth.status, 409);
  const duplicateChat = await app.request(`/api/chats/${chats[0]}/messages`, { text: 'A second turn in the same chat', mode: 'build' });
  assert.equal(duplicateChat.status, 409);
  assert.deepEqual((await app.state()).chats.find(chat => chat.id === chats[3]).messages, []);
  for (const call of app.calls) call.resolve(complete);
  await Promise.all(turns.map(turn => app.finish(turn.id)));
  const done = await app.state();
  assert.deepEqual(done.activeOperations, []);
  assert.deepEqual(done.concurrency, { limit: 3, running: 0 });
  assert.equal(done.active, null);
});

test('cancellation, failure, and completion release only the owning turn and allow that chat to retry', async t => {
  const app = await setup(t);
  const first = await app.chat(), second = await app.chat(), third = await app.chat();
  const a = await app.send(first, 'ALPHA_BUILD');
  const b = await app.send(second, 'BETA_BUILD');
  const c = await app.send(third, 'GAMMA_BUILD');
  await until(() => app.calls.length === 3, 'three runners');
  const beta = app.calls.find(call => call.options.prompt.includes('BETA_BUILD'));
  const gamma = app.calls.find(call => call.options.prompt.includes('GAMMA_BUILD'));
  assert.equal((await app.request(`/api/runs/${a.id}/stop`, {})).status, 200);
  assert.equal((await app.finish(a.id)).job.status, 'cancelled');
  assert.equal(beta.options.signal.aborted, false);
  assert.equal(gamma.options.signal.aborted, false);
  let state = await app.state();
  assert.deepEqual(new Set(state.activeOperations.map(operation => operation.id)), new Set([b.id, c.id]));
  assert.equal(state.concurrency.running, 2);
  beta.reject(new Error('Only beta failed'));
  assert.equal((await app.finish(b.id)).job.status, 'failed');
  state = await app.state();
  assert.deepEqual(state.activeOperations.map(operation => operation.id), [c.id]);
  const retry = await app.send(second, 'Continue my beta project');
  await until(() => app.calls.length === 4, 'retry runner');
  app.calls[3].resolve(complete);
  await app.finish(retry.id);
  state = await app.state();
  assert.deepEqual(state.activeOperations.map(operation => operation.id), [c.id]);
  assert.equal(gamma.options.signal.aborted, false);
  gamma.resolve(complete);
  await app.finish(c.id);
});

test('preparing turns reserve capacity before health checks and failed setup releases only its reservation', async t => {
  const gateA = deferred(), gateB = deferred(), enteredA = deferred(), enteredB = deferred();
  let healthCall = 0;
  const app = await setup(t, { maxConcurrentTurns: 2, health: async () => {
    healthCall++;
    if (healthCall === 2) { enteredA.resolve(); return gateA.promise; }
    if (healthCall === 3) { enteredB.resolve(); return gateB.promise; }
    return ready();
  } });
  const first = await app.chat(), second = await app.chat(), third = await app.chat();
  const post = id => app.request(`/api/chats/${id}/messages`, { text: 'Prepare safely', mode: 'build' });
  let pendingA, pendingB;
  try {
    pendingA = post(first); await enteredA.promise;
    assert.equal((await post(first)).status, 409, 'same-chat reservation exists during the health check');
    pendingB = post(second); await enteredB.promise;
    const preparing = await app.state();
    assert.deepEqual(preparing.concurrency, { limit: 2, running: 2 });
    assert.equal(preparing.activeOperations.length, 2);
    assert.ok(preparing.activeOperations.every(operation => operation.phase === 'preparing'));
    assert.equal((await post(third)).status, 409);
    assert.equal(app.calls.length, 0);
    gateA.reject(new Error('Temporary account check failure'));
    assert.equal((await pendingA).ok, false);
    const stillPreparing = await app.state();
    assert.equal(stillPreparing.activeOperations.length, 1);
    assert.equal(stillPreparing.activeOperations[0].chatId, second);
    assert.deepEqual(stillPreparing.chats.find(chat => chat.id === first).messages, []);
    const thirdTurn = await app.send(third, 'Use the released slot');
    gateB.resolve(ready());
    assert.equal((await pendingB).status, 202);
    await until(() => app.calls.length === 2, 'remaining prepared and replacement runners');
    const state = await app.state();
    assert.deepEqual(new Set(state.activeOperations.map(operation => operation.chatId)), new Set([second, third]));
    assert.ok(state.activeOperations.some(operation => operation.id === thirdTurn.id));
  } finally {
    gateA.resolve(ready()); gateB.resolve(ready());
    await Promise.allSettled([pendingA, pendingB].filter(Boolean));
  }
});

test('canonical project guards cover symlink aliases, descendants, and similar-but-independent folder names', async t => {
  const app = await setup(t);
  const project = path.join(app.root, 'workspace'), alias = path.join(app.root, 'alias');
  await mkdir(path.join(project, 'child'), { recursive: true });
  await symlink(project, alias);
  const owner = await app.chat({ project });
  const active = await app.send(owner);
  for (const conflicting of [project, alias, path.join(project, 'child'), path.join(alias, 'future', 'nested')]) {
    const chat = await app.chat({ project: conflicting });
    const response = await app.request(`/api/chats/${chat}/messages`, { text: 'Conflicting project', mode: 'build' });
    assert.equal(response.status, 409, conflicting);
    assert.deepEqual((await app.state()).chats.find(item => item.id === chat).messages, []);
  }
  const neighbor = await app.chat({ project: project + '-independent' });
  const allowed = await app.send(neighbor);
  assert.equal((await app.state()).activeOperations.length, 2);
  assert.equal((await app.request(`/api/runs/${active.id}/stop`, {})).status, 200);
  await app.finish(active.id);
  assert.ok((await app.state()).activeOperations.some(operation => operation.id === allowed.id));
});

test('simultaneous aliases of a missing project admit only one preparation and runner', async t => {
  const gate = deferred(), entered = deferred();
  let healthCalls = 0;
  const app = await setup(t, { health: async () => {
    healthCalls++;
    if (healthCalls > 1) { entered.resolve(); return gate.promise; }
    return ready();
  } });
  const parent = path.join(app.root, 'real-parent'), alias = path.join(app.root, 'linked-parent');
  await mkdir(parent); await symlink(parent, alias);
  const first = await app.chat({ project: path.join(parent, 'future', 'project') });
  const second = await app.chat({ project: path.join(alias, 'future', 'project') });
  let requests = [];
  try {
    requests = [first, second].map(id => app.request(`/api/chats/${id}/messages`, { text: 'Claim this project', mode: 'build' }));
    await entered.promise;
    const denied = await Promise.race(requests);
    assert.equal(denied.status, 409);
    assert.equal(healthCalls, 2, 'only one contender may reach the health check');
    assert.equal(app.calls.length, 0);
    assert.equal((await app.state()).activeOperations.length, 1);
    gate.resolve(ready());
    const outcomes = await Promise.all(requests);
    assert.deepEqual(outcomes.map(response => response.status).sort(), [202, 409]);
    await until(() => app.calls.length === 1, 'the sole project runner');
    assert.equal((await app.state()).jobs.length, 1);
  } finally {
    gate.resolve(ready());
    await Promise.allSettled(requests);
  }
});

test('cancelling a preparing turn leaves no phantom history and does not stop a different active chat', async t => {
  const gate = deferred(), entered = deferred();
  let healthCalls = 0;
  const app = await setup(t, { health: async () => {
    healthCalls++;
    if (healthCalls === 3) { entered.resolve(); return gate.promise; }
    return ready();
  } });
  const running = await app.chat(), preparing = await app.chat();
  const active = await app.send(running, 'Keep this other work running');
  let request;
  try {
    request = app.request(`/api/chats/${preparing}/messages`, { text: 'Cancel before starting', mode: 'build' });
    await entered.promise;
    const state = await app.state();
    const operation = state.activeOperations.find(operation => operation.chatId === preparing);
    assert.equal(operation.phase, 'preparing');
    assert.equal((await app.request(`/api/runs/${operation.id}/stop`, {})).status, 200);
    gate.resolve(ready());
    assert.equal((await request).ok, false);
    const after = await app.state();
    assert.deepEqual(after.activeOperations.map(operation => operation.id), [active.id]);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].options.signal.aborted, false);
    assert.deepEqual(after.chats.find(chat => chat.id === preparing).messages, []);
    assert.equal(after.jobs.length, 1);
    const saved = JSON.parse(await readFile(path.join(app.dataDir, 'conversations.json'), 'utf8'));
    assert.deepEqual(saved.chats.find(chat => chat.id === preparing).messages, []);
    assert.equal(saved.jobs.length, 1);
  } finally {
    gate.resolve(ready());
    if (request) await request;
  }
});

test('an active child project also blocks turns and checkpoints on its parent', async t => {
  const app = await setup(t);
  const project = path.join(app.root, 'parent');
  const child = await app.chat({ project: path.join(project, 'child') });
  await app.send(child);
  const parent = await app.chat({ project });
  assert.equal((await app.request(`/api/chats/${parent}/messages`, { text: 'Parent would overlap', mode: 'build' })).status, 409);
  assert.equal((await app.request(`/api/chats/${parent}/checkpoints`, {})).status, 409);
  assert.equal((await app.state()).activeOperations.length, 1);
});

test('checkpoints reserve only their own project while other builds continue and tool installation stays blocked', async t => {
  const pause = deferred(), entered = deferred();
  const previewManager = { status: () => ({ status: 'stopped' }), stop: async () => { entered.resolve(); await pause.promise; return { status: 'stopped' }; }, close: async () => {} };
  const app = await setup(t, { previewManager, maxConcurrentTurns: 2 });
  const building = await app.chat();
  const firstTurn = await app.send(building);
  const project = path.join(app.root, 'checkpoint-project');
  await mkdir(project); await writeFile(path.join(project, 'index.html'), '<h1>Before</h1>');
  const target = await app.chat({ project });
  let checkpointRequest;
  try {
    checkpointRequest = app.request(`/api/chats/${target}/checkpoints`, {});
    await entered.promise;
    const busy = await app.state();
    assert.equal(busy.activeOperations.length, 2);
    assert.equal(busy.concurrency.running, 1);
    assert.equal(busy.activeOperations.find(operation => operation.chatId === target).kind, 'checkpoint');
    assert.equal((await app.request(`/api/chats/${target}/messages`, { text: 'Cannot edit snapshot', mode: 'build' })).status, 409);
    assert.equal((await app.request(`/api/chats/${building}/checkpoints`, {})).status, 409);
    assert.equal((await app.request('/api/setup/install', { agent: 'codex' })).status, 409);
    const other = await app.chat();
    const otherTurn = await app.send(other);
    pause.resolve();
    const saved = await checkpointRequest;
    assert.equal(saved.status, 201, await saved.clone().text());
    const { checkpoint } = await saved.json();
    await writeFile(path.join(project, 'index.html'), '<h1>After</h1>');
    const restored = await app.request(`/api/chats/${target}/checkpoints/${checkpoint.id}/restore`, {});
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.ok((await restored.json()).backup.id);
    assert.match(await readFile(path.join(project, 'index.html'), 'utf8'), /Before/);
    const state = await app.state();
    assert.deepEqual(new Set(state.activeOperations.map(operation => operation.id)), new Set([firstTurn.id, otherTurn.id]));
    assert.equal(state.concurrency.running, 2);
    assert.ok(app.calls.every(call => !call.options.signal.aborted));
  } finally {
    pause.resolve();
    if (checkpointRequest) await checkpointRequest;
  }
});

test('shutdown aborts and persists every concurrent turn', async t => {
  const app = await setup(t);
  const chats = await Promise.all(Array.from({ length: 3 }, () => app.chat()));
  const turns = await Promise.all(chats.map(id => app.send(id)));
  await until(() => app.calls.length === 3, 'all runners before shutdown');
  await app.close();
  assert.ok(app.calls.every(call => call.options.signal.aborted));
  const saved = JSON.parse(await readFile(path.join(app.dataDir, 'conversations.json'), 'utf8'));
  for (const turn of turns) {
    const job = saved.jobs.find(job => job.id === turn.id);
    assert.equal(job.status, 'cancelled');
    assert.ok(job.finishedAt);
    assert.ok(saved.chats.find(chat => chat.id === turn.chatId).messages.some(message => message.role === 'assistant'));
  }
  assert.deepEqual(app.snapshot().activeOperations, []);
  assert.equal(app.snapshot().concurrency.running, 0);
});

test('pending project-folder edits block only that chat and later turns use the committed folder', async t => {
  const gate = deferred(), entered = deferred();
  let stopCalls = 0;
  const previewManager = {
    status: () => ({ status: 'stopped' }),
    stop: async () => {
      if (++stopCalls === 1) { entered.resolve(); await gate.promise; }
      return { status: 'stopped' };
    },
    close: async () => {},
  };
  const app = await setup(t, { previewManager });
  const editing = await app.chat(), independent = await app.chat();
  const newFolder = path.join(app.root, 'new-project-folder');
  let change;
  try {
    change = app.request(`/api/chats/${editing}/project`, { project: newFolder, createFolder: true });
    await entered.promise;
    const tooEarly = await app.request(`/api/chats/${editing}/messages`, { text: 'Do not use the old folder', mode: 'build' });
    assert.equal(tooEarly.status, 409);
    assert.deepEqual((await app.state()).chats.find(chat => chat.id === editing).messages, []);
    const otherTurn = await app.send(independent, 'INDEPENDENT_DURING_EDIT');
    await until(() => app.calls.length === 1, 'the independent chat runner');
    gate.resolve();
    const changed = await change;
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.equal((await app.state()).chats.find(chat => chat.id === editing).project, newFolder);
    const editedTurn = await app.send(editing, 'USE_COMMITTED_PROJECT_FOLDER');
    await until(() => app.calls.length === 2, 'the edited chat runner');
    const own = app.calls.find(call => call.options.prompt.includes('USE_COMMITTED_PROJECT_FOLDER'));
    assert.equal(own.options.project, await realpath(newFolder));
    assert.ok(app.calls.every(call => !call.options.signal.aborted));
    assert.deepEqual(new Set((await app.state()).activeOperations.map(operation => operation.id)), new Set([otherTurn.id, editedTurn.id]));
  } finally {
    gate.resolve();
    if (change) await change;
  }
});
