import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
class Element {
  constructor(tag = 'DIV') { this.tagName = tag.toUpperCase(); this.childNodes = []; this.dataset = {}; this.attributes = new Map(); this.value = ''; this.style = {}; this.hidden = false; this.disabled = false; this.classList = { toggle() {}, add() {}, remove() {} }; this.scrollHeight = 66; this.scrollTop = 0; this.clientHeight = 800; }
  set textContent(text) { this.childNodes = text === '' ? [] : [{ textContent: String(text) }]; }
  get textContent() { return this.childNodes.map(child => child.textContent || '').join(''); }
  get lastChild() { if (!this.childNodes.length) this.childNodes.push({ textContent: '' }); return this.childNodes.at(-1); }
  append(...children) { this.childNodes.push(...children); }
  replaceChildren(...children) { this.childNodes = children; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  querySelectorAll() { return []; }
  querySelector() { return new Element(); }
  addEventListener() {}
  focus() {}
  select() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const elements = new Map();
const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement(tag) { return new Element(tag); }, createTextNode(text) { return { textContent: text }; }, querySelectorAll() { return []; } };
const context = vm.createContext({ document, location: { hash: '', protocol: 'http:', origin: 'http://localhost:1' }, localStorage: { getItem() {}, setItem() {} }, sessionStorage: { getItem() {}, setItem() {} }, crypto: { randomUUID: () => 'unique' }, history: {}, innerWidth: 1200, requestAnimationFrame() {}, AbortController, setTimeout, clearTimeout, URL, console });
let source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
source = source.slice(0, source.indexOf("$('prompt').value = draftFor().text; persist(); resizePrompt();")) + '\nglobalThis.ui = { setState(value) { state = value; online = true; }, selected: value => selected = value, draftFor, renderComposer, renderHistory, projectBusy, operationForChat, runningTurns, submissions, stoppingRuns, activeJob, ensureChat, sendMessage, selectChat, api: value => api = value, poll: value => poll = value, getDrafts: () => drafts, requestApi: api, pollNow: poll, isOnline: () => online, acceptedMessage, clearSubmittedDraft, reconcileAcceptedMessages, uncertainMessages, activityLabel, runLabel, renderActivity, renderProjectResult, projectView };})();';
vm.runInContext(source, context);
const { ui } = context;
const chat = (id, project = '/projects/' + id) => ({ id, title: id, project, messages: [], runIds: [], createdAt: new Date().toISOString() });
const op = (id, project = '/projects/' + id) => ({ id: 'run-' + id, chatId: id, project, kind: 'turn', phase: 'running' });
const base = () => ({ active: 'run-a', activeOperations: [op('a')], concurrency: { limit: 3, running: 1 }, credentials: { claude: { ready: true }, codex: { ready: true } }, chats: ['a', 'b', 'c', 'd'].map(id => chat(id)), jobs: ['a', 'b', 'c'].map(id => ({ id: 'run-' + id, chatId: id, mode: 'build', status: 'working' })) });
const show = id => { ui.selected(id); ui.draftFor(id).text = 'Build it'; ui.renderComposer(); ui.renderHistory(); };

let data = base(); data.activeOperations = []; data.active = null; data.jobs = []; ui.setState(data);
let timer;
context.setTimeout = (fn, ms) => { timer = { fn, ms }; return timer; };
context.clearTimeout = () => {};
const abortError = () => Object.assign(new Error('Abort'), { name: 'AbortError' });
context.fetch = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(abortError())));
for (const [route, body, expected] of [['state', undefined, 60000], ['refresh', {}, 60000], ['chats/a/messages', {}, 90000], ['chats/a/checkpoints', {}, 120000], ['chats/a/checkpoints/version/restore', {}, 120000], ['chats/a/checkpoints', undefined, 20000]]) {
  const response = ui.requestApi(route, body); assert.equal(timer.ms, expected, `deadline for ${route}`); timer.fn();
  await assert.rejects(response, error => error.timeout === true && error.uncertain === (body !== undefined));
  assert.equal(ui.isOnline(), true, 'one slow request must not mark a healthy background app offline');
}
const statePoll = ui.pollNow(); timer.fn(); await statePoll;
assert.equal(ui.isOnline(), true, 'polling timeout keeps last confirmed connectivity');
context.fetch = async (_url, options) => ({ ok: true, json: () => options.signal.aborted ? Promise.reject(abortError()) : new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(abortError()))) });
const bodyRead = ui.requestApi('chats/a/messages', {}); await Promise.resolve(); timer.fn();
await assert.rejects(bodyRead, error => error.timeout === true, 'body read abort is classified as a deadline, not unreadable JSON');
let acceptedRequest, messageCalls = 0;
function reset() { data = base(); data.active = null; data.activeOperations = []; data.jobs = []; ui.setState(data); ui.submissions.clear(); ui.uncertainMessages.clear(); for (const draft of Object.values(ui.getDrafts())) { draft.text = ''; delete draft.clientMessageId; } show('a'); }
function recordAcceptance(phase = 'running') {
  data.chats[0].messages.push({ role: 'user', text: acceptedRequest.text, mode: acceptedRequest.mode, clientMessageId: acceptedRequest.clientMessageId, runId: 'run-a' });
  data.activeOperations = [{ ...op('a'), phase }]; ui.setState(data); ui.reconcileAcceptedMessages();
}
reset();
ui.api(async (route, body) => { assert.equal(route, 'chats/a/messages'); messageCalls++; acceptedRequest = body; throw Object.assign(new Error('Slow confirmation'), { timeout: true, uncertain: true }); });
ui.poll(async () => recordAcceptance());
await ui.sendMessage({ preventDefault() {} });
assert.equal(messageCalls, 1, 'ambiguous timeout reconciles without automatically resending');
assert.equal(ui.getDrafts().a.text, '', 'a confirmed accepted message clears its unchanged draft');
assert.equal(ui.uncertainMessages.size, 0);
reset();
let rejectSubmission;
ui.api(async (_route, body) => { acceptedRequest = body; return new Promise((_resolve, reject) => rejectSubmission = reject); });
const sending = ui.sendMessage({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
ui.getDrafts().a.text = 'A newer edit'; delete ui.getDrafts().a.clientMessageId; show('b');
rejectSubmission(Object.assign(new Error('Response lost'), { connection: true, uncertain: true })); await sending;
assert.equal(ui.getDrafts().a.text, 'A newer edit', 'reconciliation preserves newer edits in the sending chat');
assert.equal(ui.getDrafts().b.text, 'Build it', 'reconciliation preserves the newly selected chat');
reset();
ui.api(async (_route, body) => { acceptedRequest = body; throw Object.assign(new Error('Response lost'), { uncertain: true }); });
ui.poll(async () => {});
await ui.sendMessage({ preventDefault() {} });
assert.equal(ui.getDrafts().a.clientMessageId, acceptedRequest.clientMessageId, 'unknown outcomes preserve the idempotency key for deliberate retry');
assert.equal(ui.getDrafts().a.text, 'Build it');
recordAcceptance('preparing'); assert.equal(ui.getDrafts().a.text, 'Build it', 'an in-memory message still being saved is not yet confirmation');
data.activeOperations[0].phase = 'running'; ui.reconcileAcceptedMessages();
assert.equal(ui.getDrafts().a.text, '', 'a later poll reconciles delayed acceptance');
assert.equal(ui.uncertainMessages.size, 0);
const now = Date.parse('2026-10-11T10:00:00Z');
const job = { id: 'run-a', activity: { agent: 'codex', stage: 'raw model text must not render', startedAt: new Date(now - 120000).toISOString(), lastActivityAt: new Date(now - 5000).toISOString(), elapsedMs: 115000, text: 'private model output' } };
let label = ui.activityLabel(job, now);
assert.match(label, /Codex is still working/); assert.match(label, /2m 0s elapsed/); assert.match(label, /last activity 5s ago/);
assert.equal(label.includes('private model'), false); assert.equal(label.includes('raw model'), false);
job.activity.lastActivityAt = new Date(now - 45000).toISOString(); label = ui.activityLabel(job, now);
assert.match(label, /Waiting for Codex/); assert.equal(label.includes('still working'), false);
job.activity.lastActivityAt = null; label = ui.activityLabel(job, now);
assert.match(label, /waiting for first activity/); assert.equal(label.includes('still working'), false);
job.activity = null; assert.equal(ui.activityLabel(job, now), '');
data.active = null; data.activeOperations = []; ui.selected('a');
const paused = { id: 'paused-step', chatId: 'a', project: '/projects/a', mode: 'build', status: 'needs_attention', startedAt: new Date(now - 120000).toISOString(), finishedAt: new Date(now).toISOString(), events: [], rounds: [], verification: { status: 'incomplete', summary: 'Not checked yet.', criteria: [], checks: [] }, recovery: { kind: 'timeout', reason: 'idle', agent: 'claude', stage: 'claude-code' }, error: 'Claude stopped responding. Send a message to continue.' };
data.jobs = [paused]; ui.setState(data);
const projectView = ui.projectView('a'); projectView.loaded = true; projectView.jobKey = `${paused.id}:${paused.status}`;
assert.equal(ui.runLabel(paused), 'Paused · send a message to continue', 'timeout takes priority over incomplete verification');
ui.renderActivity(); assert.equal(elements.get('activity').childNodes.at(-1).open, true, 'timeout details open automatically');
ui.renderProjectResult(); assert.equal(elements.get('result-status').textContent, 'Needs attention');
assert.match(elements.get('result-status').className, /needs-attention/);
assert.equal(elements.get('result-description').textContent, paused.error);
delete paused.recovery; paused.error = 'Checks still need confirmation.'; ui.setState(data);
assert.equal(ui.runLabel(paused), 'Ready for your check', 'ordinary incomplete verification keeps its existing label');
ui.renderActivity(); assert.equal(elements.get('activity').childNodes.at(-1).open, false);
ui.renderProjectResult(); assert.equal(elements.get('result-status').textContent, 'Ready for your check');
console.log('Timeout UI checks passed: route deadlines, healthy connection preservation, response-body aborts, safe send reconciliation/retries, draft isolation, and honest activity timing.');
