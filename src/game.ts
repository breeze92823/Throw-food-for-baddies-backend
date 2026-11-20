import { CURRENCY_MAX, ID_PATTERN, PEN_MAX } from "./constants.js";

// Throw Food for Baddies' save: the client's whole progress (game/state.js `S`), stored as one
// `game` field of the player's document. The client keeps nothing in the browser; this is the only
// save. Client-authoritative like the rest: the server only bounds and shapes it so a forged
// payload cannot store junk or a huge document.

// A pen / hotbar entry: v = variant (client VARIANTS, 0 = plain), a = the lane area a season girl
// was caught in (her income scales with it). Both only present when set.
export interface SavedBaddie {
  uid: number;
  id: string;
  size: number;
  v?: number;
  a?: number;
}
export interface GameSave {
  money: number;
  strength: number;
  capacityLevel: number;
  foods: string[];
  food: string;
  foodsV: number;
  upgrades: Record<string, number>;
  baddies: SavedBaddie[];
  hotbar: Omit<SavedBaddie, "uid">[];
  discovered: Record<string, true>;
  quests: Record<string, true>;
  seen: string[]; // Index entries the player has looked at (the NEW tags)
  pad: { cash: number; xp: number };
  train: { level: number; xp: number; reps: number; bench: number }; // bench = Training Bench tier (0-based)
  chestAt: number;
  income: number; // money per second when saved (the income board)
  adBoostUntil: number; // epoch ms the rewarded-ad income boost ends
  luckyCredits: number; // free Lucky Throws (ads, gifts, daily, spin, event shop)
  tickets: number; // Event Tickets (earned only, spent in the event shop)
  lures: number; // Season Lures waiting to be used
  potions: Record<string, number>; // potion kind -> epoch ms it lasts until
  recordPaid: number; // distance-record milestones already paid
  indexPaid: number[]; // areas whose completed Index page has paid its reward
  titles: string[]; // titles earned (completed Index pages)
  stats: { throws: number; catches: number; fused: number; bestOdds: number; earned: number; bestDist: number; bestStreak: number; bestVariant: number; bestRarity: number; bestArea: number };
  lastSeen: number;
}

export const GAME_LIMITS = {
  ids: 512, // foods / discovered / seen entries kept
  hotbar: 32,
  level: 1e6,
  luckyCredits: 99,
  benchTier: 63, // Training Bench tiers (client TRAINING.benches)
  epochMs: 8.64e15, // the largest valid JS Date
  variant: 9, // client VARIANTS
  areas: 63, // lane areas (client AREAS)
  potions: 16, // potion kinds kept
  titles: 64, // titles kept
  titleLen: 64, // characters in one title
  tickets: 1e12,
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
const num = (v: unknown, max: number, min = 0): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min);
const int = (v: unknown, max: number, min = 0): number => Math.floor(num(v, max, min));
const isSize = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 9;

function idList(raw: unknown, max: number): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter(isId))].slice(0, max) : [];
}
function idFlags(raw: unknown, max: number): Record<string, true> {
  const out: Record<string, true> = {};
  if (!isObject(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= max) break;
    if (isId(id) && v) out[id] = true;
  }
  return out;
}
// The optional variant / caught-area fields of an entry, bounded (absent when 0 / missing).
function extras(b: Record<string, unknown>): { v?: number; a?: number } {
  const out: { v?: number; a?: number } = {};
  const v = int(b.v, GAME_LIMITS.variant);
  if (v > 0) out.v = v;
  if (Number.isInteger(b.a)) out.a = int(b.a, GAME_LIMITS.areas);
  return out;
}

// The bounded save, or null when `raw` is not an object at all.
export function sanitizeGame(raw: unknown): GameSave | null {
  if (!isObject(raw)) return null;
  const upgrades: Record<string, number> = {};
  if (isObject(raw.upgrades)) {
    for (const [id, n] of Object.entries(raw.upgrades)) {
      if (Object.keys(upgrades).length >= 64) break;
      if (isId(id)) upgrades[id] = int(n, GAME_LIMITS.level);
    }
  }
  const baddies: SavedBaddie[] = [];
  if (Array.isArray(raw.baddies)) {
    for (const b of raw.baddies) {
      if (baddies.length >= PEN_MAX) break;
      if (isObject(b) && isId(b.id) && isSize(b.size)) baddies.push({ uid: int(b.uid, 1e9), id: b.id, size: b.size as number, ...extras(b) });
    }
  }
  const hotbar: Omit<SavedBaddie, "uid">[] = [];
  if (Array.isArray(raw.hotbar)) {
    for (const b of raw.hotbar) {
      if (hotbar.length >= GAME_LIMITS.hotbar) break;
      if (isObject(b) && isId(b.id) && isSize(b.size)) hotbar.push({ id: b.id, size: b.size as number, ...extras(b) });
    }
  }
  const potions: Record<string, number> = {};
  if (isObject(raw.potions)) {
    for (const [id, until] of Object.entries(raw.potions)) {
      if (Object.keys(potions).length >= GAME_LIMITS.potions) break;
      if (isId(id)) potions[id] = num(until, GAME_LIMITS.epochMs);
    }
  }
  const indexPaid = Array.isArray(raw.indexPaid) ? [...new Set(raw.indexPaid.filter((a) => Number.isInteger(a) && a >= 0 && a <= GAME_LIMITS.areas))].slice(0, GAME_LIMITS.areas + 1) : [];
  const titles = Array.isArray(raw.titles) ? [...new Set(raw.titles.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= GAME_LIMITS.titleLen))].slice(0, GAME_LIMITS.titles) : [];
  const pad = isObject(raw.pad) ? raw.pad : {};
  const train = isObject(raw.train) ? raw.train : {};
  const stats = isObject(raw.stats) ? raw.stats : {};
  const foods = idList(raw.foods, GAME_LIMITS.ids);
  return {
    money: num(raw.money, CURRENCY_MAX),
    strength: num(raw.strength, CURRENCY_MAX),
    capacityLevel: int(raw.capacityLevel, 1000),
    foods,
    food: isId(raw.food) ? raw.food : foods[foods.length - 1] ?? "",
    foodsV: int(raw.foodsV, 100),
    upgrades,
    baddies,
    hotbar,
    discovered: idFlags(raw.discovered, GAME_LIMITS.ids),
    quests: idFlags(raw.quests, 256),
    seen: idList(raw.seen, GAME_LIMITS.ids),
    pad: { cash: num(pad.cash, CURRENCY_MAX), xp: num(pad.xp, CURRENCY_MAX) },
    train: { level: int(train.level, GAME_LIMITS.level, 1), xp: num(train.xp, CURRENCY_MAX), reps: int(train.reps, 1e12), bench: int(train.bench, GAME_LIMITS.benchTier) },
    chestAt: num(raw.chestAt, GAME_LIMITS.epochMs),
    income: num(raw.income, CURRENCY_MAX),
    adBoostUntil: num(raw.adBoostUntil, GAME_LIMITS.epochMs),
    luckyCredits: int(raw.luckyCredits, GAME_LIMITS.luckyCredits),
    tickets: int(raw.tickets, GAME_LIMITS.tickets),
    lures: int(raw.lures, 999),
    potions,
    recordPaid: int(raw.recordPaid, 1e6),
    indexPaid,
    titles,
    stats: {
      throws: num(stats.throws, CURRENCY_MAX),
      catches: num(stats.catches, CURRENCY_MAX),
      fused: num(stats.fused, CURRENCY_MAX),
      bestOdds: num(stats.bestOdds, CURRENCY_MAX),
      earned: num(stats.earned, CURRENCY_MAX),
      bestDist: num(stats.bestDist, 1e6),
      bestStreak: int(stats.bestStreak, 1e9),
      bestVariant: int(stats.bestVariant, GAME_LIMITS.variant),
      bestRarity: int(stats.bestRarity, 63, -1),
      bestArea: int(stats.bestArea, GAME_LIMITS.areas, -1),
    },
    lastSeen: num(raw.lastSeen, GAME_LIMITS.epochMs),
  };
}
