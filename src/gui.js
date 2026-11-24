// GUI part: discover models and show the result when an OpenCode Desktop window opens.
import { Autodiscovery } from "./rpc.ts"
import { errorMessage, resultMessage } from "./toast.ts"

export default {
  setup(ctx) {
    // Read ctx.client here: it changes when the desktop server restarts.
    void ctx.client.rpc(Autodiscovery).refresh({}).then(
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
  },
}
