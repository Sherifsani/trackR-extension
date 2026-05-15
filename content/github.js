// Injected on github.com.
// Extracts PR title, issue title, and repo name from the DOM so the background
// worker records a meaningful title instead of a raw URL.

(function () {
  function getRepoName() {
    const el = document.querySelector('[itemprop="name"] a') ||
               document.querySelector('.AppHeader-context-full a:last-child') ||
               document.querySelector('strong[itemprop="name"] a')
    return el?.textContent?.trim() || ''
  }

  function extractAndSend() {
    const url     = window.location.href
    const repo    = getRepoName()
    let   title   = ''

    if (url.includes('/pull/')) {
      const heading = document.querySelector('.gh-header-title .js-issue-title') ||
                      document.querySelector('bdi.js-issue-title') ||
                      document.querySelector('h1[class*="title"]')
      if (heading) title = `${heading.textContent.trim()} — ${repo}`
    } else if (url.includes('/issues/') && !url.endsWith('/issues')) {
      const heading = document.querySelector('.gh-header-title .js-issue-title') ||
                      document.querySelector('bdi.js-issue-title')
      if (heading) title = `${heading.textContent.trim()} — ${repo}`
    } else if (url.includes('/blob/') || url.includes('/edit/')) {
      // Viewing or editing a file
      const filepath = document.querySelector('.final-path') ||
                       document.querySelector('[aria-label*="file path"]')
      if (filepath && repo) title = `${filepath.textContent.trim()} — ${repo}`
    }

    if (title) {
      chrome.runtime.sendMessage({ type: 'TAB_ENRICHED', title }).catch(() => {})
    }
  }

  // Run on initial load
  extractAndSend()

  // GitHub uses Turbo / pjax for navigation — re-run after page transitions
  document.addEventListener('turbo:render',   extractAndSend)
  document.addEventListener('pjax:end',       extractAndSend)
  window.addEventListener('popstate',         extractAndSend)

  // Fallback: observe the <title> element for changes
  const titleEl = document.querySelector('title')
  if (titleEl) {
    new MutationObserver(extractAndSend).observe(titleEl, { childList: true })
  }
})()
