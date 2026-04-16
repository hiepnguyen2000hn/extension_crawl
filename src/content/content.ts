// src/content/content.ts
import { fetchAllLeads } from '../lib/crawlLead'
import { fetchAllCompanies } from '../lib/crawlCompany'
import { getSessionFromBrowser, buildHeaders } from '../lib/crawlLead'
import type { CrawlProgress, CompanyCrawlProgress } from '../lib/types'

const SERVER = 'http://localhost:3006'

// ── idempotency guard — prevents double-registration on re-inject ──────────
const g = globalThis as Record<string, unknown>
if (!g['__CL_INIT__']) {
  g['__CL_INIT__'] = true
  console.debug('%c[CL] content script initialized ✅', 'color:#3bf0a0;font-weight:bold', location.href)
  init()
} else {
  console.debug('%c[CL] content script re-injected (already running, skipping)', 'color:#f0a23b')
}

// ── Auto Connect ────────────────────────────────────────────────────────────

interface AutoPayload {
  spreadsheet_id: string
  gid?: number | null
  limit?: number | null
  col_linkedin?: string
  message_template?: string
}

interface SheetRow {
  index: number
  name: string
  url: string
  already_crawled: boolean
  entityUrn: string
  connectStatus: string
  firstName: string
}

function log(text: string, level: 'info' | 'warn' | 'error' = 'info') {
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', level, source: 'sheet', text, ts: Date.now() })
}

async function fetchRows(payload: AutoPayload): Promise<SheetRow[]> {
  const res = await fetch(`${SERVER}/linkedin-rows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spreadsheet_id: payload.spreadsheet_id,
      gid: payload.gid ?? null,
      limit: payload.limit ?? null,
      col_linkedin: payload.col_linkedin ?? 'linkedUrl',
    }),
  })
  if (!res.ok) throw new Error(`/linkedin-rows HTTP ${res.status}`)
  const data = await res.json() as { ok: boolean; rows: SheetRow[]; error?: string }
  if (!data.ok) throw new Error(data.error ?? 'server error')
  return data.rows
}

async function writeBack(
  payload: AutoPayload,
  results: Array<{ index: number; col_header: string; col_value: string }>,
) {
  if (!results.length) return
  const res = await fetch(`${SERVER}/auto-write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spreadsheet_id: payload.spreadsheet_id,
      gid: payload.gid ?? null,
      results,
    }),
  })
  if (!res.ok) throw new Error(`/auto-write HTTP ${res.status}`)
}

async function runAutoConnect(payload: AutoPayload): Promise<void> {
  log('▶ Auto Connect — loading rows…')
  const rows = await fetchRows(payload)
  const targets = rows.filter(r => r.entityUrn && r.connectStatus !== 'connected' && r.connectStatus !== 'pending')
  log(`Found ${targets.length} rows to connect (${rows.length - targets.length} skipped)`)

  if (!targets.length) { log('Nothing to do.'); return }

  const session = getSessionFromBrowser()
  const writeResults: Array<{ index: number; col_header: string; col_value: string }> = []

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i]
    log(`[${i + 1}/${targets.length}] Connecting → ${row.name}`)
    try {
      const res = await fetch('https://www.linkedin.com/sales-api/salesApiInvitations', {
        method: 'POST',
        headers: { ...buildHeaders(session), 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ inviteeUrn: row.entityUrn }),
      })
      if (res.ok || res.status === 201) {
        log(`  ✓ invitation sent`)
        writeResults.push({ index: row.index, col_header: 'Connect_Status', col_value: 'pending' })
      } else {
        const body = await res.text().catch(() => '')
        log(`  ✗ HTTP ${res.status} — ${body.slice(0, 80)}`, 'warn')
      }
    } catch (e) {
      log(`  ✗ ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
    if (i < targets.length - 1) await new Promise(r => setTimeout(r, 1200))
  }

  if (writeResults.length) {
    await writeBack(payload, writeResults)
    log(`✓ Auto Connect done — ${writeResults.length} invitations sent, sheet updated`)
  } else {
    log('Auto Connect done — 0 invitations sent')
  }
  chrome.runtime.sendMessage({ type: 'ENRICH_STATUS', status: 'done' })
}

async function runAutoMessage(payload: AutoPayload): Promise<void> {
  log('▶ Auto Message — loading rows…')
  const rows = await fetchRows(payload)
  const targets = rows.filter(r => r.entityUrn && r.connectStatus === 'connected')
  log(`Found ${targets.length} connected rows (${rows.length - targets.length} skipped)`)

  if (!targets.length) { log('Nothing to do — no connected rows.'); return }

  const template = payload.message_template ?? ''
  if (!template.trim()) { log('✗ message_template is empty', 'error'); return }

  const session = getSessionFromBrowser()
  const writeResults: Array<{ index: number; col_header: string; col_value: string }> = []

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i]
    const body = template.replace(/\{\{firstName\}\}/g, row.firstName || row.name.split(' ')[0] || '')
    log(`[${i + 1}/${targets.length}] Messaging → ${row.name}`)
    try {
      // LinkedIn Sales Navigator InMail / direct message
      const res = await fetch('https://www.linkedin.com/sales-api/salesApiMessagingThreads', {
        method: 'POST',
        headers: { ...buildHeaders(session), 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          keyVersion: 'LEGACY_INBOX',
          conversationCreate: {
            eventCreate: {
              value: {
                'com.linkedin.voyager.messaging.create.MessageCreate': {
                  attributedBody: { text: body, attributes: [] },
                  attachments: [],
                },
              },
            },
            recipients: [row.entityUrn],
            subtype: 'MEMBER_TO_MEMBER',
          },
        }),
      })
      if (res.ok || res.status === 201) {
        log(`  ✓ message sent`)
        writeResults.push({ index: row.index, col_header: 'Message_Sent', col_value: 'TRUE' })
      } else {
        const respBody = await res.text().catch(() => '')
        log(`  ✗ HTTP ${res.status} — ${respBody.slice(0, 80)}`, 'warn')
      }
    } catch (e) {
      log(`  ✗ ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
    if (i < targets.length - 1) await new Promise(r => setTimeout(r, 1500))
  }

  if (writeResults.length) {
    await writeBack(payload, writeResults)
    log(`✓ Auto Message done — ${writeResults.length} messages sent, sheet updated`)
  } else {
    log('Auto Message done — 0 messages sent')
  }
  chrome.runtime.sendMessage({ type: 'ENRICH_STATUS', status: 'done' })
}

function init() {
  // ── localStorage reader ──────────────────────────────────────────────────

  function readLocalStorage(): Record<string, string> {
    const entries: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key) entries[key] = localStorage.getItem(key) ?? ''
    }
    return entries
  }

  // ── message handler ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_LOCAL_STORAGE') {
      try {
        sendResponse({ ok: true, data: readLocalStorage(), url: location.href })
      } catch (e) {
        sendResponse({ ok: false, error: String(e) })
      }
      return true
    }

    if (message.type === 'START_CRAWL_LEAD') {
      fetchAllLeads((progress: CrawlProgress) => {
        chrome.runtime.sendMessage(progress)
      })
      .then(leads => {
        chrome.runtime.sendMessage({ type: 'CRAWL_LEAD_RESULT', ok: true, count: leads.length })
      })
      .catch((err: unknown) => {
        chrome.runtime.sendMessage({
          type: 'CRAWL_LEAD_RESULT',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      sendResponse({ ok: true, started: true })
      return true
    }

    if (message.type === 'START_AUTO_CONNECT') {
      runAutoConnect(message.payload).catch((err: unknown) => {
        chrome.runtime.sendMessage({ type: 'LOG_ENTRY', level: 'error', source: 'sheet', text: `✗ Auto Connect: ${err instanceof Error ? err.message : String(err)}`, ts: Date.now() })
      })
      sendResponse({ ok: true, started: true })
      return true
    }

    if (message.type === 'START_AUTO_MESSAGE') {
      runAutoMessage(message.payload).catch((err: unknown) => {
        chrome.runtime.sendMessage({ type: 'LOG_ENTRY', level: 'error', source: 'sheet', text: `✗ Auto Message: ${err instanceof Error ? err.message : String(err)}`, ts: Date.now() })
      })
      sendResponse({ ok: true, started: true })
      return true
    }

    if (message.type === 'START_CRAWL_COMPANY') {
      fetchAllCompanies(
        (progress: CompanyCrawlProgress) => { chrome.runtime.sendMessage(progress) },
        message.startIdx,
        message.endIdx
      )
      .then(companies => {
        chrome.runtime.sendMessage({ type: 'CRAWL_COMPANY_RESULT', ok: true, count: companies.length })
      })
      .catch((err: unknown) => {
        chrome.runtime.sendMessage({
          type: 'CRAWL_COMPANY_RESULT',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      sendResponse({ ok: true, started: true })
      return true
    }
  })
}

export {}
