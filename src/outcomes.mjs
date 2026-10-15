// Personal, local observations. Different tasks/modes are not a controlled benchmark.
export function outcomeSummary(jobs = []) {
  const modes = ['quality','balanced','economy'].map(mode => {
    const builds = jobs.filter(job => job.mode !== 'ask' && job.finishedAt && job.coordinator?.mode === mode);
    const reviewed = builds.filter(job => ['works','needs_fixes'].includes(job.feedback?.outcome));
    const knownUsage = builds.filter(job => job.coordinator.callsWithUsage > 0);
    return {mode, builds:builds.length, feedbackCount:reviewed.length,
      works:reviewed.filter(job=>job.feedback.outcome==='works').length,
      needsFixes:reviewed.filter(job=>job.feedback.outcome==='needs_fixes').length,
      reportedTokens:knownUsage.reduce((sum,job)=>sum+job.coordinator.reportedTokens,0),
      buildsWithUsage:knownUsage.length,
      steps:builds.reduce((sum,job)=>sum+(job.coordinator.calls?.length ?? 0),0),
      durationMs:builds.reduce((sum,job)=>sum+Math.max(0,(Date.parse(job.finishedAt)-Date.parse(job.startedAt))||0),0)};
  });
  return {modes,note:'Local feedback only. Different tasks and incomplete usage reports cannot establish model quality or credit savings.'};
}
