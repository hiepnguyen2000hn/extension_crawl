# Crawl Lead Button Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Thêm 2 nút "Crawl Lead" và "Crawl Company" vào popup, trong đó "Crawl Lead" thực thi toàn bộ logic fetch + enrich + export CSV từ LinkedIn Sales Navigator.

**Architecture:** Logic crawl chạy trong content script context (có quyền truy cập `performance`, `document.cookie`, `fetch` với `credentials:include`). Popup gửi message tới content script, content script stream progress ngược lại qua `chrome.runtime.sendMessage`. App.tsx refactor thành 2 button state độc lập.

**Tech Stack:** TypeScript, React 18, Chrome MV3, `chrome.tabs.sendMessage`, `chrome.runtime.onMessage`

---

### Task 1: Tạo types cho LinkedIn API

**Files:**
- Create: `src/lib/types.ts`

**Step 1: Tạo file types**

```typescript
// src/lib/types.ts

export interface Session {
  csrfToken: string
  liIdentity: string
}

export interface LeadPosition {
  title?: string
  companyName?: string
  companyUrn?: string
  current?: boolean
  startedOn?: unknown
  endedOn?: unknown
}

export interface LeadArtifact {
  width: number
  fileIdentifyingUrlPathSegment: string
}

export interface LeadProfilePicture {
  artifacts?: LeadArtifact[]
  rootUrl?: string
}

export interface LinkedInLeadElement {
  firstName?: string
  lastName?: string
  fullName?: string
  geoRegion?: string
  headline?: string
  summary?: string
  entityUrn?: string
  flagshipProfileUrl?: string
  premium?: boolean
  openToOpportunities?: boolean
  profilePictureDisplayImage?: LeadProfilePicture
  currentPositions?: LeadPosition[]
}

export interface MappedLead {
  firstName: string
  lastName: string
  fullName: string
  job_title: string
  location: string
  country: string
  salesNavigatorUrl: string
  linkedUrl: string
  company_name: string
  company_linkedin: string
  premium: string
  openToWork: string
  occupation: string
  profilePicture: string
  entityUrn: string
  importDate: string
}

export interface CrawlProgress {
  type: 'CRAWL_LEAD_PROGRESS'
  phase: 'fetch' | 'enrich' | 'done' | 'error'
  fetched?: number
  total?: number
  current?: number
  message?: string
}

export interface CrawlResult {
  type: 'CRAWL_LEAD_RESULT'
  ok: boolean
  count?: number
  error?: string
}
```

**Step 2: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add TypeScript types for LinkedIn lead crawl"
```

---

### Task 2: Tạo crawlLead.ts — chuyển toàn bộ JS logic sang TS

**Files:**
- Create: `src/lib/crawlLead.ts`

**Step 1: Tạo file với toàn bộ logic (chạy trong content script context)**

```typescript
// src/lib/crawlLead.ts
import type { Session, LinkedInLeadElement, MappedLead, CrawlProgress } from './types'

// ── session ────────────────────────────────────────────────────────────────

export function getSessionFromBrowser(): Session {
  const cookies = Object.fromEntries(
    document.cookie.split('; ').map(c => {
      const [k, ...v] = c.split('=')
      return [k.trim(), v.join('=')]
    })
  )
  const jsessionid = cookies['JSESSIONID']?.replace(/"/g, '')
  if (!jsessionid) throw new Error('Không tìm thấy JSESSIONID')
  return {
    csrfToken:  jsessionid,
    liIdentity: cookies['LI_IDENTITY'] ?? '',
  }
}

// ── headers ────────────────────────────────────────────────────────────────

export function buildHeaders(session: Session): Record<string, string> {
  const h: Record<string, string> = {
    'accept':                      '*/*',
    'csrf-token':                  session.csrfToken,
    'x-li-lang':                   'en_US',
    'x-restli-protocol-version':   '2.0.0',
  }
  if (session.liIdentity) h['x-li-identity'] = session.liIdentity
  return h
}

// ── url detection ──────────────────────────────────────────────────────────

export function findLatestLeadSearchQuery(): string {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const matched = entries
    .filter(e => e.name.includes('salesApiLeadSearch'))
    .sort((a, b) => b.startTime - a.startTime)
  if (!matched.length)
    throw new Error('Không tìm thấy request salesApiLeadSearch — hãy load trang search trước')
  const urlObj    = new URL(matched[0].name)
  const rawSearch = urlObj.search
  const queryMatch = rawSearch.match(/[?&]query=([^&]+)/)
  const query = queryMatch?.[1] ?? ''
  if (!query) throw new Error('Không parse được query từ URL')
  return query
}

// ── decoration ─────────────────────────────────────────────────────────────

const DECORATION =
  '%28entityUrn%2CobjectUrn%2CfirstName%2ClastName%2CfullName'
  + '%2Cheadline%2Cpronoun%2Cdegree%2CprofileUnlockInfo%2Clocation'
  + '%2ClistCount%2Csummary%2CsavedLead%2CdefaultPosition%2CcontactInfo'
  + '%2CcrmStatus%2CpendingInvitation%2Cunlocked%2CflagshipProfileUrl'
  + '%2CfullNamePronunciationAudio%2Cmemorialized'
  + '%2Cpositions*%28companyName%2Ccurrent%2Cnew%2Cdescription'
  + '%2CendedOn%2CposId%2CstartedOn%2Ctitle%2Clocation'
  + '%2CrichMedia*%2CcompanyUrn~fs_salesCompany%28entityUrn%2Cname'
  + '%2CcompanyPictureDisplayImage%29%29%2CcrmManualMatched%29'

function parseEntityUrn(entityUrn: string) {
  const match = entityUrn.match(/\(([^,)]+),([^,)]+),([^,)]*)\)/)
  if (!match) return null
  return { profileId: match[1], authType: match[2], authToken: match[3] }
}

export async function fetchFlagshipUrl(
  entityUrn: string,
  session: Session
): Promise<string> {
  const parsed = parseEntityUrn(entityUrn)
  if (!parsed) return ''
  const { profileId, authType, authToken } = parsed
  const url =
    'https://www.linkedin.com/sales-api/salesApiProfiles/'
    + `(profileId:${profileId},authType:${authType},authToken:${authToken})`
    + `?decoration=${DECORATION}`
  try {
    const res = await fetch(url, {
      headers: buildHeaders(session),
      credentials: 'include',
    })
    if (!res.ok) return ''
    const data = await res.json() as { flagshipProfileUrl?: string }
    return data.flagshipProfileUrl ?? ''
  } catch {
    return ''
  }
}

// ── mapping ────────────────────────────────────────────────────────────────

export function mapLead(el: LinkedInLeadElement): MappedLead {
  const pos        = el.currentPositions?.[0] ?? {}
  const companyId  = pos.companyUrn?.split(':').pop() ?? ''
  const salesNavUrl = el.entityUrn
    ? 'https://www.linkedin.com/sales/lead/' + encodeURIComponent(el.entityUrn)
    : ''
  const artifact =
    el.profilePictureDisplayImage?.artifacts?.find(a => a.width === 200)
    ?? el.profilePictureDisplayImage?.artifacts?.[0]
  const profilePictureUrl = artifact
    ? (el.profilePictureDisplayImage?.rootUrl ?? '') + artifact.fileIdentifyingUrlPathSegment
    : ''
  return {
    firstName:        el.firstName ?? '',
    lastName:         el.lastName ?? '',
    fullName:         el.fullName ?? '',
    job_title:        pos.title ?? '',
    location:         el.geoRegion ?? '',
    country:          el.geoRegion?.includes(',')
                        ? (el.geoRegion.split(',').pop()?.trim() ?? el.geoRegion)
                        : el.geoRegion ?? '',
    salesNavigatorUrl: salesNavUrl,
    linkedUrl:        el.flagshipProfileUrl ?? '',
    company_name:     pos.companyName ?? '',
    company_linkedin: companyId
                        ? 'https://www.linkedin.com/company/' + companyId
                        : '',
    premium:          el.premium ? 'true' : 'false',
    openToWork:       el.openToOpportunities ? 'true' : 'false',
    occupation:       el.summary?.split('\n')[0]?.slice(0, 100) ?? '',
    profilePicture:   profilePictureUrl,
    entityUrn:        el.entityUrn ?? '',
    importDate:       new Date().toISOString().split('T')[0],
  }
}

// ── csv export ─────────────────────────────────────────────────────────────

export function exportCSV(leads: MappedLead[]): void {
  if (!leads.length) return
  const heads = Object.keys(leads[0]) as (keyof MappedLead)[]
  const lines = leads.map(r =>
    heads.map(h => '"' + String(r[h] ?? '').replace(/"/g, '""') + '"').join(',')
  )
  const csv  = '\uFEFF' + heads.join(',') + '\n' + lines.join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const a    = document.createElement('a')
  a.href     = URL.createObjectURL(blob)
  a.download = 'linkedin_leads_' + Date.now() + '.csv'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href) }, 1000)
}

// ── main orchestrator ──────────────────────────────────────────────────────

type ProgressCallback = (p: CrawlProgress) => void

export async function fetchAllLeads(onProgress: ProgressCallback): Promise<MappedLead[]> {
  const session = getSessionFromBrowser()
  const query   = findLatestLeadSearchQuery()

  const COUNT = 25
  let start = 0
  const allResults: LinkedInLeadElement[] = []
  let totalFound = 0

  // Phase 1: fetch pages
  while (true) {
    const url =
      'https://www.linkedin.com/sales-api/salesApiLeadSearch'
      + '?q=searchQuery'
      + '&query=' + query
      + '&start=' + start
      + '&count=' + COUNT
      + '&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14'

    const res = await fetch(url, {
      headers: buildHeaders(session),
      credentials: 'include',
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)

    const data = await res.json() as { paging?: { total: number }; elements?: LinkedInLeadElement[] }
    if (totalFound === 0) totalFound = data.paging?.total ?? 0
    const elements = data.elements ?? []
    allResults.push(...elements)

    onProgress({ type: 'CRAWL_LEAD_PROGRESS', phase: 'fetch', fetched: allResults.length, total: totalFound })

    if (elements.length === 0 || allResults.length >= totalFound) break
    start += COUNT
    await new Promise(r => setTimeout(r, 1000))
  }

  // Phase 2: enrich
  for (let i = 0; i < allResults.length; i++) {
    const el = allResults[i]
    if (el.entityUrn) {
      el.flagshipProfileUrl = await fetchFlagshipUrl(el.entityUrn, session)
    }
    onProgress({ type: 'CRAWL_LEAD_PROGRESS', phase: 'enrich', current: i + 1, total: allResults.length })
    await new Promise(r => setTimeout(r, 600))
  }

  const mapped = allResults.map(mapLead)
  exportCSV(mapped)
  onProgress({ type: 'CRAWL_LEAD_PROGRESS', phase: 'done', total: mapped.length })
  return mapped
}
```

**Step 2: Commit**

```bash
git add src/lib/crawlLead.ts
git commit -m "feat: convert lead crawl JS logic to TypeScript"
```

---

### Task 3: Cập nhật content script — nhận message START_CRAWL_LEAD

**Files:**
- Modify: `src/content/content.ts`

**Step 1: Thay thế toàn bộ nội dung**

```typescript
// src/content/content.ts
import { fetchAllLeads } from '../lib/crawlLead'
import type { CrawlProgress } from '../lib/types'

// ── localStorage reader ────────────────────────────────────────────────────

function readLocalStorage(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key) entries[key] = localStorage.getItem(key) ?? ''
  }
  return entries
}

// ── message handler ────────────────────────────────────────────────────────

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
    // Fire and forget — progress streamed via runtime.sendMessage
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
})

export {}
```

**Step 2: Commit**

```bash
git add src/content/content.ts
git commit -m "feat: content script handles START_CRAWL_LEAD message"
```

---

### Task 4: Refactor App.tsx — 2 button độc lập + progress UI

**Files:**
- Modify: `src/popup/App.tsx`

**Step 1: Thay toàn bộ App.tsx**

Tách state thành `leadStatus` và `companyStatus` riêng. Mỗi button có progress bar riêng.
Button "Crawl Company" chỉ hiển thị — chưa có logic (placeholder `// TODO`).

```typescript
// src/popup/App.tsx
import { useState, useEffect, useCallback } from 'react'
import type { CrawlProgress, CrawlResult } from '../lib/types'

type BtnStatus = 'idle' | 'fetching' | 'enriching' | 'done' | 'error'

interface ProgressState {
  phase: 'fetch' | 'enrich' | 'done' | 'error'
  fetched: number
  total: number
  current: number
  error?: string
}

const DEFAULT_PROGRESS: ProgressState = { phase: 'fetch', fetched: 0, total: 0, current: 0 }

export default function App() {
  const [tabUrl, setTabUrl] = useState<string>('—')
  const [tabId,  setTabId]  = useState<number | null>(null)
  const [tick,   setTick]   = useState(false)

  const [leadStatus,    setLeadStatus]    = useState<BtnStatus>('idle')
  const [leadProgress,  setLeadProgress]  = useState<ProgressState>(DEFAULT_PROGRESS)

  const [companyStatus] = useState<BtnStatus>('idle')

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

  // listen for progress messages from content script
  useEffect(() => {
    const handler = (msg: CrawlProgress | CrawlResult) => {
      if (msg.type === 'CRAWL_LEAD_PROGRESS') {
        const p = msg as CrawlProgress
        if (p.phase === 'fetch') {
          setLeadStatus('fetching')
          setLeadProgress(prev => ({ ...prev, phase: 'fetch', fetched: p.fetched ?? prev.fetched, total: p.total ?? prev.total }))
        } else if (p.phase === 'enrich') {
          setLeadStatus('enriching')
          setLeadProgress(prev => ({ ...prev, phase: 'enrich', current: p.current ?? prev.current, total: p.total ?? prev.total }))
        } else if (p.phase === 'done') {
          setLeadStatus('done')
          setLeadProgress(prev => ({ ...prev, phase: 'done', total: p.total ?? prev.total }))
        }
      }
      if (msg.type === 'CRAWL_LEAD_RESULT') {
        const r = msg as CrawlResult
        if (!r.ok) {
          setLeadStatus('error')
          setLeadProgress(prev => ({ ...prev, phase: 'error', error: r.error }))
        }
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  const handleCrawlLead = useCallback(() => {
    if (!tabId) return
    setLeadStatus('fetching')
    setLeadProgress(DEFAULT_PROGRESS)
    chrome.tabs.sendMessage(tabId, { type: 'START_CRAWL_LEAD' })
  }, [tabId])

  const hostname = (() => { try { return new URL(tabUrl).hostname } catch { return tabUrl } })()

  const leadBusy    = leadStatus === 'fetching' || leadStatus === 'enriching'
  const companyBusy = companyStatus === 'fetching' || companyStatus === 'enriching'

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
          onClick={() => { /* TODO */ }}
        />
      </div>

      {/* lead progress */}
      {(leadBusy || leadStatus === 'done' || leadStatus === 'error') && (
        <ProgressPanel status={leadStatus} progress={leadProgress} label="LEAD" />
      )}

      {/* footer */}
      <footer style={s.footer}>
        <span>v1.0.0</span>
        <span style={{ color: 'var(--dim)' }}>MV3 · TS · React</span>
      </footer>
    </div>
  )
}

// ── sub-components ─────────────────────────────────────────────────────────

function CrawlButton({
  label, color, status, busy, disabled, tick, onClick,
}: {
  label: string; color: string; status: BtnStatus
  busy: boolean; disabled: boolean; tick: boolean; onClick: () => void
}) {
  const borderColor =
    status === 'error' ? 'var(--danger)' :
    status === 'done'  ? color           : color

  return (
    <button
      style={{
        ...s.btn,
        borderColor,
        color: status === 'error' ? 'var(--danger)' : color,
        cursor: busy || disabled ? (busy ? 'wait' : 'not-allowed') : 'pointer',
        opacity: disabled && !busy ? 0.45 : 1,
        background: busy
          ? 'transparent'
          : `linear-gradient(135deg, ${color}18, ${color}08)`,
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
  status, progress, label,
}: {
  status: BtnStatus; progress: ProgressState; label: string
}) {
  const { phase, fetched, total, current, error } = progress
  const pct =
    status === 'done' ? 100 :
    phase === 'fetch' && total > 0 ? Math.round((fetched / total) * 100) :
    phase === 'enrich' && total > 0 ? Math.round((current / total) * 100) : 0

  return (
    <div style={s.progressPanel}>
      <div style={s.progressHead}>
        <span style={{ color: status === 'error' ? 'var(--danger)' : 'var(--accent)' }}>
          {label}
        </span>
        <span style={{ color: 'var(--text-soft)', fontSize: '9px' }}>
          {status === 'error'    ? '✗ ' + error :
           status === 'done'     ? `✓ ${total} leads exported` :
           phase === 'fetch'     ? `fetching ${fetched}/${total}` :
           phase === 'enrich'    ? `enriching ${current}/${total}` : ''}
        </span>
      </div>
      <div style={s.barTrack}>
        <div style={{ ...s.barFill, width: pct + '%', background: status === 'error' ? 'var(--danger)' : 'var(--accent)' }} />
      </div>
    </div>
  )
}

function StatusDot({ lead, company }: { lead: BtnStatus; company: BtnStatus }) {
  const active = lead === 'fetching' || lead === 'enriching'
              || company === 'fetching' || company === 'enriching'
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
  shell:       { display: 'flex', flexDirection: 'column' as const, minHeight: '420px', background: 'var(--bg)' },
  header:      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' },
  headerLeft:  { display: 'flex', alignItems: 'center', gap: '10px' },
  logo:        { fontFamily: 'var(--font-head)', fontWeight: 800, fontSize: '20px', color: 'var(--accent)', letterSpacing: '-1px', lineHeight: 1, textShadow: '0 0 16px rgba(59,240,160,.5)' },
  title:       { fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: '13px', color: 'var(--text)', letterSpacing: '2px' },
  subtitle:    { fontSize: '9px', color: 'var(--text-soft)', letterSpacing: '1px', marginTop: '1px' },
  target:      { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' },
  label:       { fontSize: '9px', color: 'var(--text-soft)', letterSpacing: '1.5px', flexShrink: 0 },
  url:         { color: 'var(--accent2)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: '260px' },
  btnGrid:     { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', padding: '16px' },
  btn:         { padding: '13px 8px', border: '1.5px solid', borderRadius: '2px', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '11px', letterSpacing: '1.5px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', transition: 'all .2s ease', outline: 'none' },
  btnPfx:      { fontSize: '13px', minWidth: '10px' },
  progressPanel: { margin: '0 16px 12px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '2px', overflow: 'hidden' },
  progressHead:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid var(--border)', fontSize: '9px', letterSpacing: '1px' },
  barTrack:    { height: '3px', background: 'var(--border)' },
  barFill:     { height: '100%', transition: 'width .4s ease' },
  footer:      { marginTop: 'auto', padding: '8px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: 'var(--text-soft)', letterSpacing: '1px' },
}
```

**Step 2: Commit**

```bash
git add src/popup/App.tsx
git commit -m "feat: replace single crawl button with Lead + Company buttons"
```

---

### Task 5: Tạo crawlCompany.ts — chuyển JS company logic sang TS

**Files:**
- Create: `src/lib/crawlCompany.ts`
- Modify: `src/lib/types.ts` (append company types)
- Modify: `src/content/content.ts` (add START_CRAWL_COMPANY handler)
- Modify: `src/popup/App.tsx` (wire company button + progress)

**Step 1: Append company types vào src/lib/types.ts**

```typescript
// Append vào cuối src/lib/types.ts

export interface CompanyElement {
  companyName?: string
  entityUrn?: string
  employeeCount?: number
  employeeCountRange?: { start?: number; end?: number }
  industries?: Array<{ localizedName?: string }>
  headquartersLocation?: {
    city?: string
    geographicArea?: string
    country?: string
    postalCode?: string
  }
  website?: string
  description?: string
  companyPictureDisplayImage?: {
    artifacts?: Array<{ width: number; fileIdentifyingUrlPathSegment: string }>
    rootUrl?: string
  }
  _absIndex?: number
}

export interface CompanyDetail {
  companyName?: string
  description?: string
  website?: string
  phone?: string
  foundedOn?: { year?: number }
  employeeCount?: number
  employeeCountRange?: { start?: number; end?: number }
  industries?: Array<{ localizedName?: string }>
  headquartersLocation?: {
    city?: string
    geographicArea?: string
    country?: string
  }
  linkedInUrl?: string
  flagshipCompanyUrl?: string
  revenue?: { amount?: string; currencyCode?: string }
}

export interface MappedCompany {
  company_name: string
  company_linkedin: string
  website: string
  industry: string
  employee_count: string
  employee_range: string
  city: string
  region: string
  country: string
  description: string
  phone: string
  founded_year: string
  revenue: string
  entityUrn: string
  importDate: string
}

export interface CompanyCrawlProgress {
  type: 'CRAWL_COMPANY_PROGRESS'
  phase: 'fetch' | 'enrich' | 'done' | 'error'
  fetched?: number
  total?: number
  current?: number
  message?: string
}

export interface CompanyCrawlResult {
  type: 'CRAWL_COMPANY_RESULT'
  ok: boolean
  count?: number
  error?: string
}
```

**Step 2: Tạo src/lib/crawlCompany.ts**

```typescript
// src/lib/crawlCompany.ts
import { getSessionFromBrowser, buildHeaders } from './crawlLead'
import type {
  Session, CompanyElement, CompanyDetail, MappedCompany, CompanyCrawlProgress,
} from './types'

// ── url detection ──────────────────────────────────────────────────────────

export function findLatestAccountSearchQuery(): string {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const matched = entries
    .filter(e => e.name.includes('salesApiAccountSearch'))
    .sort((a, b) => b.startTime - a.startTime)
  if (!matched.length)
    throw new Error('Không tìm thấy request salesApiAccountSearch — hãy load trang account search trước')
  const urlObj     = new URL(matched[0].name)
  const queryMatch = urlObj.search.match(/[?&]query=([^&]+)/)
  const query = queryMatch?.[1] ?? ''
  if (!query) throw new Error('Không parse được query từ URL')
  return query
}

// ── detail fetch ───────────────────────────────────────────────────────────

export async function getInformationDetail(
  companyId: string,
  session: Session
): Promise<CompanyDetail | null> {
  const url = `https://www.linkedin.com/sales-api/salesApiCompanies/${companyId}`
    + `?decoration=%28entityUrn%2CcompanyName%2Cdescription%2Cwebsite%2Cphone`
    + `%2CfoundedOn%2CemployeeCount%2CemployeeCountRange%2Cindustries`
    + `%2CheadquartersLocation%2CflagshipCompanyUrl%2Crevenue%29`
  try {
    const res = await fetch(url, { headers: buildHeaders(session), credentials: 'include' })
    if (!res.ok) return null
    return await res.json() as CompanyDetail
  } catch {
    return null
  }
}

// ── mappers ────────────────────────────────────────────────────────────────

export function mapCompany(el: CompanyElement): MappedCompany {
  const companyId = el.entityUrn?.split(':').pop() ?? ''
  const logo      = el.companyPictureDisplayImage?.artifacts?.[0]
  void logo // reserved for future use
  return {
    company_name:    el.companyName ?? '',
    company_linkedin: companyId
      ? 'https://www.linkedin.com/company/' + companyId : '',
    website:         el.website ?? '',
    industry:        el.industries?.[0]?.localizedName ?? '',
    employee_count:  String(el.employeeCount ?? ''),
    employee_range:  el.employeeCountRange
      ? `${el.employeeCountRange.start ?? ''}-${el.employeeCountRange.end ?? ''}`
      : '',
    city:            el.headquartersLocation?.city ?? '',
    region:          el.headquartersLocation?.geographicArea ?? '',
    country:         el.headquartersLocation?.country ?? '',
    description:     el.description?.slice(0, 200) ?? '',
    phone:           '',
    founded_year:    '',
    revenue:         '',
    entityUrn:       el.entityUrn ?? '',
    importDate:      new Date().toISOString().split('T')[0],
  }
}

export function mapDetail(detail: CompanyDetail | null): Partial<MappedCompany> {
  if (!detail) return {}
  return {
    website:        detail.website ?? '',
    phone:          detail.phone ?? '',
    founded_year:   String(detail.foundedOn?.year ?? ''),
    description:    detail.description?.slice(0, 200) ?? '',
    employee_count: String(detail.employeeCount ?? ''),
    employee_range: detail.employeeCountRange
      ? `${detail.employeeCountRange.start ?? ''}-${detail.employeeCountRange.end ?? ''}`
      : '',
    city:           detail.headquartersLocation?.city ?? '',
    region:         detail.headquartersLocation?.geographicArea ?? '',
    country:        detail.headquartersLocation?.country ?? '',
    revenue:        detail.revenue
      ? `${detail.revenue.amount ?? ''} ${detail.revenue.currencyCode ?? ''}`.trim()
      : '',
  }
}

// ── csv export ─────────────────────────────────────────────────────────────

function exportCSV(companies: MappedCompany[]): void {
  if (!companies.length) return
  const heads = Object.keys(companies[0]) as (keyof MappedCompany)[]
  const lines = companies.map(r =>
    heads.map(h => '"' + String(r[h] ?? '').replace(/"/g, '""') + '"').join(',')
  )
  const csv  = '\uFEFF' + heads.join(',') + '\n' + lines.join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const a    = document.createElement('a')
  a.href     = URL.createObjectURL(blob)
  a.download = 'linkedin_companies_' + Date.now() + '.csv'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href) }, 1000)
}

// ── main orchestrator ──────────────────────────────────────────────────────

type ProgressCallback = (p: CompanyCrawlProgress) => void

export async function fetchAllCompanies(
  onProgress: ProgressCallback,
  startIdx?: number,
  endIdx?: number
): Promise<MappedCompany[]> {
  if (startIdx !== undefined && endIdx !== undefined && startIdx >= endIdx)
    throw new Error('startIdx must be < endIdx')

  const session = getSessionFromBrowser()
  const query   = findLatestAccountSearchQuery()

  const COUNT      = 25
  const fetchStart = startIdx !== undefined ? Math.floor(startIdx / COUNT) * COUNT : 0
  let start        = fetchStart
  const allResults: CompanyElement[] = []
  let totalFound   = 0

  // Phase 1: fetch pages
  while (true) {
    const url =
      'https://www.linkedin.com/sales-api/salesApiAccountSearch'
      + '?q=searchQuery'
      + '&query=' + query
      + '&start=' + start
      + '&count=' + COUNT
      + '&decorationId=com.linkedin.sales.deco.desktop.searchv2.AccountSearchResult-4'

    const res = await fetch(url, { headers: buildHeaders(session), credentials: 'include' })
    if (!res.ok) throw new Error('HTTP ' + res.status)

    const data = await res.json() as { paging?: { total: number }; elements?: CompanyElement[] }
    if (totalFound === 0) totalFound = data.paging?.total ?? 0
    const elements = data.elements ?? []
    elements.forEach((el, i) => { el._absIndex = start + i })
    allResults.push(...elements)

    onProgress({ type: 'CRAWL_COMPANY_PROGRESS', phase: 'fetch', fetched: allResults.length, total: totalFound })

    if (elements.length === 0) break
    if (endIdx !== undefined && (start + COUNT) >= endIdx) break
    if (allResults[allResults.length - 1]._absIndex! >= totalFound - 1) break

    start += COUNT
    await new Promise(r => setTimeout(r, 1000))
  }

  // Slice theo range
  let finalResults = allResults
  if (startIdx !== undefined) finalResults = finalResults.filter(el => (el._absIndex ?? 0) >= startIdx)
  if (endIdx   !== undefined) finalResults = finalResults.filter(el => (el._absIndex ?? 0) <  endIdx)

  // Phase 2: enrich
  const enriched: MappedCompany[] = []
  for (let i = 0; i < finalResults.length; i++) {
    const el        = finalResults[i]
    const base      = mapCompany(el)
    const companyId = el.entityUrn?.split(':').pop()
    let detail: CompanyDetail | null = null
    if (companyId) detail = await getInformationDetail(companyId, session)
    enriched.push({ ...base, ...mapDetail(detail) })

    onProgress({ type: 'CRAWL_COMPANY_PROGRESS', phase: 'enrich', current: i + 1, total: finalResults.length })
    await new Promise(r => setTimeout(r, 800))
  }

  exportCSV(enriched)
  onProgress({ type: 'CRAWL_COMPANY_PROGRESS', phase: 'done', total: enriched.length })
  return enriched
}
```

**Step 3: Cập nhật src/content/content.ts — thêm handler START_CRAWL_COMPANY**

Thêm vào sau block `START_CRAWL_LEAD`:

```typescript
// Thêm import ở đầu file:
import { fetchAllCompanies } from '../lib/crawlCompany'
import type { CompanyCrawlProgress } from '../lib/types'

// Thêm handler trong chrome.runtime.onMessage.addListener:
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
```

**Step 4: Cập nhật App.tsx — wire company button**

Trong App.tsx thay:
- `const [companyStatus] = useState<BtnStatus>('idle')` → thêm full state giống lead
- `onClick={() => { /* TODO */ }}` → `onClick={handleCrawlCompany}`
- Thêm `ProgressPanel` cho company bên dưới lead panel
- Thêm listener `CRAWL_COMPANY_PROGRESS` / `CRAWL_COMPANY_RESULT` trong `useEffect`

```typescript
// Thêm state:
const [companyStatus,   setCompanyStatus]   = useState<BtnStatus>('idle')
const [companyProgress, setCompanyProgress] = useState<ProgressState>(DEFAULT_PROGRESS)

// Thêm vào useEffect listener (cạnh CRAWL_LEAD_PROGRESS handler):
if (msg.type === 'CRAWL_COMPANY_PROGRESS') {
  const p = msg as CompanyCrawlProgress
  if (p.phase === 'fetch') {
    setCompanyStatus('fetching')
    setCompanyProgress(prev => ({ ...prev, phase: 'fetch', fetched: p.fetched ?? prev.fetched, total: p.total ?? prev.total }))
  } else if (p.phase === 'enrich') {
    setCompanyStatus('enriching')
    setCompanyProgress(prev => ({ ...prev, phase: 'enrich', current: p.current ?? prev.current, total: p.total ?? prev.total }))
  } else if (p.phase === 'done') {
    setCompanyStatus('done')
    setCompanyProgress(prev => ({ ...prev, phase: 'done', total: p.total ?? prev.total }))
  }
}
if (msg.type === 'CRAWL_COMPANY_RESULT') {
  const r = msg as CompanyCrawlResult
  if (!r.ok) {
    setCompanyStatus('error')
    setCompanyProgress(prev => ({ ...prev, phase: 'error', error: r.error }))
  }
}

// Thêm handler:
const handleCrawlCompany = useCallback(() => {
  if (!tabId) return
  setCompanyStatus('fetching')
  setCompanyProgress(DEFAULT_PROGRESS)
  chrome.tabs.sendMessage(tabId, { type: 'START_CRAWL_COMPANY' })
}, [tabId])

// Thêm ProgressPanel dưới lead panel:
{(companyBusy || companyStatus === 'done' || companyStatus === 'error') && (
  <ProgressPanel status={companyStatus} progress={companyProgress} label="COMPANY" />
)}
```

**Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/crawlCompany.ts src/content/content.ts src/popup/App.tsx
git commit -m "feat: add Crawl Company button with full TS logic"
```

---

### Task 6: Build và kiểm tra

**Files:**
- No changes

**Step 1: Build**

```bash
npm run build
```

Expected: `✓ built in ~800ms` không có lỗi TypeScript.

**Step 2: Reload extension**

Vào `chrome://extensions` → click nút refresh trên extension "Crawl Linked".

**Step 3: Test trên trang Sales Navigator**

1. Mở `linkedin.com/sales/search/people` và thực hiện 1 search bất kỳ
2. Click extension icon → kiểm tra popup hiện 2 button
3. Click "CRAWL LEAD" → progress bar chạy, cuối cùng file CSV được download

**Step 4: Commit cuối nếu cần**

```bash
git add -A
git commit -m "chore: build dist for crawl-lead + crawl-company feature"
```
