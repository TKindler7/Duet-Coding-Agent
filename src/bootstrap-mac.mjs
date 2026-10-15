import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, cp, rename, rm, access, writeFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installService } from './install-service.mjs';

const command = promisify(execFile);
const hash = content => createHash('sha256').update(content).digest('hex');
const checksum = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const migrationHelp = 'This setup did not stop the existing service or remove your data. Ask the sender for help with this configuration.';

export function bootstrapErrorMessage(error) {
  const message = error?.message || 'Duet setup could not finish. Reopen Start Duet.command and try again.';
  return /different location or port/.test(message) && !message.includes(migrationHelp)
    ? `${message}\n${migrationHelp}` : message;
}

function subprocessError(error) {
  const reported = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  // The installed bootstrap has already formatted its error. Surface that once,
  // without execFile's command line, local paths, or a second copy of its help.
  const message = reported || (error?.killed
    ? 'Duet setup took too long to finish. Reopen Start Duet.command and try again.'
    : 'The installed Duet runtime could not start. Reopen Start Duet.command and review any macOS message.');
  const failure = new Error(message, { cause: error });
  failure.code = error?.code;
  return failure;
}

export async function readDistribution(bundleDir, arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('This Mac processor is not supported.');
  const manifest = JSON.parse(await readFile(path.join(bundleDir, 'distribution.json'), 'utf8'));
  const runtime = manifest.runtimes?.[`darwin-${arch}`];
  if (manifest.format !== 1 || !/^v22\.\d+\.\d+$/.test(manifest.nodeVersion) ||
      manifest.minimumMacOS !== '13' || !checksum(runtime?.archiveSha256) || !checksum(runtime?.nodeSha256)) {
    throw new Error('The Duet download has an invalid runtime manifest. Download a fresh copy.');
  }
  return { manifest, runtime, source: path.join(bundleDir, 'runtimes', `darwin-${arch}`) };
}

export async function installBundledRuntime({ bundleDir, arch, home = os.homedir() }) {
  const { manifest, runtime, source } = await readDistribution(bundleDir, arch);
  if (hash(await readFile(path.join(source, 'bin', 'node'))) !== runtime.nodeSha256) {
    throw new Error('The included Node.js runtime is damaged. Download a fresh copy.');
  }
  const runtimeParent = path.join(home, 'Library', 'Application Support', 'Duet', 'runtime');
  const destination = path.join(runtimeParent, `node-${manifest.nodeVersion}-darwin-${arch}-${runtime.archiveSha256.slice(0, 12)}`);
  const validateInstalled = async () => {
    if (await readFile(path.join(destination, '.duet-runtime-ready'), 'utf8') !== runtime.archiveSha256 ||
        hash(await readFile(path.join(destination, 'bin', 'node'))) !== runtime.nodeSha256) {
      throw new Error('An installed Duet runtime failed its integrity check. It has not been overwritten; contact the sender for repair help.');
    }
    await access(path.join(destination, 'lib/node_modules/npm/bin/npm-cli.js'));
  };
  try { await access(destination); await validateInstalled(); return path.join(destination, 'bin', 'node'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(runtimeParent, { recursive: true, mode: 0o700 });
  const staging = path.join(runtimeParent, `.install-${randomUUID()}`);
  try {
    await cp(source, staging, { recursive: true, dereference: false, verbatimSymlinks: true });
    await chmod(path.join(staging, 'bin', 'node'), 0o755);
    await access(path.join(staging, 'lib/node_modules/npm/bin/npm-cli.js'));
    await writeFile(path.join(staging, '.duet-runtime-ready'), runtime.archiveSha256, { mode: 0o600 });
    try { await rename(staging, destination); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    await validateInstalled();
  } finally { await rm(staging, { recursive: true, force: true }); }
  return path.join(destination, 'bin', 'node');
}

export async function bootstrapMac({ bundleDir, arch = process.arch, home = os.homedir(), platform = process.platform,
  installed = false, installer = installService, run = command, logger = console } = {}) {
  if (platform !== 'darwin') throw new Error('Duet Mac Beta requires macOS 13 or newer.');
  if (typeof bundleDir !== 'string' || !path.isAbsolute(bundleDir)) throw new Error('Open Start Duet.command from the extracted beta folder.');
  const nodePath = await installBundledRuntime({ bundleDir, arch, home });
  if (!installed) {
    // Relaunch under the permanent runtime before writing the LaunchAgent.
    let result;
    try {
      result = await run(nodePath, [path.join(bundleDir, 'app/src/bootstrap-mac.mjs'), '--bundle', bundleDir, '--arch', arch, '--installed'],
        { timeout: 120_000, maxBuffer: 1024 * 1024 });
    } catch (error) { throw subprocessError(error); }
    if (result.stdout) logger.log(result.stdout.trim());
    if (result.stderr) logger.error(result.stderr.trim());
    return { nodePath, relaunched: true };
  }
  const support = path.join(home, 'Library', 'Application Support', 'Duet');
  process.env.PATH = [path.dirname(nodePath), path.join(support, 'Tools', 'bin'), path.join(home, '.local/bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const result = await installer({ appRoot: path.join(bundleDir, 'app'), home, nodePath, open: true });
  logger.log(`Duet is ready at ${result.origin}. Sign in with your own accounts in the browser.`);
  if (result.updatePending) logger.log('Finish the current work, then reopen Start Duet.command to apply this update.');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argument = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
    await bootstrapMac({ bundleDir: argument('--bundle'), arch: argument('--arch') || process.arch, installed: process.argv.includes('--installed') });
  } catch (error) {
    console.error(bootstrapErrorMessage(error));
    process.exitCode = 1;
  }
}
