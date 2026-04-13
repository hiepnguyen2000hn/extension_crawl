// src/content/content.ts
import { fetchAllLeads } from '../lib/crawlLead'
import { fetchAllCompanies } from '../lib/crawlCompany'
import type { CrawlProgress, CompanyCrawlProgress } from '../lib/types'

// ── idempotency guard — prevents double-registration on re-inject ──────────
const g = globalThis as Record<string, unknown>
if (!g['__CL_INIT__']) {
  g['__CL_INIT__'] = true
  console.debug('%c[CL] content script initialized ✅', 'color:#3bf0a0;font-weight:bold', location.href)
  init()
} else {
  console.debug('%c[CL] content script re-injected (already running, skipping)', 'color:#f0a23b')
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
