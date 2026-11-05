import { ICONS } from './icons.js'

const $ = id => document.getElementById(id)
const COLORS = ['#e0913f', '#4f9d98', '#c8644a', '#8fa35a', '#a0719e', '#6c8ebf', '#c9a94f']
const TILES = 120
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
const SOURCES = {
  upload: ['Архив', 'DocumentUpload'],
  git: ['Git', 'Code'],
  image: ['Образ', 'Box'],
}

let overview = null
let route = { view: 'overview' }
let view = null
let logSocket = null

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false))
  return node
}

function icon(name, variant = 'linear') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.classList.add('icon')
  svg.innerHTML = ICONS[name][variant]
  return svg
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

function toast(text, bad = false) {
  const node = el('div', { className: bad ? 'toast bad' : 'toast' }, icon(bad ? 'Warning2' : 'TickCircle'), text)
  $('toasts').append(node)
  setTimeout(() => node.remove(), bad ? 6000 : 3000)
}

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

function colorOf(id) {
  let sum = 0
  for (const char of id) sum = (sum * 31 + char.charCodeAt(0)) >>> 0
  return COLORS[sum % COLORS.length]
}

const findApp = id => overview?.apps.find(a => a.id === id)

function uptime(status) {
  const up = /^Up (.+?)(?: \(.*\))?$/.exec(status)
  if (!up) return ''
  const text = up[1]
    .replace('Less than a second', 'меньше секунды')
    .replace('About a minute', 'около минуты')
    .replace('About an hour', 'около часа')
    .replace(/(\d+) seconds?/, '$1 сек')
    .replace(/(\d+) minutes?/, '$1 мин')
    .replace(/(\d+) hours?/, '$1 ч')
    .replace(/(\d+) days?/, '$1 дн')
    .replace(/(\d+) weeks?/, '$1 нед')
    .replace(/(\d+) months?/, '$1 мес')
  return `уже ${text}`
}

function stateText(app) {
  const code = /^Exited \((\d+)\)/.exec(app.status)?.[1]
  if (app.state === 'running') return [STATES.running, uptime(app.status)].filter(Boolean).join(', ')
  if (code && code !== '0') return `${STATES.exited}, код ${code}`
  return STATES[app.state] || app.state
}

function tileMark(app) {
  const mark = el('span', { className: 'tile-mark' })
  const live = app.state === 'running'
  const trouble = ['failed', 'dead'].includes(app.state)
  if (!live) mark.classList.add('off')
  if (app.state === 'building' || app.state === 'restarting') mark.classList.add('busy')
  mark.style.setProperty('--c', trouble ? 'var(--bad)' : live ? colorOf(app.id) : app.state === 'building' ? colorOf(app.id) : 'var(--muted)')
  return mark
}

function allocated(exceptId) {
  const apps = overview.apps.filter(a => a.id !== exceptId)
  return {
    cpus: apps.reduce((sum, a) => sum + a.cpus, 0),
    memoryMb: apps.reduce((sum, a) => sum + a.memoryMb, 0),
  }
}

function freeFor(id) {
  const used = allocated(id)
  return {
    cpus: Math.max(overview.host.cpus - used.cpus, 0),
    memoryMb: Math.max(overview.host.usableMb - used.memoryMb, 0),
  }
}

function askConfirm(title, text, action) {
  return new Promise(resolve => {
    const box = $('confirm')
    const done = value => {
      box.close()
      resolve(value)
    }
    box.replaceChildren(
      el('h2', { textContent: title }),
      el('p', { textContent: text }),
      el('div', { className: 'dialog-actions' },
        el('button', { type: 'button', textContent: 'Отмена', onclick: () => done(false) }),
        el('button', { type: 'button', className: 'danger', textContent: action, onclick: () => done(true) })),
    )
    box.oncancel = () => resolve(false)
    box.showModal()
  })
}

async function busy(button, fn) {
  button.disabled = true
  try {
    await fn()
    await refresh()
  } catch (err) {
    toast(err.message, true)
  } finally {
    button.disabled = false
  }
}

function drawSidebar() {
  const overviewRow = $('nav-overview')
  overviewRow.classList.toggle('active', route.view === 'overview')
  overviewRow.replaceChildren(icon('Category', route.view === 'overview' ? 'bold' : 'linear'), 'Обзор')
  $('nav-apps').replaceChildren(...overview.apps.map(app => el('a', {
    className: `nav-row${route.id === app.id ? ' active' : ''}`,
    href: `#/app/${app.id}`,
  }, tileMark(app), el('span', { className: 'name', textContent: app.name }), el('span', { className: 'meta mono', textContent: gb(app.memoryMb) }))))
}

function createMosaic(kind, iconName) {
  const figure = el('b')
  const total = el('span')
  const grid = el('div', { className: 'mosaic' })
  const caption = el('p', { className: 'mosaic-caption' })
  const tiles = Array.from({ length: TILES }, () => grid.appendChild(el('div', { className: 'tile' })))
  const mosaic = { kind, figure, total, grid, caption, tiles, hover: null, freeText: '' }

  grid.onmouseover = event => {
    const id = event.target.dataset?.app || null
    if (id !== mosaic.hover) {
      mosaic.hover = id
      applyHover(mosaic)
    }
  }
  grid.onmouseleave = () => {
    mosaic.hover = null
    applyHover(mosaic)
  }
  grid.onclick = event => {
    if (event.target.dataset?.app) location.hash = `#/app/${event.target.dataset.app}`
  }

  mosaic.node = el('section', { className: 'card' },
    el('div', { className: 'mosaic-head' }, icon(iconName), figure, total),
    grid,
    caption)
  return mosaic
}

function applyHover(mosaic) {
  const { hover, grid, tiles, caption, kind } = mosaic
  grid.classList.toggle('focus', Boolean(hover))
  for (const tile of tiles) tile.classList.toggle('on', Boolean(hover) && tile.dataset.app === hover)
  const app = hover && findApp(hover)
  if (!app) {
    caption.textContent = mosaic.freeText
  } else if (kind === 'cpu') {
    caption.textContent = `${app.name}: ${app.stats ? cores(app.stats.cpuCores) : 0} из ${withCores(app.cpus)}`
  } else {
    caption.textContent = `${app.name}: ${gb(app.stats?.memoryMb ?? 0)} из ${gb(app.memoryMb)}`
  }
}

function paintMosaic(mosaic, total, limitOf, usedOf, reserved = 0) {
  const { tiles } = mosaic
  const system = Math.round((reserved / (total + reserved)) * TILES)
  const space = TILES - system
  let index = 0
  for (const app of overview.apps) {
    const count = Math.max(1, Math.round((limitOf(app) / total) * space))
    const lit = app.stats ? Math.ceil(Math.min(usedOf(app.stats) / limitOf(app), 1) * count) : 0
    for (let k = 0; k < count && index < space; k++, index++) {
      const tile = tiles[index]
      tile.className = k < lit ? 'tile lit' : 'tile held'
      tile.dataset.app = app.id
      tile.style.setProperty('--c', colorOf(app.id))
    }
  }
  for (; index < TILES; index++) {
    const tile = tiles[index]
    tile.className = index >= space ? 'tile system' : 'tile'
    delete tile.dataset.app
  }
  applyHover(mosaic)
}

function appMeter(used, limit, text, color) {
  const meter = el('span', { className: 'meter', textContent: text }, el('i'))
  meter.style.setProperty('--v', `${Math.min(used / limit, 1) * 100}%`)
  meter.style.setProperty('--c', color)
  return meter
}

function appRow(app) {
  const color = colorOf(app.id)
  const stats = app.stats
  return el('a', { className: 'table-row', href: `#/app/${app.id}` },
    tileMark(app),
    el('span', { className: 'name' }, app.name, el('small', { textContent: stateText(app) })),
    el('span', { className: 'muted mono', textContent: app.hostPort ? `:${app.hostPort}` : app.type || '' }),
    appMeter(stats?.cpuCores ?? 0, app.cpus, `${stats ? cores(stats.cpuCores) : '0'} / ${withCores(app.cpus)}`, color),
    appMeter(stats?.memoryMb ?? 0, app.memoryMb, `${gb(stats?.memoryMb ?? 0)} / ${gb(app.memoryMb)}`, color),
  )
}

function mountOverview() {
  const cpu = createMosaic('cpu', 'Cpu')
  const ram = createMosaic('ram', 'Ram')
  const table = el('section', { className: 'table' })
  const note = el('span', { className: 'head-note' })
  $('page').replaceChildren(el('div', { className: 'page-inner' },
    el('header', { className: 'page-head' },
      el('h1', { textContent: 'Обзор' }),
      note,
      el('div', { className: 'actions' },
        el('button', { className: 'primary', onclick: openCreate }, icon('Add'), 'Добавить приложение'))),
    el('div', { className: 'mosaics' }, cpu.node, ram.node),
    el('div', { className: 'legend' },
      legendItem('var(--accent)', 'используется'),
      legendItem('color-mix(in srgb, var(--accent) 32%, var(--card))', 'выделено'),
      legendItem('var(--raised)', 'свободно'),
      legendItem('repeating-linear-gradient(135deg, #3a3a3d 0 2px, var(--raised) 2px 4px)', 'оставлено системе')),
    table))
  view = { cpu, ram, table, note }
}

function legendItem(background, text) {
  const tile = el('i')
  tile.style.background = background
  return el('span', {}, tile, text)
}

function updateOverview() {
  const { host, apps } = overview
  const { cpu, ram, table, note } = view
  const used = allocated()
  note.textContent = `${withCores(host.cpus)}, ${gb(host.memoryMb)}`

  cpu.figure.textContent = cores(used.cpus)
  cpu.total.textContent = `из ${withCores(host.cpus)} выдано`
  cpu.freeText = `Свободно ${withCores(Math.max(host.cpus - used.cpus, 0))}`
  paintMosaic(cpu, host.cpus, a => a.cpus, s => s.cpuCores)

  ram.figure.textContent = gb(used.memoryMb)
  ram.total.textContent = `из ${gb(host.usableMb)} выдано`
  ram.freeText = `Свободно ${gb(Math.max(host.usableMb - used.memoryMb, 0))}`
  paintMosaic(ram, host.usableMb, a => a.memoryMb, s => s.memoryMb, host.reservedMb)

  if (apps.length) {
    table.replaceChildren(
      el('div', { className: 'table-row head' }, el('span'), el('span', { textContent: 'Приложение' }), el('span', { textContent: 'Порт или тип' }), el('span', { textContent: 'CPU' }), el('span', { textContent: 'RAM' })),
      ...apps.map(appRow))
  } else {
    table.replaceChildren(el('div', { className: 'empty' },
      el('p', { textContent: 'Сервер пока целиком свободен' }),
      el('button', { className: 'primary', onclick: openCreate }, icon('Add'), 'Добавить первое приложение')))
  }
}

function limitField({ label, min, step, max, value, unit, hint, onchange }) {
  const range = el('input', { type: 'range', min, step, max, value, ariaLabel: label })
  const number = el('input', { type: 'number', min, step, max, value, ariaLabel: `${label}, точное значение` })
  const note = el('small', { textContent: hint(max) })
  range.oninput = () => { number.value = range.value }
  number.oninput = () => { range.value = number.value }
  range.onchange = number.onchange = () => onchange?.()
  return {
    node: el('div', { className: 'limit' },
      el('div', { className: 'limit-top' }, label, el('span', { className: 'limit-value' }, number, unit)),
      range, note),
    get value() { return Number(number.value) },
    setMax(next) {
      range.max = number.max = next
      note.textContent = hint(next)
    },
    setValue(next) {
      range.value = number.value = next
    },
  }
}

const cpuHint = max => `Доступно до ${withCores(max)}`
const ramHint = max => `Доступно до ${gb(max)}`

function mountApp(app) {
  const id = app.id
  const title = el('span', { className: 'head-note' })
  const mark = el('span')
  const actions = el('div', { className: 'actions' })
  const logs = el('div', { className: 'logs', tabIndex: 0 })
  const logTitle = el('span', { className: 'title', textContent: 'Логи' })
  const filter = el('input', { type: 'search', placeholder: 'Поиск', ariaLabel: 'Поиск по логам' })
  const follow = el('button', { className: 'quiet on', title: 'Автопрокрутка', ariaLabel: 'Автопрокрутка' }, icon('ArrowDown'))
  const log = { text: '', follow: true }

  const paintLogs = () => {
    const query = filter.value.trim().toLowerCase()
    logs.textContent = query
      ? log.text.split('\n').filter(line => line.toLowerCase().includes(query)).join('\n')
      : log.text
    if (log.follow) logs.scrollTop = logs.scrollHeight
  }
  filter.oninput = paintLogs
  follow.onclick = () => {
    log.follow = !log.follow
    follow.classList.toggle('on', log.follow)
    paintLogs()
  }
  logs.onwheel = event => {
    if (event.deltaY < 0 && log.follow) follow.click()
  }

  const free = freeFor(id)
  const saveLimits = () => {
    const json = { cpus: cpu.value, memoryMb: ram.value }
    api(`/api/apps/${id}`, { method: 'PATCH', json })
      .then(() => {
        toast('Лимиты применены')
        return refresh()
      })
      .catch(err => {
        toast(err.message, true)
        cpu.setValue(findApp(id).cpus)
        ram.setValue(findApp(id).memoryMb)
      })
  }
  const cpu = limitField({ label: 'CPU', min: 0.05, step: 0.05, max: free.cpus, value: app.cpus, unit: 'ядра', hint: cpuHint, onchange: saveLimits })
  const ram = limitField({ label: 'RAM', min: 32, step: 32, max: free.memoryMb, value: app.memoryMb, unit: 'МБ', hint: ramHint, onchange: saveLimits })

  const startCmd = el('input', { value: app.startCmd || '', placeholder: 'из проекта', spellcheck: false })
  const port = el('input', { type: 'number', min: 1, max: 65535, value: app.port ?? '', placeholder: '3000' })
  const hostPort = el('input', { type: 'number', min: 1, max: 65535, value: app.hostPort ?? '', placeholder: 'закрыт' })
  const env = el('textarea', {
    rows: 5,
    spellcheck: false,
    placeholder: 'KEY=value',
    value: Object.entries(app.env).map(([key, value]) => `${key}=${value}`).join('\n'),
  })
  const restart = el('input', { type: 'checkbox', checked: app.restart })
  const save = el('button', { type: 'submit', disabled: true }, 'Сохранить и пересоздать')
  const form = el('form', {
    className: 'form',
    oninput: () => { save.disabled = false },
    onsubmit: event => {
      event.preventDefault()
      busy(save, async () => {
        await api(`/api/apps/${id}`, {
          method: 'PATCH',
          json: { env: env.value, startCmd: startCmd.value, restart: restart.checked, port: port.value, hostPort: hostPort.value },
        })
        toast('Настройки сохранены')
        connectLogs(id, log, paintLogs)
      }).then(() => { save.disabled = true })
    },
  },
  el('label', { className: 'field' }, 'Команда запуска', startCmd),
  el('div', { className: 'pair' },
    el('label', { className: 'field' }, 'Порт приложения', port),
    el('label', { className: 'field' }, 'Внешний порт', hostPort)),
  el('label', { className: 'field' }, 'Окружение', env),
  el('label', { className: 'check' }, restart, 'Перезапускать при падении'),
  save)

  const [sourceName] = SOURCES[app.source]
  const sourceValue = app.gitUrl || (app.source === 'image' ? app.image : 'zip')
  const facts = el('div', { className: 'facts' },
    el('div', {}, el('span', { textContent: sourceName }), el('span', { className: 'mono', textContent: sourceValue, title: sourceValue })),
    el('div', {}, el('span', { textContent: 'Данные' }), el('span', { className: 'mono', textContent: app.dataPath })))
  const usage = el('div', { className: 'facts' })

  const remove = el('button', {
    className: 'quiet danger',
    onclick: async () => {
      const yes = await askConfirm(`Удалить ${app.name}?`, 'Контейнер, образ и все данные приложения пропадут без возможности вернуть', 'Удалить')
      if (!yes) return
      busy(remove, async () => {
        await api(`/api/apps/${id}`, { method: 'DELETE' })
        toast(`${app.name} удалено`)
        location.hash = '#/'
      })
    },
  }, icon('Trash'), 'Удалить')

  const deploy = body => api(`/api/apps/${id}/deploy`, { method: 'POST', body }).then(() => showBuild(id, log, paintLogs, logTitle))
  const redeploy = el('button', {
    onclick: () => {
      if (app.source !== 'upload') return busy(redeploy, () => deploy(new FormData()))
      const picker = el('input', { type: 'file', accept: '.zip' })
      picker.onchange = () => {
        const data = new FormData()
        data.append('archive', picker.files[0])
        busy(redeploy, () => deploy(data))
      }
      picker.click()
    },
  }, icon(app.source === 'upload' ? 'DocumentUpload' : 'Refresh2'), app.source === 'upload' ? 'Новый архив' : 'Пересобрать')

  const command = (action, label, name, className = '') => {
    const button = el('button', {
      className,
      onclick: () => busy(button, async () => {
        await api(`/api/apps/${id}/${action}`, { method: 'POST' })
        connectLogs(id, log, paintLogs)
      }),
    }, icon(name), label)
    return button
  }
  const start = command('start', 'Запустить', 'Play', 'primary')
  const stop = command('stop', 'Остановить', 'Stop')
  const again = command('restart', 'Перезапустить', 'RotateRight')
  actions.append(start, stop, again, redeploy, remove)

  $('page').replaceChildren(el('div', { className: 'page-inner' },
    el('header', { className: 'page-head' }, mark, el('h1', { textContent: app.name }), title, actions),
    el('div', { className: 'app-grid' },
      el('section', { className: 'card log-card' },
        el('div', { className: 'log-tools' },
          logTitle,
          filter,
          follow,
          el('button', {
            className: 'quiet',
            title: 'Скопировать',
            ariaLabel: 'Скопировать логи',
            onclick: () => navigator.clipboard?.writeText(logs.textContent).then(() => toast('Логи скопированы')),
          }, icon('Copy')),
          el('button', {
            className: 'quiet',
            title: 'Очистить экран',
            ariaLabel: 'Очистить экран',
            onclick: () => {
              log.text = ''
              paintLogs()
            },
          }, icon('CloseCircle'))),
        logs),
      el('div', { className: 'side-stack' },
        el('section', { className: 'card' }, el('h2', {}, icon('Slider'), 'Порция'), usage, el('div', { style: 'height:16px' }), cpu.node, ram.node),
        el('section', { className: 'card' }, el('h2', {}, icon('Setting2'), 'Запуск'), form),
        el('section', { className: 'card' }, el('h2', {}, icon('FolderOpen'), 'Источник'), facts)))))

  view = { id, title, mark, cpu, ram, usage, start, stop, again, redeploy, log, logTitle, paintLogs, lastState: null }
  if (app.state === 'building' || app.state === 'failed') showBuild(id, log, paintLogs, logTitle)
  else connectLogs(id, log, paintLogs)
}

function updateApp() {
  const app = findApp(view.id)
  if (!app) return
  view.title.textContent = stateText(app)
  view.mark.replaceChildren(tileMark(app))

  const running = app.state === 'running'
  const building = app.state === 'building'
  view.start.hidden = running || building
  view.stop.hidden = !running
  view.again.hidden = !running
  view.redeploy.disabled = building

  const free = freeFor(app.id)
  view.cpu.setMax(free.cpus)
  view.ram.setMax(free.memoryMb)
  view.usage.replaceChildren(
    el('div', {}, el('span', { textContent: 'Сейчас CPU' }), el('span', { className: 'mono', textContent: app.stats ? withCores(app.stats.cpuCores) : '–' })),
    el('div', {}, el('span', { textContent: 'Сейчас RAM' }), el('span', { className: 'mono', textContent: app.stats ? gb(app.stats.memoryMb) : '–' })))

  if (view.lastState === 'building' && app.state !== 'building') {
    if (app.buildError) toast(app.buildError, true)
    else toast('Сборка закончена')
  }
  view.lastState = app.state
}

function connectLogs(id, log, paint) {
  logSocket?.close()
  if (route.id !== id) return
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${scheme}://${location.host}/ws/logs/${id}`)
  let fresh = true
  socket.onmessage = event => {
    log.text = ((fresh ? '' : log.text) + event.data).slice(-200000)
    fresh = false
    paint()
  }
  socket.onclose = () => {
    if (logSocket !== socket || route.id !== id) return
    setTimeout(() => {
      if (logSocket === socket && route.id === id && findApp(id)?.state === 'running') connectLogs(id, log, paint)
    }, 2000)
  }
  logSocket = socket
}

function showBuild(id, log, paint, label) {
  logSocket?.close()
  logSocket = null
  label.textContent = 'Сборка'
  const poll = async () => {
    if (route.id !== id) return
    const build = await api(`/api/apps/${id}/build`).catch(() => null)
    if (!build) return
    log.text = build.log
    paint()
    if (build.running) return setTimeout(poll, 1000)
    if (!build.error) {
      label.textContent = 'Логи'
      connectLogs(id, log, paint)
    }
  }
  poll()
}

function openCreate() {
  let source = 'upload'
  let archive = null
  const box = $('create')
  const free = freeFor(null)
  const error = el('p', { className: 'error' })
  const name = el('input', { required: true, pattern: '[a-z0-9][a-z0-9\\-]{0,30}', placeholder: 'my-bot', spellcheck: false, autocomplete: 'off', title: 'Латиница в нижнем регистре, цифры и дефис' })
  const dropText = el('span', { textContent: 'Перетащи zip сюда или нажми' })
  const picker = el('input', { type: 'file', accept: '.zip', hidden: true })
  const setArchive = file => {
    archive = file
    dropText.textContent = file ? file.name : 'Перетащи zip сюда или нажми'
    drop.classList.toggle('filled', Boolean(file))
    if (file && !name.value) {
      name.value = file.name.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31)
    }
  }
  const drop = el('label', { className: 'drop' }, icon('DocumentUpload'), dropText, picker)
  picker.onchange = () => setArchive(picker.files[0] || null)
  drop.ondragover = event => {
    event.preventDefault()
    drop.classList.add('over')
  }
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = event => {
    event.preventDefault()
    drop.classList.remove('over')
    setArchive(event.dataTransfer.files[0] || null)
  }

  const gitUrl = el('input', { placeholder: 'https://github.com/you/bot', spellcheck: false })
  const image = el('input', { placeholder: 'redis:7-alpine', spellcheck: false })
  const gitField = el('label', { className: 'field', hidden: true }, 'Ссылка на репозиторий', gitUrl)
  const imageField = el('label', { className: 'field', hidden: true }, 'Образ', image)

  const cpu = limitField({ label: 'CPU', min: 0.05, step: 0.05, max: free.cpus, value: Math.min(0.25, free.cpus), unit: 'ядра', hint: cpuHint })
  const ram = limitField({ label: 'RAM', min: 32, step: 32, max: free.memoryMb, value: Math.min(256, free.memoryMb), unit: 'МБ', hint: ramHint })

  const startCmd = el('input', { placeholder: 'определится сама', spellcheck: false })
  const baseImage = el('input', { placeholder: 'eclipse-temurin:21-jre', spellcheck: false })
  const baseField = el('label', { className: 'field' }, 'Базовый образ', baseImage, el('small', { textContent: 'Нужен, если проект не распознаётся' }))
  const port = el('input', { type: 'number', min: 1, max: 65535, placeholder: '3000' })
  const hostPort = el('input', { type: 'number', min: 1, max: 65535, placeholder: 'закрыт' })
  const dataPath = el('input', { value: '/data', spellcheck: false })
  const env = el('textarea', { rows: 3, spellcheck: false, placeholder: 'TOKEN=abc' })

  const segments = Object.entries(SOURCES).map(([key, [label, iconName]]) => el('button', {
    type: 'button',
    className: key === source ? 'active' : '',
    onclick: event => {
      source = key
      for (const button of segments) button.classList.toggle('active', button === event.currentTarget)
      drop.hidden = key !== 'upload'
      gitField.hidden = key !== 'git'
      imageField.hidden = key !== 'image'
      baseField.hidden = key === 'image'
    },
  }, icon(iconName), label))

  const submit = el('button', { className: 'primary', type: 'submit' }, 'Создать')
  const form = el('form', {
    className: 'form',
    onsubmit: async event => {
      event.preventDefault()
      error.textContent = ''
      if (source === 'upload' && !archive) {
        error.textContent = 'Выбери zip-архив'
        return
      }
      const data = new FormData()
      const fields = {
        name: name.value,
        source,
        gitUrl: gitUrl.value,
        image: image.value,
        cpus: cpu.value,
        memoryMb: ram.value,
        startCmd: startCmd.value,
        baseImage: source === 'image' ? '' : baseImage.value,
        port: port.value,
        hostPort: hostPort.value,
        dataPath: dataPath.value,
        env: env.value,
      }
      for (const [key, value] of Object.entries(fields)) data.set(key, value)
      if (source === 'upload') data.set('archive', archive)
      submit.disabled = true
      try {
        const { id } = await api('/api/apps', { method: 'POST', body: data })
        box.close()
        await refresh()
        location.hash = `#/app/${id}`
      } catch (err) {
        error.textContent = err.message
      } finally {
        submit.disabled = false
      }
    },
  },
  el('h2', { textContent: 'Новое приложение' }),
  el('div', { className: 'segments' }, ...segments),
  drop,
  gitField,
  imageField,
  el('label', { className: 'field' }, 'Имя', name),
  el('div', {}, cpu.node, ram.node),
  el('details', {},
    el('summary', { textContent: 'Дополнительно' }),
    el('div', { className: 'form' },
      el('label', { className: 'field' }, 'Команда запуска', startCmd),
      baseField,
      el('div', { className: 'pair' },
        el('label', { className: 'field' }, 'Порт приложения', port),
        el('label', { className: 'field' }, 'Внешний порт', hostPort)),
      el('label', { className: 'field' }, 'Папка данных', dataPath),
      el('label', { className: 'field' }, 'Окружение', env))),
  error,
  el('div', { className: 'dialog-actions' },
    el('button', { type: 'button', textContent: 'Отмена', onclick: () => box.close() }),
    submit))

  box.replaceChildren(form)
  box.showModal()
}

function parseRoute() {
  const id = /^#\/app\/([a-z0-9-]+)$/.exec(location.hash)?.[1]
  return id ? { view: 'app', id } : { view: 'overview' }
}

function mount() {
  logSocket?.close()
  logSocket = null
  route = parseRoute()
  const app = route.view === 'app' && findApp(route.id)
  if (route.view === 'app' && !app) route = { view: 'overview' }
  if (route.view === 'app') mountApp(app)
  else mountOverview()
  $('page').scrollTop = 0
}

function render() {
  drawSidebar()
  if (route.view === 'app') updateApp()
  else updateOverview()
}

async function refresh() {
  try {
    const first = !overview
    overview = await api('/api/overview')
    $('login').hidden = true
    $('shell').hidden = false
    if (first || (route.view === 'app' && !findApp(route.id))) mount()
    render()
  } catch (err) {
    if (err.status === 401) {
      overview = null
      logSocket?.close()
      $('shell').hidden = true
      $('login').hidden = false
    }
  }
}

$('add').append(icon('Add'))
$('add').onclick = openCreate
$('logout').append(icon('Logout'), 'Выйти')
$('logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {})
  refresh()
}

window.onhashchange = () => {
  if (!overview) return
  mount()
  render()
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
setInterval(() => !document.hidden && !$('shell').hidden && refresh(), 3000)
