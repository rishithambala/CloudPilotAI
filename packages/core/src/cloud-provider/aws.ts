import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { CLI_STEP_TIMEOUT_MS, runCli, type CliRunResult } from "./cli"
import { iniSectionNames } from "./ini"

// AWS-specific pieces of the cloud connect decision tree. The TUI connect
// flow and the agent-facing status tool both call these, so the human-facing
// Settings row and the deploy agent always agree on AWS state.

export function runAws(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CliRunResult> {
  return runCli("aws", args, { timeoutMs, signal })
}

// Parses "~/.aws/credentials" style ini text into profile names. Both
// "[name]" (credentials file) and "[profile name]" (config file) forms map
// to the same profile.
export function parseAwsProfiles(text: string): string[] {
  return iniSectionNames(text)
}

export function credentialsPath(home: string = homedir()): string {
  return path.join(home, ".aws", "credentials")
}

export function configPath(home: string = homedir()): string {
  return path.join(home, ".aws", "config")
}

// Drops one key from one ini profile section, leaving everything else
// byte-identical (comments, blanks, other sections and keys).
export function removeIniKey(text: string, profile: string, key: string): string {
  const lines = text.split("\n")
  let current: string | undefined
  const kept = lines.filter((line) => {
    const match = line.trim().match(/^\[(.+)\]$/)
    if (match) {
      current = match[1].trim().replace(/^profile\s+/, "")
      return true
    }
    if (current === profile && new RegExp(`^\\s*${key}\\s*=`).test(line)) return false
    return true
  })
  return kept.join("\n")
}

// `aws login` asks for y/n confirmation when the profile already holds a
// different login_session, and with no stdin attached that prompt dies with
// "EOF when reading a line". Dropping the key first makes the CLI take the
// new session without asking. Best effort: a missing file or failed write
// just leaves the login to behave as before.
export async function clearLoginSession(profile: string, home: string = homedir()): Promise<void> {
  const file = configPath(home)
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (!text) return
  const next = removeIniKey(text, profile, "login_session")
  if (next === text) return
  await writeFile(file, next).catch(() => undefined)
}

export type AwsPresence =
  | { kind: "connected"; profile: string }
  | { kind: "reauth"; profile: string }
  | { kind: "first-time" }

export type AwsDetectDeps = {
  kvDone: boolean
  kvProfile: string | undefined
  readCredentials: () => Promise<string | undefined>
  sts: (profile: string) => Promise<boolean>
}

// Cheapest checks first: persisted setup flag, then adopted credentials
// already on disk, then live verification. Never throws by contract of deps.
export async function detectAwsState(deps: AwsDetectDeps): Promise<AwsPresence> {
  if (deps.kvDone && deps.kvProfile) {
    return (await deps.sts(deps.kvProfile))
      ? { kind: "connected", profile: deps.kvProfile }
      : { kind: "reauth", profile: deps.kvProfile }
  }
  const text = await deps.readCredentials()
  const profiles = text ? parseAwsProfiles(text) : []
  const candidate = deps.kvProfile && profiles.includes(deps.kvProfile) ? deps.kvProfile : profiles[0]
  if (!candidate) return { kind: "first-time" }
  return (await deps.sts(candidate))
    ? { kind: "connected", profile: candidate }
    : { kind: "reauth", profile: candidate }
}

export function readAwsCredentials(home: string = homedir()): Promise<string | undefined> {
  return readFile(credentialsPath(home), "utf8").then(
    (text) => text,
    () => undefined,
  )
}

export function stsValid(profile: string): Promise<boolean> {
  return runAws(["sts", "get-caller-identity", "--profile", profile], CLI_STEP_TIMEOUT_MS).then((result) => result.ok)
}

export function cliInstalled(): Promise<boolean> {
  return runAws(["--version"], CLI_STEP_TIMEOUT_MS).then((result) => result.ok)
}
