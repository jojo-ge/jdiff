import { categorize, CATEGORY_ORDER, type FileCategory } from '../../app/utils/fileCategories'

export interface ReviewRating {
  score: number
  effort: 'quick' | 'moderate' | 'involved' | 'heavy'
  summary: string
  factors: { label: string; impact: 'good' | 'neutral' | 'bad'; detail: string }[]
  readingOrder: { path: string; note: string }[]
}

// The diff itself is capped before it goes into the prompt; the numstat
// breakdown always covers every file, so claude still sees the full shape.
const MAX_DIFF_CHARS = 60_000

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
    if (kind === 'log') console.log(`[review-rating #${number}] ${data.text}`)
  }
  const log = (text: string) => push('log', { text })

  ;(async () => {
    try {
      log('fetching PR metadata via gh…')
      const meta = JSON.parse(
        await run('gh', ['pr', 'view', number, '--json', 'title,baseRefName'], path),
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
      const [numstat, diff] = await Promise.all([
        run('git', ['diff', '--numstat', '-M', range], path),
        run('git', ['diff', '--no-color', '-M', range], path),
      ])

      // Per-category totals using the same buckets the file nav shows.
      const byCategory = new Map<FileCategory, { files: number; add: number; del: number; paths: string[] }>()
      for (const line of numstat.trim().split('\n')) {
        if (!line) continue
        const [add, del, ...rest] = line.split('\t')
        const file = rest.join('\t')
        const cat = categorize(file.replace(/^.*=> ?/, '').replace(/[{}]/g, ''))
        const entry = byCategory.get(cat) ?? { files: 0, add: 0, del: 0, paths: [] }
        entry.files++
        entry.add += add === '-' ? 0 : Number(add)
        entry.del += del === '-' ? 0 : Number(del)
        entry.paths.push(file)
        byCategory.set(cat, entry)
      }

      const breakdown = CATEGORY_ORDER
        .filter((c) => byCategory.has(c))
        .map((c) => {
          const e = byCategory.get(c)!
          const sample = e.paths.slice(0, 15).join(', ')
          return `- ${c}: ${e.files} file(s), +${e.add}/−${e.del} — ${sample}${e.paths.length > 15 ? ', …' : ''}`
        })
        .join('\n')

      const totalFiles = [...byCategory.values()].reduce((n, e) => n + e.files, 0)
      const summaryLine = CATEGORY_ORDER
        .filter((c) => byCategory.has(c))
        .map((c) => `${byCategory.get(c)!.files} ${c}`)
        .join(', ')
      log(`${totalFiles} file(s): ${summaryLine}`)

      const truncated = diff.length > MAX_DIFF_CHARS
      const diffSnippet = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff
      log(
        `diff is ${diff.length.toLocaleString()} chars` +
        (truncated ? ` — truncating to ${MAX_DIFF_CHARS.toLocaleString()} for the prompt` : ''),
      )

      const prompt = `You are rating how easy a pull request will be to REVIEW (not how good the code is).

PR title: ${meta.title}

File breakdown by category (source changes cost the most review effort; tests and docs are cheaper to review; generated files/lockfiles are near-free):
${breakdown || '- (no files changed)'}

Consider: total size, how much is real source vs tests/docs/generated noise, number of files and how scattered the change is, complexity of the logic in the diff, renames/moves, whether tests accompany source changes, and anything risky (migrations, config, security-sensitive code).

Diff${truncated ? ` (truncated to first ${MAX_DIFF_CHARS} characters — weigh the breakdown above for overall size)` : ''}:
${diffSnippet}

Respond with ONLY a JSON object, no markdown fences, in exactly this shape:
{
  "score": <integer 1-10, 10 = trivially easy to review>,
  "effort": <"quick" | "moderate" | "involved" | "heavy">,
  "summary": <one or two sentences a reviewer would want to know before opening the PR>,
  "factors": [
    { "label": <short factor name>, "impact": <"good" | "neutral" | "bad">, "detail": <one short sentence> }
  ],
  "readingOrder": [
    { "path": <file path exactly as it appears in the breakdown above>, "note": <what this file does in the change and what to check, one short sentence> }
  ]
}
Include 3 to 6 factors, most significant first.
For readingOrder, list the files in the order a reviewer should read them to understand the change fastest — start with the file that anchors the change (schema, core logic, interface), then what depends on it, tests near the source they cover. Omit generated files, lockfiles, and files too trivial to need a note; at most 20 entries.`

      log('starting claude (this is the slow part)…')
      const resultText = await runClaude(prompt, { log, signal: abort.signal })
      const rating = extractJson(resultText)

      if (typeof rating.score !== 'number' || !Array.isArray(rating.factors)) {
        throw createError({ statusCode: 500, message: 'claude returned an unexpected shape' })
      }
      const cleaned = {
        score: Math.max(1, Math.min(10, Math.round(rating.score))),
        effort: rating.effort,
        summary: String(rating.summary ?? ''),
        factors: rating.factors.slice(0, 6),
        readingOrder: (Array.isArray(rating.readingOrder) ? rating.readingOrder : [])
          .filter((e: any) => typeof e?.path === 'string')
          .map((e: any) => ({ path: e.path, note: String(e.note ?? '') }))
          .slice(0, 20),
      } satisfies ReviewRating
      const createdAt = new Date().toISOString()
      saveRating({ repo: path, number, rating: cleaned, createdAt })
      push('result', { rating: cleaned, createdAt })
    } catch (err: any) {
      push('error', { message: String(err.message ?? err).slice(0, 500) })
    } finally {
      await stream.close()
    }
  })()

  return stream.send()
})
