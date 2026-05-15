// ─── Constants ────────────────────────────────────────────────────────────────
const TRACKR_URL = 'http://localhost:3000/employee'

const CAT_COLORS = {
  development: '#7c3aed',
  design:      '#db2777',
  meetings:    '#059669',
  comms:       '#2563eb',
  docs:        '#0284c7',
  pm:          '#d97706',
  research:    '#0891b2',
  off_task:    '#dc2626',
  other:       '#4b5563',
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)

const badgeEl          = $('connection-badge')
const badgeLabel       = $('connection-label')
const sectionDisconn   = $('section-disconnected')
const sectionIdle      = $('section-idle')
const sectionActive    = $('section-active')
const timerEl          = $('timer')
const actDot           = $('activity-dot')
const actCategory      = $('activity-category')
const actTitle         = $('activity-title')
const actDomain        = $('activity-domain')
const summaryRowsEl    = $('summary-rows')
const employeeNameEl   = $('employee-name')
const avatarEl         = $('avatar-initials')
const syncLabelEl      = $('sync-label')
const btnClockIn       = $('btn-clock-in')
const btnClockOut      = $('btn-clock-out')
const btnOpenApp       = $('btn-open-app')
const footerLink       = $('footer-link')

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDuration(sec) {
  const h = Math.floor(sec / 3600).toString().padStart(2, '0')
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0')
  const s = (sec % 60).toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

function fmtMin(min) {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function getInitials(name = '') {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
}

// ─── UI update helpers ────────────────────────────────────────────────────────
function showSection(which) {
  sectionDisconn.classList.toggle('hidden', which !== 'disconnected')
  sectionIdle.classList.toggle('hidden',    which !== 'idle')
  sectionActive.classList.toggle('hidden',  which !== 'active')
}

function setBadge(mode, label) {
  badgeEl.className = `badge badge--${mode}`
  badgeLabel.textContent = label
}

function renderSummary(summary) {
  if (!summary?.categories) {
    summaryRowsEl.innerHTML = '<div style="color:#3d3d4a;font-size:11px">No activity yet today</div>'
    return
  }

  const total = summary.totalMin || 1
  const sorted = Object.entries(summary.categories)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)

  summaryRowsEl.innerHTML = sorted.map(([cat, min]) => {
    const pct   = Math.round((min / total) * 100)
    const color = CAT_COLORS[cat] || CAT_COLORS.other
    return `
      <div class="summary-row">
        <span class="summary-label">${cat.replace('_', ' ')}</span>
        <div class="summary-bar-track">
          <div class="summary-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="summary-time">${fmtMin(min)}</span>
      </div>`
  }).join('')
}

function renderCurrentActivity(activity) {
  if (!activity) return
  const cat   = activity.category || 'other'
  const color = CAT_COLORS[cat] || CAT_COLORS.other

  actDot.style.background = color
  actCategory.textContent = cat.replace('_', ' ')
  actTitle.textContent    = activity.title  || activity.domain || '—'
  actDomain.textContent   = activity.domain || '—'
}

// ─── Timer ────────────────────────────────────────────────────────────────────
let timerInterval = null
let clockInEpoch  = null

function startTimer(clockInTime) {
  clockInEpoch = clockInTime ? new Date(clockInTime).getTime() : Date.now()
  clearInterval(timerInterval)
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - clockInEpoch) / 1000)
    timerEl.textContent = fmtDuration(elapsed)
  }, 1000)
}

function stopTimer() {
  clearInterval(timerInterval)
  timerInterval = null
}

// ─── Render state ─────────────────────────────────────────────────────────────
function render(stored, bgState) {
  const token      = stored.token
  const clockedIn  = stored.clockedIn
  const name       = stored.employeeName || 'Employee'
  const summary    = bgState?.todaySummary || stored.todaySummary
  const activity   = stored.currentActivity
  const lastSync   = stored.lastSync

  footerLink.href   = TRACKR_URL
  btnOpenApp.href   = TRACKR_URL

  if (lastSync) {
    const d = new Date(lastSync)
    syncLabelEl.textContent = `synced ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }

  if (!token) {
    setBadge('disconnected', 'Not connected')
    showSection('disconnected')
    stopTimer()
    return
  }

  employeeNameEl.textContent = name
  avatarEl.textContent       = getInitials(name)

  if (!clockedIn) {
    setBadge('connected', name.split(' ')[0])
    showSection('idle')
    stopTimer()
  } else {
    setBadge('active', 'Active')
    showSection('active')
    startTimer(stored.clockInTime)
    renderCurrentActivity(activity)
    renderSummary(summary)
  }
}

// ─── Load data and render ─────────────────────────────────────────────────────
async function refresh() {
  const stored = await chrome.storage.local.get([
    'token', 'employeeId', 'employeeName',
    'clockedIn', 'clockInTime',
    'currentActivity', 'todaySummary', 'lastSync',
  ])

  // Try to get real-time state from the background worker
  let bgState = null
  try {
    bgState = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
  } catch (_) {
    // Service worker might be sleeping — storage data is enough
  }

  render(stored, bgState)
}

// ─── Button handlers ──────────────────────────────────────────────────────────
btnClockIn.addEventListener('click', async () => {
  btnClockIn.disabled    = true
  btnClockIn.textContent = 'Clocking in…'
  try {
    await chrome.runtime.sendMessage({ type: 'CLOCK_IN' })
    await refresh()
  } finally {
    btnClockIn.disabled    = false
    btnClockIn.textContent = '▶ Clock In'
  }
})

btnClockOut.addEventListener('click', async () => {
  btnClockOut.disabled    = true
  btnClockOut.textContent = 'Clocking out…'
  try {
    await chrome.runtime.sendMessage({ type: 'CLOCK_OUT' })
    stopTimer()
    timerEl.textContent = '00:00:00'
    await refresh()
  } finally {
    btnClockOut.disabled    = false
    btnClockOut.textContent = '■ Clock Out'
  }
})

// ─── Live refresh while popup is open ────────────────────────────────────────
refresh()
setInterval(refresh, 10000) // re-read storage every 10s for activity + summary updates
