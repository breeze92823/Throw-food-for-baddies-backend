import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { AD_PLACEMENT_PATTERN, verifyAdReward, verifyBase } from "../src/ads.js";
import { __setPlayersForTest } from "../src/db.js";
import { sanitizeGame } from "../src/game.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("game save", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("bounds a save and drops junk", () => {
    assert.strictEqual(sanitizeGame("nope"), null);
    const g = sanitizeGame({
      money: -5,
      strength: 1e99,
      foods: ["apple", "bad id!", "apple", "cake"],
      food: "cake",
      upgrades: { cash: 3.7, "bad id": 4 },
      baddies: [{ uid: 1, id: "meadow_honey", size: 1 }, { uid: 2, id: "x", size: 99 }, "junk"],
      hotbar: [{ id: "farm_cinna", size: 0 }],
      discovered: { meadow_honey: true, "bad id": true },
      quests: { catch5: true },
      train: { level: 0, xp: 5, reps: 2 },
      stats: { throws: 4, evil: 1 },
      hacked: true,
    })!;
    assert.strictEqual(g.money, 0);
    assert.ok(g.strength <= 1e33);
    assert.deepStrictEqual(g.foods, ["apple", "cake"]);
    assert.deepStrictEqual(g.upgrades, { cash: 3 });
    assert.deepStrictEqual(g.baddies, [{ uid: 1, id: "meadow_honey", size: 1 }]);
    assert.deepStrictEqual(g.discovered, { meadow_honey: true });
    assert.strictEqual(g.train.level, 1, "level is at least 1");
    assert.ok(!("hacked" in g) && !("evil" in g.stats));
  });

  it("sends a saved player their game and stores what they send back, never for a guest", async () => {
    const saved = sanitizeGame({ money: 1234, foods: ["apple"], food: "apple", baddies: [{ uid: 1, id: "meadow_honey", size: 0 }] });
    const fake = fakePlayers([{ _id: "u1", game: saved!, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    let got: any = undefined;
    c.onMessage("game", (m: any) => (got = m));
    fake.release();
    await sleep(150);
    assert.strictEqual(got?.game?.money, 1234);
    assert.strictEqual(got?.game?.baddies[0].id, "meadow_honey");

    c.send("saveGame", { money: 9999, foods: ["apple", "pie"], food: "pie", baddies: [], stats: { catches: 7 } });
    await sleep(150);
    const doc = fake.docs.get("u1") as any;
    assert.strictEqual(doc.game.money, 9999);
    assert.strictEqual(doc.game.food, "pie");
    assert.strictEqual(doc.game.stats.catches, 7);
    assert.strictEqual(doc.username, "Ann");

    const guest = await colyseus.connectTo(room, { userId: "guest-zzz" });
    await sleep(150);
    guest.send("saveGame", { money: 1 });
    await sleep(100);
    assert.strictEqual(fake.docs.size, 1, "a guest is never stored");
  });

  it("ignores a save sent before the load answered", async () => {
    const fake = fakePlayers([{ _id: "u2", game: sanitizeGame({ money: 500 })!, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u2" });
    c.send("saveGame", { money: 1 }); // the load has not been released yet
    await sleep(100);
    assert.strictEqual((fake.docs.get("u2") as any).game.money, 500, "the stored progress is not overwritten");
    fake.release();
    await sleep(100);
  });
});

describe("rewarded ads", () => {
  it("only verifies against a bloxity.io host and checks the token", async () => {
    assert.strictEqual(verifyBase("https://api.stage.bloxity.io/x", ""), "https://api.stage.bloxity.io");
    assert.strictEqual(verifyBase("https://evil.example.com", ""), "https://api.bloxity.io");
    assert.strictEqual(verifyBase("http://api.bloxity.io", ""), "https://api.bloxity.io", "https only");
    assert.strictEqual(verifyBase("https://evil.example.com", "https://api.bloxity.io/"), "https://api.bloxity.io");
    assert.ok(AD_PLACEMENT_PATTERN.test("double-income") && !AD_PLACEMENT_PATTERN.test("under_score"));

    assert.deepStrictEqual(await verifyAdReward("https://x", "g", "short"), { valid: false, reason: "token" });
    let sent: any = null;
    const ok = await verifyAdReward("https://api.bloxity.io", "throw-food-for-baddies", "a-long-enough-token", async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ valid: true, userId: "u1" }) };
    });
    assert.strictEqual(ok.valid, true);
    assert.strictEqual(sent.url, "https://api.bloxity.io/v1/ads/reward/verify");
    assert.deepStrictEqual(sent.body, { gameSlug: "throw-food-for-baddies", rewardToken: "a-long-enough-token" });
    const used = await verifyAdReward("https://api.bloxity.io", "g", "a-long-enough-token", async () => ({ ok: true, json: async () => ({ valid: false, reason: "unknown" }) }));
    assert.deepStrictEqual(used, { valid: false, reason: "unknown" });
    const down = await verifyAdReward("https://api.bloxity.io", "g", "a-long-enough-token", async () => {
      throw new Error("offline");
    });
    assert.deepStrictEqual(down, { valid: false, reason: "unreachable" });
  });
});
