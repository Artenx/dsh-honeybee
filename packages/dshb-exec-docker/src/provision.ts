import type { HostCommandRunner } from './docker-backend.js'

export interface ProvisionConfig {
  image: string
  cpus?: number
  memoryMB?: number
  name?: string
}

export interface ProvisionResult {
  containerId: string
  name: string
}

export type ProvisionStage = 'pull' | 'create' | 'wait' | 'ready'

export async function provisionContainer(
  runner: HostCommandRunner,
  config: ProvisionConfig,
  onStage?: (stage: ProvisionStage, detail?: string) => void,
): Promise<ProvisionResult> {
  onStage?.('pull', `拉取镜像 ${config.image}`)
  const pull = await runner.run(['docker', 'pull', config.image])
  if (pull.code !== 0) throw new Error(`镜像拉取失败: ${pull.stderr.trim() || pull.stdout.trim()}`)

  onStage?.('create', `创建容器`)
  const name = config.name ?? `dshb-${Date.now()}`
  const createArgs = ['docker', 'run', '-d', '--name', name]
  if (config.cpus) createArgs.push('--cpus', String(config.cpus))
  if (config.memoryMB) createArgs.push('-m', `${config.memoryMB}m`)
  createArgs.push(config.image, 'sleep', 'infinity')
  const create = await runner.run(createArgs)
  if (create.code !== 0) throw new Error(`容器创建失败: ${create.stderr.trim() || create.stdout.trim()}`)
  const containerId = create.stdout.trim()
  if (!containerId) throw new Error('容器创建失败：无容器 ID')

  onStage?.('wait', `等待容器就绪`)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const inspect = await runner.run(['docker', 'inspect', '--format', '{{.State.Running}}', containerId])
    if (inspect.stdout.trim() === 'true') {
      onStage?.('ready', `容器 ${name} 就绪`)
      return { containerId, name }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('容器启动超时（60 秒）')
}

export async function listContainers(runner: HostCommandRunner): Promise<Array<{ id: string; name: string; status: string; image: string }>> {
  const result = await runner.run(['docker', 'ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}'])
  if (result.code !== 0) return []
  return result.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [id, name, status, image] = line.split('\t')
      return { id: id?.trim() ?? '', name: name?.trim() ?? '', status: status?.trim() ?? '', image: image?.trim() ?? '' }
    })
}

export async function removeContainer(runner: HostCommandRunner, containerId: string): Promise<void> {
  await runner.run(['docker', 'rm', '-f', containerId])
}
