import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { startServer } from '../src/lifecycle.mjs';
import { createWebApp } from '../src/web.mjs';

async function availablePort() {
  const reservation = http.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

test('real server preserves chats, address and token through duplicates, restart, and concurrent launch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duet-restart-'));
  const dataDir = path.join(root, 'data');
  const port = await availablePort();
  const handles = [];
  t.after(async () => { for (const handle of handles) await handle.close(); });
  let createCount = 0, finishAnswer;
  const options = { root, dataDir, port, handleSignals: false, logger: { log() {}, error() {} },
    createWebApp: async config => {
      createCount++;
      return createWebApp({ ...config, projectRoot: path.join(root, 'projects'),
        health: async () => ({ claude: { ready: true }, codex: { ready: true } }),
        ask: () => new Promise(resolve => { finishAnswer = () => resolve({ status: 'answered', answer: 'Saved reply from this chat.', rounds: [] }); }),
      });
    },
  };
  const first = await startServer(options); handles.push(first);
  const request = async (route, data) => {
    const response = await fetch(first.origin + route, { method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${first.token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  assert.deepEqual(await (await fetch(first.origin + '/api/ping')).json(), { app: 'duet', version: '0.9.0' });
  const a = await request('/api/chats', { title: 'First separate chat' });
  const b = await request('/api/chats', { title: 'Second separate chat' });
  const turn = await request(`/api/chats/${a.id}/messages`, { text: 'Keep this conversation intact', mode: 'ask' });
  const beforeDuplicate = await readFile(path.join(dataDir, 'conversations.json'), 'utf8');
  const duplicate = await startServer(options); handles.push(duplicate);
  assert.equal(duplicate.reused, true);
  assert.equal(createCount, 1);
  assert.equal((await request('/api/state')).active, turn.id);
  assert.equal(await readFile(path.join(dataDir, 'conversations.json'), 'utf8'), beforeDuplicate);
  finishAnswer();
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await request('/api/state');
    if (!state.active) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.active, null);
  assert.equal(state.chats.find(chat => chat.id === a.id).messages.length, 2);
  assert.equal(state.chats.find(chat => chat.id === b.id).messages.length, 0);
  await first.close();
  const restarted = await startServer(options); handles.push(restarted);
  assert.equal(restarted.origin, first.origin);
  assert.equal(restarted.token, first.token);
  const restored = await request('/api/state');
  assert.deepEqual(restored.chats, state.chats);
  assert.deepEqual(restored.jobs, state.jobs);
  await restarted.close();
  const countBeforeConcurrentLaunch = createCount;
  const concurrent = await Promise.all([startServer(options), startServer(options)]); handles.push(...concurrent);
  assert.equal(concurrent.filter(handle => handle.reused).length, 1);
  assert.equal(createCount, countBeforeConcurrentLaunch + 1);
  assert.deepEqual((await request('/api/state')).chats, state.chats);
});
