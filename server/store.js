import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DATA_DIR = path.resolve(process.env.TESSERA_DATA || 'data')
const APPS_FILE = path.join(DATA_DIR, 'apps.json')
const AUTH_FILE = path.join(DATA_DIR, 'auth.json')

fs.mkdirSync(path.join(DATA_DIR, 'apps'), { recursive: true })
fs.mkdirSync(path.join(DATA_DIR, 'tmp'), { recursive: true })

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback)

function writeJson(file, value, mode) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode })
  fs.renameSync(tmp, file)
}

const apps = new Map(readJson(APPS_FILE, []).map(app => [app.id, app]))
const save = () => writeJson(APPS_FILE, [...apps.values()], 0o600)

export const listApps = () => [...apps.values()]
export const getApp = id => apps.get(id)
export const appDir = id => path.join(DATA_DIR, 'apps', id)

export function putApp(app) {
  apps.set(app.id, app)
  save()
  return app
}

export function removeApp(id) {
  apps.delete(id)
  save()
  fs.rmSync(appDir(id), { recursive: true, force: true })
}

const hash = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex')

export function setPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  writeJson(AUTH_FILE, { salt, hash: hash(password, salt) }, 0o600)
}

// Возвращает сгенерированный пароль только при самом первом запуске
export function ensurePassword() {
  if (fs.existsSync(AUTH_FILE)) return null
  const given = process.env.TESSERA_PASSWORD
  const password = given || crypto.randomBytes(12).toString('base64url')
  setPassword(password)
  return given ? null : password
}

export function checkPassword(password) {
  const auth = readJson(AUTH_FILE, null)
  if (!auth || typeof password !== 'string') return false
  return crypto.timingSafeEqual(Buffer.from(hash(password, auth.salt), 'hex'), Buffer.from(auth.hash, 'hex'))
}
