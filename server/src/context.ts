import type { createContext } from "./server.ts";

/**
 * What the HTTP layer works with: every module of the running server, and its settings. The modules name their own
 * dependencies (each its deps interface); this is the routes' view of them all.
 */
export type AppContext = ReturnType<typeof createContext>;
