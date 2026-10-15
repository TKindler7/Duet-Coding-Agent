#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { doctor, runDuet } from './duet.mjs';

const help = `Duet — one prompt, two coding assistants

node src/cli.mjs --project /path/to/project "Build a habit tracker"
node src/cli.mjs --project /path/to/project --prompt-file brief.md
node src/cli.mjs --doctor

Adaptive coordinator → implementation → tests → independent review → focused repairs.
Defaults: up to 3 build/review rounds; 60 minutes per helper call, stopping after 10 minutes without output.
Options: --rounds 1..10, --timeout 1..7200 (seconds), --optimization quality|balanced|economy,
--max-steps 1..40, --token-limit 0..10000000 (reported tokens; checked between steps).
Best quality is the default. Each agent step may include multiple model requests.
Ctrl+C stops the active helper and preserves the run records.
Requires Node 22+, signed-in codex and claude CLIs on PATH.`;

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string' }, 'prompt-file': { type: 'string' }, rounds: { type: 'string', default: '3' },
    optimization: { type: 'string', default: 'quality' }, 'max-steps': { type: 'string' }, 'token-limit': { type: 'string', default: '0' },
    timeout: { type: 'string', default: '3600' }, doctor: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) console.log(help);
  else if (values.doctor) {
    const status = await doctor({ signal: controller.signal });
    for (const [name, result] of Object.entries(status)) console.log(`${result.ready ? '✓' : '✗'} ${name}: ${result.action}`);
    if (Object.values(status).some(item => !item.ready)) process.exitCode = 1;
  } else {
    if (!values.project) throw new Error('Provide --project /path/to/project.\n\n' + help);
    if (values['prompt-file'] && positionals.length) throw new Error('Use either a prompt argument or --prompt-file.');
    const prompt = values['prompt-file'] ? await readFile(values['prompt-file'], 'utf8') : positionals.join(' ');
    const result = await runDuet({ project: values.project, prompt, maxRounds: Number(values.rounds),
      optimization: values.optimization, maxCalls: values['max-steps'] ? Number(values['max-steps']) : undefined, tokenLimit: Number(values['token-limit']),
      timeoutMs: Number(values.timeout) * 1000, signal: controller.signal,
      onProgress: step => console.log(`[${new Date().toLocaleTimeString()}] ${step.replaceAll('-', ' ')}`) });
    console.log(`\n${result.status === 'approved' ? 'Build approved by Claude.' : `Stopped: ${result.status}.`}\nReport: ${result.runDir}/REPORT.md`);
    console.log(result.rounds.at(-1)?.build?.run_instructions ?? '');
    if (result.status !== 'approved') process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
