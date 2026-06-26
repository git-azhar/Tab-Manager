// ═══════════════════════════════════════════════════════════════════════
//  TAB MANAGER PRO — background.js v3.4
// ═══════════════════════════════════════════════════════════════════════

const SWEEP_ALARM  = "stm_sweep"
const MEM_KEY      = "stm_mem"
const MEM_HISTORY  = "stm_mem_history"

const DEFAULT_SETTINGS = {
  enabled:            true,
  sweepMinutes:       1,
  idleSeconds:        60,
  globalTimeout:      10,
  notifyOnClose:      true,
  notifyOnWarn:       true,
  warnBeforeMinutes:  2,
  closeActiveIfIdle:  true,
  closeOnlyIfIdle:    false,
  autoReloadOnClose:  false,
  pauseSchedule:      null,
  badgeEnabled:       true,
}

const DEFAULT_RULES = [{
  id:               "rule_default",
  name:             "Support Portal",
  pattern:          "support.sergas.com",
  matchType:        "contains",
  timeout:          10,
  enabled:          true,
  snoozeUntil:      null,
  priority:         1,
  color:            "#E87722",
  action:           "close",
  groupName:        "",
  closeAfterVisits: 0,
}]

let settings = { ...DEFAULT_SETTINGS }
let rules    = [...DEFAULT_RULES]
const snoozed = {}

// ── Storage ──────────────────────────────────────────────────────────────────
function actKey(id)  { return `act_${id}` }
function warnKey(id) { return `warn_${id}` }

async function touch(tabId, ts) {
  await chrome.storage.local.set({ [actKey(tabId)]: ts ?? Date.now() })
}
async function getLast(tabId) {
  const r = await chrome.storage.local.get(actKey(tabId))
  return r[actKey(tabId)] ?? null
}
async function forget(tabId) {
  await chrome.storage.local.remove([actKey(tabId), warnKey(tabId)])
  delete snoozed[tabId]
}
async function setWarned(tabId) {
  await chrome.storage.local.set({ [warnKey(tabId)]: true })
}
async function hasWarned(tabId) {
  const r = await chrome.storage.local.get(warnKey(tabId))
  return !!r[warnKey(tabId)]
}

// ── Analytics ─────────────────────────────────────────────────────────────────
async function getAnalytics() {
  const r = await chrome.storage.local.get("analytics")
  return r.analytics || {
    totalClosed: 0, totalWarned: 0, totalSnoozed: 0,
    sessionStart: Date.now(), closedToday: 0,
    lastDate: new Date().toDateString(), history: [],
  }
}

async function bumpAnalytics(field, extra = {}) {
  const a = await getAnalytics()
  const today = new Date().toDateString()
  if (a.lastDate !== today) { a.closedToday = 0; a.lastDate = today }
  a[field] = (a[field] || 0) + 1
  if (field === "totalClosed") {
    a.closedToday++
    a.history = [{ ts: Date.now(), ...extra }, ...a.history].slice(0, 50)
  }
  await chrome.storage.local.set({ analytics: a })
}

// ── Settings / rules ──────────────────────────────────────────────────────────
async function loadAll() {
  const r = await chrome.storage.sync.get(["settings", "rules"])
  if (r.settings) settings = { ...DEFAULT_SETTINGS, ...r.settings }
  if (r.rules && r.rules.length > 0) rules = r.rules
}
async function saveAll() {
  await chrome.storage.sync.set({ settings, rules })
}

// ── Alarm ─────────────────────────────────────────────────────────────────────
function ensureAlarm() {
  chrome.alarms.getAll(all => {
    if (!all.some(a => a.name === SWEEP_ALARM)) {
      chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: Math.max(0.5, settings.sweepMinutes || 1) })
    }
  })
}
function resetAlarm() {
  chrome.alarms.clear(SWEEP_ALARM, () => {
    chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: Math.max(0.5, settings.sweepMinutes || 1) })
  })
}

// ── Rule matching ─────────────────────────────────────────────────────────────
function matchRule(url) {
  if (!url) return null
  const active = rules
    .filter(r => r.enabled && (!r.snoozeUntil || Date.now() > r.snoozeUntil))
    .sort((a, b) => (b.priority || 1) - (a.priority || 1))
  for (const rule of active) {
    try {
      let hit = false
      const p = rule.pattern || ""
      switch (rule.matchType) {
        case "startsWith": hit = url.startsWith(p); break
        case "exact":      hit = url === p; break
        case "regex":      hit = new RegExp(p, "i").test(url); break
        default:           hit = url.toLowerCase().includes(p.toLowerCase())
      }
      if (hit) return rule
    } catch (_) {}
  }
  return null
}

// ── Pause schedule ─────────────────────────────────────────────────────────────
function isPaused() {
  const s = settings.pauseSchedule
  if (!s || !s.from || !s.to) return false
  try {
    const now = new Date()
    const cur = now.getHours() * 60 + now.getMinutes()
    const [fH, fM] = s.from.split(":").map(Number)
    const [tH, tM] = s.to.split(":").map(Number)
    const from = fH * 60 + fM, to = tH * 60 + tM
    return from <= to ? (cur >= from && cur <= to) : (cur >= from || cur <= to)
  } catch (_) { return false }
}

// ── Badge ──────────────────────────────────────────────────────────────────────
async function updateBadge() {
  try {
    if (!settings.badgeEnabled) { await chrome.action.setBadgeText({ text: "" }); return }
    const tabs  = await chrome.tabs.query({})
    const count = tabs.filter(t => t.url && matchRule(t.url)).length
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" })
    await chrome.action.setBadgeBackgroundColor({ color: "#E87722" })
  } catch (_) {}
}

// ── Action ─────────────────────────────────────────────────────────────────────
async function performAction(tab, rule) {
  const action = rule.action || "close"
  try {
    if (action === "reload") {
      await chrome.tabs.reload(tab.id)
      await touch(tab.id)
      await bumpAnalytics("totalClosed", {
        url: tab.url, title: tab.title, action: "reload",
        rule: rule.name, favIconUrl: tab.favIconUrl || ""
      })
      return
    }
    if (action === "mute") {
      await chrome.tabs.update(tab.id, { muted: true })
      await touch(tab.id)
      return
    }
    if (action === "group") {
      try {
        const groups = await chrome.tabGroups.query({})
        const existing = groups.find(g => g.title === (rule.groupName || "Inactive"))
        if (existing) {
          await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id })
        } else {
          const gid = await chrome.tabs.group({ tabIds: [tab.id] })
          await chrome.tabGroups.update(gid, { title: rule.groupName || "Inactive", color: "orange" })
        }
        await touch(tab.id)
      } catch (_) {}
      return
    }
    // close
    if (settings.notifyOnClose) {
      chrome.notifications.create(`stm_${tab.id}_${Date.now()}`, {
        type: "basic", iconUrl: "icon128.png",           // ← FIXED
        title: "Tab auto-closed",
        message: `${tab.title || "Tab"} — idle ${rule.timeout}m`
      })
    }
    await bumpAnalytics("totalClosed", {
      url: tab.url, title: tab.title, action: "close",
      rule: rule.name, favIconUrl: tab.favIconUrl || ""  // ← store favicon
    })
    await chrome.tabs.remove(tab.id)
    await forget(tab.id)
    if (settings.autoReloadOnClose) {
      const rem = await chrome.tabs.query({})
      if (rem.length === 0) chrome.tabs.create({ url: "chrome://newtab" })
    }
  } catch (_) {}
}

// ── Sweep ──────────────────────────────────────────────────────────────────────
async function sweep() {
  if (!settings.enabled) return
  if (isPaused()) return
  const now       = Date.now()
  const idleState = await chrome.idle.queryState(Math.max(15, settings.idleSeconds || 60))
  const sysIdle   = idleState !== "active"
  const tabs      = await chrome.tabs.query({})
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue
    if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue
    const rule = matchRule(tab.url)
    if (!rule) continue
    if (snoozed[tab.id] && now < snoozed[tab.id]) continue
    const timeoutMs = rule.timeout * 60 * 1000
    const warnMs    = (settings.warnBeforeMinutes || 2) * 60 * 1000
    if (tab.active) {
      if (settings.closeOnlyIfIdle && !sysIdle) { await touch(tab.id); continue }
      if (!settings.closeActiveIfIdle && !settings.closeOnlyIfIdle) { await touch(tab.id); continue }
      if (!sysIdle && !settings.closeOnlyIfIdle) { await touch(tab.id); continue }
    }
    let last = await getLast(tab.id)
    if (!last) { last = tab.lastAccessed ?? now; await touch(tab.id, last); continue }
    const elapsed   = now - last
    const remaining = timeoutMs - elapsed
    if (settings.notifyOnWarn && remaining <= warnMs && remaining > 0) {
      if (!(await hasWarned(tab.id))) {
        await setWarned(tab.id)
        await bumpAnalytics("totalWarned")
        chrome.notifications.create(`stmw_${tab.id}_${now}`, {
          type: "basic", iconUrl: "icon128.png",         // ← FIXED
          title: "⚠ Tab closing soon",
          message: `${tab.title || "Tab"} closes in ~${Math.ceil(remaining / 60000)}m`
        })
      }
    }
    if (elapsed >= timeoutMs) await performAction(tab, rule)
  }
  await updateBadge()
}

// ── Memory snapshot ───────────────────────────────────────────────────────────
async function snapshotTabMemory() {
  const tabs = await chrome.tabs.query({})
  const now  = Date.now()
  const snap = {}
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue
    if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const m = performance?.memory
          return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit } : null
        },
      }).catch(() => null)
      snap[tab.id] = {
        tabId: tab.id, title: tab.title || tab.url, url: tab.url,
        favIconUrl: tab.favIconUrl || "",
        ts: now, mem: results?.[0]?.result ?? null,
        active: tab.active, matched: !!matchRule(tab.url),
      }
    } catch (_) {
      snap[tab.id] = {
        tabId: tab.id, title: tab.title || tab.url, url: tab.url,
        favIconUrl: tab.favIconUrl || "",
        ts: now, mem: null, active: tab.active, matched: !!matchRule(tab.url),
      }
    }
  }
  await chrome.storage.local.set({ [MEM_KEY]: snap })
  // Rolling history
  const histRaw = await chrome.storage.local.get(MEM_HISTORY)
  const hist    = histRaw[MEM_HISTORY] || {}
  for (const [tid, info] of Object.entries(snap)) {
    if (!info.mem) continue
    if (!hist[tid]) hist[tid] = []
    hist[tid].push({ ts: now, used: info.mem.used })
    if (hist[tid].length > 60) hist[tid] = hist[tid].slice(-60)
  }
  const openIds = new Set(tabs.map(t => String(t.id)))
  for (const tid of Object.keys(hist)) {
    if (!openIds.has(tid)) delete hist[tid]
  }
  await chrome.storage.local.set({ [MEM_HISTORY]: hist })
}

async function getMemorySnapshot() {
  const r = await chrome.storage.local.get([MEM_KEY, MEM_HISTORY])
  return { snapshot: r[MEM_KEY] || {}, history: r[MEM_HISTORY] || {} }
}

// ── Cache / browsing data ─────────────────────────────────────────────────────
async function clearTabCache(url) {
  try {
    const origin = new URL(url).origin
    await chrome.browsingData.remove({ origins: [origin] }, { cache: true, cacheStorage: true })
    return { ok: true, origin }
  } catch (e) { return { ok: false, error: e.message } }
}
async function clearCookiesForTab(url) {
  try {
    const origin = new URL(url).origin
    await chrome.browsingData.remove({ origins: [origin] }, { cookies: true })
    return { ok: true, origin }
  } catch (e) { return { ok: false, error: e.message } }
}
async function clearStorageForTab(url) {
  try {
    const origin = new URL(url).origin
    await chrome.browsingData.remove({ origins: [origin] }, { localStorage: true, indexedDB: true, serviceWorkers: true })
    return { ok: true, origin }
  } catch (e) { return { ok: false, error: e.message } }
}
async function clearAllTrackedCache() {
  const tabs    = await chrome.tabs.query({})
  const origins = new Set()
  for (const tab of tabs) {
    if (tab.url && matchRule(tab.url)) {
      try { origins.add(new URL(tab.url).origin) } catch (_) {}
    }
  }
  const results = []
  for (const origin of origins) {
    try {
      await chrome.browsingData.remove({ origins: [origin] }, { cache: true, cacheStorage: true })
      results.push({ origin, ok: true })
    } catch (e) {
      results.push({ origin, ok: false })
    }
  }
  return results
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => { await loadAll(); resetAlarm(); updateBadge() })
chrome.runtime.onStartup.addListener(async  () => { await loadAll(); resetAlarm(); updateBadge() })
;(async () => { await loadAll(); ensureAlarm(); updateBadge() })()

chrome.idle.setDetectionInterval(60)
chrome.tabs.onActivated.addListener(async ({ tabId })      => { await touch(tabId); await updateBadge() })
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) { await touch(tabId); await updateBadge() }
})
chrome.tabs.onRemoved.addListener(async (tabId) => { await forget(tabId); await updateBadge() })

// Memory snapshot alarm (every 30s)
chrome.alarms.create("stm_memory", { periodInMinutes: 0.5 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SWEEP_ALARM) { await loadAll(); await sweep() }
  if (alarm.name === "stm_memory") { await snapshotTabMemory().catch(() => {}) }
})

// ── SINGLE message handler (all cases in one switch) ─────────────────────────
// BUG FIX: previously memory/cache had a separate second listener which caused
// the first listener to respond with "unknown type" before the second could fire.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  ;(async () => {
    try {
      await loadAll()
      switch (msg.type) {

        case "GET_FULL_STATE": {
          const tabs      = await chrome.tabs.query({})
          const now       = Date.now()
          const analytics = await getAnalytics()
          const tabInfos  = await Promise.all(
            tabs
              .filter(t => t.url &&
                !t.url.startsWith("chrome-extension://") &&
                !t.url.startsWith("devtools://"))
              .map(async tab => {
                const tabUrl     = tab.url || tab.pendingUrl || ""
                const rule       = matchRule(tabUrl)
                const last       = await getLast(tab.id)
                const timeoutMs  = rule ? rule.timeout * 60000 : null
                const elapsed    = last != null ? now - last : null
                const remaining  = (elapsed != null && timeoutMs != null)
                  ? Math.max(0, timeoutMs - elapsed) : null
                const snoozeLeft = snoozed[tab.id] ? Math.max(0, snoozed[tab.id] - now) : 0
                const pct        = (remaining != null && timeoutMs)
                  ? Math.round((remaining / timeoutMs) * 100) : null
                return {
                  id: tab.id, title: tab.title || tab.url || "Untitled",
                  url: tabUrl, favIconUrl: tab.favIconUrl || "",
                  active: tab.active || false, pinned: tab.pinned || false,
                  matched: !!rule, ruleName: rule?.name ?? null,
                  ruleColor: rule?.color ?? null, ruleAction: rule?.action ?? null,
                  elapsed, remaining, timeoutMs, snoozeLeft, pct,
                }
              })
          )
          respond({ settings, rules, tabInfos, analytics, now, paused: isPaused() })
          break
        }

        case "SAVE_SETTINGS": {
          settings = { ...settings, ...msg.payload }
          await saveAll(); resetAlarm(); await updateBadge()
          respond({ ok: true }); break
        }

        case "SAVE_RULES": {
          rules = msg.payload || []
          await saveAll(); respond({ ok: true }); break
        }

        case "CLOSE_TAB": {
          const tid = msg.tabId
          // Get tab info first so history has real URL/title/favicon
          const tabInfo = await chrome.tabs.get(tid).catch(() => null)
          await bumpAnalytics("totalClosed", {
            url:        tabInfo?.url   || "",
            title:      tabInfo?.title || "Closed tab",
            action:     "manual",
            rule:       "",
            favIconUrl: tabInfo?.favIconUrl || "",
          })
          await chrome.tabs.remove(tid)
          await forget(tid)
          respond({ ok: true }); break
        }

        case "SNOOZE_TAB": {
          const tid   = msg.tabId
          const until = Date.now() + (msg.payload?.minutes || msg.minutes || 30) * 60000
          snoozed[tid] = until
          await touch(tid, Date.now())
          await bumpAnalytics("totalSnoozed")
          respond({ ok: true, until }); break
        }

        case "RESET_TAB": {
          const tid = msg.tabId
          await touch(tid)
          await chrome.storage.local.remove(warnKey(tid))
          respond({ ok: true }); break
        }

        case "FOCUS_TAB": {
          const tab = await chrome.tabs.get(msg.tabId)
          await chrome.windows.update(tab.windowId, { focused: true })
          await chrome.tabs.update(msg.tabId, { active: true })
          respond({ ok: true }); break
        }

        case "CLOSE_ALL_MATCHED": {
          const tabs = await chrome.tabs.query({})
          let count  = 0
          for (const tab of tabs) {
            if (tab.url && matchRule(tab.url)) {
              try { await chrome.tabs.remove(tab.id); count++ } catch (_) {}
            }
          }
          respond({ ok: true, count }); break
        }

        case "SWEEP_NOW": {
          await sweep(); respond({ ok: true }); break
        }

        case "RESET_ANALYTICS": {
          await chrome.storage.local.set({ analytics: {
            totalClosed: 0, totalWarned: 0, totalSnoozed: 0,
            sessionStart: Date.now(), closedToday: 0,
            lastDate: new Date().toDateString(), history: [],
          }})
          respond({ ok: true }); break
        }

        // ── Memory & Cache (FIX: merged here, no longer in separate listener) ──

        case "GET_MEMORY": {
          const data = await getMemorySnapshot()
          respond(data); break
        }

        case "SNAPSHOT_MEMORY": {
          await snapshotTabMemory().catch(() => {})
          const data = await getMemorySnapshot()
          respond(data); break
        }

        case "CLEAR_CACHE": {
          const r = await clearTabCache(msg.url)
          respond(r); break
        }

        case "CLEAR_COOKIES": {
          const r = await clearCookiesForTab(msg.url)
          respond(r); break
        }

        case "CLEAR_STORAGE": {
          const r = await clearStorageForTab(msg.url)
          respond(r); break
        }

        case "CLEAR_ALL_CACHE": {
          const results = await clearAllTrackedCache()
          respond({ ok: true, results }); break
        }

        default:
          respond({ error: "unknown message type: " + msg.type })
      }
    } catch (err) {
      respond({ error: err.message })
    }
  })()
  return true  // keep channel open for async
})

// Initial memory snapshot
snapshotTabMemory().catch(() => {})
