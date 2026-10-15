import { execute } from './process.mjs';

export const MODEL_TIMEOUT_MS = 3_600_000;
export const MODEL_IDLE_TIMEOUT_MS = 600_000;
export const isModelTimeout = error => ['DUET_TIMEOUT', 'DUET_IDLE_TIMEOUT'].includes(error?.code);

export function validateModelTimeouts(timeoutMs, idleTimeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 7_200_000) throw new Error('Timeout must be between 1 and 7200 seconds.');
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > 7_200_000) throw new Error('Idle timeout must be between 1 and 7200 seconds.');
}

// Streaming keeps a busy provider observable. Only its final result is passed
// to existing schema and usage readers; partial text is never a finished answer.
export function normalizeModelResult(agent, response) {
  if (agent !== 'claude' || !response) return response;
  const raw = response.stdout ?? '';
  try {
    const single = JSON.parse(raw);
    if (single && (!single.type || single.type === 'result') && !single.parent_tool_use_id) return response;
  } catch { /* A normal stream has one JSON object per line. */ }
  let final;
  for (const line of raw.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'result' && !event.parent_tool_use_id) final = event;
    } catch { /* Incomplete or diagnostic lines cannot become a result. */ }
  }
  return { ...response, stdout: final ? JSON.stringify(final) : '' };
}

export function timeoutExplanation(error, { agent, timeoutMs, idleTimeoutMs }) {
  const name = agent === 'codex' ? 'Codex' : 'Claude';
  const duration = ms => ms < 60_000 ? `${Math.ceil(ms / 1000)} seconds` : `${Math.ceil(ms / 60_000)} minutes`;
  const reason = error.code === 'DUET_IDLE_TIMEOUT'
    ? `${name} stopped sending activity for ${duration(idleTimeoutMs)}.`
    : `This ${name} step reached its ${duration(timeoutMs)} time limit.`;
  return `${reason} Your project and completed steps are saved. Send “Continue from the saved files” in this chat to continue. Duet has not restarted the step or spent another model call automatically.`;
}

export async function runModel(agent, args, { runner = execute, stage,
  timeoutMs = MODEL_TIMEOUT_MS, idleTimeoutMs = MODEL_IDLE_TIMEOUT_MS,
  onActivity = () => {}, ...options } = {}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let lastActivityAt = null, lastEmitted = -Infinity;
  function activity(force = false) {
    const elapsedMs = Math.round(performance.now() - started);
    if (!force && elapsedMs - lastEmitted < 2000) return;
    lastEmitted = elapsedMs;
    try {
      Promise.resolve(onActivity({ agent, stage, startedAt, lastActivityAt, elapsedMs,
        idleTimeoutMs, timeoutMs })).catch(() => {});
    } catch { /* A display update must never terminate model work. */ }
  }
  activity(true);
  // Keep captured partial output on errors for the private run record. It is
  // diagnostic evidence, never a completed answer or an implementation report.
  const response = await runner(agent, args, { ...options, timeoutMs, idleTimeoutMs,
    onOutput: () => { const first = lastActivityAt === null; lastActivityAt = new Date().toISOString(); activity(first); } });
  return normalizeModelResult(agent, response);
}
