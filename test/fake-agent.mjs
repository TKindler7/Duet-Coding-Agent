// Deterministic stand-ins exercise real subprocesses without spending model tokens.
import { readFile, writeFile } from 'node:fs/promises';
const [agent, ...args] = process.argv.slice(2);
const scenario = process.env.DUET_TEST_SCENARIO ?? 'fix';
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: scenario !== 'logged_out' }));
} else if (args[0] === 'login') {
  console.log('Logged in using test credentials');
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (agent === 'codex') {
    let count = 0;
    try { count = Number(await readFile('build-count.txt', 'utf8')); } catch {}
    count++;
    await writeFile('build-count.txt', String(count));
    await writeFile('app.txt', count > 1 ? 'fixed' : 'first build');
    const out = args[args.indexOf('--output-last-message') + 1];
    await writeFile(out, JSON.stringify({ status: scenario === 'builder_blocked' ? 'blocked' : 'built',
      summary: count > 1 ? 'Addressed Claude feedback' : 'Created app',
      checks: ['Fixture check passed'], requirements: [{ id: 'AC1', status: 'passed', evidence: 'Inspected app.txt in the fixture.' }], run_instructions: 'Read app.txt' }));
    console.log(JSON.stringify({ type: 'turn.completed' }));
  } else if (args.includes('--json-schema') && JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.complexity) {
    console.log(JSON.stringify({ structured_output: { complexity: 'standard', collaboration: 'paired', reason: 'Separate implementation and integration work.', plan: 'Implement app.txt and verify its contents.', acceptanceCriteria: ['Working app.txt'] } }));
  } else if (args[args.indexOf('--tools') + 1].includes('Write')) {
    await writeFile('claude-component.txt', 'Component implemented by Claude');
    console.log(JSON.stringify({ result: 'Implemented claude-component.txt. Codex: integrate it and run checks.' }));
  } else if (!args.includes('--json-schema')) {
    console.log(JSON.stringify({ result: 'Implement app.txt and verify its contents.' }));
  } else {
    if (scenario === 'error') { console.error('Provider unavailable'); process.exit(1); }
    if (scenario === 'malformed') { console.log('not json'); process.exit(0); }
    const count = Number(await readFile('build-count.txt', 'utf8'));
    const approved = scenario === 'approve' || (count > 1 && scenario !== 'never_approve');
    const verdict = scenario === 'reviewer_blocked' ? 'blocked' : approved ? 'approved' : 'changes_requested';
    const findings = approved ? [] : ['app.txt: replace the placeholder with the finished implementation.'];
    if (scenario === 'contradictory') findings.push('Still broken');
    console.log(JSON.stringify({ structured_output: { verdict: scenario === 'contradictory' ? 'approved' : verdict,
      summary: approved ? 'Verified app.txt.' : 'Changes required.', findings } }));
  }
}
