// Runs on the trackR web app origin.
// Bridges auth/session state between the web app (localStorage + custom events)
// and the background service worker (chrome.runtime.sendMessage).

(function () {
  // ── Page → Background ──────────────────────────────────────────────────────

  function sendToken() {
    const token      = localStorage.getItem('trackr_extension_token')
    const employeeId = localStorage.getItem('trackr_employee_id')
    const name       = localStorage.getItem('trackr_employee_name')
    if (token && employeeId) {
      chrome.runtime.sendMessage({
        type: 'AUTH_TOKEN', token, employeeId, name: name || 'Employee',
      }).catch(() => {})
    }
  }

  function clearToken() {
    chrome.runtime.sendMessage({ type: 'AUTH_CLEARED' }).catch(() => {})
  }

  function sendSession() {
    const sessionId   = localStorage.getItem('trackr_session_id')
    const clockInTime = localStorage.getItem('trackr_clock_in_time')
    chrome.runtime.sendMessage({ type: 'SESSION_CHANGED', sessionId, clockInTime }).catch(() => {})
  }

  // Web app clocked in — tell background to start tracking
  window.addEventListener('trackr:clocked_in', (e) => {
    const { sessionId, clockInTime } = (e).detail ?? {}
    chrome.runtime.sendMessage({ type: 'CLOCK_IN_FROM_WEB', sessionId, clockInTime }).catch(() => {})
  })

  // Web app clocked out — tell background to stop tracking and flush
  window.addEventListener('trackr:clocked_out', () => {
    chrome.runtime.sendMessage({ type: 'CLOCK_OUT_FROM_WEB' }).catch(() => {})
  })

  // Cross-tab localStorage changes (different tab of same origin)
  window.addEventListener('storage', (e) => {
    if (e.key === 'trackr_extension_token') {
      e.newValue ? sendToken() : clearToken()
    }
    if (e.key === 'trackr_session_id' || e.key === 'trackr_clock_in_time') {
      sendSession()
    }
  })

  // Same-tab custom events dispatched by the web app
  window.addEventListener('trackr:auth_changed',    sendToken)
  window.addEventListener('trackr:auth_cleared',    clearToken)
  window.addEventListener('trackr:session_changed', sendSession)

  // Send current state on load
  sendToken()
  sendSession()

  // ── Background → Page ──────────────────────────────────────────────────────
  // Background sends WRITE_STORAGE to update localStorage and notify the page
  // (used when the extension popup clocks in/out independently)

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'WRITE_STORAGE') return

    const { key, value } = msg

    if (value === null || value === undefined) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }

    // Notify the page so it can react without waiting for a storage event
    if (key === 'trackr_session_id') {
      if (value) {
        const clockInTime = localStorage.getItem('trackr_clock_in_time')
        window.dispatchEvent(new CustomEvent('trackr:ext_clocked_in', {
          detail: { sessionId: value, clockInTime },
        }))
      } else {
        window.dispatchEvent(new CustomEvent('trackr:ext_clocked_out'))
      }
    }

    sendResponse({ ok: true })
    return true
  })
}())
