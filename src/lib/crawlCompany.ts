// src/lib/crawlCompany.ts
import { getSessionFromBrowser, buildHeaders, buildCSV, sendDownload } from './crawlLead'
import type {
  Session, CompanyElement, CompanyDetail, MappedCompany, CompanyCrawlProgress,
} from './types'
import { makeLogger } from './logger'

const { log: LOG, warn: WARN, err: ERR } = makeLogger('company')

// ── url detection ──────────────────────────────────────────────────────────

function extractQueryFromUrl(rawUrl: string): string {
  const urlObj     = new URL(rawUrl)
  const queryMatch = urlObj.search.match(/[?&]query=([^&]+)/)
  return queryMatch?.[1] ?? ''
}

export async function findLatestAccountSearchQuery(): Promise<string> {
  // Strategy 1: background webRequest log
  try {
    const res = await new Promise<{ url: string | null }>((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GET_LATEST_URL', keyword: 'salesApiAccountSearch' },
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
  const all = entries.filter(e => e.name.includes('salesApiAccountSearch'))
  console.debug('[CL:co] perf entries:', entries.length, 'salesApiAccountSearch:', all.length)

  if (!all.length) {
    ERR('✗ no query — do an account search first')
    throw new Error('Không tìm thấy request salesApiAccountSearch — hãy load trang account search trước')
  }

  const query = extractQueryFromUrl(all.sort((a, b) => b.startTime - a.startTime)[0].name)
  if (!query) { ERR('✗ query parse failed'); throw new Error('Không parse được query') }
  LOG('[S2] query ✓')
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
  const csv      = buildCSV(companies)
  const filename = 'linkedin_companies_' + Date.now() + '.csv'
  chrome.runtime.sendMessage({ type: 'CRAWL_COMPANY_CSV', csv, filename, count: companies.length })
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
  const query   = await findLatestAccountSearchQuery()

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
    if (!res.ok) {
      ERR(`HTTP ${res.status}`)
      throw new Error('HTTP ' + res.status)
    }

    const data = await res.json() as { paging?: { total: number }; elements?: CompanyElement[] }

    if (totalFound === 0) {
      totalFound = data.paging?.total ?? 0
      LOG(`total: ${totalFound} companies`)
    }

    // verbose F12 only
    if (start === fetchStart && (data.elements?.length ?? 0) > 0) {
      console.debug('[CL:co] co[0] keys:', Object.keys(data.elements![0] as object))
    }

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

  LOG(`fetch done · ${allResults.length} companies`)

  // Slice theo range
  let finalResults = allResults
  if (startIdx !== undefined) finalResults = finalResults.filter(el => (el._absIndex ?? 0) >= startIdx)
  if (endIdx   !== undefined) finalResults = finalResults.filter(el => (el._absIndex ?? 0) <  endIdx)

  // ── Phase 2: enrich detail ───────────────────────────────────────────────
  const enriched: MappedCompany[] = []
  for (let i = 0; i < finalResults.length; i++) {
    const el        = finalResults[i]
    const base      = mapCompany(el)
    const companyId = el.entityUrn?.split(':').pop()
    let detail: CompanyDetail | null = null
    if (companyId) {
      detail = await getInformationDetail(companyId, session)
      LOG(`[${i + 1}] ${base.company_name.slice(0, 22)}`)
    } else {
      WARN(`[${i + 1}] no id`)
    }
    enriched.push({ ...base, ...mapDetail(detail) })
    onProgress({ type: 'CRAWL_COMPANY_PROGRESS', phase: 'enrich', current: i + 1, total: finalResults.length })
    await new Promise(r => setTimeout(r, 800))
  }

  exportCSV(enriched)
  onProgress({ type: 'CRAWL_COMPANY_PROGRESS', phase: 'done', total: enriched.length })
  LOG(`✓ ${enriched.length} exported`)
  return enriched
}
