import type { Tour, TourStop } from '../../app/utils/tour'

const MAX_DIFF_CHARS = 60_000
const MAX_STOPS = 20

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const path = resolveRepoDir(String(query.repo ?? ''))
  const number = String(query.number ?? '')
  if (!/^\d+$/.test(number)) throw createError({ statusCode: 400, message: 'bad ?number=' })

  const stream = createEventStream(event)
  // If the browser closes the EventSource mid-run, kill the claude process.
  const abort = new AbortController()
  stream.onClosed(() => abort.abort())
  const started = Date.now()
  const push = (kind: string, data: any) => {
    if (abort.signal.aborted) return
    const payload = { kind, t: ((Date.now() - started) / 1000).toFixed(1), ...data }
    stream.push(JSON.stringify(payload))
    if (kind === 'log') console.log(`[tour #${number}] ${data.text}`)
  }
  const log = (text: string) => push('log', { text })

  ;(async () => {
    try {
      log('fetching PR metadata via gh…')
      const meta = JSON.parse(
        await run('gh', ['pr', 'view', number, '--json', 'title,body,baseRefName'], path),
      )
      const base: string = meta.baseRefName

      log(`fetching refs for origin/${base} and PR #${number}…`)
      await run(
        'git',
        [
          'fetch', '--quiet', 'origin',
          `+refs/heads/${base}:refs/remotes/origin/${base}`,
          `+refs/pull/${number}/head:refs/differ/pr-${number}`,
        ],
        path,
      )

      log('computing diff locally…')
      const range = `origin/${base}...refs/differ/pr-${number}`
      const diff = await run('git', ['diff', '--no-color', '-M', range], path)

      const truncated = diff.length > MAX_DIFF_CHARS
      const diffSnippet = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff
      log(
        `diff is ${diff.length.toLocaleString()} chars` +
        (truncated ? ` — truncating to ${MAX_DIFF_CHARS.toLocaleString()} for the prompt` : ''),
      )

      const prompt = `You are writing a guided tour of a pull request for a reviewer who has not seen it before. You are running inside the repository being reviewed, with the PR's head available as the git ref refs/differ/pr-${number} — use your tools (Read, Grep, Glob, Bash with git show/git diff) to understand the change well enough to narrate it, especially the parts of the diff below that were truncated or that need surrounding context.

PR #${number}: ${meta.title}
PR description:
${meta.body || '(none)'}

Diff${truncated ? ` (truncated to first ${MAX_DIFF_CHARS} characters — inspect the rest with git diff ${range} yourself)` : ''}:
${diffSnippet}

Respond with ONLY a JSON object, no markdown fences, in exactly this shape:
{
  "overview": <2-4 short paragraphs of markdown: what this change does and why, how it is structured, and any concepts the reviewer needs before reading code. Write for someone about to review it, not marketing copy.>,
  "stops": [
    {
      "path": <file path exactly as it appears in the diff>,
      "side": <"RIGHT" for lines in the new version of the file (the usual case), "LEFT" only when pointing at deleted lines>,
      "line": <first line number of the region, in that version of the file>,
      "endLine": <last line number of the region; keep regions under ~40 lines>,
      "title": <short label for this stop, a few words>,
      "note": <1-3 sentences: what this code does in the change, why it is at this point in the tour, and what the reviewer should check>
    }
  ]
}

Guidance for stops:
- 5 to ${MAX_STOPS} stops, ordered as a narrative: start where the change is anchored (schema, core logic, key interface), then follow the consequences outward; put tests near the code they cover.
- Anchor every stop on lines the PR actually changes, so it lands on visible diff lines.
- Cover the parts that matter; skip generated files, lockfiles, and repetitive mechanical edits (mention those once in the overview instead).
- Line numbers must be real: count them from the diff hunk headers or read the file at refs/differ/pr-${number}. Do not guess.`

      log('starting claude (this is the slow part)…')
      const resultText = await runClaude(prompt, { log, signal: abort.signal })
      const parsed = extractJson(resultText)

      const stops: TourStop[] = (Array.isArray(parsed.stops) ? parsed.stops : [])
        .filter((s: any) => typeof s?.path === 'string' && Number.isInteger(s?.line) && s.line >= 1)
        .map((s: any) => ({
          path: s.path,
          side: s.side === 'LEFT' ? 'LEFT' as const : 'RIGHT' as const,
          line: s.line,
          endLine: Number.isInteger(s.endLine) && s.endLine >= s.line ? s.endLine : s.line,
          title: String(s.title ?? '').slice(0, 120),
          note: String(s.note ?? ''),
        }))
        .slice(0, MAX_STOPS)
      if (!stops.length || typeof parsed.overview !== 'string') {
        throw createError({ statusCode: 500, message: 'claude returned an unexpected shape' })
      }
      log(`tour has ${stops.length} stop(s)`)

      const tour: Tour = { overview: parsed.overview, stops }
      const createdAt = new Date().toISOString()
      saveTour({ repo: path, number, tour, createdAt })
      push('result', { tour, createdAt })
    } catch (err: any) {
      push('error', { message: String(err.message ?? err).slice(0, 500) })
    } finally {
      await stream.close()
    }
  })()

  return stream.send()
})
