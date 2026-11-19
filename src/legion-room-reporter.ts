import { matchMaker } from "colyseus";

// Shows this pod's live rooms on the game's Bloxity page ("Open Rooms": a list with a Join button that
// reopens the game with ?roomId=<colyseusRoomId>, which net.js joins through the pod's relay).
// Bloxity-hosted games only appear there if the server runs this reporter (docs.bloxity.io): every
// REPORT_EVERY_MS it posts the pod's rooms to the matchmaker. The matchmaker lists public rooms only
// (a `private` room never shows). It does nothing unless Bloxity hosting injected MATCHMAKER_REPORT_URL,
// BLOXITY_REPORT_TOKEN and BLOXITY_GAME_ID, so local development is untouched.

const REPORT_EVERY_MS = 2000;
const TIMEOUT_MS = 4000;

type Fetch = typeof fetch;
const realFetch: Fetch = (input, init) => fetch(input, init);
let doFetch: Fetch = realFetch;
// Test-only seam: replace the HTTP call.
export function __setRoomReporterFetchForTest(fn: Fetch | null): void {
  doFetch = fn ?? realFetch;
}

const config = () => {
  const url = (process.env.MATCHMAKER_REPORT_URL || "").replace(/\/+$/, "");
  const token = process.env.BLOXITY_REPORT_TOKEN || "";
  const gameId = process.env.BLOXITY_GAME_ID || "";
  return url && token && gameId ? { url, token, gameId } : null;
};

// One report: this pod's rooms (`podName`, total `players`, and each room's id, name, clients, size,
// lock / private flags, `started` and metadata). Never throws: the directory tolerates gaps.
export async function reportRoomsOnce(): Promise<boolean> {
  const c = config();
  if (!c) return false;
  try {
    const rooms = await matchMaker.query({});
    const body = {
      podName: process.env.POD_NAME || process.env.HOSTNAME || "",
      players: rooms.reduce((n, r) => n + (r.clients || 0), 0),
      rooms: rooms.map((r) => {
        const metadata = (r.metadata ?? {}) as Record<string, unknown>;
        return {
          colyseusRoomId: r.roomId,
          name: r.name,
          clients: r.clients,
          maxClients: r.maxClients,
          locked: !!r.locked,
          private: !!r.private,
          started: metadata.started === true,
          metadata,
        };
      }),
    };
    const res = await doFetch(`${c.url}/${encodeURIComponent(c.gameId)}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let timer: NodeJS.Timeout | null = null;
// Starts reporting (once per process): call after listen(). A no-op outside a Bloxity deployment.
export function installRoomReporter(): void {
  if (timer || !config()) return;
  void reportRoomsOnce();
  timer = setInterval(() => void reportRoomsOnce(), REPORT_EVERY_MS);
  timer.unref();
}
