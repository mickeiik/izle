import serverPackage from "../package.json" with { type: "json" };

/** The server's version (from its package.json; inlined into the release bundle). */
export const VERSION: string = serverPackage.version;
