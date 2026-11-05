const $ = id => document.getElementById(id)
const COLORS = ['#e0913f', '#6fa8a6', '#b58ac9', '#7fb069', '#d9634f', '#c9b458', '#7d9bd1']
const STATES = {
  running: 'работает',
  building: 'собирается',
  exited: 'остановлено',
  stopped: 'остановлено',
  created: 'создано',
  restarting: 'перезапускается',
  paused: 'на паузе',
  dead: 'упало',
  failed: 'ошибка сборки',
}

let overview = null
let selected = null
let logSocket = null
let source = 'upload'

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children.filter(child => child !== null && child !== undefined))
  return node
}

async function api(url, options = {}) {
  const init = { ...options }
  if (init.json !== undefined) {
    init.method ||= 'POST'
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(init.json)
  }
  const res = await fetch(url, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

const colorOf = app => COLORS[overview.apps.indexOf(app) % COLORS.length]
const gb = mb => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${Math.round(mb)} МБ`)
const cores = n => String(Number(n.toFixed(2)))

function withCores(n) {
  const value = Number(n.toFixed(2))
  const tail = value % 100
  const word = !Number.isInteger(value) ? 'ядра'
    : tail >= 11 && tail <= 14 ? 'ядер'
    : value % 10 === 1 ? 'ядро'
    : [2, 3, 4].includes(value % 10) ? 'ядра'
    : 'ядер'
  return `${value} ${word}`
}

function drawBar(bar, total, limitOf, usedOf) {
  bar.replaceChildren(...overview.apps.map(app => {
    const limit = limitOf(app)
    const used = app.stats ? Math.min(usedOf(app.stats) / limit, 1) * 100 : 0
    const slice = el('button', { className: 'slice', title: app.name, onclick: () => openDetail(app.id) },
      el('i'), el('span', { textContent: app.name }))
    slice.style.setProperty('--c', colorOf(app))
    slice.style.flex = `0 0 ${(limit / total) * 100}%`
    slice.firstChild.style.width = `${used}%`
    return slice
  }))
}

function drawApp(app) {
  const stats = app.stats
  const dot = el('span', { className: 'dot' })
  dot.style.setProperty('--c', app.state === 'running' ? colorOf(app) : 'var(--line)')
  return el('button', { className: 'app', onclick: () => openDetail(app.id) },
    dot,
    el('span', {}, app.name, el('small', { textContent: [STATES[app.state] || app.state, app.type].filter(Boolean).join(' · ') })),
    el('span', { className: 'num', textContent: `${stats ? cores(stats.cpuCores) : '–'} / ${withCores(app.cpus)}` }),
    el('span', { className: 'num', textContent: `${stats ? gb(stats.memoryMb) : '–'} / ${gb(app.memoryMb)}` }),
  )
}

function render() {
  const { host, apps } = overview
  const cpuUsed = apps.reduce((sum, a) => sum + a.cpus, 0)
  const ramUsed = apps.reduce((sum, a) => sum + a.memoryMb, 0)
  $('host').textContent = `${withCores(host.cpus)} · ${gb(host.memoryMb)}, ${gb(host.reservedMb)} оставлено системе`
  drawBar($('bar-cpu'), host.cpus, a => a.cpus, s => s.cpuCores)
  drawBar($('bar-ram'), host.usableMb, a => a.memoryMb, s => s.memoryMb)
  $('free-cpu').textContent = `свободно ${cores(host.cpus - cpuUsed)}`
  $('free-ram').textContent = `свободно ${gb(host.usableMb - ramUsed)}`
  $('apps').replaceChildren(...apps.map(drawApp))
  $('empty').hidden = apps.length > 0
  refreshDetail()
}

async function refresh() {
  try {
    overview = await api('/api/overview')
    $('login').hidden = true
    $('main').hidden = false
    render()
  } catch (err) {
    if (err.status === 401) {
      $('main').hidden = true
      $('detail').hidden = true
      $('login').hidden = false
    }
  }
}

function freeFor(app) {
  const others = overview.apps.filter(a => a.id !== app?.id)
  return {
    cpus: overview.host.cpus - others.reduce((sum, a) => sum + a.cpus, 0),
    memoryMb: overview.host.usableMb - others.reduce((sum, a) => sum + a.memoryMb, 0),
  }
}

function closeDetail() {
  selected = null
  logSocket?.close()
  $('detail').hidden = true
}

function connectLogs(id, box) {
  logSocket?.close()
  box.textContent = ''
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${scheme}://${location.host}/ws/logs/${id}`)
  socket.onmessage = event => {
    const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    box.textContent = (box.textContent + event.data).slice(-100000)
    if (pinned) box.scrollTop = box.scrollHeight
  }
  logSocket = socket
}

async function showBuildLog(id, box) {
  logSocket?.close()
  const poll = async () => {
    if (selected !== id) return
    const build = await api(`/api/apps/${id}/build`).catch(() => null)
    if (!build) return
    box.textContent = build.log
    box.scrollTop = box.scrollHeight
    if (build.running) setTimeout(poll, 1000)
    else if (!build.error) connectLogs(id, box)
  }
  poll()
}

async function act(fn, errorBox) {
  errorBox.textContent = ''
  try {
    await fn()
    await refresh()
  } catch (err) {
    errorBox.textContent = err.message
  }
}

function openDetail(id) {
  selected = id
  const app = overview.apps.find(a => a.id === id)
  const free = freeFor(app)
  const error = el('p', { className: 'error' })
  const logs = el('div', { className: 'logs' })
  const status = el('p', { className: 'muted', id: 'detail-status' })

  const cpuOut = el('output')
  const ramOut = el('output')
  const cpu = el('input', { type: 'range', min: 0.05, step: 0.05, max: free.cpus, value: app.cpus })
  const ram = el('input', { type: 'range', min: 32, step: 32, max: free.memoryMb, value: app.memoryMb })
  const showLimits = () => {
    cpuOut.textContent = withCores(Number(cpu.value))
    ramOut.textContent = gb(Number(ram.value))
  }
  showLimits()
  cpu.oninput = ram.oninput = showLimits
  cpu.onchange = ram.onchange = () => act(
    () => api(`/api/apps/${id}`, { method: 'PATCH', json: { cpus: Number(cpu.value), memoryMb: Number(ram.value) } }),
    error,
  )

  const env = el('textarea', {
    rows: 4,
    spellcheck: false,
    value: Object.entries(app.env).map(([key, value]) => `${key}=${value}`).join('\n'),
  })
  const startCmd = el('input', { value: app.startCmd || '', placeholder: 'из проекта' })
  const restart = el('input', { type: 'checkbox', checked: app.restart })
  restart.style.width = 'auto'
  const save = el('button', {
    textContent: 'Сохранить и пересоздать',
    onclick: () => act(() => api(`/api/apps/${id}`, {
      method: 'PATCH',
      json: { env: env.value, startCmd: startCmd.value, restart: restart.checked },
    }), error),
  })

  const command = (label, action) => el('button', {
    textContent: label,
    onclick: () => act(() => api(`/api/apps/${id}/${action}`, { method: 'POST' }), error),
  })
  const redeploy = el('button', {
    textContent: app.source === 'upload' ? 'Загрузить новый архив' : 'Пересобрать',
    onclick: () => {
      if (app.source !== 'upload') return runDeploy(new FormData())
      const picker = el('input', { type: 'file', accept: '.zip' })
      picker.onchange = () => {
        const form = new FormData()
        form.append('archive', picker.files[0])
        runDeploy(form)
      }
      picker.click()
    },
  })
  const runDeploy = form => act(async () => {
    await api(`/api/apps/${id}/deploy`, { method: 'POST', body: form })
    showBuildLog(id, logs)
  }, error)
  const remove = el('button', {
    className: 'danger',
    textContent: 'Удалить',
    onclick: () => {
      if (!confirm(`Удалить ${app.name} вместе с данными?`)) return
      act(async () => {
        await api(`/api/apps/${id}`, { method: 'DELETE' })
        closeDetail()
      }, error)
    },
  })

  $('detail').replaceChildren(
    el('div', { className: 'detail-head' },
      el('h2', { textContent: app.name }),
      el('button', { textContent: 'Закрыть', onclick: closeDetail })),
    status,
    el('div', { className: 'row' }, command('Запустить', 'start'), command('Остановить', 'stop'), command('Перезапустить', 'restart'), redeploy, remove),
    error,
    el('div', { className: 'sliders' },
      el('label', {}, 'CPU ', cpuOut, cpu),
      el('label', {}, 'RAM ', ramOut, ram)),
    el('label', {}, 'Логи', logs),
    el('label', {}, 'Команда запуска', startCmd),
    el('label', {}, 'Окружение', env),
    el('label', {}, restart, ' Перезапускать при падении'),
    save,
  )
  $('detail').hidden = false
  refreshDetail()
  if (app.state === 'building' || app.state === 'failed') showBuildLog(id, logs)
  else connectLogs(id, logs)
}

function refreshDetail() {
  const status = $('detail-status')
  const app = overview.apps.find(a => a.id === selected)
  if (!status || !app) return
  const port = app.hostPort ? `порт ${app.hostPort}` : null
  status.textContent = [STATES[app.state] || app.state, app.status, app.type, port].filter(Boolean).join(' · ')
}

function setSource(next) {
  source = next
  for (const tab of $('source-tabs').children) tab.classList.toggle('active', tab.dataset.source === next)
  const form = $('create-form')
  for (const node of form.querySelectorAll('[data-for]')) node.hidden = node.dataset.for !== next
  for (const node of form.querySelectorAll('[data-not]')) node.hidden = node.dataset.not === next
}

function showCreateLimits() {
  const form = $('create-form')
  $('cpu-out').textContent = withCores(Number(form.cpus.value))
  $('ram-out').textContent = gb(Number(form.memoryMb.value))
}

$('add').onclick = () => {
  const form = $('create-form')
  const free = freeFor(null)
  form.cpus.max = free.cpus
  form.memoryMb.max = free.memoryMb
  form.cpus.value = Math.min(0.25, free.cpus)
  form.memoryMb.value = Math.min(256, free.memoryMb)
  showCreateLimits()
  $('create-error').textContent = ''
  $('create').showModal()
}

$('create-cancel').onclick = () => $('create').close()
$('source-tabs').onclick = event => event.target.dataset.source && setSource(event.target.dataset.source)
$('create-form').oninput = showCreateLimits

$('create-form').onsubmit = async event => {
  event.preventDefault()
  const form = event.target
  const data = new FormData(form)
  data.set('source', source)
  if (source !== 'upload') data.delete('archive')
  try {
    const { id } = await api('/api/apps', { method: 'POST', body: data })
    $('create').close()
    form.reset()
    await refresh()
    openDetail(id)
  } catch (err) {
    $('create-error').textContent = err.message
  }
}

$('login').onsubmit = async event => {
  event.preventDefault()
  $('login-error').textContent = ''
  try {
    await api('/api/login', { json: { password: $('password').value } })
    $('password').value = ''
    await refresh()
  } catch (err) {
    $('login-error').textContent = err.message
  }
}

refresh()
setInterval(() => !document.hidden && !$('main').hidden && refresh(), 3000)
