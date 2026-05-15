// Injected on meet.google.com.
// Detects whether the user is in an active call and sends enriched context
// to the background service worker.

(function () {
  let lastState = null

  function getMeetingTitle() {
    // The meeting name appears in several places depending on Meet version
    const selectors = [
      '[data-meeting-title]',
      '.u6vdEc',       // meeting code / name bar
      'span[jsname="r4nke"]',
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (el?.textContent?.trim()) return el.textContent.trim()
    }
    // Fall back to page title
    return document.title.replace('– Google Meet', '').replace('- Google Meet', '').trim()
  }

  function isInCall() {
    // A mic/camera toggle bar only exists when the call is active
    return (
      document.querySelector('[data-is-muted]') !== null ||
      document.querySelector('[aria-label*="microphone"]') !== null ||
      document.querySelector('div[jscontroller][data-audio-capture]') !== null
    )
  }

  function check() {
    const inCall = isInCall()
    const title  = getMeetingTitle()
    const key    = `${inCall}:${title}`

    if (key === lastState) return // no change
    lastState = key

    chrome.runtime.sendMessage({
      type:     'MEETING_STATE',
      platform: 'Google Meet',
      inCall,
      title,
    }).catch(() => {})
  }

  // Check immediately then every 8 seconds
  check()
  setInterval(check, 8000)
})()
