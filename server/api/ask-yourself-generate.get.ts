import type { SelfQuestion } from '../../app/utils/askYourself'

const MAX_DIFF_CHARS = 60_000
const QUESTION_COUNT = 3

// The questions are pure prose, so they come back in a labelled plain-text
// format instead of JSON — quotes and newlines in the text can't corrupt
// the parse (JSON escaping was a recurring failure here). Any prose around
// the blocks is ignored; only TOPIC:/QUESTION:/WHY: groups are read.
function parseQuestions(text: string): SelfQuestion[] {
  const questions: SelfQuestion[] = []
  for (const block of text.split(/^TOPIC:/m).slice(1)) {
    const m = /^([\s\S]*?)\nQUESTION:([\s\S]*?)\nWHY:([\s\S]*)/.exec(block)
    if (!m) continue
    const question = m[2]!.trim()
    if (!question) continue
    questions.push({
      topic: m[1]!.trim().slice(0, 60),
      question,
      // Drop the --- separator (and any prose after the last block).
      why: m[3]!.split(/\n\s*---/)[0]!.trim(),
      answer: '',
      postedUrl: null,
    })
  }
  return questions
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
    if (kind === 'log') console.log(`[ask-yourself #${number}] ${data.text}`)
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

      const prompt = `You are helping a reviewer think critically about a pull request before they sign off on it. You are running inside the repository being reviewed, with the PR's head available as the git ref refs/differ/pr-${number} — use your tools (Read, Grep, Glob, Bash with git show/git diff) to understand the change and how it fits the existing codebase.

PR #${number}: ${meta.title}
PR description:
${meta.body || '(none)'}

Diff${truncated ? ` (truncated to first ${MAX_DIFF_CHARS} characters — inspect the rest with git diff ${range} yourself)` : ''}:
${diffSnippet}

Respond with ONLY the ${QUESTION_COUNT} questions, no JSON, no markdown fences, each in exactly this labelled plain-text format with a line containing just --- between questions:

TOPIC: <2-4 word label for what the question is about, e.g. architecture, new pattern, API contract>
QUESTION: <the question, addressed to the reviewer, that they must answer for themselves before approving>
WHY: <1-2 sentences on why this question matters for this particular PR — what is at stake if it is answered carelessly>
---

Guidance for the questions:
- Exactly ${QUESTION_COUNT} questions, and make them the big ones: the architectural direction this change commits the codebase to, new patterns / abstractions / dependencies it introduces, decisions that will be hard to reverse later, changed boundaries or contracts between parts of the system.
- Do NOT ask nitty-gritty code-level questions (naming, style, off-by-one, missing null check) — those belong as inline comments on the diff, not here.
- Each question must be specific to this PR: name the actual files, modules, or concepts involved. No generic checklist filler like "is this well tested?".
- Ask genuinely open questions a thoughtful reviewer could answer either way — the point is to make them form and defend a judgement, not to hint at a correct answer.`

      log('starting claude (this is the slow part)…')
      const resultText = await runClaude(prompt, { log, signal: abort.signal })

      const questions = parseQuestions(resultText).slice(0, QUESTION_COUNT)
      if (!questions.length) {
        throw createError({
          statusCode: 500,
          message: 'claude returned no TOPIC/QUESTION/WHY blocks: ' + resultText.slice(0, 200),
        })
      }
      log(`claude posed ${questions.length} question(s)`)

      const createdAt = new Date().toISOString()
      saveAskYourself({ repo: path, number, questions, createdAt })
      push('result', { questions, createdAt })
    } catch (err: any) {
      push('error', { message: String(err.message ?? err).slice(0, 500) })
    } finally {
      await stream.close()
    }
  })()

  return stream.send()
})
