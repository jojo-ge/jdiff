import { randomUUID } from 'node:crypto'
import { ASK_QUESTIONS, type SavedAsk } from '../../app/utils/askQuestions'

const MAX_FILE_DIFF_CHARS = 20_000
const CONTEXT_LINES = 25

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const repoPath = resolveRepoDir(String(query.repo ?? ''))
  const number = String(query.number ?? '')
  if (!/^\d+$/.test(number)) throw createError({ statusCode: 400, message: 'bad ?number=' })
  const filePath = String(query.path ?? '')
  if (!filePath) throw createError({ statusCode: 400, message: 'missing ?path=' })
  const line = Number(query.line)
  if (!Number.isInteger(line) || line < 1) throw createError({ statusCode: 400, message: 'bad ?line=' })
  const side = String(query.side ?? '')
  if (!['LEFT', 'RIGHT'].includes(side)) throw createError({ statusCode: 400, message: 'bad ?side=' })
  const question = ASK_QUESTIONS.find((q) => q.id === query.question)
  if (!question) throw createError({ statusCode: 400, message: 'unknown ?question=' })

  const stream = createEventStream(event)
  // If the browser closes the EventSource mid-run, kill the claude process.
  const abort = new AbortController()
  stream.onClosed(() => abort.abort())
  const started = Date.now()
  const push = (kind: string, data: any) => {
    if (abort.signal.aborted) return
    stream.push(JSON.stringify({ kind, t: ((Date.now() - started) / 1000).toFixed(1), ...data }))
  }
  const log = (text: string) => {
    push('log', { text })
    console.log(`[ask #${number} ${filePath}:${line}] ${text}`)
  }

  ;(async () => {
    try {
      log('fetching PR metadata via gh…')
      const meta = JSON.parse(
        await run('gh', ['pr', 'view', number, '--json', 'title,baseRefName'], repoPath),
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
        repoPath,
      )

      const range = `origin/${base}...refs/jdiff/pr-${number}`
      let fileDiff = await run('git', ['diff', '--no-color', '-M', range, '--', filePath], repoPath)
      const diffTruncated = fileDiff.length > MAX_FILE_DIFF_CHARS
      if (diffTruncated) fileDiff = fileDiff.slice(0, MAX_FILE_DIFF_CHARS)

      // The line the reviewer clicked, shown with surrounding context from
      // whichever version of the file it belongs to.
      const ref = side === 'LEFT' ? `origin/${base}` : `refs/jdiff/pr-${number}`
      let snippet = ''
      try {
        const lines = (await run('git', ['show', `${ref}:${filePath}`], repoPath)).split('\n')
        const lo = Math.max(1, line - CONTEXT_LINES)
        const hi = Math.min(lines.length, line + CONTEXT_LINES)
        snippet = lines
          .slice(lo - 1, hi)
          .map((t, i) => `${lo + i === line ? '>' : ' '} ${String(lo + i).padStart(5)} | ${t}`)
          .join('\n')
      } catch {
        log('could not load file snippet (file may be deleted on this side)')
      }

      const prompt = `You are helping a code reviewer understand one specific line of a pull request. You are running inside the repository being reviewed — use your file tools (Read, Grep, Glob) to gather whatever context you need before answering.

PR #${number}: ${meta.title}
File: ${filePath}
Line ${line} — the ${side === 'LEFT' ? 'OLD version (this line is removed/changed by the PR; read it from the base branch, not the working tree)' : 'NEW version (as introduced by the PR)'} of the file.

The line in context (">" marks the line in question):
${snippet || '(snippet unavailable)'}

Diff of this file in the PR${diffTruncated ? ` (truncated to first ${MAX_FILE_DIFF_CHARS.toLocaleString()} characters)` : ''}:
${fileDiff || '(no diff for this file)'}

Reviewer's question about that line: ${question.prompt}

Answer the question directly, grounded in this repository's actual code. Be brief and to the point: lead with the answer, use a few tight sentences or bullets, and stop as soon as the question is answered. No preamble, no headings, no restating the context, no closing summary. Plain markdown.`

      log('starting claude…')
      const answer = await runClaude(prompt, {
        cwd: repoPath,
        signal: abort.signal,
        log,
        onThinking: (text) => push('thinking', { text }),
        onText: (text) => push('answer', { text }),
      })

      const ask: SavedAsk = {
        id: randomUUID(),
        repo: repoPath,
        number,
        path: filePath,
        line,
        side: side as 'LEFT' | 'RIGHT',
        questionId: question.id,
        question: question.label,
        answer,
        createdAt: new Date().toISOString(),
      }
      saveAsk(ask)
      push('result', { ask })
    } catch (err: any) {
      push('error', { message: String(err.message ?? err).slice(0, 500) })
    } finally {
      await stream.close()
    }
  })()

  return stream.send()
})
