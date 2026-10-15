import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readlink, stat, rm, readdir } from 'node:fs/promises';
import { bootstrapMac, bootstrapErrorMessage, installBundledRuntime } from '../../src/bootstrap-mac.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duet-beta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleDir = path.join(root, 'Downloaded Beta'), home = path.join(root, 'Friend');
  const source = path.join(bundleDir, 'runtimes/darwin-arm64');
  await mkdir(path.join(source, 'bin'), { recursive: true });
  await mkdir(path.join(source, 'lib/node_modules/npm/bin'), { recursive: true });
  const bytes = 'test-runtime';
  await writeFile(path.join(source, 'bin/node'), bytes);
  await writeFile(path.join(source, 'lib/node_modules/npm/bin/npm-cli.js'), 'test-npm');
  await symlink('../lib/node_modules/npm/bin/npm-cli.js', path.join(source, 'bin/npm'));
  const manifest = { format: 1, nodeVersion: 'v22.23.3', minimumMacOS: '13', runtimes: {
    'darwin-arm64': { archiveSha256: 'a'.repeat(64), nodeSha256: createHash('sha256').update(bytes).digest('hex') },
  } };
  await writeFile(path.join(bundleDir, 'distribution.json'), JSON.stringify(manifest));
  return { root, home, bundleDir, arch: 'arm64', source };
}

test('runtime installs permanently without needing Node or retaining links to Downloads', async t => {
  const input = await fixture(t);
  const node = await installBundledRuntime(input);
  assert.ok(node.startsWith(path.join(input.home, 'Library/Application Support/Duet/runtime')));
  assert.equal((await stat(node)).mode & 0o777, 0o755);
  assert.equal(await readlink(path.join(path.dirname(node), 'npm')), '../lib/node_modules/npm/bin/npm-cli.js');
  await rm(input.bundleDir, { recursive: true });
  assert.equal(await readFile(node, 'utf8'), 'test-runtime');
  assert.equal(await readFile(path.join(path.dirname(node), 'npm'), 'utf8'), 'test-npm');
});

test('reopening reuses verified runtime and never overwrites damaged installed files', async t => {
  const input = await fixture(t);
  const node = await installBundledRuntime(input);
  const originalStat = await stat(node);
  assert.equal(await installBundledRuntime(input), node);
  assert.equal((await stat(node)).ino, originalStat.ino);
  await writeFile(node, 'unexpected');
  await assert.rejects(installBundledRuntime(input), /has not been overwritten/);
  assert.equal(await readFile(node, 'utf8'), 'unexpected');
});

test('simultaneous launches converge on one complete installed runtime', async t => {
  const input = await fixture(t);
  const nodes = await Promise.all([installBundledRuntime(input), installBundledRuntime(input)]);
  assert.equal(nodes[0], nodes[1]);
  assert.equal(await readFile(nodes[0], 'utf8'), 'test-runtime');
  const folders = await readdir(path.resolve(path.dirname(nodes[0]), '../..'));
  assert.equal(folders.length, 1);
  assert.ok(!folders[0].startsWith('.install-'));
});

test('tampered downloads and unsupported architecture are rejected before permanent installation', async t => {
  const input = await fixture(t);
  await writeFile(path.join(input.source, 'bin/node'), 'corrupt');
  await assert.rejects(installBundledRuntime(input), /damaged/);
  await assert.rejects(installBundledRuntime({ ...input, arch: '../x64' }), /not supported/);
});

test('bootstrap relaunches installed node and passes argument paths safely', async t => {
  const input = await fixture(t);
  const calls = [];
  const result = await bootstrapMac({ ...input, platform: 'darwin', run: async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; } });
  assert.equal(result.relaunched, true);
  assert.equal(calls[0][0], result.nodePath);
  assert.deepEqual(calls[0][1], [path.join(input.bundleDir, 'app/src/bootstrap-mac.mjs'), '--bundle', input.bundleDir, '--arch', 'arm64', '--installed']);
});

test('a subprocess service conflict reports its explanation and help once without the launch command', async t => {
  const input = await fixture(t);
  const conflict = new Error('A Duet background service is already registered with a different location or port.');
  const childMessage = bootstrapErrorMessage(conflict);
  const childError = Object.assign(new Error(`Command failed: /private/local-runtime/node /private/download/bootstrap-mac.mjs\n${childMessage}`),
    { code: 1, stderr: `${childMessage}\n` });
  await assert.rejects(bootstrapMac({ ...input, platform: 'darwin', run: async () => { throw childError; } }), error => {
    const displayed = bootstrapErrorMessage(error);
    assert.equal(displayed, childMessage);
    assert.equal(displayed.match(/did not stop/g)?.length, 1);
    assert.doesNotMatch(displayed, /Command failed|\/private\/|bootstrap-mac\.mjs/);
    assert.equal(error.code, 1);
    return true;
  });
});

test('a runtime launch failure without child output uses a readable error without local paths', async t => {
  const input = await fixture(t);
  await assert.rejects(bootstrapMac({ ...input, platform: 'darwin', run: async () => {
    throw Object.assign(new Error('spawn /private/download/runtime/bin/node EACCES'), { code: 'EACCES', stderr: '' });
  } }), error => {
    assert.match(bootstrapErrorMessage(error), /runtime could not start/);
    assert.doesNotMatch(bootstrapErrorMessage(error), /\/private\/|EACCES/);
    assert.equal(error.code, 'EACCES');
    return true;
  });
});

test('installed bootstrap supplies stable node and friend-owned paths; installer rejection propagates', async t => {
  const input = await fixture(t);
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  let received;
  await bootstrapMac({ ...input, platform: 'darwin', installed: true, logger: { log() {} },
    installer: async options => { received = options; return { origin: 'http://127.0.0.1:63121' }; } });
  assert.equal(received.home, input.home);
  assert.equal(received.appRoot, path.join(input.bundleDir, 'app'));
  assert.equal(received.open, true);
  assert.ok(received.nodePath.startsWith(input.home));
  assert.ok(process.env.PATH.includes(path.join(input.home, 'Library/Application Support/Duet/Tools/bin')));
  await assert.rejects(bootstrapMac({ ...input, platform: 'darwin', installed: true,
    installer: async () => { throw new Error('A Duet background service is already registered with a different location or port.'); } }), /different location or port/);
});
