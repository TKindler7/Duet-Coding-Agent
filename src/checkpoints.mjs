import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const checkpointLimits = Object.freeze({ maxFiles: 5000, maxBytes: 256 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024 });
const excludedNames = new Set(['.git', '.duet', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output', '.cache', '.turbo', '.parcel-cache', 'target', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.aws', '.azure', '.ssh', '.gnupg', '.gcloud', '.ds_store', '.npmrc', '.pypirc', '.netrc', '.envrc', 'credentials.json', 'secrets.json']);
const idPattern = /^\d{8}T\d{9}Z-[a-f0-9]{16}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = message => Object.assign(new Error(message), { code: 'DUET_CHECKPOINT' });
const absent = async filename => { try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
function excluded(name) { return excludedNames.has(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name); }
function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\\\x00-\x1f\x7f]/.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !excluded(part)) && !path.isAbsolute(value);
}
function limitsFor(overrides = {}) {
  const result = { ...checkpointLimits, ...overrides };
  for (const [name, value] of Object.entries(result)) if (!(name in checkpointLimits) || !Number.isSafeInteger(value) || value < 1 || value > checkpointLimits[name]) throw failure(`Invalid checkpoint limit: ${name}.`);
  return result;
}
async function rootFor(project, create = false) {
  if (typeof project !== 'string' || !project) throw failure('Choose a project folder before making a checkpoint.');
  const root = await realpath(project);
  if (!(await lstat(root)).isDirectory()) throw failure('The checkpoint project must be a folder.');
  for (const relative of ['.duet', '.duet/checkpoints']) {
    const filename = path.join(root, relative);
    let info = await absent(filename);
    if (!info && create) { await mkdir(filename, { mode: 0o700 }); info = await lstat(filename); }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw failure('Checkpoint storage must be a normal folder, never a symbolic link.');
  }
  return root;
}
async function ensureParents(root, relative, { create = false } = {}) {
  const parts = relative.split('/').slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let info = await absent(current);
    if (!info && create) { await mkdir(current, { mode: 0o755 }); info = await lstat(current); }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw failure(`Cannot safely restore ${relative}: a parent is not a normal folder.`);
  }
}
async function readSafe(root, relative, maxBytes = checkpointLimits.maxFileBytes) {
  await ensureParents(root, relative);
  const handle = await open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw failure(`Checkpoint file is unsupported or exceeds the ${maxBytes} byte limit: ${relative}`);
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.length > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw failure(`The project changed while saving ${relative}. Stop other edits and try again.`);
    return { data, bytes: data.length, sha256: digest(data), mode: before.mode & 0o777 };
  } finally { await handle.close(); }
}
async function scan(root, limits, onFile = async () => {}) {
  const entries = [];
  const names = new Set();
  let bytes = 0, directories = 0;
  async function visit(relative = '') {
    if (++directories > 20000) throw failure('This project exceeds the checkpoint limit of 20,000 folders. Move generated folders out of the project, then try again.');
    if (relative) {
      await ensureParents(root, `${relative}/placeholder`);
      if (!(await lstat(path.join(root, relative))).isDirectory()) throw failure('The project changed while checking its folders. Try again.');
    }
    for (const item of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded(item.name) || item.isSymbolicLink()) continue;
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (!safeRelative(name)) throw failure(`Cannot safely checkpoint this filename: ${name}`);
      const normalizedName = name.normalize('NFC').toLowerCase();
      if (names.has(normalizedName)) throw failure(`Checkpoint filenames must be distinct on macOS: ${name}`);
      names.add(normalizedName);
      if (item.isDirectory()) { await visit(name); continue; }
      if (!item.isFile()) throw failure(`Checkpoint does not support this special file: ${name}`);
      if (entries.length >= limits.maxFiles) throw failure(`This project exceeds the checkpoint limit of ${limits.maxFiles} files. Move generated files out of the project, then try again.`);
      const file = await readSafe(root, name, limits.maxFileBytes);
      bytes += file.bytes;
      if (bytes > limits.maxBytes) throw failure(`This project exceeds the checkpoint limit of ${limits.maxBytes} bytes. Move large assets out of the project, then try again.`);
      const entry = { path: name, sha256: file.sha256, bytes: file.bytes, mode: file.mode };
      entries.push(entry);
      await onFile(entry, file.data);
    }
  }
  await visit();
  return { entries, bytes };
}
const treeDigest = entries => digest(JSON.stringify(entries));
const summary = manifest => ({ id: manifest.id, createdAt: manifest.createdAt, label: manifest.label, ...(manifest.runId ? { runId: manifest.runId } : {}), fileCount: manifest.entries.length, bytes: manifest.entries.reduce((total, entry) => total + entry.bytes, 0) });
async function withCheckpointLock(root, work) {
  const lockFile = path.join(root, '.duet/checkpoint.lock');
  let handle;
  try { handle = await open(lockFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw failure('Another checkpoint operation is running. Try again when it finishes.'); throw error; }
  try { return await work(); }
  finally { await handle.close(); await unlink(lockFile); }
}
async function createUnlocked(root, { label = 'Project checkpoint', runId, limits = {} } = {}) {
  const actualLimits = limitsFor(limits);
  if (typeof label !== 'string' || label.length > 200 || /[\x00-\x1f]/.test(label)) throw failure('Checkpoint labels must be short, plain text.');
  if (runId !== undefined && (typeof runId !== 'string' || runId.length > 200 || /[\x00-\x1f]/.test(runId))) throw failure('Invalid checkpoint run ID.');
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[-:.]/g, '')}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const staging = path.join(root, '.duet/checkpoints', `.saving-${id}`);
  await mkdir(staging, { mode: 0o700 });
  await mkdir(path.join(staging, 'objects'), { mode: 0o700 });
  try {
    const snapshot = await scan(root, actualLimits, async (entry, data) => writeFile(path.join(staging, 'objects', entry.sha256), data, { mode: 0o600 }));
    const current = await scan(root, actualLimits);
    if (treeDigest(snapshot.entries) !== treeDigest(current.entries)) throw failure('The project changed while making a checkpoint. Stop other edits and try again.');
    const manifest = { version: 1, id, createdAt, label: label || 'Project checkpoint', ...(runId ? { runId } : {}), entries: snapshot.entries, treeHash: treeDigest(snapshot.entries) };
    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    await rename(staging, path.join(root, '.duet/checkpoints', id));
    return summary(manifest);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
export async function createCheckpoint(project, options = {}) {
  const root = await rootFor(project, true);
  return withCheckpointLock(root, () => createUnlocked(root, options));
}
async function loadManifest(root, id, { verifyObjects = false } = {}) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw failure('Invalid checkpoint ID.');
  const relative = `.duet/checkpoints/${id}`;
  const directory = await absent(path.join(root, relative));
  if (!directory?.isDirectory() || directory.isSymbolicLink()) throw failure('This checkpoint is missing or is not a safe folder.');
  let manifest;
  try { manifest = JSON.parse((await readSafe(root, `${relative}/manifest.json`, 8 * 1024 * 1024)).data.toString('utf8')); }
  catch (error) { throw failure(`Cannot read this checkpoint: ${error.message}`); }
  if (manifest.version !== 1 || manifest.id !== id || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || typeof manifest.label !== 'string' || manifest.label.length > 200 || (manifest.runId !== undefined && (typeof manifest.runId !== 'string' || manifest.runId.length > 200)) || !Array.isArray(manifest.entries) || manifest.entries.length > checkpointLimits.maxFiles) throw failure('This checkpoint has invalid metadata.');
  const paths = new Set(), normalizedPaths = new Set(), normalizedNodes = new Map();
  let bytes = 0;
  for (const entry of manifest.entries) {
    if (!entry || !safeRelative(entry.path) || !hashPattern.test(entry.sha256) || !Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > checkpointLimits.maxFileBytes || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || paths.has(entry.path) || normalizedPaths.has(entry.path.normalize('NFC').toLowerCase())) throw failure('This checkpoint contains an unsafe or invalid file entry.');
    paths.add(entry.path); normalizedPaths.add(entry.path.normalize('NFC').toLowerCase()); bytes += entry.bytes;
    const parts = entry.path.split('/');
    for (let end = 1; end <= parts.length; end++) {
      const spelling = parts.slice(0, end).join('/'), normalized = spelling.normalize('NFC').toLowerCase();
      if (normalizedNodes.has(normalized) && normalizedNodes.get(normalized) !== spelling) throw failure('This checkpoint contains conflicting macOS path names.');
      normalizedNodes.set(normalized, spelling);
    }
    if (bytes > checkpointLimits.maxBytes) throw failure('This checkpoint exceeds the safe restore size limit.');
    if (verifyObjects) {
      const file = await readSafe(root, `${relative}/objects/${entry.sha256}`);
      if (file.sha256 !== entry.sha256 || file.bytes !== entry.bytes) throw failure(`This checkpoint is damaged: ${entry.path}. No files have been restored.`);
    }
  }
  for (const file of paths) {
    const parts = file.split('/');
    for (let end = 1; end < parts.length; end++) if (normalizedPaths.has(parts.slice(0, end).join('/').normalize('NFC').toLowerCase())) throw failure('This checkpoint contains conflicting paths.');
  }
  if (manifest.treeHash !== treeDigest(manifest.entries)) throw failure('This checkpoint manifest is damaged. No files have been restored.');
  return manifest;
}
export async function listCheckpoints(project) {
  const root = await rootFor(project);
  const folder = path.join(root, '.duet/checkpoints');
  if (!await absent(folder)) return [];
  const result = [];
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (!idPattern.test(item.name) || !item.isDirectory() || item.isSymbolicLink()) continue;
    try { result.push(summary(await loadManifest(root, item.name))); }
    catch (error) { if (error.code !== 'DUET_CHECKPOINT' && error.code !== 'ENOENT') throw error; }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
async function assertExpected(root, relative, expected) {
  await ensureParents(root, relative);
  const info = await absent(path.join(root, relative));
  if (!expected) { if (info) throw failure(`The project changed before restoring ${relative}. Try again after stopping other edits.`); return; }
  if (!info?.isFile() || info.isSymbolicLink()) throw failure(`Cannot safely restore ${relative}: it is no longer a normal file.`);
  const current = await readSafe(root, relative);
  if (current.sha256 !== expected.sha256 || current.mode !== expected.mode) throw failure(`The project changed before restoring ${relative}. Try again after stopping other edits.`);
}
async function replaceFile(root, entry, data) {
  await ensureParents(root, entry.path, { create: true });
  const temporary = `${entry.path}.duet-restore-${randomUUID()}`;
  const filename = path.join(root, temporary);
  try {
    await writeFile(filename, data, { flag: 'wx', mode: entry.mode });
    // chmod through the open handle preserves executability even with a restrictive umask.
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.chmod(entry.mode); } finally { await handle.close(); }
    await ensureParents(root, entry.path);
    await rename(filename, path.join(root, entry.path));
  } finally { await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function restoreCheckpoint(project, id) {
  const root = await rootFor(project, true);
  const activeFile = path.join(root, '.duet/active.lock');
  let active;
  try { active = await open(activeFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw failure('Stop the active build before restoring a checkpoint.'); throw error; }
  try {
    await active.writeFile(JSON.stringify({ operation: 'checkpoint-restore', pid: process.pid, startedAt: new Date().toISOString() }));
    return await withCheckpointLock(root, async () => {
      const target = await loadManifest(root, id, { verifyObjects: true });
      for (const entry of target.entries) {
        await ensureParents(root, entry.path);
        const info = await absent(path.join(root, entry.path));
        if (info && (!info.isFile() || info.isSymbolicLink())) throw failure(`Cannot safely restore ${entry.path}: a folder, link, or special file is in its place. Move it first; your files have not changed.`);
      }
      const backup = await createUnlocked(root, { label: `Before restoring ${target.label}`.slice(0, 200) });
      const original = await loadManifest(root, backup.id, { verifyObjects: true });
      const before = new Map(original.entries.map(entry => [entry.path, entry]));
      const desired = new Map(target.entries.map(entry => [entry.path, entry]));
      const changes = [...new Set([...before.keys(), ...desired.keys()])].filter(name => before.get(name)?.sha256 !== desired.get(name)?.sha256 || before.get(name)?.mode !== desired.get(name)?.mode);
      const applied = [];
      try {
        const current = await scan(root, checkpointLimits);
        if (treeDigest(current.entries) !== original.treeHash) throw failure('The project changed before restore. Stop other edits and try again.');
        for (const name of changes) await assertExpected(root, name, before.get(name));
        for (const name of changes) {
          await assertExpected(root, name, before.get(name));
          const entry = desired.get(name);
          if (entry) {
            const file = await readSafe(root, `.duet/checkpoints/${target.id}/objects/${entry.sha256}`);
            if (file.sha256 !== entry.sha256 || file.bytes !== entry.bytes) throw failure('Checkpoint data changed during restore.');
            await replaceFile(root, entry, file.data);
          } else { await unlink(path.join(root, name)); }
          applied.push(name);
        }
        const restored = await scan(root, checkpointLimits);
        if (treeDigest(restored.entries) !== target.treeHash) throw failure('The project changed during restore. The selected checkpoint could not be verified.');
        return { restored: summary(target), backup };
      } catch (cause) {
        const rollbackErrors = [];
        for (const name of applied.reverse()) {
          try {
            await assertExpected(root, name, desired.get(name));
            const entry = before.get(name);
            if (entry) {
              const file = await readSafe(root, `.duet/checkpoints/${backup.id}/objects/${entry.sha256}`);
              if (file.sha256 !== entry.sha256 || file.bytes !== entry.bytes) throw failure('The safety backup was damaged.');
              await replaceFile(root, entry, file.data);
            } else { await unlink(path.join(root, name)); }
          } catch (error) { rollbackErrors.push(error.message); }
        }
        const error = failure(`${cause.message} ${rollbackErrors.length ? 'Some files could not be rolled back; use the saved safety checkpoint to recover.' : 'Any completed file changes were rolled back.'} Safety checkpoint: ${backup.id}.`);
        error.backup = backup;
        error.rollbackErrors = rollbackErrors;
        throw error;
      }
    });
  } finally { await active.close(); await unlink(activeFile); }
}
