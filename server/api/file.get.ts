export default defineEventHandler(async (event) => {
  const repoDir = resolveRepoPath(event)
  const q = getQuery(event)
  const number = String(q.number ?? '')
  const filePath = String(q.path ?? '')
  if (!/^\d+$/.test(number)) throw createError({ statusCode: 400, message: 'bad ?number=' })
  if (!filePath) throw createError({ statusCode: 400, message: 'missing ?path=' })

  const ref = `refs/differ/pr-${number}`
  let content: string
  try {
    content = await run('git', ['show', `${ref}:${filePath}`], repoDir)
  } catch {
    // Ref may not exist yet (full view hit before the diff endpoint ran).
    await run('git', ['fetch', '--quiet', 'origin', `+refs/pull/${number}/head:${ref}`], repoDir)
    content = await run('git', ['show', `${ref}:${filePath}`], repoDir)
  }

  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return { lines: await highlightLines(lines, filePath) }
})
