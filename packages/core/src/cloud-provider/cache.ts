import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "../global"
import { Flock } from "../util/flock"
import { isCloudProviderID, type CloudProviderID } from "./catalog"

// Persisted "this provider was set up" records, shared by every process
// (TUI Settings, connect popup, CLI, and the agent-facing status tool) so a
// returning user is recognised with the cheapest possible check instead of
// re-running the first-time flow. Mirrors the TUI's aws_setup_done KV flag,
// generalised to every provider.

export type CloudConnectionRecord = {
  /** First-time setup completed at least once. */
  done: boolean
  /** Profile (AWS/Oracle) or signed-in account (Google Cloud/Azure). */
  account?: string
  region?: string
  project?: string
  updatedAt: number
}

export type CloudConnections = Partial<Record<CloudProviderID, CloudConnectionRecord>>

const LOCK_OPTIONS = { timeoutMs: 5_000 }

export function cachePath(): string {
  return path.join(Global.Path.state, "cloud-connections.json")
}

async function readRaw(file: string): Promise<CloudConnections> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const result: CloudConnections = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (!isCloudProviderID(id) || typeof value !== "object" || value === null) continue
      const record = value as Partial<CloudConnectionRecord>
      result[id] = {
        done: record.done === true,
        account: typeof record.account === "string" ? record.account : undefined,
        region: typeof record.region === "string" ? record.region : undefined,
        project: typeof record.project === "string" ? record.project : undefined,
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
      }
    }
    return result
  } catch {
    return {}
  }
}

async function writeRaw(file: string, value: CloudConnections) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2))
  await rename(temporary, file).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}

export function readCloudConnections(file: string = cachePath()): Promise<CloudConnections> {
  return readRaw(file)
}

export async function getCloudConnection(
  id: CloudProviderID,
  file: string = cachePath(),
): Promise<CloudConnectionRecord | undefined> {
  return (await readRaw(file))[id]
}

// Best effort: a failed write only costs the next check a slower path.
export async function recordCloudConnection(
  id: CloudProviderID,
  record: Omit<CloudConnectionRecord, "updatedAt">,
  file: string = cachePath(),
): Promise<void> {
  await Flock.withLock(
    `cloud-connections:${file}`,
    async () => {
      const current = await readRaw(file)
      current[id] = { ...current[id], ...record, updatedAt: Date.now() }
      await writeRaw(file, current)
    },
    LOCK_OPTIONS,
  ).catch(() => undefined)
}

export async function clearCloudConnection(id: CloudProviderID, file: string = cachePath()): Promise<void> {
  await Flock.withLock(
    `cloud-connections:${file}`,
    async () => {
      const current = await readRaw(file)
      if (!current[id]) return
      delete current[id]
      await writeRaw(file, current)
    },
    LOCK_OPTIONS,
  ).catch(() => undefined)
}
