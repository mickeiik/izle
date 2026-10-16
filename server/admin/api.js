// @ts-check
// The admin API and the admin token. The boot code decides what a refused token means (`onUnauthorized`).

import { toast } from "./dom.js";
import { errorText } from "./lib.js";

/**
 * localStorage access, which throws in a private window, with blocked site data or a full quota: then nothing is
 * remembered (`fallback`) and the page still works.
 * @template T @param {() => T} fn @param {T} fallback
 */
function stored(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
/** @param {string} key */
export const readStored = (key) => stored(() => localStorage.getItem(key), null);
/** Whether the browser kept it. @param {string} key @param {string} value */
export const writeStored = (key, value) => stored(() => (localStorage.setItem(key, value), true), false);

const TOKEN_KEY = "izle.adminToken";
/** The token when the browser keeps no site data (a private window): signed in until the tab closes. */
let memoryToken = /** @type {string | null} */ (null);
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

/** Whether a request was cancelled because the view that made it ended. @param {unknown} err */
export const isAborted = (err) => err instanceof ApiError && err.code === "aborted";
/** @param {unknown} err */
export const isUnauthorized = (err) => err instanceof ApiError && err.status === 401;

export const getToken = () => readStored(TOKEN_KEY) ?? memoryToken;

/**
 * Checks `token` against the server (rejects with its `ApiError` when refused), then keeps it. Resolves with whether
 * the browser remembers it beyond this tab; when it does not, the owner is told.
 * @param {string} token
 */
export async function signIn(token) {
  await api("GET", "/catalog", undefined, { token });
  memoryToken = token;
  const remembered = writeStored(TOKEN_KEY, token);
  if (!remembered) toast("Signed in for this tab only: this browser does not let the page remember the token.", "info");
  return remembered;
}

export function clearToken() {
  memoryToken = null;
  stored(() => localStorage.removeItem(TOKEN_KEY), undefined);
}

/** What to do when the server refuses the stored token (401). @param {() => void} fn */
export function onUnauthorized(fn) {
  unauthorized = fn;
}

/** @param {string} id */
export const devicePath = (id) => `/devices/${encodeURIComponent(id)}`;

/**
 * One admin API call. Resolves with the JSON answer (null for 204), rejects with an `ApiError`: the server's error
 * code, `network` when it cannot be reached, `aborted` when `signal` fired.
 * @param {string} method
 * @param {string} path below /api/v1/admin
 * @param {unknown} [body]
 * @param {{ token?: string | null, signal?: AbortSignal }} [opts] `token`: one other than the stored one
 * @returns {Promise<any>}
 */
export async function api(method, path, body, opts = {}) {
  return request(method, path, body !== undefined ? { "Content-Type": "application/json" } : {}, body !== undefined ? JSON.stringify(body) : undefined, opts);
}

/**
 * Uploads a file as the raw request body (`PUT`), as an APK (`Content-Type`) with its name in `X-Izle-Filename`;
 * `headers` are added. Answers and fails like `api()`.
 * @param {string} path below /api/v1/admin
 * @param {File} file
 * @param {Record<string, string>} [headers]
 * @returns {Promise<any>}
 */
export async function upload(path, file, headers = {}) {
  return request("PUT", path, { "Content-Type": "application/vnd.android.package-archive", "X-Izle-Filename": file.name, ...headers }, file, {});
}

/**
 * @param {string} method @param {string} path @param {Record<string, string>} headers
 * @param {BodyInit | undefined} body @param {{ token?: string | null, signal?: AbortSignal }} opts
 */
async function request(method, path, headers, body, opts) {
  const withToken = opts.token === undefined ? getToken() : opts.token;
  const aborted = () => new ApiError(0, "aborted", null);
  let res;
  try {
    res = await fetch(`/api/v1/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${withToken ?? ""}`, ...headers },
      ...(body !== undefined ? { body } : {}),
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
 * Runs an action that calls the API. A failure becomes an error toast (a refused token signs out instead, and a
 * cancelled request says nothing); `success`, if given, is toasted once it worked.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} [success]
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: unknown }>}
 */
export async function attempt(fn, success) {
  try {
    const value = await fn();
    if (success) toast(success);
    return { ok: true, value };
  } catch (error) {
    if (!isAborted(error) && !isUnauthorized(error)) toast(errorText(error), "error");
    return { ok: false, error };
  }
}
