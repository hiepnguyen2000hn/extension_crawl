// src/lib/crawlCompany.ts
import { getSessionFromBrowser, buildHeaders, buildCSV } from './crawlLead'
import type {
  Session, CompanyElement, CompanyDetail, RawCompany, CompanyCrawlProgress,
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

// Exact decoration from confirmed-working old JS — field names match salesApiCompanies response:
// industry (string), headquarters, yearFounded, revenueRange
const DETAIL_DECORATION =
  '%28entityUrn%2Cname%2Caccount%28saved%2CnoteCount%2ClistCount%2CcrmStatus%2Cstarred%29'
  + '%2CpictureInfo%2CcompanyPictureDisplayImage%2CcompanyBackgroundCoverImage'
  + '%2Cdescription%2Cindustry%2Clocation%2Cheadquarters%2Cwebsite%2CrevenueRange'
  + '%2CcrmOpportunities%2CflagshipCompanyUrl%2CemployeeGrowthPercentages'
  + '%2Cemployees*~fs_salesProfile%28entityUrn%2CfirstName%2ClastName%2CfullName'
  + '%2CpictureInfo%2CprofilePictureDisplayImage%29%2Cspecialties%2Ctype%2CyearFounded%29'

export async function getInformationDetail(
  companyId: string,
  session: Session
): Promise<CompanyDetail | null> {
  const url = `https://www.linkedin.com/sales-api/salesApiCompanies/${companyId}`
    + `?decoration=${DETAIL_DECORATION}`
  try {
    const res = await fetch(url, { headers: buildHeaders(session), credentials: 'include' })
    if (!res.ok) {
      WARN(`detail HTTP ${res.status} · companyId=${companyId}`)
      return null
    }
    return await res.json() as CompanyDetail
  } catch (e) {
    WARN(`detail err · companyId=${companyId}:`, String(e).slice(0, 40))
    return null
  }
}

// ── mappers ────────────────────────────────────────────────────────────────

export function mapCompany(el: CompanyElement): RawCompany {
  const companyId = el.entityUrn?.split(':').pop() ?? ''
  return {
    company_name:     el.companyName ?? '',
    company_linkedin: companyId ? 'https://www.linkedin.com/company/' + companyId : '',
    website:          el.website ?? '',
    // list result may return industry as string (old JS) or industries array
    industry:         el.industry ?? el.industries?.[0]?.localizedName ?? '',
    employee_count:   String(el.employeeCount ?? ''),
    // employeeCountRange may be a pre-formatted string or {start,end} object
    employee_range:   el.employeeDisplayCount
      ?? (typeof el.employeeCountRange === 'string'
          ? el.employeeCountRange
          : (el.employeeCountRange
              ? `${el.employeeCountRange.start ?? ''}-${el.employeeCountRange.end ?? ''}`
              : '')),
    city:             el.headquartersLocation?.city ?? '',
    region:           el.headquartersLocation?.geographicArea ?? '',
    country:          el.headquartersLocation?.country ?? '',
    description:      el.description?.slice(0, 200) ?? '',
    phone:            '',
    founded_year:     '',
    revenue:          '',
    entityUrn:        el.entityUrn ?? '',
    importDate:       new Date().toISOString().split('T')[0],
  }
}

export function mapDetail(detail: CompanyDetail | null): Partial<RawCompany> {
  if (!detail) return {}

  // revenueRange: "10M - 50M USD" format (old JS structure)
  const revMin = detail.revenueRange?.estimatedMinRevenue
  const revMax = detail.revenueRange?.estimatedMaxRevenue
  const revenue = (revMin && revMax)
    ? `${revMin.amount ?? ''}${revMin.unit ?? ''} - ${revMax.amount ?? ''}${revMax.unit ?? ''} ${revMin.currencyCode ?? ''}`.trim()
    : (detail.revenue ? `${detail.revenue.amount ?? ''} ${detail.revenue.currencyCode ?? ''}`.trim() : '')

  // headquarters: old JS uses { city, geographicArea?, country }
  const hq = detail.headquarters ?? detail.headquartersLocation

  const out: Partial<RawCompany> = {
    website:      detail.website      ?? '',
    phone:        detail.phone        ?? '',
    industry:     detail.industry ?? detail.industries?.[0]?.localizedName ?? '',
    founded_year: String(detail.yearFounded ?? detail.foundedOn?.year ?? ''),
    description:  detail.description?.slice(0, 200) ?? '',
    city:         hq?.city          ?? '',
    region:       hq?.geographicArea ?? '',
    country:      hq?.country        ?? '',
    revenue,
  }
  // Only override employee fields if detail actually has them (avoid wiping list-result values)
  if (detail.employeeCount != null)
    out.employee_count = String(detail.employeeCount)
  if (detail.employeeCountRange != null)
    out.employee_range = typeof detail.employeeCountRange === 'string'
      ? detail.employeeCountRange
      : `${detail.employeeCountRange.start ?? ''}-${detail.employeeCountRange.end ?? ''}`
  return out
}

// ── csv export ─────────────────────────────────────────────────────────────

function exportRawCSV(companies: RawCompany[]): void {
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
): Promise<RawCompany[]> {
  if (startIdx !== undefined && endIdx !== undefined && startIdx >= endIdx)
    throw new Error('startIdx must be < endIdx')

  const session = getSessionFromBrowser()
  const query   = await findLatestAccountSearchQuery()

  const COUNT      = 25
  const fetchStart = startIdx !== undefined ? Math.floor(startIdx / COUNT) * COUNT : 0
  let start        = fetchStart
  const allResults: CompanyElement[] = []
  let totalFound: number | null = null

  // ── Phase 1: fetch pages ──────────────────────────────────────────────────
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

    if (totalFound === null) {
      totalFound = data.paging?.total ?? 0
      LOG(`total: ${totalFound} companies`)
    }

    // verbose F12 only — log first page keys
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
  LOG(`after slice: ${finalResults.length} companies`)

  // ── Phase 2: enrich detail ────────────────────────────────────────────────
  const enriched: RawCompany[] = []
  for (let i = 0; i < finalResults.length; i++) {
    const el        = finalResults[i]
    const base      = mapCompany(el)
    const companyId = el.entityUrn?.split(':').pop()
    let detail: CompanyDetail | null = null
    if (companyId) {
      detail = await getInformationDetail(companyId, session)
      LOG(`[${i + 1}/${finalResults.length}] ${base.company_name.slice(0, 25)}${detail ? '' : ' (detail failed)'}`)
    } else {
      WARN(`[${i + 1}] no companyId`)
    }
    const merged: RawCompany = { ...base, ...mapDetail(detail) }
    enriched.push(merged)
    onProgress({ type: 'CRAWL_COMPANY_PROGRESS', phase: 'enrich', current: i + 1, total: finalResults.length })
    await new Promise(r => setTimeout(r, 800))
  }

  // Lưu raw data vào storage để Score button dùng sau
  chrome.storage.local.set({ lastRawCompanies: enriched })
  LOG(`raw companies saved to storage (${enriched.length})`)

  exportRawCSV(enriched)
  onProgress({ type: 'CRAWL_COMPANY_PROGRESS', phase: 'done', total: enriched.length })
  LOG(`✓ ${enriched.length} exported (raw, no score)`)
  return enriched
}
