import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { CLI_STEP_TIMEOUT_MS, runCli, type CliRunResult } from "./cli"
import { parseIni, type IniSections } from "./ini"

// Oracle Cloud pieces of the connect decision tree, mirroring aws.ts:
// cached profile first, then profiles in ~/.oci/config, then a live
// read-only API call.

export function runOci(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CliRunResult> {
  return runCli("oci", args, { timeoutMs, signal, env: { OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: "True" } })
}

export function ociConfigPath(home: string = homedir()): string {
  return process.env.OCI_CLI_CONFIG_FILE ?? path.join(home, ".oci", "config")
}

export type OracleProfile = { name: string; region: string | undefined; sessionAuth: boolean }

export function parseOciProfiles(text: string): OracleProfile[] {
  const sections: IniSections = parseIni(text)
  return Object.entries(sections).map(([name, keys]) => ({
    name,
    region: keys.region,
    // Browser (session token) profiles need --auth security_token on every call.
    sessionAuth: typeof keys.security_token_file === "string" && keys.security_token_file.length > 0,
  }))
}

export type OraclePresence =
  | { kind: "connected"; profile: string; region: string | undefined }
  | { kind: "reauth"; profile: string; region: string | undefined; sessionAuth: boolean }
  | { kind: "first-time" }

export type OracleDetectDeps = {
  cachedProfile: string | undefined
  readConfig: () => Promise<string | undefined>
  verify: (profile: OracleProfile) => Promise<boolean>
}

export async function detectOracleState(deps: OracleDetectDeps): Promise<OraclePresence> {
  const text = await deps.readConfig()
  const profiles = text ? parseOciProfiles(text) : []
  const candidate =
    profiles.find((item) => item.name === deps.cachedProfile) ??
    profiles.find((item) => item.name === "DEFAULT") ??
    profiles[0]
  if (!candidate) return { kind: "first-time" }
  return (await deps.verify(candidate))
    ? { kind: "connected", profile: candidate.name, region: candidate.region }
    : { kind: "reauth", profile: candidate.name, region: candidate.region, sessionAuth: candidate.sessionAuth }
}

export function readOciConfig(home: string = homedir()): Promise<string | undefined> {
  return readFile(ociConfigPath(home), "utf8").then(
    (text) => text,
    () => undefined,
  )
}

export function authArgs(profile: OracleProfile): string[] {
  return ["--profile", profile.name, ...(profile.sessionAuth ? ["--auth", "security_token"] : [])]
}

export function ociVerify(profile: OracleProfile, signal?: AbortSignal): Promise<boolean> {
  return runOci(["iam", "region", "list", "--output", "json", ...authArgs(profile)], CLI_STEP_TIMEOUT_MS, signal).then(
    (result) => result.ok,
  )
}

export function ociLoginArgs(profile: string, region: string): string[] {
  return ["session", "authenticate", "--region", region, "--profile-name", profile]
}

export function ociRefreshArgs(profile: string): string[] {
  return ["session", "refresh", "--profile", profile]
}
