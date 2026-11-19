// Rewarded ads (https://docs.bloxity.io): the portal plays the ad and hands the client a
// `rewardToken`; the server verifies it before the reward is granted. A token verifies once, only for
// this game and within five minutes of the ad, and counts against a daily cap per player.

export const AD_PLACEMENT_PATTERN = /^[a-z0-9-]{1,40}$/;
const API_HOST_PATTERN = /(^|\.)bloxity\.io$/i;
const DEFAULT_API_URL = "https://api.bloxity.io";

// The Bloxity API the token is verified against: BLOXITY_API_URL when the host sets it, else the
// client's own `apiUrl` (prod and stage differ) but only if it is an https bloxity.io host, else
// prod. Never an arbitrary URL from the client.
export function verifyBase(clientApiUrl: unknown, env: string | undefined = process.env.BLOXITY_API_URL): string {
  const fromEnv = typeof env === "string" ? env.trim() : "";
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (typeof clientApiUrl === "string") {
    try {
      const u = new URL(clientApiUrl);
      if (u.protocol === "https:" && API_HOST_PATTERN.test(u.hostname)) return u.origin;
    } catch {
      // Not a URL: fall through.
    }
  }
  return DEFAULT_API_URL;
}

export interface AdVerdict {
  valid: boolean;
  reason?: string;
  test?: boolean;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json(): Promise<any> }>;

// Asks Bloxity whether `rewardToken` is a real, unspent ad for `gameSlug`.
export async function verifyAdReward(base: string, gameSlug: string, rewardToken: unknown, fetchFn: Fetch = fetch as unknown as Fetch): Promise<AdVerdict> {
  if (typeof rewardToken !== "string" || rewardToken.length < 8 || rewardToken.length > 2048) return { valid: false, reason: "token" };
  try {
    const res = await fetchFn(`${base}/v1/ads/reward/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameSlug, rewardToken }),
    });
    const v = await res.json();
    if (v?.valid === true) return { valid: true, test: v.test === true };
    return { valid: false, reason: typeof v?.reason === "string" ? v.reason.slice(0, 32) : "invalid" };
  } catch {
    return { valid: false, reason: "unreachable" };
  }
}
