import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "0.0.0.0";

serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  process.stdout.write(JSON.stringify({ level: "info", msg: "listening", port: info.port }) + "\n");
});
