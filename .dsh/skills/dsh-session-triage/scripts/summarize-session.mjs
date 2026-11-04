/**
 * Summarize a decoded DSH session log as an execution flow (tool calls,
 * tool results, permission facts, assistant output). Reads the JSONL produced
 * by `decode-sessions.mjs`.
 *
 * Usage: node summarize-session.mjs <decoded.jsonl> [--full]
 *   --full        print complete tool output / assistant text (default clips)
 */

import { readFileSync } from 'node:fs'

const [path, ...flags] = process.argv.slice(2)
if (path === undefined) {
  console.error('usage: node summarize-session.mjs <decoded.jsonl> [--full]')
  process.exit(2)
}
const full = flags.includes('--full')
const LIMIT = 500

const clip = (value) => {
  const text = String(value ?? '')
  if (full || text.length <= LIMIT) return text
  return `${text.slice(0, LIMIT)}…`
}

function blocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      if (block.type === 'text') return block.text ?? ''
      if (block.type === 'reasoning') return ''
      if (block.type === 'tool-call') return ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function toolResultText(message) {
  if (message === undefined || message === null) return ''
  return blocksText(message.content)
}

const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
const printed = []

function emit(...parts) {
  const line = parts.join(' ')
  printed.push(line)
}

for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    emit('UNPARSEABLE', clip(line))
    continue
  }
  const type = event.type
  const data = event.data ?? {}

  switch (type) {
    case 'session':
      break
    case 'session/title':
      emit('TITLE', JSON.stringify(data.title), `(${data.source?.kind ?? '?'})`)
      break
    case 'permission/preset':
      emit('PRESET', data.preset ?? '?')
      break
    case 'sandbox/mode':
      emit('SANDBOX', data.mode ?? '?')
      break
    case 'approval/policy':
      emit('APPROVAL', data.policy ?? '?')
      break
    case 'agent/inbox/spliced': {
      const inserted = data.inserted ?? []
      for (const message of inserted) {
        const text = blocksText(message.content)
        if (text.length > 0) emit('PROMPT', clip(text))
      }
      break
    }
    case 'tool/call':
      emit('CALL', data.name ?? '?', clip(data.arguments ?? data.args ?? ''))
      break
    case 'tool/result': {
      const message = data.message ?? data
      emit('RESULT', `isError=${String(message.isError)}`, clip(toolResultText(message)))
      break
    }
    case 'assistant/message': {
      const message = data.message ?? data
      const text = blocksText(message.content)
      if (text.length > 0) emit('ASSISTANT', clip(text))
      break
    }
    case 'user/message': {
      const text = blocksText(data.message?.content ?? data.content)
      const cwd = text.match(/Current working directory: "([^"]+)"/)
      if (cwd !== null) {
        emit('CTX', `cwd=${cwd[1]}`)
        break
      }
      if (text.startsWith('<system-reminder>')) break
      if (text.length > 0 && text.length <= 500) emit('USER', clip(text))
      break
    }
    case 'job/registered':
      emit('JOB-START', data.jobId ?? '?', data.kind ?? '?')
      break
    case 'job/settled':
      emit('JOB-END', data.jobId ?? '?', data.kind ?? '?')
      break
    case 'turn/end':
      emit('TURN-END', data.reason?.kind ?? '?')
      break
    case 'session/title-llm-request':
    case 'request/header':
    case 'request/context':
    case 'step/start':
    case 'step/end':
    case 'turn/start':
      break
    default:
      if (type.includes('error')) emit('ERROR', type, clip(JSON.stringify(data)))
      break
  }
}

console.log(printed.join('\n'))
console.error(`\n[${path}] ${lines.length} events, ${printed.length} summarized lines${full ? ' (full)' : ''}`)
