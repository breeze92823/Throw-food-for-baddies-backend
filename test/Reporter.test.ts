import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setVerifierForTest, resolveIdentity } from "../src/auth.js";
import { __resetReporterForTest, __setFetchForTest, boardUserId, flushReports, reportProgress } from "../src/reporter.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("bloxity leaderboards + identity", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  let calls: { url: string; auth: string; body: any }[];
  const env = { ...process.env };
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    calls = [];
    __resetReporterForTest();
    __setFetchForTest((async (url: any, init: any) => {
      calls.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, dropped: {} }) } as any;
    }) as any);
    process.env.BLOXITY_REPORT_TOKEN = "tok";
    process.env.BLOXITY_GAME_ID = "throw-food-for-baddies";
    process.env.BLOXITY_API_URL = "https://api.test";
  });
  afterEach(() => {
    __setFetchForTest(null);
    __setVerifierForTest(null);
    __setPlayersForTest(null);
    for (const k of ["BLOXITY_REPORT_TOKEN", "BLOXITY_GAME_ID", "BLOXITY_API_URL", "NODE_ENV"]) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  });

  it("names accounts legion_<id>", () => {
    assert.strictEqual(boardUserId("abc"), "legion_abc");
    assert.strictEqual(boardUserId("legion_abc#m3"), "legion_abc");
  });

  it("reports the changed scores, declaring the boards the first time", async () => {
    reportProgress("abc", { bestOdds: 1.5e6, catches: 12, income: 0 });
    await flushReports();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://api.test/v1/leaderboards/hosted/throw-food-for-baddies/report");
    assert.strictEqual(calls[0].auth, "Bearer tok");
    assert.deepStrictEqual(
      calls[0].body.scores.sort((a: any, b: any) => a.board.localeCompare(b.board)),
      [
        { board: "baddies-caught", userId: "legion_abc", score: 12 },
        { board: "best-pull", userId: "legion_abc", score: 1500000 },
      ],
      "no score for a zero",
    );
    assert.deepStrictEqual(calls[0].body.boards.map((b: any) => b.id), ["best-pull", "baddies-caught", "money-per-second"]);
    reportProgress("abc", { bestOdds: 1.5e6, catches: 13 });
    await flushReports();
    assert.deepStrictEqual(calls[1].body.scores, [{ board: "baddies-caught", userId: "legion_abc", score: 13 }], "only what changed");
    assert.strictEqual(calls[1].body.boards, undefined, "the boards are declared once");
  });

  it("reports a verified player's save, never a guest's", async () => {
    __setVerifierForTest(async (token) => (token === "good" ? { userId: "acc1", username: "Real", pfp: "", verified: true } : null));
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { token: "good" });
    const g = await colyseus.connectTo(room, { token: "forged", userId: "victim" });
    fake.release();
    await sleep(200);
    assert.strictEqual(room.state.players.get(a.sessionId)!.username, "Real", "the name comes from Bloxity");
    assert.strictEqual(room.state.players.get(g.sessionId)!.signedIn, false, "a token that does not verify is a guest, never the client's id");
    a.send("saveGame", { money: 5, stats: { bestOdds: 77, catches: 4 }, income: 9 });
    g.send("saveGame", { money: 5, stats: { bestOdds: 99999 } });
    await sleep(150);
    await flushReports();
    assert.strictEqual((fake.docs.get("acc1") as any).bestOdds, 77);
    assert.ok(!fake.docs.has("victim"), "a forged id is never written");
    const sent = calls.flatMap((c) => c.body.scores);
    assert.deepStrictEqual(sent.map((s: any) => s.userId), ["legion_acc1", "legion_acc1", "legion_acc1"]);
  });

  it("only believes a client-sent id outside production", async () => {
    assert.strictEqual((await resolveIdentity({ userId: "dev-1" })).userId, "dev-1");
    process.env.NODE_ENV = "production";
    assert.strictEqual((await resolveIdentity({ userId: "dev-1" })).userId, "", "production: no token, no account");
  });
});
