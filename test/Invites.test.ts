import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { __setVerifierForTest } from "../src/auth.js";
import { __setPlayersForTest } from "../src/db.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const accounts: Record<string, string> = { tokA: "inviter", tokB: "newbie", tokC: "veteran" };
const verifier = async (token: string) => (accounts[token] ? { userId: accounts[token], username: accounts[token], pfp: "", verified: true } : null);
const stored = (id: string, extra: object = {}) => ({ _id: id, version: 1, updatedAt: new Date(), ...extra }) as any;

describe("friend invites", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    __setVerifierForTest(verifier);
  });
  afterEach(() => {
    __setVerifierForTest(null);
    __setPlayersForTest(null);
  });

  it("credits the inviter once when a new verified player opens their link, and tells them live", async () => {
    const fake = fakePlayers([stored("inviter", { invites: 2 })]);
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { token: "tokA" });
    let invitesMsg: any = null;
    let aGame: any = null;
    a.onMessage("invites", (m: any) => (invitesMsg = m));
    a.onMessage("game", (m: any) => (aGame = m));
    await sleep(150);

    const b = await colyseus.connectTo(room, { token: "tokB", ref: "inviter" });
    let bGame: any = null;
    b.onMessage("game", (m: any) => (bGame = m));
    await sleep(250);
    assert.strictEqual((fake.docs.get("inviter") as any).invites, 3);
    assert.strictEqual((fake.docs.get("newbie") as any).invitedBy, "inviter");
    assert.deepStrictEqual(invitesMsg, { invites: 3 }, "the inviter in the room hears at once");
    void aGame;
    void bGame;

    // The same account coming back through the link again is not counted twice.
    await b.leave(true);
    await sleep(100);
    const b2 = await colyseus.connectTo(room, { token: "tokB", ref: "inviter" });
    b2.onMessage("game", () => {});
    await sleep(250);
    assert.strictEqual((fake.docs.get("inviter") as any).invites, 3);
  });

  it("does not credit existing players, self invites, guests or unknown inviters", async () => {
    const fake = fakePlayers([stored("inviter", { invites: 0 }), stored("veteran", { game: { money: 5 } })]);
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const vet = await colyseus.connectTo(room, { token: "tokC", ref: "inviter" });
    vet.onMessage("game", () => {});
    const self = await colyseus.connectTo(room, { token: "tokA", ref: "inviter" });
    self.onMessage("game", () => {});
    const guest = await colyseus.connectTo(room, { userId: "guest-x", ref: "inviter" });
    guest.onMessage("game", () => {});
    const ghost = await colyseus.connectTo(room, { token: "tokB", ref: "nobody" });
    ghost.onMessage("game", () => {});
    await sleep(300);
    assert.strictEqual((fake.docs.get("inviter") as any).invites, 0);
    assert.ok(!(fake.docs.get("veteran") as any).invitedBy, "an existing player does not count");
    assert.ok(!fake.docs.has("nobody"), "an unknown inviter is never created");
  });

  it("sends the saved invite count with the game", async () => {
    const fake = fakePlayers([stored("inviter", { invites: 4 })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { token: "tokA" });
    let got: any = null;
    a.onMessage("game", (m: any) => (got = m));
    fake.release();
    await sleep(200);
    assert.strictEqual(got?.invites, 4);
  });
});
