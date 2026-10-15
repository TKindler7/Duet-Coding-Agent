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
source = source.slice(0, source.indexOf("$('prompt').value = draftFor().text; persist(); resizePrompt();")) + '\nglobalThis.ui = { setState(value) { state = value; online = true; }, selected: value => selected = value, draftFor, renderComposer, renderHistory, projectBusy, operationForChat, runningTurns, submissions, stoppingRuns, activeJob, ensureChat, sendMessage, selectChat, api: value => api = value, poll: value => poll = value, getDrafts: () => drafts, accountView, renderConnection, safeSignInUrl, authBusy, accountRequests, feedbackDiagnostics, submitSignInCode, cancelSignIn };})();';
vm.runInContext(source, context);
const { ui } = context;
const chat = (id, project = '/projects/' + id) => ({ id, title: id, project, messages: [], runIds: [], createdAt: new Date().toISOString() });
const op = (id, project = '/projects/' + id) => ({ id: 'run-' + id, chatId: id, project, kind: 'turn', phase: 'running' });
const base = () => ({ active: 'run-a', activeOperations: [op('a')], concurrency: { limit: 3, running: 1 }, credentials: { claude: { ready: true }, codex: { ready: true } }, chats: ['a', 'b', 'c', 'd'].map(id => chat(id)), jobs: ['a', 'b', 'c'].map(id => ({ id: 'run-' + id, chatId: id, mode: 'build', status: 'working' })) });
const show = id => { ui.selected(id); ui.draftFor(id).text = 'Build it'; ui.renderComposer(); ui.renderHistory(); };

let data = base(); data.active = null; data.activeOperations = []; data.jobs = []; data.credentials = { claude: { installed: true, ready: false }, codex: { installed: true, ready: false } }; data.auth = {};
ui.setState(data); show('b'); ui.renderConnection();
assert.equal(ui.accountView('claude').disabled, false);
assert.match(elements.get('claude-setup-action').textContent, /Connect Claude/);
assert.equal(ui.safeSignInUrl('claude', 'https://claude.com/cai/oauth/authorize?code_challenge=private'), 'https://claude.com/cai/oauth/authorize?code_challenge=private');
assert.equal(ui.safeSignInUrl('claude', 'https://claude.ai/oauth/authorize?state=private'), 'https://claude.ai/oauth/authorize?state=private');
for (const url of ['https://claude.com.evil.example/cai/oauth/authorize', 'javascript:alert(1)', 'https://user:pass@claude.com/cai/oauth/authorize', 'https://claude.com:444/cai/oauth/authorize', 'https://claude.com/arbitrary/path']) assert.equal(ui.safeSignInUrl('claude', url), null);
assert.equal(ui.safeSignInUrl('codex', 'https://auth.openai.com/oauth/authorize?state=private'), 'https://auth.openai.com/oauth/authorize?state=private');
assert.equal(ui.safeSignInUrl('codex', 'https://chatgpt.com/oauth/authorize'), null);
data.auth.claude = { status: 'starting' }; ui.setState(data); ui.renderConnection();
assert.equal(elements.get('claude-setup-signin').hidden, false);
assert.equal(elements.get('claude-setup-continue').hidden, true);
assert.equal(elements.get('claude-setup-cancel').disabled, false);
assert.equal(ui.accountView('codex').disabled, true, 'other account sign-in waits');
assert.equal(elements.get('claude-setup-code-form').hidden, true, 'code entry requires explicit provider prompt');
data.credentials.codex.ready = true; show('b');
assert.equal(elements.get('send').disabled, true, 'sign-in blocks new builds');
data.auth.claude = { status: 'waiting', url: 'https://claude.com/cai/oauth/authorize?state=private', acceptsCode: true }; ui.setState(data); ui.renderConnection();
assert.equal(elements.get('claude-setup-continue').href, data.auth.claude.url);
assert.equal(elements.get('claude-setup-code-form').hidden, false);
assert.equal(ui.feedbackDiagnostics().includes('private'), false, 'feedback excludes transient login URLs');
ui.api(async (route, body) => { assert.equal(route, 'login/code'); assert.equal(body.agent, 'claude'); assert.equal(body.code, 'one-time-secret'); return { status: 'waiting' }; });
ui.poll(async () => {});
elements.get('claude-setup-code').value = 'one-time-secret';
elements.get('claude-account-code').value = 'another-input';
await ui.submitSignInCode('claude', 'setup', { preventDefault() {} });
assert.equal(elements.get('claude-setup-code').value, '');
assert.equal(elements.get('claude-account-code').value, '');
assert.equal(JSON.stringify(ui.getDrafts()).includes('one-time-secret'), false);
data.auth.claude = { status: 'waiting', url: 'https://claude.com/cai/oauth/authorize?state=private', acceptsCode: true };
data.credentials.claude.ready = true;
elements.get('claude-setup-code').value = 'code-before-refresh';
ui.setState(data); ui.renderConnection(); show('b');
assert.equal(ui.accountView('claude').ready, true, 'credentials can become ready before the sign-in helper exits');
assert.equal(ui.accountView('claude').waiting, true, 'the helper remains active independently of credential readiness');
assert.equal(elements.get('onboarding-card').hidden, false, 'active sign-in controls remain reachable when both accounts report ready');
assert.equal(elements.get('setup-banner').hidden, false);
assert.equal(elements.get('claude-setup-signin').hidden, false);
assert.equal(elements.get('claude-account-signin').hidden, false);
assert.equal(elements.get('claude-setup-cancel').disabled, false);
assert.equal(elements.get('claude-setup-continue').hidden, true, 'a connected account no longer needs another login page');
assert.equal(elements.get('claude-setup-code-form').hidden, true);
assert.equal(elements.get('claude-setup-code').value, '', 'refreshing ready credentials clears an unused code');
assert.equal(elements.get('send').disabled, true, 'active sign-in still blocks new work until it closes');
let cancellations = 0;
ui.api(async (route, body) => { assert.equal(route, 'login/cancel'); assert.equal(body.agent, 'claude'); cancellations++; return { status: 'waiting', cancelling: true }; });
await ui.cancelSignIn('claude');
assert.equal(cancellations, 1, 'ready credentials do not prevent cancelling the remaining sign-in helper');
assert.equal(elements.get('claude-setup-cancel').disabled, true);
assert.equal(elements.get('claude-account-cancel').disabled, true);
assert.match(elements.get('claude-setup-status').textContent, /Cancelling sign-in/);
await ui.cancelSignIn('claude'); assert.equal(cancellations, 1, 'a helper awaiting process closure cannot be cancelled repeatedly');
data.auth.claude = { status: 'cancelled' }; ui.setState(data); ui.renderConnection(); show('b');
assert.equal(elements.get('onboarding-card').hidden, true, 'the remaining helper closing completes setup for ready accounts');
assert.equal(elements.get('send').disabled, false);
data.credentials.claude.ready = false;
data.auth.claude = { status: 'connected' }; ui.setState(data); ui.renderConnection();
assert.equal(ui.accountView('claude').ready, false, 'provider auth status does not replace credential validation');
data.credentials.claude.ready = true; ui.setState(data); ui.renderConnection();
assert.equal(elements.get('claude-setup-signin').hidden, true);
assert.equal(elements.get('claude-setup-action').hidden, true);
assert.equal(elements.get('onboarding-card').hidden, true, 'setup clears automatically when both credentials become ready');
data.credentials.claude.ready = false; data.auth.claude = { status: 'failed', error: 'Please try again.' }; ui.setState(data); ui.renderConnection();
assert.match(elements.get('claude-setup-action').textContent, /Try sign-in again/);
assert.equal(elements.get('claude-setup-error').textContent, 'Please try again.');
data.activeOperations = [op('a')]; ui.setState(data); ui.renderConnection();
assert.equal(ui.accountView('claude').disabled, true, 'running chats block login');
data.credentials.claude.installed = false; ui.setState(data); assert.equal(ui.accountView('claude').disabled, true, 'running chats block installation');
console.log('Browser account UI checks passed: official links, exclusive setup, auto-readiness, retry/cancel visibility, code clearing, no credential leakage to drafts/feedback.');
