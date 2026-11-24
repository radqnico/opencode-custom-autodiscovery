// TUI part: refresh autodiscovered models when the UI opens and on CTRL-D.
import { Autodiscovery } from "./rpc.ts"
import { errorMessage, resultMessage } from "./toast.ts"

export default {
  id: "autodiscovery.tui",
  async setup(context) {
    const discover = async () => {
      try {
        // Read context.client here: it changes when the server restarts.
        const result = await context.client.rpc(Autodiscovery).refresh({})
        const location = context.location ?? context.data.location.default()
        await context.data.location.model.invalidate(location)
        await context.data.location.model.sync(location)
        context.ui.toast.show({
          title: "Autodiscovery",
          message: resultMessage(result),
          variant: result.errors > 0 ? "warning" : "success",
        })
      } catch (error) {
        context.ui.toast.show({
          title: "Autodiscovery",
          message: errorMessage(error),
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

    await discover()
  },
}
