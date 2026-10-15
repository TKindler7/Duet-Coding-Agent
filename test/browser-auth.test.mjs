import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebApp } from '../src/web.mjs';

const connected = () => ({ claude: { installed: true, ready: true }, codex: { installed: true, ready: true } });
const signedOut = () => ({ claude: { installed: true, ready: false }, codex: { installed: true, ready: false } });
const active = value => ['starting', 'waiting'].includes(value?.status);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  assert.fail(`Timed out: ${description}`);
}
function authControl(initial = {}) {
  const states = structuredClone(initial), calls = [], launches = [];
  let closeCount = 0;
  const manager = {
    snapshot: () => structuredClone(states),
    start(agent) {
      calls.push({ method: 'start', agent });
      if (!active(states[agent])) {
        launches.push(agent);
        states[agent] = { status: 'waiting', url: agent === 'claude'
          ? 'https://claude.ai/oauth/authorize?flow=mock'
          : 'https://auth.openai.com/oauth/authorize?flow=mock', ...(agent === 'claude' ? { acceptsCode: true } : {}) };
      }
      return structuredClone(states[agent]);
    },
    cancel(agent) {
      calls.push({ method: 'cancel', agent });
      states[agent] = active(states[agent]) ? { status: states[agent].status, cancelling: true } : { status: 'cancelled' };
      return structuredClone(states[agent]);
    },
    submitCode(agent, code) {
      calls.push({ method: 'submitCode', agent, code });
      if (!active(states[agent]) || !states[agent].acceptsCode || typeof code !== 'string' || !code.trim()) {
        throw Object.assign(new Error('No code is expected for this account.'), { status: 400 });
      }
      return { status: states[agent].status, submitted: true };
    },
    wait: async () => {},
    close: async () => {
      closeCount++;
      for (const agent of Object.keys(states)) if (active(states[agent])) states[agent] = { status: 'cancelled' };
    },
  };
  return { manager, states, calls, launches, get closeCount() { return closeCount; } };
}
async function fixture(t, { authState, health = async () => signedOut(), setupState = {}, ...options } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duet-browser-auth-'));
  const dataDir = path.join(root, 'data'), projectRoot = path.join(root, 'projects');
  const auth = authControl(authState), installs = [], nativeCalls = [], runs = [];
  const setupManager = {
    snapshot: () => structuredClone(setupState),
    install: agent => { installs.push(agent); setupState[agent] = { status: 'installing' }; return structuredClone(setupState[agent]); },
    close: async () => {},
  };
  const app = await createWebApp({ dataDir, projectRoot, health, authManager: auth.manager, setupManager,
    native: async (...args) => { nativeCalls.push(args); throw new Error('Unexpected native command'); },
    run: async options => { runs.push(options); return { status: 'approved', rounds: [] }; },
    ask: async options => { runs.push(options); return { status: 'answered', answer: 'Done', rounds: [] }; },
    ...options,
  });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const request = (route, body, { authenticate = true, headers = {} } = {}) => fetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(authenticate ? { Authorization: `Bearer ${app.token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const state = async () => (await request('/api/state')).json();
  const chat = async (input = {}) => {
    const response = await request('/api/chats', input);
    assert.equal(response.status, 201);
    return (await response.json()).id;
  };
  await state();
  return { ...app, auth, installs, nativeCalls, runs, root, dataDir, projectRoot, origin, request, state, chat, close };
}

test('a browser session signs in, submits the provider code, and cancels without opening Terminal', async t => {
  let credentials = signedOut();
  const app = await fixture(t, { health: async () => credentials });
  const cookie = (await fetch(app.origin)).headers.get('set-cookie').split(';')[0];
  const browser = (route, body) => app.request(route, body, { authenticate: false, headers: {
    Cookie: cookie, Origin: app.origin, 'X-Duet-Request': '1', 'Sec-Fetch-Site': 'same-origin',
  } });
  const first = await browser('/api/login', { agent: 'claude' });
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), app.auth.states.claude);
  const waiting = await (await browser('/api/state')).json();
  assert.deepEqual(waiting.auth, { claude: app.auth.states.claude });
  assert.equal(waiting.active, 'account-sign-in');
  assert.deepEqual(waiting.activeOperations, []);
  assert.deepEqual(waiting.concurrency, { limit: 3, running: 0 });
  assert.equal((await browser('/api/login', { agent: 'claude' })).status, 202);
  assert.deepEqual(app.auth.launches, ['claude']);
  assert.equal((await browser('/api/login', { agent: 'codex' })).status, 409);
  const code = await browser('/api/login/code', { agent: 'claude', code: 'mock-verification-code' });
  assert.equal(code.status, 200);
  assert.deepEqual(await code.json(), { status: 'waiting', submitted: true });
  assert.equal((await app.state()).active, 'account-sign-in');
  app.auth.states.claude = { status: 'connected' };
  credentials = connected();
  assert.equal((await browser('/api/refresh', {})).status, 200);
  assert.equal((await app.state()).credentials.claude.ready, true);
  assert.equal((await app.state()).active, null);
  credentials = signedOut();
  await browser('/api/refresh', {});
  assert.equal((await browser('/api/login', { agent: 'codex' })).status, 202);
  const cancel = await browser('/api/login/cancel', { agent: 'codex' });
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { status: 'waiting', cancelling: true });
  assert.equal((await app.state()).active, 'account-sign-in');
  assert.equal((await browser('/api/login', { agent: 'claude' })).status, 409);
  app.auth.states.codex = { status: 'cancelled' };
  assert.equal((await app.state()).active, null);
  assert.deepEqual(app.nativeCalls, []);
  const saved = await readFile(path.join(app.dataDir, 'conversations.json'), 'utf8');
  assert.ok(!saved.includes('mock-verification-code'));
  assert.ok(!saved.includes('oauth/authorize'));
  assert.ok(!JSON.stringify(await app.state()).includes(app.token));
});

test('every sign-in route authenticates and validates origin and provider before touching the manager', async t => {
  const app = await fixture(t);
  for (const route of ['/api/login', '/api/login/cancel', '/api/login/code']) {
    assert.equal((await app.request(route, { agent: 'claude', code: 'mock' }, { authenticate: false })).status, 401);
    assert.equal((await app.request(route, { agent: 'claude', code: 'mock' }, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    for (const agent of ['claude; touch oops', '../codex', '__proto__', null, ['claude']]) {
      assert.equal((await app.request(route, { agent, code: 'mock' })).status, 400);
    }
  }
  assert.deepEqual(app.auth.calls, []);
  assert.deepEqual(app.nativeCalls, []);
  const start = await app.request('/api/login', { agent: 'claude', command: 'touch oops', args: ['--unsafe'] });
  assert.equal(start.status, 202);
  assert.deepEqual(app.auth.calls, [{ method: 'start', agent: 'claude' }]);
  const payload = await start.json();
  assert.ok(!('manualCommand' in payload));
  assert.ok(!('command' in payload));
});

test('existing account sessions are reused without launching another sign-in', async t => {
  const app = await fixture(t, { health: async () => connected() });
  for (const agent of ['claude', 'codex']) {
    const response = await app.request('/api/login', { agent });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'connected' });
  }
  assert.deepEqual(app.auth.calls, []);
  assert.deepEqual((await app.state()).auth, {});
  assert.equal((await app.state()).active, null);
});

test('an older account check cannot overwrite a newer connected result but returns its own result', async t => {
  const entered = deferred(), olderResult = deferred();
  let healthCalls = 0, olderRequest;
  const app = await fixture(t, { health: async () => {
    if (++healthCalls === 2) { entered.resolve(); return olderResult.promise; }
    return healthCalls === 1 ? signedOut() : connected();
  } });
  assert.deepEqual((await app.state()).credentials, signedOut());
  try {
    olderRequest = app.request('/api/refresh', {});
    await entered.promise;
    const newerRequest = await app.request('/api/refresh', {});
    assert.equal(newerRequest.status, 200);
    assert.deepEqual(await newerRequest.json(), connected());
    assert.deepEqual((await app.state()).credentials, connected());
    olderResult.resolve(signedOut());
    const olderResponse = await olderRequest;
    assert.equal(olderResponse.status, 200);
    assert.deepEqual(await olderResponse.json(), signedOut());
    assert.deepEqual((await app.state()).credentials, connected());
    assert.equal((await app.request('/api/login', { agent: 'claude' })).status, 202);
    assert.deepEqual(app.auth.calls, []);
  } finally { olderResult.resolve(signedOut()); if (olderRequest) await olderRequest; }
});

test('starting or waiting for sign-in reserves the app until cancelled without creating phantom work', async t => {
  for (const status of ['starting', 'waiting']) await t.test(status, async t => {
    const app = await fixture(t, { authState: { claude: { status } }, health: async () => connected() });
    const chatId = await app.chat();
    const before = (await app.state()).chats;
    for (const mode of ['build', 'ask']) {
      assert.equal((await app.request(`/api/chats/${chatId}/messages`, { text: 'Build after sign-in', mode })).status, 409);
    }
    assert.equal((await app.request('/api/runs', { project: path.join(app.root, 'legacy'), prompt: 'Legacy build', rounds: 1 })).status, 409);
    assert.equal((await app.request(`/api/chats/${chatId}/checkpoints`, {})).status, 409);
    assert.equal((await app.request('/api/setup/install', { agent: 'codex' })).status, 409);
    assert.equal((await app.request('/api/login', { agent: 'codex' })).status, 409);
    const blocked = await app.state();
    assert.deepEqual(blocked.chats, before);
    assert.deepEqual(blocked.jobs, []);
    assert.deepEqual(blocked.activeOperations, []);
    assert.equal(blocked.active, 'account-sign-in');
    assert.deepEqual(app.installs, []);
    assert.deepEqual(app.runs, []);
    assert.equal((await app.request('/api/login/cancel', { agent: 'claude' })).status, 200);
    assert.equal((await app.state()).active, 'account-sign-in');
    assert.equal((await app.request(`/api/chats/${chatId}/messages`, { text: 'Wait for helper shutdown' })).status, 409);
    app.auth.states.claude = { status: 'cancelled' };
    assert.equal((await app.state()).active, null);
    const send = await app.request(`/api/chats/${chatId}/messages`, { text: 'Now build', mode: 'build' });
    assert.equal(send.status, 202);
    await until(() => app.runs.length === 1, 'build after cancellation');
  });
});

test('running builds and tool installations block sign-in without spawning account processes', async t => {
  const app = await fixture(t, { health: async () => connected(), run: options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
  }) });
  const chatId = await app.chat();
  const turn = await (await app.request(`/api/chats/${chatId}/messages`, { text: 'Build' })).json();
  assert.equal((await app.request('/api/login', { agent: 'claude' })).status, 409);
  assert.deepEqual(app.auth.calls, []);
  assert.equal((await app.state()).active, turn.id);
  assert.equal((await app.request(`/api/runs/${turn.id}/stop`, {})).status, 200);
  const installing = await fixture(t, { setupState: { codex: { status: 'installing' } } });
  assert.equal((await installing.request('/api/login', { agent: 'claude' })).status, 409);
  assert.deepEqual(installing.auth.calls, []);
});

test('a preparing build already blocks sign-in before its account check completes', async t => {
  const entered = deferred(), gate = deferred();
  let healthCalls = 0, send;
  const app = await fixture(t, { health: async () => {
    if (++healthCalls === 2) { entered.resolve(); return gate.promise; }
    return connected();
  } });
  const chatId = await app.chat();
  try {
    send = app.request(`/api/chats/${chatId}/messages`, { text: 'Prepare this build' });
    await entered.promise;
    assert.equal((await app.state()).activeOperations[0].phase, 'preparing');
    assert.equal((await app.request('/api/login', { agent: 'claude' })).status, 409);
    assert.deepEqual(app.auth.calls, []);
  } finally { gate.resolve(connected()); if (send) await send; }
});

test('checkpoint creation reserves sign-in until the file operation finishes', async t => {
  const entered = deferred(), gate = deferred();
  let held = false, checkpoint;
  const app = await fixture(t, { previewManager: {
    status: () => ({ status: 'stopped' }), close: async () => {},
    stop: async () => { if (!held) { held = true; entered.resolve(); await gate.promise; } return { status: 'stopped' }; },
  } });
  const project = path.join(app.root, 'checkpoint-project');
  await mkdir(project); await writeFile(path.join(project, 'index.html'), '<h1>Saved</h1>');
  const chatId = await app.chat({ project });
  try {
    checkpoint = app.request(`/api/chats/${chatId}/checkpoints`, {});
    await entered.promise;
    assert.equal((await app.state()).activeOperations[0].kind, 'checkpoint');
    assert.equal((await app.request('/api/login', { agent: 'claude' })).status, 409);
    assert.deepEqual(app.auth.calls, []);
  } finally { gate.resolve(); if (checkpoint) assert.equal((await checkpoint).status, 201); }
  assert.equal((await app.request('/api/login', { agent: 'claude' })).status, 202);
});

test('concurrent account requests launch only one provider and a failed flow can be retried', async t => {
  const app = await fixture(t);
  const responses = await Promise.all(['claude', 'codex'].map(agent => app.request('/api/login', { agent })));
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  assert.equal(app.auth.launches.length, 1);
  const agent = app.auth.launches[0];
  app.auth.states[agent] = { status: 'failed', error: 'Sign-in did not finish. Try again.' };
  assert.equal((await app.state()).active, null);
  assert.equal((await app.request('/api/login', { agent })).status, 202);
  assert.deepEqual(app.auth.launches, [agent, agent]);
  assert.deepEqual((await app.state()).jobs, []);
});

test('invalid or unexpected verification codes do not clear the active sign-in', async t => {
  const app = await fixture(t);
  await app.request('/api/login', { agent: 'claude' });
  for (const code of ['', null, { command: 'touch oops' }]) {
    assert.equal((await app.request('/api/login/code', { agent: 'claude', code })).status, 400);
  }
  assert.equal((await app.request('/api/login/code', { agent: 'codex', code: 'not-expected' })).status, 400);
  assert.equal((await app.state()).auth.claude.status, 'waiting');
  assert.equal((await app.state()).active, 'account-sign-in');
  assert.deepEqual(app.nativeCalls, []);
});

test('closing the workspace closes the managed sign-in without storing account state in chat history', async t => {
  const app = await fixture(t);
  const chatId = await app.chat({ title: 'Keep this chat' });
  await app.request('/api/login', { agent: 'claude' });
  await app.close();
  assert.equal(app.auth.closeCount, 1);
  assert.deepEqual(app.auth.manager.snapshot(), { claude: { status: 'cancelled' } });
  const saved = JSON.parse(await readFile(path.join(app.dataDir, 'conversations.json'), 'utf8'));
  assert.equal(saved.chats[0].id, chatId);
  assert.equal(saved.chats[0].title, 'Keep this chat');
  assert.deepEqual(saved.chats[0].messages, []);
  assert.deepEqual(saved.jobs, []);
  assert.ok(!('auth' in saved));
});
