import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSetupManager, CODEX_VERSION, CLAUDE_INSTALL_URL } from '../src/setup.mjs';
import { createWebApp } from '../src/web.mjs';
import { doctor } from '../src/duet.mjs';

const success = { code: 0, stdout: 'Installed tool version', stderr: '' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duet-setup-'));
  const home = path.join(root, "Friend's Mac Home");
  const nodePath = path.join(root, 'Bundled Runtime', 'bin', 'node');
  await mkdir(home);
  const manager = createSetupManager({ home, nodePath, platform: 'darwin',
    runner: async () => success,
    fetchImpl: async () => { throw new Error('A setup test attempted an unexpected download'); }, ...options });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { manager, root, home, nodePath, support: path.join(home, 'Library/Application Support/Duet') };
}

test('setup only accepts the two allowlisted providers and supported platform', async t => {
  let calls = 0;
  const app = await fixture(t, { runner: async () => { calls++; return success; } });
  for (const name of ['', 'constructor', '__proto__', 'claude; touch injected', 'codex --help', '/bin/bash', null, {}]) {
    assert.throws(() => app.manager.install(name), error => error.status === 400);
  }
  assert.deepEqual(app.manager.snapshot(), {});
  assert.equal(calls, 0);
  const otherPlatform = await fixture(t, { platform: 'linux', runner: async () => { calls++; return success; } });
  assert.throws(() => otherPlatform.manager.install('codex'), error => error.status === 400);
  assert.equal(calls, 0);
});

test('duplicate installs reuse the in-flight operation and an installed tool is not assumed signed in', async t => {
  const started = deferred(), installer = deferred();
  const calls = [], changes = [];
  const app = await fixture(t, {
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === '--version') return success;
      started.resolve(); return installer.promise;
    },
    onChange: state => { changes.push(state); },
  });
  assert.deepEqual(app.manager.install('codex'), { status: 'installing' });
  const duplicate = app.manager.install('codex');
  assert.deepEqual(duplicate, { status: 'installing' });
  duplicate.status = 'failed';
  assert.equal(app.manager.snapshot().codex.status, 'installing');
  await started.promise;
  assert.equal(calls.length, 1);
  installer.resolve(success);
  await app.manager.wait();
  assert.deepEqual(app.manager.snapshot(), { codex: { status: 'installed' } });
  assert.deepEqual(app.manager.install('codex'), { status: 'installed' });
  assert.equal(calls.length, 2, 'the only second command is --version, not another install');
  assert.deepEqual(changes.at(-1), { codex: { status: 'installed' } });
  assert.equal('ready' in app.manager.snapshot().codex, false);
  assert.equal('authMethod' in app.manager.snapshot().codex, false);
});

test('Codex installation uses pinned official package, per-user prefix, and the bundled npm CLI', async t => {
  const calls = [];
  const app = await fixture(t, { runner: async (command, args, options) => { calls.push({ command, args, options }); return success; } });
  const npmCli = path.resolve(path.dirname(app.nodePath), '../lib/node_modules/npm/bin/npm-cli.js');
  await mkdir(path.dirname(npmCli), { recursive: true });
  await writeFile(npmCli, '// Fixture; never executed');
  app.manager.install('codex');
  await app.manager.wait();
  assert.equal(calls[0].command, app.nodePath);
  assert.equal(calls[0].args[0], npmCli);
  const args = calls[0].args.slice(1);
  assert.equal(args[0], 'install');
  assert.ok(args.includes(`@openai/codex@${CODEX_VERSION}`));
  assert.ok(args.includes('--ignore-scripts'));
  assert.ok(args.includes('--registry=https://registry.npmjs.org'));
  assert.equal(args[args.indexOf('--prefix') + 1], path.join(app.support, 'Tools'));
  assert.equal(calls[0].options.cwd, app.home);
  assert.equal(calls[0].options.env.HOME, app.home);
  assert.ok(calls[0].options.env.PATH.split(':').includes(path.join(app.support, 'Tools/bin')));
  assert.ok(calls[0].options.env.PATH.split(':').includes(path.dirname(app.nodePath)));
  assert.equal(calls[1].command, 'codex');
  assert.deepEqual(calls[1].args, ['--version']);
  assert.equal(app.manager.snapshot().codex.status, 'installed');
});

test('failed installs have generic errors, leak no command output, and can be retried', async t => {
  const secret = 'private-provider-token-and-email@example.test';
  let installations = 0;
  const app = await fixture(t, { runner: async (command, args) => {
    if (args[0] === '--version') return { ...success, stdout: secret };
    installations++;
    return installations === 1 ? { code: 1, stdout: secret, stderr: secret } : success;
  } });
  app.manager.install('codex');
  await app.manager.wait();
  const failed = app.manager.snapshot();
  assert.equal(failed.codex.status, 'failed');
  assert.equal(typeof failed.codex.error, 'string');
  assert.ok(!JSON.stringify(failed).includes(secret));
  assert.deepEqual(app.manager.install('codex'), { status: 'installing' });
  await app.manager.wait();
  assert.equal(installations, 2);
  assert.deepEqual(app.manager.snapshot(), { codex: { status: 'installed' } });
});

test('installer exit success does not count as installed when executable validation fails', async t => {
  for (const verification of ['missing', 'nonzero']) {
    await t.test(verification, async t => {
      const app = await fixture(t, { runner: async (command, args) => {
        if (args[0] !== '--version') return success;
        if (verification === 'missing') throw Object.assign(new Error('Private executable path missing'), { code: 'ENOENT' });
        return { code: 1, stdout: 'private output', stderr: 'private credentials' };
      } });
      app.manager.install('codex'); await app.manager.wait();
      assert.equal(app.manager.snapshot().codex.status, 'failed');
      assert.doesNotMatch(JSON.stringify(app.manager.snapshot()), /Private executable|private output|private credentials/);
    });
  }
});

test('Claude uses only the official bounded download and removes its temporary script', async t => {
  const script = '#!/bin/bash\nprintf "fixture only; never run"\n';
  const downloads = [], calls = [];
  let scriptPath;
  const app = await fixture(t, {
    fetchImpl: async (url, options) => { downloads.push({ url, options }); return new Response(script); },
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === '/bin/bash') {
        scriptPath = args[0];
        assert.equal(await readFile(scriptPath, 'utf8'), script);
        assert.deepEqual(args.slice(1), ['stable']);
      }
      return success;
    },
  });
  assert.deepEqual(app.manager.install('claude'), { status: 'installing' });
  await app.manager.wait();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].url, CLAUDE_INSTALL_URL);
  assert.equal(downloads[0].url, 'https://claude.ai/install.sh');
  assert.equal(downloads[0].options.redirect, 'manual');
  assert.ok(downloads[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].command, '/bin/bash');
  assert.ok(scriptPath.startsWith(app.support + path.sep));
  assert.equal(calls[0].options.cwd, app.home);
  assert.equal(calls[0].options.env.HOME, app.home);
  assert.equal(calls[1].command, 'claude');
  assert.deepEqual(calls[1].args, ['--version']);
  assert.equal(app.manager.snapshot().claude.status, 'installed');
  await assert.rejects(readFile(scriptPath), { code: 'ENOENT' });
  assert.equal((await readdir(app.support)).some(name => name.startsWith('setup-')), false);
});

test('Claude follows its one known official bootstrap redirect and rejects other destinations', async t => {
  const officialBootstrap = 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh';
  const urls = [], options = [], calls = [];
  const app = await fixture(t, {
    fetchImpl: async (url, settings) => {
      urls.push(url); options.push(settings);
      return urls.length === 1
        ? new Response('', { status: 302, headers: { Location: officialBootstrap } })
        : new Response('#!/bin/bash\n# Official response fixture; never executed\n');
    },
    runner: async (command, args) => { calls.push({ command, args }); return success; },
  });
  app.manager.install('claude'); await app.manager.wait();
  assert.deepEqual(urls, [CLAUDE_INSTALL_URL, officialBootstrap]);
  assert.equal(options[0].redirect, 'manual');
  assert.equal(options[1].redirect, 'error');
  assert.equal(app.manager.snapshot().claude.status, 'installed');
  assert.equal(calls[0].command, '/bin/bash');
  for (const target of [
    'https://untrusted.example/install.sh',
    'https://downloads.claude.ai.untrusted.example/claude-code-releases/bootstrap.sh',
    'http://downloads.claude.ai/claude-code-releases/bootstrap.sh',
    'https://downloads.claude.ai/other-script.sh',
  ]) {
    await t.test(target, async t => {
      let downloads = 0, executions = 0;
      const invalid = await fixture(t, {
        fetchImpl: async () => { downloads++; return new Response('', { status: 302, headers: { Location: target } }); },
        runner: async () => { executions++; return success; },
      });
      invalid.manager.install('claude'); await invalid.manager.wait();
      assert.equal(downloads, 1);
      assert.equal(executions, 0);
      assert.equal(invalid.manager.snapshot().claude.status, 'failed');
      assert.equal((await readdir(invalid.support)).some(name => name.startsWith('setup-')), false);
    });
  }
});

test('Claude download or content failures never execute a script and leave no temporary files', async t => {
  const cases = [
    ['network', async () => { throw new Error('private proxy password'); }],
    ['HTTP error', async () => new Response('private server output', { status: 503 })],
    ['redirect response', async () => new Response('', { status: 302 })],
    ['unexpected content', async () => new Response('<html>Not an installer</html>')],
    ['oversized content', async () => new Response('#!/bin/bash\n' + 'x'.repeat(1_048_576))],
  ];
  for (const [label, fetchImpl] of cases) {
    await t.test(label, async t => {
      let executions = 0;
      const app = await fixture(t, { fetchImpl, runner: async () => { executions++; return success; } });
      app.manager.install('claude'); await app.manager.wait();
      assert.equal(app.manager.snapshot().claude.status, 'failed');
      assert.equal(executions, 0);
      assert.doesNotMatch(JSON.stringify(app.manager.snapshot()), /private proxy|private server/);
      assert.equal((await readdir(app.support)).some(name => name.startsWith('setup-')), false);
    });
  }
});

test('notification errors cannot fail setup and closing interrupts a pending install', async t => {
  const installed = await fixture(t, { onChange: () => { throw new Error('UI disconnected'); } });
  installed.manager.install('codex'); await installed.manager.wait();
  assert.equal(installed.manager.snapshot().codex.status, 'installed');
  const started = deferred();
  const app = await fixture(t, { runner: async (command, args, options) => new Promise((resolve, reject) => {
    started.resolve();
    options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  }) });
  app.manager.install('codex');
  await started.promise;
  await app.manager.close();
  assert.equal(app.manager.snapshot().codex.status, 'failed');
  assert.match(app.manager.snapshot().codex.error, /interrupted/i);
  assert.throws(() => app.manager.install('codex'), error => error.status === 503);
});

async function apiFixture(t, { setupState = {}, run } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duet-setup-api-'));
  const installedAgents = [];
  const setupManager = {
    snapshot: () => structuredClone(setupState),
    install(agent) {
      if (!['claude', 'codex'].includes(agent)) throw Object.assign(new Error('Unknown assistant.'), { status: 400 });
      installedAgents.push(agent);
      setupState[agent] = { status: 'installing' };
      return structuredClone(setupState[agent]);
    },
    close: async () => {},
  };
  const app = await createWebApp({
    dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'), setupManager,
    health: async () => ({ claude: { installed: true, ready: true }, codex: { installed: true, ready: true } }),
    ...(run ? { run } : {}),
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, body, authenticated = true) => fetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(authenticated ? { Authorization: `Bearer ${app.token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const state = async () => (await request('/api/state')).json();
  return { ...app, request, state, installedAgents };
}

test('setup API requires authentication, allowlists providers, and exposes only safe setup/system fields', async t => {
  const app = await apiFixture(t);
  assert.equal((await app.request('/api/setup/install', { agent: 'codex' }, false)).status, 401);
  assert.equal((await app.request('/api/setup/install', { agent: 'claude; touch bad' })).status, 400);
  assert.deepEqual(app.installedAgents, []);
  const install = await app.request('/api/setup/install', { agent: 'codex' });
  assert.equal(install.status, 202);
  assert.deepEqual(await install.json(), { status: 'installing' });
  const state = await app.state();
  assert.deepEqual(state.setup, { codex: { status: 'installing' } });
  assert.equal(typeof state.system.version, 'string');
  assert.equal(typeof state.system.platform, 'string');
  assert.equal(typeof state.system.architecture, 'string');
  assert.ok(Object.keys(state.system).every(key => ['version', 'platform', 'architecture', 'macOS'].includes(key)));
  assert.ok(!JSON.stringify(state).includes(app.token));
  assert.deepEqual(state.chats, []);
  assert.deepEqual(state.jobs, []);
});

test('setup API refuses installations during a build and refuses builds during installation', async t => {
  const app = await apiFixture(t, { run: options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
  }) });
  const chat = await (await app.request('/api/chats', {})).json();
  const running = await app.request(`/api/chats/${chat.id}/messages`, { text: 'Build a small app', mode: 'build', rounds: 1 });
  assert.equal(running.status, 202);
  assert.equal((await app.request('/api/setup/install', { agent: 'claude' })).status, 409);
  assert.deepEqual(app.installedAgents, []);
  const { id } = await running.json();
  assert.equal((await app.request(`/api/runs/${id}/stop`, {})).status, 200);

  const installing = await apiFixture(t, { setupState: { codex: { status: 'installing' } } });
  const newChat = await (await installing.request('/api/chats', {})).json();
  assert.equal((await installing.request(`/api/chats/${newChat.id}/messages`, {
    text: 'Wait until setup finishes', mode: 'build', rounds: 1,
  })).status, 409);
  const untouched = await installing.state();
  assert.deepEqual(untouched.jobs, []);
  assert.deepEqual(untouched.chats[0].messages, []);
});

test('account diagnostics distinguish missing tools from installed but signed-out accounts', async () => {
  const missing = await doctor({ runner: async () => { throw Object.assign(new Error('Tool not found'), { code: 'ENOENT' }); } });
  assert.equal(missing.claude.installed, false);
  assert.equal(missing.codex.installed, false);
  assert.equal(missing.claude.ready, false);
  assert.equal(missing.codex.ready, false);
  const signedOut = await doctor({ runner: async name => name === 'claude'
    ? { code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}', stderr: '' }
    : { code: 1, stdout: '', stderr: 'Not logged in' } });
  for (const name of ['claude', 'codex']) {
    assert.equal(signedOut[name].installed, true);
    assert.equal(signedOut[name].ready, false);
    assert.equal(signedOut[name].authMethod, null);
  }
});
