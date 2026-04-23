// Background Service Worker — Crawl Linked

// ── Side Panel: click icon → mở panel bên phải ───────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})


// ── Network request logging ───────────────────────────────────────────────────
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    chrome.storage.session.get(['networkLog'], (result) => {
      const log: chrome.webRequest.WebRequestDetails[] = result.networkLog ?? []
      log.unshift(details)
      chrome.storage.session.set({ networkLog: log.slice(0, 500) })
    })
  },
  { urls: ['<all_urls>'] },
  []
)

// ── Enrich Sheet SSE (runs in background, survives popup close) ───────────────
let enrichController: AbortController | null = null

type SheetPayload = {
  spreadsheet_id: string
  gid: number | null
  limit: number | null
  col_linkedin?: string
  col_name?: string
}

async function startSheetJob(endpoint: string, payload: SheetPayload) {
  return _runSSE(endpoint, payload)
}

async function startEnrichSheet(payload: SheetPayload) {
  return _runSSE('enrich-sheet', payload)
}

async function _runSSE(endpoint: string, payload: SheetPayload) {
  if (enrichController) enrichController.abort()
  enrichController = new AbortController()

  await chrome.storage.local.set({ enrichStatus: 'running', enrichLogs: [] })
  _broadcastEnrich({ type: 'ENRICH_STATUS', status: 'running' })

  const apiUrl = await _getApiUrl()
  const IDLE_MS = 90_000

  try {
    const res = await fetch(`${apiUrl}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: enrichController.signal,
    })

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SSE idle timeout')), IDLE_MS)
        ),
      ])
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        for (const raw of part.split('\n')) {
          if (!raw.startsWith('data: ')) continue
          const text = raw.slice(6).trim()
          if (!text) continue

          if (text.startsWith('__EXIT__:')) {
            const code = parseInt(text.split(':')[1] ?? '1', 10)
            const status = code === 0 ? 'done' : 'error'
            await chrome.storage.local.set({ enrichStatus: status })
            _broadcastEnrich({ type: 'ENRICH_STATUS', status })
          } else if (text.startsWith('__ERROR__:')) {
            const msg = text.slice(10)
            await _appendLog(msg)
            _broadcastEnrich({ type: 'ENRICH_LOG', line: msg })
          } else {
            await _appendLog(text)
            _broadcastEnrich({ type: 'ENRICH_LOG', line: text })
          }
        }
      }
    }
  } catch (e: unknown) {
    if ((e as Error).name === 'AbortError') return
    const msg = `✗ ${(e as Error).message ?? e}`
    await _appendLog(msg)
    await chrome.storage.local.set({ enrichStatus: 'error' })
    _broadcastEnrich({ type: 'ENRICH_LOG', line: msg })
    _broadcastEnrich({ type: 'ENRICH_STATUS', status: 'error' })
  }
}

async function _appendLog(line: string) {
  const data = await chrome.storage.local.get(['enrichLogs'])
  const logs: string[] = data.enrichLogs ?? []
  logs.push(line)
  // giữ tối đa 200 log
  await chrome.storage.local.set({ enrichLogs: logs.slice(-200) })
}

function _broadcastEnrich(msg: object) {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup có thể đang đóng */ })
}

async function _getApiUrl(): Promise<string> {
  const data = await chrome.storage.local.get(['apiUrl'])
  return (data.apiUrl as string | undefined) ?? (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3006'
}

// ── LinkedIn via Chrome Tab (Chrome handles auth automatically) ───────────────

/** Mở tab Chrome, đợi load xong, trích text bằng executeScript */
async function _crawlViaTab(url: string): Promise<string> {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      const tabId = tab.id!

      // Timeout 30s phòng tab treo
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated)
        chrome.tabs.remove(tabId).catch(() => {})
        resolve('')
      }, 30_000)

      const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
        if (id !== tabId || info.status !== 'complete') return
        chrome.tabs.onUpdated.removeListener(onUpdated)
        clearTimeout(timer)

        // Đợi 4s cho posts lazy-load render xong
        setTimeout(() => {
          chrome.scripting.executeScript(
            { target: { tabId }, func: () => document.documentElement.outerHTML },
            (results) => {
              chrome.tabs.remove(tabId).catch(() => {})
              resolve(results?.[0]?.result ?? '')
            }
          )
        }, 4_000)
      }

      chrome.tabs.onUpdated.addListener(onUpdated)
    })
  })
}

/** Orchestrate: đọc sheet rows → crawl từng URL qua tab → extract → write */
async function startLinkedInViaTab(payload: SheetPayload) {
  if (enrichController) enrichController.abort()
  enrichController = new AbortController()

  await chrome.storage.local.set({ enrichStatus: 'running', enrichLogs: [] })
  _broadcastEnrich({ type: 'ENRICH_STATUS', status: 'running' })

  const apiUrl = await _getApiUrl()
  const log = (line: string) => {
    _appendLog(line)
    _broadcastEnrich({ type: 'ENRICH_LOG', line })
  }

  try {
    // 1. Lấy danh sách rows từ sheet
    const rowsRes = await fetch(`${apiUrl}/linkedin-rows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spreadsheet_id: payload.spreadsheet_id,
        gid: payload.gid,
        limit: payload.limit,
        col_linkedin: payload.col_linkedin ?? 'linkedUrl',
        col_name: payload.col_name ?? 'fullName',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const { rows, total } = await rowsRes.json() as { rows: Array<{index: number; name: string; url: string; already_crawled: boolean}>; total: number }

    const toProcess = rows.filter(r => r.url && !r.already_crawled)
    log(`Found ${total} rows — processing ${toProcess.length} (skip already crawled)`)

    if (toProcess.length === 0) {
      log('Nothing to crawl.')
      await chrome.storage.local.set({ enrichStatus: 'done' })
      _broadcastEnrich({ type: 'ENRICH_STATUS', status: 'done' })
      return
    }

    // 2. Crawl từng người qua Chrome tab
    const results: Array<{index: number; name: string; url: string; post: string; crawled: boolean}> = []

    for (let i = 0; i < toProcess.length; i++) {
      if (enrichController.signal.aborted) break
      const row = toProcess[i]
      log(`[${i + 1}/${toProcess.length}] ${row.name}`)

      const profileUrl = row.url.endsWith('/') ? row.url : row.url + '/'
      log(`  Opening tab: ${profileUrl}`)

      const text = await _crawlViaTab(profileUrl)
      log(`  Extracted ${text.length} chars`)

      if (text.length < 200) {
        log(`  ⚠ Too short — skipping DeepSeek`)
        results.push({ index: row.index, name: row.name, url: row.url, post: '', crawled: false })
        continue
      }

      // 3. DeepSeek extract
      const extractRes = await fetch(`${apiUrl}/linkedin-extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, name: row.name }),
        signal: AbortSignal.timeout(120_000), // DeepSeek có thể chậm trên AWS
      })
      const { post, ok: extractOk } = await extractRes.json() as { post: string; ok: boolean }
      log(`  Post: ${post ? post.slice(0, 80) + '…' : '(empty)'}`)
      results.push({ index: row.index, name: row.name, url: row.url, post: post ?? '', crawled: !!post })
    }

    // 4. Ghi kết quả vào sheet
    log(`\nWriting ${results.length} results to sheet...`)
    const writeRes = await fetch(`${apiUrl}/linkedin-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spreadsheet_id: payload.spreadsheet_id,
        gid: payload.gid,
        col_linkedin: payload.col_linkedin ?? 'linkedUrl',
        col_name: payload.col_name ?? 'fullName',
        results,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const writeData = await writeRes.json() as { ok: boolean; url?: string; error?: string }
    if (writeData.ok) {
      log(`✓ Done! ${writeData.url ?? ''}`)
      await chrome.storage.local.set({ enrichStatus: 'done' })
      _broadcastEnrich({ type: 'ENRICH_STATUS', status: 'done' })
    } else {
      log(`✗ Write failed: ${writeData.error}`)
      await chrome.storage.local.set({ enrichStatus: 'error' })
      _broadcastEnrich({ type: 'ENRICH_STATUS', status: 'error' })
    }

  } catch (e: unknown) {
    if ((e as Error).name === 'AbortError') return
    const msg = `✗ ${(e as Error).message ?? e}`
    await _appendLog(msg)
    await chrome.storage.local.set({ enrichStatus: 'error' })
    _broadcastEnrich({ type: 'ENRICH_LOG', line: msg })
    _broadcastEnrich({ type: 'ENRICH_STATUS', status: 'error' })
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_NETWORK_LOG') {
    chrome.storage.session.get(['networkLog'], (result) => {
      sendResponse({ networkLog: result.networkLog ?? [] })
    })
    return true
  }

  if (message.type === 'CLEAR_NETWORK_LOG') {
    chrome.storage.session.set({ networkLog: [] })
    sendResponse({ ok: true })
  }

  if (message.type === 'DOWNLOAD_CSV') {
    const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(message.content as string)
    chrome.downloads.download({ url: dataUrl, filename: message.filename as string, saveAs: false })
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'GET_LATEST_URL') {
    chrome.storage.session.get(['networkLog'], (result) => {
      const log: chrome.webRequest.WebRequestDetails[] = result.networkLog ?? []
      const match = log.find(e =>
        e.url.includes(message.keyword) &&
        (message.tabId === undefined || e.tabId === message.tabId)
      )
      sendResponse({ url: match?.url ?? null })
    })
    return true
  }

  if (message.type === 'START_ENRICH_SHEET') {
    startSheetJob('enrich-sheet', message.payload).catch(console.error)
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'START_LINKEDIN_SHEET') {
    // Dùng Chrome Tab thay vì Playwright — Chrome tự xử lý auth LinkedIn
    startLinkedInViaTab(message.payload).catch(console.error)
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'START_GEN_CONNECT_MSG') {
    startSheetJob('gen-connect-message', message.payload).catch(console.error)
    sendResponse({ ok: true })
    return true
  }

  // Popup vừa mở, đồng bộ trạng thái hiện tại
  if (message.type === 'GET_ENRICH_STATE') {
    chrome.storage.local.get(['enrichStatus', 'enrichLogs'], (data) => {
      sendResponse({
        status: data.enrichStatus ?? 'idle',
        logs: data.enrichLogs ?? [],
      })
    })
    return true
  }

  // Popup reset trạng thái
  if (message.type === 'RESET_ENRICH') {
    if (enrichController) enrichController.abort()
    chrome.storage.local.set({ enrichStatus: 'idle', enrichLogs: [] })
    sendResponse({ ok: true })
    return true
  }
})

export {}
