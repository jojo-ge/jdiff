<script setup lang="ts">
const route = useRoute()
const repo = computed(() => String(route.query.repo ?? ''))

const { data: info } = useFetch<{ slug: string, viewer?: string }>('/api/repo', { query: { repo } })
const { data: prs, pending, error, refresh } = useFetch<any[]>('/api/prs', { query: { repo } })

const hideDrafts = ref(false)
const onlyMine = ref(false)

// Kick off the combined claude run (rating, risk map, tour, ask yourself)
// straight from the list; the job runs server-side, so the row just badges
// as busy and the artifacts are waiting when the PR is opened.
const { isRunning, startAll } = useAiTasksHub(repo)

const filtered = computed(() => (prs.value ?? []).filter(pr =>
  (!hideDrafts.value || !pr.isDraft)
  && (!onlyMine.value || pr.author?.login === info.value?.viewer),
))
</script>

<template>
  <main class="prs">
    <header class="bar">
      <NuxtLink to="/" class="brand">jDiff</NuxtLink>
      <span class="slug">{{ info?.slug ?? repo }}</span>
      <button class="refresh" :disabled="pending" @click="refresh()">↻</button>
      <NotificationBell :repo="repo" />
    </header>

    <div class="filters">
      <label class="filter">
        <input v-model="hideDrafts" type="checkbox">
        hide drafts
      </label>
      <label class="filter">
        <input v-model="onlyMine" type="checkbox">
        only mine
      </label>
    </div>

    <div v-if="pending" class="center"><span class="spinner" /></div>
    <div v-else-if="error" class="error-box">{{ error.data?.message ?? error.message }}</div>
    <div v-else-if="!prs?.length" class="center muted">no open pull requests</div>
    <div v-else-if="!filtered.length" class="center muted">no pull requests match the filters</div>

    <ul v-else class="list">
      <li v-for="pr in filtered" :key="pr.number">
        <NuxtLink :to="{ path: `/pr/${pr.number}`, query: { repo } }" class="pr">
          <div class="top">
            <span class="number">#{{ pr.number }}</span>
            <span class="title">{{ pr.title }}</span>
            <span v-if="pr.isDraft" class="badge draft">draft</span>
            <span v-else-if="pr.reviewDecision === 'APPROVED'" class="badge approved">approved</span>
            <span v-else-if="pr.reviewDecision === 'CHANGES_REQUESTED'" class="badge changes">changes</span>
            <span
              v-if="pr.ratingScore != null"
              class="badge score"
              :class="pr.ratingScore >= 7 ? 'good' : pr.ratingScore >= 4 ? 'mid' : 'bad'"
            >✦ {{ pr.ratingScore }}/10</span>
            <span class="row-tools">
              <span v-if="isRunning(pr.number)" class="badge running">
                <span class="spinner tiny" /> analyzing
              </span>
              <button
                v-else
                class="analyze-btn"
                title="run all review tools on this PR in the background"
                @click.prevent.stop="startAll(pr.number)"
              >✦ analyze</button>
            </span>
          </div>
          <div class="meta">
            <span>{{ pr.author?.login }}</span>
            <span class="branch">{{ pr.headRefName }} → {{ pr.baseRefName }}</span>
            <span>{{ timeAgo(pr.updatedAt) }}</span>
            <span class="stats">
              <span class="add">+{{ pr.additions }}</span>
              <span class="del">−{{ pr.deletions }}</span>
            </span>
          </div>
        </NuxtLink>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.prs {
  max-width: 860px;
  margin: 0 auto;
  padding: 24px;
}
.bar {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 20px;
}
.brand {
  font-family: var(--mono);
  font-weight: 700;
  color: var(--text);
}
.slug {
  font-weight: 600;
  color: var(--muted);
}
.refresh {
  margin-left: auto;
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
}
.refresh:hover { border-color: var(--accent); }
.filters {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
}
.filter {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.filter input {
  accent-color: var(--accent);
  cursor: pointer;
}
.center {
  display: flex;
  justify-content: center;
  padding: 60px 0;
}
.muted { color: var(--muted); }
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.list li + li { border-top: 1px solid var(--border); }
.pr {
  display: block;
  padding: 12px 16px;
  color: var(--text);
  background: var(--panel);
}
.pr:hover {
  background: var(--panel-2);
  text-decoration: none;
}
.top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.number {
  font-family: var(--mono);
  color: var(--muted);
}
.title { font-weight: 600; }
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
}
.badge.draft { color: var(--muted); }
.badge.approved { color: var(--green); border-color: var(--green); }
.badge.changes { color: var(--red); border-color: var(--red); }
.badge.score { font-family: var(--mono); }
.row-tools {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
}
.badge.running {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  color: var(--accent);
  border-color: var(--accent);
}
.analyze-btn {
  font-family: var(--mono);
  font-size: 11px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  border-radius: 6px;
  padding: 2px 10px;
  cursor: pointer;
}
.analyze-btn:hover { color: var(--text); border-color: var(--accent); }
.spinner.tiny { width: 8px; height: 8px; border-width: 2px; }
.badge.score.good { color: var(--green); border-color: var(--green); }
.badge.score.mid { color: var(--accent); border-color: var(--accent); }
.badge.score.bad { color: var(--red); border-color: var(--red); }
.meta {
  display: flex;
  flex-wrap: wrap;
  column-gap: 14px;
  row-gap: 4px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
}
.meta > * { white-space: nowrap; }
.branch {
  font-family: var(--mono);
  max-width: 34ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stats { font-family: var(--mono); }
.add { color: var(--green); }
.del { color: var(--red); margin-left: 6px; }
</style>
