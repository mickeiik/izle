// @ts-check
// What the /connect page makes of its URL (`<server>/connect#<invite>`): the server's address, the invite, and the
// Android intent link that hands both to the izle companion app. No DOM here: unit-tested from node.

/** An invite as the server makes it: 32 random bytes, base64url. */
const INVITE = /^[A-Za-z0-9_-]{43}$/;
const PACKAGE = "io.github.mickeiik.izle.companion";

/**
 * The server's address and the invite of a `/connect` URL; null without a valid invite.
 * @param {{ origin: string, pathname: string, hash: string }} loc
 * @returns {{ server: string, invite: string } | null}
 */
export function connectTarget(loc) {
  const invite = loc.hash.replace(/^#/, "");
  if (!INVITE.test(invite)) return null;
  const at = loc.pathname.lastIndexOf("/connect");
  const prefix = at >= 0 ? loc.pathname.slice(0, at) : "";
  return { server: `${loc.origin}${prefix}`, invite };
}

/** The intent link that opens the companion app with the invite. @param {{ server: string, invite: string }} t */
export function appLink(t) {
  return `intent://connect?server=${encodeURIComponent(t.server)}&invite=${t.invite}#Intent;scheme=izle-companion;package=${PACKAGE};end`;
}
