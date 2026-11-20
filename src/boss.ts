import { BOSS_AT_MIN, BOSS_LENGTH_MIN, BOSS_NEED_PER_PLAYER } from "./constants.js";

// The Hungry Giant (client game/boss.js): a room-wide event on the UTC clock. While she is here
// every `throw` a player in the room sends feeds her one bite; once the bites reach `need` she is
// full and everyone who threw is told how many times they fed her (`bossWin`), so each client pays
// its own reward. The room keeps one BossState per visit; `key` (her arrival, epoch ms) names it.

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface BossState {
  key: number; // epoch ms she arrived (0 = no visit yet)
  endsAt: number;
  need: number;
  fill: number;
  won: boolean;
  throws: Map<string, number>; // sessionId -> throws while she was here
}

// The visit running at `now`: { key, endsAt } or null.
export function bossWindow(now: number): { key: number; endsAt: number } | null {
  const hour = Math.floor(now / HOUR) * HOUR;
  for (const h of [hour - HOUR, hour]) {
    for (const m of BOSS_AT_MIN) {
      const key = h + m * MIN;
      const endsAt = key + BOSS_LENGTH_MIN * MIN;
      if (now >= key && now < endsAt) return { key, endsAt };
    }
  }
  return null;
}

export function newBoss(key: number, endsAt: number, players: number): BossState {
  return { key, endsAt, need: BOSS_NEED_PER_PLAYER * Math.max(1, players), fill: 0, won: false, throws: new Map() };
}

// One throw from `sessionId`. Returns true when this throw filled her up.
export function feedBoss(b: BossState, sessionId: string): boolean {
  if (b.won) return false;
  b.throws.set(sessionId, (b.throws.get(sessionId) ?? 0) + 1);
  b.fill++;
  if (b.fill >= b.need) {
    b.won = true;
    return true;
  }
  return false;
}

// What clients are sent as `boss`.
export const bossView = (b: BossState | null, on: boolean) => (b ? { key: b.key, on, fill: b.fill, need: b.need, won: b.won, endsAt: b.endsAt } : { key: 0, on: false, fill: 0, need: 0, won: false, endsAt: 0 });
