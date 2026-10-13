import { CLI_STEP_TIMEOUT_MS, runCli, type CliRunResult } from "./cli"

// Google Cloud pieces of the connect decision tree, mirroring aws.ts:
// cached account first, then the account gcloud already has configured,
// then a live token check.

export function runGcloud(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CliRunResult> {
  return runCli("gcloud", [...args, "--quiet"], { timeoutMs, signal })
}

export type GcpPresence =
  | { kind: "connected"; account: string }
  | { kind: "reauth"; account: string }
  | { kind: "first-time" }

export type GcpDetectDeps = {
  cachedAccount: string | undefined
  activeAccount: () => Promise<string | undefined>
  tokenValid: (account: string) => Promise<boolean>
}

export async function detectGcpState(deps: GcpDetectDeps): Promise<GcpPresence> {
  const account = deps.cachedAccount ?? (await deps.activeAccount())
  if (!account) return { kind: "first-time" }
  return (await deps.tokenValid(account)) ? { kind: "connected", account } : { kind: "reauth", account }
}

// `gcloud config get-value` prints "(unset)" (or nothing) for empty keys.
export function parseConfigValue(stdout: string): string | undefined {
  const value = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!value || value === "(unset)") return undefined
  return value
}

export async function gcpActiveAccount(): Promise<string | undefined> {
  const configured = await runGcloud(["config", "get-value", "account"], CLI_STEP_TIMEOUT_MS)
  const account = configured.ok ? parseConfigValue(configured.stdout) : undefined
  if (account) return account
  const listed = await runGcloud(
    ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
    CLI_STEP_TIMEOUT_MS,
  )
  return listed.ok ? parseConfigValue(listed.stdout) : undefined
}

export function gcpTokenValid(account: string, signal?: AbortSignal): Promise<boolean> {
  return runGcloud(["auth", "print-access-token", `--account=${account}`], CLI_STEP_TIMEOUT_MS, signal).then(
    (result) => result.ok && result.stdout.trim().length > 0,
  )
}

export async function gcpProject(): Promise<string | undefined> {
  const result = await runGcloud(["config", "get-value", "project"], CLI_STEP_TIMEOUT_MS)
  return result.ok ? parseConfigValue(result.stdout) : undefined
}

// Browser sign-in; `--update-adc` also refreshes Application Default
// Credentials so SDK-based tools (Terraform, client libraries) work too.
export const GCP_LOGIN_ARGS = ["auth", "login", "--brief", "--update-adc"]
