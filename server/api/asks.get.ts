export default defineEventHandler((event) => {
  const query = getQuery(event)
  const repoPath = resolveRepoDir(String(query.repo ?? ''))
  const number = String(query.number ?? '')
  if (!/^\d+$/.test(number)) throw createError({ statusCode: 400, message: 'bad ?number=' })
  return loadAsks(repoPath, number)
})
