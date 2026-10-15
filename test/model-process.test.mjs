import test from 'node:test';
import assert from 'node:assert/strict';
import { runModel, normalizeModelResult } from '../src/model-process.mjs';
import { askDuet } from '../src/conversations.mjs';

test('only the main Claude result can become a completed answer', () => {
  const child = { type: 'result', parent_tool_use_id: 'child', result: 'Child report' };
  const parent = { type: 'result', parent_tool_use_id: null, result: 'Final answer' };
  for (const events of [[child], [{ type: 'assistant', message: 'Still working' }]]) {
    assert.equal(normalizeModelResult('claude', { stdout: JSON.stringify(events[0]) }).stdout, '');
  }
  const stream = [child, parent, child].map(JSON.stringify).join('\n');
  assert.equal(JSON.parse(normalizeModelResult('claude', { stdout: stream }).stdout).result, 'Final answer');
});

test('activity reports timestamps without leaking raw provider output', async () => {
  const events = [];
  await runModel('claude', [], { stage: 'claude-code-1', onActivity: event => events.push(event), runner: async (_agent, _args, options) => {
    options.onOutput({ stream: 'stdout', chunk: Buffer.from('private provider output') });
    return { code: 0, stdout: JSON.stringify({ type: 'result', result: 'Done' }), stderr: '' };
  } });
  assert.equal(events[0].lastActivityAt, null);
  assert.ok(events[1].lastActivityAt);
  assert.equal(events[1].stage, 'claude-code-1');
  assert.doesNotMatch(JSON.stringify(events), /private provider output/);
});

test('a late timeout preserves reported usage without treating the result as success', async () => {
  const stdout = [{ type: 'system' }, { type: 'result', result: 'Partial', usage: { input_tokens: 10, output_tokens: 20 } }].map(JSON.stringify).join('\n');
  const result = await askDuet({ project: '/tmp', prompt: 'Explain', runner: async () => {
    throw Object.assign(new Error('Helper timed out'), { code: 'DUET_TIMEOUT', result: { code: null, stdout, stderr: '' } });
  } });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.answer, undefined);
  assert.equal(result.coordinator.reportedTokens, 30);
});
