// GUI part: discover models and show the result when an OpenCode Desktop window opens.
import { refreshWithRetry } from "./refresh.ts"
import { Autodiscovery } from "./rpc.ts"
import { errorMessage, resultMessage } from "./toast.ts"

export default {
  setup(ctx) {
    // Read ctx.client on every attempt: it changes when the desktop server restarts.
    void refreshWithRetry(() => ctx.client).then(
      (result) => ctx.toast.show({
        title: "Autodiscovery",
        description: resultMessage(result),
        variant: result.errors > 0 ? "error" : "success",
      }),
      (error) => ctx.toast.show({
        title: "Autodiscovery",
        description: errorMessage(error),
        variant: "error",
      }),
    )
    const controller = new AbortController()
    const off = ctx.client.rpc(Autodiscovery).events.on("discovered", ({ data }) => {
      ctx.toast.show({
        title: "Autodiscovery",
        description: resultMessage(data),
        variant: data.errors > 0 ? "error" : "success",
      })
    }, { signal: controller.signal })
    return () => { controller.abort(); off() }
  },
}
