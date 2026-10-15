import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { installService, installationPaths } from '../src/install-service.mjs';

const absent = () => Object.assign(new Error('Service absent'), { code: 113 });
const idle = async () => ({ ok: true, json: async () => ({ active: null }) });
async function fixture(t, installed = true) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'duet-unload-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const appRoot = path.join(home, 'bundle');
  for (const name of ['src', 'public', 'data']) await mkdir(path.join(appRoot, name), { recursive: true });
  await writeFile(path.join(appRoot, 'src/web.mjs'), '// Test fixture; never executed.');
  await writeFile(path.join(appRoot, 'public/index.html'), 'old version');
  await writeFile(path.join(appRoot, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(appRoot, 'data/server.json'), JSON.stringify({ origin: 'http://127.0.0.1:63121', token: 'd'.repeat(64) }));
  const options = { appRoot, home, uid: 501, platform: 'darwin', nodePath: '/mock/bin/node', port: 63121,
    wait: async () => {}, fetchImpl: idle, sleep: async () => {} };
  if (installed) await installService({ ...options, command: async (_command, args) => { if (args[0] === 'print') throw absent(); return {}; } });
  return { options, paths: installationPaths(home) };
}

test('updates wait through unloading registrations before writing runtime files or bootstrapping', async t => {
  const { options, paths } = await fixture(t), calls = [];
  await writeFile(path.join(options.appRoot, 'public/index.html'), 'new version');
  let unloading = false, remaining = 2;
  await installService({ ...options, command: async (_command, args) => {
    calls.push(args[0]);
    if (args[0] === 'bootout') unloading = true;
    if (args[0] === 'print' && unloading) {
      assert.equal(await readFile(path.join(paths.app, 'public/index.html'), 'utf8'), 'old version');
      if (remaining-- === 0) throw absent();
      return { stdout: 'state = running\npid = 12345\n' };
    }
    if (args[0] === 'bootstrap') assert.ok(remaining < 0, 'bootstrap must wait for confirmed service absence');
    return {};
  } });
  assert.deepEqual(calls, ['print', 'bootout', 'print', 'print', 'print', 'bootstrap']);
  assert.equal(await readFile(path.join(paths.app, 'public/index.html'), 'utf8'), 'new version');
});

test('unload timeout leaves the installed runtime intact and does not bootstrap', async t => {
  const { options, paths } = await fixture(t), calls = [];
  await writeFile(path.join(options.appRoot, 'public/index.html'), 'new version');
  await assert.rejects(installService({ ...options, unloadTimeoutMs: 0,
    command: async (_command, args) => { calls.push(args[0]); return { stdout: 'state = waiting\n' }; },
  }), /still stopping/);
  assert.deepEqual(calls, ['print', 'bootout', 'print']);
  assert.equal(await readFile(path.join(paths.app, 'public/index.html'), 'utf8'), 'old version');
});

test('unload inspection failures are not mistaken for service absence', async t => {
  const { options, paths } = await fixture(t), calls = [];
  await writeFile(path.join(options.appRoot, 'public/index.html'), 'new version');
  await assert.rejects(installService({ ...options, command: async (_command, args) => {
    calls.push(args[0]);
    if (args[0] === 'print' && calls.length > 1) throw Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' });
    return {};
  } }), /Could not confirm/);
  assert.deepEqual(calls, ['print', 'bootout', 'print']);
  assert.equal(await readFile(path.join(paths.app, 'public/index.html'), 'utf8'), 'old version');
});

test('bootstrap failure cannot reuse an unloading registration even if an old server briefly answers', async t => {
  const { options } = await fixture(t, false), calls = [];
  let printed = false;
  await assert.rejects(installService({ ...options, open: true, command: async (_command, args) => {
    calls.push(args[0]);
    if (args[0] === 'bootstrap') throw new Error('Registration collision');
    if (args[0] === 'print' && !printed) { printed = true; throw absent(); }
    return { stdout: 'state = waiting\n' };
  } }), /Could not start Duet/);
  assert.deepEqual(calls, ['print', 'bootstrap', 'print']);
});

test('a concurrent successful launcher can be reused only after readiness and a running registration', async t => {
  const { options } = await fixture(t, false), calls = [];
  let printed = false;
  const result = await installService({ ...options, open: true,
    wait: async () => { calls.push('ready'); }, command: async (_command, args) => {
      calls.push(args[0]);
      if (args[0] === 'bootstrap') throw new Error('Already registered by another launch');
      if (args[0] === 'print' && !printed) { printed = true; throw absent(); }
      return { stdout: 'state = running\npid = 12345\n' };
    },
  });
  assert.equal(result.origin, 'http://127.0.0.1:63121');
  assert.deepEqual(calls, ['print', 'bootstrap', 'ready', 'print', 'ready', result.url]);
});
