import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import AdmZip from 'adm-zip'
import * as store from './store.js'

const HIDDEN = new Set(['.tessera.Dockerfile', '.git'])
const TEXT_LIMIT = 1024 * 1024
const MAX_UNPACKED = 1024 * 1024 * 1024

function fail(status, message) {
  return Object.assign(new Error(message), { status })
}

const srcDir = id => path.join(store.appDir(id), 'src')

function fileName(name) {
  const value = String(name ?? '').trim()
  if (!value || value === '.' || value === '..' || /[/\\\0]/.test(value)) throw fail(400, 'Плохое имя файла')
  return value
}

const inside = (root, target) => target === root || target.startsWith(root + path.sep)

// Символические ссылки из репозитория не должны уводить панель за пределы кода
function resolvePath(id, relative) {
  const value = String(relative ?? '')
  if (value.includes('\0')) throw fail(400, 'Плохой путь')
  const root = path.resolve(srcDir(id))
  // resolve снимает хвостовой слэш, иначе проверки на корень не совпадут с root
  const target = path.resolve(path.join(root, path.normalize(`/${value}`)))
  let existing = target
  while (!fs.existsSync(existing) && existing !== root) existing = path.dirname(existing)
  if (fs.existsSync(existing) && !inside(fs.realpathSync(root), fs.realpathSync(existing))) throw fail(404, 'Файла нет')
  return target
}

export function list(id, relative) {
  const target = resolvePath(id, relative)
  if (!fs.existsSync(target)) {
    if (target === path.resolve(srcDir(id))) return []
    throw fail(404, 'Папки нет')
  }
  const entries = fs.readdirSync(target, { withFileTypes: true }).filter(entry => !HIDDEN.has(entry.name)).map(entry => {
    const stat = fs.lstatSync(path.join(target, entry.name))
    const type = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file'
    return { name: entry.name, type, size: stat.size, mtime: stat.mtimeMs }
  })
  return entries.sort((a, b) => (b.type === 'dir') - (a.type === 'dir') || a.name.localeCompare(b.name))
}

function fileAt(id, relative) {
  const target = resolvePath(id, relative)
  const stat = fs.existsSync(target) ? fs.lstatSync(target) : null
  if (!stat) throw fail(404, 'Файла нет')
  if (!stat.isFile()) throw fail(400, 'Это не файл')
  return { target, stat }
}

export function read(id, relative) {
  const { target, stat } = fileAt(id, relative)
  if (stat.size > TEXT_LIMIT) return { size: stat.size, tooLarge: true }
  const data = fs.readFileSync(target)
  if (data.includes(0)) return { size: stat.size, binary: true }
  try {
    return { size: stat.size, text: new TextDecoder('utf-8', { fatal: true }).decode(data) }
  } catch {
    return { size: stat.size, binary: true }
  }
}

export async function download(id, relative, res) {
  const { target, stat } = fileAt(id, relative)
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Length', stat.size)
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`)
  await pipeline(fs.createReadStream(target), res)
}

export function writeText(id, relative, text) {
  const target = resolvePath(id, relative)
  if (target === path.resolve(srcDir(id))) throw fail(400, 'Нужно имя файла')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, String(text))
}

export function uploadFile(id, relativeDir, name, tempPath) {
  const dir = resolvePath(id, relativeDir)
  const target = path.join(dir, fileName(name))
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(tempPath, target)
}

export function makeDir(id, relativeDir, name) {
  const target = path.join(resolvePath(id, relativeDir), fileName(name))
  if (fs.existsSync(target)) throw fail(409, 'Такое имя уже есть')
  fs.mkdirSync(target, { recursive: true })
}

export function remove(id, relative) {
  const target = resolvePath(id, relative)
  if (target === path.resolve(srcDir(id))) throw fail(400, 'Корень удалить нельзя')
  fs.rmSync(target, { recursive: true, force: true })
}

export function unpackZip(file, dir) {
  const zip = new AdmZip(file)
  const entries = zip.getEntries()
  const unpacked = entries.reduce((sum, e) => sum + e.header.size, 0)
  if (unpacked > MAX_UNPACKED) throw fail(400, 'Архив слишком большой после распаковки')
  const root = path.resolve(dir)
  for (const entry of entries) {
    const target = path.resolve(root, entry.entryName)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw fail(400, `Опасный путь в архиве: ${entry.entryName}`)
    }
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, entry.getData())
    }
  }
  const items = fs.readdirSync(root)
  if (items.length === 1 && fs.statSync(path.join(root, items[0])).isDirectory()) {
    const nested = path.join(root, items[0])
    for (const name of fs.readdirSync(nested)) fs.renameSync(path.join(nested, name), path.join(root, name))
    fs.rmdirSync(nested)
  }
}

// Распаковка поверх: одноимённые файлы заменяются, остальные остаются
export function unpackOver(id, relativeDir, tempPath) {
  const dir = resolvePath(id, relativeDir)
  const staging = path.join(store.appDir(id), 'unpack')
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    unpackZip(tempPath, staging)
    fs.cpSync(staging, dir, { recursive: true, force: true })
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
