import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { ROOM_MAX_CLIENTS } from "../src/constants.js";
import { __setRoomReporterFetchForTest, reportRoomsOnce } from "../src/legion-room-reporter.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("room reporter (Open Rooms)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  let calls: { url: string; headers: Record<string, string>; body: any }[];
  const env = { ...process.env };
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    calls = [];
    __setRoomReporterFetchForTest((async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as any;
    }) as any);
    process.env.MATCHMAKER_REPORT_URL = "https://matchmaker.test/v1/report/";
    process.env.BLOXITY_REPORT_TOKEN = "tok";
    process.env.BLOXITY_GAME_ID = "throw-food-for-baddies";
    process.env.POD_NAME = "pod-1";
  });
  afterEach(() => {
    __setRoomReporterFetchForTest(null);
    for (const k of ["MATCHMAKER_REPORT_URL", "BLOXITY_REPORT_TOKEN", "BLOXITY_GAME_ID", "POD_NAME"]) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  });

  it("posts the pod's rooms with their player counts and size (one player per base)", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(100);
    assert.strictEqual(await reportRoomsOnce(), true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://matchmaker.test/v1/report/throw-food-for-baddies/rooms");
    assert.strictEqual(calls[0].headers.authorization, "Bearer tok");
    const body = calls[0].body;
    assert.strictEqual(body.podName, "pod-1");
    const mine = body.rooms.find((r: any) => r.colyseusRoomId === room.roomId);
    assert.ok(mine, "the room is listed");
    assert.deepStrictEqual([mine.name, mine.clients, mine.maxClients, mine.locked, mine.private], ["world", 1, ROOM_MAX_CLIENTS, false, false]);
  });

  it("does nothing without the matchmaker URL, token and game id", async () => {
    await colyseus.createRoom<WorldState>("world", {});
    for (const k of ["MATCHMAKER_REPORT_URL", "BLOXITY_REPORT_TOKEN", "BLOXITY_GAME_ID"]) {
      const saved = process.env[k];
      delete process.env[k];
      assert.strictEqual(await reportRoomsOnce(), false, `without ${k}`);
      process.env[k] = saved;
    }
    assert.strictEqual(calls.length, 0);
  });

  it("survives a failing matchmaker", async () => {
    __setRoomReporterFetchForTest((async () => {
      throw new Error("down");
    }) as any);
    assert.strictEqual(await reportRoomsOnce(), false);
  });
});
