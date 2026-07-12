export default defineEventHandler(async (event) => {
  const path = resolveRepoPath(event)
  const out = await run(
    'gh',
    [
      'pr', 'list', '--limit', '100', '--json',
      'number,title,author,headRefName,baseRefName,isDraft,updatedAt,additions,deletions,reviewDecision,url',
    ],
    path,
  )
  const prs = JSON.parse(out)
  return prs.map((pr: any) => ({
    ...pr,
    ratingScore: loadRating(path, String(pr.number))?.rating.score ?? null,
  }))
})
