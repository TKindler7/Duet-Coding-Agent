import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createAuthManager, officialAuthUrl } from '../src/auth.mjs';

const state = 'test-state';
const claudeUrl = `https://claude.com/cai/oauth/authorize?client_id=official-client&response_type=code&state=${state}&code_challenge=challenge&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback`;
const codexUrl = `https://auth.openai.com/oauth/authorize?client_id=official-client&response_type=code&state=${state}&code_challenge=challenge&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback`;
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const children = [], calls = [], kills = [];
  const manager = createAuthManager({ home: '/tmp/duet-auth-mock', nodePath: '/tmp/runtime/bin/node',
    health: async () => ({ claude: { ready: true }, codex: { ready: true } }),
    spawnImpl(command, args, spawnOptions) {
      calls.push({ command, args, options: spawnOptions });
      const child = new EventEmitter(); child.pid = 12345 + children.length;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.input = '';
      child.stdin = new Writable({ write(chunk, _encoding, callback) { child.input += chunk.toString(); callback(); } });
      child.kill = signal => { kills.push({ pid: child.pid, signal }); queueMicrotask(() => child.emit('close', null)); };
      children.push(child); return child;
    },
    killImpl(pid, signal) { kills.push({ pid, signal }); queueMicrotask(() => children.find(child => child.pid === -pid)?.emit('close', null)); },
    ...options });
  return { manager, children, calls, kills };
}

test('only official authorization URLs are accepted; callbacks, tokens and lookalike hosts stay private', () => {
  assert.equal(officialAuthUrl('claude', claudeUrl), claudeUrl);
  assert.equal(officialAuthUrl('claude', claudeUrl.replace('claude.com/cai', 'claude.ai')), claudeUrl.replace('claude.com/cai', 'claude.ai'));
  assert.equal(officialAuthUrl('codex', codexUrl), codexUrl);
  for (const url of [codexUrl.replace('https:', 'http:'), codexUrl.replace('auth.openai.com', 'auth.openai.com.evil.test'),
    codexUrl.replace('auth.openai.com', 'person@auth.openai.com'), codexUrl.replace('auth.openai.com', 'auth.openai.com:444'),
    codexUrl.replace('/oauth/authorize', '/auth/callback'), codexUrl + '&access_token=secret', codexUrl + '&code=secret',
    codexUrl + '&refresh_token=secret', codexUrl + '&client_secret=secret', codexUrl + '#secret',
    codexUrl.replace('response_type=code', 'response_type=token'), codexUrl.replace('state=test-state', 'state='),
    codexUrl + '\n']) assert.equal(officialAuthUrl('codex', url), null, url);
  assert.equal(officialAuthUrl('claude', codexUrl), null);
});

test('Codex starts its official browser login and waits for verified provider readiness', async t => {
  let release;
  const f = fixture({ health: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => f.manager.close());
  assert.deepEqual(f.manager.start('codex'), { status: 'starting' }); await tick();
  assert.equal(f.calls[0].command, 'codex'); assert.deepEqual(f.calls[0].args, ['login']);
  assert.equal(f.calls[0].options.shell, undefined); assert.equal(f.calls[0].options.detached, true);
  assert.equal(f.calls[0].options.env.HOME, '/tmp/duet-auth-mock');
  assert.match(f.calls[0].options.env.PATH, /^\/tmp\/runtime\/bin:/);
  f.children[0].stderr.write(`Continue at ${codexUrl}\n`);
  assert.equal(f.manager.snapshot().codex.url, codexUrl);
  f.children[0].emit('close', 0); await tick();
  assert.equal(f.manager.snapshot().codex.status, 'waiting');
  release({ codex: { ready: true } }); await f.manager.wait();
  assert.deepEqual(f.manager.snapshot().codex, { status: 'connected' });
});

test('Claude extracts split ANSI links and forwards only its active manual code to stdin', async t => {
  const f = fixture(); t.after(() => f.manager.close()); f.manager.start('claude'); await tick();
  assert.deepEqual(f.calls[0].args, ['auth', 'login', '--claudeai']);
  assert.equal(f.children[0].stdin.writableEnded, false);
  f.children[0].stdout.write(`If browser did not open: \x1b[34m${claudeUrl.slice(0, 60)}`);
  assert.equal(f.manager.snapshot().claude.url, undefined);
  f.children[0].stdout.write(`${claudeUrl.slice(60)}\x1b[0m\nPaste code here if prompted > `);
  assert.deepEqual(f.manager.snapshot().claude, { status: 'waiting', url: claudeUrl, acceptsCode: true });
  assert.throws(() => f.manager.submitCode('claude', 'code#different-state'), /different sign-in/);
  assert.throws(() => f.manager.submitCode('claude', 'code#test-state\ncommand'), /complete code/);
  assert.deepEqual(f.manager.submitCode('claude', 'auth-code#test-state'), { status: 'waiting', submitted: true });
  assert.equal(f.children[0].input, 'auth-code#test-state\n');
  assert.equal(JSON.stringify(f.manager.snapshot()).includes('auth-code'), false);
  f.children[0].emit('close', 0); await f.manager.wait();
  assert.deepEqual(f.manager.snapshot().claude, { status: 'connected' });
});

test('duplicate starts reuse their session and simultaneous provider sign-ins cannot conflict', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  f.manager.start('codex'); f.manager.start('codex');
  assert.throws(() => f.manager.start('claude'), { status: 409 }); await tick();
  assert.equal(f.calls.length, 1); f.manager.cancel('codex'); await f.manager.wait();
  assert.deepEqual(f.manager.snapshot().codex, { status: 'cancelled' });
  assert.equal(f.manager.start('claude').status, 'starting'); await tick();
  f.children[1].emit('close', 1); await f.manager.wait();
  assert.equal(f.manager.snapshot().claude.status, 'failed');
});

test('cancellation keeps the session busy until close and clears active links immediately', async t => {
  const kills = [], f = fixture({ killImpl: (pid, signal) => kills.push({ pid, signal }), killGraceMs: 10 });
  t.after(() => f.manager.close()); f.manager.start('codex'); await tick();
  f.children[0].stdout.write(codexUrl + '\n');
  assert.deepEqual(f.manager.cancel('codex'), { status: 'waiting', cancelling: true });
  assert.throws(() => f.manager.start('claude'), { status: 409 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(kills.slice(0, 2), [{ pid: -12345, signal: 'SIGTERM' }, { pid: -12345, signal: 'SIGKILL' }]);
  f.children[0].emit('close', null); await f.manager.wait();
  assert.deepEqual(f.manager.snapshot().codex, { status: 'cancelled' });
});

test('sign-in failures and failed readiness never expose raw logs or claim connection', async t => {
  for (const exitCode of [0, 1]) {
    const f = fixture({ health: async () => ({ claude: { ready: false } }) }); t.after(() => f.manager.close());
    f.manager.start('claude'); await tick();
    f.children[0].stderr.write('secret-access-token and /private/provider/path\n');
    f.children[0].emit('close', exitCode); await f.manager.wait();
    const serialized = JSON.stringify(f.manager.snapshot());
    assert.equal(f.manager.snapshot().claude.status, 'failed');
    assert.doesNotMatch(serialized, /secret-access-token|private\/provider/);
  }
});

test('timeouts and bounded output stop helpers without persisting output', async t => {
  const timed = fixture({ timeoutMs: 15 }); t.after(() => timed.manager.close());
  timed.manager.start('codex'); await timed.manager.wait();
  assert.match(timed.manager.snapshot().codex.error, /timed out/);
  const excessive = fixture({ maxOutputBytes: 20 }); t.after(() => excessive.manager.close());
  excessive.manager.start('claude'); await tick();
  excessive.children[0].stdout.write('secret'.repeat(10)); await excessive.manager.wait();
  assert.equal(excessive.manager.snapshot().claude.status, 'failed');
  assert.doesNotMatch(JSON.stringify(excessive.manager.snapshot()), /secret/);
});

test('spawn failures are generic, code submission needs an active prompt, and close prevents restart', async () => {
  const manager = createAuthManager({ spawnImpl() { throw new Error('secret environment details'); } });
  assert.throws(() => manager.start('shell'), { status: 400 });
  assert.throws(() => manager.submitCode('claude', 'code#state'), { status: 409 });
  manager.start('codex'); await manager.wait();
  assert.equal(manager.snapshot().codex.status, 'failed');
  assert.doesNotMatch(JSON.stringify(manager.snapshot()), /secret environment/);
  await manager.close(); assert.throws(() => manager.start('codex'), { status: 503 });
});

test('cancelling before spawn and during verification never writes credentials or waits on health', async () => {
  const before = fixture(); before.manager.start('claude'); before.manager.cancel('claude'); await before.manager.wait();
  assert.equal(before.calls.length, 0); assert.equal(before.manager.snapshot().claude.status, 'cancelled');
  const during = fixture({ health: () => new Promise(() => {}) });
  during.manager.start('codex'); await tick(); during.children[0].emit('close', 0); await tick();
  await during.manager.close(); assert.equal(during.manager.snapshot().codex.status, 'cancelled');
});

test('snapshot mutation and failing observers cannot affect or fail authentication', async () => {
  const f = fixture({ onChange() { throw new Error('observer unavailable'); } });
  f.manager.start('codex'); const snapshot = f.manager.snapshot(); snapshot.codex.status = 'connected';
  assert.equal(f.manager.snapshot().codex.status, 'starting'); await tick();
  f.children[0].emit('close', 0); await f.manager.wait(); assert.equal(f.manager.snapshot().codex.status, 'connected');
});
