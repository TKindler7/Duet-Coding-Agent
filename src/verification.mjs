import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { executeWorkspaceCheck } from './workspace-process.mjs';

export const criterionEvidenceSchema = {
  type: 'array', maxItems: 30,
  items: { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', pattern: '^AC[1-9][0-9]?$' },
    status: { type: 'string', enum: ['passed', 'failed', 'not_tested'] },
    evidence: { type: 'string', description: 'Specific observed result, test/file reference, or reason this requirement was not tested. A claim is not independent verification.' },
  }, required: ['id', 'status', 'evidence'] },
};

export function validateCriterionEvidence(value) {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Build report must include requirement evidence.');
  const ids = new Set();
  return value.map(item => {
    if (!item || !/^AC[1-9][0-9]?$/.test(item.id) || ids.has(item.id)
      || !['passed', 'failed', 'not_tested'].includes(item.status)
      || typeof item.evidence !== 'string' || !item.evidence.trim() || item.evidence.length > 12_000) {
      throw new Error('Build report has invalid or duplicate requirement evidence.');
    }
    ids.add(item.id);
    return { id: item.id, status: item.status, evidence: item.evidence.trim() };
  });
}

export function initialVerification(acceptanceCriteria) {
  return { status: 'incomplete', criteria: acceptanceCriteria.map((text, index) => ({
    id: `AC${index + 1}`, text, status: 'not_tested', evidence: 'Implementation and verification have not completed.', source: 'none',
  })), checks: [], summary: 'Requirements are ready. Verification has not completed.' };
}

// These are fixed project check entry points, never a command supplied by a model.
// Project scripts still execute project code. They run with bounded resources and
// no inherited provider credentials; dependencies are never installed here.
function checkEnvironment() {
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT'];
  const env = Object.fromEntries(names.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  return { ...env, CI: '1', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
}
const tail = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-12_000);

export async function runProjectChecks(project, { runner = executeWorkspaceCheck, signal, timeoutMs = 120_000, onCheck = () => {} } = {}) {
  const packageFile = path.join(project, 'package.json');
  let manifest;
  try {
    if (await realpath(packageFile) !== packageFile) throw new Error('package.json is a symbolic link; automatic checks were skipped.');
    if ((await stat(packageFile)).size > 1_048_576) throw new Error('package.json is too large to inspect safely.');
    manifest = JSON.parse(await readFile(packageFile, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('package.json must contain an object.');
  } catch (error) {
    const output = error.code === 'ENOENT' ? 'No package.json found. Duet has no supported automatic checks for this project yet.' : error.message;
    const checks = [{ name: 'project', status: 'not_run', source: 'local', output }];
    await onCheck(checks); return checks;
  }
  const names = ['test', 'build'].filter(name => typeof manifest.scripts?.[name] === 'string' && manifest.scripts[name].trim());
  if (!names.length) {
    const checks = [{ name: 'project', status: 'not_run', source: 'local', output: 'No test or build script is declared. Add a project check or verify the requirements yourself.' }];
    await onCheck(checks); return checks;
  }
  const checks = [];
  for (const name of names) {
    signal?.throwIfAborted();
    const started = Date.now();
    const check = { name, command: `npm --ignore-scripts run ${name}`, status: 'running', source: 'local', startedAt: new Date().toISOString() };
    checks.push(check); await onCheck(structuredClone(checks));
    try {
      const reply = await runner('npm', ['--ignore-scripts', 'run', name], {
        cwd: project, signal, timeoutMs: Math.min(120_000, Math.max(1_000, timeoutMs)),
        maxBytes: 1_048_576, env: checkEnvironment(),
      });
      check.exitCode = reply.code; check.status = reply.code === 0 && !reply.signal ? 'passed' : 'failed';
      check.output = tail(`${reply.stdout ?? ''}\n${reply.stderr ?? ''}`).trim() || (check.status === 'passed' ? 'Process exited successfully without output.' : 'Project check did not finish successfully.');
      if (reply.signal) check.signal = reply.signal;
    } catch (error) {
      check.status = signal?.aborted ? 'cancelled' : ['ENOENT', 'DUET_CHECK_UNAVAILABLE'].includes(error.code) ? 'not_run' : 'failed';
      check.output = tail(`${error.message}\n${error.result?.stdout ?? ''}\n${error.result?.stderr ?? ''}`).trim();
      if (error.result?.code !== undefined) check.exitCode = error.result.code;
      if (signal?.aborted) throw error;
    } finally {
      check.durationMs = Date.now() - started;
      check.finishedAt = new Date().toISOString();
      await onCheck(structuredClone(checks));
    }
  }
  return checks;
}

export function summarizeVerification(criteria, reports, checks) {
  const evidence = new Map(validateCriterionEvidence(reports).map(item => [item.id, item]));
  const known = new Set(criteria.map(item => item.id));
  if ([...evidence.keys()].some(id => !known.has(id))) throw new Error('Build report references an unknown requirement.');
  const result = criteria.map(({ id, text }) => {
    const report = evidence.get(id);
    return { id, text, status: report?.status === 'passed' ? 'reported_pass' : report?.status ?? 'not_tested',
      evidence: report?.evidence ?? 'The builder did not supply evidence for this requirement.', source: report ? 'model' : 'none' };
  });
  const failed = result.some(item => item.status === 'failed') || checks.some(item => item.status === 'failed');
  const localPassed = checks.filter(item => item.status === 'passed').length;
  return { criteria: result, checks, status: failed ? 'failed' : 'incomplete', checkedAt: new Date().toISOString(),
    summary: failed ? 'A requirement or independently executed project check failed.'
      : `${localPassed ? `${localPassed} local project check${localPassed === 1 ? '' : 's'} passed. ` : ''}Requirements still need your confirmation; model reports are shown separately from local checks.` };
}
