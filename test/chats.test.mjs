import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebApp } from '../src/web.mjs';

const ready = async () => ({ claude: { ready: true }, codex: { ready: true } });
const answered = answer => ({ status: 'answered', answer, rounds: [] });
const built = summary => ({ status: 'approved', rounds: [{ round: 1,
  build: { summary, checks: ['All checks passed'], run_instructions: 'npm start' },
  review: { verdict: 'approve', summary: 'Ready to use', findings: [] },
}] });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duet-chats-'));
  const dataDir = path.join(root, 'data');
  const projectRoot = path.join(root, 'projects');
  await mkdir(dataDir);
  await mkdir(projectRoot);
  const cleanups = [];
  t.after(async () => {
    for (const close of cleanups) await close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, projectRoot, cleanups };
}

async function setup(t, options = {}, paths) {
  paths ??= await fixture(t);
  const app = await createWebApp({ ...paths, health: ready,
    run: async () => built('Finished the requested changes'),
    ask: async () => answered('Here is the answer'), ...options });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  paths.cleanups.push(close);
  const request = (route, input) => fetch(origin + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${app.token}`,
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const state = async () => {
    const response = await request('/api/state');
    assert.equal(response.status, 200);
    return response.json();
  };
  const chat = async input => {
    const response = await request('/api/chats', input ?? {});
    assert.ok(response.status === 200 || response.status === 201, await response.clone().text());
    const created = await response.json();
    assert.ok(created.id);
    return created.id;
  };
  const send = async (chatId, text, extra = {}) => {
    const response = await request(`/api/chats/${chatId}/messages`, { text, mode: 'ask', rounds: 1, ...extra });
    assert.equal(response.status, 202, await response.clone().text());
    return response.json();
  };
  const finish = async id => {
    for (let count = 0; count < 250; count++) {
      const snapshot = await state();
      const job = snapshot.jobs.find(job => job.id === id);
      if (job?.finishedAt && snapshot.active !== id) return { job, snapshot };
      await delay(20);
    }
    assert.fail(`Job ${id} did not finish`);
  };
  return { ...app, ...paths, close, request, state, chat, send, finish };
}

test('separate chats use separate projects, messages, jobs, and model context', async t => {
  const calls = [];
  const app = await setup(t, { ask: async options => {
    calls.push(options);
    return answered(options.prompt.includes('ORCHID-PRIVATE') ? 'ORCHID-ANSWER' : 'CEDAR-ANSWER');
  } });
  const orchidId = await app.chat({ title: 'Orchid app' });
  const cedarId = await app.chat({ title: 'Cedar app' });
  const initial = await app.state();
  const orchid = initial.chats.find(chat => chat.id === orchidId);
  const cedar = initial.chats.find(chat => chat.id === cedarId);
  assert.notEqual(orchid.project, cedar.project);
  assert.equal(path.dirname(orchid.project), app.projectRoot);
  assert.equal(path.dirname(cedar.project), app.projectRoot);

  const first = await app.send(orchidId, 'ORCHID-PRIVATE: Build a garden planner');
  await app.finish(first.id);
  const second = await app.send(cedarId, 'CEDAR-PRIVATE: Build a cabin planner');
  await app.finish(second.id);
  const followup = await app.send(orchidId, 'Continue with the earlier design');
  const { snapshot } = await app.finish(followup.id);
  assert.equal(first.chatId, orchidId);
  assert.equal(second.chatId, cedarId);
  assert.match(calls[2].prompt, /ORCHID-PRIVATE/);
  assert.match(calls[2].prompt, /ORCHID-ANSWER/);
  assert.match(calls[2].prompt, /Continue with the earlier design/);
  assert.doesNotMatch(calls[2].prompt, /CEDAR-PRIVATE|CEDAR-ANSWER/);
  assert.doesNotMatch(calls[1].prompt, /ORCHID-PRIVATE|ORCHID-ANSWER/);
  assert.equal(calls[0].project, await realpath(orchid.project));
  assert.equal(calls[1].project, await realpath(cedar.project));
  const orchidSaved = snapshot.chats.find(chat => chat.id === orchidId);
  const cedarSaved = snapshot.chats.find(chat => chat.id === cedarId);
  assert.equal(orchidSaved.messages.filter(message => message.role === 'user').length, 2);
  assert.equal(cedarSaved.messages.filter(message => message.role === 'user').length, 1);
  assert.deepEqual(orchidSaved.runIds, [first.id, followup.id]);
  assert.deepEqual(cedarSaved.runIds, [second.id]);
  assert.equal(snapshot.jobs.find(job => job.id === followup.id).chatId, orchidId);
  assert.doesNotMatch(JSON.stringify(cedarSaved.messages), /ORCHID/);
  assert.deepEqual(await app.state(), await app.state(), 'reading or selecting chats must not mutate their history');
});

test('chat history, answers, title, and project survive a server restart', async t => {
  const paths = await fixture(t);
  const app = await setup(t, { ask: async () => answered('PERSISTED-ANSWER') }, paths);
  const chatId = await app.chat({ title: 'Original name' });
  const { id } = await app.send(chatId, 'PERSISTED-QUESTION');
  await app.finish(id);
  assert.equal((await app.request(`/api/chats/${chatId}/rename`, { title: 'My real project' })).status, 200);
  const before = (await app.state()).chats.find(chat => chat.id === chatId);
  await app.close();
  const saved = JSON.parse(await readFile(path.join(paths.dataDir, 'conversations.json'), 'utf8'));
  assert.equal(saved.version, 1);
  const nextCalls = [];
  const restarted = await setup(t, { ask: async options => { nextCalls.push(options); return answered('Second answer'); } }, paths);
  const restored = (await restarted.state()).chats.find(chat => chat.id === chatId);
  assert.deepEqual(restored, before);
  assert.equal(restored.title, 'My real project');
  const next = await restarted.send(chatId, 'What was my previous question?');
  await restarted.finish(next.id);
  assert.match(nextCalls[0].prompt, /PERSISTED-QUESTION/);
  assert.match(nextCalls[0].prompt, /PERSISTED-ANSWER/);
});

test('retrying the same message ID returns the same job and does not duplicate a turn', async t => {
  let calls = 0;
  const app = await setup(t, { ask: async () => { calls++; return answered('A single answer'); } });
  const chatId = await app.chat();
  const clientMessageId = randomUUID();
  const first = await app.send(chatId, 'Send this just once', { clientMessageId });
  await app.finish(first.id);
  const retry = await app.send(chatId, 'Send this just once', { clientMessageId });
  assert.equal(retry.id, first.id);
  assert.equal(calls, 1);
  const chat = (await app.state()).chats.find(chat => chat.id === chatId);
  assert.equal(chat.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(chat.messages.filter(message => message.role === 'assistant').length, 1);
  assert.deepEqual(chat.runIds, [first.id]);
});

test('conflicting-project requests cannot append phantom messages and cancellation stays in its chat', async t => {
  const app = await setup(t, { run: options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Cancelled by user')), { once: true });
  }) });
  const firstChat = await app.chat({ title: 'Active project' });
  const firstProject = (await app.state()).chats.find(chat => chat.id === firstChat).project;
  const otherChat = await app.chat({ title: 'Another chat for the same project', project: firstProject });
  const clientMessageId = randomUUID();
  const { id } = await app.send(firstChat, 'Build this project', { mode: 'build', clientMessageId });
  const retried = await app.send(firstChat, 'Build this project', { mode: 'build', clientMessageId });
  assert.equal(retried.id, id, 'reconnecting during an active turn must not launch it twice');
  assert.equal((await app.request(`/api/chats/${otherChat}/messages`, { text: 'Do not lose me', mode: 'build', rounds: 1 })).status, 409);
  let state = await app.state();
  const waiting = state.chats.find(chat => chat.id === otherChat);
  assert.deepEqual(waiting.messages, []);
  assert.deepEqual(waiting.runIds, []);
  assert.equal((await app.request(`/api/runs/${id}/stop`, {})).status, 200);
  const { job, snapshot } = await app.finish(id);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.chatId, firstChat);
  const active = snapshot.chats.find(chat => chat.id === firstChat);
  assert.equal(active.messages.filter(message => message.role === 'user').length, 1);
  assert.ok(active.messages.some(message => message.role === 'assistant' && /cancel|stop/i.test(message.text)));
  assert.deepEqual(snapshot.chats.find(chat => chat.id === otherChat).messages, []);
});

test('invalid messages do not create project folders or enter conversation history', async t => {
  const app = await setup(t);
  const chatId = await app.chat();
  const chat = (await app.state()).chats.find(chat => chat.id === chatId);
  await assert.rejects(stat(chat.project), { code: 'ENOENT' });
  for (const input of [
    { text: '', mode: 'build', rounds: 1 },
    { text: 'Build something', mode: 'unknown', rounds: 1 },
    { text: 'Build something', mode: 'build', rounds: 0 },
    { text: 'Build something', mode: 'build', rounds: 11 },
    { text: 'x'.repeat(40_001), mode: 'build', rounds: 1 },
  ]) {
    assert.equal((await app.request(`/api/chats/${chatId}/messages`, input)).status, 400);
  }
  const after = await app.state();
  assert.deepEqual(after.chats.find(chat => chat.id === chatId).messages, []);
  assert.equal(after.jobs.length, 0);
  await assert.rejects(stat(chat.project), { code: 'ENOENT' });
});

test('a failed initial save rolls back the user turn and permits retry with the same message ID', async t => {
  let calls = 0;
  const app = await setup(t, { ask: async () => { calls++; return answered('Saved successfully'); } });
  const chatId = await app.chat();
  const before = await app.state();
  const clientMessageId = randomUUID();
  const tempPath = path.join(app.dataDir, 'conversations.json.tmp');
  await mkdir(tempPath);
  try {
    const failed = await app.request(`/api/chats/${chatId}/messages`, {
      text: 'Keep this draft until it is really accepted', mode: 'ask', rounds: 1, clientMessageId,
    });
    assert.equal(failed.ok, false);
    assert.equal(calls, 0);
    const after = await app.state();
    assert.equal(after.active, null);
    assert.deepEqual(after.jobs, before.jobs);
    assert.deepEqual(after.chats, before.chats);
  } finally {
    await rm(tempPath, { recursive: true, force: true });
  }
  const retry = await app.send(chatId, 'Keep this draft until it is really accepted', { clientMessageId });
  const { snapshot } = await app.finish(retry.id);
  assert.equal(calls, 1);
  const saved = snapshot.chats.find(chat => chat.id === chatId);
  assert.equal(saved.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(saved.messages.filter(message => message.role === 'assistant').length, 1);
  assert.deepEqual(saved.runIds, [retry.id]);
});

test('a failed project-folder change preserves the previous project and chat state', async t => {
  const app = await setup(t);
  const chatId = await app.chat({ title: 'Project with a safe folder' });
  const before = await app.state();
  const filePath = path.join(app.root, 'ordinary-file.txt');
  await writeFile(filePath, 'Preserve this file');
  const failed = await app.request(`/api/chats/${chatId}/project`, {
    project: path.join(filePath, 'cannot-be-created'), createFolder: true,
  });
  assert.equal(failed.ok, false);
  const after = await app.state();
  assert.deepEqual(after.chats, before.chats);
  assert.deepEqual(after.jobs, before.jobs);
  assert.equal(await readFile(filePath, 'utf8'), 'Preserve this file');
});

test('restart marks an unfinished saved turn interrupted without duplicating messages', async t => {
  const paths = await fixture(t);
  const chatId = randomUUID(), jobId = randomUUID();
  const time = '2026-09-27T10:00:00.000Z';
  const project = path.join(paths.projectRoot, 'interrupted-project');
  const chat = { id: chatId, title: 'Interrupted chat', project, createdAt: time, updatedAt: time,
    messages: [{ id: randomUUID(), role: 'user', text: 'Remember my unfinished work', createdAt: time, mode: 'build', runId: jobId }],
    runIds: [jobId] };
  const job = { id: jobId, chatId, project, prompt: 'Remember my unfinished work', mode: 'build', status: 'working',
    startedAt: time, events: [{ label: 'claude-code-1', time }], rounds: [] };
  await writeFile(path.join(paths.dataDir, 'conversations.json'), JSON.stringify({ version: 1, chats: [chat], jobs: [job] }));
  const app = await setup(t, {}, paths);
  const recovered = await app.state();
  assert.equal(recovered.active, null);
  assert.equal(recovered.jobs[0].status, 'interrupted');
  assert.ok(recovered.jobs[0].finishedAt);
  assert.equal(recovered.chats[0].messages.length, 2);
  assert.equal(recovered.chats[0].messages[1].role, 'assistant');
  assert.match(recovered.chats[0].messages[1].text, /interrupt/i);
  assert.equal(recovered.chats[0].messages[1].runId, jobId);
  await app.close();
  const again = await setup(t, {}, paths);
  assert.deepEqual((await again.state()).chats, recovered.chats);
});

test('legacy runs migrate into distinct chats and interrupted work receives a terminal message', async t => {
  const paths = await fixture(t);
  const firstDate = '2026-09-26T10:00:00.000Z';
  const legacy = [
    { id: randomUUID(), project: path.join(paths.projectRoot, 'first'), prompt: 'LEGACY-ONE', status: 'approved', startedAt: firstDate, finishedAt: firstDate,
      events: [], rounds: built('Legacy first result').rounds },
    { id: randomUUID(), project: path.join(paths.projectRoot, 'second'), prompt: 'LEGACY-TWO', status: 'building', startedAt: firstDate, events: [], rounds: [] },
  ];
  await writeFile(path.join(paths.dataDir, 'history.json'), JSON.stringify(legacy));
  const app = await setup(t, {}, paths);
  const state = await app.state();
  assert.equal(state.chats.length, 2);
  assert.equal(state.jobs.length, 2);
  const first = state.jobs.find(job => job.id === legacy[0].id);
  const second = state.jobs.find(job => job.id === legacy[1].id);
  assert.notEqual(first.chatId, second.chatId);
  assert.equal(first.status, 'approved');
  assert.equal(second.status, 'interrupted');
  assert.ok(second.finishedAt);
  assert.equal(state.active, null);
  const secondChat = state.chats.find(chat => chat.id === second.chatId);
  assert.match(JSON.stringify(secondChat.messages), /LEGACY-TWO/);
  assert.doesNotMatch(JSON.stringify(secondChat.messages), /LEGACY-ONE/);
  assert.ok(secondChat.messages.some(message => message.role === 'assistant' && /restart|interrupt/i.test(message.text)));
  await app.close();
  const restarted = await setup(t, {}, paths);
  const reloaded = await restarted.state();
  assert.equal(reloaded.chats.length, 2, 'migration must not duplicate legacy chats on every launch');
  assert.deepEqual(reloaded.chats, state.chats);
});
