(() => {
'use strict';
const $ = id => document.getElementById(id);
const storage = {
  get(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* The current draft remains in memory. */ } }
};
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const draftStoreKey = 'duet-chat-drafts-v2';
const selectedStoreKey = 'duet-selected-chat-v2';
let drafts = parse(storage.get(draftStoreKey, '{}'), {});
if (!drafts || Array.isArray(drafts) || typeof drafts !== 'object') drafts = {};
let selected = storage.get(selectedStoreKey) || `draft-${uid()}`;
let state = null, online = false, polling = false;
const submissions = new Map(), stoppingRuns = new Set();
const uncertainMessages = new Map();
let messageKey = '', historyKey = '', activityKey = '', settingsChat = null, renamingChat = null;
let authFailure = false, rechecking = false, savingSettings = false;
const projectViews = new Map();
let resultKey = '', resultChat = '', restoringCheckpoint = null;
function projectView(id = selected) {
  if (!projectViews.has(id)) projectViews.set(id, { preview: { status: 'stopped' }, checkpoints: [], loaded: false, refreshing: false, busy: '', error: '', previewError: '', lastRefresh: 0 });
  return projectViews.get(id);
}
const accountRequests = new Map();
const accountMessages = new Map();
let token = location.hash.slice(1);
if (!token) { try { token = sessionStorage.getItem('duet-token') || ''; } catch { /* optional */ } }
if (!token) token = storage.get('duet-token', '');
if (token) {
  storage.set('duet-token', token);
  try { sessionStorage.setItem('duet-token', token); } catch { /* optional */ }
}
if (location.hash && location.protocol !== 'file:') history.replaceState(null, '', location.pathname + location.search);

function persist() { storage.set(draftStoreKey, JSON.stringify(drafts)); storage.set(selectedStoreKey, selected); }
function draftFor(id = selected) {
  if (!drafts[id] || typeof drafts[id] !== 'object') drafts[id] = { text: '', mode: 'build', rounds: 3, createdAt: new Date().toISOString() };
  const d = drafts[id];
  if (typeof d.text !== 'string') d.text = '';
  const savedRouting = chatFor(id)?.routing;
  if (!['quality', 'balanced', 'economy'].includes(d.optimization)) d.optimization = savedRouting?.optimization || 'quality';
  if (d.maxCalls === undefined && savedRouting) d.maxCalls = savedRouting.maxCalls;
  if (d.tokenLimit === undefined) d.tokenLimit = savedRouting?.tokenLimit || 0;
  if (!['ask', 'build'].includes(d.mode)) d.mode = 'build';
  if (![1, 3, 5, 10].includes(Number(d.rounds))) d.rounds = 3;
  return d;
}
function chatFor(id = selected) { return state?.chats?.find(chat => chat.id === id); }
function activeOperations() {
  // Older Duet servers expose only one active id. Keep those installations usable during updates.
  const operations = Array.isArray(state?.activeOperations) ? [...state.activeOperations] : state?.active ? (() => {
    const job = state.jobs?.find(item => item.id === state.active);
    return [{ id: state.active, chatId: job?.chatId, project: job?.project, kind: job ? 'turn' : 'checkpoint', phase: 'running' }];
  })() : [];
  for (const [chatId, submission] of submissions) {
    if (!operations.some(operation => operation.chatId === chatId)) operations.push({ id: submission.runId || '', chatId, project: submission.project, kind: 'turn', phase: 'preparing', pending: true });
  }
  for (const [chatId, view] of projectViews) {
    if (['checkpoint', 'restore'].includes(view.busy) && !operations.some(operation => operation.chatId === chatId)) operations.push({ id: '', chatId, project: projectFor(chatId), kind: 'checkpoint', phase: 'preparing', pending: true });
  }
  return operations;
}
function operationForChat(id = selected) { return activeOperations().find(operation => operation.chatId === id); }
function isRunActive(id) { return Boolean(id && activeOperations().some(operation => operation.id === id)); }
function concurrencyLimit() { return Number.isInteger(state?.concurrency?.limit) && state.concurrency.limit > 0 ? state.concurrency.limit : Array.isArray(state?.activeOperations) ? 3 : 1; }
function runningTurns() { return activeOperations().filter(operation => operation.kind === 'turn'); }
function normalizedProject(value) {
  if (!value) return '';
  const parts = [];
  for (const part of value.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }
  return `${value.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}
function projectsOverlap(a, b) {
  a = normalizedProject(a); b = normalizedProject(b);
  return Boolean(a && b && (a === b || a === '/' || b === '/' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}
function busyOperation(id = selected) {
  const project = projectFor(id);
  return activeOperations().find(operation => operation.chatId === id || projectsOverlap(operation.project, project) || (!operation.chatId && !Array.isArray(state?.activeOperations)));
}
function projectBusy(id = selected) {
  return Boolean(busyOperation(id) || [...projectViews].some(([chatId, view]) => view.busy && view.busy !== 'feedback' && (chatId === id || projectsOverlap(projectFor(chatId), projectFor(id)))));
}
function toolsInstalling() { return Object.values(state?.setup || {}).some(setup => setup.status === 'installing') || [...accountRequests.values()].includes('install'); }
function authBusy() { return Object.values(state?.auth || {}).some(auth => ['starting', 'waiting'].includes(auth.status)) || [...accountRequests.values()].some(action => ['login', 'code', 'cancel'].includes(action)); }
function accountSetupBusy() { return toolsInstalling() || authBusy(); }
function jobForChat(id = selected) {
  const jobs = (state?.jobs || []).filter(job => job.chatId === id);
  return jobs.find(job => isRunActive(job.id)) || jobs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0];
}
function buildForChat(id = selected) { return (state?.jobs || []).filter(job => job.chatId === id && job.mode !== 'ask').sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0]; }
function activeJob(id = selected) { const operation = operationForChat(id); return state?.jobs?.find(job => job.id === operation?.id); }
function projectFor(id = selected) { return draftFor(id).project ?? chatFor(id)?.project ?? ''; }
function chatTitle(id = selected) { return chatFor(id)?.title || draftFor(id).title || (draftFor(id).text.trim() ? draftFor(id).text.trim().slice(0, 60) : 'New chat'); }
function leaf(path) { return typeof path === 'string' ? path.split('/').filter(Boolean).at(-1) || path : ''; }
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function notice(text) { $('notice-text').textContent = text; $('notice').hidden = !text; }
function settingsError(text) { $('settings-error').textContent = text; $('settings-error').hidden = !text; }
function formatTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function isNearBottom() { const el = $('conversation-scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 140; }
function scrollBottom(force = false) { if (force || isNearBottom()) requestAnimationFrame(() => { $('conversation-scroll').scrollTop = $('conversation-scroll').scrollHeight; }); }
function resizePrompt() { const el = $('prompt'); el.style.height = 'auto'; el.style.height = `${Math.min(Math.max(el.scrollHeight, 66), innerWidth < 761 ? 170 : 220)}px`; }
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-scrim').hidden = true; $('open-sidebar').setAttribute('aria-expanded', 'false'); }

async function api(route, body, method) {
  const controller = new AbortController();
  const checkpointWrite = body !== undefined && /^chats\/[\w-]+\/checkpoints(?:\/[\w-]+\/restore)?$/.test(route);
  const timeoutMs = route === 'folder' ? 180000 : checkpointWrite ? 120000 : route === 'state' || route === 'refresh' ? 60000 : /^chats\/[\w-]+\/messages$/.test(route) ? 90000 : 20000;
  let deadlineExpired = false;
  const timer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`/api/${route}`, {
      method: method || (body === undefined ? 'GET' : 'POST'), signal: controller.signal, credentials: 'same-origin',
      headers: { 'X-Duet-Request': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let result;
    try { result = await response.json(); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw Object.assign(new Error('Duet returned an unreadable response. Checking whether your request was received…'), { uncertain: body !== undefined });
    }
    if (!response.ok) {
      const error = new Error(result.error || 'Duet could not complete that request.');
      error.status = response.status;
      if (response.status === 401 || response.status === 403) { authFailure = true; online = false; renderConnection(); }
      throw error;
    }
    return result;
  } catch (error) {
    if (deadlineExpired || error.name === 'AbortError') {
      // One slow request does not mean the background app or its other chats disconnected.
      throw Object.assign(new Error('Duet is taking longer to confirm this request. Your work may still be running; your draft is saved.'), { timeout: true, uncertain: body !== undefined });
    }
    if (error instanceof TypeError) {
      online = false; renderConnection(); renderComposer();
      const connectionError = new Error('Duet lost its connection. Your chat and draft are saved. Reconnect and try again.');
      connectionError.connection = true;
      connectionError.uncertain = body !== undefined;
      throw connectionError;
    }
    throw error;
  } finally { clearTimeout(timer); }
}

function safeSignInUrl(agent, value) {
  try {
    const url = new URL(value);
    const allowed = agent === 'claude' ? ['https://claude.com/cai/oauth/authorize', 'https://claude.ai/oauth/authorize'] : ['https://auth.openai.com/oauth/authorize'];
    return !url.username && !url.password && allowed.includes(`${url.origin}${url.pathname}`) ? url.href : null;
  } catch { return null; }
}
function accountView(agent) {
  const credential = state?.credentials?.[agent] || {}, setup = state?.setup?.[agent] || {}, auth = state?.auth?.[agent] || {};
  const tool = agent === 'claude' ? 'Claude Code' : 'Codex', provider = agent === 'claude' ? 'Claude' : 'ChatGPT';
  const ready = Boolean(credential.ready);
  const installed = ready || credential.installed === true || setup.status === 'installed' ? true : credential.installed === false ? false : null;
  const installing = setup.status === 'installing', request = accountRequests.get(agent);
  const waiting = ['starting', 'waiting'].includes(auth.status);
  const cancelling = waiting && (auth.cancelling === true || request === 'cancel');
  const url = waiting && !ready && !cancelling ? safeSignInUrl(agent, auth.url) : null;
  const connectedLabel = agent === 'codex'
    ? credential.authMethod === 'chatgpt' ? 'Using your ChatGPT account through Codex' : 'Connected through Codex'
    : credential.authMethod === 'claude' ? 'Using your Claude account through Claude Code' : 'Connected through Claude Code';
  const workspaceBusy = activeOperations().length > 0 || [...projectViews.values()].some(view => Boolean(view.busy));
  let detail = !online ? 'Waiting for Duet' : ready ? connectedLabel : installed ? `Sign in with your own ${provider} account in your browser.` : installed === false ? `${tool} is not installed on this Mac.` : 'Checking this Mac…';
  if (!ready && auth.status === 'cancelled') detail = 'Sign-in cancelled. You can try again whenever you’re ready.';
  if (installing) detail = `Installing ${tool}… This may take a few minutes.`;
  if (waiting) detail = ready ? 'Your account is connected. Finishing sign-in…' : url ? `Finish signing in on ${provider}’s website. Duet will connect automatically.` : 'Preparing your secure sign-in page…';
  if (request === 'login') detail = 'Starting secure sign-in in your browser…';
  if (request === 'install') detail = `Starting the ${tool} installer…`;
  if (request === 'code') detail = 'Completing sign-in…';
  if (cancelling) detail = 'Cancelling sign-in…';
  const action = installed === false ? 'install' : installed ? 'login' : 'recheck';
  if (!ready && !installing && !waiting && !request && workspaceBusy) detail = 'Finish the running chats before changing account setup.';
  else if (!ready && !installing && !waiting && !request && accountSetupBusy()) detail = 'Finish or cancel the other account setup first.';
  const label = installing ? 'Installing…' : request ? 'Please wait…' : waiting ? 'Signing in…' : action === 'install' ? `${setup.status === 'failed' ? 'Retry: install' : 'Install'} ${tool}` : action === 'login' ? auth.status === 'failed' ? 'Try sign-in again' : `Connect ${provider}` : 'Check connection';
  const error = !ready && auth.status === 'failed' ? auth.error || 'Sign-in did not finish. Please try again.' : setup.status === 'failed' ? setup.error || `${tool} could not be installed. Try again or share feedback.` : '';
  return { ready, installed, installing, waiting, cancelling, url, acceptsCode: waiting && !ready && !cancelling && agent === 'claude' && auth.acceptsCode === true, action, label, detail,
    disabled: !online || installing || waiting || Boolean(request) || rechecking || workspaceBusy || accountSetupBusy(), error };
}
function renderConnection() {
  $('offline-banner').hidden = online;
  $('server-dot').classList.toggle('offline', !online);
  $('server-status').textContent = online ? 'Running on your Mac' : 'Reconnecting…';
  $('offline-title').textContent = authFailure ? 'Reconnect your workspace' : 'Duet is reconnecting';
  $('offline-text').textContent = authFailure ? ' Reconnect to this Mac’s Duet workspace. Your conversations and draft are saved; no Duet login is needed.' : ' Your draft is saved. Open the Duet launcher if the local server has stopped.';
  $('retry-connection').textContent = authFailure ? 'Reconnect' : 'Retry';
  let readyCount = 0;
  for (const agent of ['claude', 'codex']) {
    const view = accountView(agent);
    if (view.ready) { readyCount++; if (!view.waiting) accountMessages.delete(agent); }
    for (const id of [`${agent}-connection`, `${agent}-setup-status`]) { $(id).textContent = view.detail; $(id).classList.toggle('ready', view.ready); }
    for (const id of [`${agent}-login`, `${agent}-setup-action`]) { $(id).textContent = view.label; $(id).hidden = view.ready || view.waiting; $(id).disabled = view.disabled; }
    for (const id of [`${agent}-account-error`, `${agent}-setup-error`]) { $(id).textContent = view.error; $(id).hidden = !view.error; }
    for (const surface of ['setup', 'account']) {
      const prefix = `${agent}-${surface}`, link = $(`${prefix}-continue`), cancel = $(`${prefix}-cancel`);
      $(`${prefix}-signin`).hidden = !view.waiting;
      link.hidden = !view.url || !online;
      if (view.url && online) link.href = view.url; else link.removeAttribute('href');
      cancel.disabled = !online || view.cancelling || Boolean(accountRequests.get(agent));
      cancel.textContent = view.cancelling ? 'Cancelling…' : 'Cancel sign-in';
      const codeForm = $(`${prefix}-code-form`);
      if (codeForm) {
        codeForm.hidden = !view.acceptsCode;
        const input = $(`${prefix}-code`);
        input.disabled = !online || Boolean(accountRequests.get(agent));
        $(`${prefix}-submit-code`).disabled = input.disabled;
        if (!view.acceptsCode) input.value = '';
      }
    }
  }
  const ready = readyCount === 2 && !authBusy();
  $('team-status').textContent = !online ? 'Waiting for connection' : ready ? 'Both connected' : authBusy() ? 'Finishing sign-in' : 'Finish setting up Duet';
  $('onboarding-card').hidden = !state || ready;
  $('setup-banner').hidden = !state || ready || !online;
  $('welcome-suggestions').hidden = Boolean(state) && !ready;
  $('first-build-guide').hidden = !state || !ready;
  $('welcome').classList.toggle('needs-setup', Boolean(state) && !ready);
  $('setup-count').textContent = `${readyCount} of 2 connected`;
  $('setup-banner-text').textContent = `${readyCount} of 2 accounts connected. Finish setup here in your browser.`;
  for (const id of ['recheck', 'setup-recheck']) { $(id).disabled = !online || rechecking; $(id).textContent = rechecking ? 'Checking…' : 'Refresh connection'; }
  const messages = [...accountMessages.values()].filter(Boolean).join(' ');
  $('account-action-note').textContent = messages;
  $('setup-progress-note').textContent = messages || 'Sign in on each provider’s website. Duet detects the connection automatically. Your password stays with the provider.';
  if (typeof state?.system?.version === 'string') $('beta-version').textContent = `Beta ${state.system.version}`;
}
async function recheckAccounts() {
  if (!online || rechecking) return;
  rechecking = true; settingsError(''); renderConnection();
  try { await api('refresh', {}); await poll(true); }
  catch (error) { settingsError(error.message); notice(error.message); }
  finally { rechecking = false; renderConnection(); }
}
function updateAuth(agent, result) {
  if (state && result && ['starting', 'waiting', 'connected', 'failed', 'cancelled'].includes(result.status)) state.auth = { ...state.auth, [agent]: result };
}
async function accountAction(agent) {
  const view = accountView(agent);
  if (view.ready || view.disabled) return;
  if (view.action === 'recheck') { await recheckAccounts(); return; }
  accountRequests.set(agent, view.action); accountMessages.delete(agent); renderConnection(); renderComposer();
  try {
    if (view.action === 'install') await api('setup/install', { agent });
    else updateAuth(agent, await api('login', { agent }));
    await poll(true);
  } catch (error) { accountMessages.set(agent, error.message); }
  finally { accountRequests.delete(agent); renderConnection(); renderComposer(); }
}
function clearSignInCode(agent) {
  for (const surface of ['setup', 'account']) { const input = $(`${agent}-${surface}-code`); if (input) input.value = ''; }
}
async function cancelSignIn(agent) {
  const view = accountView(agent);
  if (!online || accountRequests.has(agent) || !view.waiting || view.cancelling) return;
  clearSignInCode(agent); accountRequests.set(agent, 'cancel'); accountMessages.delete(agent); renderConnection(); renderComposer();
  try { updateAuth(agent, await api('login/cancel', { agent })); await poll(true); }
  catch (error) { accountMessages.set(agent, error.message); }
  finally { accountRequests.delete(agent); renderConnection(); renderComposer(); }
}
async function submitSignInCode(agent, surface, event) {
  event.preventDefault();
  if (!online || accountRequests.has(agent) || !accountView(agent).acceptsCode) return;
  const code = $(`${agent}-${surface}-code`).value.trim();
  if (!code) return;
  clearSignInCode(agent); accountRequests.set(agent, 'code'); accountMessages.delete(agent); renderConnection(); renderComposer();
  try { updateAuth(agent, await api('login/code', { agent, code })); await poll(true); }
  catch (error) { accountMessages.set(agent, error.message); }
  finally { accountRequests.delete(agent); renderConnection(); renderComposer(); }
}
function feedbackDiagnostics() {
  const system = state?.system || {};
  const value = key => typeof system[key] === 'string' || typeof system[key] === 'number' ? String(system[key]) : 'Not available';
  const lines = [`Duet version: ${value('version')}`, `Platform: ${value('platform')}`, `Architecture: ${value('architecture')}`, `macOS: ${value('macOS')}`];
  for (const agent of ['claude', 'codex']) {
    const credential = state?.credentials?.[agent];
    const installed = typeof credential?.installed === 'boolean' ? credential.installed ? 'yes' : 'no' : credential?.ready ? 'yes' : 'unknown';
    const ready = typeof credential?.ready === 'boolean' ? credential.ready ? 'yes' : 'no' : 'unknown';
    lines.push(`${agent === 'claude' ? 'Claude Code' : 'Codex'} installed: ${installed}; connected: ${ready}`);
  }
  return lines.join('\n');
}
function openFeedback() {
  closeSidebar(); $('feedback-diagnostics').textContent = feedbackDiagnostics();
  $('feedback-status').textContent = ''; $('feedback-fallback').hidden = true;
  $('feedback-dialog').showModal(); $('feedback-installation').focus();
}
async function copyFeedback() {
  const text = [
    'Duet Mac beta feedback',
    `Installation: ${$('feedback-installation').value}`,
    `Build result: ${$('feedback-build').value}`,
    '', 'What happened / steps to reproduce:', $('feedback-notes').value.trim() || '[Add your notes here]',
    '', 'Screenshot (optional): [attach when sending, if helpful]', '', 'Basic app information:', feedbackDiagnostics()
  ].join('\n');
  $('copy-feedback').disabled = true;
  try { await navigator.clipboard.writeText(text); $('feedback-status').textContent = 'Copied. Paste it into a message to the person who shared Duet with you. Nothing was sent.'; }
  catch { $('feedback-fallback').value = text; $('feedback-fallback').hidden = false; $('feedback-fallback').focus(); $('feedback-fallback').select(); $('feedback-status').textContent = 'Clipboard access is unavailable. Copy the selected text above and send it yourself.'; }
  finally { $('copy-feedback').disabled = false; }
}
function renderHistory() {
  const count = runningTurns().length, limit = concurrencyLimit();
  $('running-count').hidden = !count;
  $('running-count').textContent = `${count} ${count === 1 ? 'chat' : 'chats'} running`;
  $('running-count').title = `Up to ${limit} chats can work at once in separate projects.`;
  const localDrafts = Object.entries(drafts).filter(([id, draft]) => id.startsWith('draft-') && (draft.text?.trim() || draft.title || id === selected)).map(([id, draft]) => ({ id, title: chatTitle(id), updatedAt: draft.createdAt, draft: true }));
  const chats = [...(state?.chats || []), ...localDrafts];
  chats.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  const key = JSON.stringify(chats.map(chat => [chat.id, chat.title, chat.updatedAt, draftFor(chat.id).text.length, operationForChat(chat.id), activeJob(chat.id)?.step])) + selected + [...stoppingRuns].join(',');
  if (historyKey === key) return;
  historyKey = key; $('history').replaceChildren();
  if (!chats.length) $('history').append(node('p', 'history-empty', 'A little space for your next idea.'));
  for (const chat of chats) {
    const row = node('div', `history-item${chat.id === selected ? ' selected' : ''}`);
    const button = node('button', 'chat-select'); button.type = 'button';
    if (chat.id === selected) button.setAttribute('aria-current', 'page');
    const name = node('span', 'chat-name', chat.title || 'New chat'); button.title = chat.title || 'New chat';
    const meta = node('span', 'chat-meta');
    const operation = operationForChat(chat.id), job = activeJob(chat.id);
    if (operation) {
      const label = stoppingRuns.has(operation.id) ? 'Stopping…' : operation.kind === 'checkpoint' ? 'Saving project…' : operation.phase === 'preparing' ? 'Getting started…' : job?.mode === 'ask' ? 'Thinking…' : 'Building…';
      meta.append(node('span', 'chat-running-dot'), document.createTextNode(label));
      meta.title = job ? runLabel(job) : label;
    }
    else meta.textContent = draftFor(chat.id).text ? 'Draft saved' : chat.draft ? 'Start a conversation' : formatDate(chat.updatedAt || chat.createdAt);
    button.append(name, meta); button.onclick = () => selectChat(chat.id);
    const rename = node('button', 'chat-rename', '···'); rename.type = 'button'; rename.title = 'Rename conversation'; rename.setAttribute('aria-label', `Rename ${chat.title || 'conversation'}`);
    rename.onclick = () => openRename(chat.id);
    row.append(button, rename); $('history').append(row);
  }
}

function inlineMarkdown(container, value) {
  // Text nodes and allowlisted links only: model output is never interpreted as HTML.
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > start) container.append(document.createTextNode(value.slice(start, match.index)));
    const token = match[0];
    if (token.startsWith('`')) container.append(node('code', '', token.slice(1, -1)));
    else if (token.startsWith('**')) container.append(node('strong', '', token.slice(2, -2)));
    else {
      const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      const a = node('a', '', parts[1]); a.href = parts[2]; a.target = '_blank'; a.rel = 'noopener noreferrer'; container.append(a);
    }
    start = match.index + token.length;
  }
  if (start < value.length) container.append(document.createTextNode(value.slice(start)));
}
function markdown(container, text) {
  const lines = String(text || '').split('\n');
  let paragraph = [], list = null;
  function flush() { if (paragraph.length) { const p = node('p'); inlineMarkdown(p, paragraph.join('\n')); container.append(p); paragraph = []; } list = null; }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      flush(); const language = line.trim().slice(3).trim(); const content = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith('```')) content.push(lines[i]);
      const block = node('div', 'code-block'), top = node('div', 'code-top'), copy = node('button', '', 'Copy'); copy.type = 'button';
      copy.onclick = async () => { try { await navigator.clipboard.writeText(content.join('\n')); copy.textContent = 'Copied'; } catch { notice('Clipboard unavailable. You can select and copy the code directly.'); } };
      top.append(node('span', '', language || 'code'), copy);
      const pre = node('pre'), code = node('code', '', content.join('\n')); pre.append(code); block.append(top, pre); container.append(block); continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { flush(); const h = node(`h${Math.min(heading[1].length + 1, 4)}`); inlineMarkdown(h, heading[2]); container.append(h); continue; }
    const bullet = line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);
    if (bullet) {
      if (paragraph.length) flush(); const tag = bullet[1] ? 'UL' : 'OL';
      if (!list || list.tagName !== tag) { list = node(tag.toLowerCase()); container.append(list); }
      const li = node('li'); inlineMarkdown(li, bullet[2]); list.append(li); continue;
    }
    if (!line.trim()) { flush(); continue; }
    list = null; paragraph.push(line);
  }
  flush();
}
function mark() { const wrapper = node('span', 'duet-mark'); wrapper.setAttribute('aria-hidden', 'true'); wrapper.append(node('i'), node('i')); return wrapper; }
function renderMessages() {
  const chat = chatFor(), messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const job = jobForChat();
  const empty = !messages.length && !job;
  $('welcome').hidden = !empty; $('conversation').hidden = empty;
  const key = JSON.stringify(messages) + selected;
  if (messageKey === key) return;
  const nearBottom = isNearBottom(); messageKey = key; $('messages').replaceChildren();
  for (const message of messages) {
    const user = message.role === 'user';
    const article = node('article', `message ${user ? 'message-user' : 'message-assistant'}`);
    article.setAttribute('aria-label', user ? 'You' : 'Duet');
    const body = node('div', 'message-body');
    if (user) {
      body.textContent = message.text || '';
      article.append(body, node('div', 'message-caption', `${message.mode === 'ask' ? 'Ask' : 'Build'}${message.createdAt ? ` · ${formatTime(message.createdAt)}` : ''}`));
    } else {
      const avatar = node('div', 'message-avatar'); avatar.append(mark());
      const content = node('div', 'assistant-content'), heading = node('div', 'message-heading', 'Duet');
      heading.append(node('span', '', message.mode === 'ask' ? 'Thinking with you' : 'Claude + Codex'));
      markdown(body, message.text); content.append(heading, body); article.append(avatar, content);
    }
    $('messages').append(article);
  }
  if (nearBottom) scrollBottom(true);
}
function friendly(label = '') {
  if (/verif|local-check/.test(label)) return 'Duet is checking the project on your Mac';
  if (label === 'claude-plan') return 'Claude is putting the plan together';
  if (/ask|chat|answer/.test(label)) return 'Claude is thinking through your question';
  const round = label.match(/-(\d+)$/)?.[1];
  const suffix = round ? ` · round ${round}` : '';
  if (label.startsWith('claude-code')) return `Claude is writing code${suffix}`;
  if (label.startsWith('codex-build')) return `Codex is building and testing${suffix}`;
  if (label.startsWith('claude-review')) return `Claude is reviewing the changes${suffix}`;
  return label.replaceAll('-', ' ') || 'Your team is getting started';
}
function activityLabel(job, now = Date.now()) {
  const activity = job?.activity;
  if (!activity || !isRunActive(job.id)) return '';
  const timestamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  const duration = value => {
    const seconds = Math.floor(Math.max(0, value) / 1000), minutes = Math.floor(seconds / 60);
    return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  };
  const started = timestamp(activity.startedAt), last = timestamp(activity.lastActivityAt);
  const reportedElapsed = Number.isFinite(activity.elapsedMs) ? Math.max(0, activity.elapsedMs) : 0;
  const elapsed = Math.max(reportedElapsed, Number.isFinite(started) ? now - started : 0);
  const sinceActivity = Number.isFinite(last) ? Math.max(0, now - last) : null;
  const agent = activity.agent === 'claude' ? 'Claude' : activity.agent === 'codex' ? 'Codex' : 'your assistant';
  const status = sinceActivity !== null && sinceActivity < 30000 ? `${agent} is still working` : `Waiting for ${agent}`;
  return `${status} · ${duration(elapsed)} elapsed · ${sinceActivity === null ? 'waiting for first activity' : `last activity ${duration(sinceActivity)} ago`}`;
}
function runLabel(job) {
  if (job.recovery?.kind === 'timeout') return 'Paused · send a message to continue';
  if (isRunActive(job.id)) return activityLabel(job) || friendly(job.events?.at(-1)?.label || job.step || (job.mode === 'ask' ? 'claude-ask' : ''));
  if (job.status === 'answered') return 'Response complete';
  if (job.feedback?.outcome === 'works') return 'Works for you · feedback saved';
  if (job.status === 'needs_attention' && job.verification?.status === 'incomplete') return 'Ready for your check';
  if (job.status === 'interrupted') return 'Interrupted · send a message to continue';
  if (['approved', 'completed', 'complete'].includes(job.status)) return job.mode === 'ask' ? 'Response complete' : 'Build reviewed · try it in preview';
  if (['stopped', 'cancelled'].includes(job.status)) return 'Stopped · send a message to continue';
  if (job.error || job.status === 'failed') return 'Your team needs attention';
  return String(job.status || 'Saved activity').replaceAll('_', ' ');
}
function renderActivity() {
  const jobs = (state?.jobs || []).filter(job => job.chatId === selected).sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  const ticking = jobs.some(job => job.activity && isRunActive(job.id)) ? Math.floor(Date.now() / 2000) : '';
  const key = JSON.stringify([jobs, operationForChat()]) + selected + ticking;
  if (activityKey === key) return;
  const nearBottom = isNearBottom(); activityKey = key;
  const opened = new Set([...$('activity').querySelectorAll('details[open]')].map(detail => detail.dataset.key));
  $('activity').replaceChildren();
  // Keep the conversation readable: past turns keep their full replies, while the latest run exposes its implementation details.
  const job = jobs.at(-1); if (!job) return;
  const running = isRunActive(job.id);
  const details = node('details', `activity-card${running ? ' running' : ''}`); details.dataset.key = job.id; details.open = opened.has(job.id);
  const summary = node('summary'); summary.append(node('span', 'activity-dot'), node('span', '', runLabel(job)));
  const contents = node('div', 'activity-details');
  contents.append(node('p', 'activity-description', job.mode === 'ask' ? 'Discussing this conversation and its project. No files are changed in Ask mode.' : 'The coordinator selects a model for each step, adapts the workflow, and keeps independent review before completion.'));
  const coordination = job.coordinator;
  if (coordination) {
    const panel = node('section', 'coordinator-summary');
    panel.append(node('h3', '', `${coordination.label} coordinator`));
    const used = coordination.calls?.length || 0;
    const usageLabel = coordination.callsWithUsage ? `${Number(coordination.reportedTokens || 0).toLocaleString()} reported tokens` : 'Token usage not reported';
    panel.append(node('p', '', `${used} of ${coordination.maxCalls} agent steps · ${usageLabel}`));
    panel.append(node('p', 'field-help', `Usage reported for ${coordination.callsWithUsage || 0} of ${used} steps. Tokens are not a credit balance or bill. Each step may contain multiple model requests.`));
    if (coordination.assessment) panel.append(node('p', '', coordination.assessment.reason));
    if (coordination.stopReason) panel.append(node('p', 'run-error', coordination.stopReason));
    const choices = node('ol', 'routing-decisions');
    for (const call of coordination.calls || []) {
      const item = node('li'), model = call.model || 'Provider default';
      item.append(node('strong', '', `${call.agent === 'claude' ? 'Claude' : 'Codex'} · ${model}${call.effort ? ` · ${call.effort}` : ''}`));
      item.append(node('span', '', `${friendly(call.stage)} · ${call.status}`), node('p', '', call.reason));
      if (call.usage) item.append(node('small', '', `${call.usage.total.toLocaleString()} reported tokens${call.usage.actualModels?.length ? ' · Used: ' + call.usage.actualModels.join(', ') : ' · Model shown is requested, not independently verified'}`));
      choices.append(item);
    }
    panel.append(choices);
    for (const decision of coordination.decisions || []) panel.append(node('p', 'routing-note', decision.reason));
    contents.append(panel);
  }
  const timeline = node('ol', 'timeline');
  for (const [index, event] of (job.events || []).entries()) {
    const item = node('li', running && index === job.events.length - 1 ? 'current' : '');
    item.append(node('span', '', friendly(event.label)), node('time', '', formatTime(event.time))); timeline.append(item);
  }
  contents.append(timeline);
  if (job.error) contents.append(node('div', 'run-error', job.error));
  function handoff(title, value) {
    if (!value) return;
    const detail = node('details', 'handoff'); detail.dataset.key = `${job.id}-${title}`; detail.open = opened.has(detail.dataset.key);
    detail.append(node('summary', '', title), node('pre', '', typeof value === 'string' ? value : JSON.stringify(value, null, 2))); contents.append(detail);
  }
  handoff('The shared plan', job.plan);
  for (const round of Array.isArray(job.rounds) ? job.rounds : []) {
    handoff(`Round ${round.round} · Claude’s changes`, round.claudeBuild);
    if (round.build) handoff(`Round ${round.round} · Codex’s changes and checks`, [round.build.summary, (round.build.checks || []).join('\n'), round.build.run_instructions].filter(Boolean).join('\n\n'));
    if (round.review) handoff(`Round ${round.round} · Review`, [round.review.summary, (round.review.findings || []).join('\n')].filter(Boolean).join('\n\n'));
  }
  handoff('Project and saved records', [job.project, job.runDir ? `Run records: ${job.runDir}` : ''].filter(Boolean).join('\n\n'));
  details.append(summary, contents); $('activity').append(details);
  if (job.recovery?.kind === 'timeout' || (job.error && !(job.status === 'needs_attention' && job.verification?.status === 'incomplete'))) details.open = true;
  if (nearBottom) scrollBottom(true);
}
async function syncProjectDecisions(id) {
  const draft = draftFor(id), chat = chatFor(id);
  if (draft.decisions === undefined || draft.decisions === (chat?.decisions || '')) return;
  await api(`chats/${id}`, { decisions: draft.decisions }, 'PATCH');
  if (chat) chat.decisions = draft.decisions;
  delete draft.decisions; persist();
}
function safePreviewUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin !== location.origin && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
async function refreshProjectView(id = selected) {
  if (!online || id.startsWith('draft-') || !chatFor(id)?.project) return;
  const view = projectView(id);
  if (view.refreshing || view.busy) return;
  view.refreshing = true;
  try {
    const results = await Promise.allSettled([api(`chats/${id}/preview`), api(`chats/${id}/checkpoints`)]);
    if (results[0].status === 'fulfilled') { view.preview = results[0].value; view.previewError = ''; }
    else view.previewError = results[0].reason.message;
    if (results[1].status === 'fulfilled') { view.checkpoints = results[1].value.checkpoints || []; view.error = ''; }
    else view.error = results[1].reason.message;
    view.loaded = true; view.lastRefresh = Date.now();
  } finally { view.refreshing = false; if (id === selected) renderProjectResult(); }
}
function verificationLabel(status) {
  return ({ passed: 'Check passed', reported_pass: 'Reported by an assistant', failed: 'Needs a fix', fail: 'Needs a fix', not_tested: 'Not tested', not_run: 'Not run', pending: 'Waiting for a check', running: 'Checking now', cancelled: 'Stopped before completion' })[status] || 'Not tested';
}
function evidenceText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join('\n');
  return '';
}
function renderProjectResult() {
  const chat = chatFor(), job = buildForChat() || jobForChat(), view = projectView();
  const visible = Boolean(chat?.project && (job || chat.messages?.length));
  $('project-result').hidden = !visible;
  if (!visible) {
    if ($('project-preview').hasAttribute('src')) $('project-preview').removeAttribute('src');
    resultChat = ''; return;
  }
  if (resultChat !== selected) { $('project-preview').removeAttribute('src'); resultChat = selected; }
  const running = Boolean(job && isRunActive(job.id)), projectWorking = projectBusy(), blocked = !online || projectWorking || Boolean(view.busy);
  const buildJob = job?.mode !== 'ask';
  const checksAreStale = Boolean(chat?.restoredAt && job && new Date(chat.restoredAt).getTime() > new Date(job.finishedAt || job.startedAt || 0).getTime());
  const timedOut = job?.recovery?.kind === 'timeout';
  const key = JSON.stringify([selected, job?.id, job?.status, job?.verification, job?.feedback, job?.checkpoint, job?.recovery, job?.error, checksAreStale, running, online, projectWorking, view]);
  if (resultKey === key) return;
  resultKey = key;
  $('result-status').textContent = timedOut ? 'Needs attention' : running ? job?.mode === 'ask' ? 'Thinking' : job?.status === 'verifying' ? 'Checking' : 'Building' : checksAreStale ? 'Restored version' : job?.verification?.status === 'failed' ? 'Checks need attention' : job?.feedback?.outcome === 'works' ? 'Works for you' : job?.verification?.status === 'incomplete' ? 'Ready for your check' : ['failed', 'interrupted', 'stopped', 'cancelled', 'needs_attention'].includes(job?.status) ? 'Needs attention' : buildJob ? 'Ready for you to try' : 'Your workspace';
  $('result-status').className = `result-badge${timedOut ? ' needs-attention' : running ? ' working' : job?.verification?.status === 'failed' ? ' needs-attention' : ''}`;
  $('result-description').textContent = timedOut ? job.error || 'This step paused after a timeout. Send a message to continue from the current work.' : checksAreStale ? 'This project was restored after the checks below. They describe an earlier version. Ask Duet to check this restored version before relying on them.' : running ? 'Duet is working through this request. You can review the plan and model choices below.' : job?.verification?.summary || 'Try the app yourself, review the evidence, and tell Duet what to improve next.';
  const url = view.preview.status === 'running' ? safePreviewUrl(view.preview.url) : null;
  $('start-preview').disabled = blocked;
  $('start-preview').textContent = view.busy === 'preview' ? 'Opening preview…' : url ? 'Reload preview' : 'Open app preview';
  $('open-preview').hidden = !url;
  if (url) $('open-preview').href = url; else $('open-preview').removeAttribute('href');
  $('stop-preview').hidden = !url; $('stop-preview').disabled = blocked;
  $('preview-surface').hidden = !url;
  if (url && $('project-preview').getAttribute('src') !== url) $('project-preview').src = url;
  else if (!url && $('project-preview').hasAttribute('src')) $('project-preview').removeAttribute('src');
  $('preview-status').textContent = view.previewError || (view.busy === 'preview' ? 'Opening the project’s built pages on this Mac…' : projectWorking ? 'Duet is working in this project. Preview controls will be ready when it finishes.' : url ? 'Local app preview. Use “Open in a new tab” for a larger view. This preview is not a test result.' : view.preview.status === 'failed' ? view.preview.error || 'The preview stopped. Try opening it again.' : 'Opens the project’s built or static pages on this Mac. If a build is needed, Duet will explain the next step.');
  const criteria = Array.isArray(job?.verification?.criteria) ? job.verification.criteria : [];
  $('requirements-section').hidden = !buildJob || !criteria.length;
  $('requirements-title').textContent = checksAreStale ? 'Checks for an earlier version' : 'What should work';
  $('requirements-list').replaceChildren();
  for (const criterion of criteria) {
    const item = node('li', `criterion criterion-${['passed', 'reported_pass', 'failed'].includes(criterion.status) ? criterion.status : 'not_tested'}`);
    const heading = node('div', 'criterion-heading');
    heading.append(node('span', 'criterion-status', verificationLabel(criterion.status)), node('strong', '', criterion.text || 'Requirement'));
    item.append(heading);
    const evidence = evidenceText(criterion.evidence);
    if (evidence) item.append(node('p', 'criterion-evidence', evidence));
    if (criterion.source) item.append(node('small', 'criterion-source', `Source: ${criterion.source === 'model' ? 'Assistant report' : criterion.source === 'local' ? 'Local project check' : criterion.source === 'none' ? 'No verification yet' : evidenceText(criterion.source) || 'Assistant report'}`));
    $('requirements-list').append(item);
  }
  const checks = Array.isArray(job?.verification?.checks) ? job.verification.checks : [];
  $('project-checks').hidden = !checks.length; $('checks-list').replaceChildren();
  for (const check of checks) {
    const item = node('details', 'check-evidence');
    item.append(node('summary', '', `${verificationLabel(check.status)} · ${check.name || 'Project check'}`));
    if (check.command) item.append(node('code', 'check-command', evidenceText(check.command)));
    item.append(node('pre', '', evidenceText(check.output) || evidenceText(check.evidence) || 'No captured output.'));
    $('checks-list').append(item);
  }
  $('result-feedback').hidden = !job || job.mode === 'ask' || running || !job.finishedAt;
  const outcome = typeof job?.feedback === 'string' ? job.feedback : job?.feedback?.outcome;
  $('outcome-status').textContent = checksAreStale ? 'This project was restored. Build or check the current version before recording a result.' : view.busy === 'feedback' ? 'Saving your result…' : outcome === 'works' ? 'Saved: this result worked for you. Kept on this Mac.' : outcome === 'needs_fixes' ? 'Saved: this result needs fixes. Describe the problem in your next message.' : 'Your answer stays on this Mac and helps compare future builds.';
  for (const [id, value] of [['outcome-works', 'works'], ['outcome-fixes', 'needs_fixes']]) { $(id).disabled = !online || Boolean(view.busy) || checksAreStale; $(id).setAttribute('aria-pressed', String(outcome === value)); }
  $('save-checkpoint').disabled = blocked; $('refresh-checkpoints').disabled = !online || view.refreshing || Boolean(view.busy);
  $('save-checkpoint').textContent = view.busy === 'checkpoint' ? 'Saving…' : 'Save a checkpoint';
  $('checkpoint-count').textContent = view.checkpoints.length ? String(view.checkpoints.length) : '';
  $('checkpoint-status').textContent = view.error || (view.busy === 'restore' ? 'Saving a safety backup and restoring your files…' : view.busy === 'checkpoint' ? 'Saving this version…' : projectWorking ? 'Save or restore a version after work in this project finishes.' : !view.loaded || view.refreshing ? 'Checking saved versions…' : !view.checkpoints.length ? 'Your first build saves a checkpoint before changing files. You can also save one here.' : 'Checkpoints cover project source files. Dependencies, secrets, and generated folders are excluded.');
  $('checkpoints-list').replaceChildren();
  for (const checkpoint of [...view.checkpoints].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))) {
    const item = node('li'), copy = node('div');
    copy.append(node('strong', '', checkpoint.label || checkpoint.reason || 'Saved version'), node('span', '', `${formatDate(checkpoint.createdAt)} · ${formatTime(checkpoint.createdAt)}`));
    const restore = node('button', 'secondary-button', 'Restore…'); restore.type = 'button'; restore.disabled = blocked;
    restore.setAttribute('aria-label', `Restore ${checkpoint.label || checkpoint.reason || 'checkpoint'} from ${formatDate(checkpoint.createdAt)} ${formatTime(checkpoint.createdAt)}`);
    restore.onclick = () => openRestore(checkpoint, selected);
    item.append(copy, restore); $('checkpoints-list').append(item);
  }
  const jobKey = `${job?.id}:${job?.status}`;
  if (view.jobKey !== jobKey) { view.jobKey = jobKey; if (!running) refreshProjectView(selected); }
}
async function openProjectPreview() {
  const id = selected, view = projectView(id);
  if (view.busy || !online || projectBusy(id)) return;
  view.busy = 'preview'; view.previewError = ''; renderProjectState(id);
  try {
    view.preview = await api(`chats/${id}/preview`, {});
    if (view.preview.status === 'running' && !safePreviewUrl(view.preview.url)) throw new Error('Duet returned an unexpected preview address. The preview was not opened.');
    if (id === selected) $('project-preview').removeAttribute('src');
  } catch (error) { view.previewError = error.message; }
  finally { view.busy = ''; renderProjectState(id); }
}
async function stopProjectPreview() {
  const id = selected, view = projectView(id);
  if (view.busy || !online || projectBusy(id)) return;
  view.busy = 'preview-stop'; renderProjectState(id);
  try { await api(`chats/${id}/preview/stop`, {}); view.preview = { status: 'stopped' }; view.previewError = ''; }
  catch (error) { view.previewError = error.message; }
  finally { view.busy = ''; renderProjectState(id); }
}
async function saveCheckpoint() {
  const id = selected, view = projectView(id);
  if (!online || view.busy || projectBusy(id)) return;
  view.busy = 'checkpoint'; view.error = ''; renderProjectState(id);
  try { await api(`chats/${id}/checkpoints`, {}); }
  catch (error) { view.error = error.message; }
  finally { view.busy = ''; if (!view.error) await refreshProjectView(id); renderProjectState(id); }
}
function renderProjectState(id) {
  if (id === selected) renderProjectResult();
  renderHistory(); renderComposer(); renderConnection();
}
function openRestore(checkpoint, chatId) {
  if (!online || projectBusy(chatId)) return;
  restoringCheckpoint = { checkpoint, chatId };
  $('restore-description').textContent = `Return to “${checkpoint.label || checkpoint.reason || 'Saved version'}” from ${formatDate(checkpoint.createdAt)} at ${formatTime(checkpoint.createdAt)}?`;
  $('restore-error').hidden = true; $('restore-dialog').showModal(); $('keep-current').focus();
}
async function restoreCheckpoint(event) {
  event.preventDefault();
  const target = restoringCheckpoint; if (!target || !online) return;
  if (projectBusy(target.chatId)) { $('restore-error').textContent = 'Wait for work in this project to finish before restoring.'; $('restore-error').hidden = false; return; }
  const view = projectView(target.chatId);
  $('confirm-restore').disabled = true; $('keep-current').disabled = true; $('cancel-restore').disabled = true;
  view.busy = 'restore'; view.error = ''; renderProjectState(target.chatId);
  try {
    if (view.preview.status === 'running') { await api(`chats/${target.chatId}/preview/stop`, {}); view.preview = { status: 'stopped' }; }
    const result = await api(`chats/${target.chatId}/checkpoints/${target.checkpoint.id}/restore`, {});
    $('restore-dialog').close(); restoringCheckpoint = null;
    notice(result.warning || 'Checkpoint restored. Your previous files are saved in a safety backup. Built apps may need a fresh build before preview.');
  } catch (error) { $('restore-error').textContent = error.message; $('restore-error').hidden = false; }
  finally {
    view.busy = ''; $('confirm-restore').disabled = false; $('keep-current').disabled = false; $('cancel-restore').disabled = false;
    await refreshProjectView(target.chatId); renderProjectState(target.chatId);
  }
}
async function recordOutcome(outcome) {
  const id = selected, job = buildForChat(id), view = projectView(id);
  if (!job || !job.finishedAt || isRunActive(job.id) || !online || view.busy || (chatFor(id)?.restoredAt && new Date(chatFor(id).restoredAt) > new Date(job.finishedAt || job.startedAt || 0))) return;
  view.busy = 'feedback'; renderProjectResult();
  try {
    await api(`runs/${job.id}/feedback`, { outcome });
    job.feedback = { outcome }; await poll();
    if (outcome === 'needs_fixes' && selected === id) { $('prompt').focus(); notice('Tell Duet what happened and what you expected. Your feedback has been saved on this Mac.'); }
  } catch (error) { notice(error.message); }
  finally { view.busy = ''; if (id === selected) renderProjectResult(); }
}

function renderBuildResults() {
  const outcomes = state?.outcomes;
  const rows = Array.isArray(outcomes?.modes) ? outcomes.modes : [];
  const labels = { quality: 'Best quality', balanced: 'Balanced', economy: 'Save usage' };
  $('results-summary').replaceChildren();
  const total = rows.reduce((sum, row) => sum + (Number(row.builds) || 0), 0);
  if (!total) {
    $('results-summary').append(node('p', 'results-empty', 'Your first build starts the record. Try the result and leave feedback to see it here.'));
  } else {
    for (const row of rows) {
      const card = node('section', 'mode-result');
      card.append(node('h3', '', labels[row.mode] || row.mode));
      const list = node('dl', 'result-metrics');
      for (const [label, value] of [['Build attempts', row.builds], ['Works for you', row.works], ['Needs fixes', row.needsFixes], ['Awaiting your feedback', Math.max(0, (row.builds || 0) - (row.feedbackCount || 0))]]) {
        const pair = node('div'); pair.append(node('dt', '', label), node('dd', '', String(value || 0))); list.append(pair);
      }
      card.append(list);
      if (row.builds) {
        const details = node('details', 'observed-usage'); details.append(node('summary', '', 'Usage recorded for this mode'));
        details.append(node('p', '', `${Number(row.steps || 0).toLocaleString()} agent steps across these builds.`));
        details.append(node('p', '', row.buildsWithUsage ? `${Number(row.reportedTokens || 0).toLocaleString()} reported tokens from ${row.buildsWithUsage} of ${row.builds} builds. Reports can be incomplete; tokens are not a credit balance.` : 'Token usage was not reported. This does not mean the builds used no credits.'));
        card.append(details);
      }
      $('results-summary').append(card);
    }
  }
  $('results-note').textContent = outcomes?.note || 'These results stay on this Mac. Different tasks are not a fair comparison between models, and incomplete usage reports cannot establish credit savings.';
}
function openBuildResults() { closeSidebar(); renderBuildResults(); $('results-dialog').showModal(); $('close-results').focus(); }
function renderComposer() {
  const draft = draftFor();
  const mode = draft.mode;
  const submitting = submissions.has(selected), operation = operationForChat(), job = activeJob();
  const selectedRunning = operation?.kind === 'turn', running = runningTurns().length;
  const blockedProject = busyOperation(), atCapacity = running >= concurrencyLimit(), installing = accountSetupBusy();
  const stopping = Boolean(operation?.id && stoppingRuns.has(operation.id));
  $('optimization').value = draft.optimization;
  $('optimization').disabled = submitting;
  $('mode-build').setAttribute('aria-pressed', String(mode === 'build'));
  $('mode-ask').setAttribute('aria-pressed', String(mode === 'ask'));
  $('prompt').placeholder = chatFor()?.messages?.length ? mode === 'ask' ? 'Ask a question or talk through what’s next…' : 'What would you like to change or build next?' : mode === 'ask' ? 'Ask anything about your idea or project…' : 'Describe what you’d like to build…';
  const credentials = state?.credentials || {};
  const ready = mode === 'ask' ? Boolean(credentials.claude?.ready) : ['claude', 'codex'].every(agent => credentials[agent]?.ready);
  $('send').disabled = !online || projectBusy() || atCapacity || installing || !ready || submitting || !draft.text.trim();
  $('send').hidden = selectedRunning;
  $('stop').hidden = !selectedRunning;
  $('stop').disabled = stopping || !online || !operation?.id;
  $('stop').lastChild.textContent = stopping ? ' Stopping…' : !operation?.id ? ' Starting…' : ' Stop';
  $('composer-footnote').textContent = mode === 'ask' ? 'Think it through with Claude. Switch to Build when you’re ready to make changes.' : 'Your coordinator chooses models and checks the work. Projects stay on your Mac.';
  const status = $('composer-status'); status.replaceChildren(); status.classList.toggle('working', selectedRunning);
  if (!online) status.textContent = 'Your draft is saved on this browser while Duet reconnects.';
  else if (submitting) status.textContent = 'Sending your message…';
  else if (selectedRunning) status.textContent = stopping ? 'Stopping this chat. Your other chats will keep working.' : job ? runLabel(job) : 'Getting this chat ready…';
  else if (blockedProject || projectBusy()) {
    status.append(document.createTextNode('Work in this project is still running. Your draft is saved. '));
    if (blockedProject?.chatId && blockedProject.chatId !== selected) { const open = node('button', '', 'View chat'); open.type = 'button'; open.onclick = () => selectChat(blockedProject.chatId); status.append(open); }
  } else if (installing) status.textContent = 'Wait for account setup to finish. Your draft is saved.';
  else if (!ready) {
    status.append(document.createTextNode(mode === 'ask' ? 'Connect Claude to start chatting. ' : 'Connect both coding partners to build. '));
    const connect = node('button', '', 'Connect accounts'); connect.type = 'button'; connect.onclick = () => openSettings('team'); status.append(connect);
  } else if (atCapacity) status.textContent = `${running} ${running === 1 ? 'chat is' : 'chats are'} running. Send this draft when one finishes.`;
  else if (running) status.textContent = `${running} ${running === 1 ? 'other chat is' : 'other chats are'} running. You can start this one in a separate project.`;
  status.hidden = !status.childNodes.length;
  const project = projectFor();
  $('project-label').textContent = project ? leaf(project) : 'Project settings';
  $('open-project').title = project || 'Choose this chat’s project';
  $('composer-project-label').textContent = project ? leaf(project) : 'New project';
  $('composer-project').title = project || 'A new folder will be created for this conversation';
  renderSettingsAvailability();
}
function render() {
  if (state && !selected.startsWith('draft-') && !chatFor()) { selected = `draft-${uid()}`; persist(); $('prompt').value = draftFor().text; resizePrompt(); }
  $('chat-title').textContent = chatTitle();
  $('chat-tag').hidden = Boolean(chatFor()?.messages?.length);
  document.title = `${chatTitle()} — Duet`;
  renderConnection(); renderHistory(); renderMessages(); renderActivity(); renderProjectResult(); renderComposer();
  if ($('results-dialog').open) renderBuildResults();
}
function selectChat(id) {
  selected = id; persist(); $('prompt').value = draftFor().text; resizePrompt();
  messageKey = ''; activityKey = ''; resultKey = ''; notice(''); closeSidebar(); render(); scrollBottom(true); refreshProjectView(id);
}
function newChat() { selected = `draft-${uid()}`; draftFor(); selectChat(selected); $('prompt').focus(); }
function updateDraft(patch) { Object.assign(draftFor(), patch); delete draftFor().clientMessageId; persist(); renderHistory(); renderComposer(); }
function acceptedMessage(id, request) {
  if (typeof request.clientMessageId !== 'string' || !request.clientMessageId) return false;
  const message = chatFor(id)?.messages?.find(message => message.role === 'user' && message.clientMessageId === request.clientMessageId && message.text?.trim() === request.text && message.mode === request.mode);
  if (!message) return false;
  // The server exposes preparation before its save finishes. Wait for acceptance to become durable.
  return !state?.activeOperations?.some(operation => operation.id === message.runId && operation.phase === 'preparing');
}
function clearSubmittedDraft(id, request) {
  const draft = drafts[id];
  if (!draft || draft.clientMessageId !== request.clientMessageId || draft.text?.trim() !== request.text || draft.mode !== request.mode) return false;
  draft.text = ''; delete draft.clientMessageId; delete draft.project;
  if (selected === id) { $('prompt').value = ''; resizePrompt(); }
  persist(); return true;
}
function reconcileAcceptedMessages() {
  for (const [id, draft] of Object.entries(drafts)) {
    if (!draft?.clientMessageId) continue;
    const request = { clientMessageId: draft.clientMessageId, text: typeof draft.text === 'string' ? draft.text.trim() : '', mode: draft.mode };
    if (acceptedMessage(id, request)) clearSubmittedDraft(id, request);
  }
  for (const [id, request] of uncertainMessages) if (acceptedMessage(id, request)) {
    uncertainMessages.delete(id);
    if (selected === id) notice('Your message was received. Its progress is shown in this chat.');
  }
}
async function poll(fresh = false) {
  if (location.protocol === 'file:') return;
  if (polling) { await polling; if (fresh === true) return poll(); return; }
  polling = (async () => {
    try {
      const next = await api('state');
      const chats = Array.isArray(next.chats) ? [...next.chats] : [];
      // A poll that began before chat creation must not discard the new chat while its message is sending.
      for (const chat of state?.chats || []) if (submissions.has(chat.id) && !chats.some(item => item.id === chat.id)) chats.push(chat);
      state = { ...next, chats, jobs: Array.isArray(next.jobs) ? next.jobs : [] };
      reconcileAcceptedMessages();
      online = true; authFailure = false; render();
      if (chatFor()?.project && (!projectView().loaded || (projectView().preview.status === 'running' && Date.now() - projectView().lastRefresh > 10000))) refreshProjectView(selected);
    } catch (error) { if (!error.timeout) online = false; renderConnection(); renderComposer(); }
  })();
  try { await polling; } finally { polling = false; }
}
async function ensureChat(id) {
  if (!id.startsWith('draft-')) return id;
  const draft = draftFor(id);
  const result = await api('chats', { ...(draft.title ? { title: draft.title } : {}), ...(draft.project?.trim() ? { project: draft.project.trim() } : {}) });
  drafts[result.id] = draft; delete drafts[id];
  if (submissions.has(id)) { submissions.set(result.id, submissions.get(id)); submissions.delete(id); }
  // Add a provisional record until the next state request, so rendering cannot abandon a freshly created chat.
  if (!chatFor(result.id)) state.chats.unshift({ id: result.id, title: draft.title || 'New chat', project: draft.project || '', createdAt: draft.createdAt, updatedAt: new Date().toISOString(), messages: [], runIds: [] });
  if (selected === id) selected = result.id;
  persist(); return result.id;
}
async function sendMessage(event) {
  event.preventDefault();
  if ($('send').disabled || submissions.has(selected)) return;
  let id = selected;
  const draft = draftFor(id); const text = draft.text.trim(); const mode = draft.mode;
  const request = { text, mode, rounds: Number(draft.rounds || 3), optimization: draft.optimization, ...(draft.maxCalls ? { maxCalls: draft.maxCalls } : {}), tokenLimit: draft.tokenLimit || 0 };
  draft.clientMessageId ||= uid(); persist();
  const clientMessageId = draft.clientMessageId;
  const submittedMessage = { text, mode, clientMessageId };
  let messageRequestStarted = false;
  submissions.set(id, { project: projectFor(id), mode }); notice(''); renderHistory(); renderComposer();
  try {
    id = await ensureChat(id);
    if (draft.project?.trim() && draft.project.trim() !== chatFor(id)?.project) await api(`chats/${id}/project`, { project: draft.project.trim() });
    await syncProjectDecisions(id);
    messageRequestStarted = true;
    const result = await api(`chats/${id}/messages`, { ...request, clientMessageId });
    submissions.get(id).runId = result.id;
    // Do not clear text typed while the message was in flight.
    clearSubmittedDraft(id, submittedMessage); uncertainMessages.delete(id);
    persist(); await poll(true);
    if (selected === id) scrollBottom(true);
  } catch (error) {
    if (messageRequestStarted && error.uncertain) {
      uncertainMessages.set(id, submittedMessage);
      await poll(true);
      if (acceptedMessage(id, submittedMessage)) {
        clearSubmittedDraft(id, submittedMessage); uncertainMessages.delete(id);
        if (selected === id) notice('Your message was received. Its progress is shown in this chat.');
        return;
      }
    }
    notice(selected === id ? error.message : `${chatTitle(id)}: ${error.message}`);
  }
  finally { submissions.delete(id); render(); }
}

function renderSettingsAvailability() {
  if (!settingsChat || !$('settings-dialog').open) return;
  const busy = projectBusy(settingsChat), locked = Boolean(chatFor(settingsChat)?.messages?.length) || busy;
  $('project').readOnly = locked;
  $('browse').disabled = locked || !online || savingSettings;
  $('project-decisions').disabled = busy || savingSettings;
  for (const id of ['rounds', 'max-calls', 'token-limit']) $(id).disabled = busy || savingSettings;
  $('save-settings').disabled = busy || savingSettings;
  $('settings-busy').hidden = !busy;
  $('settings-busy').textContent = 'Work is running in this project. You can update these settings when it finishes.';
}
function openSettings(section) {
  settingsChat = selected; const draft = draftFor(settingsChat);
  $('settings-title').textContent = section === 'team' ? 'Your accounts' : 'Chat settings';
  $('settings-dialog').classList.toggle('accounts-only', section === 'team');
  $('project-settings').hidden = section === 'team';
  $('save-settings').hidden = section === 'team';
  $('cancel-settings').textContent = section === 'team' ? 'Done' : 'Cancel';
  const locked = Boolean(chatFor(settingsChat)?.messages?.length);
  $('project').value = projectFor(settingsChat);
  $('project').readOnly = locked;
  $('browse').disabled = locked || !online;
  $('project-help').textContent = locked ? 'This conversation belongs to this project. Start a new chat to work in a different folder.' : 'Each chat has its own project. Leave this blank for an automatic folder. Missing folders are created when you send your first message.';
  $('project-decisions').value = draft.decisions ?? chatFor(settingsChat)?.decisions ?? '';
  $('rounds').value = String(draft.rounds || 3); $('max-calls').value = draft.maxCalls || ''; $('token-limit').value = draft.tokenLimit || 0; settingsError('');
  $('settings-dialog').showModal();
  renderSettingsAvailability();
  if (section === 'team') $('recheck').focus(); else $('project').focus();
}
async function saveSettings() {
  const id = settingsChat; if (!id) return;
  if (projectBusy(id) || savingSettings) return;
  const enteredProject = $('project').value.trim();
  const project = enteredProject || chatFor(id)?.project || '';
  const patch = { decisions: $('project-decisions').value.trim(), rounds: Number($('rounds').value), maxCalls: $('max-calls').value ? Number($('max-calls').value) : null, tokenLimit: Number($('token-limit').value) };
  if ((patch.maxCalls !== null && (!Number.isInteger(patch.maxCalls) || patch.maxCalls < 1 || patch.maxCalls > 40)) || !Number.isInteger(patch.tokenLimit) || patch.tokenLimit < 0 || patch.tokenLimit > 10000000) { settingsError('Use 1–40 agent steps and a token threshold between 0 and 10,000,000.'); return; }
  savingSettings = true; renderSettingsAvailability(); settingsError('');
  try {
    const changed = project !== (chatFor(id)?.project || '');
    if (!id.startsWith('draft-') && changed && online) {
      const result = await api(`chats/${id}/project`, { project });
      const chat = chatFor(id); if (chat) chat.project = result.project || project;
      delete draftFor(id).project;
    } else if (changed || id.startsWith('draft-')) patch.project = project;
    Object.assign(draftFor(id), patch); delete draftFor(id).clientMessageId; persist();
    if (!id.startsWith('draft-') && online) await syncProjectDecisions(id);
    $('settings-dialog').close(); settingsChat = null; render();
  } catch (error) { settingsError(error.message); }
  finally { savingSettings = false; $('save-settings').disabled = false; renderSettingsAvailability(); }
}
function openRename(id) {
  renamingChat = id; $('rename-title').value = chatTitle(id); $('rename-dialog').showModal(); $('rename-title').focus(); $('rename-title').select();
}
async function renameChat(event) {
  event.preventDefault(); const id = renamingChat, title = $('rename-title').value.trim();
  if (!id || !title) return;
  const button = $('rename-form').querySelector('[type=submit]'); button.disabled = true;
  try {
    if (id.startsWith('draft-')) { draftFor(id).title = title; persist(); }
    else { await api(`chats/${id}/rename`, { title }); const chat = chatFor(id); if (chat) chat.title = title; }
    $('rename-dialog').close(); renamingChat = null; render();
  } catch (error) { notice(error.message); $('rename-dialog').close(); }
  finally { button.disabled = false; }
}

$('prompt').value = draftFor().text; persist(); resizePrompt();
$('prompt').addEventListener('input', () => { updateDraft({ text: $('prompt').value }); resizePrompt(); });
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && innerWidth > 760) { event.preventDefault(); if (!$('send').disabled) $('chat-form').requestSubmit(); }
  else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('chat-form').requestSubmit(); }
});
$('chat-form').addEventListener('submit', sendMessage);
$('new-chat').onclick = newChat; $('brand').onclick = newChat;
$('optimization').onchange = () => updateDraft({ optimization: $('optimization').value, maxCalls: null });
$('mode-build').onclick = () => updateDraft({ mode: 'build' }); $('mode-ask').onclick = () => updateDraft({ mode: 'ask' });
$('open-sidebar').onclick = () => { $('sidebar').classList.add('open'); $('sidebar-scrim').hidden = false; $('open-sidebar').setAttribute('aria-expanded', 'true'); };
$('close-sidebar').onclick = closeSidebar; $('sidebar-scrim').onclick = closeSidebar;
$('dismiss-notice').onclick = () => notice('');
$('open-project').onclick = () => openSettings('project'); $('composer-project').onclick = () => openSettings('project'); $('open-team').onclick = () => openSettings('team');
$('close-settings').onclick = $('cancel-settings').onclick = () => { $('settings-dialog').close(); settingsChat = null; };
$('save-settings').onclick = saveSettings;
$('cancel-rename').onclick = () => $('rename-dialog').close(); $('rename-form').onsubmit = renameChat;
$('settings-dialog').addEventListener('click', event => { if (event.target === $('settings-dialog')) { const rect = $('settings-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('settings-dialog').close(); } });
$('browse').onclick = async () => {
  $('browse').disabled = true; settingsError('');
  try { const result = await api('folder', {}); if (result.path) $('project').value = result.path; }
  catch (error) { settingsError(error.message); } finally { $('browse').disabled = false; renderSettingsAvailability(); }
};
$('recheck').onclick = recheckAccounts; $('setup-recheck').onclick = recheckAccounts;
$('open-setup').onclick = () => openSettings('team');
for (const agent of ['claude', 'codex']) { $(`${agent}-login`).onclick = () => accountAction(agent); $(`${agent}-setup-action`).onclick = () => accountAction(agent); }
for (const agent of ['claude', 'codex']) for (const surface of ['setup', 'account']) {
  $(`${agent}-${surface}-cancel`).onclick = () => cancelSignIn(agent);
  const form = $(`${agent}-${surface}-code-form`);
  if (form) form.onsubmit = event => submitSignInCode(agent, surface, event);
}
$('open-feedback').onclick = openFeedback; $('copy-feedback').onclick = copyFeedback;
$('close-feedback').onclick = $('cancel-feedback').onclick = () => $('feedback-dialog').close();
$('open-results').onclick = openBuildResults; $('close-results').onclick = $('done-results').onclick = () => $('results-dialog').close();
$('start-preview').onclick = openProjectPreview; $('stop-preview').onclick = stopProjectPreview;
$('save-checkpoint').onclick = saveCheckpoint; $('refresh-checkpoints').onclick = () => refreshProjectView(selected);
$('outcome-works').onclick = () => recordOutcome('works'); $('outcome-fixes').onclick = () => recordOutcome('needs_fixes');
$('restore-form').onsubmit = restoreCheckpoint;
$('cancel-restore').onclick = $('keep-current').onclick = () => { $('restore-dialog').close(); restoringCheckpoint = null; };
$('restore-dialog').addEventListener('cancel', event => { if ($('confirm-restore').disabled) event.preventDefault(); });
$('stop').onclick = async () => {
  const operation = operationForChat(); if (!operation?.id || operation.kind !== 'turn' || stoppingRuns.has(operation.id)) return;
  const { id, chatId } = operation; stoppingRuns.add(id); renderHistory(); renderComposer();
  try { await api(`runs/${id}/stop`, {}); await poll(true); }
  catch (error) { notice(selected === chatId ? error.message : `${chatTitle(chatId)}: ${error.message}`); }
  finally { stoppingRuns.delete(id); renderHistory(); renderComposer(); }
};
$('retry-connection').onclick = async () => {
  persist();
  if (authFailure && ['http:', 'https:'].includes(location.protocol)) { location.reload(); return; }
  $('retry-connection').disabled = true; await poll(); $('retry-connection').disabled = false;
};
for (const button of document.querySelectorAll('[data-suggestion]')) button.onclick = () => {
  updateDraft({ text: button.dataset.suggestion, mode: button.dataset.mode }); $('prompt').value = draftFor().text; resizePrompt(); $('prompt').focus(); $('prompt').setSelectionRange($('prompt').value.length, $('prompt').value.length);
};
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !$('settings-dialog').open && !$('rename-dialog').open && !$('feedback-dialog').open && !$('restore-dialog').open && !$('results-dialog').open) { event.preventDefault(); newChat(); }
  if (event.key === 'Escape') closeSidebar();
});
window.addEventListener('resize', resizePrompt);
window.addEventListener('online', poll);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

if (location.protocol === 'file:') {
  render();
  $('offline-title').textContent = 'Open the Duet launcher to start your workspace';
  $('offline-text').textContent = ' This page was opened as a file. Double-click the Duet launcher to start the server and open the connected conversation.';
  $('server-status').textContent = 'App not started'; $('team-status').textContent = 'Open the Duet launcher';
  $('retry-connection').hidden = true;
  for (const id of ['browse', 'save-settings', 'recheck', 'claude-login', 'codex-login']) $(id).disabled = true;
} else { render(); poll(); setInterval(poll, 2000); }
})();
