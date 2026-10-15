import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, lstat, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from '../src/checkpoints.mjs';

async function fixture(t) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'duet-checkpoints-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}
async function put(project, name, content) {
  await mkdir(path.dirname(path.join(project, name)), { recursive: true });
  await writeFile(path.join(project, name), content);
}
const get = (project, name) => readFile(path.join(project, name), 'utf8');
const manifestFile = (project, id) => path.join(project, '.duet/checkpoints', id, 'manifest.json');
async function editManifest(project, id, transform) {
  const manifest = JSON.parse(await readFile(manifestFile(project, id), 'utf8'));
  transform(manifest);
  manifest.treeHash = createHash('sha256').update(JSON.stringify(manifest.entries)).digest('hex');
  await writeFile(manifestFile(project, id), JSON.stringify(manifest));
}

test('checkpoints restore edits, deleted files, untracked files, and executable permissions with a recoverable safety backup', async t => {
  const project = await fixture(t);
  await put(project, 'src/main.js', 'before');
  await put(project, 'untracked.txt', 'original untracked');
  await put(project, 'script.sh', '#!/bin/sh\ntrue\n');
  await chmod(path.join(project, 'script.sh'), 0o755);
  const checkpoint = await createCheckpoint(project, { label: 'Working version', runId: 'run-123' });
  assert.equal(checkpoint.fileCount, 3);
  assert.equal(checkpoint.runId, 'run-123');
  await put(project, 'src/main.js', 'after');
  await put(project, 'new/file.txt', 'new work');
  await rm(path.join(project, 'untracked.txt'));
  await chmod(path.join(project, 'script.sh'), 0o644);
  const result = await restoreCheckpoint(project, checkpoint.id);
  assert.equal(result.restored.id, checkpoint.id);
  assert.equal(result.backup.fileCount, 3);
  assert.equal(await get(project, 'src/main.js'), 'before');
  assert.equal(await get(project, 'untracked.txt'), 'original untracked');
  assert.equal((await lstat(path.join(project, 'script.sh'))).mode & 0o777, 0o755);
  await assert.rejects(access(path.join(project, 'new/file.txt')));
  await assert.rejects(access(path.join(project, '.duet/active.lock')));
  await restoreCheckpoint(project, result.backup.id);
  assert.equal(await get(project, 'src/main.js'), 'after');
  assert.equal(await get(project, 'new/file.txt'), 'new work');
  await assert.rejects(access(path.join(project, 'untracked.txt')));
  assert.equal((await listCheckpoints(project)).length, 3);
});

test('credentials, generated folders, and symlinks stay outside snapshots and survive restoration', async t => {
  const project = await fixture(t), external = await fixture(t);
  await put(project, 'main.txt', 'original');
  const ignored = ['.env', '.env.local', '.git/config', '.duet/private.txt', 'node_modules/module/index.js', 'dist/bundle.js', 'nested/.cache/item', '.npmrc', 'private.key', 'credentials.json'];
  for (const filename of ignored) await put(project, filename, 'private');
  await put(external, 'secret.txt', 'outside');
  await symlink(external, path.join(project, 'outside-link'));
  await symlink(path.join(external, 'secret.txt'), path.join(project, 'file-link'));
  const checkpoint = await createCheckpoint(project);
  assert.equal(checkpoint.fileCount, 1);
  for (const filename of ignored) await put(project, filename, 'updated private');
  await put(project, 'main.txt', 'changed');
  await restoreCheckpoint(project, checkpoint.id);
  for (const filename of ignored) assert.equal(await get(project, filename), 'updated private');
  assert.equal(await get(external, 'secret.txt'), 'outside');
  assert.ok((await lstat(path.join(project, 'outside-link'))).isSymbolicLink());
  assert.ok((await lstat(path.join(project, 'file-link'))).isSymbolicLink());
});

test('an empty project is a valid checkpoint and can undo the first build', async t => {
  const project = await fixture(t);
  assert.deepEqual(await listCheckpoints(project), []);
  const checkpoint = await createCheckpoint(project);
  assert.equal(checkpoint.fileCount, 0);
  await put(project, 'index.html', 'first app');
  const result = await restoreCheckpoint(project, checkpoint.id);
  await assert.rejects(access(path.join(project, 'index.html')));
  assert.equal(result.backup.fileCount, 1);
});

test('existing active locks prevent restore without touching work or the lock', async t => {
  const project = await fixture(t);
  await put(project, 'file.txt', 'original');
  const checkpoint = await createCheckpoint(project);
  await put(project, 'file.txt', 'current');
  await put(project, '.duet/active.lock', 'existing run');
  await assert.rejects(restoreCheckpoint(project, checkpoint.id), /Stop the active build/);
  assert.equal(await get(project, 'file.txt'), 'current');
  assert.equal(await get(project, '.duet/active.lock'), 'existing run');
  // Builds may make a checkpoint after taking the build lock.
  assert.equal((await createCheckpoint(project)).fileCount, 1);
});

test('snapshot size and file limits fail clearly and never publish partial checkpoints', async t => {
  const project = await fixture(t);
  await put(project, 'one.txt', '12345');
  await put(project, 'two.txt', 'abcde');
  await assert.rejects(createCheckpoint(project, { limits: { maxFiles: 1 } }), /limit of 1 files/);
  await assert.rejects(createCheckpoint(project, { limits: { maxBytes: 8 } }), /limit of 8 bytes/);
  await assert.rejects(createCheckpoint(project, { limits: { maxFileBytes: 4 } }), /4 byte limit/);
  assert.deepEqual(await listCheckpoints(project), []);
  assert.equal(await get(project, 'one.txt'), '12345');
  await assert.rejects(access(path.join(project, '.duet/checkpoint.lock')));
});

test('unsafe manifest paths, excluded paths, and malicious checkpoint IDs cannot write outside the project', async t => {
  for (const unsafe of ['../escaped.txt', '/tmp/duet-escaped.txt', 'sub/../../escaped.txt', '.env', '.duet/active.lock', 'bad\\path', 'node_modules/file']) {
    const project = await fixture(t);
    await put(project, 'file.txt', 'original');
    const checkpoint = await createCheckpoint(project);
    await put(project, 'file.txt', 'current');
    await editManifest(project, checkpoint.id, manifest => { manifest.entries[0].path = unsafe; });
    await assert.rejects(restoreCheckpoint(project, checkpoint.id), /unsafe|invalid/);
    assert.equal(await get(project, 'file.txt'), 'current');
    assert.deepEqual(await listCheckpoints(project), []);
  }
  const project = await fixture(t);
  for (const id of ['../outside', '/tmp/example', '', null]) await assert.rejects(restoreCheckpoint(project, id), /Invalid checkpoint ID/);
});

test('damaged snapshot bytes and manifest hashes fail before restoring any file', async t => {
  for (const damage of ['object', 'manifest']) {
    const project = await fixture(t);
    await put(project, 'file.txt', 'original');
    const checkpoint = await createCheckpoint(project);
    await put(project, 'file.txt', 'current');
    const manifest = JSON.parse(await readFile(manifestFile(project, checkpoint.id), 'utf8'));
    if (damage === 'object') await put(project, `.duet/checkpoints/${checkpoint.id}/objects/${manifest.entries[0].sha256}`, 'corrupt!');
    else { manifest.entries[0].mode = 0o755; await writeFile(manifestFile(project, checkpoint.id), JSON.stringify(manifest)); }
    await assert.rejects(restoreCheckpoint(project, checkpoint.id), /damaged/);
    assert.equal(await get(project, 'file.txt'), 'current');
    await assert.rejects(access(path.join(project, '.duet/active.lock')));
  }
});

test('case aliases and file-parent collisions in edited metadata are rejected before restore', async t => {
  for (const alias of ['FILE.TXT', 'file.txt/child']) {
    const project = await fixture(t);
    await put(project, 'file.txt', 'original');
    const checkpoint = await createCheckpoint(project);
    await put(project, 'file.txt', 'current');
    await editManifest(project, checkpoint.id, manifest => { manifest.entries.push({ ...manifest.entries[0], path: alias }); });
    await assert.rejects(restoreCheckpoint(project, checkpoint.id), /invalid|conflicting/);
    assert.equal(await get(project, 'file.txt'), 'current');
  }
});

test('symlinked storage, snapshot objects, restore targets, and parents are rejected safely', async t => {
  const external = await fixture(t);
  await put(external, 'file.txt', 'external');
  const project = await fixture(t);
  await symlink(external, path.join(project, '.duet'));
  await assert.rejects(createCheckpoint(project), /never a symbolic link/);
  for (const scenario of ['target', 'parent', 'objects', 'snapshot']) {
    const folder = await fixture(t);
    await put(folder, 'nested/file.txt', 'original');
    const checkpoint = await createCheckpoint(folder);
    const checkpointDir = path.join(folder, '.duet/checkpoints', checkpoint.id);
    if (scenario === 'target') {
      await rm(path.join(folder, 'nested/file.txt'));
      await symlink(path.join(external, 'file.txt'), path.join(folder, 'nested/file.txt'));
    } else if (scenario === 'parent') {
      await rm(path.join(folder, 'nested'), { recursive: true });
      await symlink(external, path.join(folder, 'nested'));
    } else if (scenario === 'objects') {
      await rm(path.join(checkpointDir, 'objects'), { recursive: true });
      await symlink(external, path.join(checkpointDir, 'objects'));
    } else {
      await rm(checkpointDir, { recursive: true });
      await symlink(external, checkpointDir);
    }
    await assert.rejects(restoreCheckpoint(folder, checkpoint.id), /safe|normal folder/);
    assert.equal(await get(external, 'file.txt'), 'external');
  }
});

test('file-versus-folder conflicts fail without deleting current work', async t => {
  const project = await fixture(t);
  await put(project, 'component', 'original file');
  const checkpoint = await createCheckpoint(project);
  await rm(path.join(project, 'component'));
  await put(project, 'component/new.txt', 'current file');
  await assert.rejects(restoreCheckpoint(project, checkpoint.id), /Move it first/);
  assert.equal(await get(project, 'component/new.txt'), 'current file');
});
