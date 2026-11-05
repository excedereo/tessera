import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'
import multer from 'multer'
import { WebSocketServer } from 'ws'
import * as store from './store.js'
import * as engine from './docker.js'
import * as files from './files.js'
import * as code from './code.js'

const HOST = process.env.TESSERA_HOST || '127.0.0.1'
const PORT = Number(process.env.TESSERA_PORT || 8030)
const SESSION_MS = 7 * 24 * 3600 * 1000
const MAX_UPLOAD = 200 * 1024 * 1024
const BUILD_LOG_LIMIT = 200_000

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const upload = multer({ dest: path.join(store.DATA_DIR, 'tmp'), limits: { fileSize: MAX_UPLOAD }, defParamCharset: 'utf8' })

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const sessions = new Map()
const failures = new Map()

function cookieToken(req) {
  return /(?:^|;\s*)tessera=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1]
}

function authorized(req) {
  const token = cookieToken(req)
  const expires = token && sessions.get(token)
  if (!expires) return false
  if (expires < Date.now()) {
    sessions.delete(token)
    return false
  }
  return true
}

function loginAllowed(ip) {
  const entry = failures.get(ip)
  if (!entry || entry.until < Date.now()) return true
  return entry.count < 5
}

function noteFailure(ip) {
  const entry = failures.get(ip)
  if (!entry || entry.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 60000 })
  else entry.count++
}

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use(express.static(publicDir))

app.post('/api/login', (req, res) => {
  if (!loginAllowed(req.ip)) throw new HttpError(429, 'Слишком много попыток, подожди минуту')
  if (!store.checkPassword(req.body?.password)) {
    noteFailure(req.ip)
    throw new HttpError(401, 'Неверный пароль')
  }
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, Date.now() + SESSION_MS)
  res.setHeader('Set-Cookie', `tessera=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`)
  res.json({ ok: true })
})

app.use('/api', (req, res, next) => {
  if (!authorized(req)) throw new HttpError(401, 'Нужно войти')
  next()
})

app.post('/api/logout', (req, res) => {
  sessions.delete(cookieToken(req))
  res.setHeader('Set-Cookie', 'tessera=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  res.json({ ok: true })
})

const builds = new Map()

function beginBuild(id) {
  if (builds.get(id)?.running) throw new HttpError(409, 'Сборка уже идёт')
  const build = { running: true, error: null, log: '' }
  builds.set(id, build)
  return build
}

function allocated(exceptId) {
  const others = store.listApps().filter(a => a.id !== exceptId)
  return {
    cpus: others.reduce((sum, a) => sum + a.cpus, 0),
    memoryMb: others.reduce((sum, a) => sum + a.memoryMb, 0),
  }
}

async function checkLimits({ cpus, memoryMb }, exceptId) {
  if (!Number.isFinite(cpus) || cpus < 0.05) throw new HttpError(400, 'CPU: минимум 0.05 ядра')
  if (!Number.isInteger(memoryMb) || memoryMb < 32) throw new HttpError(400, 'RAM: минимум 32 МБ')
  const host = await engine.hostInfo()
  const used = allocated(exceptId)
  if (used.cpus + cpus > host.cpus + 1e-9) {
    throw new HttpError(409, `CPU не хватает: свободно ${(host.cpus - used.cpus).toFixed(2)} из ${host.cpus}`)
  }
  if (used.memoryMb + memoryMb > host.usableMb) {
    throw new HttpError(409, `RAM не хватает: свободно ${host.usableMb - used.memoryMb} МБ из ${host.usableMb}`)
  }
}

function parseEnv(text = '') {
  const env = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at < 1) throw new HttpError(400, `Плохая строка окружения: ${line}`)
    const key = line.slice(0, at).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new HttpError(400, `Плохое имя переменной: ${key}`)
    env[key] = line.slice(at + 1)
  }
  return env
}

function parsePort(value, label) {
  if (value === undefined || value === null || value === '') return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, `${label}: порт от 1 до 65535`)
  return port
}

function checkHostPort(hostPort, id) {
  if (!hostPort) return
  if (hostPort === PORT) throw new HttpError(409, 'Этот порт занят самой панелью')
  const owner = store.listApps().find(a => a.hostPort === hostPort && a.id !== id)
  if (owner) throw new HttpError(409, `Порт ${hostPort} уже у приложения ${owner.name}`)
}

function checkDataPath(dataPath) {
  if (!/^\/[\w./-]*$/.test(dataPath) || dataPath === '/' || dataPath.includes('..')) {
    throw new HttpError(400, 'Папка данных: абсолютный путь внутри контейнера')
  }
}

const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]*$/i

function gitClone(url, dir, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', '--', url, dir], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    child.stderr.on('data', chunk => onLine(chunk.toString()))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git clone завершился с кодом ${code}`))))
  })
}

async function deploy(appRecord, build, zipPath) {
  const onLine = line => {
    build.log = (build.log + line).slice(-BUILD_LOG_LIMIT)
  }
  const srcDir = path.join(store.appDir(appRecord.id), 'src')
  try {
    if (appRecord.source === 'image') {
      await engine.pullImage(appRecord.image, onLine)
    } else {
      if (appRecord.source === 'git') {
        fs.rmSync(srcDir, { recursive: true, force: true })
        await gitClone(appRecord.gitUrl, srcDir, onLine)
      } else if (zipPath) {
        fs.rmSync(srcDir, { recursive: true, force: true })
        fs.mkdirSync(srcDir, { recursive: true })
        code.unpackZip(zipPath, srcDir)
      }
      Object.assign(appRecord, await engine.buildApp(appRecord, srcDir, onLine))
      store.putApp(appRecord)
    }
    await engine.createAndStart(appRecord)
    onLine('Запущено\n')
  } catch (err) {
    build.error = err.message
    onLine(`Ошибка: ${err.message}\n`)
  } finally {
    build.running = false
    if (zipPath) fs.rmSync(zipPath, { force: true })
  }
}

function view(a, states, stats) {
  const container = states.get(a.id)
  const build = builds.get(a.id)
  return {
    ...a,
    state: build?.running ? 'building' : container?.state || (build?.error ? 'failed' : 'stopped'),
    status: container?.status || '',
    buildError: build?.error || null,
    stats: stats.get(a.id) || null,
  }
}

app.get('/api/overview', async (req, res) => {
  const [host, states] = await Promise.all([engine.hostInfo(), engine.states()])
  const stats = engine.liveStats()
  res.json({ host, apps: store.listApps().map(a => view(a, states, stats)) })
})

app.post('/api/apps', upload.single('archive'), async (req, res) => {
  const body = req.body
  const id = String(body.name || '').trim().toLowerCase()
  try {
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw new HttpError(400, 'Имя: латиница, цифры и дефис, до 31 символа')
    if (store.getApp(id)) throw new HttpError(409, 'Такое имя уже есть')

    const source = body.source
    if (!['upload', 'git', 'image'].includes(source)) throw new HttpError(400, 'Неизвестный источник')
    if (source === 'upload' && !req.file) throw new HttpError(400, 'Нужен zip-архив')
    if (source === 'git' && !/^(https:\/\/|git@)[\w.@:/~-]+$/.test(body.gitUrl || '')) {
      throw new HttpError(400, 'Git-ссылка: https:// или git@')
    }
    if (source === 'image' && !IMAGE_RE.test(body.image || '')) throw new HttpError(400, 'Плохое имя образа')
    if (body.baseImage && !IMAGE_RE.test(body.baseImage)) throw new HttpError(400, 'Плохой базовый образ')

    const record = {
      id,
      name: id,
      source,
      gitUrl: source === 'git' ? body.gitUrl : null,
      image: source === 'image' ? body.image : null,
      baseImage: body.baseImage || null,
      type: source === 'image' ? 'image' : null,
      startCmd: body.startCmd?.trim() || null,
      port: parsePort(body.port, 'Порт приложения'),
      hostPort: parsePort(body.hostPort, 'Внешний порт'),
      dataPath: body.dataPath?.trim() || '/data',
      env: parseEnv(body.env),
      cpus: Number(body.cpus),
      memoryMb: Number(body.memoryMb),
      restart: body.restart !== 'false',
      createdAt: new Date().toISOString(),
    }
    if (record.hostPort && !record.port) throw new HttpError(400, 'Внешний порт требует порта приложения')
    checkDataPath(record.dataPath)
    checkHostPort(record.hostPort, id)
    await checkLimits(record)

    fs.mkdirSync(store.appDir(id), { recursive: true })
    store.putApp(record)
    deploy(record, beginBuild(id), req.file?.path)
    res.status(202).json({ id })
  } catch (err) {
    if (req.file) fs.rmSync(req.file.path, { force: true })
    throw err
  }
})

function requireApp(req) {
  const record = store.getApp(req.params.id)
  if (!record) throw new HttpError(404, 'Нет такого приложения')
  return record
}

app.patch('/api/apps/:id', async (req, res) => {
  const record = requireApp(req)
  const body = req.body || {}
  const next = { ...record }
  if (body.cpus !== undefined) next.cpus = Number(body.cpus)
  if (body.memoryMb !== undefined) next.memoryMb = Number(body.memoryMb)
  if (body.env !== undefined) next.env = parseEnv(body.env)
  if (body.startCmd !== undefined) next.startCmd = String(body.startCmd).trim() || null
  if (body.restart !== undefined) next.restart = Boolean(body.restart)
  if (body.port !== undefined) next.port = parsePort(body.port, 'Порт приложения')
  if (body.hostPort !== undefined) next.hostPort = parsePort(body.hostPort, 'Внешний порт')
  if (next.hostPort && !next.port) throw new HttpError(400, 'Внешний порт требует порта приложения')
  checkHostPort(next.hostPort, next.id)
  await checkLimits(next, next.id)

  const container = (await engine.states()).get(next.id)
  const recreate = ['startCmd', 'restart', 'port', 'hostPort'].some(key => next[key] !== record[key])
    || JSON.stringify(next.env) !== JSON.stringify(record.env)

  store.putApp(next)
  if (container && recreate) {
    await engine.createAndStart(next)
  } else if (container && (next.cpus !== record.cpus || next.memoryMb !== record.memoryMb)) {
    await engine.docker.getContainer(container.id).update(engine.limitsFor(next))
  }
  res.json({ ok: true, recreated: Boolean(container && recreate) })
})

app.post('/api/apps/:id/deploy', upload.single('archive'), async (req, res) => {
  try {
    const record = requireApp(req)
    if (record.source === 'upload' && !req.file && !fs.existsSync(path.join(store.appDir(record.id), 'src'))) {
      throw new HttpError(400, 'Нужен zip-архив')
    }
    deploy(record, beginBuild(record.id), req.file?.path)
    res.status(202).json({ ok: true })
  } catch (err) {
    if (req.file) fs.rmSync(req.file.path, { force: true })
    throw err
  }
})

app.post('/api/apps/:id/:action', async (req, res) => {
  const record = requireApp(req)
  const { action } = req.params
  if (!['start', 'stop', 'restart'].includes(action)) throw new HttpError(404, 'Нет такого действия')
  const existing = (await engine.states()).get(record.id)
  if (!existing) {
    if (action === 'stop') throw new HttpError(409, 'Контейнера нет')
    if (!record.image) throw new HttpError(409, 'Приложение ещё не собрано')
    await engine.createAndStart(record)
  } else {
    const container = engine.docker.getContainer(existing.id)
    if (action === 'stop') await container.stop({ t: 10 })
    if (action === 'start') await container.start()
    if (action === 'restart') await container.restart({ t: 10 })
  }
  res.json({ ok: true })
})

app.get('/api/apps/:id/build', (req, res) => {
  requireApp(req)
  const build = builds.get(req.params.id)
  res.json(build || { running: false, error: null, log: '' })
})

// scope=code это исходники приложения, всё остальное том с данными
function fileScope(req, { write = false } = {}) {
  const record = requireApp(req)
  if (req.query.scope !== 'code') return { record, backend: files, isCode: false }
  if (record.source === 'image') throw new HttpError(404, 'У готового образа нет кода')
  if (write && record.source === 'git') throw new HttpError(409, 'Код приходит из репозитория, меняй его там')
  if (write && builds.get(record.id)?.running) throw new HttpError(409, 'Сначала дождись конца сборки')
  return { record, backend: code, isCode: true }
}

app.get('/api/apps/:id/files', async (req, res) => {
  const { record, backend } = fileScope(req)
  res.json({ entries: await backend.list(record.id, req.query.path) })
})

app.get('/api/apps/:id/files/content', async (req, res) => {
  const { record, backend } = fileScope(req)
  res.json(await backend.read(record.id, req.query.path))
})

app.put('/api/apps/:id/files/content', async (req, res) => {
  const { record, backend } = fileScope(req, { write: true })
  await backend.writeText(record.id, req.body?.path, req.body?.text ?? '')
  res.json({ ok: true })
})

app.get('/api/apps/:id/files/download', async (req, res) => {
  const { record, backend } = fileScope(req)
  await backend.download(record.id, req.query.path, res)
})

app.post('/api/apps/:id/files/upload', upload.single('file'), async (req, res) => {
  try {
    const { record, backend, isCode } = fileScope(req, { write: true })
    if (!req.file) throw new HttpError(400, 'Нужен файл')
    const unpack = isCode && req.file.originalname.toLowerCase().endsWith('.zip')
    if (unpack) code.unpackOver(record.id, req.body.path, req.file.path)
    else await backend.uploadFile(record.id, req.body.path, req.file.originalname, req.file.path)
    res.json({ ok: true, unpacked: unpack })
  } finally {
    if (req.file) fs.rmSync(req.file.path, { force: true })
  }
})

app.post('/api/apps/:id/files/folder', async (req, res) => {
  const { record, backend } = fileScope(req, { write: true })
  await backend.makeDir(record.id, req.body?.path, req.body?.name)
  res.json({ ok: true })
})

app.post('/api/apps/:id/files/unzip', async (req, res) => {
  await files.unzip(requireApp(req).id, req.body?.path)
  res.json({ ok: true })
})

app.delete('/api/apps/:id/files', async (req, res) => {
  const { record, backend } = fileScope(req, { write: true })
  await backend.remove(record.id, req.query.path)
  res.json({ ok: true })
})

app.delete('/api/apps/:id', async (req, res) => {
  const record = requireApp(req)
  if (builds.get(record.id)?.running) throw new HttpError(409, 'Сначала дождись конца сборки')
  await engine.destroy(record.id)
  store.removeApp(record.id)
  builds.delete(record.id)
  res.json({ ok: true })
})

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(413).json({ error: 'Файл больше 200 МБ' })
  const status = err.status || 500
  if (status === 500) console.error(err)
  res.status(status).json({ error: err.message })
})

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  const id = /^\/ws\/logs\/([a-z0-9-]+)$/.exec(url.pathname)?.[1]
  const sameOrigin = req.headers.origin && new URL(req.headers.origin).host === req.headers.host
  if (!id || !store.getApp(id) || !sameOrigin || !authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, ws => streamLogs(ws, id))
})

async function streamLogs(ws, id) {
  try {
    const container = engine.docker.getContainer(engine.containerName(id))
    const stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 300 })
    const send = { write: chunk => ws.readyState === ws.OPEN && ws.send(chunk.toString()) }
    engine.docker.modem.demuxStream(stream, send, send)
    stream.on('end', () => ws.close())
    ws.on('close', () => stream.destroy())
  } catch (err) {
    ws.send(err.statusCode === 404 ? 'Контейнера пока нет\n' : `Ошибка: ${err.message}\n`)
    ws.close()
  }
}

const generated = store.ensurePassword()

server.listen(PORT, HOST, () => {
  console.log(`Tessera: http://${HOST}:${PORT}`)
  if (generated) console.log(`Пароль (показывается один раз): ${generated}`)
})
