import { RISK_LEVELS, type FileRisk } from '../../app/utils/risk'

// The diff itself is capped before it goes into the prompt; the numstat
// listing always covers every file, so claude still rates all of them.
const MAX_DIFF_CHARS = 60_000

// numstat prints renames as "dir/{old => new}/file" or "old => new";
// collapse to the new path so entries match the diff view's paths.
function newPathOf(numstatPath: string): string {
  if (numstatPath.includes('{')) {
    return numstatPath.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/\/\/+/g, '/')
  }
  const parts = numstatPath.split(' => ')
  return parts.length === 2 ? parts[1] : numstatPath
}

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
    if (kind === 'log') console.log(`[risk-heatmap #${number}] ${data.text}`)
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

      const fileLines: string[] = []
      const knownPaths = new Set<string>()
      for (const line of numstat.trim().split('\n')) {
        if (!line) continue
        const [add, del, ...rest] = line.split('\t')
        const filePath = newPathOf(rest.join('\t'))
        knownPaths.add(filePath)
        fileLines.push(`- ${filePath} (+${add}/−${del})`)
      }
      if (!knownPaths.size) throw createError({ statusCode: 400, message: 'empty diff' })
      log(`${knownPaths.size} changed file(s)`)

      const truncated = diff.length > MAX_DIFF_CHARS
      const diffSnippet = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff
      log(
        `diff is ${diff.length.toLocaleString()} chars` +
        (truncated ? ` — truncating to ${MAX_DIFF_CHARS.toLocaleString()} for the prompt` : ''),
      )

      const prompt = `You are triaging a pull request diff so a reviewer can budget their attention across files. Rate how much careful review each changed file needs — this is about where mistakes could hide, not code quality.

PR title: ${meta.title}

Changed files:
${fileLines.join('\n')}

Diff${truncated ? ` (truncated to first ${MAX_DIFF_CHARS} characters — files missing from it are still listed above; rate them from their path and size)` : ''}:
${diffSnippet}

Respond with ONLY a JSON object, no markdown fences, in exactly this shape:
{
  "files": [
    { "path": <file path exactly as listed above>, "level": <"low" | "medium" | "high">, "note": <one short sentence: why this level, and what to check> }
  ]
}
Rate EVERY file listed above.
- "high": subtle or risky changes that deserve line-by-line scrutiny — core behavior changes, tricky edge cases, concurrency, security-sensitive code, data migrations, error handling that could swallow failures.
- "medium": ordinary logic changes to read normally.
- "low": mechanical, generated, formatting-only, docs, or trivially safe changes the reviewer can skim.`

      log('starting claude (this is the slow part)…')
      const resultText = await runClaude(prompt, { log, signal: abort.signal })
      const parsed = extractJson(resultText)
      if (!Array.isArray(parsed.files)) {
        throw createError({ statusCode: 500, message: 'claude returned an unexpected shape' })
      }

      const risks: FileRisk[] = parsed.files
        .filter((f: any) => knownPaths.has(f?.path) && RISK_LEVELS.includes(f?.level))
        .map((f: any) => ({ path: f.path, level: f.level, note: String(f.note ?? '') }))
      log(`rated ${risks.length}/${knownPaths.size} file(s)`)

      const createdAt = new Date().toISOString()
      saveRiskMap({ repo: path, number, risks, createdAt })
      push('result', { risks, createdAt })
    } catch (err: any) {
      push('error', { message: String(err.message ?? err).slice(0, 500) })
    } finally {
      await stream.close()
    }
  })()

  return stream.send()
})
