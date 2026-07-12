<script setup lang="ts">
import type { SavedAsk } from '~/utils/askQuestions'
import type { SelfQuestion } from '~/utils/askYourself'
import type { FileRisk } from '~/utils/risk'
import type { Tour } from '~/utils/tour'

export interface ReviewComment {
  id: number
  inReplyTo: number | null
  path: string
  line: number | null
  side: 'LEFT' | 'RIGHT'
  body: string
  user: string
  createdAt: string
  outdated: boolean
}
export interface Thread {
  rootId: number
  key: string
  comments: ReviewComment[]
}

const route = useRoute()
const repo = computed(() => String(route.query.repo ?? ''))
const number = computed(() => String(route.params.number))

const { data: pr, refresh: refreshPr } = useFetch<any>('/api/pr', {
  query: { repo, number },
})
const { data: diff, pending, error } = useFetch<{ files: any[] }>('/api/diff', {
  query: { repo, number },
})
const { data: comments, refresh: refreshComments } = useFetch<ReviewComment[]>('/api/comments', {
  query: { repo, number },
})
const { data: savedAsks, refresh: refreshAsks } = useFetch<SavedAsk[]>('/api/asks', {
  query: { repo, number },
})

// Locally saved claude asks, grouped like threads: file path → "SIDE:line".
const asksByFile = computed(() => {
  const byFile: Record<string, Record<string, SavedAsk[]>> = {}
  for (const a of savedAsks.value ?? []) {
    const fileMap = (byFile[a.path] ??= {})
    ;(fileMap[`${a.side}:${a.line}`] ??= []).push(a)
  }
  return byFile
})

const showComments = ref(true)

// Claude artifacts (rating, risk map, tour) and the file graph are snapshots
// of the diff at generation time; a push after that makes them out of date.
// The PR metadata refreshes on window focus so the badges can appear while
// the page stays open.
const lastPushedMs = computed(() =>
  pr.value?.lastPushedAt ? new Date(pr.value.lastPushedAt).getTime() : 0,
)
function isStale(at: string): boolean {
  return !!at && lastPushedMs.value > new Date(at).getTime()
}
const onFocus = () => refreshPr()
onMounted(() => window.addEventListener('focus', onFocus))
onBeforeUnmount(() => window.removeEventListener('focus', onFocus))

// File map: force layout of the changed files, linked by imports /
// references and grouped into clusters. Opens as a fullscreen overlay;
// fetches on first open.
const showGraph = ref(false)
watch(showGraph, (v) => {
  document.body.style.overflow = v ? 'hidden' : ''
})
function onGraphKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && showGraph.value) showGraph.value = false
}
onMounted(() => window.addEventListener('keydown', onGraphKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGraphKey)
  document.body.style.overflow = ''
})

// Jumping to a file's diff from the map: close the overlay first so the
// anchor scroll lands on the visible page.
function onGraphFileClick(e: MouseEvent, path: string) {
  showGraph.value = false
  onFileLinkClick(e, path)
}

const summaryRaw = ref(false)
// The PR description opens collapsed: the verdict line and checklist carry
// the orientation load; the full body is one click away.
const summaryOpen = ref(false)
const summaryHtml = computed(() =>
  pr.value?.body ? renderMarkdown(pr.value.body) : '',
)

const commentCount = computed(() => (comments.value ?? []).filter((c) => !c.outdated).length)
const outdatedCount = computed(() => (comments.value ?? []).filter((c) => c.outdated).length)

// Group inline comments into threads keyed by file path + "SIDE:line".
const threadsByFile = computed(() => {
  const roots = new Map<number, Thread>()
  const byFile: Record<string, Record<string, Thread[]>> = {}
  for (const c of comments.value ?? []) {
    if (c.inReplyTo || c.outdated || c.line == null) continue
    const key = `${c.side}:${c.line}`
    const thread: Thread = { rootId: c.id, key, comments: [c] }
    roots.set(c.id, thread)
    const fileMap = (byFile[c.path] ??= {})
    ;(fileMap[key] ??= []).push(thread)
  }
  for (const c of comments.value ?? []) {
    if (c.inReplyTo) roots.get(c.inReplyTo)?.comments.push(c)
  }
  return byFile
})

function anchorFor(path: string): string {
  return 'f-' + path.replace(/[^a-zA-Z0-9]/g, '-')
}

// Closed files are removed from the diff view and shown greyed out in the
// sidebar; clicking a greyed entry restores the file and scrolls to it.
const closedFiles = ref<string[]>([])
const visibleFiles = computed(() =>
  (diff.value?.files ?? []).filter((f) => !closedFiles.value.includes(f.path)),
)

function closeFile(path: string) {
  if (!closedFiles.value.includes(path)) closedFiles.value.push(path)
}

// Reviewability rating: runs the local `claude` CLI on the server against
// the PR diff + category breakdown. Slow (an LLM call), so on-demand only.
interface ReviewRating {
  score: number
  effort: string
  summary: string
  factors: { label: string; impact: 'good' | 'neutral' | 'bad'; detail: string }[]
  readingOrder: { path: string; note: string }[]
}
const rating = ref<ReviewRating | null>(null)
const ratedAt = ref('')
// Open when the rating was just requested; ratings restored from the local
// store start collapsed to just the score line.
const ratingOpen = ref(false)

// Ratings persist in ~/.differ/ratings.json; show the last one on load.
const { data: savedRating } = useFetch<{ rating: ReviewRating; createdAt: string } | null>('/api/rating', {
  query: { repo, number },
})
watch(savedRating, (v) => {
  if (v && !rating.value) {
    rating.value = v.rating
    ratedAt.value = v.createdAt
  }
}, { immediate: true })
const ratingStale = computed(() => isStale(ratedAt.value))
// Reading-order entries only link into the diff when the path matches a real
// file — claude occasionally abbreviates paths.
const diffPaths = computed(() => new Set((diff.value?.files ?? []).map((f) => f.path)))
const ratingPending = ref(false)
const ratingError = ref('')
const ratingLog = ref<{ t: string; text: string }[]>([])
const showLog = ref(false)
const logEl = ref<HTMLElement | null>(null)

watch(
  () => ratingLog.value.length,
  () => nextTick(() => logEl.value?.scrollTo({ top: logEl.value.scrollHeight })),
)

// Closing the EventSource mid-run tells the server to kill the claude
// process, so cancel/navigation actually stops the work.
let ratingEs: EventSource | null = null

function cancelRating() {
  ratingEs?.close()
  ratingEs = null
  ratingPending.value = false
  showLog.value = false
}

function rateReviewability() {
  if (ratingPending.value) return
  ratingPending.value = true
  ratingError.value = ''
  ratingLog.value = []
  showLog.value = true

  const params = new URLSearchParams({ repo: repo.value, number: number.value })
  const es = new EventSource(`/api/review-rating?${params}`)
  ratingEs = es
  const finish = () => {
    es.close()
    ratingEs = null
    ratingPending.value = false
  }
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.kind === 'log') {
      ratingLog.value.push({ t: msg.t, text: msg.text })
    } else if (msg.kind === 'result') {
      rating.value = msg.rating
      ratedAt.value = msg.createdAt ?? new Date().toISOString()
      ratingOpen.value = true
      showLog.value = false
      finish()
    } else if (msg.kind === 'error') {
      ratingError.value = msg.message
      finish()
    }
  }
  // Fires both on transport failure and on normal server close; only treat
  // it as an error if no result or error event arrived first.
  es.onerror = () => {
    if (ratingPending.value && !rating.value && !ratingError.value) {
      ratingError.value = 'connection to rating stream lost'
    }
    finish()
  }
}

// Risk heatmap: one claude pass over the whole diff rates each file
// low/medium/high; the file nav colors a dot per file. Persisted in
// ~/.differ/risks.json, so the last map shows on load.
const risks = ref<FileRisk[] | null>(null)
const riskAt = ref('')
// Open when the map was just requested; maps restored from the local store
// start collapsed to just the count line.
const riskOpen = ref(false)
const { data: savedRisks } = useFetch<{ risks: FileRisk[]; createdAt: string } | null>('/api/risk', {
  query: { repo, number },
})
watch(savedRisks, (v) => {
  if (v && !risks.value) {
    risks.value = v.risks
    riskAt.value = v.createdAt
  }
}, { immediate: true })
const riskStale = computed(() => isStale(riskAt.value))
const riskByPath = computed<Record<string, FileRisk>>(() =>
  Object.fromEntries((risks.value ?? []).map((r) => [r.path, r])),
)
const RISK_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }
const sortedRisks = computed(() =>
  [...(risks.value ?? [])].sort((a, b) => RISK_ORDER[a.level]! - RISK_ORDER[b.level]!),
)
const riskCounts = computed(() => {
  const c = { high: 0, medium: 0, low: 0 }
  for (const r of risks.value ?? []) c[r.level]++
  return c
})
// The low bucket is usually long and skimmable; keep it folded unless it is
// all there is.
const showLowRisk = ref(false)
const visibleRisks = computed(() => {
  const all = sortedRisks.value
  if (showLowRisk.value || riskCounts.value.high + riskCounts.value.medium === 0) return all
  return all.filter((r) => r.level !== 'low')
})
const riskPending = ref(false)
const riskError = ref('')
const riskLog = ref<{ t: string; text: string }[]>([])
const showRiskLog = ref(false)
const riskLogEl = ref<HTMLElement | null>(null)

watch(
  () => riskLog.value.length,
  () => nextTick(() => riskLogEl.value?.scrollTo({ top: riskLogEl.value.scrollHeight })),
)

let riskEs: EventSource | null = null

function cancelRisk() {
  riskEs?.close()
  riskEs = null
  riskPending.value = false
  showRiskLog.value = false
}

function mapRisk() {
  if (riskPending.value) return
  riskPending.value = true
  riskError.value = ''
  riskLog.value = []
  showRiskLog.value = true

  const params = new URLSearchParams({ repo: repo.value, number: number.value })
  const es = new EventSource(`/api/risk-heatmap?${params}`)
  riskEs = es
  const finish = () => {
    es.close()
    riskEs = null
    riskPending.value = false
  }
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.kind === 'log') {
      riskLog.value.push({ t: msg.t, text: msg.text })
    } else if (msg.kind === 'result') {
      risks.value = msg.risks
      riskAt.value = msg.createdAt ?? new Date().toISOString()
      riskOpen.value = true
      showRiskLog.value = false
      finish()
    } else if (msg.kind === 'error') {
      riskError.value = msg.message
      finish()
    }
  }
  es.onerror = () => {
    if (riskPending.value && !riskError.value) {
      riskError.value = 'connection to risk stream lost'
    }
    finish()
  }
}

// Guided tour: claude writes an overview of the change plus ordered stops
// (file + line range + note). Walking the tour scrolls the diff to each
// stop and highlights it in place, so commenting, asks, and context
// expansion all keep working mid-tour. Persisted in ~/.differ/tours.json.
const tour = ref<Tour | null>(null)
const tourAt = ref('')
const tourOpen = ref(false)
const { data: savedTour } = useFetch<{ tour: Tour; createdAt: string } | null>('/api/tour', {
  query: { repo, number },
})
watch(savedTour, (v) => {
  if (v && !tour.value) {
    tour.value = v.tour
    tourAt.value = v.createdAt
    if (import.meta.client) loadTourProgress()
  }
}, { immediate: true })
const tourStale = computed(() => isStale(tourAt.value))
const tourPending = ref(false)
const tourError = ref('')
const tourLog = ref<{ t: string; text: string }[]>([])
const showTourLog = ref(false)
const tourLogEl = ref<HTMLElement | null>(null)

watch(
  () => tourLog.value.length,
  () => nextTick(() => tourLogEl.value?.scrollTo({ top: tourLogEl.value.scrollHeight })),
)

let tourEs: EventSource | null = null

function cancelTour() {
  tourEs?.close()
  tourEs = null
  tourPending.value = false
  showTourLog.value = false
}

function generateTour() {
  if (tourPending.value) return
  tourPending.value = true
  tourError.value = ''
  tourLog.value = []
  showTourLog.value = true

  const params = new URLSearchParams({ repo: repo.value, number: number.value })
  const es = new EventSource(`/api/tour-generate?${params}`)
  tourEs = es
  const finish = () => {
    es.close()
    tourEs = null
    tourPending.value = false
  }
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.kind === 'log') {
      tourLog.value.push({ t: msg.t, text: msg.text })
    } else if (msg.kind === 'result') {
      tour.value = msg.tour
      tourAt.value = msg.createdAt ?? new Date().toISOString()
      tourIndex.value = null
      clearTourProgress()
      tourOpen.value = true
      showTourLog.value = false
      finish()
    } else if (msg.kind === 'error') {
      tourError.value = msg.message
      finish()
    }
  }
  es.onerror = () => {
    if (tourPending.value && !tourError.value) {
      tourError.value = 'connection to tour stream lost'
    }
    finish()
  }
}

// Ask yourself: claude poses three big-picture questions — architecture,
// new patterns, hard-to-reverse decisions — that the reviewer answers in
// their own words. Answers save as drafts and can be posted back to the PR
// as regular conversation comments. Persisted in ~/.differ/ask-yourself.json.
const selfQs = ref<SelfQuestion[] | null>(null)
const selfAt = ref('')
const selfOpen = ref(false)
const { data: savedSelf } = useFetch<{ questions: SelfQuestion[]; createdAt: string } | null>('/api/ask-yourself', {
  query: { repo, number },
})
watch(savedSelf, (v) => {
  if (v && !selfQs.value) {
    selfQs.value = v.questions
    selfAt.value = v.createdAt
  }
}, { immediate: true })
const selfStale = computed(() => isStale(selfAt.value))
const answeredCount = computed(() => (selfQs.value ?? []).filter((q) => q.answer.trim()).length)
const selfPending = ref(false)
const selfError = ref('')
const selfLog = ref<{ t: string; text: string }[]>([])
const showSelfLog = ref(false)
const selfLogEl = ref<HTMLElement | null>(null)

watch(
  () => selfLog.value.length,
  () => nextTick(() => selfLogEl.value?.scrollTo({ top: selfLogEl.value.scrollHeight })),
)

let selfEs: EventSource | null = null

function cancelSelf() {
  selfEs?.close()
  selfEs = null
  selfPending.value = false
  showSelfLog.value = false
}

function generateSelf() {
  if (selfPending.value) return
  selfPending.value = true
  selfError.value = ''
  selfLog.value = []
  showSelfLog.value = true

  const params = new URLSearchParams({ repo: repo.value, number: number.value })
  const es = new EventSource(`/api/ask-yourself-generate?${params}`)
  selfEs = es
  const finish = () => {
    es.close()
    selfEs = null
    selfPending.value = false
  }
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.kind === 'log') {
      selfLog.value.push({ t: msg.t, text: msg.text })
    } else if (msg.kind === 'result') {
      selfQs.value = msg.questions
      selfAt.value = msg.createdAt ?? new Date().toISOString()
      selfOpen.value = true
      showSelfLog.value = false
      finish()
    } else if (msg.kind === 'error') {
      selfError.value = msg.message
      finish()
    }
  }
  es.onerror = () => {
    if (selfPending.value && !selfError.value) {
      selfError.value = 'connection to question stream lost'
    }
    finish()
  }
}

function saveAnswer(i: number) {
  const q = selfQs.value?.[i]
  if (!q) return
  $fetch('/api/ask-yourself-answer', {
    method: 'POST',
    body: { repo: repo.value, number: number.value, index: i, answer: q.answer },
  }).catch(() => { /* draft save is best-effort; posting persists too */ })
}

const postingIdx = ref<number | null>(null)

async function postAnswer(i: number) {
  const q = selfQs.value?.[i]
  if (!q || !q.answer.trim() || postingIdx.value != null) return
  postingIdx.value = i
  selfError.value = ''
  try {
    const res = await $fetch<{ url: string }>('/api/ask-yourself-post', {
      method: 'POST',
      body: { repo: repo.value, number: number.value, index: i, answer: q.answer },
    })
    q.postedUrl = res.url
  } catch (e: any) {
    selfError.value = e.data?.message ?? e.message ?? 'failed to post comment'
  } finally {
    postingIdx.value = null
  }
}

// null = not touring; otherwise the index of the active stop.
const tourIndex = ref<number | null>(null)
const currentStop = computed(() =>
  tourIndex.value == null ? null : tour.value?.stops[tourIndex.value] ?? null,
)

// The tour itself lives in ~/.differ/tours.json; walk progress is browser
// state, kept in localStorage keyed by repo + PR and stamped with the
// tour's createdAt so a rewritten tour invalidates stale positions. A
// reload (or coming back days later) resumes at the last visited stop.
const progressKey = computed(() => `differ:tour-pos:${repo.value}:${number.value}`)
const resumeIndex = ref<number | null>(null)

function loadTourProgress() {
  try {
    const raw = localStorage.getItem(progressKey.value)
    if (!raw) return
    const saved = JSON.parse(raw)
    if (
      saved.tourAt === tourAt.value &&
      Number.isInteger(saved.index) &&
      saved.index >= 0 &&
      saved.index < (tour.value?.stops.length ?? 0)
    ) {
      resumeIndex.value = saved.index
    }
  } catch { /* corrupt or unavailable storage: start fresh */ }
}

function clearTourProgress() {
  resumeIndex.value = null
  try {
    localStorage.removeItem(progressKey.value)
  } catch { /* ignore */ }
}

watch(tourIndex, (i) => {
  if (i == null) return
  resumeIndex.value = i
  try {
    localStorage.setItem(progressKey.value, JSON.stringify({ tourAt: tourAt.value, index: i }))
  } catch { /* ignore */ }
})

async function focusStop() {
  const s = currentStop.value
  if (!s) return
  if (closedFiles.value.includes(s.path)) {
    closedFiles.value = closedFiles.value.filter((p) => p !== s.path)
  }
  await nextTick()
  const el =
    document.getElementById(anchorFor(s.path) + '-tour') ??
    document.getElementById(anchorFor(s.path))
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function jumpToStop(i: number) {
  tourIndex.value = i
  focusStop()
}

function nextStop() {
  if (tourIndex.value == null || !tour.value) return
  if (tourIndex.value >= tour.value.stops.length - 1) {
    endTour(true)
    return
  }
  tourIndex.value++
  focusStop()
}

function prevStop() {
  if (tourIndex.value == null || tourIndex.value === 0) return
  tourIndex.value--
  focusStop()
}

function endTour() {
  tourIndex.value = null
}

function onTourKey(e: KeyboardEvent) {
  if (tourIndex.value == null) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return
  if (e.key === 'ArrowRight' || e.key === 'n') {
    e.preventDefault()
    nextStop()
  } else if (e.key === 'ArrowLeft' || e.key === 'p') {
    e.preventDefault()
    prevStop()
  } else if (e.key === 'Escape') {
    endTour()
  }
}
onMounted(() => window.addEventListener('keydown', onTourKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onTourKey))
// Leaving the page cancels any in-flight claude runs.
onBeforeUnmount(() => {
  ratingEs?.close()
  riskEs?.close()
  tourEs?.close()
  selfEs?.close()
})

// One click to kick off every claude tool; each run function no-ops if its
// stream is already in flight, so this is safe to press mid-run.
const anyPending = computed(() => ratingPending.value || riskPending.value || tourPending.value || selfPending.value)

function runAllTools() {
  rateReviewability()
  mapRisk()
  generateTour()
  generateSelf()
}

function cancelAllTools() {
  if (ratingPending.value) cancelRating()
  if (riskPending.value) cancelRisk()
  if (tourPending.value) cancelTour()
  if (selfPending.value) cancelSelf()
}

// Leaving the page kills every in-flight claude run (closing an EventSource
// aborts its process server-side), so warn first: the browser's own dialog
// for refresh/close, a confirm() for in-app navigation.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!anyPending.value) return
  e.preventDefault()
  // Legacy requirement — some browsers only show the dialog when returnValue is set.
  e.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

onBeforeRouteLeave(() => {
  if (!anyPending.value) return true
  return window.confirm('a claude run is still in progress — leaving this page will cancel it. leave anyway?')
})

function onFileLinkClick(e: MouseEvent, path: string) {
  if (!closedFiles.value.includes(path)) return
  e.preventDefault()
  closedFiles.value = closedFiles.value.filter((p) => p !== path)
  nextTick(() => document.getElementById(anchorFor(path))?.scrollIntoView({ block: 'start' }))
}

// Review checklist: the sidebar's default view once guidance artifacts
// exist. Done-flags are browser state (localStorage keyed by repo + PR),
// stamped with each artifact's createdAt so a regenerated tour or risk map
// resets its own section without touching the other.
const hasChecklist = computed(() => !!(tour.value || risks.value || selfQs.value))
const stopsDone = ref<boolean[]>([])
const risksDone = ref<boolean[]>([])
const checklistKey = computed(() => `differ:checklist:${repo.value}:${number.value}`)

function restoreChecklist() {
  try {
    const raw = localStorage.getItem(checklistKey.value)
    if (!raw) return
    const s = JSON.parse(raw)
    if (s.tourAt === tourAt.value && Array.isArray(s.stops) && s.stops.length === stopsDone.value.length) {
      stopsDone.value = s.stops.map(Boolean)
    }
    if (s.riskAt === riskAt.value && Array.isArray(s.risks) && s.risks.length === risksDone.value.length) {
      risksDone.value = s.risks.map(Boolean)
    }
  } catch { /* corrupt or unavailable storage: start unchecked */ }
}

watch([tour, tourAt], () => {
  stopsDone.value = Array(tour.value?.stops.length ?? 0).fill(false)
  restoreChecklist()
}, { immediate: true })
watch([risks, riskAt], () => {
  risksDone.value = Array(sortedRisks.value.length).fill(false)
  restoreChecklist()
}, { immediate: true })
watch([stopsDone, risksDone], () => {
  try {
    localStorage.setItem(checklistKey.value, JSON.stringify({
      tourAt: tourAt.value,
      riskAt: riskAt.value,
      stops: stopsDone.value,
      risks: risksDone.value,
    }))
  } catch { /* ignore */ }
}, { deep: true })

const checklistTotal = computed(
  () => stopsDone.value.length + risksDone.value.length + (selfQs.value?.length ? 1 : 0),
)
const checklistDone = computed(
  () =>
    stopsDone.value.filter(Boolean).length +
    risksDone.value.filter(Boolean).length +
    (selfQs.value?.length && answeredCount.value === selfQs.value.length ? 1 : 0),
)
const checklistPct = computed(() =>
  checklistTotal.value ? Math.round((checklistDone.value / checklistTotal.value) * 100) : 0,
)

function nextUnreviewed() {
  const i = stopsDone.value.findIndex((d) => !d)
  jumpToStop(i === -1 ? 0 : i)
}

function openSelfCard() {
  selfOpen.value = true
  nextTick(() =>
    document.getElementById('self-card')?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
  )
}
</script>

<template>
  <main class="pr-page">
    <header class="bar">
      <NuxtLink to="/" class="brand">differ</NuxtLink>
      <NuxtLink :to="{ path: '/prs', query: { repo } }" class="back">← PRs</NuxtLink>
      <button
        class="toggle"
        :class="{ on: showComments }"
        @click="showComments = !showComments"
      >
        💬 {{ commentCount }} · {{ showComments ? 'on' : 'off' }}
      </button>
      <NotificationBell :repo="repo" />
    </header>

    <div v-if="pr" class="pr-head">
      <h1>
        <span class="number">#{{ pr.number }}</span>
        {{ pr.title }}
        <span v-if="pr.isDraft" class="badge">draft</span>
      </h1>
      <div class="meta">
        <span>{{ pr.author?.login }}</span>
        <span class="branch">{{ pr.headRefName }} → {{ pr.baseRefName }}</span>
        <span>{{ pr.commitCount }} commit{{ pr.commitCount === 1 ? '' : 's' }}<template v-if="pr.lastPushedAt"> · pushed {{ timeAgo(pr.lastPushedAt) }}</template></span>
        <span class="stats">
          <span class="add">+{{ pr.additions }}</span>
          <span class="del">−{{ pr.deletions }}</span>
        </span>
        <span v-if="showComments && outdatedCount" class="outdated-note">
          {{ outdatedCount }} outdated comment{{ outdatedCount === 1 ? '' : 's' }} hidden
        </span>
        <a :href="pr.url" target="_blank" rel="noopener">github ↗</a>
      </div>
      <p v-if="rating" class="verdict">
        <span class="rating-score" :class="rating.score >= 7 ? 'good' : rating.score >= 4 ? 'mid' : 'bad'">
          {{ rating.score }}/10
        </span>
        {{ rating.summary }}
      </p>

      <div class="tour-cta">
        <template v-if="tour && !tourPending">
          <button class="tour-go" @click="jumpToStop(resumeIndex ?? 0)">
            {{ resumeIndex ? `▶ resume tour ${resumeIndex + 1}/${tour.stops.length}` : '▶ start code tour' }}
          </button>
          <button
            v-if="resumeIndex"
            class="log-toggle"
            title="forget saved progress and start from stop 1"
            @click="clearTourProgress(); jumpToStop(0)"
          >restart</button>
          <span class="tour-hint">← → to move · esc ends</span>
        </template>
        <button
          v-else
          class="rate-btn"
          :title="tourPending ? 'stop this run' : 'claude writes an overview of the change and a guided walkthrough of the diff'"
          @click="tourPending ? cancelTour() : generateTour()"
        >
          <span v-if="tourPending" class="spinner small" />
          {{ tourPending ? 'cancel tour run' : '✦ write code tour' }}
        </button>
        <button
          class="rate-btn run-all"
          :title="anyPending ? 'stop every in-flight run' : 'run reviewability, risk heatmap, guided tour, and ask yourself in one go'"
          @click="anyPending ? cancelAllTools() : runAllTools()"
        >
          <span v-if="anyPending" class="spinner small" />
          {{ anyPending ? 'cancel all' : '✦ run all tools' }}
        </button>
      </div>

      <div v-if="pr.body" class="desc">
        <button class="disclose" @click="summaryOpen = !summaryOpen">
          <span class="d-chev">{{ summaryOpen ? '▾' : '▸' }}</span> description
        </button>
        <div v-if="summaryOpen" class="summary">
          <button class="raw-toggle" @click="summaryRaw = !summaryRaw">
            {{ summaryRaw ? 'markdown' : 'raw' }}
          </button>
          <pre v-if="summaryRaw" class="summary-raw">{{ pr.body }}</pre>
          <div v-else class="summary-md" v-html="summaryHtml" />
        </div>
      </div>
      <div class="rating-card">
        <div
          class="rating-head"
          :class="{ clickable: rating && !ratingPending }"
          @click="rating && !ratingPending && (ratingOpen = !ratingOpen)"
        >
          <span v-if="rating && !ratingPending" class="rating-chevron">{{ ratingOpen ? '▾' : '▸' }}</span>
          <template v-if="rating">
            <span class="rating-score" :class="rating.score >= 7 ? 'good' : rating.score >= 4 ? 'mid' : 'bad'">
              {{ rating.score }}/10
            </span>
            <span class="rating-effort">{{ rating.effort }} review</span>
            <span v-if="ratedAt" class="rating-effort">rated {{ timeAgo(ratedAt) }}</span>
            <span v-if="ratingStale" class="stale-badge" title="the PR was pushed after this rating was generated — rate again to refresh">out of date</span>
          </template>
          <span v-else class="card-title">✦ reviewability</span>
          <span class="head-actions">
            <button
              v-if="ratingOpen && ratingLog.length && !ratingPending"
              class="log-toggle"
              @click.stop="showLog = !showLog"
            >
              {{ showLog ? 'hide log' : 'show log' }}
            </button>
            <button
              class="rate-btn"
              :title="ratingPending ? 'stop this run' : undefined"
              @click.stop="ratingPending ? cancelRating() : rateReviewability()"
            >
              <span v-if="ratingPending" class="spinner small" />
              {{ ratingPending ? 'cancel' : rating ? 'rate again' : 'rate' }}
            </button>
          </span>
        </div>
        <div v-if="showLog && ratingLog.length" ref="logEl" class="rating-log">
          <div v-for="(l, i) in ratingLog" :key="i" class="log-line">
            <span class="log-t">{{ l.t }}s</span>{{ l.text }}
          </div>
        </div>
        <div v-if="ratingError" class="error-box in-card">{{ ratingError }}</div>
        <template v-if="rating && !ratingPending && ratingOpen">
          <ul class="rating-factors">
            <li v-for="f in rating.factors" :key="f.label">
              <span class="factor-dot" :class="f.impact" />
              <div class="risk-item">
                <strong>{{ f.label }}</strong>
                <div class="item-note">{{ f.detail }}</div>
              </div>
            </li>
          </ul>
          <template v-if="rating.readingOrder?.length">
            <div class="reading-title">suggested reading order</div>
            <ol class="reading-order">
              <li v-for="e in rating.readingOrder" :key="e.path">
                <a
                  v-if="diffPaths.has(e.path)"
                  :href="'#' + anchorFor(e.path)"
                  class="reading-path"
                  @click="onFileLinkClick($event, e.path)"
                >{{ e.path }}</a>
                <span v-else class="reading-path">{{ e.path }}</span>
                <div class="item-note">{{ e.note }}</div>
              </li>
            </ol>
          </template>
        </template>
      </div>

      <div class="rating-card">
        <div
          class="rating-head"
          :class="{ clickable: risks && !riskPending }"
          @click="risks && !riskPending && (riskOpen = !riskOpen)"
        >
          <span v-if="risks && !riskPending" class="rating-chevron">{{ riskOpen ? '▾' : '▸' }}</span>
          <span class="card-title" :class="{ 'risk-title': risks }">{{ risks ? 'risk heatmap' : '✦ risk heatmap' }}</span>
          <template v-if="risks">
            <span class="risk-counts">
              <span class="rc high">{{ riskCounts.high }} high</span>
              <span class="rc medium">{{ riskCounts.medium }} medium</span>
              <span class="rc low">{{ riskCounts.low }} low</span>
            </span>
            <span v-if="riskAt" class="rating-effort">mapped {{ timeAgo(riskAt) }}</span>
            <span v-if="riskStale" class="stale-badge" title="the PR was pushed after this map was generated — remap to refresh">out of date</span>
          </template>
          <span class="head-actions">
            <button
              v-if="riskOpen && riskLog.length && !riskPending"
              class="log-toggle"
              @click.stop="showRiskLog = !showRiskLog"
            >
              {{ showRiskLog ? 'hide log' : 'show log' }}
            </button>
            <button
              class="rate-btn"
              :title="riskPending ? 'stop this run' : 'claude rates how much review attention each file needs; colors the file nav'"
              @click.stop="riskPending ? cancelRisk() : mapRisk()"
            >
              <span v-if="riskPending" class="spinner small" />
              {{ riskPending ? 'cancel' : risks ? 'remap' : 'map' }}
            </button>
          </span>
        </div>
        <div v-if="showRiskLog && riskLog.length" ref="riskLogEl" class="rating-log">
          <div v-for="(l, i) in riskLog" :key="i" class="log-line">
            <span class="log-t">{{ l.t }}s</span>{{ l.text }}
          </div>
        </div>
        <div v-if="riskError" class="error-box in-card">{{ riskError }}</div>
        <template v-if="risks && !riskPending && riskOpen">
          <ul class="risk-list">
            <li v-for="r in visibleRisks" :key="r.path">
              <span class="factor-dot" :class="'risk-' + r.level" />
              <div class="risk-item">
                <a
                  v-if="diffPaths.has(r.path)"
                  :href="'#' + anchorFor(r.path)"
                  class="reading-path"
                  @click="onFileLinkClick($event, r.path)"
                >{{ r.path }}</a>
                <span v-else class="reading-path">{{ r.path }}</span>
                <div class="item-note">{{ r.note }}</div>
              </div>
            </li>
          </ul>
          <button
            v-if="riskCounts.low && riskCounts.high + riskCounts.medium > 0"
            class="show-low"
            @click="showLowRisk = !showLowRisk"
          >
            {{ showLowRisk ? 'hide' : 'show' }} {{ riskCounts.low }} low-risk file{{ riskCounts.low === 1 ? '' : 's' }}
          </button>
        </template>
      </div>
      <div class="rating-card">
        <div
          class="rating-head"
          :class="{ clickable: tour && !tourPending }"
          @click="tour && !tourPending && (tourOpen = !tourOpen)"
        >
          <span v-if="tour && !tourPending" class="rating-chevron">{{ tourOpen ? '▾' : '▸' }}</span>
          <span class="card-title">{{ tour ? 'guided tour' : '✦ guided tour' }}</span>
          <template v-if="tour">
            <span class="rating-effort">{{ tour.stops.length }} stops</span>
            <span v-if="tourAt" class="rating-effort">written {{ timeAgo(tourAt) }}</span>
            <span v-if="tourStale" class="stale-badge" title="the PR was pushed after this tour was written — rewrite to refresh">out of date</span>
          </template>
          <span class="head-actions">
            <button
              v-if="tourOpen && tourLog.length && !tourPending"
              class="log-toggle"
              @click.stop="showTourLog = !showTourLog"
            >
              {{ showTourLog ? 'hide log' : 'show log' }}
            </button>
            <button
              class="rate-btn"
              :title="tourPending ? 'stop this run' : 'claude writes an overview of the change and a guided walkthrough of the diff'"
              @click.stop="tourPending ? cancelTour() : generateTour()"
            >
              <span v-if="tourPending" class="spinner small" />
              {{ tourPending ? 'cancel' : tour ? 'rewrite' : 'write' }}
            </button>
          </span>
        </div>
        <div v-if="showTourLog && tourLog.length" ref="tourLogEl" class="rating-log">
          <div v-for="(l, i) in tourLog" :key="i" class="log-line">
            <span class="log-t">{{ l.t }}s</span>{{ l.text }}
          </div>
        </div>
        <div v-if="tourError" class="error-box in-card">{{ tourError }}</div>
        <template v-if="tour && !tourPending && tourOpen">
          <div class="summary-md tour-overview" v-html="renderMarkdown(tour.overview)" />
          <div class="reading-title">stops</div>
          <ol class="reading-order">
            <li v-for="(s, i) in tour.stops" :key="i" :class="{ 'stop-active': tourIndex === i }">
              <strong class="stop-title">{{ s.title }}</strong>
              <div>
                <a
                  v-if="diffPaths.has(s.path)"
                  href="#"
                  class="reading-path"
                  @click.prevent="jumpToStop(i)"
                >{{ s.path }}:{{ s.line }}</a>
                <span v-else class="reading-path">{{ s.path }}:{{ s.line }}</span>
              </div>
              <div class="item-note">{{ s.note }}</div>
            </li>
          </ol>
        </template>
      </div>
      <div id="self-card" class="rating-card">
        <div
          class="rating-head"
          :class="{ clickable: selfQs && !selfPending }"
          @click="selfQs && !selfPending && (selfOpen = !selfOpen)"
        >
          <span v-if="selfQs && !selfPending" class="rating-chevron">{{ selfOpen ? '▾' : '▸' }}</span>
          <span class="card-title">{{ selfQs ? 'ask yourself' : '✦ ask yourself' }}</span>
          <template v-if="selfQs">
            <span class="rating-effort">{{ answeredCount }}/{{ selfQs.length }} answered</span>
            <span v-if="selfAt" class="rating-effort">asked {{ timeAgo(selfAt) }}</span>
            <span v-if="selfStale" class="stale-badge" title="the PR was pushed after these questions were posed — ask again to refresh">out of date</span>
          </template>
          <span class="head-actions">
            <button
              v-if="selfOpen && selfLog.length && !selfPending"
              class="log-toggle"
              @click.stop="showSelfLog = !showSelfLog"
            >
              {{ showSelfLog ? 'hide log' : 'show log' }}
            </button>
            <button
              class="rate-btn"
              :title="selfPending ? 'stop this run' : 'claude poses three big-picture questions — architecture, new patterns, key decisions — for you to answer and post back to the PR'"
              @click.stop="selfPending ? cancelSelf() : generateSelf()"
            >
              <span v-if="selfPending" class="spinner small" />
              {{ selfPending ? 'cancel' : selfQs ? 'ask again' : 'ask' }}
            </button>
          </span>
        </div>
        <div v-if="showSelfLog && selfLog.length" ref="selfLogEl" class="rating-log">
          <div v-for="(l, i) in selfLog" :key="i" class="log-line">
            <span class="log-t">{{ l.t }}s</span>{{ l.text }}
          </div>
        </div>
        <div v-if="selfError" class="error-box in-card">{{ selfError }}</div>
        <template v-if="selfQs && !selfPending && selfOpen">
          <ol class="reading-order self-list">
            <li v-for="(q, i) in selfQs" :key="i">
              <strong class="stop-title">{{ q.topic }}</strong>
              <div class="self-question">{{ q.question }}</div>
              <div class="item-note">{{ q.why }}</div>
              <textarea
                v-model="q.answer"
                class="self-answer"
                rows="3"
                placeholder="your answer — saved as you go, posted only when you say so"
                @blur="saveAnswer(i)"
              />
              <div class="self-actions">
                <a v-if="q.postedUrl" :href="q.postedUrl" target="_blank" rel="noopener" class="posted-link">posted ↗</a>
                <button
                  class="rate-btn"
                  :disabled="!q.answer.trim() || postingIdx !== null"
                  :title="q.answer.trim() ? 'post this question + your answer to the PR as a comment' : 'write an answer first'"
                  @click="postAnswer(i)"
                >
                  <span v-if="postingIdx === i" class="spinner small" />
                  {{ postingIdx === i ? 'posting' : q.postedUrl ? 'post again' : 'post to PR' }}
                </button>
              </div>
            </li>
          </ol>
        </template>
      </div>
      <div class="rating-card">
        <div class="rating-head clickable" @click="diff && (showGraph = true)">
          <span class="rating-chevron">▸</span>
          <span class="card-title">🕸 file map</span>
          <span class="rating-effort">changed files linked by imports &amp; references, in clusters</span>
          <span class="head-actions">
            <button class="rate-btn" :disabled="!diff" @click.stop="showGraph = true">open</button>
          </span>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="showGraph && diff" class="graph-overlay">
        <div class="graph-overlay-head">
          <span class="card-title">🕸 file map</span>
          <span class="rating-effort">changed files linked by imports &amp; references, in clusters</span>
          <button class="graph-x" title="close (esc)" @click="showGraph = false">×</button>
        </div>
        <FileGraph
          :repo="repo"
          :number="number"
          :files="diff.files"
          :anchor-for="anchorFor"
          :risks="riskByPath"
          :last-pushed-at="pr?.lastPushedAt ?? null"
          fullscreen
          @open="onGraphFileClick"
        />
      </div>
    </Teleport>

    <div v-if="pending" class="center">
      <span class="spinner" />
      <span class="loading-note">fetching refs &amp; computing diff locally…</span>
    </div>
    <div v-else-if="error" class="error-box">{{ error.data?.message ?? error.message }}</div>

    <div v-else-if="diff" class="layout">
      <aside class="sidebar">
        <FileNav
          :files="diff.files"
          :closed-files="closedFiles"
          :anchor-for="anchorFor"
          :risks="riskByPath"
          :has-checklist="hasChecklist"
          @open="onFileLinkClick"
        >
          <template #todo>
            <div class="todo">
              <div class="todo-progress">
                <div class="todo-p-row">
                  <span class="todo-label">review progress</span>
                  <span class="todo-count">{{ checklistDone }}/{{ checklistTotal }}</span>
                </div>
                <div
                  class="todo-bar"
                  role="progressbar"
                  :aria-valuenow="checklistPct"
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                  <div class="todo-fill" :style="{ transform: `scaleX(${checklistPct / 100})` }" />
                </div>
                <button v-if="tour" class="todo-next" @click="nextUnreviewed()">next unreviewed →</button>
              </div>

              <div v-if="tour" class="todo-sec">
                <div class="todo-label">reading order</div>
                <ol class="todo-items">
                  <li v-for="(s, i) in tour.stops" :key="i" class="todo-item">
                    <input v-model="stopsDone[i]" type="checkbox" :aria-label="`mark stop ${i + 1} reviewed`">
                    <button
                      class="todo-link"
                      :class="{ done: stopsDone[i], on: tourIndex === i }"
                      @click="jumpToStop(i)"
                    >
                      <span class="todo-title">{{ s.title }}</span>
                      <span class="todo-path">{{ s.path }}</span>
                    </button>
                  </li>
                </ol>
              </div>

              <div v-if="sortedRisks.length" class="todo-sec">
                <div class="todo-label">risks</div>
                <ul class="todo-items">
                  <li v-for="(r, i) in sortedRisks" :key="r.path" class="todo-item">
                    <input v-model="risksDone[i]" type="checkbox" :aria-label="`mark risk on ${r.path} reviewed`">
                    <a
                      v-if="diffPaths.has(r.path)"
                      class="todo-link"
                      :class="{ done: risksDone[i] }"
                      :href="'#' + anchorFor(r.path)"
                      @click="onFileLinkClick($event, r.path)"
                    >
                      <span class="todo-title"><span class="todo-rdot" :class="r.level" /> {{ r.path.split('/').pop() }}</span>
                      <span class="todo-path">{{ r.note }}</span>
                    </a>
                    <span v-else class="todo-link" :class="{ done: risksDone[i] }">
                      <span class="todo-title"><span class="todo-rdot" :class="r.level" /> {{ r.path.split('/').pop() }}</span>
                      <span class="todo-path">{{ r.note }}</span>
                    </span>
                  </li>
                </ul>
              </div>

              <div v-if="selfQs" class="todo-sec">
                <div class="todo-label">ask yourself</div>
                <button
                  class="todo-link"
                  :class="{ done: selfQs.length > 0 && answeredCount === selfQs.length }"
                  @click="openSelfCard()"
                >
                  <span class="todo-title">{{ answeredCount }}/{{ selfQs.length }} answered</span>
                </button>
              </div>
            </div>
          </template>
        </FileNav>
      </aside>

      <div class="diffs">
        <DiffFile
          v-for="f in visibleFiles"
          :key="f.path"
          :file="f"
          :anchor="anchorFor(f.path)"
          :repo="repo"
          :number="number"
          :threads="threadsByFile[f.path] ?? {}"
          :asks="asksByFile[f.path] ?? {}"
          :show-comments="showComments"
          :tour-stop="currentStop && currentStop.path === f.path ? currentStop : null"
          @posted="refreshComments()"
          @asked="refreshAsks()"
          @close="closeFile(f.path)"
        />
        <div v-if="!diff.files.length" class="center muted">empty diff</div>
        <div v-else-if="!visibleFiles.length" class="center muted">all files closed</div>
      </div>
    </div>

    <div v-if="currentStop && tour" class="tour-bar">
      <div class="tour-bar-head">
        <span class="tour-step">{{ tourIndex! + 1 }}/{{ tour.stops.length }}</span>
        <span class="tour-bar-title">{{ currentStop.title }}</span>
        <span class="tour-bar-path">{{ currentStop.path }}:{{ currentStop.line }}</span>
        <button class="tour-x" title="end tour (esc)" @click="endTour">×</button>
      </div>
      <div class="tour-bar-note">{{ currentStop.note }}</div>
      <div class="tour-bar-actions">
        <span class="tour-keys">← → to navigate · esc to end</span>
        <button class="tour-nav" :disabled="tourIndex === 0" @click="prevStop">← prev</button>
        <button class="tour-nav primary" @click="nextStop">
          {{ tourIndex === tour.stops.length - 1 ? 'finish ✓' : 'next →' }}
        </button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.pr-page {
  padding: 20px 24px;
  max-width: 1800px;
  margin: 0 auto;
}
/* Everything except the diff layout sits in a centered 700px reading
   column; .layout (file list + diffs) spans the full page width. */
.bar,
.pr-head,
.center,
.pr-page > .error-box {
  max-width: 700px;
  margin-left: auto;
  margin-right: auto;
}
.bar {
  display: flex;
  gap: 16px;
  align-items: baseline;
  margin-bottom: 12px;
}
.brand {
  font-family: var(--mono);
  font-weight: 700;
  color: var(--text);
}
.toggle {
  margin-left: auto;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  border-radius: 6px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
}
.toggle.on {
  color: var(--text);
  border-color: var(--accent);
}
.pr-head {
  margin-bottom: 24px;
}
.pr-head h1 {
  font-size: 20px;
  margin: 0 0 6px;
  text-wrap: balance;
}

/* Briefing: verdict + tour launch sit at the top; detail cards follow. */
.verdict {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  margin: 0 0 12px;
}
.verdict .rating-score { margin-right: 8px; }
.tour-cta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.tour-go {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  border-radius: 6px;
  padding: 7px 18px;
  font-size: 13px;
  cursor: pointer;
}
.tour-go:hover { filter: brightness(1.1); }
.tour-hint {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}
.tour-cta .run-all { margin-left: auto; }

.desc { margin-bottom: 12px; }
.disclose {
  border: none;
  background: none;
  padding: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.disclose:hover { color: var(--text); }
.d-chev { font-size: 9px; }
.desc .summary { margin-top: 8px; margin-bottom: 0; }
.number { color: var(--muted); font-weight: 400; }
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  color: var(--muted);
  vertical-align: middle;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 16px;
  row-gap: 6px;
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 20px;
}
.meta > * { white-space: nowrap; }
.branch, .stats { font-family: var(--mono); font-size: 12px; }
.branch { max-width: 34ch; overflow: hidden; text-overflow: ellipsis; }
.add { color: var(--green); }
.del { color: var(--red); margin-left: 6px; }
.outdated-note { font-size: 12px; }
.rate-btn {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  border-radius: 6px;
  padding: 2px 10px;
  cursor: pointer;
  font-size: 12px;
}
.rate-btn:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
.rate-btn:disabled { cursor: default; opacity: 0.7; }
.rate-btn.on { color: var(--text); border-color: var(--accent); }
.rating-log {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  padding: 8px 12px;
  margin: 10px 0 2px;
  max-height: 180px;
  overflow-y: auto;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.7;
  color: var(--muted);
}
.log-line { white-space: pre-wrap; overflow-wrap: break-word; }
.log-t {
  display: inline-block;
  min-width: 44px;
  color: var(--accent);
  opacity: 0.8;
}
.log-toggle {
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--muted);
  border-radius: 5px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
}
.log-toggle:hover { color: var(--text); }
.spinner.small { width: 10px; height: 10px; border-width: 2px; }
/* Artifact rows: quiet ▸ disclosures in the reading column, matching the
   description toggle — no card chrome. The verdict line above carries the
   visual weight; these are the ladder beneath it. */
.rating-card {
  padding: 3px 0;
  font-size: 13px;
}
.rating-head {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.rating-head.clickable {
  cursor: pointer;
  user-select: none;
}
.rating-head.clickable:hover .card-title { color: var(--text); }
.rating-chevron { color: var(--muted); font-size: 9px; }
.card-title {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 400;
  color: var(--muted);
}
.head-actions {
  margin-left: auto;
  display: inline-flex;
  gap: 8px;
  align-items: baseline;
}
/* Open-state content indents to the label, past the chevron. */
.rating-card > :not(.rating-head) { margin-left: 19px; }
.error-box.in-card { margin: 10px 0 2px; }
.rating-score {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
}
.verdict .rating-score { font-size: 18px; }
.rating-score.good { color: var(--green); }
.rating-score.mid { color: var(--accent); }
.rating-score.bad { color: var(--red); }
.rating-effort { color: var(--muted); font-size: 12px; }
.stale-badge {
  font-size: 11px;
  font-family: var(--mono);
  color: #d29922;
  border: 1px solid #d2992255;
  border-radius: 10px;
  padding: 0 8px;
  white-space: nowrap;
}
.rating-factors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
}
.rating-factors li {
  display: flex;
  gap: 8px;
}
.rating-factors strong { color: var(--text); font-weight: 600; }
.factor-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 4px;
  background: var(--border);
}
.risk-item { min-width: 0; }
.item-note {
  color: var(--muted);
  line-height: 1.5;
  margin-top: 2px;
}
.factor-dot.good { background: var(--green); }
.factor-dot.bad { background: var(--red); }
.risk-title { font-weight: 600; }
.risk-counts {
  display: flex;
  gap: 10px;
  font-family: var(--mono);
  font-size: 12px;
}
.rc.high { color: var(--red); }
.rc.medium { color: #d29922; }
.rc.low { color: var(--green); }
.risk-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
}
.risk-list li {
  display: flex;
  gap: 8px;
}
.factor-dot.risk-high { background: var(--red); }
.factor-dot.risk-medium { background: #d29922; }
.factor-dot.risk-low { background: var(--green); }
.show-low {
  margin-top: 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  border-radius: 6px;
  padding: 3px 10px;
  cursor: pointer;
  font-size: 12px;
}
.show-low:hover { color: var(--text); border-color: var(--accent); }
.tour-overview {
  margin: 10px 0 4px;
  font-size: 13px;
  line-height: 1.55;
}
.stop-title { font-size: 12px; }
.reading-order li.stop-active .stop-title { color: var(--accent); }
.self-list { margin-top: 12px; }
.self-question {
  margin-top: 2px;
  line-height: 1.5;
}
.self-answer {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
}
.self-answer:focus { border-color: var(--accent); }
.self-actions {
  display: flex;
  justify-content: flex-end;
  align-items: baseline;
  gap: 10px;
  margin-top: 6px;
}
.posted-link { font-size: 12px; }

/* Fullscreen file map overlay */
.graph-overlay {
  position: fixed;
  inset: 0;
  z-index: 30;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  padding: 14px 20px 16px;
}
.graph-overlay-head {
  display: flex;
  gap: 12px;
  align-items: baseline;
  margin-bottom: 10px;
}
.graph-x {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--muted);
  font-weight: 700;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.graph-x:hover { color: var(--red); }

/* Floating tour bar: stays put while the reviewer scrolls, comments, and
   asks; only prev/next/esc move the tour along. */
.tour-bar {
  position: fixed;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  width: min(680px, calc(100vw - 32px));
  z-index: 20;
  border: 1px solid var(--accent);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  padding: 10px 14px;
  font-size: 13px;
}
.tour-bar-head {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.tour-step {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--accent);
}
.tour-bar-title { font-weight: 600; }
.tour-bar-path {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tour-x {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--muted);
  font-weight: 700;
  font-size: 14px;
  cursor: pointer;
}
.tour-x:hover { color: var(--red); }
.tour-bar-note {
  margin-top: 6px;
  color: var(--muted);
  line-height: 1.5;
}
.tour-bar-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}
.tour-keys {
  margin-right: auto;
  color: var(--muted);
  font-size: 11px;
}
.tour-nav {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  border-radius: 6px;
  padding: 3px 12px;
  cursor: pointer;
  font-size: 12px;
}
.tour-nav:hover:not(:disabled) { border-color: var(--accent); }
.tour-nav:disabled { opacity: 0.4; cursor: default; }
.tour-nav.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.reading-title {
  margin: 12px 0 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}
.reading-order {
  margin: 0;
  padding-left: 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
}
.reading-order li::marker { color: var(--muted); }
.reading-path {
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
span.reading-path { color: var(--text); }
.summary {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  padding: 12px 16px;
  margin-bottom: 20px;
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: break-word;
  max-height: 320px;
  overflow-y: auto;
}
.raw-toggle {
  float: right;
  margin-left: 12px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--muted);
  border-radius: 5px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
}
.raw-toggle:hover { color: var(--text); }
.summary-raw {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  font-family: var(--mono);
  font-size: 12px;
}
.summary-md :deep(> :first-child) { margin-top: 0; }
.summary-md :deep(> :last-child) { margin-bottom: 0; }
.summary-md :deep(h1),
.summary-md :deep(h2),
.summary-md :deep(h3),
.summary-md :deep(h4) {
  margin: 14px 0 6px;
  line-height: 1.3;
}
.summary-md :deep(h1) { font-size: 16px; }
.summary-md :deep(h2) { font-size: 15px; }
.summary-md :deep(h3) { font-size: 14px; }
.summary-md :deep(h4) { font-size: 13px; }
.summary-md :deep(p) { margin: 6px 0; }
.summary-md :deep(ul),
.summary-md :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}
.summary-md :deep(li) { margin: 2px 0; }
.summary-md :deep(code) {
  font-family: var(--mono);
  font-size: 12px;
  background: var(--panel-2);
  border-radius: 4px;
  padding: 1px 4px;
}
.summary-md :deep(pre) {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 8px 0;
}
.summary-md :deep(pre code) {
  background: none;
  padding: 0;
}
.summary-md :deep(blockquote) {
  margin: 8px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--border);
  color: var(--muted);
}
.summary-md :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
}
.summary-md :deep(th),
.summary-md :deep(td) {
  border: 1px solid var(--border);
  padding: 4px 10px;
}
.summary-md :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 12px 0;
}
.summary-md :deep(img) { max-width: 100%; }
.center {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
}
.loading-note { color: var(--muted); font-size: 13px; }
.muted { color: var(--muted); }
.layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 20px;
  align-items: start;
}

/* Review checklist (the sidebar's "todo" view; rendered via FileNav's slot,
   so styles live here in the page scope). */
.todo { font-size: 12px; }
.todo-progress { padding: 6px 8px 12px; border-bottom: 1px solid var(--border); }
.todo-p-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
}
.todo-label {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
}
.todo-count { font-family: var(--mono); font-size: 11px; color: var(--text); }
.todo-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--panel-2);
  overflow: hidden;
  margin-bottom: 10px;
}
.todo-fill {
  height: 100%;
  background: var(--accent);
  transform-origin: left;
  transition: transform 0.2s ease-out;
}
@media (prefers-reduced-motion: reduce) {
  .todo-fill { transition: none; }
}
.todo-next {
  width: 100%;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  border-radius: 6px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}
.todo-next:hover { filter: brightness(1.1); }
.todo-sec { padding: 10px 8px; border-bottom: 1px solid var(--border); }
.todo-sec:last-child { border-bottom: none; }
.todo-sec .todo-label { display: block; margin-bottom: 8px; }
.todo-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.todo-item { display: flex; gap: 8px; align-items: flex-start; }
.todo-item input {
  accent-color: var(--accent);
  cursor: pointer;
  margin-top: 2px;
  flex: none;
}
.todo-link {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
  color: var(--text);
  font: inherit;
}
.todo-link:hover .todo-title,
.todo-link.on .todo-title { color: var(--accent); }
.todo-link.done .todo-title {
  color: var(--muted);
  text-decoration: line-through;
}
a.todo-link:hover { text-decoration: none; }
.todo-title { font-size: 12px; font-weight: 600; line-height: 1.4; }
.todo-path {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.todo-rdot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--border);
  margin-right: 2px;
}
.todo-rdot.high { background: var(--red); }
.todo-rdot.medium { background: #d29922; }
.todo-rdot.low { background: var(--green); }
.sidebar {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  padding: 6px;
}
@media (max-width: 1100px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { position: static; max-height: 200px; }
}
</style>
