// GUI part: discover models when an OpenCode Desktop window opens.
import { Autodiscovery } from "./rpc.ts"

export default {
  setup(ctx) {
    // Read ctx.client here: it changes when the desktop server restarts.
    void ctx.client.rpc(Autodiscovery).refresh({}).catch(() => {})
  },
}
