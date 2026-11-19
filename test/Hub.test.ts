import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

// What the other players draw in the hub: held items, base contents and relayed throws / emotes.
describe("hub presence", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("relays pose extras, the base's baddies and the Bloxity id, bounded", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", username: "Ann" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;

    a.send("pose", { x: 1, y: 0, z: -29, yaw: 3, speed: 2, grounded: false, vy: 5, arm: -2.85, lean: 0.2, act: "aim", food: "apple", carry: "meadow_honey:1", income: 1234 });
    a.send("pen", { list: [{ id: "meadow_honey", size: 0 }, { id: "farm_cinna", size: 1 }, { id: "bad id!", size: 0 }, { id: "x", size: 99 }] });
    await sleep(50);
    assert.strictEqual(p.grounded, false);
    assert.strictEqual(p.vy, 5);
    assert.strictEqual(p.armOn, true);
    assert.ok(Math.abs(p.arm - -2.85) < 1e-3);
    assert.strictEqual(p.act, "aim");
    assert.strictEqual(p.food, "apple");
    assert.strictEqual(p.carry, "meadow_honey:1");
    assert.strictEqual(p.income, 1234);
    assert.strictEqual(p.pen, "meadow_honey:0,farm_cinna:1", "invalid entries are dropped");

    a.send("pose", { arm: null, act: "bogus", carry: "no way", food: "bad food!" });
    await sleep(50);
    assert.strictEqual(p.armOn, false);
    assert.strictEqual(p.act, "aim", "an unknown act is ignored");
    assert.strictEqual(p.carry, "meadow_honey:1", "a malformed carry is ignored");
    assert.strictEqual(p.food, "apple", "a malformed food id is ignored");
  });

  it("replays a throw and an emote to the others only", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", username: "Ann" });
    const b = await colyseus.connectTo(room, { userId: "guest-b", username: "Bo" });
    const seenByB: any[] = [];
    const seenByA: any[] = [];
    b.onMessage("throwFx", (m) => seenByB.push(m));
    b.onMessage("emoteFx", (m) => seenByB.push(m));
    a.onMessage("throwFx", (m) => seenByA.push(m));
    await sleep(50);

    a.send("throw", { food: "apple", from: { x: 0, y: 2, z: -29 }, to: { x: 1, y: -9, z: -90 }, dur: 2, peak: 99999, power: 5, lucky: true });
    a.send("throw", { food: "bad food", from: {}, to: {}, dur: 1, peak: 1 }); // dropped
    a.send("emote", { id: "000000000000000000000e01" });
    await sleep(100);

    const throws = seenByB.filter((m) => m.food);
    assert.strictEqual(throws.length, 1);
    assert.strictEqual(throws[0].sid, a.sessionId);
    assert.strictEqual(throws[0].peak, 60, "peak is bounded");
    assert.strictEqual(throws[0].power, 1, "power is bounded");
    assert.strictEqual(seenByB.filter((m) => m.id).length, 1);
    assert.strictEqual(seenByA.length, 0, "the sender does not get its own throw back");
  });
});
