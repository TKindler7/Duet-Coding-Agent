import test from 'node:test';
import assert from 'node:assert/strict';
import { doctor } from '../src/duet.mjs';

test('account status identifies existing subscription logins without returning credentials', async () => {
  const accounts = await doctor({ runner: async name => name === 'codex'
    ? { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' }
    : { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'private@example.test', subscriptionType: 'max' }), stderr: '' } });
  assert.equal(accounts.codex.authMethod, 'chatgpt');
  assert.equal(accounts.claude.authMethod, 'claude');
  assert.ok(accounts.codex.ready && accounts.claude.ready);
  assert.ok(!JSON.stringify(accounts).includes('private@example.test'));
});

test('API key and signed-out accounts are not presented as subscription connections', async () => {
  const accounts = await doctor({ runner: async name => name === 'codex'
    ? { code: 0, stdout: 'Logged in using an API key', stderr: '' }
    : { code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}', stderr: '' } });
  assert.equal(accounts.codex.authMethod, 'api-key');
  assert.equal(accounts.claude.ready, false);
  assert.equal(accounts.claude.authMethod, null);
});

test('account recovery directs people to Duet controls without returning shell commands or diagnostic output', async () => {
  const calls = [];
  const missing = await doctor({ runner: async (command, args) => {
    calls.push({ command, args });
    throw Object.assign(new Error('private-home-path and secret-token'), { code: 'ENOENT' });
  } });
  assert.deepEqual(calls, [
    { command: 'codex', args: ['login', 'status'] },
    { command: 'claude', args: ['auth', 'status'] },
  ]);
  const signedOut = await doctor({ runner: async command => command === 'claude'
    ? { code: 1, stdout: '{"loggedIn":false}', stderr: 'private-provider-details' }
    : { code: 1, stdout: '', stderr: 'private-provider-details' } });
  const unavailable = await doctor({ runner: async () => { throw new Error('private-home-path and secret-token'); } });
  for (const agent of ['claude', 'codex']) {
    assert.match(missing[agent].action, /Install .*Duet.s account settings/);
    assert.match(signedOut[agent].action, /Sign in.*Duet.s account settings/);
    assert.match(unavailable[agent].action, /Recheck accounts in Duet/);
  }
  assert.doesNotMatch(JSON.stringify({ missing, signedOut, unavailable }), /private-home-path|secret-token|private-provider-details|claude auth login|codex login|Terminal/);
});
