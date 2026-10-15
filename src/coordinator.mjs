// Routing policy is intentionally inspectable. The planning model assesses the
// task; these rules enforce the user's mode, permissions, and call budget.
export const modes = ['economy', 'balanced', 'quality'];
export const presets = {
  economy: { label: 'Save usage', maxCalls: 6 },
  balanced: { label: 'Balanced', maxCalls: 10 },
  quality: { label: 'Best quality', maxCalls: 16 },
};
export function coordinatorOptions({ optimization = 'quality', maxCalls, tokenLimit = 0 } = {}) {
  if (!modes.includes(optimization)) throw new Error('Choose Save usage, Balanced, or Best quality.');
  maxCalls ??= presets[optimization].maxCalls;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 40) throw new Error('Agent-step limit must be between 1 and 40.');
  if (!Number.isInteger(tokenLimit) || tokenLimit < 0 || tokenLimit > 10_000_000) throw new Error('Reported-token threshold must be between 0 and 10,000,000.');
  return { optimization, maxCalls, tokenLimit };
}
export const planSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    complexity: { type: 'string', enum: ['focused', 'standard', 'complex'] },
    collaboration: { type: 'string', enum: ['single-builder', 'paired'] },
    reason: { type: 'string' }, plan: { type: 'string' },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
  }, required: ['complexity', 'collaboration', 'reason', 'plan', 'acceptanceCriteria'],
};
export function validatePlan(value) {
  if (!value || !['focused', 'standard', 'complex'].includes(value.complexity)
    || !['single-builder', 'paired'].includes(value.collaboration)
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 4000
    || typeof value.plan !== 'string' || !value.plan.trim() || value.plan.length > 50_000
    || !Array.isArray(value.acceptanceCriteria) || !value.acceptanceCriteria.length || value.acceptanceCriteria.length > 30
    || !value.acceptanceCriteria.every(item => typeof item === 'string' && item.trim() && item.length < 4000)) {
    throw new Error('The coordinator returned an invalid plan.');
  }
  return { complexity: value.complexity, collaboration: value.collaboration, reason: value.reason,
    plan: value.plan, acceptanceCriteria: value.acceptanceCriteria };
}
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function reportedUsage(agent, raw) {
  try {
    if (agent === 'claude') {
      const result = JSON.parse(raw), usage = result.usage;
      const models = Object.entries(result.modelUsage ?? {});
      if (models.length && models.every(([, value]) => number(value.inputTokens) !== null && number(value.outputTokens) !== null)) {
        let input = 0, output = 0, cached = 0;
        for (const [, value] of models) {
          const read = number(value.cacheReadInputTokens) ?? 0, created = number(value.cacheCreationInputTokens) ?? 0;
          input += value.inputTokens + read + created; output += value.outputTokens; cached += read;
        }
        return { input, output, cached, total: input + output, actualModels: models.map(([name]) => name).filter(name => /^[\w.:-]{1,100}$/.test(name)) };
      }
      if (!usage || number(usage.input_tokens) === null || number(usage.output_tokens) === null) return null;
      const cacheRead = number(usage.cache_read_input_tokens) ?? 0, cacheWrite = number(usage.cache_creation_input_tokens) ?? 0;
      return { input: usage.input_tokens + cacheRead + cacheWrite, output: usage.output_tokens,
        cached: cacheRead, total: usage.input_tokens + cacheRead + cacheWrite + usage.output_tokens,
        actualModels: Object.keys(result.modelUsage ?? {}).filter(name => /^[\w.:-]{1,100}$/.test(name)) };
    }
    const completed = raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } })
      .filter(event => event.type === 'turn.completed' && event.usage);
    if (!completed.length) return null;
    let input = 0, output = 0, cached = 0;
    for (const { usage } of completed) {
      if (number(usage.input_tokens) === null || number(usage.output_tokens) === null) return null;
      input += usage.input_tokens; output += usage.output_tokens; cached += number(usage.cached_input_tokens) ?? 0;
    }
    return { input, output, cached, total: input + output, actualModels: [] };
  } catch { return null; }
}
export function modelUnavailable(response) {
  let message = response.stderr ?? '';
  try { const json = JSON.parse(response.stdout); if (json.is_error) message += '\n' + (json.result ?? ''); } catch {}
  // Never retry quota, network, permissions, or arbitrary application failures.
  return /(?:model[^\n]{0,100}(?:not found|does not exist|not available|not supported|not accessible)|(?:unknown|unsupported|invalid) model)/i.test(message)
    && !/rate.limit|quota|usage.limit|permission|policy|allowlist|organization|administrator/i.test(message);
}
export function createCoordinator(options = {}) {
  const { optimization, maxCalls, tokenLimit } = coordinatorOptions(options);
  const state = { version: 1, mode: optimization, label: presets[optimization].label,
    maxCalls, tokenLimit, assessment: null, decisions: [], calls: [], reportedTokens: 0, callsWithUsage: 0 };
  const unavailable = new Set();
  function note(reason) { state.decisions.push({ reason, time: new Date().toISOString() }); }
  return {
    snapshot: () => structuredClone(state),
    assess(plan) { state.assessment = validatePlan(plan); note(plan.reason); },
    note,
    paired(round) { return optimization === 'quality' || (round === 1 && optimization === 'balanced' && state.assessment?.collaboration === 'paired'); },
    route(agent, stage, round = 1) {
      const complex = state.assessment?.complexity === 'complex';
      const escalated = round > 1;
      let model, effort, reason;
      if (agent === 'claude') {
        const strong = optimization === 'quality' || (optimization === 'balanced' && (complex || escalated) && stage !== 'plan');
        model = strong ? 'opus' : 'sonnet';
        effort = strong ? 'high' : optimization === 'economy' && stage === 'plan' ? 'low' : 'medium';
        reason = strong ? 'Use a stronger model for deeper implementation or review.' : 'Use Sonnet for this bounded planning, coding, or review step.';
      } else {
        model = optimization === 'quality' ? 'gpt-6-astra'
          : optimization === 'economy' && !complex && !escalated ? 'gpt-6-luna' : 'gpt-6.1-sol';
        effort = model === 'gpt-6-luna' || optimization === 'quality' || complex || escalated ? 'high' : 'medium';
        reason = model === 'gpt-6-luna' ? 'Use the efficient model for a bounded first implementation.'
          : escalated ? 'Unresolved review findings justify stronger reasoning on the repair.'
            : optimization === 'quality' ? 'Prioritize deeper reasoning for implementation and testing.' : 'Balance implementation capability with model usage.';
      }
      if (unavailable.has(`${agent}:${model}`)) return { agent, model: null, effort: null, reason: 'The requested model was unavailable; use the provider default.' };
      return { agent, model, effort, reason };
    },
    fallback(route) { unavailable.add(`${route.agent}:${route.model}`); note(`${route.model} was unavailable. Retrying once with the provider default; usage may differ.`); return { agent: route.agent, model: null, effort: null, reason: 'Provider-default compatibility fallback.' }; },
    begin(route, stage) {
      if (state.calls.length >= maxCalls || (tokenLimit && state.reportedTokens >= tokenLimit)) {
        const reason = state.calls.length >= maxCalls ? 'Reached the agent-step limit.' : 'Reached the reported-token threshold.';
        state.stopReason = reason + ' Saved the work without starting another agent step.';
        throw Object.assign(new Error(state.stopReason), { code: 'DUET_BUDGET' });
      }
      const call = { ...route, stage, status: 'running', startedAt: new Date().toISOString(), usage: null };
      state.calls.push(call); return call;
    },
    finish(call, response, status = 'completed') {
      call.status = status; call.finishedAt = new Date().toISOString();
      call.durationMs = Date.parse(call.finishedAt) - Date.parse(call.startedAt);
      call.usage = response ? reportedUsage(call.agent, response.stdout ?? '') : null;
      if (call.usage) { state.reportedTokens += call.usage.total; state.callsWithUsage++; }
    },
  };
}
