import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  clearLoginSession,
  detectAwsState,
  isCliMissing,
  parseAwsProfiles,
  removeIniKey,
} from "../../src/util/aws-setup"
import { loginFailure } from "../../src/component/aws-connect"

describe("aws-connect loginFailure", () => {
  test("reads errors from stdout when stderr is empty", () => {
    const failure = loginFailure({ stdout: "SSO login failed", stderr: "", timedOut: false })
    expect(failure.cancelled).toBe(false)
    expect(failure.message).toContain("SSO login failed")
  })

  test("classifies timeouts", () => {
    const failure = loginFailure({ stdout: "", stderr: "", timedOut: true })
    expect(failure.cancelled).toBe(false)
    expect(failure.message).toMatch(/timed out/i)
  })

  test("classifies user cancellation as neutral", () => {
    const failure = loginFailure({ stdout: "", stderr: "Login cancelled by user", timedOut: false })
    expect(failure.cancelled).toBe(true)
    expect(failure.message).toMatch(/cancelled/i)
  })

  test("falls back instead of showing nothing", () => {
    const failure = loginFailure({ stdout: "", stderr: "", timedOut: false })
    expect(failure.message).toContain("unknown error")
  })

  test("treats an interrupted run as cancelled", () => {
    const failure = loginFailure({ stdout: "", stderr: "", timedOut: false, aborted: true })
    expect(failure.cancelled).toBe(true)
  })
})

describe("util.aws-setup parseAwsProfiles", () => {
  test("reads credentials-style sections", () => {
    expect(parseAwsProfiles("[dev]\naws_access_key_id=x\n[prod]\n")).toEqual(["dev", "prod"])
  })

  test("strips the config-file profile prefix", () => {
    expect(parseAwsProfiles("[profile dev]\nregion=us-east-1\n")).toEqual(["dev"])
  })

  test("ignores comments, blanks, and key lines", () => {
    expect(parseAwsProfiles("# comment\n\naws_region=x\n[dev]\n")).toEqual(["dev"])
  })

  test("dedupes and skips empty sections", () => {
    expect(parseAwsProfiles("[dev]\n[dev]\n[]\n[  ]\n")).toEqual(["dev"])
  })

  test("returns empty for blank input", () => {
    expect(parseAwsProfiles("")).toEqual([])
  })
})

describe("util.aws-setup removeIniKey", () => {
  const text = [
    "[default]",
    "region = eu-north-1",
    "login_session = arn:aws:iam::123:root",
    "",
    "[profile my-profile]",
    "region = us-east-1",
    "login_session = arn:aws:iam::123:root",
    "",
    "[profile other]",
    "region = us-west-2",
    "",
  ].join("\n")

  test("drops the key from the target section only", () => {
    const next = removeIniKey(text, "my-profile", "login_session")
    expect(next).not.toContain("us-east-1\nlogin_session")
    expect(next).toContain("[default]\nregion = eu-north-1\nlogin_session = arn:aws:iam::123:root")
    expect(next).toContain("[profile other]\nregion = us-west-2")
  })

  test("matches the default section without prefix", () => {
    const next = removeIniKey(text, "default", "login_session")
    expect(next).toContain("[default]\nregion = eu-north-1\n")
    expect(next).toContain("login_session = arn:aws:iam::123:root")
  })

  test("leaves text untouched when the key is absent", () => {
    expect(removeIniKey("[dev]\nregion=x\n", "dev", "login_session")).toBe("[dev]\nregion=x\n")
  })
})

describe("util.aws-setup clearLoginSession", () => {
  test("removes login_session for the profile from the config file", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "aws-setup-"))
    await mkdir(path.join(home, ".aws"), { recursive: true })
    await writeFile(
      path.join(home, ".aws", "config"),
      "[profile my-profile]\nregion = us-east-1\nlogin_session = arn:aws:iam::123:root\n",
    )
    await clearLoginSession("my-profile", home)
    const next = await readFile(path.join(home, ".aws", "config"), "utf8")
    expect(next).toBe("[profile my-profile]\nregion = us-east-1\n")
  })

  test("resolves when the config file is missing", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "aws-setup-"))
    await clearLoginSession("my-profile", home)
  })
})

describe("util.aws-setup isCliMissing", () => {
  test("flags spawn ENOENT as missing CLI", () => {
    expect(
      isCliMissing({ ok: false, code: null, stdout: "", stderr: "spawn aws ENOENT", timedOut: false, aborted: false }),
    ).toBe(true)
  })

  test("does not flag ordinary failures", () => {
    expect(
      isCliMissing({
        ok: false,
        code: 1,
        stdout: "",
        stderr: "Unable to locate credentials",
        timedOut: false,
        aborted: false,
      }),
    ).toBe(false)
    expect(
      isCliMissing({ ok: true, code: 0, stdout: "aws-cli/2.x", stderr: "", timedOut: false, aborted: false }),
    ).toBe(false)
  })
})

describe("util.aws-setup detectAwsState", () => {
  test("stored setup with live credentials is connected", async () => {
    const state = await detectAwsState({
      kvDone: true,
      kvProfile: "dev",
      readCredentials: async () => undefined,
      sts: async () => true,
    })
    expect(state).toEqual({ kind: "connected", profile: "dev" })
  })

  test("stored setup with dead credentials needs re-auth", async () => {
    const state = await detectAwsState({
      kvDone: true,
      kvProfile: "dev",
      readCredentials: async () => undefined,
      sts: async () => false,
    })
    expect(state).toEqual({ kind: "reauth", profile: "dev" })
  })

  test("adopts on-disk credentials when nothing was ever set up", async () => {
    const state = await detectAwsState({
      kvDone: false,
      kvProfile: undefined,
      readCredentials: async () => "[legacy]\naws_access_key_id=x\n",
      sts: async () => true,
    })
    expect(state).toEqual({ kind: "connected", profile: "legacy" })
  })

  test("expired on-disk credentials need re-auth", async () => {
    const state = await detectAwsState({
      kvDone: false,
      kvProfile: undefined,
      readCredentials: async () => "[legacy]\n",
      sts: async () => false,
    })
    expect(state).toEqual({ kind: "reauth", profile: "legacy" })
  })

  test("no flag and no credentials is first-time", async () => {
    const state = await detectAwsState({
      kvDone: false,
      kvProfile: undefined,
      readCredentials: async () => undefined,
      sts: async () => true,
    })
    expect(state).toEqual({ kind: "first-time" })
  })
})
