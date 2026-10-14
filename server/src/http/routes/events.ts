// The TV's event stream (SSE): the current state version on connect, then state changes and commands as they
// happen. Unacknowledged recent commands are replayed on every (re)connect.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "../../context.ts";
import type { Env } from "../middleware.ts";

export function registerEvents(app: Hono<Env>, ctx: AppContext): void {
  const { store, events } = ctx;

  app.get("/api/v1/tv/events", (c) => {
    const device = c.get("device");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let ping: ReturnType<typeof setInterval> | undefined;
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      const write = (event: string, data: unknown, id?: string) =>
        stream.writeSSE({ event, data: JSON.stringify(data), ...(id ? { id } : {}) }).catch(() => stream.abort());
      const unsubscribe = events.subscribe(device.id, {
        send: (ev) => void write(ev.type, ev.data, ev.type === "state" ? `s${ev.data.version}` : `c${ev.data.id}`),
        close: () => stream.abort(),
      });
      try {
        const current = store.getDevice(device.id);
        const version = current?.stateVersion ?? device.stateVersion;
        await stream.writeSSE({ event: "state", data: JSON.stringify({ version }), id: `s${version}`, retry: 5000 });
        for (const cmd of ctx.commands.replayable(device.id)) {
          await write("command", { id: cmd.id, type: cmd.type, payload: cmd.payload }, `c${cmd.id}`);
        }
        ping = setInterval(() => void stream.write(": ping\n\n").catch(() => stream.abort()), ctx.pingMs);
        await closed;
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });
}
