<script setup lang="ts">
const path = ref('')
const busy = ref(false)
const error = ref('')
const recents = ref<{ path: string; slug: string }[]>([])

onMounted(() => {
  try {
    recents.value = JSON.parse(localStorage.getItem('differ:recents') ?? '[]')
  } catch { /* ignore */ }
})

async function open(target?: string) {
  const repo = (target ?? path.value).trim()
  if (!repo) return
  busy.value = true
  error.value = ''
  try {
    const info = await $fetch<{ path: string; slug: string }>('/api/repo', { query: { repo } })
    const next = [{ path: info.path, slug: info.slug }, ...recents.value.filter((r) => r.path !== info.path)].slice(0, 10)
    localStorage.setItem('differ:recents', JSON.stringify(next))
    navigateTo({ path: '/prs', query: { repo: info.path } })
  } catch (e: any) {
    error.value = e.data?.message ?? e.message ?? 'failed to open repo'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="home">
    <h1>differ</h1>
    <p class="sub">point at a local clone; PRs come from github, diffs come from your git</p>

    <form class="picker" @submit.prevent="open()">
      <input
        v-model="path"
        placeholder="~/code/my-repo"
        spellcheck="false"
        autofocus
      >
      <button type="submit" :disabled="busy">
        <span v-if="!busy">open</span>
        <span v-else class="spinner" />
      </button>
    </form>

    <div v-if="error" class="error-box">{{ error }}</div>

    <div v-if="recents.length" class="recents">
      <h2>recent</h2>
      <button v-for="r in recents" :key="r.path" class="recent" @click="open(r.path)">
        <span class="slug">{{ r.slug }}</span>
        <span class="rpath">{{ r.path }}</span>
      </button>
    </div>
  </main>
</template>

<style scoped>
.home {
  max-width: 640px;
  margin: 12vh auto 0;
  padding: 0 24px;
}
h1 {
  font-family: var(--mono);
  font-size: 28px;
  margin: 0 0 4px;
}
.sub {
  color: var(--muted);
  margin: 0 0 28px;
}
.picker {
  display: flex;
  gap: 8px;
}
.picker input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  font-family: var(--mono);
  font-size: 13px;
  outline: none;
}
.picker input:focus { border-color: var(--accent); }
.picker button {
  padding: 10px 20px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  cursor: pointer;
  display: flex;
  align-items: center;
}
.picker button:hover { border-color: var(--accent); }
.recents { margin-top: 36px; }
.recents h2 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 0 0 8px;
}
.recent {
  display: flex;
  width: 100%;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
  padding: 10px 14px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  cursor: pointer;
  text-align: left;
}
.recent:hover { border-color: var(--accent); }
.recent .slug { font-weight: 600; }
.recent .rpath {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
