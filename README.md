# differ

A local GitHub client that's really good at diffs. GitHub is only used to know
which PRs are open — everything else happens with your local tooling:

- **`gh`** lists open PRs and PR metadata (you must be logged in: `gh auth status`)
- **`git`** fetches `refs/pull/N/head` into your local clone and computes the
  diff against the merge-base — no GitHub diff API involved

## Usage

```sh
pnpm install
pnpm dev
```

Open the app, paste the path to a local clone (e.g. `~/code/my-repo`), and
you get the list of open PRs. Click one for a side-by-side, syntax-highlighted
diff. Recent repos are remembered.

## How it works

- `server/api/prs.get.ts` — `gh pr list` in the repo's directory
- `server/api/diff.get.ts` — `git fetch origin +refs/pull/N/head:refs/differ/pr-N`
  then `git diff origin/<base>...refs/differ/pr-N`, parsed with `parse-diff` and
  highlighted server-side with `shiki`
