// Request parameters several route modules read the same way.

import { HttpError } from "../errors.ts";
import type { Device, Store } from "../store.ts";
import { isId } from "../validation.ts";

/** The `wait=<seconds>` query parameter of the long-poll routes. */
export function parseWait(param: string | undefined, defaultSec: number, maxSec: number): number {
  const sec = param === undefined ? defaultSec : Number(param);
  if (!Number.isInteger(sec) || sec < 0 || sec > maxSec) throw new HttpError(400, "invalid_request", `wait must be an integer between 0 and ${maxSec}`);
  return sec;
}

/** The device a `/admin/devices/:id` route names; 404 `unknown_device` otherwise. */
export function requireDevice(store: Store, id: string): Device {
  const d = isId(id) ? store.getDevice(id) : null;
  if (!d) throw new HttpError(404, "unknown_device");
  return d;
}
