// Global state for the claude review-guidance runs (rating, risk map, tour,
// ask-yourself). The server runs each job detached from its SSE connection,
// so this composable owns the client half of that contract: task state lives
// in app-wide useState keyed by repo + PR (it survives route changes), the
// EventSources live at module scope (never closed on unmount), and landing
// back on a PR page re-attaches to whatever is still running via
// /api/ai-jobs. Cancelling is an explicit POST — closing a stream only
// stops watching.
//
// useAiTasks binds one PR (the PR page); useAiTasksHub binds a whole repo
// (the list view: kick off runs per row, badge rows with running jobs).

export type AiToolKind = 'rating' | 'risk' | 'tour' | 'self'

export interface AiToolState {
  pending: boolean
  error: string
  log: { t: string; text: string }[]
  showLog: boolean
  // The tool's last 'result' event payload ({ rating | risks | tour |
  // questions, createdAt }); pages watch this and fold it into their view.
  result: Record<string, any> | null
}

export type PrAiTasks = Record<AiToolKind, AiToolState>

type Store = Ref<Record<string, PrAiTasks>>

const TOOL_KINDS: AiToolKind[] = ['rating', 'risk', 'tour', 'self']

const ENDPOINT: Record<AiToolKind, string> = {
  rating: '/api/review-rating',
  risk: '/api/risk-heatmap',
  tour: '/api/tour-generate',
  self: '/api/ask-yourself-generate',
}

const SAVED_ENDPOINT: Record<AiToolKind, string> = {
  rating: '/api/rating',
  risk: '/api/risk',
  tour: '/api/tour',
  self: '/api/ask-yourself',
}

// The combined analyze run tags each result/toolError event with a tool name.
const ANALYZE_TOOL: Record<string, AiToolKind> = {
  rating: 'rating',
  risk: 'risk',
  tour: 'tour',
  questions: 'self',
}

function blankTool(): AiToolState {
  return { pending: false, error: '', log: [], showLog: false, result: null }
}

function useAiTasksStore(): Store {
  return useState<Record<string, PrAiTasks>>('ai-tasks', () => ({}))
}

function ensurePr(store: Store, repo: string, number: string): PrAiTasks {
  const key = `${repo} ${number}`
  if (!store.value[key]) {
    store.value[key] = { rating: blankTool(), risk: blankTool(), tour: blankTool(), self: blankTool() }
  }
  return store.value[key]!
}

function resetTool(t: AiToolState) {
  t.pending = true
  t.error = ''
  t.log = []
  t.showLog = true
}

function handleToolMessage(t: AiToolState, msg: any) {
  if (msg.kind === 'log') {
    t.log.push({ t: msg.t, text: msg.text })
  } else if (msg.kind === 'result') {
    t.result = msg
    t.pending = false
    t.showLog = false
  } else if (msg.kind === 'error') {
    t.error = msg.message
    t.pending = false
  }
}

// Live EventSources. Module scope: navigation must not close them.
const sources = new Map<string, EventSource>()

function sourceKey(repo: string, number: string, kind: AiToolKind | 'analyze'): string {
  return `${repo} ${number} ${kind}`
}

function attach(store: Store, repo: string, number: string, kind: AiToolKind | 'analyze') {
  const key = sourceKey(repo, number, kind)
  if (sources.has(key)) return
  const pr = ensurePr(store, repo, number)

  const url = kind === 'analyze' ? '/api/analyze-generate' : ENDPOINT[kind]
  const params = new URLSearchParams({ repo, number })
  const es = new EventSource(`${url}?${params}`)
  sources.set(key, es)

  const close = () => {
    es.close()
    if (sources.get(key) === es) sources.delete(key)
  }
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    // 'done' is the job's terminal marker; close before EventSource
    // auto-reconnects, or a reconnect after the job expires would start a
    // fresh run. A tool still pending at 'done' will never get its result
    // event — settle it from the saved artifact instead of spinning forever.
    if (msg.kind === 'done') {
      close()
      const pendingKinds = kind === 'analyze' ? TOOL_KINDS : [kind]
      for (const k of pendingKinds) {
        if (pr[k].pending) {
          pr[k].pending = false
          pr[k].showLog = false
          settleFromStore(pr[k], k, repo, number)
        }
      }
      return
    }
    if (kind !== 'analyze') {
      handleToolMessage(pr[kind], msg)
    } else if (msg.kind === 'log') {
      // One run, one log — mirror it into every panel still waiting.
      const line = { t: msg.t, text: msg.text }
      for (const k of TOOL_KINDS) if (pr[k].pending) pr[k].log.push(line)
    } else if (msg.kind === 'result' || msg.kind === 'toolError') {
      const tool = ANALYZE_TOOL[msg.tool]
      if (tool) handleToolMessage(pr[tool], msg.kind === 'toolError' ? { ...msg, kind: 'error' } : msg)
    } else if (msg.kind === 'error') {
      for (const k of TOOL_KINDS) if (pr[k].pending) handleToolMessage(pr[k], msg)
    }
  }
  // Transport drop (server restart, network). The job is still running
  // server-side, so keep the pending state and try to re-attach; if the
  // job finished in the gap, reattach() settles from the saved artifacts.
  es.onerror = () => {
    close()
    const stillWaiting = kind === 'analyze'
      ? TOOL_KINDS.some((k) => pr[k].pending)
      : pr[kind].pending
    if (stillWaiting) setTimeout(() => reattach(store, repo, number), 1500)
  }
}

function startFor(store: Store, repo: string, number: string, kind: AiToolKind) {
  if (import.meta.server) return
  const pr = ensurePr(store, repo, number)
  if (pr[kind].pending) return
  resetTool(pr[kind])
  attach(store, repo, number, kind)
}

// All four artifacts from a single claude run against /api/analyze-generate.
function startAllFor(store: Store, repo: string, number: string) {
  if (import.meta.server) return
  const pr = ensurePr(store, repo, number)
  if (TOOL_KINDS.some((k) => pr[k].pending)) return
  for (const k of TOOL_KINDS) resetTool(pr[k])
  attach(store, repo, number, 'analyze')
}

function requestCancel(repo: string, number: string, kind: AiToolKind | 'analyze') {
  $fetch('/api/ai-job-cancel', { method: 'POST', body: { repo, number, kind } })
    .catch(() => { /* job may have just finished; nothing to kill */ })
}

function closeSource(repo: string, number: string, kind: AiToolKind | 'analyze') {
  const key = sourceKey(repo, number, kind)
  sources.get(key)?.close()
  sources.delete(key)
}

function cancelFor(store: Store, repo: string, number: string, kind: AiToolKind) {
  // During a combined run the four tools share one claude process, so
  // cancelling any one of them cancels the run.
  if (sources.has(sourceKey(repo, number, 'analyze'))) return cancelAllFor(store, repo, number)
  const pr = ensurePr(store, repo, number)
  closeSource(repo, number, kind)
  pr[kind].pending = false
  pr[kind].showLog = false
  requestCancel(repo, number, kind)
}

function cancelAllFor(store: Store, repo: string, number: string) {
  const pr = ensurePr(store, repo, number)
  if (sources.has(sourceKey(repo, number, 'analyze'))) {
    closeSource(repo, number, 'analyze')
    requestCancel(repo, number, 'analyze')
    for (const k of TOOL_KINDS) {
      pr[k].pending = false
      pr[k].showLog = false
    }
    return
  }
  for (const k of TOOL_KINDS) if (pr[k].pending) cancelFor(store, repo, number, k)
}

// Re-attach to whatever the server is still running for this PR. Tools we
// thought were pending but that finished (or died) while no stream was
// watching settle from their saved artifacts.
async function reattach(store: Store, repo: string, number: string) {
  const pr = ensurePr(store, repo, number)
  let running: string[]
  try {
    const res = await $fetch<{ running: string[] }>('/api/ai-jobs', { query: { repo, number } })
    running = res.running
  } catch {
    return
  }
  if (running.includes('analyze')) {
    for (const k of TOOL_KINDS) if (!pr[k].pending) resetTool(pr[k])
    attach(store, repo, number, 'analyze')
  }
  for (const k of TOOL_KINDS) {
    if (running.includes(k)) {
      if (!pr[k].pending) resetTool(pr[k])
      attach(store, repo, number, k)
    } else if (pr[k].pending && !running.includes('analyze') && !sources.has(sourceKey(repo, number, k))) {
      // Finished while detached: the artifact is saved; fetch it so the
      // page doesn't stay stuck on a spinner.
      pr[k].pending = false
      pr[k].showLog = false
      settleFromStore(pr[k], k, repo, number)
    }
  }
}

async function settleFromStore(t: AiToolState, kind: AiToolKind, repo: string, number: string) {
  try {
    const saved = await $fetch<Record<string, any> | null>(SAVED_ENDPOINT[kind], {
      query: { repo, number },
    })
    if (saved) t.result = saved
  } catch { /* the page's own saved-artifact fetch remains the fallback */ }
}

export function useAiTasks(repo: Ref<string>, number: Ref<string>) {
  const store = useAiTasksStore()
  const tasks = computed(() => ensurePr(store, repo.value, number.value))
  const anyPending = computed(() => TOOL_KINDS.some((k) => tasks.value[k].pending))

  return {
    tasks,
    anyPending,
    start: (kind: AiToolKind) => startFor(store, repo.value, number.value, kind),
    startAll: () => startAllFor(store, repo.value, number.value),
    cancel: (kind: AiToolKind) => cancelFor(store, repo.value, number.value, kind),
    cancelAll: () => cancelAllFor(store, repo.value, number.value),
    resume: async () => {
      if (import.meta.server) return
      await reattach(store, repo.value, number.value)
    },
  }
}

const HUB_POLL_MS = 8_000

// Repo-wide view for the PR list: which PRs have jobs running (local state
// answers instantly for runs started in this session; a light poll of
// /api/ai-jobs catches runs from before a reload or another tab), plus a
// fire-and-forget starter per row.
export function useAiTasksHub(repo: Ref<string>) {
  const store = useAiTasksStore()
  const serverRunning = ref<Record<string, string[]>>({})

  async function refresh() {
    try {
      const res = await $fetch<{ prs: Record<string, string[]> }>('/api/ai-jobs', {
        query: { repo: repo.value },
      })
      serverRunning.value = res.prs
    } catch { /* keep the last snapshot; the poll will retry */ }
  }

  function isRunning(number: string | number): boolean {
    const n = String(number)
    if (serverRunning.value[n]?.length) return true
    const pr = store.value[`${repo.value} ${n}`]
    return !!pr && TOOL_KINDS.some((k) => pr[k].pending)
  }

  function startAll(number: string | number) {
    startAllFor(store, repo.value, String(number))
  }

  let timer: ReturnType<typeof setInterval> | undefined
  const onFocus = () => refresh()
  onMounted(() => {
    refresh()
    timer = setInterval(refresh, HUB_POLL_MS)
    window.addEventListener('focus', onFocus)
  })
  onUnmounted(() => {
    if (timer) clearInterval(timer)
    window.removeEventListener('focus', onFocus)
  })

  return { isRunning, startAll, refresh }
}
