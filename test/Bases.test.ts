import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { pickBase } from "../src/bases.js";
import { BASE_COUNT, ROOM_MAX_CLIENTS } from "../src/constants.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("bases", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("sizes the room to the number of bases", () => {
    assert.strictEqual(ROOM_MAX_CLIENTS, BASE_COUNT);
  });

  it("picks the lowest free base, or a free preferred one", () => {
    assert.strictEqual(pickBase([]), 0);
    assert.strictEqual(pickBase([0, 1, 3]), 2);
    assert.strictEqual(pickBase([0, 1], 4), 4, "a free preferred base wins");
    assert.strictEqual(pickBase([0, 4], 4), 1, "a taken preferred base falls back to the lowest free one");
    assert.strictEqual(pickBase([], 99), 0, "an out-of-range preference is ignored");
    assert.strictEqual(pickBase([], "2"), 0, "a non-number preference is ignored");
    assert.strictEqual(pickBase([0, 1, 2, 3, 4]), -1, "no base left");
  });

  it("gives every player their own base and frees it when they leave", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    assert.strictEqual(room.maxClients, BASE_COUNT);

    const clients = [];
    for (let i = 0; i < BASE_COUNT; i++) clients.push(await colyseus.connectTo(room, { userId: `guest-${i}`, username: `P${i}` }));
    await sleep(50);
    const bases = clients.map((c) => room.state.players.get(c.sessionId)!.base).sort();
    assert.deepStrictEqual(bases, Array.from({ length: BASE_COUNT }, (_, i) => i), "each base is used exactly once");

    // The room is full: a further player has to be placed in another room, which has its own bases.
    const extra = await colyseus.sdk.joinOrCreate<WorldState>("world", { userId: "guest-extra", username: "Extra" });
    assert.notStrictEqual(extra.roomId, room.roomId);
    await extra.leave();

    // Leaving frees the base: the next newcomer takes it.
    const leaver = clients[2];
    const freed = room.state.players.get(leaver.sessionId)!.base;
    await leaver.leave(true);
    await sleep(100);
    const next = await colyseus.connectTo(room, { userId: "guest-next", username: "Next" });
    await sleep(50);
    assert.strictEqual(room.state.players.get(next.sessionId)!.base, freed);
  });

  it("honours a free preferred base (a rejoining player)", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", username: "A", base: 3 });
    await sleep(50);
    assert.strictEqual(room.state.players.get(a.sessionId)!.base, 3);

    const b = await colyseus.connectTo(room, { userId: "guest-b", username: "B", base: 3 });
    await sleep(50);
    assert.strictEqual(room.state.players.get(b.sessionId)!.base, 0, "a taken preference falls back to the lowest free base");
  });
});
