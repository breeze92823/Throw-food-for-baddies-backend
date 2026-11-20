import { AVATAR_MAX_LEN, CURRENCY_MAX, ID_PATTERN, PEN_MAX, POSE_BOUNDS, PRESENCE_PETS_MAX, PET_TIERS_MAX } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player in the world (client remotePlayers.js).
// Relayed through the roster as sent, only bounded here -- like the rest of the game it is
// client-authoritative and purely cosmetic.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// `pose` { x, y, z, yaw, speed }: the boat's feet position in TRACK coordinates (z minus the
// sender's race scroll, so racers line up in everyone's lane), heading (rad) and speed (m/s).
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xy, b.xy);
  if (finite(m.y)) p.y = clamp(m.y, -b.xy, b.xy);
  if (finite(m.z)) p.z = clamp(m.z, -b.z, b.xy);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
  // Throw Food for Baddies: animation inputs and what the player holds.
  if (typeof m.grounded === "boolean") p.grounded = m.grounded;
  if (finite(m.vy)) p.vy = clamp(m.vy, -200, 200);
  if (finite(m.arm)) {
    p.arm = clamp(m.arm, -6, 6);
    p.armOn = true;
  } else if (m.arm === null) p.armOn = false;
  if (finite(m.lean)) p.lean = clamp(m.lean, -1, 1);
  if (m.act === "" || m.act === "aim" || m.act === "train") p.act = m.act;
  if (m.food === "" || isId(m.food)) p.food = m.food as string;
  if (m.carry === "" || isBaddieRef(m.carry)) p.carry = m.carry as string;
  if (finite(m.income)) p.income = clamp(m.income, 0, CURRENCY_MAX);
}

// "baddieId:size" (client config BADDIES ids, SIZES index).
const isBaddieRef = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  const [id, size, ...rest] = v.split(":");
  return rest.length === 0 && ID_PATTERN.test(id) && /^[0-9]$/.test(size ?? "");
};

// `pen` { list: [{ id, size }] }: the base's placed baddies as "id:size,id:size", capped at
// PEN_MAX entries (the client's ECONOMY.maxCapacity).
export function applyPen(p: PlayerState, msg: unknown): void {
  const list = (msg as { list?: unknown })?.list;
  if (!Array.isArray(list)) return;
  const out: string[] = [];
  for (const e of list) {
    if (out.length >= PEN_MAX) break;
    const id = (e as { id?: unknown })?.id;
    const size = (e as { size?: unknown })?.size;
    const v = (e as { v?: unknown })?.v; // variant (client VARIANTS), 0 = plain
    const vs = Number.isInteger(v) && (v as number) > 0 && (v as number) <= 9 ? `:${v}` : "";
    if (isId(id) && Number.isInteger(size) && (size as number) >= 0 && (size as number) <= 9) out.push(`${id}:${size}${vs}`);
  }
  p.pen = out.join(",");
}

// A throw as the others replay it: `throw` { food, from, to, dur, peak, power, lucky }, bounded.
// Returns the sanitized event, or null when it is not a throw.
export function cleanThrow(msg: unknown) {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const vec = (v: unknown) => {
    const o = v as { x?: unknown; y?: unknown; z?: unknown } | null;
    if (!o || !finite(o.x) || !finite(o.y) || !finite(o.z)) return null;
    const b = POSE_BOUNDS;
    return { x: clamp(o.x, -b.xy, b.xy), y: clamp(o.y, -b.xy, b.xy), z: clamp(o.z, -b.xy, b.xy) };
  };
  const from = vec(m.from);
  const to = vec(m.to);
  if (!from || !to || !isId(m.food) || !finite(m.dur) || !finite(m.peak)) return null;
  return {
    food: m.food,
    from,
    to,
    dur: clamp(m.dur, 0.2, 12),
    peak: clamp(m.peak, 0, 60),
    power: finite(m.power) ? clamp(m.power, 0, 1) : 1,
    lucky: m.lucky === true,
  };
}

// An emote id from the Bloxity catalogue (opaque string) or "" to stop.
export function cleanEmote(msg: unknown): string | null {
  const id = (msg as { id?: unknown })?.id;
  if (id === "" || (typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id))) return id as string;
  return null;
}

// `loadout` { boat, engine, trail, partner, pets: [{ kind, tier }], world }: equipped catalog ids
// ("" = none) and the world the player is in (clients only draw players in their own world). Pets travel as "kind:tier" joined by commas, capped at PRESENCE_PETS_MAX.
export function applyLoadout(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  for (const key of ["boat", "engine", "trail", "partner", "world"] as const) {
    const v = m[key];
    if (v === "" || isId(v)) p[key] = v as string;
  }
  if (Array.isArray(m.pets)) {
    const pets: string[] = [];
    for (const pet of m.pets) {
      if (pets.length >= PRESENCE_PETS_MAX) break;
      const k = (pet as { kind?: unknown })?.kind;
      const t = (pet as { tier?: unknown })?.tier;
      if (isId(k) && Number.isInteger(t) && (t as number) >= 0 && (t as number) < PET_TIERS_MAX) pets.push(`${k}:${t}`);
    }
    p.pets = pets.join(",");
  }
}

// `setAvatar` { avatar }: the Bloxity look as an opaque JSON string ("" = default), length-capped.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const a = (msg as { avatar?: unknown })?.avatar;
  if (typeof a === "string" && a.length <= AVATAR_MAX_LEN) p.avatar = a;
}
