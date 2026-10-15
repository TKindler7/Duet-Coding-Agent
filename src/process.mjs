import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

// No shell interpolation. Terminate the whole helper process group on timeout/cancel.
export function execute(command, args, { cwd, input = '', timeoutMs = 1_200_000, idleTimeoutMs,
  signal, env = process.env, maxBytes = 8 * 1024 * 1024, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    for (const [name, value] of [['timeoutMs', timeoutMs], ['idleTimeoutMs', idleTimeoutMs]]) {
      if (name === 'idleTimeoutMs' && value === undefined) continue;
      if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
        throw new RangeError(`${name} must be a positive finite number no greater than 2147483647 milliseconds.`);
      }
    }
    const cancelled = () => Object.assign(new Error('Cancelled by user.'), { code: 'DUET_CANCELLED' });
    if (signal?.aborted) throw cancelled();
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let bytes = 0, failure, killTimer, idleTimer;
    function kill(kind) {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if (error.code !== 'ESRCH') { try { child.kill(kind); } catch { /* Already stopped. */ } }
      }
    }
    function stop(error) {
      if (failure) return;
      failure = error;
      clearTimeout(idleTimer);
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
    }
    const abort = () => stop(cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(Object.assign(new Error(`Helper timed out after ${timeoutMs / 1000} seconds.`), { code: 'DUET_TIMEOUT' })), timeoutMs);
    function resetIdleTimer() {
      if (idleTimeoutMs === undefined || failure) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop(Object.assign(new Error(`Helper timed out after ${idleTimeoutMs / 1000} seconds without output.`), { code: 'DUET_IDLE_TIMEOUT' })), idleTimeoutMs);
    }
    resetIdleTimer();
    function collect(target, stream, chunk) {
      resetIdleTimer();
      bytes += chunk.length;
      if (bytes > maxBytes) return stop(new Error('Helper output exceeded the 8 MiB limit.'));
      target.push(chunk);
      if (typeof onOutput === 'function') {
        try {
          // Observers cannot mutate captured output or fail the helper.
          Promise.resolve(onOutput({ stream, chunk: Buffer.from(chunk) })).catch(() => {});
        } catch { /* A disconnected progress observer must not stop work. */ }
      }
    }
    child.stdout.on('data', chunk => collect(stdout, 'stdout', chunk));
    child.stderr.on('data', chunk => collect(stderr, 'stderr', chunk));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.on('error', error => { failure ||= error; });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      // Kill remaining descendants even when the immediate parent already exited.
      if (failure) kill('SIGKILL');
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      const result = { code, signal: exitSignal, stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString() };
      if (failure) reject(Object.assign(failure, { result }));
      else resolve(result);
    });
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}

export async function saveJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
