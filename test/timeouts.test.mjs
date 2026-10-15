import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { doctor, runDuet } from '../src/duet.mjs';
import { askDuet, summarizeJob } from '../src/conversations.mjs';

const plan = { complexity: 'standard', collaboration: 'paired', reason: 'Separate coding and integration work.',
  plan: 'Build the component and check the finished files.', acceptanceCriteria: ['A working component'] };
const finalResponse = payload => ({ code: 0, stderr: '', stdout: [
  { type: 'system', subtype: 'init' },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Working…' } } },
  { type: 'result', subtype: 'success', is_error: false, ...payload, usage: { input_tokens: 25, output_tokens: 10 } },
].map(value => JSON.stringify(value)).join('\n') + '\n' });
const partialResult = { code: null, signal: 'SIGTERM', stdout: '{"type":"stream_event","text":"partial work"}\n',
  // This diagnostic must never make a timeout eligible for automatic fallback.
  stderr: 'Requested model not available' };
function timeout(code = 'DUET_IDLE_TIMEOUT') {
  return Object.assign(new Error('Helper timed out.'), { code, result: { ...partialResult } });
}
async function project(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'duet-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function modelRunner(calls, { timeoutStage, timeoutCode, abortController } = {}) {
  return async (agent, args, options) => {
    if (!options.input) return { code: 0, stderr: '', stdout: JSON.stringify(agent === 'claude' ? { loggedIn: true } : {}) };
    const schema = args.includes('--json-schema') ? JSON.parse(args[args.indexOf('--json-schema') + 1]) : null;
    const stage = agent === 'codex' ? 'codex-build-1' : schema?.properties?.complexity ? 'claude-plan'
      : schema ? 'claude-review-1' : 'claude-code-1';
    calls.push({ agent, stage, args, options });
    if (stage === timeoutStage) {
      await writeFile(path.join(options.cwd, 'unfinished-component.txt'), 'Keep these partial edits.');
      abortController?.abort();
      throw timeout(timeoutCode);
    }
    if (agent === 'codex') {
      await writeFile(path.join(options.cwd, 'finished-component.txt'), 'Completed integration.');
      await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ status: 'built',
        summary: 'Integrated the component.', checks: ['Fixture integration check passed'],
        requirements: [{ id: 'AC1', status: 'passed', evidence: 'Fixture inspected the component.' }], run_instructions: 'Open the component.' }));
      return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 20 } }) };
    }
    if (schema?.properties?.complexity) return finalResponse({ structured_output: plan });
    if (schema) return finalResponse({ structured_output: { verdict: 'approved', summary: 'Reviewed the actual component.', findings: [] } });
    await writeFile(path.join(options.cwd, 'claude-component.txt'), 'Completed Claude portion.');
    return finalResponse({ result: 'Claude implemented its component and handed it to Codex.' });
  };
}

test('every build model stage receives a one-hour hard limit and ten-minute activity limit', async t => {
  const calls = [];
  const result = await runDuet({ project: await project(t), prompt: 'Build the component', runner: modelRunner(calls) });
  assert.deepEqual(calls.map(call => call.stage), ['claude-plan', 'claude-code-1', 'codex-build-1', 'claude-review-1']);
  for (const { options } of calls) {
    assert.equal(options.timeoutMs, 3_600_000);
    assert.equal(options.idleTimeoutMs, 600_000);
  }
  const claudeCalls = calls.filter(call => call.agent === 'claude');
  for (const { args } of claudeCalls) {
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(args.includes('--verbose')); assert.ok(args.includes('--include-partial-messages'));
  }
  assert.equal(result.plan.includes(plan.plan), true);
  assert.match(result.rounds[0].claudeBuild, /handed it to Codex/);
  assert.equal(result.rounds[0].review.verdict, 'approved');
  assert.equal(result.coordinator.callsWithUsage, 4, 'stream normalization must preserve final reported usage');
});

test('explicit model deadlines reach every build stage', async t => {
  const calls = [];
  await runDuet({ project: await project(t), prompt: 'Build', timeoutMs: 1_800_000, idleTimeoutMs: 120_000, runner: modelRunner(calls) });
  assert.ok(calls.length > 1);
  assert.ok(calls.every(call => call.options.timeoutMs === 1_800_000 && call.options.idleTimeoutMs === 120_000));
});

test('invalid model deadlines are rejected before starting either provider', async () => {
  for (const limits of [{ timeoutMs: NaN }, { timeoutMs: 0 }, { idleTimeoutMs: Infinity }, { idleTimeoutMs: 0 }]) {
    let calls = 0;
    const options = { project: '/tmp', prompt: 'Explain', ...limits, runner: async () => { calls++; throw new Error('Provider must not start.'); } };
    await assert.rejects(runDuet(options), /timeout/i);
    await assert.rejects(askDuet(options), /timeout/i);
    assert.equal(calls, 0);
  }
});

for (const [stage, timeoutCode, expectedCalls] of [
  ['claude-plan', 'DUET_TIMEOUT', 1],
  ['claude-code-1', 'DUET_IDLE_TIMEOUT', 2],
  ['codex-build-1', 'DUET_TIMEOUT', 3],
  ['claude-review-1', 'DUET_IDLE_TIMEOUT', 4],
]) {
  test(`${stage} timeout preserves work and run records without retrying or changing models`, async t => {
    const directory = await project(t), calls = [], progress = [];
    const result = await runDuet({ project: directory, prompt: 'Build',
      runner: modelRunner(calls, { timeoutStage: stage, timeoutCode }), onProgress: value => progress.push(value) });
    assert.equal(result.status, 'needs_attention');
    assert.ok(result.finishedAt); assert.match(result.error, /continue/i);
    assert.equal(calls.length, expectedCalls); assert.equal(result.coordinator.calls.length, expectedCalls);
    assert.ok(calls.every(call => call.args.includes('--model')), 'no provider-default fallback');
    assert.ok(!progress.some(value => /fallback|retry/.test(value)));
    assert.ok(!result.coordinator.decisions.some(value => /Retrying|fallback/i.test(value.reason)));
    assert.equal(await readFile(path.join(directory, 'unfinished-component.txt'), 'utf8'), 'Keep these partial edits.');
    await assert.rejects(access(path.join(directory, '.duet/active.lock')), { code: 'ENOENT' });
    const saved = JSON.parse(await readFile(path.join(result.runDir, 'state.json'), 'utf8'));
    assert.equal(saved.status, 'needs_attention'); assert.equal(saved.error, result.error);
    assert.ok(saved.coordinator.calls.at(-1).finishedAt);
    assert.deepEqual(JSON.parse(await readFile(path.join(result.runDir, `${stage}.response.json`), 'utf8')), partialResult);
    assert.match(await readFile(path.join(result.runDir, `${stage}.prompt.txt`), 'utf8'), /Build/);
    assert.match(await readFile(path.join(result.runDir, 'REPORT.md'), 'utf8'), /needs_attention/);
    assert.match(summarizeJob(result), /continue/i);
    if (expectedCalls >= 3) assert.match(result.rounds[0].claudeBuild, /implemented/);
    if (stage === 'claude-review-1') {
      assert.equal(result.rounds[0].build.summary, 'Integrated the component.');
      assert.equal(await readFile(path.join(directory, 'finished-component.txt'), 'utf8'), 'Completed integration.');
    }
  });
}

test('Ask uses the same streaming and deadline defaults, with explicit overrides supported', async () => {
  for (const overrides of [{}, { timeoutMs: 1_800_000, idleTimeoutMs: 120_000 }]) {
    let invocation;
    const result = await askDuet({ project: '/tmp', prompt: 'Explain this project', ...overrides,
      runner: async (agent, args, options) => { invocation = { agent, args, options }; return finalResponse({ result: 'Here is the explanation.' }); } });
    assert.equal(result.status, 'answered'); assert.equal(result.answer, 'Here is the explanation.');
    assert.equal(invocation.options.timeoutMs, overrides.timeoutMs ?? 3_600_000);
    assert.equal(invocation.options.idleTimeoutMs, overrides.idleTimeoutMs ?? 600_000);
    assert.equal(invocation.args[invocation.args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(result.coordinator.callsWithUsage, 1);
  }
});

for (const code of ['DUET_TIMEOUT', 'DUET_IDLE_TIMEOUT']) {
  test(`Ask ${code} is resumable attention rather than a failed answer or automatic retry`, async () => {
    let calls = 0;
    const result = await askDuet({ project: '/tmp', prompt: 'Explain', runner: async () => { calls++; throw timeout(code); } });
    assert.equal(result.status, 'needs_attention'); assert.equal(calls, 1);
    assert.match(result.error, /continue/i); assert.match(summarizeJob(result), /continue/i);
    assert.equal(result.coordinator.calls.length, 1); assert.ok(result.coordinator.calls[0].finishedAt);
    assert.ok(!result.coordinator.decisions.some(value => /fallback|retrying/i.test(value.reason)));
    assert.equal(result.answer, undefined);
  });
}

test('user cancellation remains cancellation when a timeout arrives at the same time', async t => {
  const directory = await project(t), controller = new AbortController(), calls = [];
  await assert.rejects(runDuet({ project: directory, prompt: 'Build', signal: controller.signal,
    runner: modelRunner(calls, { timeoutStage: 'claude-code-1', timeoutCode: 'DUET_TIMEOUT', abortController: controller }) }));
  const runNames = await readdir(path.join(directory, '.duet/runs'));
  const state = JSON.parse(await readFile(path.join(directory, '.duet/runs', runNames[0], 'state.json'), 'utf8'));
  assert.equal(state.status, 'cancelled'); assert.equal(state.coordinator.calls.at(-1).status, 'cancelled');
  await assert.rejects(access(path.join(directory, '.duet/active.lock')), { code: 'ENOENT' });
  const askController = new AbortController();
  await assert.rejects(askDuet({ project: directory, prompt: 'Explain', signal: askController.signal,
    runner: async () => { askController.abort(); throw timeout(); } }));
});

test('account preflight starts both checks in parallel with short deadlines and the shared cancellation signal', async () => {
  const calls = [], controller = new AbortController(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = doctor({ cwd: '/tmp', signal: controller.signal, runner: async (agent, args, options) => {
    calls.push({ agent, args, options }); await gate;
    return { code: 0, stderr: '', stdout: agent === 'claude' ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) : 'Logged in using ChatGPT' };
  } });
  try {
    assert.deepEqual(calls.map(call => call.agent).sort(), ['claude', 'codex']);
    for (const { options } of calls) {
      assert.equal(options.timeoutMs, 15_000); assert.equal(options.signal, controller.signal);
      assert.equal(options.input, undefined);
    }
  } finally { release(); }
  const result = await pending;
  assert.equal(result.claude.ready, true); assert.equal(result.codex.ready, true);
});

test('Stop during account preflight cancels both checks and never creates build records or starts a model', async t => {
  const directory = await project(t), controller = new AbortController(), calls = [];
  let started;
  const preflightStarted = new Promise(resolve => { started = resolve; });
  const pending = runDuet({ project: directory, prompt: 'Build', signal: controller.signal,
    runner: (agent, args, options) => new Promise((_resolve, reject) => {
      calls.push({ agent, args, options }); started();
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled by user.'), { code: 'DUET_CANCELLED' })), { once: true });
    }) });
  await preflightStarted;
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejected;
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.options.input === undefined));
  assert.ok(calls.every(call => call.options.signal === controller.signal));
  await assert.rejects(access(path.join(directory, '.duet')), { code: 'ENOENT' });
});
