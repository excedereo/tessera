import { docker, containerName, TERMINAL_ENV } from './docker.js'

// Ctrl+P Ctrl+Q у Docker по умолчанию отключает от контейнера и съедает Ctrl+P.
// Ставим сочетание, которое в TUI почти не встречается
const DETACH_KEYS = 'ctrl-],ctrl-]'
const SHELL = 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clamp = (value, min, max) => Math.min(Math.max(Math.round(Number(value) || 0), min), max)
const size = (cols, rows) => ({ w: clamp(cols, 10, 500), h: clamp(rows, 4, 200) })

function say(ws, text) {
  if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[90m${text}\x1b[0m\r\n`)
}

// Docker не завершает оболочку, когда соединение закрыто: она остаётся висеть.
// Поэтому оболочка пишет свой PID, а при закрытии всей её сессии шлётся SIGHUP
// Если вкладку закрыли сразу, оболочка могла ещё не успеть записать PID
const HANGUP = `i=0
while [ ! -s "$1" ] && [ $i -lt 30 ]; do sleep 0.1 2>/dev/null || sleep 1; i=$((i + 1)); done
p=$(cat "$1" 2>/dev/null) || exit 0
rm -f "$1"
for d in /proc/[0-9]*; do
  [ "$(cut -d' ' -f6 "$d/stat" 2>/dev/null)" = "$p" ] && kill -HUP "\${d#/proc/}" 2>/dev/null
done
exit 0`

async function hangup(container, pidFile) {
  const exec = await container.exec({ Cmd: ['sh', '-c', HANGUP, 'sh', pidFile], AttachStdout: true, AttachStderr: true })
  const stream = await exec.start({})
  stream.resume()
  await new Promise(resolve => stream.on('end', resolve))
}

async function openShell(container, { w, h }) {
  const pidFile = `/tmp/.tessera-shell-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const exec = await container.exec({
    Cmd: ['sh', '-c', `echo $$ > "$1" 2>/dev/null; ${SHELL}`, 'sh', pidFile],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: TERMINAL_ENV,
    DetachKeys: DETACH_KEYS,
  })
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true })
  const resize = next => exec.resize(next)
  await resize({ w, h }).catch(() => {})
  const close = async () => {
    stream.destroy()
    await hangup(container, pidFile)
  }
  return { stream, resize, close }
}

async function openApp(container, { w, h }) {
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true, detachKeys: DETACH_KEYS })
  const resize = next => container.resize(next)
  await resize({ w, h }).catch(() => {})
  // TUI рисует экран только при изменении размера. Первый кадр после смены ширины
  // бывает со старой разметкой, поэтому ждём его, чистим экран и просим кадр ещё раз
  const redraw = async ws => {
    await sleep(250)
    if (ws.readyState === ws.OPEN) ws.send('\x1b[2J\x1b[3J\x1b[H')
    await resize({ w: Math.max(w - 1, 10), h }).catch(() => {})
    await sleep(120)
    await resize({ w, h }).catch(() => {})
  }
  return { stream, resize, redraw, close: async () => stream.end() }
}

export async function connect(ws, id, mode, cols, rows) {
  const container = docker.getContainer(containerName(id))
  let session
  // Вкладку могут закрыть, пока оболочка ещё открывается: тогда закрываем её сразу после открытия
  let closed = false
  ws.on('close', () => {
    closed = true
    session?.close().catch(() => {})
  })
  try {
    const info = await container.inspect()
    if (!info.State.Running) {
      say(ws, 'Приложение не запущено')
      return ws.close()
    }
    if (mode === 'attach' && !(info.Config.Tty && info.Config.OpenStdin)) {
      say(ws, 'Интерактивный режим выключен: включи его в настройках запуска')
      return ws.close()
    }
    session = mode === 'attach' ? await openApp(container, size(cols, rows)) : await openShell(container, size(cols, rows))
    if (closed) return session.close().catch(() => {})
  } catch (err) {
    say(ws, err.statusCode === 404 ? 'Контейнера пока нет' : `Ошибка: ${err.message}`)
    return ws.close()
  }

  const { stream, resize } = session
  stream.on('data', chunk => ws.readyState === ws.OPEN && ws.send(chunk))
  stream.on('end', () => {
    say(ws, mode === 'attach' ? 'Приложение завершилось' : 'Сессия закрыта')
    ws.close()
  })
  stream.on('error', () => ws.close())
  session.redraw?.(ws)

  ws.on('message', raw => {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.t === 'in' && typeof message.d === 'string') stream.write(message.d)
    if (message.t === 'resize') resize(size(message.cols, message.rows)).catch(() => {})
  })
}
