import { describe, expect, test } from "bun:test"
import { buildGithubStatus, buildReport, cloudTargets, TARGETS } from "../../src/tool/connection-status"
import { CLOUD_PROVIDER_IDS } from "@cloudpilot-ai/core/cloud-provider/catalog"
import type { CloudConnectionStatus } from "@cloudpilot-ai/core/cloud-provider/detect"

const cloud = (provider: CloudConnectionStatus["provider"], state: CloudConnectionStatus["state"], name: string) =>
  ({ provider, name, state, summary: `${name} ${state}`, checkedAt: 0 }) satisfies CloudConnectionStatus

describe("tool.connection_status", () => {
  test("targets cover github and every catalog provider", () => {
    expect(TARGETS).toEqual(["all", "github", ...CLOUD_PROVIDER_IDS])
    expect(cloudTargets("all")).toEqual([...CLOUD_PROVIDER_IDS])
    expect(cloudTargets("github")).toEqual([])
    expect(cloudTargets("azure")).toEqual(["azure"])
  })

  test("github status uses the same MCP mapping as the Settings row", () => {
    const connected = buildGithubStatus({ status: "connected" }, "acme/app")
    expect(connected).toMatchObject({ state: "connected", repository: "acme/app" })
    expect(connected.summary).toContain("acme/app")
    expect(connected.nextStep).toBeUndefined()

    const missing = buildGithubStatus(undefined, undefined)
    expect(missing.state).toBe("not_connected")
    expect(missing.nextStep).toContain("Settings")
    expect(buildGithubStatus({ status: "needs_auth" }, undefined).state).toBe("needs_auth")
    expect(buildGithubStatus({ status: "failed", error: "401" }, undefined).summary).toContain("401")
  })

  test("report overview is plain language", () => {
    const report = buildReport({
      github: buildGithubStatus({ status: "connected" }, undefined),
      cloud: [cloud("aws", "connected", "AWS"), cloud("azure", "reauth", "Microsoft Azure")],
    })
    expect(report.overview).toBe("GitHub is connected; connected cloud providers: AWS.")
    expect(buildReport({ cloud: [cloud("oracle", "not_connected", "Oracle Cloud")] }).overview).toBe(
      "no cloud provider is connected yet.",
    )
  })
})
