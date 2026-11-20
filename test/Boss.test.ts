import assert from "assert";

import { bossView, bossWindow, feedBoss, newBoss } from "../src/boss.js";
import { BOSS_AT_MIN, BOSS_LENGTH_MIN, BOSS_NEED_PER_PLAYER } from "../src/constants.js";

const MIN = 60_000;
const hour = Date.UTC(2026, 10, 20, 10, 0, 0);

describe("hungry giant", () => {
  it("visits at the scheduled minutes for her length, and not between", () => {
    const at = hour + BOSS_AT_MIN[0] * MIN;
    assert.strictEqual(bossWindow(at - 1), null);
    assert.deepStrictEqual(bossWindow(at), { key: at, endsAt: at + BOSS_LENGTH_MIN * MIN });
    assert.strictEqual(bossWindow(at + BOSS_LENGTH_MIN * MIN - 1)?.key, at);
    assert.strictEqual(bossWindow(at + BOSS_LENGTH_MIN * MIN), null);
    assert.strictEqual(bossWindow(hour + BOSS_AT_MIN[1] * MIN + MIN)?.key, hour + BOSS_AT_MIN[1] * MIN);
  });

  it("needs bites per player, counts each thrower and is won once", () => {
    const b = newBoss(1, 2, 2);
    assert.strictEqual(b.need, BOSS_NEED_PER_PLAYER * 2);
    let wins = 0;
    for (let i = 0; i < b.need + 5; i++) if (feedBoss(b, i % 3 === 0 ? "a" : "b")) wins++;
    assert.strictEqual(wins, 1);
    assert.ok(b.won);
    assert.strictEqual(b.fill, b.need, "bites after she is full do not count");
    assert.strictEqual((b.throws.get("a") ?? 0) + (b.throws.get("b") ?? 0), b.need);
    assert.deepStrictEqual(bossView(b, true), { key: 1, on: true, fill: b.need, need: b.need, won: true, endsAt: 2 });
  });

  it("an empty room still needs one player's worth", () => {
    assert.strictEqual(newBoss(1, 2, 0).need, BOSS_NEED_PER_PLAYER);
  });
});
