// src/lib/logger.ts
import type { LogLevel, LogSource } from './types'

function send(level: LogLevel, source: LogSource, args: unknown[]) {
  const text = args.map(a =>
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  ).join(' ')
  try { chrome.runtime.sendMessage({ type: 'LOG_ENTRY', level, source, text, ts: Date.now() }) }
  catch { /* popup closed */ }
  return text
}

export function makeLogger(source: LogSource) {
  const color = source === 'lead' ? '#3bf0a0' : '#38bdf8'
  const tag   = `%c[CL:${source}]`
  const style = `color:${color};font-weight:bold`
  return {
    log:  (...a: unknown[]) => { console.debug(tag, style, ...a); send('info',  source, a) },
    warn: (...a: unknown[]) => { console.warn(tag,  style, ...a); send('warn',  source, a) },
    err:  (...a: unknown[]) => { console.error(tag, style, ...a); send('error', source, a) },
  }
}
