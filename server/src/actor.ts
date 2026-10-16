// Who caused a change or an event: the owner (admin token), an access token (an agent, an app), a TV (the viewer
// with the remote, and what the TV reports and its connections) or the server itself (a reload by SIGHUP,
// housekeeping, the start). Stored with every event and command; consumers ignore types they do not know.

export type Actor =
  | { type: "owner" }
  | { type: "token"; tokenId: string; name: string }
  | { type: "tv"; deviceId: string }
  | { type: "server" };

export const OWNER: Actor = { type: "owner" };
export const SERVER: Actor = { type: "server" };

export const tvActor = (deviceId: string): Actor => ({ type: "tv", deviceId });
