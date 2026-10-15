import os from 'node:os';
import { spawn } from 'node:child_process';
import { toolPath } from './setup.mjs';

const assistants = new Set(['claude', 'codex']);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const terminalState = (status, error) => ({ status, ...(error ? { error } : {}) });
const genericError = 'Sign-in did not finish. Try again and complete the provider’s browser page.';
const authorizationPaths = {
  claude: new Map([['claude.com', '/cai/oauth/authorize'], ['claude.ai', '/oauth/authorize']]),
  codex: new Map([['auth.openai.com', '/oauth/authorize']]),
};

// Only authorization requests from the official login process are exposed.
// Callback codes, tokens, arbitrary domains, and custom OAuth providers are not.
export function officialAuthUrl(agent, value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || authorizationPaths[agent]?.get(url.hostname) !== url.pathname) return null;
    if (url.searchParams.get('response_type') !== 'code' || !url.searchParams.get('state') || !url.searchParams.get('client_id')) return null;
    for (const name of url.searchParams.keys()) {
      if (/^(?:code|token|access_token|refresh_token|id_token|client_secret|code_verifier)$/i.test(name)) return null;
    }
    return url.href;
  } catch { return null; }
}

function plainOutput(value) {
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

// OAuth and credential storage remain entirely inside the official CLIs. Duet
// keeps only a bounded, temporary parser buffer and the active browser link.
export function createAuthManager({ home = os.homedir(), nodePath = process.execPath,
  spawnImpl = spawn, killImpl = process.kill, platform = process.platform,
  onChange = () => {}, health, timeoutMs = 300_000, killGraceMs = 1000,
  maxOutputBytes = 65_536 } = {}) {
  const states = {}, sessions = new Map(), tasks = new Set();
  let closed = false;
  const snapshot = () => structuredClone(states);
  const notify = () => Promise.resolve().then(() => onChange(snapshot())).catch(() => {});
  const update = (agent, value) => { states[agent] = value; void notify(); };
  const validateAgent = agent => { if (!assistants.has(agent)) throw failure('Unknown assistant.'); };
  function signalChild(session, signal) {
    try {
      if (platform !== 'win32' && session.child?.pid) killImpl(-session.child.pid, signal);
      else session.child?.kill(signal);
    } catch { try { session.child?.kill(signal); } catch { /* Already stopped. */ } }
  }
  function stop(session, reason) {
    if (session.stopping || session.finished) return;
    session.stopping = reason;
    session.abortVerification();
    // Remain busy until the helper and its callback listener have closed.
    update(session.agent, { status: states[session.agent].status, cancelling: true });
    if (!session.childClosed) {
      signalChild(session, 'SIGTERM');
      session.killTimer = setTimeout(() => signalChild(session, 'SIGKILL'), killGraceMs);
    }
  }
  function consume(session, source, chunk) {
    if (session.stopping || session.childClosed) return;
    session.bytes += Buffer.byteLength(chunk);
    if (session.bytes > maxOutputBytes) return stop(session, 'output');
    session.buffers[source] = (session.buffers[source] + chunk.toString('utf8')).slice(-16_384);
    const output = plainOutput(session.buffers[source]);
    let url = states[session.agent].url;
    // A terminating character is required: a chunk boundary is not the end of
    // a URL, and publishing a truncated PKCE link would break sign-in.
    for (const match of output.matchAll(/https:\/\/[^\s<>"'\x00-\x20]+(?=[\s<>"'\x00-\x20])/g)) {
      const candidate = officialAuthUrl(session.agent, match[0]);
      if (candidate) url = candidate;
    }
    const acceptsCode = session.agent === 'claude' && Boolean(url)
      && (states[session.agent].acceptsCode || /Paste code here if prompted\s*>/i.test(output));
    if (url && (url !== states[session.agent].url || Boolean(acceptsCode) !== Boolean(states[session.agent].acceptsCode))) {
      update(session.agent, { status: 'waiting', url, ...(acceptsCode ? { acceptsCode: true } : {}) });
    }
  }
  async function perform(session) {
    let code;
    const timer = setTimeout(() => stop(session, 'timeout'), timeoutMs);
    try {
      if (session.stopping) return;
      code = await new Promise(resolve => {
        let settled = false;
        const done = result => { if (!settled) { settled = true; session.childClosed = true; resolve(result); } };
        try {
          const args = session.agent === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'];
          session.child = spawnImpl(session.agent, args, { cwd: home,
            env: { ...process.env, HOME: home, PATH: toolPath(home, nodePath), NO_COLOR: '1' },
            detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
          session.child.stdout.on('data', chunk => consume(session, 'stdout', chunk));
          session.child.stderr.on('data', chunk => consume(session, 'stderr', chunk));
          session.child.stdin.on('error', () => stop(session, 'input'));
          session.child.once('error', () => { session.spawnFailed = true; done(null); });
          session.child.once('close', done);
          // Claude keeps stdin open for its documented code#state fallback.
          if (session.agent === 'codex') session.child.stdin.end();
        } catch { session.spawnFailed = true; done(null); }
      });
      if (session.stopping) signalChild(session, 'SIGKILL');
      clearTimeout(session.killTimer);
      if (code === 0 && !session.stopping && !session.spawnFailed) {
        // Successful exit is necessary, but the provider's status is the final
        // confirmation when the host supplies a health check.
        if (health) {
          const result = await Promise.race([Promise.resolve().then(() => health()), session.cancelledVerification]);
          session.verified = result?.[session.agent]?.ready === true;
        } else session.verified = true;
      }
    } catch { /* Never expose subprocess output, secrets, or raw exceptions. */ }
    finally {
      clearTimeout(timer); clearTimeout(session.killTimer);
      session.finished = true;
      session.buffers = { stdout: '', stderr: '' };
      sessions.delete(session.agent);
      const status = session.stopping === 'cancelled' ? 'cancelled' : session.verified && !session.stopping ? 'connected' : 'failed';
      const error = status !== 'failed' ? undefined : session.stopping === 'timeout'
        ? 'Sign-in timed out. Start again when you are ready to finish in the browser.' : genericError;
      update(session.agent, terminalState(status, error));
    }
  }
  return {
    snapshot,
    start(agent) {
      validateAgent(agent);
      if (closed) throw failure('Duet is restarting. Reopen it to connect your accounts.', 503);
      if (sessions.has(agent)) return structuredClone(states[agent]);
      // The shared account stores and Codex callback port should have one owner.
      if (sessions.size) throw failure('Finish or cancel the other account sign-in first.', 409);
      const session = { agent, child: null, childClosed: false, buffers: { stdout: '', stderr: '' }, bytes: 0 };
      session.cancelledVerification = new Promise(resolve => { session.abortVerification = () => resolve(null); });
      sessions.set(agent, session); update(agent, { status: 'starting' });
      const task = Promise.resolve().then(() => perform(session));
      tasks.add(task); task.finally(() => tasks.delete(task)).catch(() => {});
      return structuredClone(states[agent]);
    },
    cancel(agent) {
      validateAgent(agent);
      const session = sessions.get(agent);
      if (session) stop(session, 'cancelled');
      return structuredClone(states[agent] ?? { status: 'cancelled' });
    },
    submitCode(agent, value) {
      validateAgent(agent);
      const session = sessions.get(agent), state = states[agent];
      if (agent !== 'claude' || !session || session.stopping || session.childClosed || !state?.acceptsCode) {
        throw failure('Start Claude sign-in before entering its browser code.', 409);
      }
      if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9_.~+\/=\-]+#[A-Za-z0-9_-]+$/.test(value.trim())) {
        throw failure('Copy the complete code from Claude’s browser page, including the part after #.');
      }
      const code = value.trim(), oauthState = code.slice(code.indexOf('#') + 1);
      if (new URL(state.url).searchParams.get('state') !== oauthState) throw failure('This code belongs to a different sign-in. Use the latest Claude browser page.');
      // Forward directly to the official CLI. Never retain or echo the code.
      try { session.child.stdin.write(code + '\n'); }
      catch { stop(session, 'input'); throw failure('Claude sign-in closed. Start it again.', 409); }
      return { status: state.status, submitted: true };
    },
    async wait() { await Promise.allSettled([...tasks]); },
    async close() { closed = true; for (const session of sessions.values()) stop(session, 'cancelled'); await this.wait(); },
  };
}
