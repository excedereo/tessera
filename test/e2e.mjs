// Сквозной тест на настоящем Docker: node test/e2e.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import AdmZip from 'adm-zip'
import WebSocket from 'ws'

const PORT = 8031
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'test-password'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-e2e-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

let cookie = ''
let failed = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` -> ${detail}` : ''}`)
  if (!ok) failed++
}

async function call(url, options = {}) {
  const init = { ...options, headers: { ...options.headers, cookie } }
  if (options.json !== undefined) {
    init.method ||= 'POST'
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.json)
  }
  const res = await fetch(BASE + url, init)
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) }
}

function zipOf(files) {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content))
  return zip.toBuffer()
}

function createForm(fields, archive) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
  if (archive) form.set('archive', new Blob([archive]), 'app.zip')
  return form
}

const create = (fields, archive) => call('/api/apps', { method: 'POST', body: createForm(fields, archive) })

async function waitBuild(id) {
  for (let i = 0; i < 180; i++) {
    const { body } = await call(`/api/apps/${id}/build`)
    if (!body.running) return body
    await sleep(1000)
  }
  throw new Error(`Сборка ${id} не закончилась`)
}

function readLogs(id, needle) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/logs/${id}`, { headers: { cookie, origin: BASE } })
    let text = ''
    const timer = setTimeout(() => { ws.close(); resolve(text) }, 8000)
    ws.on('message', data => {
      text += data
      if (text.includes(needle)) { clearTimeout(timer); ws.close(); resolve(text) }
    })
    ws.on('error', () => { clearTimeout(timer); resolve(text) })
  })
}

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, TESSERA_DATA: dataDir, TESSERA_PORT: String(PORT), TESSERA_PASSWORD: PASSWORD },
  stdio: ['ignore', 'inherit', 'inherit'],
})

try {
  await sleep(1500)

  check('без входа 401', (await call('/api/overview')).status === 401)
  check('неверный пароль 401', (await call('/api/login', { json: { password: 'nope' } })).status === 401)
  const login = await call('/api/login', { json: { password: PASSWORD } })
  check('вход', login.status === 200)
  cookie = login.headers.get('set-cookie').split(';')[0]

  const { host } = (await call('/api/overview')).body
  console.log(`host: ${host.cpus} cpu, ${host.memoryMb} MB`)

  const py = await create({ name: 't-py', source: 'upload', cpus: 0.5, memoryMb: 128 }, zipOf({
    'proj/requirements.txt': 'six==1.16.0\n',
    'proj/bot.py': 'import six, time\nprint("bot alive", flush=True)\nwhile True: time.sleep(1)\n',
  }))
  check('python принят', py.status === 202, JSON.stringify(py.body))
  const pyBuild = await waitBuild('t-py')
  check('python собран', !pyBuild.error, pyBuild.error + pyBuild.log.slice(-400))
  check('логи через ws', (await readLogs('t-py', 'bot alive')).includes('bot alive'))

  const node = await create({ name: 't-node', source: 'upload', cpus: 0.25, memoryMb: 128, port: 3000, hostPort: 18099, env: 'GREETING=привет' }, zipOf({
    'package.json': '{"name":"t","main":"index.js"}',
    'index.js': 'require("http").createServer((q,s)=>s.end(process.env.GREETING)).listen(3000)',
  }))
  check('node принят', node.status === 202, JSON.stringify(node.body))
  const nodeBuild = await waitBuild('t-node')
  check('node собран', !nodeBuild.error, nodeBuild.error + nodeBuild.log.slice(-400))
  await sleep(1500)
  const reply = await fetch('http://127.0.0.1:18099').then(r => r.text()).catch(err => err.message)
  check('порт и окружение работают', reply === 'привет', reply)

  const image = await create({ name: 't-redis', source: 'image', image: 'redis:7-alpine', cpus: 0.25, memoryMb: 64 })
  check('образ принят', image.status === 202, JSON.stringify(image.body))
  const imageBuild = await waitBuild('t-redis')
  check('образ запущен', !imageBuild.error, imageBuild.error + imageBuild.log.slice(-400))

  const tooMuch = await create({ name: 't-big', source: 'image', image: 'redis:7-alpine', cpus: host.cpus, memoryMb: 64 })
  check('лишний CPU отклонён', tooMuch.status === 409, JSON.stringify(tooMuch.body))
  const tooMuchRam = await create({ name: 't-big', source: 'image', image: 'redis:7-alpine', cpus: 0.1, memoryMb: host.usableMb })
  check('лишняя RAM отклонена', tooMuchRam.status === 409, JSON.stringify(tooMuchRam.body))
  const samePort = await create({ name: 't-port', source: 'image', image: 'redis:7-alpine', cpus: 0.1, memoryMb: 64, port: 6379, hostPort: 18099 })
  check('занятый порт отклонён', samePort.status === 409, JSON.stringify(samePort.body))

  const before = docker('inspect', '-f', '{{.Id}}', 'tessera-t-py')
  const patch = await call('/api/apps/t-py', { method: 'PATCH', json: { cpus: 1, memoryMb: 256 } })
  check('лимиты изменены', patch.status === 200 && patch.body.recreated === false, JSON.stringify(patch.body))
  const limits = docker('inspect', '-f', '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}', 'tessera-t-py')
  check('docker видит новые лимиты', limits === `1000000000 ${256 * 1024 * 1024}`, limits)
  check('контейнер не пересоздан', docker('inspect', '-f', '{{.Id}}', 'tessera-t-py') === before)

  await sleep(6000)
  await call('/api/overview')
  await sleep(4000)
  const live = (await call('/api/overview')).body.apps.find(a => a.id === 't-py')
  check('статистика идёт', live.stats && live.stats.memoryMb > 0, JSON.stringify(live))
  check('состояние running', live.state === 'running', live.state)

  await call('/api/apps/t-py/stop', { method: 'POST' })
  check('остановка', docker('inspect', '-f', '{{.State.Status}}', 'tessera-t-py') === 'exited')
  await call('/api/apps/t-py/start', { method: 'POST' })
  check('запуск', docker('inspect', '-f', '{{.State.Status}}', 'tessera-t-py') === 'running')

  const evil = new AdmZip()
  evil.addFile('main.py', Buffer.from('print(1)'))
  evil.getEntries()[0].entryName = '../../../evil.py'
  await create({ name: 't-evil', source: 'upload', cpus: 0.1, memoryMb: 64 }, evil.toBuffer())
  const evilBuild = await waitBuild('t-evil')
  check('опасный архив отклонён', /Опасный путь/.test(evilBuild.error || ''), JSON.stringify(evilBuild))
  check('файл не вылез наружу', !fs.existsSync(path.join(dataDir, 'evil.py')) && !fs.existsSync(path.join(dataDir, 'apps', 'evil.py')))

  const badWs = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/logs/t-py`, { headers: { origin: BASE } })
    ws.on('open', () => resolve('open'))
    ws.on('error', () => resolve('refused'))
  })
  check('ws без входа закрыт', badWs === 'refused', badWs)

  for (const id of ['t-py', 't-node', 't-redis', 't-evil']) {
    const res = await call(`/api/apps/${id}`, { method: 'DELETE' })
    check(`удалено ${id}`, res.status === 200, JSON.stringify(res.body))
  }
  check('контейнеров не осталось', docker('ps', '-aq', '--filter', 'label=tessera.app') === '')
  check('томов не осталось', !docker('volume', 'ls', '-q').includes('tessera-t-'))
} catch (err) {
  failed++
  console.error('CRASH', err)
} finally {
  server.kill()
  try {
    const left = docker('ps', '-aq', '--filter', 'label=tessera.app')
    if (left) docker('rm', '-f', ...left.split(/\s+/))
  } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true })
  console.log(failed ? `\nПровалено: ${failed}` : '\nВсё прошло')
  process.exit(failed ? 1 : 0)
}
