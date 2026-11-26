// TUI part: refresh autodiscovered models when the UI opens (and on demand via the palette command).
import { refreshWithRetry } from "./refresh.ts"
import { errorMessage, resultMessage } from "./toast.ts"

export default {
  id: "autodiscovery.tui",
  async setup(context) {
    const discover = async ({ invalidate = false } = {}) => {
      try {
        // Read context.client on every attempt: it changes when the server restarts.
        const result = await refreshWithRetry(() => context.client, { invalidate })
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
          palette: true,
          run: () => discover(),
        },
        {
          id: "autodiscovery.ad",
          title: "Discover models (fresh)",
          description: "Clear the autodiscovery cache and refetch all models",
          group: "Autodiscovery",
          palette: true,
          slash: { name: "ad" },
          run: () => discover({ invalidate: true }),
        },
      ],
    }))

    await discover()
  },
}
