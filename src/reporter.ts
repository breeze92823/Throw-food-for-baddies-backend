import { LEADERBOARDS, LEADERBOARD_REPORT_EVERY_MS, REPORT_BATCH_MAX, SCORE_MAX } from "./constants.js";
import type { PlayerDoc } from "./db.js";

// Bloxity's hosted leaderboards (docs.bloxity.io): on Bloxity hosting the SERVER reports scores
// (the client only declares the boards, with the same ids as LEADERBOARDS in the client's config.js).
// Only Bloxity-verified accounts are reported, as `legion_<id>`, batched every
// LEADERBOARD_REPORT_EVERY_MS (up to REPORT_BATCH_MAX per call). Without BLOXITY_REPORT_TOKEN /
// BLOXITY_GAME_ID (local development) nothing is sent.

interface Score {
  board: string;
  userId: string;
  score: number;
}

type Fetch = typeof fetch;
const realFetch: Fetch = (input, init) => fetch(input, init);
let doFetch: Fetch = realFetch;
export function __setFetchForTest(fn: Fetch | null): void {
  doFetch = fn ?? realFetch;
}

const enabled = () => !!(process.env.BLOXITY_REPORT_TOKEN && process.env.BLOXITY_GAME_ID);
const apiUrl = () => (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");

// The identity Bloxity ranks: legion_<id>, any "#m..." mode suffix stripped.
export function boardUserId(id: string): string {
  const base = id.split("#")[0];
  return base.startsWith("legion_") ? base : `legion_${base}`;
}

const pending = new Map<string, Score>(); // board|user -> the latest score, sent at the next flush
const lastQueued = new Map<string, number>(); // board|user -> the last score queued (skip unchanged)
let declared = false; // the board definitions ride on the first report

// Queues a verified player's scores from a save (only the boards whose number changed).
export function reportProgress(userId: string, doc: Partial<PlayerDoc>): void {
  if (!enabled()) return;
  const uid = boardUserId(userId);
  for (const b of LEADERBOARDS) {
    const raw = doc[b.stat];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const score = Math.min(SCORE_MAX, Math.floor(raw));
    if (score <= 0) continue;
    const key = `${b.id}|${uid}`;
    if (lastQueued.get(key) === score) continue;
    lastQueued.set(key, score);
    pending.set(key, { board: b.id, userId: uid, score });
  }
}

// Sends what is queued (<= REPORT_BATCH_MAX scores per call). Never throws; a failed call puts the
// scores back for the next flush.
export async function flushReports(): Promise<void> {
  if (!enabled() || !pending.size) return;
  const batch = [...pending.values()].slice(0, REPORT_BATCH_MAX);
  for (const s of batch) pending.delete(`${s.board}|${s.userId}`);
  const body: { boards?: unknown[]; scores: Score[] } = { scores: batch };
  if (!declared) {
    body.boards = LEADERBOARDS.map(({ id, label, order, mode, format, reset }) => ({ id, label, order, mode, format, reset }));
  }
  try {
    const res = await doFetch(`${apiUrl()}/v1/leaderboards/hosted/${encodeURIComponent(process.env.BLOXITY_GAME_ID!)}/report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.BLOXITY_REPORT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    declared = true;
    const r = (await res.json().catch((): null => null)) as { dropped?: Record<string, number> } | null;
    const dropped = Object.values(r?.dropped ?? {}).reduce((a, n) => a + (Number(n) || 0), 0);
    if (dropped) console.warn("[reporter] leaderboard scores dropped", r?.dropped);
  } catch (err) {
    console.warn("[reporter] leaderboard report failed", err);
    // Back in the queue for the next timer tick (a newer score for the same player stays newer).
    for (const s of batch) if (!pending.has(`${s.board}|${s.userId}`)) pending.set(`${s.board}|${s.userId}`, s);
    return;
  }
  if (pending.size) await flushReports(); // more than one batch queued
}

let timer: NodeJS.Timeout | null = null;
// Starts the periodic flush (once per process; harmless with no report token).
export function startReporter(): void {
  if (timer) return;
  timer = setInterval(() => void flushReports(), LEADERBOARD_REPORT_EVERY_MS);
  timer.unref();
}

// Test-only: forget everything queued.
export function __resetReporterForTest(): void {
  pending.clear();
  lastQueued.clear();
  declared = false;
}
