// @ts-check
// The admin API (docs/spec/server-api-v1.md, "Admin API") and the admin token. The boot code decides what a
// refused token means (`onUnauthorized`), so this module knows nothing about routes or views.

import { toast } from "./dom.js";
import { errorText } from "./lib.js";
import { forgetStored, readStored, writeStored } from "./storage.js";

const TOKEN_KEY = "izle.adminToken";

/** The token when the browser keeps no site data (a private window): signed in until the tab closes. */
let memoryToken = /** @type {string | null} */ (null);

/** @type {() => void} */
let unauthorized = () => {};

export class ApiError extends Error {
  /** @param {number} status 0 when no answer came @param {string} code @param {any} body */
  constructor(status, code, body) {
    super(code);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Whether a request was cancelled because the view that made it ended (nothing to report). @param {unknown} err */
export const isAborted = (err) => err instanceof ApiError && err.code === "aborted";

/** Whether the server refused the token (401). @param {unknown} err */
export const isUnauthorized = (err) => err instanceof ApiError && err.status === 401;

export function getToken() {
  return readStored(TOKEN_KEY) ?? memoryToken;
}

/**
 * Keeps the admin token; returns whether the browser remembers it beyond this tab.
 * @param {string} token
 */
function setToken(token) {
  memoryToken = token;
  return writeStored(TOKEN_KEY, token);
}

/**
 * Signs in with `token`: checks it against the server (rejects with its `ApiError` when refused), then keeps it.
 * Resolves with whether the browser remembers it beyond this tab; when it does not, the owner is told.
 * @param {string} token
 */
export async function signIn(token) {
  await api("GET", "/catalog", undefined, { token });
  const remembered = setToken(token);
  if (!remembered) toast("Signed in for this tab only: this browser does not let the page remember the token.", "info");
  return remembered;
}

export function clearToken() {
  memoryToken = null;
  forgetStored(TOKEN_KEY);
}

/** What to do when the server refuses the stored token (401). @param {() => void} fn */
export function onUnauthorized(fn) {
  unauthorized = fn;
}

/** `/devices/<id>`, the id encoded. @param {string} id */
export const devicePath = (id) => `/devices/${encodeURIComponent(id)}`;

/**
 * @typedef {object} CallOptions
 * @property {string | null} [token] a token other than the stored one (sign-in checks the candidate)
 * @property {AbortSignal} [signal] cancels the request; it then fails with the code `aborted`
 */

/**
 * One admin API call. Resolves with the JSON answer (null for 204), rejects with an `ApiError`: the server's error
 * code, `network` when it cannot be reached, `aborted` when `signal` fired.
 * @param {string} method
 * @param {string} path below /api/v1/admin
 * @param {unknown} [body]
 * @param {CallOptions} [opts]
 * @returns {Promise<any>}
 */
export async function api(method, path, body, opts = {}) {
  const withToken = opts.token === undefined ? getToken() : opts.token;
  const aborted = () => new ApiError(0, "aborted", null);
  let res;
  try {
    res = await fetch(`/api/v1/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${withToken ?? ""}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    throw opts.signal?.aborted ? aborted() : new ApiError(0, "network", null);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (opts.signal?.aborted) throw aborted();
  if (res.status === 401 && withToken === getToken()) unauthorized();
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `http_${res.status}`, data);
  return data;
}

/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: unknown }} Result
 */

/**
 * Runs an action that calls the API. A failure becomes an error toast (a refused token signs out instead, and a
 * cancelled request says nothing); `success`, if given, is toasted once it worked.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} [success]
 * @returns {Promise<Result<T>>}
 */
export async function attempt(fn, success) {
  try {
    const value = await fn();
    if (success) toast(success);
    return { ok: true, value };
  } catch (error) {
    const quiet = isAborted(error) || isUnauthorized(error);
    if (!quiet) toast(errorText(error), "error");
    return { ok: false, error };
  }
}
