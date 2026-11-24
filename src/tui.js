// TUI part: discover models when a terminal UI opens, not when the server starts.
import { Autodiscovery } from "./rpc.ts"

export default {
  id: "autodiscovery.tui",
  async setup(context) {
    try {
      const result = await context.client.rpc(Autodiscovery).refresh({})
      if (result.errors > 0) {
        context.ui.toast.show({
          title: "Autodiscovery",
          message: `${result.models} model(s), ${result.errors} provider(s) failed`,
          variant: "warning",
        })
      }
    } catch (error) {
      context.ui.toast.show({
        title: "Autodiscovery",
        message: `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        variant: "error",
      })
    }
  },
}
