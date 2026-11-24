// TUI part: adds CTRL-D "Discover models" to refresh the autodiscovered inventory live.
import { Autodiscovery } from "./rpc.ts"

export default {
  id: "autodiscovery.tui",
  setup(context) {
    const discover = async () => {
      try {
        const result = await context.client.rpc(Autodiscovery).refresh({})
        const location = context.location ?? context.data.location.default()
        await context.data.location.model.invalidate(location)
        await context.data.location.model.sync(location)
        context.ui.toast.show({
          title: "Autodiscovery",
          message: `${result.models} model(s) up to date`,
          variant: result.errors > 0 ? "warning" : "success",
        })
      } catch (error) {
        context.ui.toast.show({
          title: "Autodiscovery",
          message: `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          variant: "error",
        })
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 100,
      commands: [
        {
          id: "autodiscovery.discover",
          title: "Discover models",
          description: "Refresh autodiscovered models for this location",
          group: "Autodiscovery",
          bind: "ctrl+d",
          palette: true,
          run: () => discover(),
        },
      ],
    }))
  },
}
