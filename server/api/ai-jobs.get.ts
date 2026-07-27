import type { AiJobKind } from '../utils/aiJobs'

// Which claude jobs are currently running — for one target (?number= or
// ?branch=, so a client landing on its page can re-attach to the streams) or
// for every target in the repo (neither param, so the list view can badge
// busy rows).
export default defineEventHandler((event) => {
  const query = getQuery(event)
  const path = resolveRepoDir(String(query.repo ?? ''))
  if (query.number || query.branch) {
    const target = resolveTarget(event)
    // `failures` explains a run that died while nothing was attached to its
    // stream, so re-attaching shows the reason instead of an empty result.
    return {
      running: runningAiJobs(path, target.storeKey),
      failures: recentAiFailures(path, target.storeKey),
    }
  }
  const prs: Record<string, AiJobKind[]> = {}
  for (const job of allRunningAiJobs(path)) {
    ;(prs[job.number] ??= []).push(job.jobKind)
  }
  return { prs }
})
