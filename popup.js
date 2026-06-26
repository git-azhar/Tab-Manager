// ══════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════
let S = null
let editingRuleId = null
let selectedColor = "#E87722"
let refreshTimer  = null
const SNOOZE_OPTIONS = [5, 15, 30, 60]

// ══════════════════════════════════════════════════════
//  THEME — light/dark toggle, persisted in localStorage
// ══════════════════════════════════════════════════════
const btnTheme = document.getElementById('btn-theme')

function applyTheme(light) {
  document.body.classList.toggle('light', light)
  btnTheme.textContent = light ? '🌙' : '☀️'
  btnTheme.title = light ? 'Switch to dark theme' : 'Switch to light theme'
}

// Load saved preference (default: dark)
applyTheme(localStorage.getItem('tm_theme') === 'light')

btnTheme.addEventListener('click', () => {
  const goLight = !document.body.classList.contains('light')
  localStorage.setItem('tm_theme', goLight ? 'light' : 'dark')
  applyTheme(goLight)
})

// ══════════════════════════════════════════════════════
//  MESSAGING
// ══════════════════════════════════════════════════════
function send(type, payload = {}, extra = {}) {
  return new Promise(res => {
    const msg = { type, payload, ...extra }
    function attempt(retries) {
      chrome.runtime.sendMessage(msg, r => {
        if (chrome.runtime.lastError) {
          if (retries > 0) { setTimeout(() => attempt(retries - 1), 300) }
          else res({})
          return
        }
        res(r || {})
      })
    }
    attempt(3)
  })
}

// ══════════════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════════════
function toast(msg, dur = 2000) {
  const el = document.getElementById('toast')
  el.textContent = msg; el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), dur)
}

// ══════════════════════════════════════════════════════
//  NAV
// ══════════════════════════════════════════════════════
document.querySelectorAll('.nb').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nb').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById('panel-' + btn.dataset.panel).classList.add('active')
    if (btn.dataset.panel === 'analytics') renderAnalytics(S?.analytics)
    if (btn.dataset.panel === 'memory')    loadMemory()
  })
})

// ══════════════════════════════════════════════════════
//  MASTER TOGGLE
// ══════════════════════════════════════════════════════
document.getElementById('mtoggle').addEventListener('click', async () => {
  const on = !S?.settings?.enabled
  await send('SAVE_SETTINGS', { enabled: on })
  toast(on ? '✅ Enabled' : '⏸ Paused')
  await refresh()
})

// ══════════════════════════════════════════════════════
//  TOOLBAR BUTTONS
// ══════════════════════════════════════════════════════
document.getElementById('btn-sweep').addEventListener('click', async () => {
  await send('SWEEP_NOW'); toast('⚡ Sweep triggered'); await refresh()
})
document.getElementById('btn-close-all').addEventListener('click', async () => {
  if (!confirm('Close all matched tabs now?')) return
  const r = await send('CLOSE_ALL_MATCHED')
  toast(`✕ Closed ${r.count || 0} tab(s)`); await refresh()
})

// ══════════════════════════════════════════════════════
//  RENDER BANNER + STATS
// ══════════════════════════════════════════════════════
function renderBanner(s) {
  if (!s) return
  const { settings, rules, tabInfos, analytics, paused } = s
  const matched     = tabInfos.filter(t => t.matched).length
  const activeRules = (rules || []).filter(r => r.enabled).length

  document.getElementById('sub').textContent =
    `Monitoring ${activeRules} rule${activeRules !== 1 ? 's' : ''} across ${matched} tab${matched !== 1 ? 's' : ''}`
  document.getElementById('ss-matched').textContent = matched
  document.getElementById('ss-rules').textContent   = activeRules
  document.getElementById('ss-sweep').textContent   = settings.sweepMinutes < 1
    ? Math.round(settings.sweepMinutes * 60) + 's' : settings.sweepMinutes + 'm'

  const mt = document.getElementById('mtoggle')
  const ml = mt.querySelector('.mlabel')
  if (settings.enabled && !paused) { mt.classList.add('on'); ml.textContent = 'ON' }
  else { mt.classList.remove('on'); ml.textContent = paused ? 'PAUSED' : 'OFF' }
  document.getElementById('pause-badge').style.display = paused ? 'flex' : 'none'

  document.getElementById('s-closed').textContent  = analytics?.totalClosed  ?? 0
  document.getElementById('s-today').textContent   = analytics?.closedToday  ?? 0
  document.getElementById('s-snoozed').textContent = analytics?.totalSnoozed ?? 0
  const upMs  = Date.now() - (analytics?.sessionStart ?? Date.now())
  const upMin = Math.floor(upMs / 60000)
  document.getElementById('s-uptime').textContent = upMin < 60
    ? upMin + 'm' : Math.floor(upMin / 60) + 'h' + (upMin % 60) + 'm'
}

// ══════════════════════════════════════════════════════
//  RENDER LIVE TABS
// ══════════════════════════════════════════════════════
function renderTabs(tabInfos) {
  const list = document.getElementById('tab-list')
  const sorted = [...tabInfos].sort((a, b) => {
    if (a.matched && !b.matched) return -1
    if (!a.matched && b.matched) return 1
    return 0
  })
  if (!sorted.length) {
    list.innerHTML = `<div class="empty-state"><div class="ei">🌐</div><div class="et">No tabs visible</div><div class="es">Chrome internal tabs are hidden.</div></div>`
    return
  }
  list.innerHTML = ''
  sorted.forEach(tab => {
    const el = document.createElement('div')
    const pct      = tab.pct ?? 100
    const barColor = pct > 60 ? '#22C55E' : pct > 25 ? '#F59E0B' : '#EF4444'
    const isSnoozed   = tab.snoozeLeft > 0
    const elapsedMin  = tab.elapsed    != null ? Math.floor(tab.elapsed / 60000)   : 0
    const remMin      = tab.remaining  != null ? Math.ceil(tab.remaining / 60000)  : null
    const snoozeMin   = isSnoozed ? Math.ceil(tab.snoozeLeft / 60000) : 0

    el.className = `tc ${tab.matched ? 'matched' : 'unmatched'} ${isSnoozed ? 'snoozed' : ''}`
    el.dataset.id = tab.id

    const favHtml = tab.favIconUrl
      ? `<img class="fav-img" src="${escHtml(tab.favIconUrl)}"/>`
      : '🌐'

    el.innerHTML = `
      <div class="tc-head">
        <div class="tc-fav">${favHtml}</div>
        <div class="tc-info">
          <div class="tc-title">${escHtml(tab.title || 'Untitled')}</div>
          <div class="tc-url">${escHtml(tab.url || '')}</div>
        </div>
      </div>
      ${tab.matched && !isSnoozed ? `<div class="tc-prog"><div class="tc-prog-bar" style="width:${pct}%;background:${barColor}"></div></div>` : ''}
      <div class="tc-meta">
        ${tab.active ? '<span class="badge b-active">● Active</span>' : `<span class="badge b-idle">${elapsedMin}m idle</span>`}
        ${tab.matched ? `<span class="badge b-rule" style="background:${tab.ruleColor}22;color:${tab.ruleColor}">${escHtml(tab.ruleName || '')}</span>` : '<span class="badge" style="background:rgba(255,255,255,.05);color:var(--text3)">untracked</span>'}
        ${isSnoozed ? `<span class="badge b-snoozed">💤 ${snoozeMin}m left</span>` : ''}
        <div class="tc-time">${tab.matched && !isSnoozed && remMin != null ? `${remMin}m left` : ''}</div>
      </div>
      <div class="tc-actions">
        <button class="ab focus"  data-act="focus"  data-id="${tab.id}">👁 Focus</button>
        <button class="ab reset"  data-act="reset"  data-id="${tab.id}">🔄 Reset</button>
        <button class="ab snooze" data-act="snooze" data-id="${tab.id}">💤 Snooze</button>
        <button class="ab close"  data-act="close"  data-id="${tab.id}">✕ Close</button>
      </div>
      <div class="snooze-menu" id="sm-${tab.id}">
        ${SNOOZE_OPTIONS.map(m => `<div class="sopt" data-min="${m}" data-id="${tab.id}">${m}m</div>`).join('')}
      </div>`

    list.appendChild(el)
  })

  wireFavIcons(list)
  list.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      const id  = parseInt(btn.dataset.id)
      const act = btn.dataset.act
      if (act === 'close') {
        await send('CLOSE_TAB', {}, { tabId: id }); toast('✕ Tab closed'); await refresh()
      } else if (act === 'reset') {
        await send('RESET_TAB', {}, { tabId: id }); toast('🔄 Timer reset'); await refresh()
      } else if (act === 'focus') {
        await send('FOCUS_TAB', {}, { tabId: id })
      } else if (act === 'snooze') {
        const menu = document.getElementById(`sm-${id}`)
        if (menu) menu.classList.toggle('open')
      }
    })
  })
  list.querySelectorAll('.sopt').forEach(opt => {
    opt.addEventListener('click', async e => {
      e.stopPropagation()
      const id  = parseInt(opt.dataset.id)
      const min = parseInt(opt.dataset.min)
      await send('SNOOZE_TAB', { minutes: min }, { tabId: id })
      toast(`💤 Snoozed ${min}m`); await refresh()
    })
  })
}

// ══════════════════════════════════════════════════════
//  RENDER RULES
// ══════════════════════════════════════════════════════
function renderRules(rules) {
  const list = document.getElementById('rule-list')
  list.innerHTML = ''
  if (!rules || !rules.length) {
    list.innerHTML = '<div class="empty-state"><div class="ei">📏</div><div class="et">No rules yet</div><div class="es">Add a URL rule to start tracking</div></div>'
    return
  }
  rules.forEach((rule, idx) => {
    const el = document.createElement('div')
    el.className = 'rule-card' + (rule.enabled ? '' : ' disabled')
    el.innerHTML = `
      <div class="rule-head" data-ruleid="${rule.id}">
        <div class="rule-color-dot" style="background:${rule.color || '#E87722'}"></div>
        <div class="rule-name-wrap">
          <div class="rule-name">${escHtml(rule.name || 'Unnamed Rule')}</div>
          <div class="rule-pattern">${escHtml(rule.pattern)} (${rule.matchType})</div>
        </div>
        <div class="rule-badges">
          <span class="rb">${rule.timeout}m</span>
          <span class="rb">${rule.action || 'close'}</span>
          <span class="rb">P${rule.priority || 1}</span>
        </div>
        <label class="tog" style="margin-left:6px" data-stopprop="1">
          <input type="checkbox" class="rule-toggle" data-idx="${idx}" ${rule.enabled ? 'checked' : ''}/>
          <span class="tr"></span>
        </label>
      </div>
      <div class="rule-body" id="rb-${rule.id}">
        <div style="display:flex;gap:6px">
          <button class="ra save" style="flex:2" data-edit="${rule.id}">✏️ Edit</button>
          <button class="ra dup" data-dup="${rule.id}">⧉ Dup</button>
          <button class="ra del" data-del="${rule.id}">🗑 Delete</button>
        </div>
      </div>`
    list.appendChild(el)
  })

  wireFavIcons(list)
  list.querySelectorAll('.rule-head').forEach(head => {
    head.addEventListener('click', () => {
      const body = document.getElementById('rb-' + head.dataset.ruleid)
      if (body) body.classList.toggle('open')
    })
  })
  list.querySelectorAll('.rule-toggle').forEach(tog => {
    tog.addEventListener('change', async () => {
      const idx = parseInt(tog.dataset.idx)
      S.rules[idx].enabled = tog.checked
      await send('SAVE_RULES', S.rules)
      toast(tog.checked ? '✅ Rule enabled' : '⏸ Rule disabled'); await refresh()
    })
  })
  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => openRuleForm(btn.dataset.edit))
  })
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this rule?')) return
      S.rules = S.rules.filter(r => r.id !== btn.dataset.del)
      await send('SAVE_RULES', S.rules); toast('🗑 Rule deleted'); await refresh()
    })
  })
  list.querySelectorAll('[data-dup]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const orig = S.rules.find(r => r.id === btn.dataset.dup)
      if (!orig) return
      const copy = { ...orig, id: 'rule_' + Date.now(), name: orig.name + ' (copy)' }
      S.rules.push(copy)
      await send('SAVE_RULES', S.rules); toast('⧉ Rule duplicated'); await refresh()
    })
  })
}

// ── Rule form ─────────────────────────────────────────────────────────────────
document.getElementById('btn-add-rule').addEventListener('click', () => openRuleForm(null))

function openRuleForm(ruleId) {
  editingRuleId = ruleId
  const form = document.getElementById('rule-form')
  form.style.display = 'block'
  if (ruleId) {
    const r = S.rules.find(x => x.id === ruleId)
    if (!r) return
    document.getElementById('rf-name').value      = r.name || ''
    document.getElementById('rf-pattern').value   = r.pattern || ''
    document.getElementById('rf-matchtype').value = r.matchType || 'contains'
    document.getElementById('rf-timeout').value   = r.timeout || 10
    document.getElementById('rf-priority').value  = r.priority || 1
    document.getElementById('rf-action').value    = r.action || 'close'
    document.getElementById('rf-visits').value    = r.closeAfterVisits || 0
    document.getElementById('rf-groupname').value = r.groupName || ''
    document.getElementById('rf-id').value        = ruleId
    selectedColor = r.color || '#E87722'
  } else {
    document.getElementById('rf-name').value      = ''
    document.getElementById('rf-pattern').value   = ''
    document.getElementById('rf-matchtype').value = 'contains'
    document.getElementById('rf-timeout').value   = 10
    document.getElementById('rf-priority').value  = 1
    document.getElementById('rf-action').value    = 'close'
    document.getElementById('rf-visits').value    = 0
    document.getElementById('rf-groupname').value = ''
    document.getElementById('rf-id').value        = ''
    selectedColor = '#E87722'
  }
  document.querySelectorAll('.cc').forEach(c => c.classList.toggle('sel', c.dataset.c === selectedColor))
  toggleGroupRow()
  form.scrollIntoView({ behavior: 'smooth' })
}

document.getElementById('rf-action').addEventListener('change', toggleGroupRow)
function toggleGroupRow() {
  document.getElementById('rf-group-row').style.display =
    document.getElementById('rf-action').value === 'group' ? 'flex' : 'none'
}
document.querySelectorAll('.cc').forEach(c => {
  c.addEventListener('click', () => {
    selectedColor = c.dataset.c
    document.querySelectorAll('.cc').forEach(x => x.classList.toggle('sel', x.dataset.c === selectedColor))
  })
})
document.getElementById('rf-save').addEventListener('click', async () => {
  const name    = document.getElementById('rf-name').value.trim()
  const pattern = document.getElementById('rf-pattern').value.trim()
  if (!name || !pattern) { toast('⚠ Name and pattern required'); return }
  const id   = document.getElementById('rf-id').value || ('rule_' + Date.now())
  const rule = {
    id, name, pattern,
    matchType:        document.getElementById('rf-matchtype').value,
    timeout:          parseInt(document.getElementById('rf-timeout').value) || 10,
    priority:         parseInt(document.getElementById('rf-priority').value) || 1,
    action:           document.getElementById('rf-action').value,
    closeAfterVisits: parseInt(document.getElementById('rf-visits').value) || 0,
    groupName:        document.getElementById('rf-groupname').value.trim(),
    color:            selectedColor,
    enabled:          true, snoozeUntil: null, _visits: {},
  }
  const idx = S.rules.findIndex(r => r.id === id)
  if (idx >= 0) S.rules[idx] = rule; else S.rules.push(rule)
  await send('SAVE_RULES', S.rules)
  document.getElementById('rule-form').style.display = 'none'
  toast('✅ Rule saved'); await refresh()
})
document.getElementById('rf-cancel').addEventListener('click', () => {
  document.getElementById('rule-form').style.display = 'none'
})

// ══════════════════════════════════════════════════════
//  RENDER SETTINGS
// ══════════════════════════════════════════════════════
function bindSlider(id, valId) {
  const el = document.getElementById(id)
  el.addEventListener('input', () => { document.getElementById(valId).textContent = el.value })
}
bindSlider('s-global',    'sv-global')
bindSlider('s-sweep-set', 'sv-sweep')
bindSlider('s-warn',      'sv-warn')
bindSlider('s-idle',      'sv-idle')

function renderSettings(settings) {
  if (!settings) return
  document.getElementById('s-global').value       = settings.globalTimeout     || 10
  document.getElementById('sv-global').textContent = settings.globalTimeout    || 10
  document.getElementById('s-sweep-set').value    = settings.sweepMinutes      || 1
  document.getElementById('sv-sweep').textContent  = settings.sweepMinutes     || 1
  document.getElementById('s-warn').value          = settings.warnBeforeMinutes || 2
  document.getElementById('sv-warn').textContent   = settings.warnBeforeMinutes || 2
  document.getElementById('s-idle').value          = settings.idleSeconds      || 60
  document.getElementById('sv-idle').textContent   = settings.idleSeconds      || 60
  document.getElementById('s-closeactive').checked = !!settings.closeActiveIfIdle
  document.getElementById('s-onlyidle').checked    = !!settings.closeOnlyIfIdle
  document.getElementById('s-autoreload').checked  = !!settings.autoReloadOnClose
  document.getElementById('s-badge').checked       = settings.badgeEnabled !== false
  document.getElementById('s-notifycloseB').checked = settings.notifyOnClose !== false
  document.getElementById('s-notifywarn').checked  = settings.notifyOnWarn !== false
  if (settings.pauseSchedule) {
    document.getElementById('s-pause-from').value = settings.pauseSchedule.from || ''
    document.getElementById('s-pause-to').value   = settings.pauseSchedule.to   || ''
  }
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const fromT = document.getElementById('s-pause-from').value
  const toT   = document.getElementById('s-pause-to').value
  const payload = {
    globalTimeout:     parseInt(document.getElementById('s-global').value),
    sweepMinutes:      parseInt(document.getElementById('s-sweep-set').value),
    warnBeforeMinutes: parseInt(document.getElementById('s-warn').value),
    idleSeconds:       parseInt(document.getElementById('s-idle').value),
    closeActiveIfIdle: document.getElementById('s-closeactive').checked,
    closeOnlyIfIdle:   document.getElementById('s-onlyidle').checked,
    autoReloadOnClose: document.getElementById('s-autoreload').checked,
    badgeEnabled:      document.getElementById('s-badge').checked,
    notifyOnClose:     document.getElementById('s-notifycloseB').checked,
    notifyOnWarn:      document.getElementById('s-notifywarn').checked,
    pauseSchedule:     (fromT && toT) ? { from: fromT, to: toT } : null,
  }
  await send('SAVE_SETTINGS', payload); toast('✅ Settings saved'); await refresh()
})

// ══════════════════════════════════════════════════════
//  RENDER ANALYTICS  — history items reopen on click
// ══════════════════════════════════════════════════════
function renderAnalytics(a) {
  if (!a) return
  document.getElementById('an-total').textContent   = a.totalClosed  || 0
  document.getElementById('an-today').textContent   = a.closedToday  || 0
  document.getElementById('an-warned').textContent  = a.totalWarned  || 0
  document.getElementById('an-snoozed').textContent = a.totalSnoozed || 0

  const list = document.getElementById('hist-list')
  if (!a.history || !a.history.length) {
    list.innerHTML = '<div class="empty-state" style="padding:10px"><div class="et" style="font-size:10px">No close history yet</div></div>'
    return
  }

  list.innerHTML = ''
  a.history.slice(0, 15).forEach(h => {
    const ago  = Math.round((Date.now() - h.ts) / 60000)
    const icon = h.action === 'reload' ? '🔄' : h.action === 'manual' ? '✕' : '🚫'
    const canOpen = h.url && !h.url.startsWith('chrome')

    const el = document.createElement('div')
    el.className = 'hist-item'
    if (canOpen) el.title = 'Click to reopen in new tab'

    // Favicon cell
    const favDiv = document.createElement('div')
    favDiv.className = 'hist-ic'
    if (h.favIconUrl) {
      const img = document.createElement('img')
      img.src   = h.favIconUrl
      img.width = 14; img.height = 14
      img.style.cssText = 'object-fit:contain'
      // Fallback to emoji if favicon fails to load
      img.addEventListener('error', () => { favDiv.textContent = icon })
      favDiv.appendChild(img)
    } else {
      favDiv.textContent = icon
    }

    // Info cell
    const infoDiv = document.createElement('div')
    infoDiv.className = 'hist-info'
    infoDiv.innerHTML = `
      <div class="hist-title">${escHtml(h.title || 'Tab')}</div>
      <div class="hist-url">${escHtml(h.url || '')}${h.rule ? ' · ' + escHtml(h.rule) : ''}</div>`

    // Right: time + reopen badge
    const rightDiv = document.createElement('div')
    rightDiv.className = 'hist-right'
    rightDiv.innerHTML = `
      <div class="hist-time">${ago < 1 ? 'just now' : ago + 'm ago'}</div>
      ${canOpen ? '<div class="hist-reopen">↗ Reopen</div>' : ''}`

    el.appendChild(favDiv)
    el.appendChild(infoDiv)
    el.appendChild(rightDiv)

    // Click to reopen
    if (canOpen) {
      el.addEventListener('click', () => {
        chrome.tabs.create({ url: h.url })
        toast('↗ Reopening tab…')
      })
    }

    list.appendChild(el)
  })
}

document.getElementById('btn-reset-analytics').addEventListener('click', async () => {
  if (!confirm('Reset all analytics?')) return
  await send('RESET_ANALYTICS'); toast('📊 Analytics reset'); await refresh()
})

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════
function wireFavIcons(container) {
  container.querySelectorAll('img.fav-img').forEach(img => {
    img.addEventListener('error', () => {
      if (img.parentElement) img.parentElement.textContent = '🌐'
    })
  })
  container.querySelectorAll('[data-stopprop]').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation())
  })
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ══════════════════════════════════════════════════════
//  REFRESH
// ══════════════════════════════════════════════════════
async function refresh() {
  let resp
  try { resp = await send('GET_FULL_STATE') } catch(e) { return }
  if (!resp || !resp.settings) return
  S = resp
  renderBanner(S)
  renderTabs(S.tabInfos || [])
  renderRules(S.rules || [])
  renderSettings(S.settings)
  if (document.getElementById('panel-analytics').classList.contains('active')) {
    renderAnalytics(S.analytics)
  }
}

// ══════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════
setTimeout(refresh, 100)
setTimeout(refresh, 600)
refreshTimer = setInterval(refresh, 4000)
window.addEventListener('unload', () => clearInterval(refreshTimer))

// ══════════════════════════════════════════════════════
//  MEMORY & CACHE PANEL
// ══════════════════════════════════════════════════════
function fmtBytes(b) {
  if (!b || b === 0) return '–'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / (1024 * 1024)).toFixed(1) + ' MB'
}
function memBarColor(pct) {
  if (pct > 80) return '#EF4444'
  if (pct > 50) return '#F59E0B'
  return '#22C55E'
}

async function loadMemory() {
  // Trigger a fresh snapshot then load the result
  const data = await send('SNAPSHOT_MEMORY')
  if (!data || !data.snapshot) return

  const snap    = data.snapshot
  const history = data.history || {}
  const tabs    = Object.values(snap)

  const withMem   = tabs.filter(t => t.mem)
  const totalUsed = withMem.reduce((s, t) => s + t.mem.used, 0)
  const sorted0   = [...withMem].sort((a, b) => b.mem.used - a.mem.used)
  const maxTab    = sorted0[0]

  document.getElementById('mem-tabs').textContent    = tabs.length
  document.getElementById('mem-total').textContent   = fmtBytes(totalUsed)
  document.getElementById('mem-highest').textContent = maxTab ? fmtBytes(maxTab.mem.used) : '–'

  const list = document.getElementById('mem-list')
  if (!tabs.length) {
    list.innerHTML = '<div class="empty-state"><div class="ei">🧠</div><div class="et">No tab data yet</div><div class="es">Data populates after next sweep</div></div>'
    return
  }

  const sorted = [...tabs].sort((a, b) => {
    if (a.matched && !b.matched) return -1
    if (!a.matched && b.matched) return 1
    return (b.mem?.used || 0) - (a.mem?.used || 0)
  })

  list.innerHTML = ''
  sorted.forEach(tab => {
    if (!tab.tabId) return
    const used  = tab.mem?.used  || 0
    const total = tab.mem?.total || 0
    const pct   = total > 0 ? Math.round((used / total) * 100) : 0
    const hist  = history[tab.tabId] || []

    let growthHtml = ''
    if (hist.length >= 3) {
      const recent = hist.slice(-3)
      const delta  = recent[2].used - recent[0].used
      if (delta > 2 * 1024 * 1024)      growthHtml = `<span class="mem-growth up">↑ growing</span>`
      else if (delta < -512 * 1024)     growthHtml = `<span class="mem-growth stable">↓ freeing</span>`
      else                              growthHtml = `<span class="mem-growth stable">● stable</span>`
    }

    const el = document.createElement('div')
    el.className = 'mem-card'

    // Favicon: use stored favIconUrl from snapshot (now saved in background.js)
    const favHtml = tab.favIconUrl
      ? `<img class="fav-img" src="${escHtml(tab.favIconUrl)}"/>`
      : '🌐'

    el.innerHTML = `
      <div class="mem-head">
        <div class="mem-fav">${favHtml}</div>
        <div class="mem-info">
          <div class="mem-title">${escHtml(tab.title)}${growthHtml}</div>
          <div class="mem-url">${escHtml(tab.url)}</div>
        </div>
        <div class="mem-usage">
          <div class="mem-num">${used ? fmtBytes(used) : '–'}</div>
          <div class="mem-sub">${total ? 'of ' + fmtBytes(total) : 'no data'}</div>
        </div>
      </div>
      ${used ? `<div class="mem-bar-wrap"><div class="mem-bar" style="width:${pct}%;background:${memBarColor(pct)}"></div></div>` : ''}
      <div class="mem-actions">
        <button class="mc-btn" data-cache="${escHtml(tab.url)}">🗑 Cache</button>
        <button class="mc-btn" data-cookies="${escHtml(tab.url)}">🍪 Cookies</button>
        <button class="mc-btn" data-storage="${escHtml(tab.url)}">📦 Storage</button>
        <button class="mc-btn danger" data-closeTab="${tab.tabId}">✕ Close</button>
      </div>`

    list.appendChild(el)
  })

  wireFavIcons(list)

  list.querySelectorAll('[data-cache]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '⏳'
      const r = await send('CLEAR_CACHE', {}, { url: btn.dataset.cache })
      btn.textContent = r.ok ? '✅ Done' : '❌ Fail'
      setTimeout(() => { btn.textContent = '🗑 Cache' }, 2000)
    })
  })
  list.querySelectorAll('[data-cookies]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '⏳'
      const r = await send('CLEAR_COOKIES', {}, { url: btn.dataset.cookies })
      btn.textContent = r.ok ? '✅ Done' : '❌ Fail'
      setTimeout(() => { btn.textContent = '🍪 Cookies' }, 2000)
    })
  })
  list.querySelectorAll('[data-storage]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '⏳'
      const r = await send('CLEAR_STORAGE', {}, { url: btn.dataset.storage })
      btn.textContent = r.ok ? '✅ Done' : '❌ Fail'
      setTimeout(() => { btn.textContent = '📦 Storage' }, 2000)
    })
  })
  list.querySelectorAll('[data-closeTab]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tid = parseInt(btn.dataset.closetab)
      await send('CLOSE_TAB', {}, { tabId: tid })
      toast('✕ Tab closed'); await loadMemory()
    })
  })
}

document.getElementById('btn-refresh-mem').addEventListener('click', async () => {
  toast('↺ Refreshing…'); await loadMemory()
})
document.getElementById('btn-clear-all-cache').addEventListener('click', async () => {
  if (!confirm('Clear cache for all tracked tab origins?')) return
  const r  = await send('CLEAR_ALL_CACHE')
  const ok = (r.results || []).filter(x => x.ok).length
  toast(`🗑 Cleared cache for ${ok} origin(s)`)
})
