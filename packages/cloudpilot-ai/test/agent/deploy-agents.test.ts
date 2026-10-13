import { describe, expect, test } from "bun:test"
import path from "path"
import { ConfigAgent } from "../../src/config/agent"
import { Permission } from "../../src/permission"

// Fixture: the real deploy agents shipped in the repo's .cloudpilot/agent.
// These agents can spend real money, so their approval gates and
// delegation rules are asserted here rather than trusted to prompt wording.
const DIR = path.resolve(import.meta.dir, "../../../../.cloudpilot")
const SUBAGENTS = ["deploy-analyze", "deploy-provision", "deploy-release", "deploy-monitor"] as const

const agents = await ConfigAgent.load(DIR)
const ruleset = (name: string) => Permission.fromConfig(agents[name]?.permission ?? {})
const action = (name: string, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, ruleset(name)).action

describe("deploy orchestrator", () => {
  test("is a primary agent and every subagent exists", () => {
    expect(agents.deploy?.mode).toBe("primary")
    for (const name of SUBAGENTS) expect(agents[name]?.mode).toBe("subagent")
  })

  test("delegates analysis and monitoring freely", () => {
    expect(action("deploy", "task", "deploy-analyze")).toBe("allow")
    expect(action("deploy", "task", "deploy-monitor")).toBe("allow")
  })

  test("cannot start a billable or deploying stage without a captured user approval", () => {
    // "ask" means the permission system blocks until the user approves;
    // the orchestrator cannot skip it by prompt wording alone.
    expect(action("deploy", "task", "deploy-provision")).toBe("ask")
    expect(action("deploy", "task", "deploy-release")).toBe("ask")
  })

  test("cannot delegate to unrelated agents", () => {
    expect(action("deploy", "task", "general")).toBe("deny")
    expect(action("deploy", "task", "build")).toBe("deny")
  })

  test("checks connection status and keeps shell/edit behind approval", () => {
    expect(action("deploy", "connection_status")).toBe("allow")
    expect(action("deploy", "bash")).toBe("ask")
    expect(action("deploy", "edit")).toBe("ask")
    expect(action("deploy", "question")).toBe("allow")
  })

  test("prompt states the hard rules", () => {
    const prompt = agents.deploy?.prompt ?? ""
    expect(prompt).toContain("connection_status")
    expect(prompt).toContain("only voice the user hears")
    expect(prompt).toContain("Plain-language glossary")
    expect(prompt).toContain("Approval is recorded, not assumed")
    for (const name of SUBAGENTS) expect(prompt).toContain(name)
  })
})

describe("deploy subagents", () => {
  for (const name of SUBAGENTS) {
    test(`${name} never talks to the user directly and checks connections first`, () => {
      expect(action(name, "question")).toBe("deny")
      expect(action(name, "connection_status")).toBe("allow")
      const prompt = agents[name]?.prompt ?? ""
      expect(prompt).toContain("You never talk to the user directly")
      expect(prompt).toContain("Write for a non-technical reader")
      expect(prompt).toContain("NEEDS APPROVAL:")
      expect(prompt).toContain("Technical details")
    })
  }

  test("only read-only subagents edit nothing; the rest must ask before shell or edits", () => {
    expect(action("deploy-analyze", "edit")).toBe("deny")
    for (const name of ["deploy-provision", "deploy-release", "deploy-monitor"]) {
      expect(action(name, "bash")).toBe("ask")
      expect(action(name, "edit")).toBe("ask")
    }
  })

  test("provisioning refuses to create unapproved billable resources", () => {
    const prompt = agents["deploy-provision"]?.prompt ?? ""
    expect(prompt).toContain("not already approved")
    expect(prompt).toContain("do not create it")
    expect(prompt).not.toMatch(/falling back to raw shell/i)
  })
})
