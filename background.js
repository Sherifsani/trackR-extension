// ─── Config ───────────────────────────────────────────────────────────────────
const TRACKR_ORIGIN = "http://localhost:3000";
const IDLE_THRESHOLD_SEC = 180; // 3 minutes
const SYNC_INTERVAL_MIN = 1; // alarm-based fallback sync (1 minute)
const EAGER_SYNC_MS = 5_000; // sync 5s after any tab is recorded (faster live updates)

// ─── Domain → category map ────────────────────────────────────────────────────
const CATEGORY_MAP = {
  development: [
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "stackoverflow.com",
    "mdn.web.dev",
    "developer.mozilla.org",
    "npmjs.com",
    "caniuse.com",
    "bundlephobia.com",
    "localhost",
    "vercel.app",
    "netlify.app",
    "railway.app",
  ],
  design: [
    "figma.com",
    "framer.com",
    "canva.com",
    "dribbble.com",
    "behance.net",
    "coolors.co",
  ],
  docs: [
    "notion.so",
    "docs.google.com",
    "confluence.atlassian.net",
    "slab.com",
    "nuclino.com",
    "coda.io",
    "gitbook.io",
  ],
  comms: [
    "slack.com",
    "discord.com",
    "mail.google.com",
    "outlook.live.com",
    "teams.microsoft.com",
    "telegram.org",
  ],
  meetings: [
    "meet.google.com",
    "zoom.us",
    "whereby.com",
    "around.co",
    "cal.com",
    "calendly.com",
  ],
  pm: [
    "linear.app",
    "jira.atlassian.net",
    "asana.com",
    "trello.com",
    "basecamp.com",
    "monday.com",
    "clickup.com",
    "github.com/issues",
    "github.com/projects",
  ],
  research: [
    "wikipedia.org",
    "medium.com",
    "dev.to",
    "hashnode.com",
    "news.ycombinator.com",
    "google.com",
  ],
  off_task: [
    "youtube.com",
    "twitter.com",
    "x.com",
    "reddit.com",
    "netflix.com",
    "instagram.com",
    "facebook.com",
    "tiktok.com",
    "twitch.tv",
    "9gag.com",
  ],
};

// ─── In-memory state (restored from storage on init) ──────────────────────────
let state = {
  token: null,
  employeeId: null,
  employeeName: null,
  sessionId: null, // WorkSession.id from the DB
  clockedIn: false,
  clockInTime: null,
  // current tab tracking
  currentTabId: null,
  currentUrl: null,
  currentTitle: null,
  currentTabStart: null,
  windowFocused: true,
  idleStart: null,
  // data buffer (flushed to backend every SYNC_INTERVAL_MIN)
  buffer: [],
  // today's rolling summary
  todaySummary: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function categorize(url, title = "") {
  if (!url) return "other";
  const domain = getDomain(url);
  const combined = `${domain} ${title}`.toLowerCase();
  for (const [cat, patterns] of Object.entries(CATEGORY_MAP)) {
    if (patterns.some((p) => combined.includes(p))) return cat;
  }
  return "other";
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function isIgnoredUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("edge://")
  );
}

// ─── Summary helpers ──────────────────────────────────────────────────────────

function ensureTodaySummary() {
  const today = todayKey();
  if (!state.todaySummary || state.todaySummary.date !== today) {
    state.todaySummary = {
      date: today,
      categories: {},
      totalMin: 0,
      idleMin: 0,
    };
  }
  return state.todaySummary;
}

function addToSummary(category, durationSec) {
  const summary = ensureTodaySummary();
  const min = Math.round(durationSec / 60);
  if (min <= 0) return;
  summary.categories[category] = (summary.categories[category] || 0) + min;
  summary.totalMin += min;
  chrome.storage.local.set({ todaySummary: summary });
}

function addIdleToSummary(durationSec) {
  const summary = ensureTodaySummary();
  summary.idleMin += Math.round(durationSec / 60);
  chrome.storage.local.set({ todaySummary: summary });
}

// ─── Core tracking ────────────────────────────────────────────────────────────

function recordCurrentTab(endTime = Date.now()) {
  if (!state.clockedIn) {
    console.log("[trackR] Skip: not clocked in");
    return;
  }
  if (!state.token) {
    console.log("[trackR] Skip: no token");
    return;
  }
  if (!state.currentUrl) {
    console.log("[trackR] Skip: no currentUrl");
    return;
  }
  if (isIgnoredUrl(state.currentUrl)) {
    console.log("[trackR] Skip: ignored URL -", state.currentUrl);
    return;
  }
  if (!state.currentTabStart) {
    console.log("[trackR] Skip: no currentTabStart");
    return;
  }
  if (!state.windowFocused) {
    console.log("[trackR] Skip: window not focused");
    return;
  }

  const durationSec = Math.round((endTime - state.currentTabStart) / 1000);
  if (durationSec < 3) {
    console.log("[trackR] Skip: dwell < 3s -", durationSec + "s");
    return;
  }

  const category = categorize(state.currentUrl, state.currentTitle);
  const event = {
    type: "tab_visit",
    url: state.currentUrl,
    domain: getDomain(state.currentUrl),
    title: state.currentTitle || "",
    category,
    ts: state.currentTabStart, // epoch ms when tab was opened
    dwell: durationSec, // seconds on tab
  };

  state.buffer.push(event);
  addToSummary(category, durationSec);
  chrome.storage.local.set({ buffer: state.buffer });
  console.log(
    "[trackR] Recorded tab_visit:",
    event.domain,
    "(" + category + ")",
    durationSec + "s",
  );
  scheduleEagerSync(); // flush to server within EAGER_SYNC_MS
}

async function startTrackingTab(tab) {
  if (!tab) return;

  // Always claim the tab ID so onUpdated fires for this tab even while its URL
  // is still loading or is temporarily an ignored URL (e.g. chrome://newtab/).
  state.currentTabId = tab.id;

  if (isIgnoredUrl(tab.url)) {
    // Clear tracking state so we don't record stale dwell for the previous tab.
    state.currentUrl = null;
    state.currentTitle = null;
    state.currentTabStart = null;
    console.log("[trackR] Skip tab (ignored):", tab.url || "no url");
    return;
  }

  state.currentUrl = tab.url;
  state.currentTitle = tab.title || "";
  state.currentTabStart = Date.now();

  console.log(
    "[trackR] Tracking tab:",
    getDomain(state.currentUrl),
    "(" + (tab.title || "no title") + ")",
  );

  // Persist current activity for popup display
  await chrome.storage.local.set({
    currentActivity: {
      url: tab.url,
      domain: getDomain(tab.url),
      title: tab.title || "",
      category: categorize(tab.url, tab.title),
      since: Date.now(),
    },
  });
}

// ─── Tab listeners ────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  recordCurrentTab();
  try {
    const tab = await chrome.tabs.get(tabId);
    await startTrackingTab(tab);
  } catch (_) {}
  // If the content script didn't relay clock-in, discover it on tab switch
  if (!state.clockedIn && state.token) syncSessionState();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId !== state.currentTabId) return;
  if (!changeInfo.url && !changeInfo.title) return;
  recordCurrentTab();
  await startTrackingTab(tab);
});

// ─── Window focus ─────────────────────────────────────────────────────────────

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Browser lost focus — user switched to another app
    recordCurrentTab();
    state.windowFocused = false;
    state.currentTabStart = null;

    if (state.clockedIn && state.token) {
      state.buffer.push({ type: "focus_lost", ts: Date.now() });
      chrome.storage.local.set({ buffer: state.buffer });
    }
  } else {
    // Browser regained focus
    state.windowFocused = true;
    state.currentTabStart = Date.now();

    if (state.clockedIn && state.token) {
      state.buffer.push({ type: "focus_gained", ts: Date.now() });
      chrome.storage.local.set({ buffer: state.buffer });
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab) await startTrackingTab(tab);
    } catch (_) {}
  }
});

// ─── Idle detection ───────────────────────────────────────────────────────────

chrome.idle.onStateChanged.addListener(async (newState) => {
  if (newState === "idle" || newState === "locked") {
    recordCurrentTab();
    state.idleStart = Date.now();
    state.windowFocused = false;
    state.currentTabStart = null;
  } else if (newState === "active") {
    if (state.idleStart && state.clockedIn && state.token) {
      const durationSec = Math.round((Date.now() - state.idleStart) / 1000);
      state.buffer.push({
        type: "idle",
        ts: state.idleStart, // epoch ms idle started
        dwell: durationSec,
      });
      addIdleToSummary(durationSec);
      chrome.storage.local.set({ buffer: state.buffer });
    }
    state.idleStart = null;
    state.windowFocused = true;
    state.currentTabStart = Date.now();

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab) await startTrackingTab(tab);
    } catch (_) {}
  }
});

// ─── Periodic checkpoint (records same-tab dwell for live updates) ──────────────

let checkpointTimer = null;
const CHECKPOINT_INTERVAL_SEC = 30; // Record activity every 30s even on same tab

function scheduleCheckpoint() {
  if (checkpointTimer) return;
  if (!state.clockedIn) return;

  checkpointTimer = setTimeout(() => {
    checkpointTimer = null;
    if (
      state.clockedIn &&
      state.currentUrl &&
      state.windowFocused &&
      state.currentTabStart
    ) {
      const durationSec = Math.round(
        (Date.now() - state.currentTabStart) / 1000,
      );
      if (durationSec >= 3) {
        const category = categorize(state.currentUrl, state.currentTitle);
        const event = {
          type: "tab_visit",
          url: state.currentUrl,
          domain: getDomain(state.currentUrl),
          title: state.currentTitle || "",
          category,
          ts: state.currentTabStart,
          dwell: durationSec,
        };
        state.buffer.push(event);
        addToSummary(category, durationSec);
        chrome.storage.local.set({ buffer: state.buffer });
        console.log(
          "[trackR] Checkpoint:",
          event.domain,
          "(" + category + ")",
          durationSec + "s",
        );

        state.currentTabStart = Date.now();
        scheduleEagerSync();
      }
    }
    // Always schedule next checkpoint
    scheduleCheckpoint();
  }, CHECKPOINT_INTERVAL_SEC * 1000);
}

// ─── Session state poll ───────────────────────────────────────────────────────
// Discovers clock-in/out that happened in the web app when the content script
// wasn't injected (e.g. the app is served via a tunnel like ngrok).

async function syncSessionState() {
  if (!state.token || !state.employeeId) return;

  try {
    const res = await fetch(
      `${TRACKR_ORIGIN}/api/sessions/active?employeeId=${encodeURIComponent(state.employeeId)}`,
      { headers: { Authorization: `Bearer ${state.token}` } }
    );
    if (!res.ok) return;
    const data = await res.json();

    if (data.session) {
      const wasClocked = state.clockedIn;
      state.clockedIn = true;
      state.sessionId  = data.session.id;

      await chrome.storage.local.set({ clockedIn: true, sessionId: data.session.id });

      if (!wasClocked) {
        // Session was started from the web app — start tracking from now
        state.currentTabStart = Date.now();
        ensureTodaySummary();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
        if (tab) await startTrackingTab(tab);
        scheduleCheckpoint();
        console.log("[trackR] Session discovered via poll:", data.session.id);
      }
    } else {
      if (state.clockedIn) {
        // Session ended in the web app while content script wasn't relaying it
        recordCurrentTab();
        if (checkpointTimer) { clearTimeout(checkpointTimer); checkpointTimer = null; }
        await syncToBackend({ noRetry: true });
        state.clockedIn  = false;
        state.sessionId  = null;
        state.currentTabStart = null;
        await chrome.storage.local.set({ clockedIn: false, sessionId: null });
        console.log("[trackR] Session ended (detected via poll)");
      }
    }
  } catch (err) {
    console.warn("[trackR] syncSessionState failed:", err.message);
  }
}

// ─── Periodic sync ────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") {
    syncToBackend();
    syncSessionState();
  }
});

// Eager sync — called right after a tab visit is recorded so the dashboard
// sees activity within ~20s instead of waiting for the 1-minute alarm.
let eagerSyncTimer = null;
function scheduleEagerSync() {
  if (eagerSyncTimer) return; // already scheduled
  eagerSyncTimer = setTimeout(() => {
    eagerSyncTimer = null;
    syncToBackend();
  }, EAGER_SYNC_MS);
}

// noRetry: true at session end so that failed events are dropped rather than
// re-queued — this prevents old events from being sent under a future sessionId.
async function syncToBackend({ noRetry = false } = {}) {
  if (!state.token) {
    console.log("[trackR] Sync skipped: no token");
    return;
  }
  if (state.buffer.length === 0) {
    console.log("[trackR] Sync skipped: buffer empty");
    return;
  }

  const toSync = [...state.buffer];
  state.buffer = [];
  chrome.storage.local.set({ buffer: [] });

  console.log("[trackR] Syncing", toSync.length, "events to backend...");

  try {
    const res = await fetch(`${TRACKR_ORIGIN}/api/extension/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({
        employeeId: state.employeeId,
        sessionId: state.sessionId,
        events: toSync,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    chrome.storage.local.set({ lastSync: new Date().toISOString() });
    console.log(
      "[trackR] ✓ Sync successful:",
      data.received,
      "events accepted",
    );
  } catch (err) {
    if (noRetry) {
      // Drop events rather than re-queue — prevents contaminating the next session
      console.warn(
        "[trackR] ✗ Sync failed at session end, events dropped:",
        err.message,
      );
    } else {
      // Put events back — they'll retry on the next alarm
      state.buffer = [...toSync, ...state.buffer];
      chrome.storage.local.set({ buffer: state.buffer });
      console.warn("[trackR] ✗ Sync failed:", err.message);
    }
  }
}

// ─── Send WRITE_STORAGE to all open trackR web app tabs ───────────────────────

async function writeToWebApp(key, value) {
  const tabs = await chrome.tabs
    .query({ url: `${TRACKR_ORIGIN}/*` })
    .catch(() => []);
  for (const tab of tabs) {
    chrome.tabs
      .sendMessage(tab.id, { type: "WRITE_STORAGE", key, value })
      .catch(() => {});
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    // Auth token received from content/auth.js
    case "AUTH_TOKEN": {
      state.token = msg.token;
      state.employeeId = msg.employeeId;
      state.employeeName = msg.name;
      chrome.storage.local.set({
        token: msg.token,
        employeeId: msg.employeeId,
        employeeName: msg.name,
      });
      console.log(
        "[trackR] ✓ Authenticated as",
        msg.name,
        "(ID:",
        msg.employeeId + ")",
      );
      sendResponse({ ok: true });
      break;
    }

    case "AUTH_CLEARED": {
      state.token = null;
      state.employeeId = null;
      state.employeeName = null;
      state.clockedIn = false;
      chrome.storage.local.remove([
        "token",
        "employeeId",
        "employeeName",
        "clockedIn",
      ]);
      console.log("[trackR] Auth cleared");
      sendResponse({ ok: true });
      break;
    }

    // Clock in from the extension popup — creates a WorkSession, syncs to web app
    case "CLOCK_IN": {
      (async () => {
        // Clear any stale buffer from a previous session before starting fresh
        state.buffer = [];
        await chrome.storage.local.set({ buffer: [] });
        state.clockedIn = true;
        state.currentTabStart = Date.now();
        ensureTodaySummary();
        console.log("[trackR] Clock in initiated");

        try {
          const res = await fetch(`${TRACKR_ORIGIN}/api/sessions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${state.token}`,
            },
            body: JSON.stringify({ employeeId: state.employeeId }),
          });
          const data = await res.json();
          // Use the server's clockIn timestamp — this is the source of truth
          state.sessionId = data.sessionId;
          state.clockInTime = data.clockIn; // ISO string from DB

          await chrome.storage.local.set({
            clockedIn: true,
            clockInTime: data.clockIn,
            sessionId: data.sessionId,
          });

          console.log("[trackR] ✓ Clocked in, session:", data.sessionId);

          // Tell the web app so its timer syncs immediately
          await writeToWebApp("trackr_clock_in_time", data.clockIn);
          await writeToWebApp("trackr_session_id", data.sessionId);
        } catch (err) {
          // Fallback: local time if API fails
          state.clockInTime = new Date().toISOString();
          await chrome.storage.local.set({
            clockedIn: true,
            clockInTime: state.clockInTime,
          });
          console.warn("[trackR] Clock in failed, using local time:", err);
        }

        const [tab] = await chrome.tabs
          .query({ active: true, currentWindow: true })
          .catch(() => []);
        if (tab) await startTrackingTab(tab);

        // Start periodic checkpoint for live activity updates
        scheduleCheckpoint();

        sendResponse({ ok: true, sessionId: state.sessionId });
      })();
      return true;
    }

    // Clock out from the extension popup — close session, flush, sync to web app
    case "CLOCK_OUT": {
      recordCurrentTab();
      // Stop checkpoint timer
      if (checkpointTimer) {
        clearTimeout(checkpointTimer);
        checkpointTimer = null;
      }
      state.clockedIn = false;
      state.currentTabStart = null;
      console.log("[trackR] Clock out initiated");
      (async () => {
        try {
          if (state.sessionId) {
            await fetch(`${TRACKR_ORIGIN}/api/sessions/${state.sessionId}`, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${state.token}` },
            });
          }
        } catch {
          /* non-fatal */
        }

        await syncToBackend({ noRetry: true });

        // Tell the web app the session is over
        await writeToWebApp("trackr_session_id", null);
        await writeToWebApp("trackr_clock_in_time", null);

        state.sessionId = null;
        state.clockInTime = null;
        await chrome.storage.local.set({
          clockedIn: false,
          sessionId: null,
          clockInTime: null,
        });
        sendResponse({ ok: true });
      })();
      return true;
    }

    // Web app clocked in — update state and start tracking (no API call needed)
    case "CLOCK_IN_FROM_WEB": {
      (async () => {
        // Only clear the buffer when this is a genuinely new session.
        // On page refresh, restoreSession fires CLOCK_IN_FROM_WEB with the same
        // sessionId — preserve the buffer so in-flight events aren't lost.
        if (msg.sessionId && msg.sessionId !== state.sessionId) {
          state.buffer = [];
          await chrome.storage.local.set({ buffer: [] });
        }
        state.clockedIn = true;
        state.sessionId = msg.sessionId;
        state.clockInTime = msg.clockInTime; // ISO string from server
        state.currentTabStart = Date.now();
        ensureTodaySummary();

        await chrome.storage.local.set({
          clockedIn: true,
          clockInTime: msg.clockInTime,
          sessionId: msg.sessionId,
        });

        const [tab] = await chrome.tabs
          .query({ active: true, currentWindow: true })
          .catch(() => []);
        if (tab) await startTrackingTab(tab);

        // Start periodic checkpoint
        scheduleCheckpoint();

        sendResponse({ ok: true });
      })();
      return true;
    }

    // Web app clocked out — stop tracking, flush buffer (no API call needed)
    case "CLOCK_OUT_FROM_WEB": {
      recordCurrentTab();
      // Stop checkpoint timer
      if (checkpointTimer) {
        clearTimeout(checkpointTimer);
        checkpointTimer = null;
      }
      state.clockedIn = false;
      state.currentTabStart = null;
      (async () => {
        await syncToBackend({ noRetry: true });
        state.sessionId = null;
        state.clockInTime = null;
        await chrome.storage.local.set({
          clockedIn: false,
          sessionId: null,
          clockInTime: null,
        });
        sendResponse({ ok: true });
      })();
      return true;
    }

    // Session changed from web app — keep sessionId and clockInTime in sync
    case "SESSION_CHANGED": {
      state.sessionId = msg.sessionId;
      if (msg.clockInTime) state.clockInTime = msg.clockInTime;
      chrome.storage.local.set({
        sessionId: msg.sessionId,
        ...(msg.clockInTime ? { clockInTime: msg.clockInTime } : {}),
      });
      sendResponse({ ok: true });
      break;
    }

    // Popup requests current state
    case "GET_STATE": {
      sendResponse({
        token: state.token,
        employeeId: state.employeeId,
        employeeName: state.employeeName,
        clockedIn: state.clockedIn,
        clockInTime: state.clockInTime,
        currentUrl: state.currentUrl,
        currentTitle: state.currentTitle,
        currentCategory: categorize(state.currentUrl, state.currentTitle),
        currentSince: state.currentTabStart,
        bufferSize: state.buffer.length,
        todaySummary: state.todaySummary,
      });
      break;
    }

    // Enriched title from github.js
    case "TAB_ENRICHED": {
      if (state.currentTitle !== msg.title) {
        recordCurrentTab();
        state.currentTitle = msg.title;
        state.currentTabStart = Date.now();
        chrome.storage.local.set({
          currentActivity: {
            url: state.currentUrl,
            domain: getDomain(state.currentUrl),
            title: msg.title,
            category: categorize(state.currentUrl, msg.title),
            since: Date.now(),
          },
        });
      }
      break;
    }

    // Meeting state from meet.js
    case "MEETING_STATE": {
      if (state.clockedIn && state.token && msg.inCall) {
        state.buffer.push({
          type: "meeting_active",
          platform: msg.platform,
          title: msg.title,
          ts: Date.now(),
        });
        chrome.storage.local.set({ buffer: state.buffer });
      }
      break;
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.local.get([
    "token",
    "employeeId",
    "employeeName",
    "sessionId",
    "clockedIn",
    "clockInTime",
    "buffer",
    "todaySummary",
  ]);

  console.log("[trackR] Initializing background service worker...");

  if (stored.token) state.token = stored.token;
  if (stored.employeeId) state.employeeId = stored.employeeId;
  if (stored.employeeName) state.employeeName = stored.employeeName;
  if (stored.sessionId) state.sessionId = stored.sessionId;
  if (stored.clockedIn) state.clockedIn = stored.clockedIn;
  if (stored.clockInTime) state.clockInTime = stored.clockInTime;
  if (stored.buffer) state.buffer = stored.buffer;

  // Reset summary if it's from a previous day
  if (stored.todaySummary?.date === todayKey()) {
    state.todaySummary = stored.todaySummary;
  }

  console.log("[trackR] Restored state:", {
    authenticated: !!state.token,
    clockedIn: state.clockedIn,
    bufferSize: state.buffer?.length || 0,
  });

  chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SEC);

  // Clear old alarm and create a fresh one
  await chrome.alarms.clear("sync");
  chrome.alarms.create("sync", { periodInMinutes: SYNC_INTERVAL_MIN });

  // Start tracking whatever tab is currently active
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab) await startTrackingTab(tab);
  } catch (_) {}

  // Restart checkpoint timer if we restored a clocked-in session from storage
  if (state.clockedIn) scheduleCheckpoint();

  // Sync session state from server on startup (catches sessions started via web app)
  if (state.token && state.employeeId) syncSessionState();

  console.log("[trackR] ✓ Background service worker initialized");
}

init();
