import type { AiJobKind } from '../utils/aiJobs'

const KINDS: AiJobKind[] = ['rating', 'risk', 'tour', 'self', 'analyze']

// Explicitly kill a running claude job. Closing the EventSource no longer
// cancels anything — jobs run detached — so the cancel buttons call this.
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const path = resolveRepoDir(String(body?.repo ?? ''))
  const number = String(body?.number ?? '')
  const kind = String(body?.kind ?? '') as AiJobKind
  if (!/^\d+$/.test(number)) throw createError({ statusCode: 400, message: 'bad number' })
  if (!KINDS.includes(kind)) throw createError({ statusCode: 400, message: 'bad kind' })
  return { cancelled: cancelAiJob(kind, path, number) }
})
