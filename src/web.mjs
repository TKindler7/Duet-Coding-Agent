import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, realpath } from 'node:fs/promises';
import { execute } from './process.mjs';
import { doctor, runDuet } from './duet.mjs';
import { askDuet, conversationPrompt, loadConversations, message, summarizeJob } from './conversations.mjs';
import { createSetupManager, systemInformation } from './setup.mjs';
import { createAuthManager } from './auth.mjs';
import { APP_VERSION } from './lifecycle.mjs';
import { coordinatorOptions } from './coordinator.mjs';
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from './checkpoints.mjs';
import { createPreviewManager } from './preview.mjs';
import { outcomeSummary } from './outcomes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = path.join(root, 'public');
const providers = new Set(['claude', 'codex']);
const fail = (text, status = 400) => Object.assign(new Error(text), { status });
const equalSecret = (supplied, expected) => {
  const actual = Buffer.from(supplied ?? ''), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};

export async function createWebApp({ dataDir = path.join(root, 'data'), run = runDuet, ask = askDuet,
  projectRoot = process.env.DUET_PROJECT_ROOT || path.join(os.homedir(), 'Documents', 'Duet Projects'),
  health = doctor, native = execute, setupManager, authManager, previewManager = createPreviewManager(), token = randomBytes(32).toString('hex'), maxConcurrentTurns = 3 } = {}) {
  if (!Number.isInteger(maxConcurrentTurns) || maxConcurrentTurns < 1 || maxConcurrentTurns > 8) throw new Error('Concurrent turns must be between 1 and 8.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const saved = await loadConversations(dataDir);
  const jobs = new Map(saved.jobs.map(job => [job.id, job]));
  const chats = new Map(saved.chats.map(chat => [chat.id, chat]));
  const historyFile = path.join(dataDir, 'conversations.json');
  for (const job of jobs.values()) {
    if (!job.finishedAt) {
      job.status = 'interrupted'; job.finishedAt = new Date().toISOString();
      job.error = 'Duet stopped before this turn finished.';
    }
    const chat = chats.get(job.chatId);
    if (chat && !chat.messages.some(m => m.runId === job.id && m.role === 'assistant')) {
      chat.messages.push(message('assistant', summarizeJob(job), { runId: job.id }));
      chat.updatedAt = job.finishedAt;
    }
  }
  let credentials = {}, refreshSequence = 0, saveQueue = Promise.resolve(), projectQueue = Promise.resolve(), closing = false;
  const system = await systemInformation(APP_VERSION);
  const setup = setupManager ?? createSetupManager({ onChange: () => refresh() });
  const auth = authManager ?? createAuthManager({ health: refresh });
  const isAuthActive = value => ['starting', 'waiting'].includes(value?.status);
  const authBusy = () => Object.values(auth.snapshot()).some(isAuthActive);
  const controllers = new Map(), pending = new Set(), preparingChats = new Set(), editingChats = new Set(), operations = new Map();
  const busyChat = id => [...operations.values()].some(operation => operation.chatId === id);
  const turnCount = () => [...operations.values()].filter(operation => operation.kind === 'turn').length;
  const projectKey = value => process.platform === 'darwin' ? value.normalize('NFC').toLowerCase() : value;
  const overlaps = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
  // Resolve the existing ancestor too, so aliases of a not-yet-created folder
  // reserve the same workspace. Project claims are serialized, not the builds.
  async function canonicalProject(project) {
    let ancestor = project;
    const missing = [];
    for (;;) {
      try { return path.join(await realpath(ancestor), ...missing); }
      catch (error) {
        if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
        missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
      }
    }
  }
  function reserve(chat, kind) {
    if (closing) throw fail('Duet is restarting. Your draft is safe; reconnect and send it again.', 503);
    if (authBusy()) throw fail('Finish or cancel account sign-in before starting work. Your draft is saved.', 409);
    if (editingChats.has(chat.id)) throw fail('This chat’s settings are being saved. Try again in a moment.', 409);
    if (busyChat(chat.id)) throw fail('This chat is already working. Wait for it to finish, or start another chat.', 409);
    if (Object.values(setup.snapshot()).some(value => value.status === 'installing')) throw fail('Wait for tool installation to finish before starting work.', 409);
    if (kind === 'turn' && turnCount() >= maxConcurrentTurns) throw fail(`All ${maxConcurrentTurns} working slots are in use. Your draft is saved; send it when one finishes.`, 409);
    const operation = { id: kind === 'turn' ? randomUUID() : `checkpoint-${randomUUID()}`, chatId: chat.id, project: chat.project, kind, phase: 'preparing' };
    operations.set(operation.id, operation);
    return operation;
  }
  async function claimProject(operation) {
    const claim = projectQueue.then(async () => {
      if (closing) throw fail('Duet is restarting. Please try again when it reconnects.', 503);
      const canonical = await canonicalProject(operation.project), key = projectKey(canonical);
      if ([...operations.values()].some(other => other.id !== operation.id && other.projectKey && overlaps(key, other.projectKey))) {
        throw fail('This project folder is already in use by another chat. Wait for that work to finish, or choose a separate project folder.', 409);
      }
      operation.projectKey = key;
      return canonical;
    });
    projectQueue = claim.catch(() => {});
    return claim;
  }
  async function trackOperation(work) {
    const operation = Promise.resolve().then(work); pending.add(operation);
    try { return await operation; } finally { pending.delete(operation); }
  }
  const snapshot = () => structuredClone({ credentials, setup: setup.snapshot(), auth: auth.snapshot(), system,
    // Keep the scalar for older clients and installers: non-null means busy.
    active: operations.keys().next().value ?? (authBusy() ? 'account-sign-in' : null),
    activeOperations: [...operations.values()].map(({ projectKey: _key, ...operation }) => operation),
    concurrency: { limit: maxConcurrentTurns, running: turnCount() }, defaultProjectRoot: projectRoot,
    outcomes: outcomeSummary([...jobs.values()]),
    chats: [...chats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    jobs: [...jobs.values()].reverse() });
  function save() {
    const contents = JSON.stringify({ version: 1, chats: [...chats.values()], jobs: [...jobs.values()] });
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await writeFile(historyFile + '.tmp', contents, { mode: 0o600 });
      await rename(historyFile + '.tmp', historyFile);
    });
    saveQueue.catch(error => console.error('Could not save chats:', error.message));
    return saveQueue;
  }
  await save();
  async function refresh(options = {}) {
    const sequence = ++refreshSequence;
    const result = await health(options);
    // A slower, older account check must not undo a newer sign-in result.
    if (sequence === refreshSequence) credentials = result;
    return result;
  }
  const refreshing = refresh().catch(error => console.error(error.message));
  async function body(req) {
    let result = '';
    for await (const chunk of req) {
      result += chunk;
      if (Buffer.byteLength(result) > 64_000) throw fail('The request is too large.', 413);
    }
    let value;
    try { value = JSON.parse(result || '{}'); } catch { throw fail('Invalid JSON request.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Expected a JSON object.');
    return value;
  }
  function validateProject(project) {
    if (typeof project !== 'string' || !path.isAbsolute(project) || project.includes('\0')) throw fail('Choose a folder or enter its full path.');
    return path.normalize(project);
  }
  function newChat(input = {}) {
    const id = randomUUID(), now = new Date().toISOString();
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.trim().length > 100)) throw fail('Use a chat title of up to 100 characters.');
    const chat = { id, title: input.title?.trim() || 'New chat',
      project: input.project ? validateProject(input.project) : path.join(projectRoot, `project-${id.slice(0, 8)}`),
      createdAt: now, updatedAt: now, messages: [], runIds: [] };
    chats.set(id, chat); return chat;
  }
  function validateTurn(input) {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 40_000) throw fail('Enter a message of up to 40,000 characters.');
    const mode = input.mode ?? 'build', rounds = input.rounds ?? 3;
    if (!['build', 'ask'].includes(mode)) throw fail('Choose Build or Ask mode.');
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw fail('Choose between 1 and 10 rounds.');
    if (input.clientMessageId !== undefined && (typeof input.clientMessageId !== 'string' || !/^[\w-]{1,128}$/.test(input.clientMessageId))) throw fail('Invalid message identifier.');
    const routing = coordinatorOptions({ optimization: input.optimization, maxCalls: input.maxCalls, tokenLimit: input.tokenLimit });
    return { text: input.text.trim(), mode, rounds, ...routing, clientMessageId: input.clientMessageId };
  }
  async function startTurn(chat, input) {
    const { text, mode, rounds, clientMessageId, ...routing } = validateTurn(input);
    const duplicate = clientMessageId && chat.messages.find(m => m.role === 'user' && m.clientMessageId === clientMessageId);
    if (duplicate) {
      if (operations.get(duplicate.runId)?.phase === 'preparing') throw fail('This message is still being saved. Try again in a moment.', 409);
      if (duplicate.text !== text || duplicate.mode !== mode) throw fail('This message identifier was already used for different content.', 409);
      if (duplicate.routing && JSON.stringify(duplicate.routing) !== JSON.stringify(routing)) throw fail('This message identifier was already used with different coordinator settings.', 409);
      return { id: duplicate.runId, chatId: chat.id };
    }
    const operation = reserve(chat, 'turn'), id = operation.id;
    const controller = new AbortController(); controllers.set(id, controller);
    preparingChats.add(chat.id);
    const previousChat = structuredClone(chat);
    try {
      await claimProject(operation);
      controller.signal.throwIfAborted();
      const connections = await refresh({ signal: controller.signal });
      const required = mode === 'build' ? ['claude', 'codex'] : ['claude'];
      const missing = required.filter(name => !connections[name]?.ready);
      if (missing.length) throw fail(`Sign in to ${missing.join(' and ')} first.`);
      if (closing) throw fail('Duet is restarting. Please send again after it reconnects.', 503);
      controller.signal.throwIfAborted();
      await mkdir(chat.project, { recursive: true });
      if (!(await stat(chat.project)).isDirectory()) throw fail('The project path must be a folder.');
      const executionProject = await claimProject(operation);
      controller.signal.throwIfAborted();
      const prompt = conversationPrompt(chat.messages, text, chat.decisions);
      const job = { id, chatId: chat.id, project: chat.project, prompt: text, mode, status: 'starting',
        startedAt: new Date().toISOString(), events: [], rounds: [] };
      jobs.set(id, job);
      chat.messages.push(message('user', text, { mode, routing, runId: id, ...(clientMessageId ? { clientMessageId } : {}) }));
      chat.routing = routing;
      chat.runIds.push(id);
      if (chat.title === 'New chat') chat.title = text.replace(/\s+/g, ' ').slice(0, 64);
      chat.updatedAt = job.startedAt;
      await save();
      controller.signal.throwIfAborted();
      preparingChats.delete(chat.id);
      operation.phase = 'running';
      const mergeResult = result => {
        // Helper context and IDs may not replace the UI's actual message or chat ownership.
        const { prompt: _prompt, project: _project, id: _id, chatId: _chatId, mode: _mode, ...progress } = result;
        Object.assign(job, progress);
      };
      const task = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return (mode === 'ask' ? ask : run)({ project: executionProject, prompt,
          maxRounds: rounds, ...routing, signal: controller.signal,
          onProgress: label => { job.step = label; job.status = mode === 'ask' ? 'answering' : 'working'; job.events.push({ label, time: new Date().toISOString() }); save(); },
          onState: state => { mergeResult(state); save(); },
        });
      }).then(mergeResult)
        .catch(error => { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; })
        .finally(async () => {
          job.finishedAt = new Date().toISOString();
          chat.messages.push(message('assistant', summarizeJob(job), { runId: id, mode }));
          chat.updatedAt = job.finishedAt;
          operations.delete(id);
          controllers.delete(id);
          await save();
        });
      pending.add(task);
      task.catch(error => console.error('Could not finalize turn:', error.message)).finally(() => pending.delete(task));
      return { id, chatId: chat.id };
    } catch (error) {
      preparingChats.delete(chat.id);
      operations.delete(id);
      jobs.delete(id);
      Object.assign(chat, previousChat);
      if (!Object.hasOwn(previousChat, 'routing')) delete chat.routing;
      controllers.delete(id);
      await save();
      throw error;
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src http://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const host = `127.0.0.1:${server.address().port}`;
      const origin = `http://${host}`;
      if (req.headers.host !== host) return reply(403, { error: 'Invalid local host.' });
      if (req.headers.origin && req.headers.origin !== origin) return reply(403, { error: 'Cross-origin access denied.' });
      const url = new URL(req.url, origin);
      // A browser opening this personal, loopback-only app gets its own local
      // session. The provider accounts and their credentials remain in the CLIs.
      const sessionName = `duet_session_${server.address().port}`;
      const sessionValue = createHmac('sha256', token).update(`duet-browser-session:v1:${origin}`).digest('hex');
      if (req.method === 'GET' && url.pathname === '/api/ping') return reply(200, { app: 'duet', version: APP_VERSION });
      if (url.pathname.startsWith('/api/')) {
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        const cookie = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${sessionName}=`))?.slice(sessionName.length + 1);
        const site = req.headers['sec-fetch-site'];
        const sameOriginRequest = req.headers['x-duet-request'] === '1'
          && (!site || site === 'same-origin')
          && (req.headers.origin === origin || site === 'same-origin');
        const cookieAuth = sameOriginRequest && equalSecret(cookie, sessionValue);
        if (!equalSecret(bearer, token) && !cookieAuth) return reply(401, { error: 'Reload Duet to reconnect this browser.' });
        if (['POST', 'PATCH'].includes(req.method) && req.headers['content-type'] !== 'application/json') return reply(415, { error: 'JSON content required.' });
        if (req.method === 'GET' && url.pathname === '/api/state') { await refreshing; return reply(200, snapshot()); }
        if (req.method === 'POST' && url.pathname === '/api/refresh') return reply(200, await refresh());
        if (req.method === 'POST' && url.pathname === '/api/setup/install') {
          const { agent } = await body(req);
          if (!providers.has(agent)) throw fail('Unknown assistant.');
          if (closing || operations.size || authBusy()) throw fail('Finish running work and account sign-in before installing coding tools.', 409);
          return reply(202, setup.install(agent));
        }
        if (req.method === 'POST' && url.pathname === '/api/folder') {
          const result = await native('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a project for Duet")'], { timeoutMs: 120_000 });
          if (result.code !== 0) return reply(200, { cancelled: true });
          return reply(200, { path: result.stdout.trim().replace(/\/$/, '') || '/' });
        }
        if (req.method === 'POST' && ['/api/login', '/api/login/cancel', '/api/login/code'].includes(url.pathname)) {
          const input = await body(req), { agent } = input;
          if (!providers.has(agent)) throw fail('Unknown assistant.');
          if (url.pathname === '/api/login/cancel') return reply(200, await auth.cancel(agent));
          if (closing) throw fail('Duet is restarting. Reconnect to continue signing in.', 503);
          if (url.pathname === '/api/login/code') return reply(200, await auth.submitCode(agent, input.code));
          if (operations.size || Object.values(setup.snapshot()).some(item => item.status === 'installing')) throw fail('Finish running work and tool installation before signing in.', 409);
          if (authBusy() && !isAuthActive(auth.snapshot()[agent])) throw fail('Finish or cancel the other account’s sign-in first.', 409);
          // Existing official tool sessions remain usable without signing in again.
          if (!isAuthActive(auth.snapshot()[agent]) && credentials[agent]?.ready) return reply(202, { status: 'connected' });
          return reply(202, await auth.start(agent));
        }
        if (req.method === 'POST' && url.pathname === '/api/chats') {
          const chat = newChat(await body(req));
          try { await save(); } catch (error) { chats.delete(chat.id); throw error; }
          return reply(201, { id: chat.id });
        }
        const decisionsRoute = url.pathname.match(/^\/api\/chats\/([\w-]+)$/);
        if (req.method === 'PATCH' && decisionsRoute) {
          const chat = chats.get(decisionsRoute[1]);
          if (!chat) throw fail('Chat not found.', 404);
          const input = await body(req);
          if (busyChat(chat.id) || editingChats.has(chat.id)) throw fail('Finish this turn or settings update before updating project decisions.', 409);
          if (Object.keys(input).some(key => key !== 'decisions') || typeof input.decisions !== 'string' || input.decisions.length > 6000) throw fail('Use project notes of up to 6,000 characters.');
          const previous = { decisions: chat.decisions, updatedAt: chat.updatedAt };
          editingChats.add(chat.id);
          chat.decisions = input.decisions.trim(); chat.updatedAt = new Date().toISOString();
          try { await save(); } catch (error) { Object.assign(chat, previous); throw error; }
          finally { editingChats.delete(chat.id); }
          return reply(200, chat);
        }
        const previewRoute = url.pathname.match(/^\/api\/chats\/([\w-]+)\/preview(?:\/(stop))?$/);
        if (previewRoute && ['GET', 'POST'].includes(req.method)) {
          const chat = chats.get(previewRoute[1]); if (!chat) throw fail('Chat not found.', 404);
          if (req.method === 'GET' && !previewRoute[2]) return reply(200, previewManager.status(chat.id));
          if (closing) throw fail('Duet is restarting. Try again when it reconnects.', 503);
          if (req.method === 'POST') return reply(200, previewRoute[2] ? await previewManager.stop(chat.id)
            : await previewManager.start(chat.id, chat.project, { appOrigin: origin, builtAfter: chat.restoredAt }));
        }
        const checkpointRoute = url.pathname.match(/^\/api\/chats\/([\w-]+)\/checkpoints(?:\/([\w-]+)\/(restore))?$/);
        if (checkpointRoute && ['GET', 'POST'].includes(req.method)) {
          const chat = chats.get(checkpointRoute[1]); if (!chat) throw fail('Chat not found.', 404);
          if (req.method === 'GET' && !checkpointRoute[2]) return reply(200, { checkpoints: await listCheckpoints(chat.project) });
          if (req.method === 'POST') {
            return await trackOperation(async () => {
              const operation = reserve(chat, 'checkpoint');
              try {
                await claimProject(operation);
                operation.phase = 'running';
                await previewManager.stop(chat.id);
                if (checkpointRoute[2]) {
                  const result = await restoreCheckpoint(chat.project, checkpointRoute[2]);
                  chat.messages.push(message('assistant', 'Restored the selected project checkpoint. Your previous files were saved as a recovery checkpoint. Earlier build results describe the versions tested then; send a new request to check this version.', { checkpointRestore: true }));
                  chat.updatedAt = new Date().toISOString(); chat.restoredAt = chat.updatedAt;
                  try { await save(); } catch { return reply(200, {...result,warning:'Project files were restored and the recovery checkpoint is saved, but the chat update could not be saved. Do not repeat the restore; check your disk space.'}); }
                  return reply(200, result);
                }
                const checkpoint = await createCheckpoint(chat.project, {label:'Saved by you'});
                return reply(201, {checkpoint});
              } finally { operations.delete(operation.id); }
            });
          }
        }
        const feedbackRoute = url.pathname.match(/^\/api\/runs\/([\w-]+)\/feedback$/);
        if (req.method === 'POST' && feedbackRoute) {
          const job = jobs.get(feedbackRoute[1]); if (!job) throw fail('Build not found.',404);
          if (!job.finishedAt || job.mode === 'ask') throw fail('Finish a build before recording its outcome.',409);
          if (chats.get(job.chatId)?.restoredAt > job.finishedAt) throw fail('This project was restored after that build. Run a new check before recording its outcome.',409);
          const input = await body(req);
          if (!['works','needs_fixes'].includes(input.outcome) || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000))) throw fail('Choose whether the app works, with an optional note up to 2,000 characters.');
          const previous = job.feedback;
          job.feedback = { outcome: input.outcome, note: input.note?.trim() || '', recordedAt:new Date().toISOString(), source:'user' };
          try { await save(); } catch(error) {job.feedback=previous;throw error;}
          return reply(200, {feedback:job.feedback, outcomes:outcomeSummary([...jobs.values()])});
        }
        const chatRoute = url.pathname.match(/^\/api\/chats\/([\w-]+)\/(messages|rename|project)$/);
        if (req.method === 'POST' && chatRoute) {
          const chat = chats.get(chatRoute[1]);
          if (!chat) return reply(404, { error: 'Chat not found.' });
          const input = await body(req);
          if (chatRoute[2] === 'messages') return reply(202, await trackOperation(() => startTurn(chat, input)));
          if (preparingChats.has(chat.id) || editingChats.has(chat.id)) throw fail('This chat is starting or saving. Try updating it again in a moment.', 409);
          editingChats.add(chat.id);
          try {
            const previous = { title: chat.title, project: chat.project, updatedAt: chat.updatedAt };
            if (chatRoute[2] === 'rename') {
              if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 100) throw fail('Enter a title of 1–100 characters.');
              chat.title = input.title.trim();
            } else {
              if (busyChat(chat.id) || [...jobs.values()].some(job => job.chatId === chat.id && !job.finishedAt)) throw fail('Wait for this chat’s turn to finish before changing its folder.', 409);
              if (chat.messages.length) throw fail('This chat already has a project. Start a new chat to work in a different folder.', 409);
              const candidate = validateProject(input.project);
              if (input.createFolder === true) await mkdir(candidate, { recursive: true });
              if (busyChat(chat.id) || chat.messages.length) throw fail('This chat has started a turn. Start a new chat to use a different folder.', 409);
              await previewManager.stop(chat.id);
              if (busyChat(chat.id) || chat.messages.length) throw fail('This chat has started a turn. Start a new chat to use a different folder.', 409);
              chat.project = candidate;
            }
            chat.updatedAt = new Date().toISOString();
            try { await save(); } catch (error) { Object.assign(chat, previous); throw error; }
            return reply(200, chat);
          } finally { editingChats.delete(chat.id); }
        }
        // Backwards-compatible entry point: each old single-prompt build becomes its own chat.
        if (req.method === 'POST' && url.pathname === '/api/runs') {
          const input = await body(req);
          const turn = { text: input.prompt, mode: 'build', rounds: input.rounds,
            optimization: input.optimization, maxCalls: input.maxCalls, tokenLimit: input.tokenLimit };
          validateTurn(turn); validateProject(input.project);
          const chat = newChat({ project: input.project });
          try { return reply(202, await trackOperation(() => startTurn(chat, turn))); }
          catch (error) { if (!chat.messages.length) chats.delete(chat.id); throw error; }
        }
        const stop = url.pathname.match(/^\/api\/runs\/([\w-]+)\/stop$/);
        if (req.method === 'POST' && stop) {
          const controller = controllers.get(stop[1]);
          if (!controller) return reply(409, { error: 'This turn is no longer running.' });
          controller.abort(); return reply(200, { stopping: true });
        }
        return reply(404, { error: 'Not found.' });
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method !== 'GET' || !files[url.pathname]) return reply(404, { error: 'Not found.' });
      const [file, type] = files[url.pathname];
      if (url.pathname === '/' && req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'document') {
        return reply(403, { error: 'Open Duet directly in a browser tab.' });
      }
      const content = await readFile(path.join(publicDir, file));
      if (url.pathname === '/') res.setHeader('Set-Cookie', `${sessionName}=${sessionValue}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content);
    } catch (error) { if (!res.headersSent) reply(error.status ?? 400, { error: error.message }); else res.end(); }
  });
  return { server, token, snapshot, async close() {
    closing = true;
    for (const controller of controllers.values()) controller.abort();
    await auth.close();
    await setup.close();
    await previewManager.close();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...pending]);
    await saveQueue;
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { startServer } = await import('./lifecycle.mjs');
  await startServer({ createWebApp, root, open: process.argv.includes('--open') });
}
