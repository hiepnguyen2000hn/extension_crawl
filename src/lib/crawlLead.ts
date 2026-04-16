// src/lib/crawlLead.ts
import type { Session, LinkedInLeadElement, MappedLead, CrawlProgress } from './types'
import { makeLogger } from './logger'

const { log: LOG, warn: WARN, err: ERR } = makeLogger('lead')

// short LinkedIn path for terminal display: /in/username
const liPath = (url: string) => {
  try { return new URL(url).pathname.replace('/in/', '').slice(0, 22) }
  catch { return url.slice(0, 22) }
}

// ── session ────────────────────────────────────────────────────────────────

export function getSessionFromBrowser(): Session {
  const cookies = Object.fromEntries(
    document.cookie.split('; ').map(c => {
      const [k, ...v] = c.split('=')
      return [k.trim(), v.join('=')]
    })
  )
  const jsessionid = cookies['JSESSIONID']?.replace(/"/g, '')
  const liIdentity = cookies['LI_IDENTITY'] ?? ''

  // verbose → F12 console only
  console.group('%c[CL] Session Tokens', 'color:#3bf0a0;font-weight:bold')
  console.log('JSESSIONID:', jsessionid ?? 'NOT FOUND')
  console.log('LI_IDENTITY:', liIdentity || 'absent')
  console.groupEnd()

  if (!jsessionid) { ERR('session ✗ no JSESSIONID'); throw new Error('Không tìm thấy JSESSIONID') }
  LOG('session ✓')
  return { csrfToken: jsessionid, liIdentity }
}

// ── headers ────────────────────────────────────────────────────────────────

export function buildHeaders(session: Session): Record<string, string> {
  const h: Record<string, string> = {
    'accept':                    '*/*',
    'csrf-token':                session.csrfToken,
    'x-li-lang':                 'en_US',
    'x-restli-protocol-version': '2.0.0',
  }
  if (session.liIdentity) h['x-li-identity'] = session.liIdentity
  return h
}

// ── url detection ──────────────────────────────────────────────────────────

function extractQueryFromUrl(rawUrl: string): string {
  const m = new URL(rawUrl).search.match(/[?&]query=([^&]+)/)
  return m?.[1] ?? ''
}

export async function findLatestLeadSearchQuery(): Promise<string> {
  // Strategy 1: background webRequest log
  try {
    const res = await new Promise<{ url: string | null }>((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GET_LATEST_URL', keyword: 'salesApiLeadSearch' },
        r => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(r))
    })
    if (res.url) {
      const query = extractQueryFromUrl(res.url)
      if (query) { LOG('[S1] query ✓'); return query }
      WARN('[S1] url ok but no query param')
    } else {
      WARN('[S1] no match in log')
    }
  } catch (e) {
    WARN('[S1] bg msg failed:', String(e).slice(0, 40))
  }

  // Strategy 2: performance entries
  LOG('[S2] trying perf…')
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const all = entries.filter(e => e.name.includes('salesApiLeadSearch'))
  console.debug('[CL] perf entries:', entries.length, 'salesApiLeadSearch:', all.length)

  if (!all.length) {
    ERR('✗ no query — do a search first')
    throw new Error('Không tìm thấy request salesApiLeadSearch — hãy load trang search trước')
  }

  const query = extractQueryFromUrl(all.sort((a, b) => b.startTime - a.startTime)[0].name)
  if (!query) { ERR('✗ query parse failed'); throw new Error('Không parse được query') }
  LOG('[S2] query ✓')
  return query
}

// ── flagship profile (includes contactInfo for email/phone) ────────────────

// Decoration for salesApiProfiles — includes contactInfo to extract email & phone
const PROFILE_DECORATION =
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
  const m = entityUrn.match(/\(([^,)]+),([^,)]+),([^,)]*)\)/)
  if (!m) { WARN('urn parse fail:', entityUrn.slice(0, 30)); return null }
  return { profileId: m[1], authType: m[2], authToken: m[3] }
}

interface FlagshipProfile { flagshipProfileUrl: string; email: string; phone: string }

export async function fetchFlagshipProfile(entityUrn: string, session: Session): Promise<FlagshipProfile> {
  const empty: FlagshipProfile = { flagshipProfileUrl: '', email: '', phone: '' }
  const parsed = parseEntityUrn(entityUrn)
  if (!parsed) return empty
  const { profileId, authType, authToken } = parsed
  const url = 'https://www.linkedin.com/sales-api/salesApiProfiles/'
    + `(profileId:${profileId},authType:${authType},authToken:${authToken})`
    + `?decoration=${PROFILE_DECORATION}`
  try {
    const res = await fetch(url, { headers: buildHeaders(session), credentials: 'include' })
    if (!res.ok) { WARN(`flagship HTTP ${res.status}`); return empty }
    const data = await res.json() as {
      flagshipProfileUrl?: string
      contactInfo?: {
        emailAddresses?: Array<{ emailAddress?: string }>
        phoneNumbers?:   Array<{ number?: string }>
      }
    }
    return {
      flagshipProfileUrl: data.flagshipProfileUrl ?? '',
      email: data.contactInfo?.emailAddresses?.[0]?.emailAddress ?? '',
      phone: data.contactInfo?.phoneNumbers?.[0]?.number ?? '',
    }
  } catch (e) {
    WARN('flagship err:', String(e).slice(0, 40))
    return empty
  }
}

// ── mapping ────────────────────────────────────────────────────────────────

export function mapLead(el: LinkedInLeadElement, index?: number): MappedLead {
  const raw = el as unknown as Record<string, unknown>
  const positions =
    (Array.isArray(el.currentPositions) ? el.currentPositions : null) ??
    (Array.isArray(raw['positions'])     ? raw['positions'] as typeof el.currentPositions : null) ??
    []

  // verbose field inspection — F12 console only, first lead
  if (index === 0) {
    console.debug('[CL] lead[0] keys:', Object.keys(raw))
    console.debug('[CL] positions:', positions)
  }

  const pos       = positions[0] ?? {}
  const companyId = pos.companyUrn?.split(':').pop() ?? ''
  const salesNavUrl = el.entityUrn
    ? 'https://www.linkedin.com/sales/lead/' + encodeURIComponent(el.entityUrn) : ''
  const artifact =
    el.profilePictureDisplayImage?.artifacts?.find(a => a.width === 200) ??
    el.profilePictureDisplayImage?.artifacts?.[0]
  const profilePictureUrl = artifact
    ? (el.profilePictureDisplayImage?.rootUrl ?? '') + artifact.fileIdentifyingUrlPathSegment : ''

  return {
    firstName:         el.firstName ?? '',
    lastName:          el.lastName ?? '',
    fullName:          el.fullName ?? '',
    job_title:         pos.title ?? '',
    location:          el.geoRegion ?? '',
    country:           el.geoRegion?.includes(',')
                         ? (el.geoRegion.split(',').pop()?.trim() ?? el.geoRegion)
                         : el.geoRegion ?? '',
    email:             el.email ?? '',
    phone:             el.phone ?? '',
    salesNavigatorUrl: salesNavUrl,
    linkedUrl:         el.flagshipProfileUrl ?? '',
    company_name:      pos.companyName ?? '',
    company_linkedin:  companyId ? 'https://www.linkedin.com/company/' + companyId : '',
    premium:           el.premium ? 'true' : 'false',
    openToWork:        el.openToOpportunities ? 'true' : 'false',
    connectStatus:     el.degree === 1      ? 'connected'
                     : el.pendingInvitation ? 'pending'
                     : 'not_connected',
    occupation:        el.summary?.split('\n')[0]?.slice(0, 100) ?? '',
    profilePicture:    profilePictureUrl,
    entityUrn:         el.entityUrn ?? '',
    importDate:        new Date().toISOString().split('T')[0],
  }
}

// ── csv export ─────────────────────────────────────────────────────────────

export function buildCSV<T extends object>(rows: T[]): string {
  if (!rows.length) return ''
  const heads = Object.keys(rows[0]) as (keyof T)[]
  const lines = rows.map(r =>
    heads.map(h => '"' + String((r[h] as unknown) ?? '').replace(/"/g, '""') + '"').join(',')
  )
  return '\uFEFF' + heads.join(',') + '\n' + lines.join('\n')
}

export function sendDownload(csv: string, filename: string): void {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_CSV', content: csv, filename })
}

export function exportCSV(leads: MappedLead[]): void {
  if (!leads.length) return
  const csv      = buildCSV(leads)
  const filename = 'linkedin_leads_' + Date.now() + '.csv'
  chrome.runtime.sendMessage({ type: 'CRAWL_LEAD_CSV', csv, filename, count: leads.length })
}

// ── main orchestrator ──────────────────────────────────────────────────────

type ProgressCallback = (p: CrawlProgress) => void

export async function fetchAllLeads(onProgress: ProgressCallback): Promise<MappedLead[]> {
  const session = getSessionFromBrowser()
  const query   = await findLatestLeadSearchQuery()

  const COUNT = 25
  let start = 0
  const allResults: LinkedInLeadElement[] = []
  let totalFound = 0

  // ── Phase 1: fetch all pages ─────────────────────────────────────────────
  while (true) {
    const url =
      'https://www.linkedin.com/sales-api/salesApiLeadSearch'
      + '?q=searchQuery&query=' + query
      + '&start=' + start + '&count=' + COUNT
      + '&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14'

    const res = await fetch(url, { headers: buildHeaders(session), credentials: 'include' })
    if (!res.ok) {
      ERR(`HTTP ${res.status}`)
      throw new Error('HTTP ' + res.status)
    }

    const data = await res.json() as { paging?: { total: number }; elements?: LinkedInLeadElement[] }
    if (totalFound === 0) {
      totalFound = data.paging?.total ?? 0
      LOG(`total: ${totalFound} leads`)
    }

    const elements = data.elements ?? []
    allResults.push(...elements)
    onProgress({ type: 'CRAWL_LEAD_PROGRESS', phase: 'fetch', fetched: allResults.length, total: totalFound })

    if (elements.length === 0 || allResults.length >= totalFound) break
    start += COUNT
    await new Promise(r => setTimeout(r, 1000))
  }

  LOG(`fetch done · ${allResults.length} leads`)

  // ── Phase 2: enrich flagship URL + email + phone ─────────────────────────
  for (let i = 0; i < allResults.length; i++) {
    const el = allResults[i]
    if (el.entityUrn) {
      const profile = await fetchFlagshipProfile(el.entityUrn, session)
      el.flagshipProfileUrl = profile.flagshipProfileUrl
      el.email = profile.email
      el.phone = profile.phone
      LOG(`[${i + 1}] ${profile.flagshipProfileUrl ? liPath(profile.flagshipProfileUrl) : '(no url)'}${profile.email ? ' · ' + profile.email : ''}`)
    } else {
      WARN(`[${i + 1}] no urn`)
    }
    onProgress({ type: 'CRAWL_LEAD_PROGRESS', phase: 'enrich', current: i + 1, total: allResults.length })
    await new Promise(r => setTimeout(r, 600))
  }

  const mapped = allResults.map((el, i) => mapLead(el, i))
  exportCSV(mapped)
  onProgress({ type: 'CRAWL_LEAD_PROGRESS', phase: 'done', total: mapped.length })
  LOG(`✓ ${mapped.length} exported`)
  return mapped
}
