// src/popup/App.tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import type { CrawlProgress, CrawlResult, CompanyCrawlProgress, CompanyCrawlResult, LogEntry, CrawlCSVReady } from '../lib/types'
import { checkServer, crawlUrl, type CrawlUrlResult } from '../lib/crawlWebsite'

type BtnStatus = 'idle' | 'fetching' | 'enriching' | 'done' | 'error'
type AppTab = 'linkedin' | 'website' | 'sheet'
type SheetMode = 'enrich' | 'linkedin' | 'auto' | 'genmsg'
type AutoAction = 'message' | 'connect_v2'

interface ProgressState {
  phase: 'fetch' | 'enrich' | 'done' | 'error'
  fetched: number; total: number; current: number; error?: string
}

const DEFAULT_PROGRESS: ProgressState = { phase: 'fetch', fetched: 0, total: 0, current: 0 }
const MAX_LOGS = 200

type IncomingMsg = CrawlProgress | CrawlResult | CompanyCrawlProgress | CompanyCrawlResult | LogEntry | CrawlCSVReady

export default function App() {
  const manifest = chrome.runtime.getManifest()

  const [tabUrl, setTabUrl] = useState('—')
  const [tabId,  setTabId]  = useState<number | null>(null)
  const [tick,   setTick]   = useState(false)

  // ── LinkedIn tab state ────────────────────────────────────────────────────
  const [leadStatus,    setLeadStatus]    = useState<BtnStatus>('idle')
  const [leadProgress,  setLeadProgress]  = useState<ProgressState>(DEFAULT_PROGRESS)
  const [companyStatus,   setCompanyStatus]   = useState<BtnStatus>('idle')
  const [companyProgress, setCompanyProgress] = useState<ProgressState>(DEFAULT_PROGRESS)
  const [leadCsv,    setLeadCsv]    = useState<{ csv: string; filename: string } | null>(null)
  const [companyCsv, setCompanyCsv] = useState<{ csv: string; filename: string } | null>(null)

  // ── Website tab state ─────────────────────────────────────────────────────
  const [websiteUrl,    setWebsiteUrl]    = useState('')
  const [websiteStatus, setWebsiteStatus] = useState<BtnStatus>('idle')
  const [websiteResult, setWebsiteResult] = useState<CrawlUrlResult | null>(null)

  // ── Sheet tab state ───────────────────────────────────────────────────────
  const [sheetMode,     setSheetMode]     = useState<SheetMode>('enrich')
  const [sheetPasteUrl, setSheetPasteUrl] = useState('')
  const [sheetId,       setSheetId]       = useState('')
  const [sheetGid,      setSheetGid]      = useState('')
  const [rowLimit,      setRowLimit]      = useState('15')
  const [colLinkedin,   setColLinkedin]   = useState('linkedUrl')
  const [sheetStatus,   setSheetStatus]   = useState<BtnStatus>('idle')
  const [autoAction,      setAutoAction]      = useState<AutoAction>('connect_v2')
  const [messageTemplate, setMessageTemplate] = useState('')
  const [colMessage,       setColMessage]       = useState('message')
  const [autoStatus,      setAutoStatus]      = useState<BtnStatus>('idle')
  const [genMsgRegen,     setGenMsgRegen]     = useState(false)

  // ── UI state ──────────────────────────────────────────────────────────────
  const [activeTab,  setActiveTab]  = useState<AppTab>('linkedin')
  const [logs, setLogs]             = useState<LogEntry[]>([])
  const [termOpen, setTermOpen]     = useState(true)
  const logEndRef = useRef<HTMLDivElement>(null)

  const pushLog = useCallback((entry: Omit<LogEntry, 'type'>) => {
    setLogs(prev => {
      const next = [...prev, { ...entry, type: 'LOG_ENTRY' as const }]
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
    })
  }, [])

  // ── Persist inputs + restore on open ─────────────────────────────────────
  useEffect(() => {
    chrome.storage.local.get(
      ['activeTab', 'websiteUrl', 'sheetPasteUrl', 'sheetId', 'sheetGid',
       'rowLimit', 'sheetMode', 'colLinkedin', 'savedLogs'],
      (d) => {
        if (d.activeTab)    setActiveTab(d.activeTab as AppTab)
        if (d.websiteUrl)   setWebsiteUrl(d.websiteUrl)
        if (d.sheetPasteUrl) setSheetPasteUrl(d.sheetPasteUrl)
        if (d.sheetId)      setSheetId(d.sheetId)
        if (d.sheetGid)     setSheetGid(d.sheetGid)
        if (d.rowLimit)     setRowLimit(d.rowLimit)
        if (d.sheetMode)    setSheetMode(d.sheetMode as SheetMode)
        if (d.colLinkedin)  setColLinkedin(d.colLinkedin)
        if (d.savedLogs)    setLogs(d.savedLogs)
      }
    )
    // sync enrich state từ background
    chrome.runtime.sendMessage({ type: 'GET_ENRICH_STATE' }, (res) => {
      if (!res) return
      const status = res.status === 'running' ? 'fetching' : res.status
      setSheetStatus(status as BtnStatus)
      if (res.logs?.length) {
        setLogs(prev => {
          const entries = (res.logs as string[]).map((text: string) => ({
            type: 'LOG_ENTRY' as const,
            level: /error|traceback/i.test(text) ? 'error' as const : 'info' as const,
            source: 'sheet' as const,
            text,
            ts: Date.now(),
          }))
          return [...prev, ...entries].slice(-MAX_LOGS)
        })
      }
    })
  }, [])

  useEffect(() => {
    chrome.storage.local.set({ activeTab, websiteUrl, sheetPasteUrl, sheetId, sheetGid, rowLimit, sheetMode, colLinkedin })
  }, [activeTab, websiteUrl, sheetPasteUrl, sheetId, sheetGid, rowLimit, sheetMode, colLinkedin])

  useEffect(() => {
    if (logs.length === 0) return
    chrome.storage.local.set({ savedLogs: logs.slice(-50) })
  }, [logs])

  // ── Notifications khi crawl xong ─────────────────────────────────────────
  const prevLead    = useRef<BtnStatus>('idle')
  const prevCompany = useRef<BtnStatus>('idle')
  const prevSheet   = useRef<BtnStatus>('idle')

  useEffect(() => {
    const notify = (id: string, title: string, message: string) => {
      chrome.notifications.create(id, { type: 'basic', iconUrl: 'assets/icon128.png', title, message })
    }
    if (prevLead.current !== leadStatus) {
      if (leadStatus === 'done')  notify('lead-done', 'Crawl Lead ✓', `Hoàn tất ${leadProgress.total} leads`)
      if (leadStatus === 'error') notify('lead-err',  'Crawl Lead ✗', 'Có lỗi xảy ra')
      prevLead.current = leadStatus
    }
  }, [leadStatus, leadProgress.total])

  useEffect(() => {
    const notify = (id: string, title: string, message: string) => {
      chrome.notifications.create(id, { type: 'basic', iconUrl: 'assets/icon128.png', title, message })
    }
    if (prevCompany.current !== companyStatus) {
      if (companyStatus === 'done')  notify('co-done', 'Crawl Company ✓', `Hoàn tất ${companyProgress.total} companies`)
      if (companyStatus === 'error') notify('co-err',  'Crawl Company ✗', 'Có lỗi xảy ra')
      prevCompany.current = companyStatus
    }
  }, [companyStatus, companyProgress.total])

  useEffect(() => {
    const notify = (id: string, title: string, message: string) => {
      chrome.notifications.create(id, { type: 'basic', iconUrl: 'assets/icon128.png', title, message })
    }
    if (prevSheet.current !== sheetStatus) {
      if (sheetStatus === 'done')  notify('sheet-done', 'Sheet ✓', 'Crawl hoàn tất')
      if (sheetStatus === 'error') notify('sheet-err',  'Sheet ✗', 'Có lỗi xảy ra')
      prevSheet.current = sheetStatus
    }
  }, [sheetStatus])

  // ── Blink cursor ──────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setTick(t => !t), 530)
    return () => clearInterval(id)
  }, [])

  // ── Active tab URL ────────────────────────────────────────────────────────
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs[0]
      if (t) { setTabUrl(t.url ?? '—'); setTabId(t.id ?? null) }
    })
  }, [])

  // ── Auto-scroll terminal ──────────────────────────────────────────────────
  const termBodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // Scroll về đầu khi chuyển tab
  useEffect(() => {
    if (termBodyRef.current) termBodyRef.current.scrollTop = 0
  }, [activeTab])

  // ── Message listener ──────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (msg: IncomingMsg & { line?: string; status?: string }) => {
      if (msg.type === 'LOG_ENTRY') {
        setLogs(prev => { const n = [...prev, msg as LogEntry]; return n.length > MAX_LOGS ? n.slice(-MAX_LOGS) : n })
        return
      }
      if (msg.type === 'ENRICH_LOG') {
        const text = msg.line ?? ''
        pushLog({ level: /error|traceback/i.test(text) ? 'error' : 'info', source: 'sheet', text, ts: Date.now() })
        return
      }
      if (msg.type === 'ENRICH_STATUS') {
        const s = msg.status ?? ''
        setSheetStatus(s === 'running' ? 'fetching' : s as BtnStatus)
        return
      }
      if (msg.type === 'CRAWL_LEAD_PROGRESS') {
        const p = msg as CrawlProgress
        if (p.phase === 'fetch')   { setLeadStatus('fetching');  setLeadProgress(prev => ({ ...prev, phase: 'fetch', fetched: p.fetched ?? prev.fetched, total: p.total ?? prev.total })) }
        if (p.phase === 'enrich')  { setLeadStatus('enriching'); setLeadProgress(prev => ({ ...prev, phase: 'enrich', current: p.current ?? prev.current, total: p.total ?? prev.total })) }
        if (p.phase === 'done')    { setLeadStatus('done');      setLeadProgress(prev => ({ ...prev, phase: 'done', total: p.total ?? prev.total })); pushLog({ level: 'info', source: 'lead', text: `✓ ${p.total} leads`, ts: Date.now() }) }
      }
      if (msg.type === 'CRAWL_LEAD_RESULT') { const r = msg as CrawlResult; if (!r.ok) { setLeadStatus('error'); pushLog({ level: 'error', source: 'lead', text: `✗ ${r.error}`, ts: Date.now() }) } }
      if (msg.type === 'CRAWL_COMPANY_PROGRESS') {
        const p = msg as CompanyCrawlProgress
        if (p.phase === 'fetch')  { setCompanyStatus('fetching');  setCompanyProgress(prev => ({ ...prev, phase: 'fetch', fetched: p.fetched ?? prev.fetched, total: p.total ?? prev.total })) }
        if (p.phase === 'enrich') { setCompanyStatus('enriching'); setCompanyProgress(prev => ({ ...prev, phase: 'enrich', current: p.current ?? prev.current, total: p.total ?? prev.total })) }
        if (p.phase === 'done')   { setCompanyStatus('done');      setCompanyProgress(prev => ({ ...prev, phase: 'done', total: p.total ?? prev.total })); pushLog({ level: 'info', source: 'company', text: `✓ ${p.total} companies`, ts: Date.now() }) }
      }
      if (msg.type === 'CRAWL_COMPANY_RESULT') { const r = msg as CompanyCrawlResult; if (!r.ok) { setCompanyStatus('error'); pushLog({ level: 'error', source: 'company', text: `✗ ${r.error}`, ts: Date.now() }) } }
      if (msg.type === 'CRAWL_LEAD_CSV')    { setLeadCsv({ csv: (msg as CrawlCSVReady).csv, filename: (msg as CrawlCSVReady).filename }) }
      if (msg.type === 'CRAWL_COMPANY_CSV') { setCompanyCsv({ csv: (msg as CrawlCSVReady).csv, filename: (msg as CrawlCSVReady).filename }) }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [pushLog])

  // ── sendToTab helper ──────────────────────────────────────────────────────
  const sendToTab = useCallback(async (message: object) => {
    if (!tabId) return
    return new Promise<void>((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, () => {
        if (chrome.runtime.lastError) {
          chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] }, () => {
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return }
            chrome.tabs.sendMessage(tabId, message, () => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
              else resolve()
            })
          })
        } else resolve()
      })
    })
  }, [tabId])

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleCrawlLead = useCallback(() => {
    if (!tabId) return
    setLeadStatus('fetching'); setLeadProgress(DEFAULT_PROGRESS); setLeadCsv(null)
    pushLog({ level: 'info', source: 'lead', text: '▶ START CRAWL LEAD', ts: Date.now() })
    sendToTab({ type: 'START_CRAWL_LEAD' }).catch(err => { setLeadStatus('error'); pushLog({ level: 'error', source: 'lead', text: err.message, ts: Date.now() }) })
  }, [tabId, sendToTab, pushLog])

  const handleCrawlCompany = useCallback(() => {
    if (!tabId) return
    setCompanyStatus('fetching'); setCompanyProgress(DEFAULT_PROGRESS); setCompanyCsv(null)
    pushLog({ level: 'info', source: 'company', text: '▶ START CRAWL COMPANY', ts: Date.now() })
    sendToTab({ type: 'START_CRAWL_COMPANY' }).catch(err => { setCompanyStatus('error'); pushLog({ level: 'error', source: 'company', text: err.message, ts: Date.now() }) })
  }, [tabId, sendToTab, pushLog])

const handleCrawlWebsite = useCallback(async () => {
    const url = websiteUrl.trim()
    if (!url) return
    setWebsiteStatus('fetching')
    setWebsiteResult(null)
    pushLog({ level: 'info', source: 'website', text: `▶ crawling ${url}`, ts: Date.now() })
    const alive = await checkServer()
    if (!alive) { setWebsiteStatus('error'); pushLog({ level: 'error', source: 'website', text: '✗ server offline — chạy: python -m uvicorn server:app --port 3006', ts: Date.now() }); return }
    const res = await crawlUrl(url)
    if (res.ok) {
      pushLog({ level: 'info', source: 'website', text: `✓ crawled ${res.markdown.length} chars`, ts: Date.now() })
      if (res.linh_vuc)       pushLog({ level: 'info', source: 'website', text: `Lĩnh vực: ${res.linh_vuc}`, ts: Date.now() })
      if (res.tuyen_dung)     pushLog({ level: 'info', source: 'website', text: `Tuyển dụng:\n${res.tuyen_dung}`, ts: Date.now() })
      if (res.blog)           pushLog({ level: 'info', source: 'website', text: `Blog:\n${res.blog}`, ts: Date.now() })
      if (res.du_an_gan_nhat) pushLog({ level: 'info', source: 'website', text: `Dự án: ${res.du_an_gan_nhat}`, ts: Date.now() })
      if (res.doi_tac)        pushLog({ level: 'info', source: 'website', text: `Đối tác: ${res.doi_tac}`, ts: Date.now() })
      setWebsiteResult(res)
      setWebsiteStatus('done')
    } else {
      pushLog({ level: 'error', source: 'website', text: `✗ ${res.error}`, ts: Date.now() })
      setWebsiteStatus('error')
    }
  }, [websiteUrl, pushLog])

  const handleSheetUrlPaste = useCallback((raw: string) => {
    setSheetPasteUrl(raw)
    const idMatch  = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
    const gidMatch = raw.match(/[?#&]gid=(\d+)/)
    if (idMatch)  setSheetId(idMatch[1])
    if (gidMatch) setSheetGid(gidMatch[1])
  }, [])

  const handleStartSheet = useCallback(() => {
    if (!sheetId.trim()) return
    setSheetStatus('fetching')
    const modeLabel = sheetMode === 'enrich' ? 'Company' : sheetMode === 'genmsg' ? 'Gen Message' : 'LinkedIn Posts'
    pushLog({ level: 'info', source: 'sheet', text: `▶ ${modeLabel} — ${sheetId.slice(0, 16)}… limit=${rowLimit || 'all'}`, ts: Date.now() })
    const payload = { spreadsheet_id: sheetId.trim(), gid: sheetGid ? Number(sheetGid) : null, limit: rowLimit ? Number(rowLimit) : null }
    const msgType = sheetMode === 'enrich' ? 'START_ENRICH_SHEET'
                  : sheetMode === 'genmsg' ? 'START_GEN_CONNECT_MSG'
                  : 'START_LINKEDIN_SHEET'
    const fullPayload = sheetMode === 'linkedin' ? { ...payload, col_linkedin: colLinkedin }
                      : sheetMode === 'genmsg'   ? { ...payload, regen: genMsgRegen }
                      : payload
    chrome.runtime.sendMessage({ type: msgType, payload: fullPayload })
  }, [sheetId, sheetGid, rowLimit, sheetMode, colLinkedin, pushLog])

  const handleAutoAction = useCallback(() => {
    if (!sheetId.trim()) return
    setAutoStatus('fetching')
    const label = autoAction === 'connect_v2' ? 'Auto Connect V2' : 'Auto Message'
    pushLog({ level: 'info', source: 'sheet', text: `▶ ${label} — ${sheetId.slice(0, 16)}… limit=${rowLimit || 'all'}`, ts: Date.now() })
    const payload: Record<string, unknown> = {
      spreadsheet_id: sheetId.trim(),
      gid: sheetGid ? Number(sheetGid) : null,
      limit: rowLimit ? Number(rowLimit) : null,
      col_linkedin: colLinkedin,
    }
    if (autoAction === 'message')    payload['message_template'] = messageTemplate
    if (autoAction === 'connect_v2') payload['col_message'] = colMessage || 'message'
    const msgType = autoAction === 'connect_v2' ? 'START_AUTO_CONNECT_V2' : 'START_AUTO_MESSAGE'
    sendToTab({ type: msgType, payload })
      .catch(err => { setAutoStatus('error'); pushLog({ level: 'error', source: 'sheet', text: err.message, ts: Date.now() }) })
  }, [sheetId, sheetGid, rowLimit, autoAction, messageTemplate, colMessage, colLinkedin, sendToTab, pushLog])

  // ── Computed ──────────────────────────────────────────────────────────────
  const leadBusy    = leadStatus === 'fetching' || leadStatus === 'enriching'
  const companyBusy = companyStatus === 'fetching' || companyStatus === 'enriching'
  const websiteBusy = websiteStatus === 'fetching'
  const sheetBusy   = sheetStatus === 'fetching'
  const autoBusy    = autoStatus === 'fetching'
  const anyActive   = leadBusy || companyBusy || websiteBusy || sheetBusy || autoBusy
  const hostname = (() => { try { return new URL(tabUrl).hostname } catch { return tabUrl } })()
  const isLinkedInPage = tabUrl.includes('linkedin.com/sales')

  // Filter logs theo tab đang xem
  const tabSources: Record<AppTab, string[]> = {
    linkedin: ['lead', 'company'],
    website:  ['website'],
    sheet:    ['sheet'],
  }
  const visibleLogs = logs.filter(e => tabSources[activeTab].includes(e.source ?? ''))

  return (
    <div style={s.shell}>
      {/* Header */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.logo}>CL</span>
          <div>
            <div style={s.title}>{manifest.name.toUpperCase()}</div>
            <div style={s.subtitle}>{manifest.description}</div>
          </div>
        </div>
        <StatusDot active={anyActive} error={leadStatus === 'error' || companyStatus === 'error' || sheetStatus === 'error'} done={!anyActive && (leadStatus === 'done' || companyStatus === 'done' || sheetStatus === 'done')} />
      </header>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {(['linkedin', 'website', 'sheet'] as AppTab[]).map(t => (
          <button key={t} style={{ ...s.tabBtn, ...(activeTab === t ? s.tabBtnActive : {}) }} onClick={() => setActiveTab(t)}>
            {t === 'linkedin' ? 'LINKEDIN' : t === 'website' ? 'WEBSITE' : 'SHEET'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={s.tabContent}>

        {/* ── LINKEDIN tab ── */}
        {activeTab === 'linkedin' && (
          <div style={s.tabPane}>
            <div style={s.targetRow}>
              <span style={s.label}>TARGET</span>
              <span style={s.urlText} title={tabUrl}>{hostname}</span>
            </div>
            {!isLinkedInPage && (
              <div style={{ fontSize: '9px', color: 'var(--warn)', letterSpacing: '1px', textAlign: 'center' as const, padding: '4px 0' }}>
                ⚠ Navigate to LinkedIn Sales Navigator (linkedin.com/sales) to enable crawl
              </div>
            )}
            <div style={s.btnGrid}>
              <CrawlButton label="CRAWL LEAD" color="var(--accent)" status={leadStatus} busy={leadBusy} disabled={!tabId || !isLinkedInPage || companyBusy} tick={tick} onClick={handleCrawlLead} />
              <CrawlButton label="CRAWL COMPANY" color="var(--accent2)" status={companyStatus} busy={companyBusy} disabled={!tabId || !isLinkedInPage || leadBusy} tick={tick} onClick={handleCrawlCompany} />
            </div>
            {(leadBusy || leadStatus === 'done' || leadStatus === 'error') && (
              <ProgressPanel status={leadStatus} progress={leadProgress} label="LEAD" color="var(--accent)"
                onDownload={leadCsv ? () => chrome.runtime.sendMessage({ type: 'DOWNLOAD_CSV', content: leadCsv.csv, filename: leadCsv.filename }) : undefined} />
            )}
            {(companyBusy || companyStatus === 'done' || companyStatus === 'error') && (
              <ProgressPanel status={companyStatus} progress={companyProgress} label="COMPANY" color="var(--accent2)"
                onDownload={companyCsv ? () => chrome.runtime.sendMessage({ type: 'DOWNLOAD_CSV', content: companyCsv.csv, filename: companyCsv.filename }) : undefined} />
            )}
          </div>
        )}

        {/* ── WEBSITE tab ── */}
        {activeTab === 'website' && (
          <div style={s.tabPane}>
            <div style={s.fieldGroup}>
              <span style={s.label}>WEBSITE URL</span>
              <input style={s.input} placeholder="https://example.com" value={websiteUrl}
                onChange={e => setWebsiteUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !websiteBusy && handleCrawlWebsite()} />
            </div>
            <CrawlButton label="CRAWL WEBSITE" color="var(--accent3)" status={websiteStatus} busy={websiteBusy} disabled={!websiteUrl.trim()} tick={tick} onClick={handleCrawlWebsite} fullWidth />
            {websiteStatus !== 'idle' && (
              <WebsiteProgressPanel status={websiteStatus} result={websiteResult} />
            )}
          </div>
        )}

        {/* ── SHEET tab ── */}
        {activeTab === 'sheet' && (
          <div style={s.tabPane}>
            {/* mode toggle */}
            <div style={s.segmented}>
              <button style={{ ...s.segBtn, ...(sheetMode === 'enrich' ? s.segBtnActive : {}) }} onClick={() => setSheetMode('enrich')}>Company</button>
              <button style={{ ...s.segBtn, ...(sheetMode === 'linkedin' ? s.segBtnActive : {}) }} onClick={() => setSheetMode('linkedin')}>LinkedIn Posts</button>
              <button style={{ ...s.segBtn, ...(sheetMode === 'genmsg' ? s.segBtnActive : {}) }} onClick={() => setSheetMode('genmsg')}>Gen Msg</button>
              <button style={{ ...s.segBtn, ...(sheetMode === 'auto' ? s.segBtnActive : {}) }} onClick={() => setSheetMode('auto')}>Auto</button>
            </div>

            {/* sheet URL paste */}
            <div style={s.fieldGroup}>
              <span style={s.label}>GOOGLE SHEET URL</span>
              <input style={{ ...s.input, borderColor: sheetId ? 'var(--accent3)' : undefined }}
                placeholder="Paste Sheet URL…"
                value={sheetPasteUrl}
                onChange={e => handleSheetUrlPaste(e.target.value)} />
              {sheetId && (
                <div style={s.parsedInfo}>
                  <span style={{ color: 'var(--accent3)' }}>ID </span>{sheetId.slice(0, 20)}…
                  {sheetGid && <><span style={{ color: 'var(--accent3)', marginLeft: 8 }}>GID </span>{sheetGid}</>}
                </div>
              )}
            </div>

            {/* options */}
            <div style={s.fieldGroup}>
              <span style={s.label}>LIMIT</span>
              <input style={s.input} placeholder="15" value={rowLimit} onChange={e => setRowLimit(e.target.value)} />
            </div>

            {sheetMode !== 'auto' && (
              <>
                {sheetMode === 'genmsg' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <label style={{ ...s.label, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <input type="checkbox" checked={genMsgRegen} onChange={e => setGenMsgRegen(e.target.checked)} />
                      Re-generate existing
                    </label>
                  </div>
                )}
                <CrawlButton
                  label={sheetMode === 'enrich' ? 'START COMPANY' : sheetMode === 'genmsg' ? 'GEN MESSAGES' : 'CRAWL POSTS'}
                  color="var(--accent3)" status={sheetStatus} busy={sheetBusy}
                  disabled={!sheetId.trim()} tick={tick} onClick={handleStartSheet} fullWidth
                />
              </>
            )}

            {sheetMode === 'auto' && (
              <>
                {/* sub-toggle */}
                <div style={{ ...s.segmented, marginBottom: 6 }}>
                  <button style={{ ...s.segBtn, ...(autoAction === 'connect_v2' ? s.segBtnActive : {}) }} onClick={() => setAutoAction('connect_v2')}>Connect+Msg</button>
                  <button style={{ ...s.segBtn, ...(autoAction === 'message'    ? s.segBtnActive : {}) }} onClick={() => setAutoAction('message')}>Message</button>
                </div>

                {autoAction === 'connect_v2' && (
                  <div style={s.fieldGroup}>
                    <span style={s.label}>MESSAGE COLUMN</span>
                    <input
                      style={s.input}
                      placeholder="message"
                      value={colMessage}
                      onChange={e => setColMessage(e.target.value)}
                    />
                  </div>
                )}

                {autoAction === 'message' && (
                  <div style={s.fieldGroup}>
                    <span style={s.label}>MESSAGE TEMPLATE</span>
                    <textarea
                      style={{ ...s.input, height: 64, resize: 'vertical' as const, fontFamily: 'inherit' }}
                      placeholder={'Hi {{firstName}}, ...'}
                      value={messageTemplate}
                      onChange={e => setMessageTemplate(e.target.value)}
                    />
                  </div>
                )}

                <CrawlButton
                  label={autoAction === 'connect_v2' ? 'AUTO CONNECT V2' : 'AUTO MESSAGE'}
                  color="var(--accent)" status={autoStatus} busy={autoBusy}
                  disabled={!sheetId.trim()} tick={tick} onClick={handleAutoAction} fullWidth
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* Terminal */}
      {visibleLogs.length > 0 && (
        <div style={s.terminal}>
          <div style={s.termHead}>
            <div style={s.termDots}>
              <span style={{ ...s.dot, background: '#ff5f57' }} />
              <span style={{ ...s.dot, background: '#febc2e' }} />
              <span style={{ ...s.dot, background: '#28c840' }} />
            </div>
            <span style={s.termTitle}>terminal · {activeTab}</span>
            <button style={s.chevronBtn} onClick={() => setTermOpen(o => !o)}>
              <span className={termOpen ? 'chevron chevron-up' : 'chevron chevron-down'} />
            </button>
          </div>
          {termOpen && (
            <div ref={termBodyRef} className="term-body" style={s.termBody}>
              {visibleLogs.map((e, i) => <TermLine key={i} entry={e} />)}
              {anyActive && <div style={{ padding: '1px 10px' }}><span className="term-cursor" /></div>}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <footer style={s.footer}>
        <span>v{manifest.version}</span>
        <span style={{ color: anyActive ? 'var(--warn)' : 'var(--dim)' }}>{anyActive ? '● running' : 'MV3 · TS · React'}</span>
      </footer>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DownloadIcon({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M6.5 1.5v6M4 5.5l2.5 2.5L9 5.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M2 10h9" stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function TermLine({ entry }: { entry: LogEntry }) {
  const time = new Date(entry.ts).toTimeString().slice(3, 8)
  const levelColor = entry.level === 'error' ? 'var(--danger)' : entry.level === 'warn' ? 'var(--warn)' : 'var(--text)'
  const src =
    entry.source === 'lead'    ? { text: 'LD', color: 'var(--accent)' } :
    entry.source === 'company' ? { text: 'CO', color: 'var(--accent2)' } :
    entry.source === 'website' ? { text: 'WB', color: 'var(--accent3)' } :
    entry.source === 'sheet'   ? { text: 'SH', color: 'var(--accent3)' } :
                                 { text: '--', color: 'var(--dim)' }
  const pfxColor = entry.level === 'error' ? 'var(--danger)' : entry.level === 'warn' ? 'var(--warn)' : 'var(--dim)'
  return (
    <div style={s.termLine}>
      <span style={{ color: 'var(--dim)', flexShrink: 0, userSelect: 'none' as const }}>{'>'}</span>
      <span style={{ color: pfxColor, flexShrink: 0 }}>{time}</span>
      <span style={{ color: src.color, flexShrink: 0, fontWeight: 700 }}>{src.text}</span>
      <span style={{ color: levelColor, overflow: 'hidden', wordBreak: 'break-all' as const, whiteSpace: 'pre-wrap' as const }}>{entry.text}</span>
    </div>
  )
}

function CrawlButton({ label, color, status, busy, disabled, tick, onClick, fullWidth }: {
  label: string; color: string; status: BtnStatus
  busy: boolean; disabled: boolean; tick: boolean; onClick: () => void; fullWidth?: boolean
}) {
  return (
    <button style={{
      ...s.btn,
      borderColor: status === 'error' ? 'var(--danger)' : color,
      color: status === 'error' ? 'var(--danger)' : color,
      cursor: busy || disabled ? (busy ? 'wait' : 'not-allowed') : 'pointer',
      opacity: disabled && !busy ? 0.45 : 1,
      background: busy ? 'transparent' : `linear-gradient(135deg, ${color}18, ${color}08)`,
      boxShadow: status === 'done' ? `0 0 18px ${color}28, inset 0 0 18px ${color}08` : busy ? `0 0 16px var(--warn)28` : 'none',
      ...(fullWidth ? { width: '100%' } : {}),
    }} onClick={onClick} disabled={busy || disabled}>
      <span style={s.btnPfx}>{tick && busy ? '>' : ' '}</span>
      {busy ? label.replace(/^(CRAWL|START)/, w => w === 'CRAWL' ? 'CRAWLING' : 'RUNNING') : status === 'done' ? label + ' ✓' : label}
    </button>
  )
}

function ProgressPanel({ status, progress, label, color, onDownload }: {
  status: BtnStatus; progress: ProgressState; label: string; color: string; onDownload?: () => void
}) {
  const { phase, fetched, total, current, error } = progress
  const pct = status === 'done' ? 100 : status === 'error' ? 0 :
    phase === 'fetch'  && total > 0 ? Math.round((fetched  / total) * 50) :
    phase === 'enrich' && total > 0 ? Math.round(50 + (current / total) * 50) : 0
  const phaseText = phase === 'fetch' ? `fetching ${fetched}/${total}` : phase === 'enrich' ? `enriching ${current}/${total}` : ''
  return (
    <div style={s.progressPanel}>
      <div style={s.progressHead}>
        <span style={{ color: status === 'error' ? 'var(--danger)' : color, fontWeight: 700 }}>{label}</span>
        {status === 'error' && <span style={{ color: 'var(--danger)', fontSize: '9px' }}>✗ {error}</span>}
        {(status === 'fetching' || status === 'enriching') && <span style={{ color: 'var(--text-soft)', fontSize: '9px' }}>{phaseText}</span>}
        {status === 'done' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color, fontSize: '12px', fontWeight: 700 }}>{total}</span>
            <span style={{ color: 'var(--text)', fontSize: '10px' }}>exported</span>
            {onDownload && <button onClick={onDownload} style={s.dlBtn}><DownloadIcon color={color} /></button>}
          </span>
        )}
      </div>
      <div style={s.barTrack}>
        <div style={{ ...s.barFill, width: pct + '%', background: status === 'error' ? 'var(--danger)' : color }} />
      </div>
    </div>
  )
}

function buildWebsiteCsv(res: CrawlUrlResult): string {
  const fields = ['url', 'linh_vuc', 'tuyen_dung', 'blog', 'du_an_gan_nhat', 'doi_tac'] as const
  const header = fields.join(',')
  const row = fields.map(f => '"' + String((res as Record<string, unknown>)[f] ?? '').replace(/"/g, '""') + '"').join(',')
  return '﻿' + header + '\n' + row
}

function WebsiteProgressPanel({ status, result }: { status: BtnStatus; result: CrawlUrlResult | null }) {
  const [animPct, setAnimPct] = useState(0)

  useEffect(() => {
    if (status !== 'fetching') { if (status !== 'done') setAnimPct(0); return }
    setAnimPct(5)
    const start = Date.now()
    const id = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000
      setAnimPct(Math.min(88, Math.round(5 + (elapsed / 50) * 83)))
    }, 800)
    return () => clearInterval(id)
  }, [status])

  const pct   = status === 'done' ? 100 : status === 'error' ? 0 : animPct
  const color = status === 'error' ? 'var(--danger)' : 'var(--accent3)'
  const phase = animPct < 55 ? 'crawling website…' : 'AI extracting…'

  const handleDownload = () => {
    if (!result) return
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_CSV',
      content: buildWebsiteCsv(result),
      filename: 'website_crawl_' + Date.now() + '.csv',
    })
  }

  return (
    <div style={s.progressPanel}>
      <div style={s.progressHead}>
        <span style={{ color, fontWeight: 700 }}>WEBSITE</span>
        {status === 'fetching' && <span style={{ color: 'var(--text-soft)', fontSize: '9px' }}>{phase}</span>}
        {status === 'error'    && <span style={{ color: 'var(--danger)',    fontSize: '9px' }}>✗ crawl failed</span>}
        {status === 'done'     && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'var(--text-soft)', fontSize: '9px' }}>done</span>
            {result && <button onClick={handleDownload} style={s.dlBtn}><DownloadIcon color={color} /></button>}
          </span>
        )}
      </div>
      <div style={s.barTrack}>
        <div style={{ ...s.barFill, width: pct + '%', background: color }} />
      </div>
    </div>
  )
}

function StatusDot({ active, error, done }: { active: boolean; error: boolean; done: boolean }) {
  return (
    <div style={{
      width: '8px', height: '8px', borderRadius: '50%',
      background: error ? 'var(--danger)' : active ? 'var(--warn)' : done ? 'var(--accent)' : 'var(--dim)',
      boxShadow: active ? '0 0 8px var(--warn)' : done ? '0 0 8px var(--accent)' : 'none',
      transition: 'all .3s ease',
    }} />
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = {
  shell:        { display: 'flex', flexDirection: 'column' as const, height: '100vh', background: 'var(--bg)', overflow: 'hidden' },
  header:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 10px', borderBottom: '1px solid var(--border)' },
  headerLeft:   { display: 'flex', alignItems: 'center', gap: '10px' },
  logo:         { fontFamily: 'var(--font-head)', fontWeight: 800, fontSize: '20px', color: 'var(--accent)', letterSpacing: '-1px', lineHeight: 1, textShadow: '0 0 16px rgba(59,240,160,.5)' },
  title:        { fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: '13px', color: 'var(--text)', letterSpacing: '2px' },
  subtitle:     { fontSize: '9px', color: 'var(--text-soft)', letterSpacing: '1px', marginTop: '1px' },
  tabBar:       { display: 'flex', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' },
  tabBtn:       { flex: 1, padding: '9px 4px', border: 'none', borderBottom: '2px solid transparent', background: 'transparent', color: 'var(--dim)', fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '1.5px', cursor: 'pointer', transition: 'all .15s' },
  tabBtnActive: { color: 'var(--accent3)', borderBottomColor: 'var(--accent3)' },
  tabContent:   { flex: 1, overflowY: 'auto' as const, minHeight: 0 },
  tabPane:      { display: 'flex', flexDirection: 'column' as const, gap: '10px', padding: '14px 16px' },
  targetRow:    { display: 'flex', alignItems: 'center', gap: '8px' },
  label:        { fontSize: '9px', color: 'var(--text-soft)', letterSpacing: '1.5px', flexShrink: 0 },
  urlText:      { color: 'var(--accent2)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: '260px' },
  btnGrid:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' },
  btn:          { padding: '11px 8px', border: '1.5px solid', borderRadius: '2px', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '11px', letterSpacing: '1.5px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', transition: 'all .2s ease', outline: 'none' },
  btnPfx:       { fontSize: '13px', minWidth: '10px' },
  fieldGroup:   { display: 'flex', flexDirection: 'column' as const, gap: '5px' },
  input:        { width: '100%', padding: '7px 10px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '2px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: '10px', outline: 'none', boxSizing: 'border-box' as const },
  parsedInfo:   { fontSize: '9px', color: 'var(--dim)', fontFamily: 'var(--font-mono)', padding: '1px 4px', lineHeight: 1.8 },
  segmented:    { display: 'flex', gap: '0', border: '1px solid var(--border)', borderRadius: '2px', overflow: 'hidden' },
  segBtn:       { flex: 1, padding: '7px', border: 'none', background: 'transparent', color: 'var(--dim)', fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '1px', cursor: 'pointer', transition: 'all .15s' },
  segBtnActive: { background: 'var(--accent3)20', color: 'var(--accent3)' },
  progressPanel:{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '2px', overflow: 'hidden' },
  progressHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid var(--border)', fontSize: '9px', letterSpacing: '1px' },
  barTrack:     { height: '3px', background: 'var(--border)' },
  barFill:      { height: '100%', transition: 'width .4s ease' },
  dlBtn:        { background: 'none', border: 'none', padding: '2px 3px', cursor: 'pointer', display: 'flex', alignItems: 'center', borderRadius: '3px', opacity: 0.85 },
  terminal:     { borderTop: '1px solid var(--border)', background: '#060a0f' },
  termHead:     { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderBottom: '1px solid #1e2736', background: '#0d1117' },
  termDots:     { display: 'flex', gap: '5px', flexShrink: 0 },
  dot:          { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block' },
  termTitle:    { flex: 1, fontSize: '9px', color: '#4a5568', letterSpacing: '2px', textAlign: 'center' as const },
  chevronBtn:   { background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '2px', flexShrink: 0, lineHeight: 1 },
  termBody:     { maxHeight: '260px', overflowY: 'auto' as const, padding: '6px 0 4px' },
  termLine:     { display: 'grid', gridTemplateColumns: '10px 34px 20px 1fr', gap: '6px', padding: '1px 10px', fontSize: '10px', fontFamily: 'var(--font-mono)', lineHeight: '1.7', alignItems: 'start' },
  footer:       { padding: '7px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: 'var(--text-soft)', letterSpacing: '1px' },
}
