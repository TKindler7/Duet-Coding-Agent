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
source = source.slice(0, source.indexOf("$('prompt').value = draftFor().text; persist(); resizePrompt();")) + '\nglobalThis.ui = { setState(value) { state = value; online = true; }, selected: value => selected = value, draftFor, renderComposer, renderHistory, projectBusy, operationForChat, runningTurns, submissions, stoppingRuns, activeJob, ensureChat, sendMessage, selectChat, api: value => api = value, poll: value => poll = value, getDrafts: () => drafts };})();';
vm.runInContext(source, context);
const { ui } = context;
const chat = (id, project = '/projects/' + id) => ({ id, title: id, project, messages: [], runIds: [], createdAt: new Date().toISOString() });
const op = (id, project = '/projects/' + id) => ({ id: 'run-' + id, chatId: id, project, kind: 'turn', phase: 'running' });
const base = () => ({ active: 'run-a', activeOperations: [op('a')], concurrency: { limit: 3, running: 1 }, credentials: { claude: { ready: true }, codex: { ready: true } }, chats: ['a', 'b', 'c', 'd'].map(id => chat(id)), jobs: ['a', 'b', 'c'].map(id => ({ id: 'run-' + id, chatId: id, mode: 'build', status: 'working' })) });
const show = id => { ui.selected(id); ui.draftFor(id).text = 'Build it'; ui.renderComposer(); ui.renderHistory(); };
let data = base(); ui.setState(data); show('b');
assert.equal(elements.get('send').disabled, false, 'a second chat can submit');
assert.equal(elements.get('stop').hidden, true, 'no stop control for unrelated running chat');
assert.match(elements.get('composer-status').textContent, /1 other chat/);
show('a'); assert.equal(elements.get('stop').hidden, false);
data.activeOperations.push(op('b'), op('c')); ui.setState(data); show('d');
assert.equal(elements.get('send').disabled, true, 'capacity blocks a fourth chat');
assert.match(elements.get('running-count').textContent, /3 chats/);
assert.equal(elements.get('prompt').disabled, false, 'drafts remain editable at capacity');
ui.stoppingRuns.add('run-a'); show('a'); assert.equal(elements.get('stop').disabled, true);
show('b'); assert.equal(elements.get('stop').disabled, false, 'stopping another chat does not disable this stop control');
ui.stoppingRuns.clear();
data = base(); data.chats[1].project = '/projects/a/nested'; ui.setState(data); show('b');
assert.equal(elements.get('send').disabled, true, 'a parent project blocks a child project');
data.chats[1].project = '/projects/abc'; ui.setState(data); show('b'); assert.equal(elements.get('send').disabled, false, 'path prefixes alone do not overlap');
data.activeOperations[0].phase = 'preparing'; data.jobs = []; ui.setState(data); show('a');
assert.equal(elements.get('stop').disabled, false, 'preparing server reservations can be stopped');
data = base(); delete data.activeOperations; delete data.concurrency; ui.setState(data); show('b'); assert.equal(elements.get('send').disabled, true, 'old servers retain single-turn behavior');
data = base(); data.activeOperations = []; data.active = null; ui.setState(data);
let resolveMessage;
ui.api(async (route, body) => { if (route.endsWith('/messages')) return new Promise(resolve => resolveMessage = () => resolve({ id: 'accepted' })); throw new Error('Unexpected route: ' + route); });
ui.poll(async () => {});
show('a'); const pending = ui.sendMessage({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
show('b'); assert.equal(elements.get('send').disabled, false, 'in-flight submission belongs only to its source chat');
ui.draftFor('a').text = 'A new followup'; delete ui.draftFor('a').clientMessageId;
resolveMessage(); await pending;
assert.equal(ui.getDrafts().a.text, 'A new followup', 'new draft typed during submission is retained');
assert.equal(ui.getDrafts().b.text, 'Build it', 'switching chats never clears the other draft');
console.log('Concurrent UI checks passed: independent sends, capacity, stops, project isolation, preparation, old-server fallback, and draft ownership.');
