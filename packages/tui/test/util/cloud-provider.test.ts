import { describe, expect, test } from "bun:test"
import { CLOUD_PROVIDERS as CATALOG } from "@cloudpilot-ai/core/cloud-provider/catalog"
import {
  CLOUD_PROVIDERS,
  cloudProviderState,
  getConnectedCloudProviders,
  isCloudProviderConnected,
  setCloudProviderState,
} from "../../src/util/cloud-provider"

describe("util.cloud-provider", () => {
  test("TUI list is derived from the single core catalog", () => {
    expect(CLOUD_PROVIDERS.map((item) => item.value)).toEqual(CATALOG.map((item) => item.id))
    expect(CLOUD_PROVIDERS.map((item) => item.title)).toEqual(CATALOG.map((item) => item.name))
  })

  test("connection status reflects real detected state instead of a stub", () => {
    expect(isCloudProviderConnected("azure")).toBe(false)
    setCloudProviderState("azure", "connected")
    setCloudProviderState("oracle", "reauth")
    expect(isCloudProviderConnected("azure")).toBe(true)
    expect(isCloudProviderConnected("oracle")).toBe(false)
    expect(cloudProviderState("oracle")).toBe("reauth")
    expect(getConnectedCloudProviders().map((item) => item.value)).toEqual(["azure"])
    setCloudProviderState("azure", "not_connected")
    expect(getConnectedCloudProviders()).toEqual([])
  })
})
