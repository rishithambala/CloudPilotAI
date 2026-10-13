import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { CLI_STEP_TIMEOUT_MS, runCli, type CliRunResult } from "./cli"

// Microsoft Azure pieces of the connect decision tree, mirroring aws.ts:
// cached flag first, then the subscriptions `az` already cached on disk,
// then a live `az account show`.

// The interactive subscription picker added in newer az releases would
// block forever with no stdin attached, so it is always switched off.
export const AZURE_ENV = { AZURE_CORE_LOGIN_EXPERIENCE_V2: "off", AZURE_CORE_ONLY_SHOW_ERRORS: "true" }

export function runAz(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CliRunResult> {
  return runCli("az", args, { timeoutMs, signal, env: AZURE_ENV })
}

export function azureProfilePath(home: string = homedir()): string {
  const dir = process.env.AZURE_CONFIG_DIR ?? path.join(home, ".azure")
  return path.join(dir, "azureProfile.json")
}

export type AzureAccount = { user: string | undefined; subscription: string | undefined }

function parseJson(text: string): unknown {
  // az writes azureProfile.json with a UTF-8 BOM on some platforms.
  const clean = text.replace(/^\uFEFF/, "").trim()
  if (!clean) return undefined
  try {
    return JSON.parse(clean)
  } catch {
    return undefined
  }
}

function accountFrom(value: unknown): AzureAccount | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as { name?: unknown; user?: { name?: unknown } }
  const user = typeof record.user?.name === "string" ? record.user.name : undefined
  const subscription = typeof record.name === "string" ? record.name : undefined
  if (!user && !subscription) return undefined
  return { user, subscription }
}

// Returns the default subscription (or the first one) cached by `az login`.
export function parseAzureProfile(text: string): AzureAccount | undefined {
  const data = parseJson(text) as { subscriptions?: unknown } | undefined
  const subscriptions = Array.isArray(data?.subscriptions) ? data.subscriptions : []
  const preferred =
    subscriptions.find((item) => typeof item === "object" && item !== null && (item as any).isDefault === true) ??
    subscriptions[0]
  return accountFrom(preferred)
}

export function parseAccountShow(stdout: string): AzureAccount | undefined {
  return accountFrom(parseJson(stdout))
}

export type AzurePresence =
  | { kind: "connected"; account: string; subscription: string | undefined }
  | { kind: "reauth"; account: string }
  | { kind: "first-time" }

export type AzureDetectDeps = {
  cachedAccount: string | undefined
  readProfile: () => Promise<string | undefined>
  accountShow: () => Promise<AzureAccount | undefined>
}

export async function detectAzureState(deps: AzureDetectDeps): Promise<AzurePresence> {
  const cached = deps.cachedAccount
  const onDisk = cached
    ? undefined
    : await deps.readProfile().then((text) => (text ? parseAzureProfile(text) : undefined))
  const candidate = cached ?? onDisk?.user ?? onDisk?.subscription
  if (!candidate) return { kind: "first-time" }
  const live = await deps.accountShow()
  if (live)
    return { kind: "connected", account: live.user ?? live.subscription ?? candidate, subscription: live.subscription }
  return { kind: "reauth", account: candidate }
}

export function readAzureProfile(home: string = homedir()): Promise<string | undefined> {
  return readFile(azureProfilePath(home), "utf8").then(
    (text) => text,
    () => undefined,
  )
}

export async function azureAccountShow(signal?: AbortSignal): Promise<AzureAccount | undefined> {
  const result = await runAz(["account", "show", "--output", "json"], CLI_STEP_TIMEOUT_MS, signal)
  return result.ok ? parseAccountShow(result.stdout) : undefined
}

export const AZURE_LOGIN_ARGS = ["login", "--output", "none"]
