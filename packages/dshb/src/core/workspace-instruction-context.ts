import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  sharedWorkspaceInstructionStore,
  sharedSessionInstructionSnapshotStore,
  type SessionInstructionSnapshot,
  type WorkspaceInstructionRecord,
} from './workspace-instructions.js'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
const INSTRUCTION_INTRO =
  'The following project instructions are managed by the user for this DSH workspace. Follow them as persistent workspace guidance. They take precedence over repository-provided workspace guidance. System, developer, and direct user instructions take precedence over these project instructions.'

export interface InstructionSnapshotResult {
  snapshot: SessionInstructionSnapshot
  message: ReturnType<typeof createUserMessage> | undefined
}

export function escapeInstructionFrameBody(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

export function renderInstructionMessageText(workspaceTitle: string, text: string): string {
  const escaped = escapeInstructionFrameBody(text)
  return `${SYSTEM_REMINDER_OPEN}\n${INSTRUCTION_INTRO}\n\nInstructions for workspace: ${workspaceTitle}\n\n${escaped}\n${SYSTEM_REMINDER_CLOSE}`
}

export function createInstructionMessage(
  workspaceId: string,
  workspaceTitle: string,
  snapshot: SessionInstructionSnapshot,
): ReturnType<typeof createUserMessage> {
  const text = renderInstructionMessageText(workspaceTitle, snapshot.text)
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'dshb-workspace-instructions',
      form: 'instructions',
      workspaceId,
      revision: snapshot.workspaceRevision,
      digest: snapshot.digest,
      snapshot: true,
    } as never,
  })
}

interface AgentLike {
  session: {
    id: string
    header: { cwd: string }
    surface?: { nodes?: number[] }
    eventAt?: (seq: number) => { type: string; data: { source: { kind: string } } } | undefined
  }
}

interface MessageLike {
  id: string
  role: string
  source: { kind: string }
}

interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<{ id: string; path: string; title: string } | undefined>
  get(id: string): { id: string; path: string; title: string } | undefined
}

function hasDirectUserMessage(messages: MessageLike[]): boolean {
  return messages.some((m) => m.role === 'user' && m.source.kind === 'user')
}

function hasOwnInstructionMessage(agent: AgentLike): boolean {
  const nodes = agent.session.surface?.nodes
  if (!nodes) return false
  for (const seq of nodes) {
    const event = agent.session.eventAt?.(seq)
    if (event?.type === 'user/message' && event.data.source.kind === 'dshb-workspace-instructions') {
      return true
    }
  }
  return false
}

export async function resolveSnapshotForSession(
  agent: AgentLike,
  messages: MessageLike[],
  workspaceStore = sharedWorkspaceInstructionStore(),
  snapshotStore = sharedSessionInstructionSnapshotStore(),
  registry?: WorkspaceRegistryLike,
): Promise<SessionInstructionSnapshot | undefined> {
  const sessionId = agent.session.id
  const existing = snapshotStore.get(sessionId)
  if (existing) return existing

  const isFirstDirect = hasDirectUserMessage(messages) && !hasOwnInstructionMessage(agent)
  if (!isFirstDirect) return undefined

  let workspaceId: string | undefined
  let workspaceTitle = 'Unknown'
  const cwd = agent.session.header.cwd
  if (registry && cwd) {
    try {
      const ws = await registry.resolveByPath(cwd)
      if (ws) {
        workspaceId = ws.id
        workspaceTitle = ws.title
      }
    } catch {
      // path 不可解析时创建无工作区空快照
    }
  }

  const record: WorkspaceInstructionRecord | undefined = workspaceId
    ? workspaceStore.get(workspaceId)
    : undefined

  if (!record || record.text.length === 0) {
    return snapshotStore.createIfAbsent(sessionId, {
      kind: 'empty',
      workspaceId,
    })
  }

  return snapshotStore.createIfAbsent(sessionId, {
    kind: 'workspace',
    record,
    workspaceId: workspaceId!,
  })
}

export function registerWorkspaceInstructionInjector(ctx: Context): void {
  if (typeof (ctx as { on?: unknown }).on !== 'function') return
  const workspaceStore = sharedWorkspaceInstructionStore()
  const snapshotStore = sharedSessionInstructionSnapshotStore()

  ;(ctx as unknown as { on: (event: string, handler: (arg: { agent: AgentLike; messages: MessageLike[]; signal: AbortSignal }, next: () => Promise<{ kind: string; messages: MessageLike[] }>) => Promise<unknown>) => void }).on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()

    const agentLike = agent as unknown as AgentLike
    const messagesLike = messages as unknown as MessageLike[]

    const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined

    let snapshot = snapshotStore.get(agentLike.session.id)
    if (!snapshot) {
      snapshot = await resolveSnapshotForSession(
        agentLike,
        messagesLike,
        workspaceStore,
        snapshotStore,
        registry,
      )
    }
    signal.throwIfAborted()
    if (!snapshot || snapshot.text.length === 0) return decision

    if (hasOwnInstructionMessage(agentLike)) return decision

    const workspaceId = snapshot.workspaceId
    if (!workspaceId) return decision
    const ws = registry?.get(workspaceId)
    const workspaceTitle = ws?.title ?? 'Unknown'

    const message = createInstructionMessage(workspaceId, workspaceTitle, snapshot)
    const lastClaimedIndex = decision.messages.findLastIndex((m) =>
      (messages as unknown as MessageLike[]).includes(m as unknown as MessageLike),
    )
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, message)
    return {
      ...decision,
      messages: entered,
    }
  })

  try {
    ;(ctx as { on?: (event: string, handler: (sessionId: string) => void) => void }).on?.('session/deleted', (sessionId: string) => {
      snapshotStore.remove(sessionId)
    })
  } catch {
    // session/deleted event may not exist in this DSH version
  }
}

export const name = 'dshb-workspace-instruction-injector'
export const inject = ['workspaceRegistry']
