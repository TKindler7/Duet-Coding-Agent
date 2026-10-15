import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open as openFile, stat, unlink } from 'node:fs/promises';
import { execute } from './process.mjs';

export const DEFAULT_PORT = 63121;
export const APP_VERSION = '0.9.0';
const validToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parsePort(value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1024 || Number(value) > 65535) {
    throw new Error('DUET_PORT must be a whole number between 1024 and 65535.');
  }
  return Number(value);
}

export async function readServerConfig(dataDir, { port = process.env.DUET_PORT } = {}) {
  let previous;
  try { previous = JSON.parse(await readFile(path.join(dataDir, 'server.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const match = typeof previous?.origin === 'string' && previous.origin.match(/^http:\/\/127\.0\.0\.1:(\d+)$/);
  const savedPort = match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535 ? Number(match[1]) : DEFAULT_PORT;
  const selectedPort = port === undefined ? savedPort : parsePort(port);
  return {
    origin: `http://127.0.0.1:${selectedPort}`, port: selectedPort,
    token: validToken(previous?.token) ? previous.token : randomBytes(32).toString('hex'),
  };
}

export async function probeServer(origin, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  let response;
  try { response = await fetchImpl(`${origin}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) }); }
  catch { return { running: false, duet: false }; }
  try {
    const value = await response.json();
    return { running: true, duet: response.ok && value.app === 'duet', version: value.version };
  } catch { return { running: true, duet: false }; }
}

export async function waitForServer(origin, { timeoutMs = 20_000, probe = probeServer, pause = sleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await probe(origin);
    if (state.duet) return state;
    if (state.running) throw new Error(`Another application is using ${origin}. Close that application, or choose a different DUET_PORT.`);
    await pause(200);
  }
  throw new Error(`Duet did not start at ${origin}. See data/server-error.log for details and reopen Duet.app.`);
}

async function writeConfig(dataDir, config) {
  const file = path.join(dataDir, 'server.json');
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ origin: config.origin, token: config.token }), { mode: 0o600 });
  await rename(temp, file);
}

async function startupLock(dataDir) {
  const file = path.join(dataDir, 'server-start.lock');
  const nonce = randomBytes(16).toString('hex');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const handle = await openFile(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); }
      finally { await handle.close(); }
      return async () => {
        try { if (JSON.parse(await readFile(file, 'utf8')).nonce === nonce) await unlink(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const before = await stat(file);
        let dead = false;
        try {
          const owner = JSON.parse(await readFile(file, 'utf8'));
          if (Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
          } else dead = Date.now() - before.mtimeMs > 30_000;
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          if (!(error instanceof SyntaxError)) throw error;
          // A process can still be writing a newly created lock.
          dead = Date.now() - before.mtimeMs > 30_000;
        }
        if (dead && (await stat(file)).ino === before.ino) { await unlink(file); continue; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await sleep(100);
    }
  }
  throw new Error('Duet is already starting. Wait a moment and reopen the app.');
}

export async function startServer({ createWebApp, root, dataDir = process.env.DUET_DATA_DIR || path.join(root, 'data'),
  port = process.env.DUET_PORT, open = false, native = execute, handleSignals = true,
  probe = probeServer, logger = console } = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const release = await startupLock(dataDir);
  try {
  let config = await readServerConfig(dataDir, { port });
  const existing = await probe(config.origin);
  if (existing.running && !existing.duet) {
    throw new Error(`Another application is using ${config.origin}. Close that application, or choose a different DUET_PORT.`);
  }
  const show = async () => {
    if (open) {
      const result = await native('/usr/bin/open', [`${config.origin}/#${config.token}`]);
      if (result.code !== 0) logger.error(`Could not open the browser. Open ${config.origin} using Duet.app.`);
    }
  };
  if (existing.duet) {
    logger.log(`Duet is already running at ${config.origin}.`);
    await show();
    return { ...config, reused: true, close: async () => {} };
  }
  const app = await createWebApp({ dataDir, token: config.token });
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(config.port, '127.0.0.1', () => { app.server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    await app.close();
    if (error.code !== 'EADDRINUSE') throw error;
    const raced = await probe(config.origin);
    if (!raced.duet) throw new Error(`Another application is using ${config.origin}. Duet will keep this address; choose another DUET_PORT if needed.`);
    config = await readServerConfig(dataDir, { port });
    await show();
    return { ...config, reused: true, close: async () => {} };
  }
  let closing;
  const close = () => {
    if (!closing) {
      for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig, stop);
      closing = app.close();
    }
    return closing;
  };
  const stop = () => { close().then(() => process.exit(0), error => { logger.error(error); process.exit(1); }); };
  try { await writeConfig(dataDir, config); }
  catch (error) { await close(); throw error; }
  if (handleSignals) for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, stop);
  logger.log(`Duet is running at ${config.origin}`);
  await show();
  return { ...config, app, reused: false, close };
  } finally { await release(); }
}
