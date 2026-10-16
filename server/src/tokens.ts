// Access tokens: named secrets the owner hands to an agent or an app, each with one scope, revocable at any time.
// The secret is `izat_` + 32 random bytes (base64url), shown once; the server keeps its sha256 and never logs it.

import { newId, newToken, sha256 } from "./auth.ts";
import { HttpError } from "./errors.ts";
import type { Logger } from "./log.ts";
import { iso } from "./presenters.ts";
import type { AccessToken, Store } from "./store.ts";

/** What an access token may do, each scope including the ones before it; the owner token may do everything. */
export const SCOPES = ["read", "control", "manage"] as const;

export type Scope = (typeof SCOPES)[number];

/** Lets secret scanners recognize the secret, and the server tell it from the owner token. */
export const ACCESS_TOKEN_PREFIX = "izat_";

/** `lastUsedAt` is written at most this often. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export function accessTokenJson(t: AccessToken) {
  return { id: t.id, name: t.name, scope: t.scope, createdAt: iso(t.createdAt), lastUsedAt: iso(t.lastUsedAt) };
}

export class TokenService {
  private readonly store: Store;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(store: Store, log: Logger, now: () => number) {
    this.store = store;
    this.log = log;
    this.now = now;
  }

  /** Creates a token; the secret is returned here and nowhere else. 409 `duplicate_name` for a name in use. */
  create(name: string, scope: Scope): { token: AccessToken; secret: string } {
    const trimmed = name.trim();
    const secret = `${ACCESS_TOKEN_PREFIX}${newToken()}`;
    const token = this.store.transaction(() => {
      if (this.store.getAccessTokenByName(trimmed)) throw new HttpError(409, "duplicate_name", "an access token with this name exists");
      return this.store.insertAccessToken({ id: newId(), name: trimmed, scope, secretHash: sha256(secret), createdAt: this.now(), lastUsedAt: null });
    });
    // The token's id is its actor id in the access log; a field named after the token would be dropped by the log's
    // redaction, and the secret is never logged anywhere.
    this.log.info("access token created", { actorId: token.id, scope });
    return { token, secret };
  }

  list(): AccessToken[] {
    return this.store.listAccessTokens();
  }

  /** Revokes a token: requests with it answer 401 from now on. 404 `unknown_token` when there is none with the id. */
  revoke(id: string): void {
    if (!this.store.deleteAccessToken(id)) throw new HttpError(404, "unknown_token");
    this.log.info("access token revoked", { actorId: id });
  }

  /** The token a presented secret belongs to, or null; records its use at most once a minute. */
  authenticate(secret: string): AccessToken | null {
    const token = this.store.getAccessTokenByHash(sha256(secret));
    if (!token) return null;
    const t = this.now();
    if (token.lastUsedAt === null || t - token.lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS) {
      this.store.touchAccessToken(token.id, t);
      token.lastUsedAt = t;
    }
    return token;
  }
}
