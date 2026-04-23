const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3006'

export interface CrawlUrlResult {
  ok: boolean
  url: string
  markdown: string
  error?: string
  tuyen_dung?: string
  blog?: string
  linh_vuc?: string
  du_an_gan_nhat?: string
  doi_tac?: string
}

export interface CrawlSheetResult {
  ok: boolean
  total: number
  results: Array<CrawlUrlResult & { row: Record<string, string> }>
  error?: string
}

/** Kiểm tra Python server có đang chạy không. */
export async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Crawl 1 URL — gọi POST /crawl */
export async function crawlUrl(url: string): Promise<CrawlUrlResult> {
  const res = await fetch(`${API_URL}/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(60_000),
  })
  return res.json() as Promise<CrawlUrlResult>
}

/** Helper: đọc SSE stream từ response, gọi onLine cho mỗi dòng */
async function _readSSE(res: Response, onLine: (line: string) => void): Promise<{ ok: boolean }> {
  if (!res.body) return { ok: false }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let exitCode = 0
  // 90s idle timeout — bắt connection chết trên AWS ALB/Nginx
  const IDLE_MS = 90_000

  while (true) {
    const readPromise = reader.read()
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SSE idle timeout')), IDLE_MS)
    )
    const { done, value } = await Promise.race([readPromise, timeoutPromise])
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const text = line.slice(6).trim()
        if (text.startsWith('__EXIT__:')) {
          exitCode = parseInt(text.split(':')[1] ?? '1', 10)
        } else if (text.startsWith('__ERROR__:')) {
          onLine(`✗ ${text.slice(10)}`)
        } else if (text) {
          onLine(text)
        }
      }
    }
  }

  return { ok: exitCode === 0 }
}

/**
 * Full enrich với SSE streaming — gọi POST /enrich-sheet.
 * Lưu ý: trong extension, background service worker gọi endpoint này trực tiếp
 * để duy trì kết nối khi popup đóng. Hàm này dùng cho trường hợp gọi thẳng từ popup.
 */
export async function enrichSheetStream(
  opts: { spreadsheetId: string; gid?: number; sheetName?: string; limit?: number },
  onLine: (line: string) => void,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_URL}/enrich-sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spreadsheet_id: opts.spreadsheetId,
      gid: opts.gid ?? null,
      sheet_name: opts.sheetName ?? null,
      limit: opts.limit ?? null,
    }),
    signal: AbortSignal.timeout(1_800_000), // 30 phút
  })
  return _readSSE(res, onLine)
}

/**
 * Crawl LinkedIn posts với SSE streaming — gọi POST /linkedin-sheet.
 * Lưu ý: trong extension, background service worker gọi endpoint này trực tiếp.
 */
export async function linkedinSheetStream(
  opts: {
    spreadsheetId: string
    gid?: number
    sheetName?: string
    limit?: number
    colLinkedin?: string
    colName?: string
  },
  onLine: (line: string) => void,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_URL}/linkedin-sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spreadsheet_id: opts.spreadsheetId,
      gid: opts.gid ?? null,
      sheet_name: opts.sheetName ?? null,
      limit: opts.limit ?? null,
      col_linkedin: opts.colLinkedin ?? 'linkedUrl',
      col_name: opts.colName ?? 'fullName',
    }),
    signal: AbortSignal.timeout(1_800_000), // 30 phút
  })
  return _readSSE(res, onLine)
}

/** Crawl danh sách URL từ Google Sheet — gọi POST /crawl-sheet */
export async function crawlSheet(opts: {
  spreadsheetId: string
  gid?: number
  sheetName?: string
  urlColumn?: string
  limit?: number
}): Promise<CrawlSheetResult> {
  const res = await fetch(`${API_URL}/crawl-sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spreadsheet_id: opts.spreadsheetId,
      gid: opts.gid ?? null,
      sheet_name: opts.sheetName ?? null,
      url_column: opts.urlColumn ?? 'website',
      limit: opts.limit ?? null,
    }),
    signal: AbortSignal.timeout(300_000), // 5 phút cho nhiều URL
  })
  return res.json() as Promise<CrawlSheetResult>
}
