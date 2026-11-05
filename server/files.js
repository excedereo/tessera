import fs from 'node:fs'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import tarStream from 'tar-stream'
import { docker, volumeName } from './docker.js'

// Панель работает от root, поэтому к тому она не ходит напрямую: символическая
// ссылка из приложения увела бы её на файлы сервера. Всё идёт через одноразовый
// контейнер без сети, в котором виден только том этого приложения
const HELPER_IMAGE = 'busybox:1.37'
const ROOT = '/data'
const TEXT_LIMIT = 1024 * 1024

let imageReady = null

function ensureImage() {
  imageReady ||= docker.getImage(HELPER_IMAGE).inspect().catch(async () => {
    const stream = await docker.pull(HELPER_IMAGE)
    await new Promise((resolve, reject) => docker.modem.followProgress(stream, err => (err ? reject(err) : resolve())))
  }).catch(err => {
    imageReady = null
    throw err
  })
  return imageReady
}

function fail(status, message) {
  return Object.assign(new Error(message), { status })
}

export function resolvePath(relative) {
  const value = String(relative ?? '')
  if (value.includes('\0')) throw fail(400, 'Плохой путь')
  // Без хвостового слэша, иначе проверки на корень не совпадут с ROOT
  return posix.join(ROOT, posix.normalize(`/${value}`)).replace(/\/+$/, '')
}

function fileName(name) {
  const value = String(name ?? '').trim()
  if (!value || value === '.' || value === '..' || /[/\\\0]/.test(value)) throw fail(400, 'Плохое имя файла')
  return value
}

async function createHelper(id, cmd) {
  await ensureImage()
  return docker.createContainer({
    Image: HELPER_IMAGE,
    Cmd: cmd,
    Tty: true,
    NetworkDisabled: true,
    Labels: { 'tessera.helper': id },
    HostConfig: { Binds: [`${volumeName(id)}:${ROOT}`], Memory: 64 * 1024 * 1024, PidsLimit: 32 },
  })
}

async function withHelper(id, fn) {
  const container = await createHelper(id, ['true'])
  try {
    return await fn(container)
  } finally {
    await container.remove({ force: true }).catch(() => {})
  }
}

async function run(id, script, ...args) {
  const container = await createHelper(id, ['sh', '-c', script, 'sh', ...args])
  try {
    await container.start()
    const { StatusCode } = await container.wait()
    const output = (await container.logs({ stdout: true, stderr: true })).toString().replace(/\r/g, '')
    return { code: StatusCode, output }
  } finally {
    await container.remove({ force: true }).catch(() => {})
  }
}

const LIST_SCRIPT = `cd "$1" || exit 44
for f in * .[!.]* ..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  stat -c '%F|%s|%Y|%n' -- "$f"
done`

const TYPES = { directory: 'dir', 'symbolic link': 'link' }

export async function list(id, relative) {
  const { code, output } = await run(id, LIST_SCRIPT, resolvePath(relative))
  if (code === 44) throw fail(404, 'Папки нет')
  if (code !== 0) throw new Error(output.trim() || `Код ${code}`)
  const entries = output.split('\n').filter(Boolean).map(line => {
    const [kind, size, mtime, ...name] = line.split('|')
    return { name: name.join('|'), type: TYPES[kind] || 'file', size: Number(size), mtime: Number(mtime) * 1000 }
  })
  return entries.sort((a, b) => (b.type === 'dir') - (a.type === 'dir') || a.name.localeCompare(b.name))
}

// Открывает файл из архива Docker и отдаёт его поток в handler
function withEntry(container, target, handler) {
  return new Promise((resolve, reject) => {
    container.getArchive({ path: target }).then(archive => {
      const extract = tarStream.extract()
      let done = false
      const finish = (err, value) => {
        if (done) return
        done = true
        archive.destroy()
        err ? reject(err) : resolve(value)
      }
      extract.once('entry', (header, stream, next) => {
        if (header.type !== 'file') {
          stream.resume()
          return finish(fail(400, 'Это не файл'))
        }
        handler(header, stream).then(value => finish(null, value), finish)
      })
      extract.on('error', finish)
      extract.on('finish', () => finish(fail(404, 'Файла нет')))
      archive.on('error', finish)
      archive.pipe(extract)
    }, err => reject(err.statusCode === 404 ? fail(404, 'Файла нет') : err))
  })
}

export function read(id, relative) {
  return withHelper(id, container => withEntry(container, resolvePath(relative), async (header, stream) => {
    if (header.size > TEXT_LIMIT) {
      stream.destroy()
      return { size: header.size, tooLarge: true }
    }
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const data = Buffer.concat(chunks)
    if (data.includes(0)) return { size: header.size, binary: true }
    try {
      return { size: header.size, text: new TextDecoder('utf-8', { fatal: true }).decode(data) }
    } catch {
      return { size: header.size, binary: true }
    }
  }))
}

export function download(id, relative, res) {
  const target = resolvePath(relative)
  return withHelper(id, container => withEntry(container, target, async (header, stream) => {
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', header.size)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(target))}`)
    await pipeline(stream, res)
  }))
}

// Владелец и права берутся у файла, а новому файлу у папки: иначе приложение
// не под root потеряло бы доступ к тому, что записали из панели
async function ownerOf(id, target) {
  const script = 'stat -c "%u %g %a" -- "$1" 2>/dev/null || stat -c "%u %g 644" -- "$(dirname "$1")"'
  const { code, output } = await run(id, script, target)
  if (code !== 0) throw fail(404, 'Папки нет')
  const [uid, gid, mode] = output.trim().split(' ')
  return { uid: Number(uid), gid: Number(gid), mode: parseInt(mode, 8) }
}

async function put(id, target, size, fill) {
  const owner = await ownerOf(id, target)
  const pack = tarStream.pack()
  await withHelper(id, async container => {
    const upload = container.putArchive(pack, { path: posix.dirname(target), copyUIDGID: 'true' })
    await fill(pack, { name: posix.basename(target), size, ...owner })
    pack.finalize()
    await upload
  })
}

export function writeText(id, relative, text) {
  const target = resolvePath(relative)
  if (target === ROOT) throw fail(400, 'Нужно имя файла')
  const data = Buffer.from(String(text), 'utf8')
  return put(id, target, data.length, (pack, header) => new Promise((resolve, reject) => {
    pack.entry(header, data, err => (err ? reject(err) : resolve()))
  }))
}

export function uploadFile(id, relativeDir, name, tempPath) {
  const target = posix.join(resolvePath(relativeDir), fileName(name))
  const { size } = fs.statSync(tempPath)
  return put(id, target, size, async (pack, header) => {
    await pipeline(fs.createReadStream(tempPath), pack.entry(header))
  })
}

export async function makeDir(id, relativeDir, name) {
  const target = posix.join(resolvePath(relativeDir), fileName(name))
  const script = 'mkdir -- "$1" && chown "$(stat -c %u:%g -- "$(dirname "$1")")" -- "$1"'
  const { code, output } = await run(id, script, target)
  if (code !== 0) throw fail(409, /exists/i.test(output) ? 'Такое имя уже есть' : output.trim())
}

// Распаковка через временную папку: файлы получают владельца папки, а не root
const UNZIP_SCRIPT = `d=$(dirname "$1")
t="$d/.tessera-unzip"
rm -rf "$t"
mkdir "$t" && unzip -oq "$1" -d "$t" && chown -R "$(stat -c %u:%g -- "$d")" "$t" && cp -a "$t"/. "$d"/
c=$?
rm -rf "$t"
exit $c`

export async function unzip(id, relative) {
  const target = resolvePath(relative)
  if (!target.toLowerCase().endsWith('.zip')) throw fail(400, 'Это не zip')
  const { code, output } = await run(id, UNZIP_SCRIPT, target)
  if (code !== 0) throw fail(400, output.trim() || 'Не удалось распаковать')
}

export async function remove(id, relative) {
  const target = resolvePath(relative)
  if (target === ROOT) throw fail(400, 'Корень удалить нельзя')
  const { code, output } = await run(id, 'rm -rf -- "$1"', target)
  if (code !== 0) throw new Error(output.trim() || `Код ${code}`)
}
