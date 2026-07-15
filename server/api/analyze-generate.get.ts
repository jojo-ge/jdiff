import { createHash } from 'node:crypto'
import { categorize, CATEGORY_ORDER, type FileCategory } from '../../app/utils/fileCategories'
import type { ReviewRating } from '../utils/aiArtifacts'

// Generates all four review-guidance artifacts — reviewability rating, risk
// heatmap, guided tour, and ask-yourself questions — from a SINGLE claude
// run. One prompt asks for four marker-delimited sections; each section is
// parsed, saved, and pushed to the client independently, so one malformed
// section doesn't take the others down.
const MAX_DIFF_CHARS = 60_000

// Split the response on marker lines like ===RATING===; anything before the
// first marker (preamble prose) is dropped.
function splitSections(text: string): Partial<Record<string, string>> {
  const sections: Partial<Record<string, string>> = {}
  const re = /^\s*={2,}\s*(RATING|RISK|TOUR|QUESTIONS)\s*={2,}\s*$/gim
  let current: string | null = null
  let start = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (current) sections[current] = text.slice(start, m.index)
    current = m[1]!.toUpperCase()
    start = re.lastIndex
  }
  if (current) sections[current] = text.slice(start)
  return sections
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const path = resolveRepoDir(String(query.repo ?? ''))
  const number = String(query.number ?? '')
  if (!/^\d+$/.test(number)) throw createError({ statusCode: 400, message: 'bad ?number=' })

  // ?attach=1 re-attaches to a run that is already in flight without ever
  // starting one — used when reconnecting after a reload or navigation, where
  // "the job finished in the meantime" must not silently kick off a new run.
  if (String(query.attach ?? '') === '1') {
    const existing = getAiJob('analyze', path, number)
    if (existing) return aiJobStream(event, existing)
    const stream = createEventStream(event)
    stream.push(JSON.stringify({ kind: 'done', t: '0.0' })).then(() => stream.close())
    return stream.send()
  }

  // The run lives in the job registry, detached from this connection:
  // navigating away only stops watching, all four artifacts still get
  // generated and saved. A request while a run is in flight attaches to it
  // instead of starting a second claude.
  const job = startOrAttachAiJob({
    kind: 'analyze',
    repo: path,
    number,
    work: async ({ log, push, signal }) => {
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
          `+refs/pull/${number}/head:refs/jdiff/pr-${number}`,
        ],
        path,
      )

      log('computing diff locally…')
      const range = `origin/${base}...refs/jdiff/pr-${number}`
      const [numstat, diff] = await Promise.all([
        run('git', ['diff', '--numstat', '-M', range], path),
        run('git', ['diff', '--no-color', '-M', range], path),
      ])

      // Per-file list (for the risk map) and per-category totals (for the
      // rating) from the same numstat pass.
      const fileLines: string[] = []
      const knownPaths = new Set<string>()
      let totalAdd = 0
      let totalDel = 0
      const byCategory = new Map<FileCategory, { files: number; add: number; del: number; paths: string[] }>()
      for (const line of numstat.trim().split('\n')) {
        if (!line) continue
        const [add, del, ...rest] = line.split('\t')
        const rawPath = rest.join('\t')
        const filePath = newPathOf(rawPath)
        knownPaths.add(filePath)
        fileLines.push(`- ${filePath} (+${add}/−${del})`)
        const cat = categorize(filePath)
        const entry = byCategory.get(cat) ?? { files: 0, add: 0, del: 0, paths: [] }
        entry.files++
        entry.add += add === '-' ? 0 : Number(add)
        entry.del += del === '-' ? 0 : Number(del)
        totalAdd += add === '-' ? 0 : Number(add)
        totalDel += del === '-' ? 0 : Number(del)
        entry.paths.push(rawPath)
        byCategory.set(cat, entry)
      }
      if (!knownPaths.size) throw createError({ statusCode: 400, message: 'empty diff' })
      log(`${knownPaths.size} changed file(s)`)

      const breakdown = CATEGORY_ORDER
        .filter((c) => byCategory.has(c))
        .map((c) => {
          const e = byCategory.get(c)!
          const sample = e.paths.slice(0, 15).join(', ')
          return `- ${c}: ${e.files} file(s), +${e.add}/−${e.del} — ${sample}${e.paths.length > 15 ? ', …' : ''}`
        })
        .join('\n')

      // Identifies "same code, new run" so the consistency review can pin
      // the score to the previous rating when nothing changed.
      const diffHash = createHash('sha256').update(diff).digest('hex')
      const previous = loadRating(path, number)

      const truncated = diff.length > MAX_DIFF_CHARS
      const diffSnippet = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff
      log(
        `diff is ${diff.length.toLocaleString()} chars` +
        (truncated ? ` — truncating to ${MAX_DIFF_CHARS.toLocaleString()} for the prompt` : ''),
      )

      const prompt = `You are preparing four pieces of review guidance for a pull request in a single pass: a reviewability rating, a per-file risk map, a guided tour, and big-picture questions the reviewer must answer for themselves. You are running inside the repository being reviewed, with the PR's head available as the git ref refs/jdiff/pr-${number} — use your tools (Read, Grep, Glob, Bash with git show/git diff) to understand the change well enough to do all four, especially the parts of the diff below that were truncated or that need surrounding context.

PR #${number}: ${meta.title}
PR description:
${meta.body || '(none)'}

Changed files:
${fileLines.join('\n')}

File breakdown by category (source changes cost the most review effort; tests and docs are cheaper to review; generated files/lockfiles are near-free):
${breakdown || '- (no files changed)'}

Diff${truncated ? ` (truncated to first ${MAX_DIFF_CHARS} characters — files missing from it are still listed above; inspect the rest with git diff ${range} yourself)` : ''}:
${diffSnippet}

Respond with ONLY the four sections below, in this order. Begin each section with its marker on a line of its own, exactly as shown (===RATING===, ===RISK===, ===TOUR===, ===QUESTIONS===). No markdown fences anywhere.

===RATING===
Rate how easy this PR will be to REVIEW (not how good the code is). Consider: total size, how much is real source vs tests/docs/generated noise, number of files and how scattered the change is, complexity of the logic in the diff, renames/moves, whether tests accompany source changes, and anything risky (migrations, config, security-sensitive code). A JSON object, in exactly this shape:
${RATING_FORMAT}
${RATING_RUBRIC}

===RISK===
Rate how much careful review each changed file needs — this is about where mistakes could hide, not code quality. A JSON object, in exactly this shape:
${RISK_FORMAT}

===TOUR===
A guided tour of the PR for a reviewer who has not seen it before, ordered as a narrative. A JSON object, in exactly this shape:
${tourFormat(number)}

===QUESTIONS===
Questions that make the reviewer think critically before signing off. ONLY the ${QUESTION_COUNT} questions, no JSON, each in exactly this labelled plain-text format with a line containing just --- between questions:
${QUESTIONS_FORMAT}`

      log('starting claude (one run for all four tools — this is the slow part)…')
      const resultText = await runClaude(prompt, { log, signal })
      const sections = splitSections(resultText)
      const createdAt = new Date().toISOString()

      const section = (name: string): string => {
        const s = sections[name]
        if (!s?.trim()) {
          throw createError({ statusCode: 500, message: `claude's response has no ===${name}=== section` })
        }
        return s
      }

      // Each artifact parses, saves, and reports on its own so a bad section
      // costs only that tool.
      const attempt = async (tool: string, fn: () => void | Promise<void>) => {
        try {
          await fn()
        } catch (err: any) {
          push('toolError', { tool, message: String(err.message ?? err).slice(0, 500) })
        }
      }

      let draftRating: ReviewRating | null = null
      await attempt('rating', () => {
        draftRating = cleanRating(extractJson(section('RATING')))
        saveRating({ repo: path, number, rating: draftRating, createdAt, diffHash })
        log('rating parsed')
        push('result', { tool: 'rating', rating: draftRating, createdAt })
      })

      await attempt('risk', () => {
        const risks = cleanRisks(extractJson(section('RISK')), knownPaths)
        saveRiskMap({ repo: path, number, risks, createdAt })
        log(`rated ${risks.length}/${knownPaths.size} file(s)`)
        push('result', { tool: 'risk', risks, createdAt })
      })

      await attempt('tour', () => {
        const tour = cleanTour(extractJson(section('TOUR')))
        saveTour({ repo: path, number, tour, createdAt })
        log(`tour has ${tour.stops.length} stop(s)`)
        push('result', { tool: 'tour', tour, createdAt })
      })

      await attempt('questions', () => {
        const questions = parseQuestions(section('QUESTIONS')).slice(0, QUESTION_COUNT)
        if (!questions.length) {
          throw createError({ statusCode: 500, message: 'claude returned no TOPIC/QUESTION/WHY blocks' })
        }
        saveAskYourself({ repo: path, number, questions, createdAt })
        log(`claude posed ${questions.length} question(s)`)
        push('result', { tool: 'questions', questions, createdAt })
      })

      // Second pass: Opus 4.8 audits the rating against the deterministic
      // diff facts and the rubric, pinning the score to the previous rating
      // when the diff hasn't changed. Runs after the other artifacts so a
      // failure here still leaves the draft rating in place.
      const candidate = draftRating as ReviewRating | null
      if (candidate) {
        await attempt('rating', async () => {
          log('reviewing rating for consistency (opus 4.8)…')
          const facts = [
            `- ${knownPaths.size} changed file(s), +${totalAdd}/−${totalDel} lines total`,
            'Per-category breakdown:',
            breakdown || '- (no files changed)',
          ].join('\n')
          const reviewed = cleanRating(extractJson(await runClaude(
            ratingReviewPrompt({
              title: `#${number}: ${meta.title}`,
              facts,
              candidate,
              previous: previous && previous.diffHash === diffHash ? previous.rating : null,
            }),
            { log, signal, model: 'claude-opus-4-8' },
          )))
          saveRating({ repo: path, number, rating: reviewed, createdAt, diffHash })
          log(reviewed.score === candidate.score
            ? `review confirmed score ${candidate.score}`
            : `review adjusted score ${candidate.score} → ${reviewed.score}`)
          push('result', { tool: 'rating', rating: reviewed, createdAt })
        })
      }
    },
  })

  return aiJobStream(event, job)
})
