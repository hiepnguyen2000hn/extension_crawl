// Background Service Worker — Crawl Linked
// Listens to network requests from all tabs

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Store intercepted requests for popup to read
    chrome.storage.session.get(['networkLog'], (result) => {
      const log: chrome.webRequest.WebRequestDetails[] = result.networkLog ?? []
      log.unshift(details)
      // Keep last 500 entries
      chrome.storage.session.set({ networkLog: log.slice(0, 500) })
    })
  },
  { urls: ['<all_urls>'] },
  []
)

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

  // Download a CSV file — content script can't use blob: due to LinkedIn CSP
  if (message.type === 'DOWNLOAD_CSV') {
    const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(message.content as string)
    chrome.downloads.download({ url: dataUrl, filename: message.filename as string, saveAs: false })
    sendResponse({ ok: true })
    return true
  }

  // Returns the most recent URL matching a given keyword, optionally filtered by tabId
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
})

export {}