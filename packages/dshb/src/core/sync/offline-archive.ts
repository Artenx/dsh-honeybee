import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { appendFileSync, chmodSync, closeSync, createReadStream, createWriteStream, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SyncNodeService, type SyncNodeManifest } from './node-sync.js'
import { SyncSessionError, SyncSessionService, validateSyncSessionBundle, type SyncSessionBundle } from './session-sync.js'
import { SyncOfflineArchiveJournalStore, type SyncOfflineImportJournal } from './offline-journal.js'
import type { SyncStateStore } from './stores.js'
import type { SyncImportMethod, SyncRecordMetadata } from './model.js'

const ARCHIVE_MAGIC = Buffer.from('DSHBSYNC')
const ARCHIVE_VERSION = 1
const HEADER_SIZE = 50
const TAG_SIZE = 16
const SALT_SIZE = 16
const NONCE_SIZE = 12
const SCRYPT_N = 32_768
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_BYTES = 32
const MIN_PASSWORD_BYTES = 8
const MAX_PASSWORD_BYTES = 1024
export const MAX_OFFLINE_ARCHIVE_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_EXPANDED_BYTES = 128 * 1024 * 1024
const MAX_ZIP_BYTES = MAX_OFFLINE_ARCHIVE_BYTES - HEADER_SIZE - TAG_SIZE
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})

export class SyncOfflineArchiveError extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SyncOfflineArchiveError'
  }
}

export interface SyncOfflineArchiveFile {
  path: string
  bytes: number
  cleanup(): void
}

export interface SyncOfflineImportResult {
  nodes: { created: number; updated: number; deleted: number; pendingRemoval: number; skipped: number }
  sessions?: { created: number; updated: number; archived: number; deleted: number; skipped: number; unmapped: number }
}

interface ZipFile {
  name: string
  data: Buffer
}

interface OfflineRecordSummary {
  kind: 'node' | 'session'
  originInstanceId: string
  originEntityId: string
  revision: SyncRecordMetadata['revision']
  contentDigest: string
  deleted: boolean
  branchId?: string
}

interface OfflineArchiveManifest {
  format: 'dshb-sync'
  formatVersion: 1
  instanceId: string
  createdAt: string
  includeSessions: boolean
  sessionFormatVersion?: number
  files: {
    nodes: { bytes: number; digest: string }
    sessions?: { bytes: number; digest: string }
  }
  records: OfflineRecordSummary[]
}

function sha256(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function validatePassword(password: string): Buffer {
  if (typeof password !== 'string') throw new SyncOfflineArchiveError('password-required', 'Package password is required')
  const bytes = Buffer.from(password, 'utf8')
  if (bytes.byteLength < MIN_PASSWORD_BYTES || bytes.byteLength > MAX_PASSWORD_BYTES || password.includes('\0')) {
    throw new SyncOfflineArchiveError('password-invalid', `Package password must be ${MIN_PASSWORD_BYTES}-${MAX_PASSWORD_BYTES} UTF-8 bytes`)
  }
  return bytes
}

async function deriveKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024,
    }, (error, key) => {
      if (error) reject(error)
      else resolve(key as Buffer)
    })
  })
}

function archiveHeader(salt: Buffer, nonce: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_SIZE)
  ARCHIVE_MAGIC.copy(header, 0)
  header.writeUInt16BE(ARCHIVE_VERSION, 8)
  header.writeUInt32BE(SCRYPT_N, 10)
  header.writeUInt32BE(SCRYPT_R, 14)
  header.writeUInt32BE(SCRYPT_P, 18)
  salt.copy(header, 22)
  nonce.copy(header, 22 + SALT_SIZE)
  return header
}

function parseArchiveHeader(header: Buffer): { salt: Buffer; nonce: Buffer } {
  if (header.length !== HEADER_SIZE || !header.subarray(0, 8).equals(ARCHIVE_MAGIC) ||
    header.readUInt16BE(8) !== ARCHIVE_VERSION || header.readUInt32BE(10) !== SCRYPT_N ||
    header.readUInt32BE(14) !== SCRYPT_R || header.readUInt32BE(18) !== SCRYPT_P) {
    throw new SyncOfflineArchiveError('format-unsupported', 'Offline archive format or KDF parameters are unsupported')
  }
  return {
    salt: header.subarray(22, 22 + SALT_SIZE),
    nonce: header.subarray(22 + SALT_SIZE, HEADER_SIZE),
  }
}

function safeZipName(name: string): boolean {
  return Boolean(name) && !name.startsWith('/') && !name.includes('\\') && !name.includes('\0') &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..') && !name.includes(':')
}

function writeZipParts(files: readonly ZipFile[]): { chunks: Buffer[]; bytes: number } {
  const localRecords: Buffer[] = []
  const centralRecords: Buffer[] = []
  let localOffset = 0
  let expandedBytes = 0

  for (const file of files) {
    if (!safeZipName(file.name)) throw new SyncOfflineArchiveError('path-invalid', 'Offline archive entry path is invalid')
    expandedBytes += file.data.byteLength
    if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES || file.data.byteLength > 0xffffffff) {
      throw new SyncOfflineArchiveError('archive-too-large', 'Offline archive contents exceed the size limit')
    }
    const name = Buffer.from(file.name, 'utf8')
    const checksum = crc32(file.data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(file.data.byteLength, 18)
    localHeader.writeUInt32LE(file.data.byteLength, 22)
    localHeader.writeUInt16LE(name.byteLength, 26)
    localHeader.writeUInt16LE(0, 28)
    localRecords.push(localHeader, name, file.data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0)
    centralHeader.writeUInt16LE(0x0314, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(file.data.byteLength, 20)
    centralHeader.writeUInt32LE(file.data.byteLength, 24)
    centralHeader.writeUInt16LE(name.byteLength, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE((0o100600 << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralRecords.push(centralHeader, name)
    localOffset += localHeader.byteLength + name.byteLength + file.data.byteLength
  }

  if (files.length > 0xffff || localOffset > 0xffffffff) {
    throw new SyncOfflineArchiveError('archive-too-large', 'Offline archive exceeds classic ZIP limits')
  }
  const centralBytes = centralRecords.reduce((total, record) => total + record.byteLength, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBytes, 12)
  end.writeUInt32LE(localOffset, 16)
  end.writeUInt16LE(0, 20)
  const bytes = localOffset + centralBytes + end.byteLength
  if (bytes > MAX_ZIP_BYTES) {
    throw new SyncOfflineArchiveError('archive-too-large', 'Offline archive exceeds the size limit')
  }
  return { chunks: [...localRecords, ...centralRecords, end], bytes }
}

function parseZip(archive: Buffer): { files: Map<string, Buffer>; expandedBytes: number } {
  const minimumEocd = Math.max(0, archive.length - 65_557)
  let eocd = -1
  for (let offset = archive.length - 22; offset >= minimumEocd; offset -= 1) {
    if (archive.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) { eocd = offset; break }
  }
  if (eocd < 0 || eocd + 22 > archive.length) throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive ZIP directory is invalid')
  const commentLength = archive.readUInt16LE(eocd + 20)
  if (eocd + 22 + commentLength !== archive.length || archive.readUInt16LE(eocd + 4) !== 0 ||
    archive.readUInt16LE(eocd + 6) !== 0 || archive.readUInt16LE(eocd + 8) !== archive.readUInt16LE(eocd + 10)) {
    throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive ZIP directory is inconsistent')
  }
  const count = archive.readUInt16LE(eocd + 10)
  const centralSize = archive.readUInt32LE(eocd + 12)
  const centralOffset = archive.readUInt32LE(eocd + 16)
  if (count < 2 || count > 3 || centralOffset + centralSize !== eocd) {
    throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive contains an unsupported entry count or layout')
  }

  const entries: Array<{ name: string; method: number; crc: number; compressedBytes: number; expandedBytes: number; localOffset: number }> = []
  let offset = centralOffset
  let totalExpanded = 0
  const names = new Set<string>()
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > eocd || archive.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive central entry is invalid')
    }
    const madeBy = archive.readUInt16LE(offset + 4)
    const flags = archive.readUInt16LE(offset + 8)
    const method = archive.readUInt16LE(offset + 10)
    const checksum = archive.readUInt32LE(offset + 16)
    const compressedBytes = archive.readUInt32LE(offset + 20)
    const expandedBytes = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const entryCommentLength = archive.readUInt16LE(offset + 32)
    const diskNumber = archive.readUInt16LE(offset + 34)
    const externalAttributes = archive.readUInt32LE(offset + 38)
    const localOffset = archive.readUInt32LE(offset + 42)
    const end = offset + 46 + nameLength + extraLength + entryCommentLength
    if (end > eocd || nameLength === 0 || diskNumber !== 0 || (flags & ~0x0800) !== 0 || (method !== 0 && method !== 8)) {
      throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive entry flags or compression are unsupported')
    }
    let name: string
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(archive.subarray(offset + 46, offset + 46 + nameLength))
    } catch (error) {
      throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive entry name is not valid UTF-8', error)
    }
    const unixMode = madeBy >> 8 === 3 ? externalAttributes >>> 16 : 0
    const fileType = unixMode & 0o170000
    if (!safeZipName(name) || names.has(name) || (fileType !== 0 && fileType !== 0o100000) || expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new SyncOfflineArchiveError('path-invalid', 'Offline archive contains a duplicate, unsafe, linked or oversized path')
    }
    if (method === 0 && compressedBytes !== expandedBytes) throw new SyncOfflineArchiveError('zip-invalid', 'Stored ZIP entry sizes differ')
    totalExpanded += expandedBytes
    if (totalExpanded > MAX_ARCHIVE_EXPANDED_BYTES) throw new SyncOfflineArchiveError('archive-too-large', 'Expanded offline archive exceeds the size limit')
    names.add(name)
    entries.push({ name, method, crc: checksum, compressedBytes, expandedBytes, localOffset })
    offset = end
  }
  if (offset !== eocd || !names.has('manifest.json') || !names.has('nodes.json') ||
    (names.has('sessions.json') !== (count === 3))) {
    throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive has missing or unexpected files')
  }

  const ranges: Array<[number, number]> = []
  const files = new Map<string, Buffer>()
  for (const entry of entries) {
    const local = entry.localOffset
    if (local + 30 > centralOffset || archive.readUInt32LE(local) !== ZIP_LOCAL_SIGNATURE) {
      throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive local entry is invalid')
    }
    const flags = archive.readUInt16LE(local + 6)
    const method = archive.readUInt16LE(local + 8)
    const crc = archive.readUInt32LE(local + 14)
    const compressedBytes = archive.readUInt32LE(local + 18)
    const expandedBytes = archive.readUInt32LE(local + 22)
    const nameLength = archive.readUInt16LE(local + 26)
    const extraLength = archive.readUInt16LE(local + 28)
    const nameStart = local + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + entry.compressedBytes
    const localName = archive.subarray(nameStart, nameStart + nameLength).toString('utf8')
    if (flags !== 0x0800 || method !== entry.method || crc !== entry.crc || compressedBytes !== entry.compressedBytes ||
      expandedBytes !== entry.expandedBytes || localName !== entry.name || dataEnd > centralOffset) {
      throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive local and central entries do not match')
    }
    ranges.push([local, dataEnd])
    const compressed = archive.subarray(dataStart, dataEnd)
    let data: Buffer
    try {
      data = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.expandedBytes + 1 })
    } catch (error) {
      throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive entry could not be expanded safely', error)
    }
    if (data.byteLength !== entry.expandedBytes || crc32(data) !== entry.crc) {
      throw new SyncOfflineArchiveError('archive-integrity', 'Offline archive entry checksum does not match')
    }
    files.set(entry.name, data)
  }
  ranges.sort((a, b) => a[0] - b[0])
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1]![1] > ranges[index]![0]) throw new SyncOfflineArchiveError('zip-invalid', 'Offline archive entries overlap')
  }
  return { files, expandedBytes: totalExpanded }
}

export function validateOfflineZipArchive(archive: Buffer): void {
  parseZip(archive)
}

function parseJson<T>(data: Buffer, label: string): T {
  try {
    return JSON.parse(data.toString('utf8')) as T
  } catch (error) {
    throw new SyncOfflineArchiveError('archive-invalid', `${label} is invalid JSON`, error)
  }
}

function recordSummary(metadata: SyncRecordMetadata, branchId?: string): OfflineRecordSummary {
  return {
    kind: metadata.kind as 'node' | 'session',
    originInstanceId: metadata.originInstanceId,
    originEntityId: metadata.originEntityId,
    revision: metadata.revision,
    contentDigest: metadata.contentDigest,
    deleted: Boolean(metadata.deleted),
    ...(branchId ? { branchId } : {}),
  }
}

function summaryRecords(nodes: SyncNodeManifest, sessions?: SyncSessionBundle): OfflineRecordSummary[] {
  const records = [
    ...nodes.records.map((entry) => recordSummary(entry.metadata)),
    ...(sessions?.entries.map((entry) => recordSummary(entry.metadata, entry.branchId)) ?? []),
  ]
  return records.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
}

function validateManifest(value: unknown, files: Map<string, Buffer>): { manifest: OfflineArchiveManifest; nodes: SyncNodeManifest; sessions?: SyncSessionBundle } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyncOfflineArchiveError('archive-invalid', 'Offline archive manifest is invalid')
  }
  const manifest = value as OfflineArchiveManifest
  if (Object.keys(manifest).some((key) => !['format', 'formatVersion', 'instanceId', 'createdAt', 'includeSessions', 'sessionFormatVersion', 'files', 'records'].includes(key)) ||
    manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files) ||
    !manifest.files.nodes || typeof manifest.files.nodes !== 'object' || Array.isArray(manifest.files.nodes)) {
    throw new SyncOfflineArchiveError('archive-invalid', 'Offline archive manifest contains unsupported fields')
  }
  if (manifest.format !== 'dshb-sync' || manifest.formatVersion !== ARCHIVE_VERSION ||
    typeof manifest.instanceId !== 'string' || !/^i-[a-f0-9]{32}$/.test(manifest.instanceId) ||
    typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) ||
    typeof manifest.includeSessions !== 'boolean' || !Array.isArray(manifest.records) ||
    manifest.includeSessions !== files.has('sessions.json') ||
    (manifest.includeSessions && manifest.sessionFormatVersion !== SESSION_FORMAT_VERSION) ||
    (!manifest.includeSessions && manifest.sessionFormatVersion !== undefined)) {
    throw new SyncOfflineArchiveError('format-unsupported', 'Offline archive manifest version or fields are unsupported')
  }
  const nodesData = files.get('nodes.json')
  const manifestData = files.get('manifest.json')
  if (!nodesData || !manifestData || manifest.files.nodes.bytes !== nodesData.byteLength ||
    manifest.files.nodes.digest !== sha256(nodesData)) {
    throw new SyncOfflineArchiveError('archive-integrity', 'Offline archive node manifest digest does not match')
  }
  const nodes = parseJson<SyncNodeManifest>(nodesData, 'Node manifest')
  if (nodes.protocolVersion !== 1 || nodes.instanceId !== manifest.instanceId || !Array.isArray(nodes.records)) {
    throw new SyncOfflineArchiveError('archive-invalid', 'Offline archive node manifest identity is invalid')
  }
  let sessions: SyncSessionBundle | undefined
  const sessionsData = files.get('sessions.json')
  if (sessionsData) {
    if (!manifest.files.sessions || manifest.files.sessions.bytes !== sessionsData.byteLength || manifest.files.sessions.digest !== sha256(sessionsData)) {
      throw new SyncOfflineArchiveError('archive-integrity', 'Offline archive session bundle digest does not match')
    }
    sessions = validateSyncSessionBundle(parseJson(sessionsData, 'Session bundle'))
    if (sessions.instanceId !== manifest.instanceId) throw new SyncOfflineArchiveError('archive-invalid', 'Session bundle source identity differs from archive')
  } else if (manifest.files.sessions !== undefined) {
    throw new SyncOfflineArchiveError('archive-invalid', 'Offline archive declares a missing session file')
  }
  if (canonicalJson(manifest.records) !== canonicalJson(summaryRecords(nodes, sessions))) {
    throw new SyncOfflineArchiveError('archive-integrity', 'Offline archive record summary does not match payloads')
  }
  return { manifest, nodes, ...(sessions ? { sessions } : {}) }
}

function decodeOfflinePayload(zip: Buffer, nodesService: SyncNodeService): {
  files: Map<string, Buffer>
  payloads: ReturnType<typeof validateManifest>
} {
  const parsed = parseZip(zip)
  const manifestData = parsed.files.get('manifest.json')
  if (!manifestData) throw new SyncOfflineArchiveError('archive-invalid', 'Offline archive manifest is missing')
  const payloads = validateManifest(parseJson(manifestData, 'Archive manifest'), parsed.files)
  try {
    nodesService.validateManifest(payloads.nodes.records)
    if (payloads.sessions) validateSyncSessionBundle(payloads.sessions)
  } catch (error) {
    throw new SyncOfflineArchiveError('archive-invalid', 'Offline archive contains an invalid sync manifest', error)
  }
  return { files: parsed.files, payloads }
}

function readFileRange(path: string, position: number, length: number): Buffer {
  const file = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const bytes = readSync(file, buffer, 0, length, position)
    if (bytes !== length) throw new SyncOfflineArchiveError('archive-invalid', 'Offline archive header is truncated')
    return buffer
  } finally {
    closeSync(file)
  }
}

function homeDirectory(home?: string): string {
  return home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function availableBytes(path: string): bigint {
  const available = statfsSync(path, { bigint: true })
  return available.bavail * available.bsize
}

function checkAvailableSpace(path: string, requiredBytes: number, getAvailableBytes: (path: string) => bigint): void {
  try {
    if (getAvailableBytes(path) < BigInt(requiredBytes)) {
      throw new SyncOfflineArchiveError('disk-space', 'Insufficient disk space for offline archive import')
    }
  } catch (error) {
    if (error instanceof SyncOfflineArchiveError) throw error
    throw new SyncOfflineArchiveError('disk-space', 'Unable to verify available disk space', error)
  }
}

function requiredBytesForImport(
  payloads: ReturnType<typeof validateManifest>,
  state: SyncStateStore | undefined,
  nodesPending: boolean,
  sessionsPending: boolean,
): number {
  const attachmentBytes = sessionsPending
    ? payloads.sessions?.entries.reduce((total, entry) =>
      total + (entry.objects?.reduce((sum, object) => sum + object.bytes, 0) ?? 0), 0,
    ) ?? 0
    : 0
  const sessionBytes = sessionsPending && payloads.sessions
    ? Buffer.byteLength(`${JSON.stringify(payloads.sessions, null, 2)}\n`, 'utf8')
    : 0
  const nodeBytes = nodesPending ? payloads.manifest.files.nodes.bytes : 0
  const stateBytes = nodesPending || sessionsPending
    ? (state ? Buffer.byteLength(`${JSON.stringify(state.read(), null, 2)}\n`, 'utf8') : 0)
    : 0
  return attachmentBytes * 2 + sessionBytes * 3 + nodeBytes * 2 + stateBytes * 2 + 4 * 1024 * 1024
}

export class SyncOfflineArchiveService {
  private operationTail: Promise<void> = Promise.resolve()
  private readonly home: string
  private readonly journal: SyncOfflineArchiveJournalStore

  constructor(
    private readonly nodes: SyncNodeService,
    private readonly sessions: SyncSessionService,
    home?: string,
    private readonly getAvailableBytes: (path: string) => bigint = availableBytes,
    private readonly state?: SyncStateStore,
  ) {
    this.home = homeDirectory(home)
    this.journal = new SyncOfflineArchiveJournalStore(this.home)
  }

  exportArchive(password: string, includeSessions = false): Promise<SyncOfflineArchiveFile> {
    return this.serializeMutation(() => this.exportArchiveNow(password, includeSessions))
  }

  importArchive(password: string, input: AsyncIterable<Uint8Array>): Promise<SyncOfflineImportResult> {
    return this.serializeMutation(async () => {
      await this.recoverPendingNow()
      await this.sessions.recoverPending()
      return this.importArchiveNow(password, input)
    })
  }

  recoverPending(): Promise<void> {
    return this.serializeMutation(async () => {
      await this.recoverPendingNow()
    })
  }

  cleanupStagingDirectories(): void {
    const root = join(this.home, 'dshb')
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    const pendingDirectory = this.journal.read()?.stagingDirectory
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== pendingDirectory && /^(?:sync-offline-staging|sync-offline-export)-/.test(entry.name)) {
        rmSync(join(root, entry.name), { recursive: true, force: true })
      }
    }
  }

  private async exportArchiveNow(passwordValue: string, includeSessions: boolean): Promise<SyncOfflineArchiveFile> {
    const password = validatePassword(passwordValue)
    if (typeof includeSessions !== 'boolean') throw new SyncOfflineArchiveError('request-invalid', 'Session inclusion option is invalid')
    const nodeManifest = await this.nodes.exportManifest()
    this.nodes.validateManifest(nodeManifest.records)
    const sessionBundle = includeSessions ? await this.sessions.exportBundle() : undefined
    const nodesData = Buffer.from(JSON.stringify(nodeManifest), 'utf8')
    const sessionsData = sessionBundle ? Buffer.from(JSON.stringify(sessionBundle), 'utf8') : undefined
    const records = summaryRecords(nodeManifest, sessionBundle)
    const manifest: OfflineArchiveManifest = {
      format: 'dshb-sync',
      formatVersion: ARCHIVE_VERSION,
      instanceId: nodeManifest.instanceId,
      createdAt: new Date().toISOString(),
      includeSessions,
      ...(sessionBundle ? { sessionFormatVersion: SESSION_FORMAT_VERSION } : {}),
      files: {
        nodes: { bytes: nodesData.byteLength, digest: sha256(nodesData) },
        ...(sessionsData ? { sessions: { bytes: sessionsData.byteLength, digest: sha256(sessionsData) } } : {}),
      },
      records,
    }
    const manifestData = Buffer.from(JSON.stringify(manifest), 'utf8')
    const zip = writeZipParts([
      { name: 'manifest.json', data: manifestData },
      { name: 'nodes.json', data: nodesData },
      ...(sessionsData ? [{ name: 'sessions.json', data: sessionsData }] : []),
    ])
    if (zip.bytes > MAX_ARCHIVE_EXPANDED_BYTES) throw new SyncOfflineArchiveError('archive-too-large', 'Offline archive contents exceed the size limit')

    mkdirSync(join(this.home, 'dshb'), { recursive: true, mode: 0o700 })
    const directory = mkdtempSync(join(this.home, 'dshb', 'sync-offline-export-'))
    chmodSync(directory, 0o700)
    const path = join(directory, 'export.dshb-sync')
    const salt = randomBytes(SALT_SIZE)
    const nonce = randomBytes(NONCE_SIZE)
    const header = archiveHeader(salt, nonce)
    let key: Buffer | undefined
    try {
      key = await deriveKey(password, salt)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(header)
      writeFileSync(path, header, { flag: 'wx', mode: 0o600 })
      await pipeline(Readable.from(zip.chunks), cipher, createWriteStream(path, { flags: 'a', mode: 0o600 }))
      appendFileSync(path, cipher.getAuthTag())
      chmodSync(path, 0o600)
      const bytes = statSync(path).size
      if (bytes > MAX_OFFLINE_ARCHIVE_BYTES) throw new SyncOfflineArchiveError('archive-too-large', 'Offline archive exceeds the size limit')
      return {
        path,
        bytes,
        cleanup: () => rmSync(directory, { recursive: true, force: true }),
      }
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error instanceof SyncOfflineArchiveError
        ? error
        : new SyncOfflineArchiveError('archive-export-failed', 'Offline archive export failed', error)
    } finally {
      password.fill(0)
      key?.fill(0)
      for (const chunk of zip.chunks) chunk.fill(0)
    }
  }

  private async importArchiveNow(passwordValue: string, input: AsyncIterable<Uint8Array>): Promise<SyncOfflineImportResult> {
    const password = validatePassword(passwordValue)
    mkdirSync(join(this.home, 'dshb'), { recursive: true, mode: 0o700 })
    const batchId = randomBytes(16).toString('hex')
    const stagingDirectory = `sync-offline-staging-${batchId}`
    const directory = join(this.home, 'dshb', stagingDirectory)
    mkdirSync(directory, { mode: 0o700 })
    chmodSync(directory, 0o700)
    const encryptedPath = join(directory, 'input.enc')
    const zipPath = join(directory, 'payload.zip')
    let key: Buffer | undefined
    let plaintextZip: Buffer | undefined
    let payloadFiles: Map<string, Buffer> | undefined
    try {
      let encryptedBytes = 0
      const sizeLimit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          encryptedBytes += chunk.byteLength
          if (encryptedBytes > MAX_OFFLINE_ARCHIVE_BYTES) {
            callback(new SyncOfflineArchiveError('archive-too-large', 'Offline archive exceeds the upload size limit'))
            return
          }
          callback(null, chunk)
        },
      })
      await pipeline(Readable.from(input), sizeLimit, createWriteStream(encryptedPath, { flags: 'wx', mode: 0o600 }))
      if (encryptedBytes < HEADER_SIZE + TAG_SIZE + 22) throw new SyncOfflineArchiveError('archive-invalid', 'Offline archive is truncated')
      const header = readFileRange(encryptedPath, 0, HEADER_SIZE)
      const { salt, nonce } = parseArchiveHeader(header)
      const tag = readFileRange(encryptedPath, encryptedBytes - TAG_SIZE, TAG_SIZE)
      key = await deriveKey(password, salt)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAAD(header)
      decipher.setAuthTag(tag)
      try {
        await pipeline(
          createReadStream(encryptedPath, { start: HEADER_SIZE, end: encryptedBytes - TAG_SIZE - 1 }),
          decipher,
          createWriteStream(zipPath, { flags: 'wx', mode: 0o600 }),
        )
      } catch (error) {
        throw new SyncOfflineArchiveError('password-or-integrity', 'Package password is incorrect or archive authentication failed', error)
      }
      const zipStat = statSync(zipPath)
      if (zipStat.size > MAX_ARCHIVE_EXPANDED_BYTES) throw new SyncOfflineArchiveError('archive-too-large', 'Offline archive contents exceed the size limit')
      plaintextZip = readFileRange(zipPath, 0, zipStat.size)
      const decoded = decodeOfflinePayload(plaintextZip, this.nodes)
      payloadFiles = decoded.files
      const payloads = decoded.payloads
      const requiredBytes = requiredBytesForImport(payloads, this.state, true, Boolean(payloads.sessions))
      if (!Number.isSafeInteger(requiredBytes)) throw new SyncOfflineArchiveError('archive-too-large', 'Offline archive storage estimate exceeds the supported range')
      checkAvailableSpace(this.home, requiredBytes, this.getAvailableBytes)
      await this.preflightPayloads(payloads, true, Boolean(payloads.sessions))

      const journal: SyncOfflineImportJournal = {
        version: 1,
        batchId,
        stagingDirectory,
        zipDigest: sha256(plaintextZip),
        includeSessions: Boolean(payloads.sessions),
        nodesApplied: false,
        sessionsApplied: !payloads.sessions,
        startedAt: new Date().toISOString(),
      }
      this.journal.begin(journal)
      return await this.applyJournaledPayloads(payloads, journal, false)
    } catch (error) {
      if (error instanceof SyncOfflineArchiveError || error instanceof SyncSessionError) throw error
      throw new SyncOfflineArchiveError('archive-import-failed', 'Offline archive import failed', error)
    } finally {
      password.fill(0)
      key?.fill(0)
      plaintextZip?.fill(0)
      if (payloadFiles) for (const data of payloadFiles.values()) data.fill(0)
      let preserveStaging = false
      try {
        preserveStaging = this.journal.read()?.stagingDirectory === stagingDirectory
      } catch {
        preserveStaging = true
      }
      if (!preserveStaging) rmSync(directory, { recursive: true, force: true })
    }
  }

  private async recoverPendingNow(): Promise<void> {
    const journal = this.journal.read()
    if (!journal) return
    const directory = join(this.home, 'dshb', journal.stagingDirectory)
    const zipPath = join(directory, 'payload.zip')
    let zip: Buffer | undefined
    let files: Map<string, Buffer> | undefined
    try {
      const zipBytes = statSync(zipPath).size
      if (zipBytes > MAX_ARCHIVE_EXPANDED_BYTES) throw new SyncOfflineArchiveError('archive-too-large', 'Offline archive staging exceeds the size limit')
      zip = readFileRange(zipPath, 0, zipBytes)
      if (sha256(zip) !== journal.zipDigest) throw new SyncOfflineArchiveError('journal-integrity', 'Staged offline archive digest does not match its journal')
      const decoded = decodeOfflinePayload(zip, this.nodes)
      files = decoded.files
      if (decoded.payloads.manifest.includeSessions !== journal.includeSessions) {
        throw new SyncOfflineArchiveError('journal-invalid', 'Offline archive journal options do not match the staged payload')
      }
      await this.applyJournaledPayloads(decoded.payloads, journal, true)
    } finally {
      zip?.fill(0)
      if (files) for (const data of files.values()) data.fill(0)
    }
  }

  private async preflightPayloads(
    payloads: ReturnType<typeof validateManifest>,
    nodesPending: boolean,
    sessionsPending: boolean,
  ): Promise<void> {
    if (nodesPending) {
      try {
        await this.nodes.preflightManifest(payloads.nodes.records)
      } catch (error) {
        throw new SyncOfflineArchiveError('archive-conflict', 'Target node state conflicts with the offline archive', error)
      }
    }
    if (sessionsPending && payloads.sessions) {
      await this.sessions.recoverPending()
      await this.sessions.exportBundle()
      this.sessions.preflightBundle(payloads.sessions, { allowSameInstance: true })
    }
  }

  private async applyJournaledPayloads(
    payloads: ReturnType<typeof validateManifest>,
    initialJournal: SyncOfflineImportJournal,
    runPreflight: boolean,
  ): Promise<SyncOfflineImportResult> {
    let journal = initialJournal
    const nodesPending = !journal.nodesApplied
    const sessionsPending = journal.includeSessions && !journal.sessionsApplied
    if (!nodesPending && !sessionsPending) {
      this.journal.complete()
      rmSync(join(this.home, 'dshb', journal.stagingDirectory), { recursive: true, force: true })
      return { nodes: { created: 0, updated: 0, deleted: 0, pendingRemoval: 0, skipped: 0 } }
    }
    if (runPreflight) {
      const requiredBytes = requiredBytesForImport(payloads, this.state, nodesPending, sessionsPending)
      if (!Number.isSafeInteger(requiredBytes)) throw new SyncOfflineArchiveError('archive-too-large', 'Offline archive storage estimate exceeds the supported range')
      checkAvailableSpace(this.home, requiredBytes, this.getAvailableBytes)
      await this.preflightPayloads(payloads, nodesPending, sessionsPending)
    }

    const nodeResult = nodesPending
      ? await this.nodes.applyManifest(payloads.nodes.records, 'offline archive', 'offline' satisfies SyncImportMethod)
      : { created: 0, updated: 0, deleted: 0, pendingRemoval: 0, skipped: 0 }
    if (nodesPending) journal = this.journal.update({ nodesApplied: true })

    let sessionResult: SyncOfflineImportResult['sessions']
    if (sessionsPending && payloads.sessions) {
      sessionResult = await this.sessions.applyBundle(
        payloads.sessions,
        'offline archive',
        'p-000000000000000000000000',
        { importedVia: 'offline', allowSameInstance: true },
      )
      journal = this.journal.update({ sessionsApplied: true })
    }

    this.journal.complete()
    rmSync(join(this.home, 'dshb', journal.stagingDirectory), { recursive: true, force: true })
    return { nodes: nodeResult, ...(sessionResult ? { sessions: sessionResult } : {}) }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}
