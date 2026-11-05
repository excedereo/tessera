import fs from 'node:fs'
import path from 'node:path'

const has = (dir, name) => fs.existsSync(path.join(dir, name))

function pythonEntry(dir) {
  for (const name of ['main.py', 'bot.py', 'app.py', 'run.py']) if (has(dir, name)) return name
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.py'))
  return files.length === 1 ? files[0] : null
}

function nodeStart(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  if (pkg.scripts?.start) return 'npm start'
  for (const name of [pkg.main, 'index.js', 'main.js', 'bot.js', 'server.js']) {
    if (name && has(dir, name)) return `node ${name}`
  }
  return null
}

const cmd = line => `CMD ${JSON.stringify(['sh', '-c', line])}`

// Возвращает { type, dockerfile }, dockerfile === null значит в проекте уже есть свой
export function detect(dir, { startCmd, baseImage } = {}) {
  if (has(dir, 'Dockerfile')) return { type: 'dockerfile', dockerfile: null }

  if (baseImage) {
    if (!startCmd) throw new Error('Для своего базового образа нужна команда запуска')
    return { type: 'custom', dockerfile: `FROM ${baseImage}\nWORKDIR /app\nCOPY . .\n${cmd(startCmd)}\n` }
  }

  if (has(dir, 'package.json')) {
    const start = startCmd || nodeStart(dir)
    if (!start) throw new Error('Не нашла, чем запускать Node-проект: укажи команду запуска')
    return {
      type: 'node',
      dockerfile: `FROM node:22-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install --omit=dev\nCOPY . .\n${cmd(start)}\n`,
    }
  }

  if (has(dir, 'requirements.txt') || pythonEntry(dir)) {
    const entry = pythonEntry(dir)
    const start = startCmd || (entry && `python -u ${entry}`)
    if (!start) throw new Error('Не нашла, какой .py запускать: укажи команду запуска')
    const deps = has(dir, 'requirements.txt') ? 'COPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\n' : ''
    return { type: 'python', dockerfile: `FROM python:3.12-slim\nWORKDIR /app\n${deps}COPY . .\n${cmd(start)}\n` }
  }

  if (has(dir, 'go.mod')) {
    return {
      type: 'go',
      dockerfile: `FROM golang:1.24-alpine AS build\nWORKDIR /src\nCOPY . .\nRUN go build -o /out/app .\nFROM alpine:3.21\nCOPY --from=build /out/app /app\n${cmd(startCmd || '/app')}\n`,
    }
  }

  if (has(dir, 'index.html')) {
    return { type: 'static', dockerfile: 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html\n' }
  }

  if (has(dir, 'compose.yml') || has(dir, 'docker-compose.yml')) {
    throw new Error('Compose пока не поддерживается: загрузи сервисы отдельными приложениями')
  }
  throw new Error('Не узнала проект: добавь Dockerfile или укажи базовый образ и команду запуска')
}
