import { BASE_COUNT } from "./constants.js";

// Bases: the fenced pens of the hub. A room holds BASE_COUNT players and each gets one base of
// their own for the whole session (PlayerState.base, client src/net.js -> main.js).

// The base for a newcomer: `preferred` (a rejoining player asking for the base they had) when it
// is a valid, free index, otherwise the lowest free one. -1 when every base is taken.
export function pickBase(taken: Iterable<number>, preferred?: unknown): number {
  const used = new Set(taken);
  if (typeof preferred === "number" && Number.isInteger(preferred) && preferred >= 0 && preferred < BASE_COUNT && !used.has(preferred)) {
    return preferred;
  }
  for (let i = 0; i < BASE_COUNT; i++) if (!used.has(i)) return i;
  return -1;
}
