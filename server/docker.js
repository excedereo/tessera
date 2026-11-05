import fs from 'node:fs'
import path from 'node:path'
import Docker from 'dockerode'
import tar from 'tar-fs'
import { detect } from './detect.js'

export const docker = new Docker()

const LABEL = 'tessera.app'
const GENERATED_DOCKERFILE = '.tessera.Dockerfile'
const SYSTEM_RESERVE_MB = 512

export const containerName = id => `tessera-${id}`
const imageTag = id => `tessera/${id}:latest`
export const volumeName = id => `tessera-${id}-data`

export async function hostInfo() {
  const info = await docker.info()
  const memoryMb = Math.floor(info.MemTotal / 1024 / 1024)
  return { cpus: info.NCPU, memoryMb, reservedMb: SYSTEM_RESERVE_MB, usableMb: memoryMb - SYSTEM_RESERVE_MB }
}

function follow(stream, onLine) {
  return new Promise((resolve, reject) => {
    let failure = null
    docker.modem.followProgress(
      stream,
      err => (err || failure ? reject(err || new Error(failure)) : resolve()),
      event => {
        if (event.error) failure = event.error
        const line = event.stream || event.error || (event.status && `${event.status}\n`)
        if (line) onLine(line)
      },
    )
  })
}

export async function buildApp(app, dir, onLine) {
  const { type, dockerfile } = detect(dir, app)
  if (dockerfile) fs.writeFileSync(path.join(dir, GENERATED_DOCKERFILE), dockerfile)
  onLine(`Тип проекта: ${type}\n`)
  const context = tar.pack(dir, { ignore: name => /(^|[\\/])(\.git|node_modules|__pycache__|\.venv)([\\/]|$)/.test(name) })
  const stream = await docker.buildImage(context, {
    t: imageTag(app.id),
    dockerfile: dockerfile ? GENERATED_DOCKERFILE : 'Dockerfile',
    rm: true,
    forcerm: true,
  })
  await follow(stream, onLine)
  return { type, image: imageTag(app.id) }
}

export async function pullImage(image, onLine) {
  await follow(await docker.pull(image), onLine)
}

export const limitsFor = app => ({
  NanoCpus: Math.round(app.cpus * 1e9),
  Memory: app.memoryMb * 1024 * 1024,
  MemorySwap: app.memoryMb * 1024 * 1024,
})

export async function removeContainer(id) {
  try {
    await docker.getContainer(containerName(id)).remove({ force: true })
  } catch (err) {
    if (err.statusCode !== 404) throw err
  }
}

export async function createAndStart(app) {
  await removeContainer(app.id)
  const port = app.port && `${app.port}/tcp`
  const container = await docker.createContainer({
    name: containerName(app.id),
    Image: app.image,
    Env: Object.entries(app.env).map(([key, value]) => `${key}=${value}`),
    Labels: { [LABEL]: app.id },
    ...(app.startCmd ? { Entrypoint: ['sh', '-c'], Cmd: [app.startCmd] } : {}),
    ...(port ? { ExposedPorts: { [port]: {} } } : {}),
    HostConfig: {
      ...limitsFor(app),
      PidsLimit: 512,
      SecurityOpt: ['no-new-privileges'],
      RestartPolicy: { Name: app.restart ? 'unless-stopped' : 'no' },
      Binds: [`${volumeName(app.id)}:${app.dataPath}`],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      ...(port && app.hostPort ? { PortBindings: { [port]: [{ HostPort: String(app.hostPort) }] } } : {}),
    },
  })
  await container.start()
}

export async function destroy(id) {
  await removeContainer(id)
  await docker.getImage(imageTag(id)).remove({ force: true }).catch(() => {})
  await docker.getVolume(volumeName(id)).remove().catch(() => {})
}

export async function states() {
  const list = await docker.listContainers({ all: true, filters: { label: [LABEL] } })
  return new Map(list.map(c => [c.Labels[LABEL], { id: c.Id, state: c.State, status: c.Status }]))
}

const stats = new Map()
let lastRead = 0

function readStats(raw) {
  const cpu = raw.cpu_stats
  const pre = raw.precpu_stats
  const total = cpu.cpu_usage.total_usage - (pre.cpu_usage?.total_usage ?? 0)
  const system = cpu.system_cpu_usage - (pre.system_cpu_usage ?? 0)
  const cores = system > 0 ? (total / system) * (cpu.online_cpus || 1) : 0
  const memory = raw.memory_stats
  const used = (memory.usage ?? 0) - (memory.stats?.inactive_file ?? 0)
  return { cpuCores: cores, memoryMb: Math.max(used, 0) / 1024 / 1024 }
}

async function tick() {
  if (Date.now() - lastRead > 15000) return
  const current = await states()
  for (const id of stats.keys()) if (current.get(id)?.state !== 'running') stats.delete(id)
  await Promise.all(
    [...current].filter(([, c]) => c.state === 'running').map(async ([id, c]) => {
      const raw = await docker.getContainer(c.id).stats({ stream: false }).catch(() => null)
      if (raw?.cpu_stats?.cpu_usage) stats.set(id, readStats(raw))
    }),
  )
}

setInterval(() => tick().catch(() => {}), 3000).unref()

export function liveStats() {
  lastRead = Date.now()
  return stats
}
