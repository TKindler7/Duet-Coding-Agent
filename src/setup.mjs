import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execute } from './process.mjs';

export const CODEX_VERSION = '0.162.0';
export const CLAUDE_INSTALL_URL = 'https://claude.ai/install.sh';
export function toolPath(home = os.homedir(), nodePath = process.execPath) {
  return [path.dirname(nodePath), path.join(home, 'Library/Application Support/Duet/Tools/bin'),
    path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}
export async function systemInformation(version) {
  let macOS;
  if (process.platform === 'darwin') {
    try {
      const plist = await readFile('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
      macOS = plist.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    } catch { /* Version diagnostics are optional. */ }
  }
  return { version, platform: process.platform, architecture: process.arch, ...(macOS ? { macOS } : {}) };
}

// Each operation is an explicit first-run action. Provider authentication remains
// in the official tools; no account credentials are copied into Duet.
export function createSetupManager({ home = os.homedir(), runner = execute,
  platform = process.platform, nodePath = process.execPath, fetchImpl = fetch, onChange = () => {} } = {}) {
  const states = {}, tasks = new Set(), controllers = new Set();
  const base = path.join(home, 'Library/Application Support/Duet');
  const env = { ...process.env, HOME: home, PATH: toolPath(home, nodePath) };
  let closed = false;
  const snapshot = () => structuredClone(states);
  const change = () => Promise.resolve().then(() => onChange(snapshot())).catch(() => {});
  async function perform(agent, signal) {
    let temporary;
    try {
      await mkdir(base, { recursive: true, mode: 0o700 });
      const options = { cwd: home, env, signal, timeoutMs: 600_000 };
      let result;
      if (agent === 'codex') {
        const npmCli = path.resolve(path.dirname(nodePath), '../lib/node_modules/npm/bin/npm-cli.js');
        const args = ['install', '--global', '--prefix', path.join(base, 'Tools'),
          '--no-audit', '--no-fund', '--no-progress', '--ignore-scripts', '--registry=https://registry.npmjs.org', `@openai/codex@${CODEX_VERSION}`];
        let bundled = true;
        try { await access(npmCli); } catch { bundled = false; }
        result = await runner(bundled ? nodePath : 'npm', bundled ? [npmCli, ...args] : args, options);
      } else {
        temporary = await mkdtemp(path.join(base, 'setup-'));
        const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
        let response = await fetchImpl(CLAUDE_INSTALL_URL, { signal: downloadSignal, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const target = response.headers.get('location');
          await response.body?.cancel();
          if (target !== 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh') throw new Error('Unexpected installer redirect.');
          response = await fetchImpl(target, { signal: downloadSignal, redirect: 'error' });
        }
        if (!response.ok) throw new Error('Download failed.');
        const reader = response.body.getReader();
        const chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1_048_576) throw new Error('Installer exceeds expected size.');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        const script = Buffer.concat(chunks).toString('utf8');
        if (!script.startsWith('#!/bin/bash')) throw new Error('Unexpected installer.');
        const file = path.join(temporary, 'install-claude.sh');
        await writeFile(file, script, { mode: 0o600 });
        result = await runner('/bin/bash', [file, 'stable'], options);
      }
      if (result.code !== 0) throw new Error('Installation failed.');
      const check = await runner(agent, ['--version'], { ...options, timeoutMs: 30_000 });
      if (check.code !== 0) throw new Error('Installed tool could not start.');
      states[agent] = { status: 'installed' };
    } catch {
      states[agent] = { status: 'failed', error: signal.aborted
        ? 'Setup was interrupted. Reopen Duet and try again.'
        : 'Installation did not finish. Check your internet connection and try again. If it keeps failing, use the official setup guide.' };
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      await change();
    }
  }
  return {
    snapshot,
    install(agent) {
      if (!['claude', 'codex'].includes(agent)) throw Object.assign(new Error('Unknown assistant.'), { status: 400 });
      if (platform !== 'darwin') throw Object.assign(new Error('Guided setup is available on Mac.'), { status: 400 });
      if (closed) throw Object.assign(new Error('Duet is restarting. Reopen it to continue setup.'), { status: 503 });
      if (['installing', 'installed'].includes(states[agent]?.status)) return structuredClone(states[agent]);
      states[agent] = { status: 'installing' };
      const controller = new AbortController(); controllers.add(controller);
      const task = perform(agent, controller.signal);
      tasks.add(task);
      task.finally(() => { tasks.delete(task); controllers.delete(controller); }).catch(() => {});
      return structuredClone(states[agent]);
    },
    async wait() { await Promise.allSettled([...tasks]); },
    async close() { closed = true; for (const controller of controllers) controller.abort(); await this.wait(); },
  };
}
