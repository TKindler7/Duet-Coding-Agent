import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWebApp } from '../src/web.mjs';

const ready = async () => ({ claude: { ready: true }, codex: { ready: true } });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duet-session-'));
  const closers = [];
  t.after(async () => {
    for (const close of closers) await close();
    await rm(root, { recursive: true, force: true });
  });
  const launch = async ({ token = randomBytes(32).toString('hex'), port = 0 } = {}) => {
    const app = await createWebApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'), token, health: ready });
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, '127.0.0.1', resolve);
    });
    const actualPort = app.server.address().port;
    const origin = `http://127.0.0.1:${actualPort}`;
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await app.close(); } };
    closers.push(close);
    const request = (route, headers = {}) => fetch(origin + route, { headers });
    const cookieRequest = (cookie, extra = {}) => request('/api/state', {
      Cookie: cookie, 'X-Duet-Request': '1', Origin: origin, ...extra,
    });
    const session = async () => {
      const response = await request('/');
      assert.equal(response.status, 200);
      const setCookie = response.headers.get('set-cookie');
      assert.ok(setCookie, 'a fresh browser landing must receive its local session cookie');
      await response.text();
      return { setCookie, cookie: setCookie.split(';')[0] };
    };
    return { ...app, port: actualPort, origin, close, request, cookieRequest, session };
  };
  return { launch };
}

test('opening the plain local URL creates a scoped session without disclosing the server token', async t => {
  const { launch } = await fixture(t);
  const app = await launch();
  const response = await app.request('/');
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  const expected = createHmac('sha256', app.token).update(`duet-browser-session:v1:${app.origin}`).digest('hex');
  assert.ok(setCookie?.startsWith(`duet_session_${app.port}=${expected};`));
  assert.match(setCookie, /;\s*Path=\/api(?:;|$)/i);
  assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
  assert.match(setCookie, /;\s*SameSite=Strict(?:;|$)/i);
  assert.match(setCookie, /;\s*Max-Age=31536000(?:;|$)/i);
  assert.doesNotMatch(setCookie, /;\s*Domain=/i);
  assert.ok(!setCookie.includes(app.token));
  assert.ok(!(await response.text()).includes(app.token));
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('a fresh session reads state without a bearer using exact Origin or same-origin fetch metadata', async t => {
  const { launch } = await fixture(t);
  const app = await launch();
  const { cookie } = await app.session();
  assert.equal((await app.cookieRequest(cookie)).status, 200);
  assert.equal((await app.request('/api/state', {
    Cookie: cookie, 'X-Duet-Request': '1', 'Sec-Fetch-Site': 'same-origin',
  })).status, 200);
  assert.equal((await app.cookieRequest(cookie, { Authorization: 'Bearer an-expired-token' })).status, 200,
    'stale browser bearer storage must not override a valid local session');
  assert.equal((await app.request('/api/state', { Authorization: `Bearer ${app.token}` })).status, 200,
    'native clients and old links retain bearer compatibility');
});

test('cookie authentication rejects missing proof and conflicting origin metadata', async t => {
  const { launch } = await fixture(t);
  const app = await launch();
  const { cookie } = await app.session();
  const invalidHeaders = [
    { Cookie: cookie, Origin: app.origin },
    { Cookie: cookie, 'X-Duet-Request': '0', Origin: app.origin },
    { Cookie: cookie, 'X-Duet-Request': '1' },
    { Cookie: cookie, 'X-Duet-Request': '1', Origin: 'https://untrusted.example' },
    { Cookie: cookie, 'X-Duet-Request': '1', Origin: 'null' },
    { Cookie: cookie, 'X-Duet-Request': '1', Origin: app.origin, 'Sec-Fetch-Site': 'cross-site' },
    { Cookie: cookie, 'X-Duet-Request': '1', Origin: app.origin, 'Sec-Fetch-Site': 'same-site' },
    { Cookie: cookie, 'X-Duet-Request': '1', Origin: app.origin, 'Sec-Fetch-Site': 'none' },
    { Cookie: cookie, 'X-Duet-Request': '1', Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'same-origin' },
  ];
  for (const headers of invalidHeaders) {
    const response = await app.request('/api/state', headers);
    assert.ok(response.status === 401 || response.status === 403, `unexpected status ${response.status} for ${JSON.stringify(headers)}`);
  }
  assert.equal((await app.request('/api/state', {
    Authorization: `Bearer ${app.token}`, Origin: 'https://untrusted.example',
  })).status, 403, 'foreign origins remain blocked even if a bearer is supplied');
});

test('missing, malformed, tampered, raw-token, and wrong-port cookies cannot authenticate', async t => {
  const { launch } = await fixture(t);
  const app = await launch();
  const { cookie } = await app.session();
  const [name, value] = cookie.split('=');
  for (const invalid of [
    '',
    `${name}=`,
    `${name}=not-a-session`,
    `${name}=%ZZ`,
    `${name}=${app.token}`,
    `${name}=${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`,
    `duet_session_${app.port + 1}=${value}`,
  ]) {
    const response = await app.cookieRequest(invalid);
    assert.ok(response.status === 401 || response.status === 403);
  }
});

test('a fresh local session can create a chat but cross-site cookie requests cannot mutate state', async t => {
  const { launch } = await fixture(t);
  const app = await launch();
  const { cookie } = await app.session();
  const post = headers => fetch(app.origin + '/api/chats', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ title: 'Created from a fresh browser' }),
  });
  const created = await post({ 'X-Duet-Request': '1', Origin: app.origin, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.ok(id);
  const before = await (await app.cookieRequest(cookie)).json();
  assert.equal(before.chats.length, 1);
  const foreign = await post({ 'X-Duet-Request': '1', Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(foreign.status, 403);
  const unmarked = await post({ Origin: app.origin });
  assert.ok([401, 403].includes(unmarked.status));
  assert.deepEqual(await (await app.cookieRequest(cookie)).json(), before);
});

test('top-level links can establish a session while embedded pages are rejected before cookie issuance', async t => {
  const { launch } = await fixture(t);
  const app = await launch();
  const topLevel = await app.request('/', {
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
  });
  assert.equal(topLevel.status, 200);
  assert.ok(topLevel.headers.get('set-cookie'));
  await topLevel.text();
  for (const destination of ['iframe', 'frame', 'embed', 'object']) {
    const embedded = await app.request('/', {
      'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': destination,
    });
    assert.equal(embedded.status, 403, `unexpected embedded landing behavior for ${destination}`);
    assert.equal(embedded.headers.get('set-cookie'), null);
  }
});

test('session survives a server restart with the same token but fails after token rotation', async t => {
  const { launch } = await fixture(t);
  const first = await launch();
  const { cookie } = await first.session();
  const { token, port } = first;
  await first.close();
  const sameIdentity = await launch({ token, port });
  assert.equal((await sameIdentity.cookieRequest(cookie)).status, 200);
  await sameIdentity.close();
  const changedIdentity = await launch({ port });
  assert.notEqual(changedIdentity.token, token);
  assert.ok([401, 403].includes((await changedIdentity.cookieRequest(cookie)).status));
  const renewed = await changedIdentity.session();
  assert.notEqual(renewed.cookie, cookie);
  assert.equal((await changedIdentity.cookieRequest(renewed.cookie)).status, 200);
});
