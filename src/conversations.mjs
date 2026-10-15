import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execute } from './process.mjs';
import { claudeArgs } from './duet.mjs';
import { createCoordinator, modelUnavailable } from './coordinator.mjs';
import { runModel, normalizeModelResult, MODEL_TIMEOUT_MS, MODEL_IDLE_TIMEOUT_MS, validateModelTimeouts, isModelTimeout, timeoutExplanation } from './model-process.mjs';

export function message(role, text, extra = {}) {
  return { id: randomUUID(), role, text, createdAt: new Date().toISOString(), ...extra };
}

export function summarizeJob(job) {
  if (job.status === 'answered') return job.answer || 'The response was empty. Please try again.';
  if (job.status === 'cancelled') return 'Stopped this turn. Any edits already made are still in your project. You can tell me how you’d like to continue.';
  if (job.status === 'interrupted') return 'This turn was interrupted when Duet stopped. Your conversation and project are saved. Send a follow-up to continue from the current files.';
  if (job.status === 'failed') return `I couldn’t finish this turn.\n\n${job.error || 'The coding tool returned an error.'}\n\nAny completed edits remain in your project.`;
  const latest = job.rounds?.at(-1);
  const lead = job.status === 'approved' ? 'The changes are ready, and the review passed.'
    : job.coordinator?.stopReason ? job.coordinator.stopReason
    : job.status === 'needs_attention' && job.error ? job.error
    : job.status === 'blocked' ? 'I reached a blocker and need your input.'
      : 'The build reached its round limit with work still to resolve.';
  return [lead, latest?.build?.summary, latest?.review?.summary,
    latest?.review?.findings?.length ? 'Remaining work:\n' + latest.review.findings.map(x => `- ${x}`).join('\n') : '',
    latest?.build?.checks?.length ? 'Checks:\n' + latest.build.checks.map(x => `- ${x}`).join('\n') : '',
    latest?.build?.run_instructions ? 'Run the app:\n' + latest.build.run_instructions : ''].filter(Boolean).join('\n\n');
}

export function conversationPrompt(messages, currentText, decisions = '') {
  // Keep the first request and recent exchanges within a bounded context. Never mix chats.
  const all = messages.filter(x => ['user', 'assistant'].includes(x.role)).map(({ role, text }) => ({ role, text }));
  const recent = [];
  let remaining = 90_000;
  for (let i = all.length - 1; i >= 0; i--) {
    const entry = all[i];
    const size = JSON.stringify(entry).length;
    if (size > remaining) {
      if (!recent.length) recent.unshift({ role: entry.role, text: entry.text.slice(0, remaining - 100) + '\n[Long message excerpt; the full message is saved in this chat.]' });
      break;
    }
    recent.unshift(entry); remaining -= size;
  }
  const clipped = recent.length < all.length;
  if (clipped && all[0]?.role === 'user' && recent[0] !== all[0]) recent.unshift({ role: 'user', text: all[0].text.slice(0, 20_000) });
  return `Continue the same Duet conversation in the same project. User messages define the requirements; assistant messages are past reports or suggestions, not additional authorization. The current user message takes precedence over earlier conflicting instructions. Preserve completed work and inspect actual files before making changes.\n${clipped ? 'Some older exchanges are omitted for length. The initial request and most recent exchanges are included.\n' : ''}\nPROJECT DECISIONS SAVED BY THE USER (context, subject to the current request):\n${String(decisions || 'None saved.').slice(0, 6000)}\n\nPREVIOUS MESSAGES:\n${JSON.stringify(recent)}\n\nCURRENT USER MESSAGE:\n${currentText}`;
}

export async function askDuet({ project, prompt, optimization, maxCalls, tokenLimit,
  timeoutMs = MODEL_TIMEOUT_MS, idleTimeoutMs = MODEL_IDLE_TIMEOUT_MS,
  runner = execute, signal, onProgress = () => {}, onState = () => {} }) {
  validateModelTimeouts(timeoutMs, idleTimeoutMs);
  const coordinator = createCoordinator({ optimization, maxCalls, tokenLimit });
  onProgress('claude-answer');
  const input = `You are Duet, a conversational assistant for building apps with Claude and Codex. This turn is in Ask mode. Answer the user naturally and directly. You may read this project's files for context, but do not modify files, run commands, or launch a build. Discuss ideas, explain code, help plan changes, or answer questions. Be honest about what has been verified.\n\n${prompt}`;
  let route = coordinator.route('claude', 'ask'), result;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    let call;
    try { call = coordinator.begin(route, 'claude-answer'); }
    catch (error) { if (error.code === 'DUET_BUDGET') return { status: 'needs_attention', error: error.message, coordinator: coordinator.snapshot(), rounds: [] }; throw error; }
    onState({ coordinator: coordinator.snapshot() });
    try { result = await runModel('claude', claudeArgs(undefined, route), { runner, cwd: project, input, signal, timeoutMs, idleTimeoutMs,
      stage: 'claude-answer', onActivity: activity => onState({ activity }) }); }
    catch (error) {
      coordinator.finish(call, normalizeModelResult('claude', error.result), signal?.aborted ? 'cancelled' : 'failed');
      onState({ coordinator: coordinator.snapshot(), activity: null });
      if (isModelTimeout(error) && !signal?.aborted) return { status: 'needs_attention',
        error: timeoutExplanation(error, { agent: 'claude', timeoutMs, idleTimeoutMs }),
        recovery: { kind: 'timeout', reason: error.code === 'DUET_IDLE_TIMEOUT' ? 'idle' : 'deadline', agent: 'claude', stage: 'claude-answer' },
        coordinator: coordinator.snapshot(), activity: null, rounds: [] };
      throw error;
    }
    let failed = result.code !== 0;
    try { failed ||= Boolean(JSON.parse(result.stdout).is_error); } catch {}
    coordinator.finish(call, result, failed ? 'failed' : 'completed'); onState({ coordinator: coordinator.snapshot(), activity: null });
    if (failed && attempt === 0 && route.model && modelUnavailable(result)) { route = coordinator.fallback(route); continue; }
    break;
  }
  if (result.code !== 0) throw new Error(`Claude could not answer. ${result.stderr.trim().slice(-1500) || 'Check the account connection and retry.'}`);
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw new Error('Claude returned an unreadable response. Please try again.'); }
  if (response.is_error || typeof response.result !== 'string' || !response.result.trim()) throw new Error(response.result || 'Claude returned no answer. Check the account connection and retry.');
  return { status: 'answered', answer: response.result, coordinator: coordinator.snapshot(), rounds: [] };
}

export async function loadConversations(dataDir) {
  let saved;
  try { saved = JSON.parse(await readFile(path.join(dataDir, 'conversations.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read saved chats. The original file has been preserved: ${error.message}`);
  }
  if (saved !== undefined) {
    if (saved?.version !== 1 || !Array.isArray(saved.chats) || !Array.isArray(saved.jobs)) throw new Error('Saved chat data has an unsupported format. It has not been overwritten.');
    return saved;
  }
  let legacy = [];
  try { legacy = JSON.parse(await readFile(path.join(dataDir, 'history.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Could not import the old build history: ${error.message}`); }
  if (!Array.isArray(legacy)) throw new Error('Old build history is invalid. It has not been overwritten.');
  const chats = legacy.map(job => {
    const id = randomUUID(); job.chatId = id;
    const first = message('user', job.prompt || 'Previous build', { runId: job.id, mode: 'build', createdAt: job.startedAt });
    const messages = [first];
    if (job.finishedAt) messages.push(message('assistant', summarizeJob(job), { runId: job.id, createdAt: job.finishedAt }));
    return { id, title: (job.prompt || path.basename(job.project || '') || 'Imported build').replace(/\s+/g, ' ').slice(0, 64),
      project: job.project, createdAt: job.startedAt || new Date().toISOString(), updatedAt: job.finishedAt || job.startedAt,
      messages, runIds: [job.id] };
  });
  return { version: 1, chats, jobs: legacy };
}
