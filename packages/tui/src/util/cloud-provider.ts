import { createStore } from "solid-js/store"
import { CLOUD_PROVIDERS as CATALOG, type CloudProviderID } from "@cloudpilot-ai/core/cloud-provider/catalog"
import {
  detectAllCloudProviders,
  invalidateCloudProvider,
  type CloudConnectionState,
} from "@cloudpilot-ai/core/cloud-provider/detect"

export type CloudProviderItem = {
  value: CloudProviderID
  title: string
  description: string
}

// Derived from the single catalog in @cloudpilot-ai/core — never re-declare
// the provider list here.
export const CLOUD_PROVIDERS: CloudProviderItem[] = CATALOG.map((item) => ({
  value: item.id,
  title: item.name,
  description: item.description,
}))

// Reactive connection state for every provider, fed by the same core
// detection the agent-facing `connection_status` tool uses. Connect flows
// push live phase changes in; `refreshCloudProviders()` fills it from a
// cheap background check for surfaces (sidebar, Settings) that have no
// connect flow of their own running.
const [connections, setConnections] = createStore<Partial<Record<CloudProviderID, CloudConnectionState>>>({})

export function setCloudProviderState(id: CloudProviderID, state: CloudConnectionState) {
  if (connections[id] === state) return
  setConnections(id, state)
  invalidateCloudProvider(id)
}

export function cloudProviderState(id: CloudProviderID): CloudConnectionState | undefined {
  return connections[id]
}

export function isCloudProviderConnected(id: string) {
  return connections[id as CloudProviderID] === "connected"
}

export function getConnectedCloudProviders() {
  return CLOUD_PROVIDERS.filter((item) => isCloudProviderConnected(item.value))
}

let refreshing: Promise<void> | undefined

// Deduplicated; results younger than a minute are reused so reopening the
// sidebar or Settings never repeats the CLI checks.
export function refreshCloudProviders(options: { force?: boolean } = {}): Promise<void> {
  if (refreshing) return refreshing
  refreshing = detectAllCloudProviders({ maxAgeMs: options.force ? 0 : 60_000 })
    .then((items) => {
      for (const item of items) setConnections(item.provider, item.state)
    })
    .catch(() => undefined)
    .finally(() => {
      refreshing = undefined
    })
  return refreshing
}
