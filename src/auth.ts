import { GAME_SLUG, NAME_MAX, PFP_MAX_LEN } from "./constants.js";

// Who a connection really is (docs.bloxity.io: never trust a user id the client sends). The client
// passes its Bloxity token (`Legion.SDK.auth.getToken()`) in the join options / `identify` message
// as `token`; this server asks Bloxity who it belongs to (POST {BLOXITY_API_URL}/v1/auth/game-token/verify)
// and only the returned `user._id` is ever an account id. A missing, refused or unverifiable token
// is a guest: nothing is loaded or saved for it, and there is NO fallback to a client-sent id --
// except in local development (NODE_ENV not "production", or ALLOW_CLIENT_IDS=true), where the
// client's own `dev-...` id is used so a local server + Mongo keeps progress without Bloxity.

export interface Identity {
  userId: string; // "" = guest
  username: string; // from Bloxity when verified
  pfp: string;
  verified: boolean; // a Bloxity-verified account (only these may appear on Bloxity's leaderboards)
}

export const GUEST: Identity = { userId: "", username: "", pfp: "", verified: false };

type Verifier = (token: string) => Promise<Identity | null>;

const apiUrl = () => (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
const gameSlug = () => process.env.BLOXITY_GAME_ID || GAME_SLUG;

// Bloxity's answer for a token: { valid, user: { _id, username, displayName, pfp }, carriedFrom? }.
async function verifyWithBloxity(token: string): Promise<Identity | null> {
  try {
    const res = await fetch(`${apiUrl()}/v1/auth/game-token/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ gameSlug: gameSlug() }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null; // 401: not a valid token -> guest
    const body = (await res.json()) as { valid?: boolean; user?: { _id?: unknown; username?: unknown; displayName?: unknown; pfp?: unknown } };
    const u = body?.user;
    if (body?.valid === false || !u || typeof u._id !== "string" || !u._id) return null;
    const name = typeof u.displayName === "string" && u.displayName ? u.displayName : typeof u.username === "string" ? u.username : "";
    const pfp = typeof u.pfp === "string" && u.pfp.length <= PFP_MAX_LEN && /^https?:\/\//i.test(u.pfp) ? u.pfp : "";
    return { userId: u._id.slice(0, 128), username: name.slice(0, NAME_MAX), pfp, verified: true };
  } catch (err) {
    console.warn("[auth] token verification failed", err);
    return null;
  }
}

let verifier: Verifier = verifyWithBloxity;
// Test-only seam: replace the call to Bloxity.
export function __setVerifierForTest(fn: Verifier | null): void {
  verifier = fn ?? verifyWithBloxity;
}

// Local development may use the client's own id; a deployed (production) server never does.
export const trustClientIds = () => process.env.NODE_ENV !== "production" || process.env.ALLOW_CLIENT_IDS === "true";

// The identity for join options / an `identify` message: { token?, userId?, username?, pfp? }.
export async function resolveIdentity(raw: unknown): Promise<Identity> {
  const o = (raw && typeof raw === "object" ? raw : {}) as { token?: unknown; userId?: unknown; username?: unknown; pfp?: unknown };
  if (typeof o.token === "string" && o.token && o.token.length <= 4096) {
    const id = await verifier(o.token);
    if (id) return id;
    return GUEST; // a token that does not verify never falls back to the client's id
  }
  if (trustClientIds() && typeof o.userId === "string" && o.userId) {
    return {
      userId: o.userId.slice(0, 128),
      username: typeof o.username === "string" ? o.username.slice(0, NAME_MAX) : "",
      pfp: typeof o.pfp === "string" && o.pfp.length <= PFP_MAX_LEN && /^https?:\/\//i.test(o.pfp) ? o.pfp : "",
      verified: false,
    };
  }
  return GUEST;
}
