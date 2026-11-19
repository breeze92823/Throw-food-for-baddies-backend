import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    base: t.int8().default(-1), // index of the base (pen) assigned to this player, 0..BASE_COUNT-1 (-1 = none yet)
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none), for the others' racer heads
    racing: t.boolean().default(false), // in a race right now (`race` message)
    distance: t.float64().default(0), // this race's distance so far, studs
    // Presence (presence.ts, `pose` / `loadout` / `setAvatar`): what the others draw in the world.
    x: t.float64().default(0), // feet position in track coordinates (z minus the race scroll)
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float32().default(0), // heading, rad (PI = facing the gate)
    speed: t.float32().default(0), // m/s, for flames and dead reckoning
    boat: t.string().default(""), // equipped catalog ids (client config.js), "" = none / default
    engine: t.string().default(""),
    trail: t.string().default(""),
    partner: t.string().default(""),
    pets: t.string().default(""), // equipped pets "kind:tier,kind:tier"
    world: t.string().default(""), // the world the player is in (client WORLDS id), "" = the start world
    avatar: t.string().default(""), // Bloxity look JSON { equipped, proportions, skin }, "" = default
    // Throw Food for Baddies presence (presence.ts): what the others draw of this player.
    uid: t.string().default(""), // Bloxity user id ("" = guest), so chat bubbles find their player
    grounded: t.boolean().default(true),
    vy: t.float32().default(0), // vertical speed, m/s (jump / fall animation)
    arm: t.float32().default(0), // right-arm raise (rad) while aiming / carrying; only read when armOn
    armOn: t.boolean().default(false),
    lean: t.float32().default(0), // body lean while throwing, rad
    act: t.string().default(""), // "" | "aim" (on the throw band, food in hand) | "train" (pull-up bar)
    food: t.string().default(""), // equipped food id (the one held up while aiming)
    carry: t.string().default(""), // "baddieId:size" carried in the arms ("" = none)
    income: t.float64().default(0), // money per second of the base (its sign)
    pen: t.string().default(""), // the base's placed baddies, "id:size,id:size" (capped)
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
