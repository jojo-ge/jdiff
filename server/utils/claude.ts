import { spawn } from 'node:child_process'

const CLAUDE_TIMEOUT_MS = 300_000

export interface RunClaudeOpts {
  cwd?: string
  // CLI model name; defaults to the fast general-purpose model.
  model?: string
  // Aborting kills the claude process (SIGTERM). Endpoints tie this to the
  // SSE connection so closing the EventSource cancels the run.
  signal?: AbortSignal
  log: (text: string) => void
  // When either delta handler is set, claude runs with
  // --include-partial-messages and thinking/answer text streams out
  // token-by-token as it is generated.
  onThinking?: (text: string) => void
  onText?: (text: string) => void
}

// Runs `claude -p --output-format stream-json` and reports each event as it
// happens, so the UI can show live progress. Resolves with the text of the
// final result event.
export function runClaude(prompt: string, opts: RunClaudeOpts): Promise<string> {
  const wantDeltas = !!(opts.onThinking || opts.onText)
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p', '--model', opts.model ?? 'claude-sonnet-5', '--output-format', 'stream-json', '--verbose',
        ...(wantDeltas ? ['--include-partial-messages'] : []),
      ],
      { timeout: CLAUDE_TIMEOUT_MS, signal: opts.signal, env: process.env, cwd: opts.cwd },
    )
    let result: string | null = null
    let buffered = ''
    let stderr = ''

    const handleLine = (line: string) => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        opts.log(`claude: ${line.slice(0, 200)}`)
        return
      }
      if (msg.type === 'stream_event') {
        const ev = msg.event
        if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'thinking_delta') opts.onThinking?.(ev.delta.thinking)
          else if (ev.delta?.type === 'text_delta') opts.onText?.(ev.delta.text)
        }
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        opts.log(`claude session started — model ${msg.model}`)
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use') {
            const target = block.input?.file_path ?? block.input?.pattern ?? ''
            opts.log(`claude used tool: ${block.name}${target ? ` (${String(target).slice(0, 120)})` : ''}`)
          } else if (!wantDeltas && block.type === 'text') {
            opts.log(`claude replied (${block.text.length} chars)`)
          } else if (!wantDeltas && block.type === 'thinking') {
            opts.log('claude is thinking…')
          }
        }
      } else if (msg.type === 'result') {
        const secs = (msg.duration_ms / 1000).toFixed(1)
        const cost = msg.total_cost_usd != null ? `, $${msg.total_cost_usd.toFixed(4)}` : ''
        opts.log(`claude finished in ${secs}s${cost}`)
        if (msg.is_error) {
          reject(createError({ statusCode: 500, message: String(msg.result ?? 'claude reported an error').slice(0, 500) }))
        } else {
          result = String(msg.result ?? '')
        }
      }
    }

    child.stdout.on('data', (d) => {
      buffered += d
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      lines.forEach(handleLine)
    })
    child.stderr.on('data', (d) => {
      stderr += d
      for (const line of String(d).split('\n')) {
        if (line.trim()) opts.log(`claude stderr: ${line.trim().slice(0, 200)}`)
      }
    })
    child.on('error', (err) => {
      if (err.name === 'AbortError') {
        opts.log('claude run cancelled')
        reject(createError({ statusCode: 499, message: 'cancelled' }))
        return
      }
      reject(createError({
        statusCode: 500,
        message: err.message.includes('ENOENT') ? 'claude CLI not found on PATH' : err.message,
      }))
    })
    child.on('close', (code) => {
      if (buffered.trim()) handleLine(buffered)
      if (result != null) {
        resolve(result)
      } else {
        reject(createError({
          statusCode: 500,
          message: (stderr || `claude exited with code ${code} without a result`).trim().slice(0, 500),
        }))
      }
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}
