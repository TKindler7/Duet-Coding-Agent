import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../src/process.mjs';
import { runDuet, codexArgs, claudeArgs, validateBuild } from '../src/duet.mjs';

const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const project = () => mkdtemp(path.join(os.tmpdir(), 'duet-test-'));
function runner(scenario = 'fix', calls = []) {
  return (command, args, opts) => {
    calls.push({ command, args, input: opts.input });
    return execute(process.execPath, [fixture, command, ...args], {
      ...opts, env: { ...process.env, DUET_TEST_SCENARIO: scenario },
    });
  };
}
test('one prompt drives both coding partners, fixes, and a review ready for user verification', async () => {
  const dir = await project(), calls = [];
  const prompt = 'Build a thing with literal $(touch SHOULD_NOT_EXIST) and `echo no`';
  const result = await runDuet({ project: dir, prompt, runner: runner('fix', calls) });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.rounds.length, 2);
  assert.equal(await readFile(path.join(dir, 'app.txt'), 'utf8'), 'fixed');
  assert.equal(await readFile(path.join(dir, 'claude-component.txt'), 'utf8'), 'Component implemented by Claude');
  const work = calls.filter(x => x.input);
  assert.deepEqual(work.map(x => x.command), ['claude', 'claude', 'codex', 'claude', 'claude', 'codex', 'claude']);
  assert.ok(work.every(x => x.input.includes(prompt)));
  assert.ok(work[4].input.includes('replace the placeholder'));
  assert.ok(work[5].input.includes('replace the placeholder'));
  assert.ok(work[2].input.includes('Implemented claude-component.txt'));
  assert.ok(work[4].input.includes('Created app'));
  assert.match(await readFile(path.join(result.runDir, 'REPORT.md'), 'utf8'), /Status: \*\*needs_attention\*\*/);
  assert.equal(JSON.parse(await readFile(path.join(result.runDir, 'state.json'))).status, 'needs_attention');
  await assert.rejects(access(path.join(dir, 'SHOULD_NOT_EXIST')));
  await assert.rejects(access(path.join(dir, '.duet', 'active.lock')));
});
test('missing Claude login directs users to Duet sign-in before building or creating state', async () => {
  const dir = await project(), calls = [];
  await assert.rejects(runDuet({ project: dir, prompt: 'Build', runner: runner('logged_out', calls) }), error => {
    assert.match(error.message, /claude/i);
    assert.match(error.message, /Sign in.*Duet.s account settings/);
    assert.doesNotMatch(error.message, /claude auth login|Terminal/);
    return true;
  });
  assert.equal(calls.length, 2);
  await assert.rejects(access(path.join(dir, '.duet')));
});
test('round limit is reported as needs_attention, never success', async () => {
  const result = await runDuet({ project: await project(), prompt: 'Build', maxRounds: 1, runner: runner('never_approve') });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.rounds.length, 1);
});
for (const scenario of ['builder_blocked', 'reviewer_blocked']) {
  test(`${scenario} stops the loop`, async () => {
    const result = await runDuet({ project: await project(), prompt: 'Build', runner: runner(scenario) });
    assert.equal(result.status, 'blocked');
    assert.equal(result.rounds.length, 1);
  });
}
for (const scenario of ['error', 'malformed', 'contradictory']) {
  test(`${scenario} review fails and releases project lock`, async () => {
    const dir = await project();
    await assert.rejects(runDuet({ project: dir, prompt: 'Build', runner: runner(scenario) }));
    await assert.rejects(access(path.join(dir, '.duet', 'active.lock')));
    const retry = await runDuet({ project: dir, prompt: 'Build', runner: runner('approve') });
    assert.equal(retry.status, 'needs_attention');
  });
}
test('project lock prevents overlapping builds', async () => {
  const dir = await project();
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const active = new Promise(resolve => { started = resolve; });
  const base = runner('approve');
  const first = runDuet({ project: dir, prompt: 'Build', runner: async (cmd, args, opts) => {
    if (opts.input && cmd === 'claude' && !args.includes('--json-schema')) { started(); await waiting; }
    return base(cmd, args, opts);
  } });
  await active;
  try { await assert.rejects(runDuet({ project: dir, prompt: 'Another', runner: runner() }), /Another Duet run/); }
  finally { release(); }
  await first;
});
test('both helpers can code, while review is limited to read tools', () => {
  const codex = codexArgs('/tmp', '/tmp/schema', '/tmp/out');
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'workspace-write');
  const claude = claudeArgs();
  assert.equal(claude[claude.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(claude.includes('--strict-mcp-config'));
  assert.ok(claude.includes('--restricted'));
  const coding = claudeArgs(undefined, { coding: true });
  assert.equal(coding[coding.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
  assert.equal(coding[coding.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(!coding.includes('Bash'));
  assert.ok(![...codex, ...claude].some(x => x.includes('dangerously')));
});
test('invalid build reports and limits are rejected', async () => {
  assert.throws(() => validateBuild({ status: 'built' }), /invalid build/);
  await assert.rejects(runDuet({ project: '/tmp', prompt: 'Build', maxRounds: 0 }), /Rounds/);
  await assert.rejects(runDuet({ project: '/tmp', prompt: 'Build', timeoutMs: NaN }), /Timeout/);
});
test('timeout kills a nonresponsive helper', async () => {
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /timed out/);
});
test('cancellation kills a running helper', async () => {
  const controller = new AbortController();
  const pending = execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /Cancelled/);
});
test('missing executable is actionable and excessive output is bounded', async () => {
  await assert.rejects(execute('/nonexistent/duet-tool', []), { code: 'ENOENT' });
  await assert.rejects(execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { maxBytes: 100 }), /output exceeded/);
});
