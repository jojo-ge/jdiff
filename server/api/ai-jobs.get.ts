import type { AiJobKind } from '../utils/aiJobs'

// Which claude jobs are currently running — for one PR (?number=, so a
// client landing on its page can re-attach to the streams) or for every PR
// in the repo (no ?number=, so the list view can badge busy rows).
export default defineEventHandler((event) => {
  const query = getQuery(event)
  const path = resolveRepoDir(String(query.repo ?? ''))
  const number = String(query.number ?? '')
  if (number) {
    if (!/^\d+$/.test(number)) throw createError({ statusCode: 400, message: 'bad ?number=' })
    return { running: runningAiJobs(path, number) }
  }
  const prs: Record<string, AiJobKind[]> = {}
  for (const job of allRunningAiJobs(path)) {
    ;(prs[job.number] ??= []).push(job.jobKind)
  }
  return { prs }
})
