import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_IDS, getCloudProvider, isCloudProviderID } from "../src/cloud-provider/catalog"
import { failureDetail, isCliMissing, quoteWindowsArg } from "../src/cloud-provider/cli"
import { iniSectionNames, parseIni } from "../src/cloud-provider/ini"
import { detectGcpState, parseConfigValue } from "../src/cloud-provider/gcp"
import { detectAzureState, parseAccountShow, parseAzureProfile } from "../src/cloud-provider/azure"
import { authArgs, detectOracleState, parseOciProfiles } from "../src/cloud-provider/oracle"
import {
  clearCloudConnection,
  getCloudConnection,
  readCloudConnections,
  recordCloudConnection,
} from "../src/cloud-provider/cache"
import { describe as describeState } from "../src/cloud-provider/detect"
import { describeGithub, githubStateFromMcp, parseGithubRemote } from "../src/connection/github"

describe("cloud-provider catalog", () => {
  test("is the single list of the four supported providers", () => {
    expect(CLOUD_PROVIDER_IDS).toEqual(["aws", "oracle", "google-cloud", "azure"])
    expect(new Set(CLOUD_PROVIDERS.map((item) => item.id)).size).toBe(CLOUD_PROVIDERS.length)
    for (const item of CLOUD_PROVIDERS) {
      expect(item.cli.length).toBeGreaterThan(0)
      expect(item.installUrl.startsWith("https://")).toBe(true)
    }
  })

  test("lookup helpers", () => {
    expect(isCloudProviderID("azure")).toBe(true)
    expect(isCloudProviderID("digitalocean")).toBe(false)
    expect(getCloudProvider("google-cloud")?.cli).toBe("gcloud")
    expect(getCloudProvider("nope")).toBeUndefined()
  })
})

describe("cloud-provider cli helpers", () => {
  const base = { ok: false, code: 1, stdout: "", stderr: "", timedOut: false, aborted: false }
  test("detects missing executables on every platform", () => {
    expect(isCliMissing({ ...base, code: null, stderr: "spawn gcloud ENOENT" })).toBe(true)
    expect(isCliMissing({ ...base, stderr: "'az' is not recognized as an internal or external command," })).toBe(true)
    expect(isCliMissing({ ...base, stderr: "ERROR: not logged in" })).toBe(false)
    expect(isCliMissing({ ...base, ok: true, code: 0 })).toBe(false)
  })

  test("failureDetail prefers stderr then stdout", () => {
    expect(failureDetail({ stdout: "out line\n", stderr: "first\nlast err\n" })).toBe("last err")
    expect(failureDetail({ stdout: "only stdout\n", stderr: "" })).toBe("only stdout")
    expect(failureDetail({ stdout: "", stderr: "" })).toBeUndefined()
  })

  test("quotes Windows shell arguments only when needed", () => {
    expect(quoteWindowsArg("login")).toBe("login")
    expect(quoteWindowsArg("--format=value(account)")).toBe('"--format=value(account)"')
    expect(quoteWindowsArg('a "b"')).toBe('"a ""b"""')
    expect(quoteWindowsArg("")).toBe('""')
  })
})

describe("cloud-provider ini", () => {
  test("parses sections, keys, and AWS 'profile' headers", () => {
    const text = "# comment\n[DEFAULT]\nregion = us-ashburn-1\n\n[profile dev]\nkey=value=with=equals\n"
    expect(parseIni(text)).toEqual({ DEFAULT: { region: "us-ashburn-1" }, dev: { key: "value=with=equals" } })
    expect(iniSectionNames("[a]\r\n[profile b]\r\n[a]\r\n")).toEqual(["a", "b"])
  })
})

describe("google cloud detection", () => {
  test("no account is first-time", async () => {
    const state = await detectGcpState({
      cachedAccount: undefined,
      activeAccount: async () => undefined,
      tokenValid: async () => true,
    })
    expect(state).toEqual({ kind: "first-time" })
  })

  test("cached account is checked first and never re-reads config", async () => {
    let read = false
    const state = await detectGcpState({
      cachedAccount: "me@example.com",
      activeAccount: async () => {
        read = true
        return "other@example.com"
      },
      tokenValid: async () => true,
    })
    expect(state).toEqual({ kind: "connected", account: "me@example.com" })
    expect(read).toBe(false)
  })

  test("expired token needs re-auth", async () => {
    const state = await detectGcpState({
      cachedAccount: undefined,
      activeAccount: async () => "me@example.com",
      tokenValid: async () => false,
    })
    expect(state).toEqual({ kind: "reauth", account: "me@example.com" })
  })

  test("config values", () => {
    expect(parseConfigValue("(unset)\n")).toBeUndefined()
    expect(parseConfigValue("\nmy-project\n")).toBe("my-project")
    expect(parseConfigValue("")).toBeUndefined()
  })
})

describe("azure detection", () => {
  const profile =
    "\uFEFF" +
    JSON.stringify({
      subscriptions: [
        { name: "Other", isDefault: false, user: { name: "a@x.com" } },
        { name: "Main", isDefault: true, user: { name: "me@x.com" } },
      ],
    })

  test("reads the default subscription from a BOM-prefixed profile", () => {
    expect(parseAzureProfile(profile)).toEqual({ user: "me@x.com", subscription: "Main" })
    expect(parseAzureProfile("{}")).toBeUndefined()
    expect(parseAzureProfile("not json")).toBeUndefined()
    expect(parseAccountShow(JSON.stringify({ name: "Main", user: { name: "me@x.com" } }))).toEqual({
      user: "me@x.com",
      subscription: "Main",
    })
  })

  test("never signed in is first-time without a live call", async () => {
    let live = false
    const state = await detectAzureState({
      cachedAccount: undefined,
      readProfile: async () => undefined,
      accountShow: async () => {
        live = true
        return { user: "x", subscription: "y" }
      },
    })
    expect(state).toEqual({ kind: "first-time" })
    expect(live).toBe(false)
  })

  test("cached subscriptions with a live session are connected", async () => {
    const state = await detectAzureState({
      cachedAccount: undefined,
      readProfile: async () => profile,
      accountShow: async () => ({ user: "me@x.com", subscription: "Main" }),
    })
    expect(state).toEqual({ kind: "connected", account: "me@x.com", subscription: "Main" })
  })

  test("expired session needs re-auth", async () => {
    const state = await detectAzureState({
      cachedAccount: "me@x.com",
      readProfile: async () => undefined,
      accountShow: async () => undefined,
    })
    expect(state).toEqual({ kind: "reauth", account: "me@x.com" })
  })
})

describe("oracle detection", () => {
  const config =
    "[DEFAULT]\nregion=us-ashburn-1\nkey_file=~/.oci/key.pem\n[work]\nregion=eu-frankfurt-1\nsecurity_token_file=/t\n"

  test("parses profiles and session auth", () => {
    expect(parseOciProfiles(config)).toEqual([
      { name: "DEFAULT", region: "us-ashburn-1", sessionAuth: false },
      { name: "work", region: "eu-frankfurt-1", sessionAuth: true },
    ])
    expect(authArgs({ name: "work", region: undefined, sessionAuth: true })).toEqual([
      "--profile",
      "work",
      "--auth",
      "security_token",
    ])
  })

  test("prefers the cached profile, then DEFAULT", async () => {
    const seen: string[] = []
    const verify = async (profile: { name: string }) => {
      seen.push(profile.name)
      return true
    }
    expect(await detectOracleState({ cachedProfile: "work", readConfig: async () => config, verify })).toEqual({
      kind: "connected",
      profile: "work",
      region: "eu-frankfurt-1",
    })
    expect(await detectOracleState({ cachedProfile: undefined, readConfig: async () => config, verify })).toEqual({
      kind: "connected",
      profile: "DEFAULT",
      region: "us-ashburn-1",
    })
    expect(seen).toEqual(["work", "DEFAULT"])
  })

  test("no config is first-time, failed verify is re-auth", async () => {
    expect(
      await detectOracleState({
        cachedProfile: undefined,
        readConfig: async () => undefined,
        verify: async () => true,
      }),
    ).toEqual({ kind: "first-time" })
    expect(
      await detectOracleState({ cachedProfile: "work", readConfig: async () => config, verify: async () => false }),
    ).toEqual({ kind: "reauth", profile: "work", region: "eu-frankfurt-1", sessionAuth: true })
  })
})

describe("cloud connection cache", () => {
  test("records, merges, reads and clears per provider", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cloud-cache-"))
    const file = path.join(dir, "cloud-connections.json")
    expect(await readCloudConnections(file)).toEqual({})
    await recordCloudConnection("oracle", { done: false, account: "DEFAULT", region: "us-ashburn-1" }, file)
    await recordCloudConnection("oracle", { done: true, account: "DEFAULT" }, file)
    await recordCloudConnection("azure", { done: true, account: "me@x.com" }, file)
    const oracle = await getCloudConnection("oracle", file)
    expect(oracle).toMatchObject({ done: true, account: "DEFAULT", region: "us-ashburn-1" })
    expect(typeof oracle?.updatedAt).toBe("number")
    await clearCloudConnection("oracle", file)
    expect(Object.keys(await readCloudConnections(file))).toEqual(["azure"])
    expect(JSON.parse(await readFile(file, "utf8")).azure.done).toBe(true)
  })

  test("ignores unknown providers and corrupt files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cloud-cache-"))
    const file = path.join(dir, "c.json")
    await Bun.write(file, JSON.stringify({ nope: { done: true }, aws: { done: true, account: 1 } }))
    expect(await readCloudConnections(file)).toEqual({
      aws: { done: true, account: undefined, region: undefined, project: undefined, updatedAt: 0 },
    })
    await Bun.write(file, "{ broken")
    expect(await readCloudConnections(file)).toEqual({})
  })
})

describe("plain-language status text", () => {
  test("every non-ready state tells the user what to do next", () => {
    for (const id of CLOUD_PROVIDER_IDS) {
      expect(describeState(id, "connected", { account: "x" }).nextStep).toBeUndefined()
      for (const state of ["reauth", "not_connected", "cli_missing", "error"] as const) {
        const text = describeState(id, state)
        expect(text.summary.length).toBeGreaterThan(0)
        expect(text.nextStep?.length ?? 0).toBeGreaterThan(0)
      }
    }
    expect(describeState("azure", "cli_missing").nextStep).toContain(getCloudProvider("azure")!.installUrl)
  })
})

describe("github connection helpers", () => {
  test("maps MCP status to connection state", () => {
    expect(githubStateFromMcp(undefined)).toEqual({ state: "not_connected" })
    expect(githubStateFromMcp({ status: "connected" })).toEqual({ state: "connected" })
    expect(githubStateFromMcp({ status: "needs_client_registration", error: "x" })).toEqual({ state: "needs_auth" })
    expect(githubStateFromMcp({ status: "failed", error: "401" })).toEqual({ state: "failed", error: "401" })
    expect(githubStateFromMcp({ status: "disabled" })).toEqual({ state: "not_connected" })
    expect(describeGithub("needs_auth").nextStep).toContain("Settings")
  })

  test("parses GitHub remotes", () => {
    expect(parseGithubRemote("https://github.com/acme/app.git\n")).toBe("acme/app")
    expect(parseGithubRemote("https://token@github.com/acme/app")).toBe("acme/app")
    expect(parseGithubRemote("git@github.com:acme/app.git")).toBe("acme/app")
    expect(parseGithubRemote("ssh://git@github.com/acme/app.git")).toBe("acme/app")
    expect(parseGithubRemote("https://gitlab.com/acme/app.git")).toBeUndefined()
  })
})

describe("detectCloudProvider", () => {
  test("reports cli_missing without spawning anything when the CLI is not on PATH", async () => {
    const { detectCloudProvider, invalidateCloudProvider } = await import("../src/cloud-provider/detect")
    const saved = { PATH: process.env.PATH, Path: process.env.Path }
    process.env.PATH = path.join(tmpdir(), "no-such-bin-dir")
    delete process.env.Path
    try {
      invalidateCloudProvider()
      const status = await detectCloudProvider("oracle", { persist: false })
      expect(status.state).toBe("cli_missing")
      expect(status.nextStep).toContain("https://")
    } finally {
      process.env.PATH = saved.PATH
      if (saved.Path !== undefined) process.env.Path = saved.Path
      invalidateCloudProvider()
    }
  })
})
