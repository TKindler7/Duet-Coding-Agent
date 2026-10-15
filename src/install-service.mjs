import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, rename, chmod, access, readdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readServerConfig, waitForServer } from './lifecycle.mjs';
import { toolPath } from './setup.mjs';

export const SERVICE_LABEL = 'local.duet.server';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

export function installationPaths(home) {
  const support = path.join(home, 'Library', 'Application Support', 'Duet');
  return { support, app: path.join(support, 'app'), data: path.join(support, 'data'),
    logs: path.join(support, 'logs'), projects: path.join(support, 'Projects') };
}

async function savedConnection(dataDir, origin) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const value = JSON.parse(await readFile(path.join(dataDir, 'server.json'), 'utf8'));
      if (value.origin === origin && /^[a-f0-9]{64}$/i.test(value.token)) return value;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Duet started but its local connection details were not saved. Check its Application Support/Duet/logs folder.');
}

export async function bundleContents(appRoot) {
  const files = new Map();
  async function visit(relative) {
    const entries = await readdir(path.join(appRoot, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.set(file, await readFile(path.join(appRoot, file)));
      else throw new Error(`The Duet bundle contains an unsupported link: ${file}`);
    }
  }
  await visit('src'); await visit('public');
  files.set('package.json', await readFile(path.join(appRoot, 'package.json')));
  const hash = createHash('sha256');
  for (const [file, content] of files) hash.update(file).update('\0').update(content).update('\0');
  return { files, digest: hash.digest('hex') };
}

export async function deployRuntime({ appRoot, paths, bundle }) {
  for (const directory of [paths.app, paths.data, paths.logs, paths.projects]) await mkdir(directory, { recursive: true, mode: 0o700 });
  // Import only once. The original data stays untouched as a backup, and newer
  // installed chats always win on subsequent launches or source updates.
  for (const name of ['server.json', 'history.json', 'conversations.json']) {
    try {
      await copyFile(path.join(appRoot, 'data', name), path.join(paths.data, name), constants.COPYFILE_EXCL);
      await chmod(path.join(paths.data, name), 0o600);
    } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
  }
  for (const [relative, content] of bundle.files) {
    const destination = path.join(paths.app, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temp = `${destination}.${process.pid}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, destination);
  }
  await writeFile(path.join(paths.app, '.bundle-sha256'), bundle.digest, { mode: 0o600 });
}

export function launchAgentPlist({ appRoot, nodePath, home, port, dataDir = path.join(appRoot, 'data'),
  logsDir = dataDir, workingDirectory = appRoot, projectRoot }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(nodePath)}</string><string>${xml(path.join(appRoot, 'src/web.mjs'))}</string><string>--service</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(toolPath(home, nodePath))}</string>
    <key>DUET_PORT</key><string>${xml(port)}</string>
    <key>DUET_DATA_DIR</key><string>${xml(dataDir)}</string>
    ${projectRoot ? `<key>DUET_PROJECT_ROOT</key><string>${xml(projectRoot)}</string>` : ''}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(logsDir, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsDir, 'server-error.log'))}</string>
</dict></plist>
`;
}

// Older personal installs used the user's Node executable. The shareable beta
// supplies its own permanent runtime. This is still the same service when only
// Node and PATH differ; all application/data locations and other fields must
// remain byte-for-byte identical. Never use this to migrate an unrelated job.
export function compatibleRuntimeUpdate(previous, next) {
  if (typeof previous !== 'string') return false;
  const pathField = /<key>PATH<\/key><string>[^<]*<\/string>/;
  const executable = /(<key>ProgramArguments<\/key><array>\s*<string>)([^<]*)(<\/string>)/;
  const oldNode = previous.match(executable), newNode = next.match(executable);
  if (!oldNode || !newNode || ![oldNode[2], newNode[2]].every(value => value.startsWith('/') && value.endsWith('/node'))) return false;
  const newPath = next.match(pathField);
  if (!newPath || !previous.match(pathField)) return false;
  return previous.replace(executable, () => newNode[0]).replace(pathField, () => newPath[0]) === next;
}

async function waitForUnload(command, target, { timeoutMs, sleep }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await command('/bin/launchctl', ['print', target], { timeout: 5000 }); }
    catch (error) {
      // launchctl exits with code 113 when this service is absent. A timeout,
      // permissions failure, or unavailable GUI domain does not confirm unload.
      if (error.code === 113 || /Could not find service \"[^\"]+\" in domain/.test(error.stderr ?? '')) return;
      throw new Error('Could not confirm that the previous Duet service stopped. Reopen Duet and try again.');
    }
    if (Date.now() >= deadline) throw new Error('Duet is still stopping its previous service. Wait a moment, then reopen Duet.');
    await sleep(200);
  }
}

const runningRegistration = result => /^\s*state = running\s*$/m.test(result?.stdout ?? '')
  && /^\s*pid = [1-9]\d*\s*$/m.test(result?.stdout ?? '');

export async function installService({ appRoot = root, home = os.homedir(), nodePath = process.execPath,
  uid = process.getuid?.(), platform = process.platform, command = run, wait = waitForServer,
  fetchImpl = fetch, port = process.env.DUET_PORT, open = false,
  unloadTimeoutMs = 25_000, sleep = pause } = {}) {
  if (platform !== 'darwin') throw new Error('The Duet app launcher requires macOS. On other systems, run node src/web.mjs.');
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(appRoot) || !path.isAbsolute(home)) throw new Error('Duet requires absolute paths for its local service.');
  if (!Number.isInteger(uid) || uid < 0) throw new Error('Could not determine the current macOS user.');
  await access(path.join(appRoot, 'src/web.mjs'));
  const paths = installationPaths(home), bundle = await bundleContents(appRoot);
  let configSource = paths.data;
  try { await access(path.join(paths.data, 'server.json')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    configSource = path.join(appRoot, 'data');
  }
  const config = await readServerConfig(configSource, { port });
  const contents = launchAgentPlist({ appRoot: paths.app, home, nodePath, port: config.port,
    dataDir: paths.data, logsDir: paths.logs, workingDirectory: paths.support, projectRoot: paths.projects });
  const agentDir = path.join(home, 'Library', 'LaunchAgents');
  const agentFile = path.join(agentDir, `${SERVICE_LABEL}.plist`);
  const domain = `gui/${uid}`, target = `${domain}/${SERVICE_LABEL}`;
  let loaded = false;
  try { await command('/bin/launchctl', ['print', target], { timeout: 5000 }); loaded = true; } catch {}
  let previous, installedDigest;
  try { previous = await readFile(agentFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { installedDigest = await readFile(path.join(paths.app, '.bundle-sha256'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (loaded && previous !== contents && !compatibleRuntimeUpdate(previous, contents)) {
    throw new Error('A Duet background service is already registered with a different location or port. Stop that Duet service before reinstalling it; saved chats will be preserved.');
  }
  let updatePending = false;
  if (loaded && (installedDigest !== bundle.digest || previous !== contents)) {
    // Never replace a live runtime or interrupt an active turn just to update.
    let state;
    try {
      const response = await fetchImpl(config.origin + '/api/state', {
        headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('Could not authenticate to the running service.');
      state = await response.json();
    } catch (error) { throw new Error(`Could not safely check Duet before updating: ${error.message}`); }
    if (state.active !== null || Object.values(state.setup ?? {}).some(item => item.status === 'installing')) updatePending = true;
    else {
      await command('/bin/launchctl', ['bootout', target], { timeout: 25_000 });
      // bootout may return while launchd still owns an unloading registration.
      // Do not replace runtime files or bootstrap its label during that window.
      await waitForUnload(command, target, { timeoutMs: unloadTimeoutMs, sleep });
      loaded = false;
    }
  }
  if (!loaded) {
    await deployRuntime({ appRoot, paths, bundle });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    if (previous !== contents) {
      const temp = `${agentFile}.${process.pid}.tmp`;
      await writeFile(temp, contents, { mode: 0o600 });
      await rename(temp, agentFile);
    }
    await chmod(agentFile, 0o600);
    try { await command('/bin/launchctl', ['bootstrap', domain, agentFile], { timeout: 10_000 }); }
    catch (error) {
      // A simultaneous app launch can register the same service first. Reuse
      // it only when the server is ready and launchd still has a running PID;
      // an unloading/ghost registration is not successful startup.
      try {
        await wait(config.origin);
        if (!runningRegistration(await command('/bin/launchctl', ['print', target], { timeout: 5000 }))) throw new Error('Not running.');
      } catch { throw new Error(`Could not start Duet's background service: ${error.stderr?.trim() || error.message}`); }
    }
  } else await command('/bin/launchctl', ['kickstart', target], { timeout: 10_000 });
  await wait(config.origin);
  const running = await savedConnection(paths.data, config.origin);
  const url = `${running.origin}/#${running.token}`;
  if (open) await command('/usr/bin/open', [url], { timeout: 10_000 });
  return { origin: running.origin, url, agentFile, target, paths, updatePending };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await installService({ open: process.argv.includes('--open') });
    console.log(`Duet is ready at ${result.origin}. It will restart automatically and start when you sign in.`);
    if (result.updatePending) console.log('A newer version is ready. Finish the current turn, then reopen Duet.app to install it.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
