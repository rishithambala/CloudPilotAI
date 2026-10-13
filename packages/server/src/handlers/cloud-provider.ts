import { CloudProvider } from "@cloudpilot-ai/schema/cloud-provider"
import { CLOUD_PROVIDERS } from "@cloudpilot-ai/core/cloud-provider/catalog"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

// Derived from the single catalog in @cloudpilot-ai/core.
const all: ReadonlyArray<typeof CloudProvider.Info.Type> = CLOUD_PROVIDERS.map((item) => ({
  id: CloudProvider.ID.make(item.id),
  name: item.name,
  description: item.description,
}))

export const CloudProviderHandler = HttpApiBuilder.group(Api, "server.cloud-provider", (handlers) =>
  handlers.handle("cloud-provider.list", () =>
    Effect.gen(function* () {
      return yield* response(Effect.succeed(all))
    }),
  ),
)
