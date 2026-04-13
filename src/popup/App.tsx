// src/popup/App.tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import type { CrawlProgress, CrawlResult, CompanyCrawlProgress, CompanyCrawlResult, LogEntry, CrawlCSVReady } from '../lib/types'

type BtnStatus = 'idle' | 'fetching' | 'enriching' | 'done' | 'error'

interface ProgressState {
  phase: 'fetch' | 'enrich' | 'done' | 'error'
  fetched: number
  total: number
  current: number
  error?: string
}

const DEFAULT_PROGRESS: ProgressState = { phase: 'fetch', fetched: 0, total: 0, current: 0 }
const MAX_LOGS = 200

type IncomingMsg = CrawlProgress | CrawlResult | CompanyCrawlProgress | CompanyCrawlResult | LogEntry | CrawlCSVReady

export default function App() {
  const [tabUrl, setTabUrl] = useState<string>('—')
  const [tabId,  setTabId]  = useState<number | null>(null)
  const [tick,   setTick]   = useState(false)

  const [leadStatus,    setLeadStatus]    = useState<BtnStatus>('idle')
  const [leadProgress,  setLeadProgress]  = useState<ProgressState>(DEFAULT_PROGRESS)

  const [companyStatus,   setCompanyStatus]   = useState<BtnStatus>('idle')
  const [companyProgress, setCompanyProgress] = useState<ProgressState>(DEFAULT_PROGRESS)

  const [logs, setLogs]           = useState<LogEntry[]>([])
  const [termOpen, setTermOpen]   = useState(true)
  const [leadCsv,    setLeadCsv]    = useState<{ csv: string; filename: string } | null>(null)
  const [companyCsv, setCompanyCsv] = useState<{ csv: string; filename: string } | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  const pushLog = useCallback((entry: Omit<LogEntry, 'type'>) => {
    setLogs(prev => {
      const next = [...prev, { ...entry, type: 'LOG_ENTRY' as const }]
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
    })
  }, [])

  // blink cursor
  useEffect(() => {
    const id = setInterval(() => setTick(t => !t), 530)
    return () => clearInterval(id)
  }, [])

  // get active tab
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0]
      if (tab) { setTabUrl(tab.url ?? '—'); setTabId(tab.id ?? null) }
    })
  }, [])

  // auto-scroll terminal to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // listen for progress + log messages from content script
  useEffect(() => {
    const handler = (msg: IncomingMsg) => {
      if (msg.type === 'LOG_ENTRY') {
        const e = msg as LogEntry
        setLogs(prev => {
          const next = [...prev, e]
          return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
        })
        return
      }

      if (msg.type === 'CRAWL_LEAD_PROGRESS') {
        const p = msg as CrawlProgress
        if (p.phase === 'fetch') {
          setLeadStatus('fetching')
          setLeadProgress(prev => ({ ...prev, phase: 'fetch', fetched: p.fetched ?? prev.fetched, total: p.total ?? prev.total }))
          if (p.fetched === 0 || p.fetched === p.total)
            pushLog({ level: 'info', source: 'lead', text: `fetch ${p.fetched}/${p.total}`, ts: Date.now() })
        } else if (p.phase === 'enrich') {
          setLeadStatus('enriching')
          setLeadProgress(prev => ({ ...prev, phase: 'enrich', current: p.current ?? prev.current, total: p.total ?? prev.total }))
          if (p.current === 1 || p.current === p.total)
            pushLog({ level: 'info', source: 'lead', text: `enrich ${p.current}/${p.total}`, ts: Date.now() })
        } else if (p.phase === 'done') {
          setLeadStatus('done')
          setLeadProgress(prev => ({ ...prev, phase: 'done', total: p.total ?? prev.total }))
          pushLog({ level: 'info', source: 'lead', text: `✓ done — ${p.total} leads exported`, ts: Date.now() })
        }
      }

      if (msg.type === 'CRAWL_LEAD_RESULT') {
        const r = msg as CrawlResult
        if (!r.ok) {
          setLeadStatus('error')
          setLeadProgress(prev => ({ ...prev, phase: 'error', error: r.error }))
          pushLog({ level: 'error', source: 'lead', text: `✗ ${r.error ?? 'unknown error'}`, ts: Date.now() })
        }
      }

      if (msg.type === 'CRAWL_COMPANY_PROGRESS') {
        const p = msg as CompanyCrawlProgress
        if (p.phase === 'fetch') {
          setCompanyStatus('fetching')
          setCompanyProgress(prev => ({ ...prev, phase: 'fetch', fetched: p.fetched ?? prev.fetched, total: p.total ?? prev.total }))
          if (p.fetched === 0 || p.fetched === p.total)
            pushLog({ level: 'info', source: 'company', text: `fetch ${p.fetched}/${p.total}`, ts: Date.now() })
        } else if (p.phase === 'enrich') {
          setCompanyStatus('enriching')
          setCompanyProgress(prev => ({ ...prev, phase: 'enrich', current: p.current ?? prev.current, total: p.total ?? prev.total }))
          if (p.current === 1 || p.current === p.total)
            pushLog({ level: 'info', source: 'company', text: `enrich ${p.current}/${p.total}`, ts: Date.now() })
        } else if (p.phase === 'done') {
          setCompanyStatus('done')
          setCompanyProgress(prev => ({ ...prev, phase: 'done', total: p.total ?? prev.total }))
          pushLog({ level: 'info', source: 'company', text: `✓ done — ${p.total} companies exported`, ts: Date.now() })
        }
      }

      if (msg.type === 'CRAWL_LEAD_CSV') {
        const r = msg as CrawlCSVReady
        setLeadCsv({ csv: r.csv, filename: r.filename })
      }

      if (msg.type === 'CRAWL_COMPANY_CSV') {
        const r = msg as CrawlCSVReady
        setCompanyCsv({ csv: r.csv, filename: r.filename })
      }

      if (msg.type === 'CRAWL_COMPANY_RESULT') {
        const r = msg as CompanyCrawlResult
        if (!r.ok) {
          setCompanyStatus('error')
          setCompanyProgress(prev => ({ ...prev, phase: 'error', error: r.error }))
          pushLog({ level: 'error', source: 'company', text: `✗ ${r.error ?? 'unknown error'}`, ts: Date.now() })
        }
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [pushLog])

  // Auto-inject content script then send message
  const sendToTab = useCallback(async (message: object) => {
    if (!tabId) return
    return new Promise<void>((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, () => {
        if (chrome.runtime.lastError) {
          chrome.scripting.executeScript(
            { target: { tabId }, files: ['content/content.js'] },
            () => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message))
                return
              }
              chrome.tabs.sendMessage(tabId, message, () => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
                else resolve()
              })
            }
          )
        } else {
          resolve()
        }
      })
    })
  }, [tabId])

  const handleCrawlLead = useCallback(() => {
    if (!tabId) return
    setLeadStatus('fetching')
    setLeadProgress(DEFAULT_PROGRESS)
    setLeadCsv(null)
    pushLog({ level: 'info', source: 'lead', text: '▶ START CRAWL LEAD', ts: Date.now() })
    sendToTab({ type: 'START_CRAWL_LEAD' }).catch(err => {
      setLeadStatus('error')
      setLeadProgress(prev => ({ ...prev, phase: 'error', error: String(err.message) }))
      pushLog({ level: 'error', source: 'lead', text: `inject failed: ${err.message}`, ts: Date.now() })
    })
  }, [tabId, sendToTab, pushLog])

  const handleCrawlCompany = useCallback(() => {
    if (!tabId) return
    setCompanyStatus('fetching')
    setCompanyProgress(DEFAULT_PROGRESS)
    setCompanyCsv(null)
    pushLog({ level: 'info', source: 'company', text: '▶ START CRAWL COMPANY', ts: Date.now() })
    sendToTab({ type: 'START_CRAWL_COMPANY' }).catch(err => {
      setCompanyStatus('error')
      setCompanyProgress(prev => ({ ...prev, phase: 'error', error: String(err.message) }))
      pushLog({ level: 'error', source: 'company', text: `inject failed: ${err.message}`, ts: Date.now() })
    })
  }, [tabId, sendToTab, pushLog])

  const hostname = (() => { try { return new URL(tabUrl).hostname } catch { return tabUrl } })()

  const leadBusy    = leadStatus === 'fetching' || leadStatus === 'enriching'
  const companyBusy = companyStatus === 'fetching' || companyStatus === 'enriching'
  const anyActive   = leadBusy || companyBusy

  return (
    <div style={s.shell}>

      {/* header */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.logo}>CL</span>
          <div>
            <div style={s.title}>CRAWL LINKED</div>
            <div style={s.subtitle}>sales navigator extractor</div>
          </div>
        </div>
        <StatusDot lead={leadStatus} company={companyStatus} />
      </header>

      {/* target */}
      <div style={s.target}>
        <span style={s.label}>TARGET</span>
        <span style={s.url} title={tabUrl}>{hostname}</span>
      </div>

      {/* buttons */}
      <div style={s.btnGrid}>
        <CrawlButton
          label="CRAWL LEAD"
          color="var(--accent)"
          status={leadStatus}
          busy={leadBusy}
          disabled={!tabId || companyBusy}
          tick={tick}
          onClick={handleCrawlLead}
        />
        <CrawlButton
          label="CRAWL COMPANY"
          color="var(--accent2)"
          status={companyStatus}
          busy={companyBusy}
          disabled={!tabId || leadBusy}
          tick={tick}
          onClick={handleCrawlCompany}
        />
      </div>

      {/* scrollable content area — progress + terminal, never grows the popup */}
      <div style={s.scroll}>

      {/* progress bars */}
      {(leadBusy || leadStatus === 'done' || leadStatus === 'error') && (
        <ProgressPanel
          status={leadStatus} progress={leadProgress} label="LEAD" color="var(--accent)"
          onDownload={leadCsv ? () => chrome.runtime.sendMessage({ type: 'DOWNLOAD_CSV', content: leadCsv.csv, filename: leadCsv.filename }) : undefined}
        />
      )}
      {(companyBusy || companyStatus === 'done' || companyStatus === 'error') && (
        <ProgressPanel
          status={companyStatus} progress={companyProgress} label="COMPANY" color="var(--accent2)"
          onDownload={companyCsv ? () => chrome.runtime.sendMessage({ type: 'DOWNLOAD_CSV', content: companyCsv.csv, filename: companyCsv.filename }) : undefined}
        />
      )}

      {/* terminal log */}
      {logs.length > 0 && (
        <div style={s.terminal}>
          {/* title bar */}
          <div style={s.termHead}>
            <div style={s.termDots}>
              <span style={{ ...s.dot, background: '#ff5f57' }} />
              <span style={{ ...s.dot, background: '#febc2e' }} />
              <span style={{ ...s.dot, background: '#28c840' }} />
            </div>
            <span style={s.termTitle}>terminal</span>
            <button
              style={s.chevronBtn}
              onClick={() => setTermOpen(o => !o)}
              title={termOpen ? 'collapse' : 'expand'}
            >
              <span className={termOpen ? 'chevron chevron-up' : 'chevron chevron-down'} />
            </button>
          </div>
          {/* body */}
          {termOpen && (
            <div className="term-body" style={s.termBody}>
              {logs.map((entry, i) => (
                <TermLine key={i} entry={entry} />
              ))}
              {anyActive && <div style={{ padding: '1px 10px' }}><span className="term-cursor" /></div>}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}

      </div>{/* end scroll */}

      {/* footer */}
      <footer style={s.footer}>
        <span>v1.0.0</span>
        <span style={{ color: anyActive ? 'var(--warn)' : 'var(--dim)' }}>
          {anyActive ? '● running' : 'MV3 · TS · React'}
        </span>
      </footer>
    </div>
  )
}

// ── sub-components ─────────────────────────────────────────────────────────

function DownloadIcon({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6.5 1.5v6M4 5.5l2.5 2.5L9 5.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M2 10h9" stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function TermLine({ entry }: { entry: LogEntry }) {
  const time = new Date(entry.ts).toTimeString().slice(3, 8) // MM:SS only
  const levelColor =
    entry.level === 'error' ? 'var(--danger)' :
    entry.level === 'warn'  ? 'var(--warn)'   : 'var(--text)'
  const src =
    entry.source === 'lead'    ? { text: 'LD', color: 'var(--accent)' } :
    entry.source === 'company' ? { text: 'CO', color: 'var(--accent2)' } :
                                 { text: '--', color: 'var(--dim)' }
  const pfxColor =
    entry.level === 'error' ? 'var(--danger)' :
    entry.level === 'warn'  ? 'var(--warn)'   : 'var(--dim)'
  return (
    <div style={s.termLine}>
      <span style={{ color: 'var(--dim)', flexShrink: 0, userSelect: 'none' as const }}>{'>'}</span>
      <span style={{ color: pfxColor, flexShrink: 0 }}>{time}</span>
      <span style={{ color: src.color, flexShrink: 0, fontWeight: 700 }}>{src.text}</span>
      <span style={{ color: levelColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{entry.text}</span>
    </div>
  )
}

function CrawlButton({
  label, color, status, busy, disabled, tick, onClick,
}: {
  label: string; color: string; status: BtnStatus
  busy: boolean; disabled: boolean; tick: boolean; onClick: () => void
}) {
  return (
    <button
      style={{
        ...s.btn,
        borderColor: status === 'error' ? 'var(--danger)' : color,
        color: status === 'error' ? 'var(--danger)' : color,
        cursor: busy || disabled ? (busy ? 'wait' : 'not-allowed') : 'pointer',
        opacity: disabled && !busy ? 0.45 : 1,
        background: busy ? 'transparent' : `linear-gradient(135deg, ${color}18, ${color}08)`,
        boxShadow: status === 'done'
          ? `0 0 18px ${color}28, inset 0 0 18px ${color}08`
          : busy ? `0 0 16px var(--warn)28` : 'none',
      }}
      onClick={onClick}
      disabled={busy || disabled}
    >
      <span style={s.btnPfx}>{tick && busy ? '>' : ' '}</span>
      {busy ? label.replace('CRAWL', 'CRAWLING') : status === 'done' ? label + ' ✓' : label}
    </button>
  )
}

function ProgressPanel({
  status, progress, label, color, onDownload,
}: {
  status: BtnStatus; progress: ProgressState; label: string; color: string
  onDownload?: () => void
}) {
  const { phase, fetched, total, current, error } = progress

  // Continuous 0→100%: fetch = first 50%, enrich = last 50%
  const pct =
    status === 'done'  ? 100 :
    status === 'error' ? 0   :
    phase === 'fetch'  && total > 0 ? Math.round((fetched  / total) * 50) :
    phase === 'enrich' && total > 0 ? Math.round(50 + (current / total) * 50) : 0

  const phaseText =
    phase === 'fetch'  ? `fetching ${fetched}/${total}` :
    phase === 'enrich' ? `enriching ${current}/${total}` : ''

  return (
    <div style={s.progressPanel}>
      <div style={s.progressHead}>
        <span style={{ color: status === 'error' ? 'var(--danger)' : color, fontWeight: 700 }}>
          {label}
        </span>

        {/* right side: busy = phase text dim | done = count bright | error = msg red */}
        {status === 'error' && (
          <span style={{ color: 'var(--danger)', fontSize: '9px' }}>✗ {error}</span>
        )}
        {(status === 'fetching' || status === 'enriching') && (
          <span style={{ color: 'var(--text-soft)', fontSize: '9px' }}>{phaseText}</span>
        )}
        {status === 'done' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ color: color, fontSize: '12px', fontWeight: 700 }}>{total}</span>
              <span style={{ color: 'var(--text)', fontSize: '10px' }}>exported</span>
            </span>
            {onDownload && (
              <button onClick={onDownload} style={s.dlBtn} title="Download CSV">
                <DownloadIcon color={color} />
              </button>
            )}
          </span>
        )}
      </div>
      <div style={s.barTrack}>
        <div style={{
          ...s.barFill,
          width: pct + '%',
          background: status === 'error' ? 'var(--danger)' : color,
        }} />
      </div>
    </div>
  )
}

function StatusDot({ lead, company }: { lead: BtnStatus; company: BtnStatus }) {
  const active = lead === 'fetching' || lead === 'enriching' || company === 'fetching' || company === 'enriching'
  const error  = lead === 'error' || company === 'error'
  const done   = !active && (lead === 'done' || company === 'done')
  return (
    <div style={{
      width: '8px', height: '8px', borderRadius: '50%',
      background: error ? 'var(--danger)' : active ? 'var(--warn)' : done ? 'var(--accent)' : 'var(--dim)',
      boxShadow:  active ? '0 0 8px var(--warn)' : done ? '0 0 8px var(--accent)' : 'none',
      transition: 'all .3s ease',
    }} />
  )
}

// ── styles ─────────────────────────────────────────────────────────────────

const s = {
  shell:        { display: 'flex', flexDirection: 'column' as const, height: '520px', background: 'var(--bg)', overflow: 'hidden' },
  scroll:       { flex: 1, overflowY: 'auto' as const, overflowX: 'hidden' as const, minHeight: 0 },
  header:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' },
  headerLeft:   { display: 'flex', alignItems: 'center', gap: '10px' },
  logo:         { fontFamily: 'var(--font-head)', fontWeight: 800, fontSize: '20px', color: 'var(--accent)', letterSpacing: '-1px', lineHeight: 1, textShadow: '0 0 16px rgba(59,240,160,.5)' },
  title:        { fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: '13px', color: 'var(--text)', letterSpacing: '2px' },
  subtitle:     { fontSize: '9px', color: 'var(--text-soft)', letterSpacing: '1px', marginTop: '1px' },
  target:       { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' },
  label:        { fontSize: '9px', color: 'var(--text-soft)', letterSpacing: '1.5px', flexShrink: 0 },
  url:          { color: 'var(--accent2)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: '260px' },
  btnGrid:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', padding: '16px' },
  btn:          { padding: '13px 8px', border: '1.5px solid', borderRadius: '2px', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '11px', letterSpacing: '1.5px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', transition: 'all .2s ease', outline: 'none' },
  btnPfx:       { fontSize: '13px', minWidth: '10px' },
  progressPanel:{ margin: '0 16px 10px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '2px', overflow: 'hidden' },
  progressHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid var(--border)', fontSize: '9px', letterSpacing: '1px' },
  barTrack:     { height: '3px', background: 'var(--border)' },
  barFill:      { height: '100%', transition: 'width .4s ease' },
  dlBtn:        { background: 'none', border: 'none', padding: '2px 3px', cursor: 'pointer', display: 'flex', alignItems: 'center', borderRadius: '3px', opacity: 0.85 },
  terminal:     { margin: '0 16px 10px', border: '1px solid #1e2736', borderRadius: '4px', overflow: 'hidden', background: '#060a0f', boxShadow: '0 4px 24px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.04)' },
  termHead:     { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderBottom: '1px solid #1e2736', background: '#0d1117' },
  termDots:     { display: 'flex', gap: '5px', flexShrink: 0 },
  dot:          { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block' },
  termTitle:    { flex: 1, fontSize: '9px', color: '#4a5568', letterSpacing: '2px', textAlign: 'center' as const },
  chevronBtn:   { background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '2px', flexShrink: 0, lineHeight: 1 },
  termBody:     { maxHeight: '150px', overflowY: 'auto' as const, padding: '6px 0 4px' },
  termLine:     { display: 'grid', gridTemplateColumns: '10px 34px 20px 1fr', gap: '6px', padding: '1px 10px', fontSize: '10px', fontFamily: 'var(--font-mono)', lineHeight: '1.7', alignItems: 'center' },
  footer:       { marginTop: 'auto', padding: '8px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: 'var(--text-soft)', letterSpacing: '1px' },
}
