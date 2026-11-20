import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { INVITES_MAX, GAME_SLUG, BASE_COUNT, DISTANCE_MAX, GUEST_ID_PREFIX, LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, RECONNECT_SECONDS, ROOM_MAX_CLIENTS } from "../constants.js";
import { pickBase } from "../bases.js";
import { sanitizeGame } from "../game.js";
import { resolveIdentity } from "../auth.js";
import { reportProgress } from "../reporter.js";
import { AD_PLACEMENT_PATTERN, verifyAdReward, verifyBase } from "../ads.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { accrue, rollWedge, spinStateFrom, type SpinState } from "../spin.js";
import { claimDaily, dailyFields, dailyView, readDaily, rollDaily, type DailyState } from "../daily.js";
import { bossView, bossWindow, feedBoss, newBoss, type BossState } from "../boss.js";
import { applyAvatar, applyLoadout, applyPen, applyPose, cleanEmote, cleanThrow } from "../presence.js";
import { ranksOf, topBoards } from "../leaderboard.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username })`. Loads and
 * saves each signed-in player's progress (MongoDB, see db.ts) -- the client keeps no save of its
 * own, so this is the only place progress lives. The game is client-authoritative: no gameplay
 * rules live here, saves are only bounded (sanitize.ts). The room is exactly as big as the hub has
 * bases (maxClients = BASE_COUNT) and every player is assigned one (`PlayerState.base`); full rooms
 * spill into a fresh one automatically.
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // sessionId -> Spin wheel state (spin.ts), set once the session's save has been read. Kept for
  // guests and serverless sessions too (it then lasts the connection).
  private spinStates = new Map<string, SpinState>();
  // sessionId -> Daily Reward state (daily.ts), read with the save. Guests and serverless sessions
  // keep theirs here only (like the rest of their progress, it lasts the session).
  private dailies = new Map<string, DailyState>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // The personal best only ever goes up ($max), so a stale or replayed save can't lower it.
      const { bestDistance, ...rest } = patch;
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", updatedAt: new Date() },
            ...(bestDistance !== undefined && { $max: { bestDistance } }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Throw Food for Baddies' whole progress (game.ts), debounced client-side. The only save the game
    // has: nothing is kept in the browser. Ignored until this session's load has answered (a save
    // sent first would overwrite the stored progress with a fresh player's), and for guests.
    saveGame: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const game = sanitizeGame(msg);
      if (!p || !game || !this.loaded.has(client.sessionId)) return;
      const userId = this.userIds.get(client.sessionId);
      const players = getPlayers();
      if (!userId || !players) return;
      try {
        await players.updateOne(
          { _id: userId },
          {
            // The plaza / Bloxity boards rank these (copied out of the save so they can be indexed).
            $set: { game, bestOdds: game.stats.bestOdds, catches: game.stats.catches, income: game.income, username: p.username || "Player", updatedAt: new Date() },
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
        if (this.verified.has(client.sessionId)) reportProgress(userId, { bestOdds: game.stats.bestOdds, catches: game.stats.catches, income: game.income });
      } catch (err) {
        console.warn("[WorldRoom] saveGame failed", err);
      }
    },
    // A rewarded ad finished: { placement, rewardToken, apiUrl }. Bloxity verifies the token (once,
    // this game only, within 5 minutes); only then does the client grant the reward. Answers
    // `adResult` { ok, placement, reason? }.
    adReward: async (client: Client, msg: { placement?: unknown; rewardToken?: unknown; apiUrl?: unknown }) => {
      const placement = typeof msg?.placement === "string" && AD_PLACEMENT_PATTERN.test(msg.placement) ? msg.placement : "";
      if (!placement || !this.state.players.has(client.sessionId)) return client.send("adResult", { ok: false, placement, reason: "placement" });
      const verdict = await verifyAdReward(verifyBase(msg?.apiUrl), GAME_SLUG, msg?.rewardToken);
      try {
        client.send("adResult", { ok: verdict.valid, placement, reason: verdict.reason });
      } catch {
        // Gone meanwhile.
      }
    },
    // Claims Daily Reward day `msg.day` (0-based). The server decides: answers `dailyResult`
    // { ok, day, ...state }; the client only grants the reward on ok.
    claimDaily: async (client: Client, msg: { day?: unknown }) => {
      const s = this.dailies.get(client.sessionId);
      const day = msg?.day;
      if (!s || !this.loaded.has(client.sessionId)) return client.send("dailyResult", { ok: false, day, reason: "loading" });
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s); // midnight passed while online
      if (!claimDaily(s, day)) return client.send("dailyResult", { ok: false, day, reason: "locked", ...dailyView(s) });
      if (!(await this.saveDaily(client.sessionId, s))) {
        s.claimed = s.claimed.filter((i) => i !== day); // not stored: not claimed
        return client.send("dailyResult", { ok: false, day, reason: "save", ...dailyView(s) });
      }
      client.send("dailyResult", { ok: true, day, ...dailyView(s) });
    },
    // The client's countdown reached the next UTC day: unlock it (server clock) and answer `daily`.
    dailyRefresh: (client: Client) => {
      const s = this.dailies.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return;
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s);
      client.send("daily", dailyView(s));
    },
    // Spin wheel: uses one spin and rolls the prize here, so the client can't choose it. Answers
    // `spinResult` { ok, id (SPIN_WEDGES id), spins, nextAt, serverTime } or { ok: false, reason }.
    spin: async (client: Client) => {
      const s = this.spinStates.get(client.sessionId);
      if (!s) return client.send("spinResult", { ok: false, reason: "loading" });
      const now = Date.now();
      accrue(s, now);
      if (s.spins < 1) return client.send("spinResult", { ok: false, reason: "none", ...this.spinView(s, now) });
      s.spins--;
      accrue(s, now); // dropping below the cap starts the free-spin clock
      const wedge = rollWedge();
      client.send("spinResult", { ok: true, id: wedge.id, ...this.spinView(s, now) });
      await this.saveSpins(client.sessionId, s);
    },
    // The sender's race, relayed through the roster so everyone draws them on the distance bar and
    // podium: { racing, distance (studs this race) }, a few times a second while racing.
    race: (client: Client, msg: { racing?: unknown; distance?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.racing = msg?.racing === true;
      const d = msg?.distance;
      p.distance = p.racing && typeof d === "number" && Number.isFinite(d) ? Math.min(DISTANCE_MAX, Math.max(0, d)) : 0;
    },
    // Presence (presence.ts): the sender's pose ~10x/s, its equipped gear and its Bloxity look,
    // relayed through the roster so everyone draws them in the world (client remotePlayers.js).
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    // The base's placed baddies (presence.ts applyPen): everyone draws them in that player's pen.
    pen: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPen(p, msg);
    },
    // A throw, replayed by the others: the food's flight down the lane (presence.ts cleanThrow).
    throw: (client: Client, msg: unknown) => {
      const e = cleanThrow(msg);
      if (!e || !this.state.players.has(client.sessionId)) return;
      this.broadcast("throwFx", { sid: client.sessionId, ...e }, { except: client });
      // The Hungry Giant (boss.ts): every throw while she is here feeds her.
      this.tickBoss(Date.now());
      if (this.boss && this.bossOn) {
        const full = feedBoss(this.boss, client.sessionId);
        this.broadcast("boss", bossView(this.boss, true));
        if (full) this.broadcast("bossWin", { key: this.boss.key, throws: Object.fromEntries(this.boss.throws) });
      }
    },
    // A Bloxity emote the sender started ("" = stopped), replayed on their avatar by the others.
    emote: (client: Client, msg: unknown) => {
      const id = cleanEmote(msg);
      if (id !== null && this.state.players.has(client.sessionId)) this.broadcast("emoteFx", { sid: client.sessionId, id }, { except: client });
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: async (client: Client, msg: { token?: string; username?: string; userId?: string; pfp?: string; ref?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      // The account comes from the Bloxity token (auth.ts), never from a user id the client sends.
      const id = await resolveIdentity(msg);
      if (this.state.players.get(client.sessionId) !== p) return; // left meanwhile
      p.username = id.username || (typeof msg?.username === "string" ? sanitizeName(msg.username) : p.username);
      p.pfp = id.pfp || (typeof msg?.pfp === "string" ? sanitizePfp(msg.pfp) : p.pfp);
      this.setVerified(client.sessionId, id.verified);
      this.setRef(client.sessionId, msg?.ref);
      this.setUserId(client, p, id.userId);
    },
  };

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads.
  onCreate() {
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
    this.clock.setInterval(() => this.tickBoss(Date.now()), 1000);
  }

  // The Hungry Giant's visit (boss.ts): starts and ends on the UTC clock; `boss` goes to everyone
  // when she arrives or leaves (and after every bite, see the `throw` handler).
  boss: BossState | null = null;
  bossOn = false;
  tickBoss(now: number) {
    const w = bossWindow(now);
    if (w && this.boss?.key !== w.key) {
      this.boss = newBoss(w.key, w.endsAt, this.clients.length);
      this.bossOn = true;
      this.broadcast("boss", bossView(this.boss, true));
    } else if (!w && this.bossOn) {
      this.bossOn = false;
      this.broadcast("boss", bossView(this.boss, false));
    }
  }

  // `leaderboard` { boards: { rebirths|trophies|energy|playtime: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  async onJoin(client: Client, options?: { ref?: string; token?: string; username?: string; userId?: string; pfp?: string; base?: number; pose?: unknown; loadout?: unknown; avatar?: string }) {
    const p = new PlayerState();
    // One base per player: the lowest free one, or the one a rejoining player asks for (`options.base`)
    // when it is still free. Bases are freed in forgetSession, so a seat held for a reconnection
    // keeps its base. maxClients === BASE_COUNT, so a free base always exists here.
    const taken: number[] = [];
    this.state.players.forEach((o) => taken.push(o.base));
    p.base = pickBase(taken, options?.base);
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options);
    applyPen(p, (options as { pen?: unknown } | undefined)?.pen);
    this.state.players.set(client.sessionId, p);
    // Tell the newcomer their base straight away (the roster carries it for everyone else).
    client.send("welcome", { base: p.base, bases: BASE_COUNT });
    // And whether the Hungry Giant is here right now.
    this.tickBoss(Date.now());
    if (this.bossOn) client.send("boss", bossView(this.boss, true));
    // Who this really is: the Bloxity token is verified with Bloxity (auth.ts); a user id the client
    // sends is only believed in local development. Everything above ran synchronously, so the
    // base is already taken while this waits.
    const id = await resolveIdentity(options);
    if (this.state.players.get(client.sessionId) !== p) return; // left while verifying
    if (id.username) p.username = id.username;
    if (id.pfp) p.pfp = id.pfp;
    this.setVerified(client.sessionId, id.verified);
    this.setRef(client.sessionId, options?.ref);
    this.setUserId(client, p, id.userId);
  }

  // Sessions whose account Bloxity verified: only these appear on Bloxity's leaderboards.
  // sessionId -> the account whose invite link opened the game (`?ref=`), kept for verified players only.
  private refs = new Map<string, string>();
  private setRef(sessionId: string, raw: unknown) {
    if (typeof raw === "string" && raw && raw.length <= 128 && this.verified.has(sessionId)) this.refs.set(sessionId, raw);
    else this.refs.delete(sessionId);
  }

  // Friend invite: a Bloxity-verified player who is NEW to the game and opened it through someone's
  // invite link (`?ref=<inviter's account id>`) counts once for that inviter (their `invites`), which
  // gives the inviter an income boost. The invitee's document is created first with `invitedBy`
  // (an upsert that only inserts), so each account can only ever be credited once, and the inviter
  // must already exist (no upsert) and cannot be the invitee.
  private async creditInvite(inviteeId: string, ref: string): Promise<void> {
    const players = getPlayers();
    if (!players || !ref || ref === inviteeId) return;
    try {
      const made = await players.updateOne({ _id: inviteeId }, { $setOnInsert: { invitedBy: ref, version: 1, updatedAt: new Date() } }, { upsert: true });
      if (!made.upsertedCount) return; // already known: not a new player
      const inc = await players.updateOne({ _id: ref }, { $inc: { invites: 1 } });
      if (!inc.matchedCount) return; // no such inviter
      // The inviter, if they are in this room, hears about it at once (others get it on their next load).
      for (const [sid, uid] of this.userIds) {
        if (uid !== ref) continue;
        const doc = await players.findOne({ _id: ref });
        const c = this.clients.find((x) => x.sessionId === sid);
        if (c) c.send("invites", { invites: Math.min(INVITES_MAX, Number(doc?.invites) || 0) });
      }
    } catch (err) {
      console.warn("[WorldRoom] creditInvite failed", err);
    }
  }

  private verified = new Set<string>();
  private setVerified(sessionId: string, on: boolean) {
    if (on) this.verified.add(sessionId);
    else this.verified.delete(sessionId);
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.verified.delete(sessionId);
    this.refs.delete(sessionId);
    this.dailies.delete(sessionId);
    this.spinStates.delete(sessionId);
  }

  private spinView(s: SpinState, now: number) {
    return { spins: s.spins, nextAt: s.nextAt, serverTime: now };
  }

  // The spin fields go straight to Mongo (saveProgress never carries them).
  private async saveSpins(sessionId: string, s: SpinState) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { spins: s.spins, spinAt: s.nextAt, updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
    } catch (err) {
      console.warn("[WorldRoom] saveSpins failed", err);
    }
  }

  // Stores a session's Daily Reward state. True when stored, or when there is nowhere to store it
  // (guest / no database: it lives in `dailies` for the session).
  private async saveDaily(sessionId: string, s: DailyState): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { ...dailyFields(s), updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveDaily failed", err);
      return false;
    }
  }

  // Client-trusted Bloxity user id (guest ids are dropped, see GUEST_ID_PREFIX). A forged id can
  // only read/overwrite the SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, 128);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    this.spinStates.delete(client.sessionId); // nor spins
    p.signedIn = !!userId;
    p.uid = userId; // public Bloxity id: lets the others match this player's chat bubbles

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    const spin = spinStateFrom(doc, now);
    this.spinStates.set(client.sessionId, spin);
    const sid = client.sessionId;
    const ref = this.refs.get(sid);
    if (!doc && userId && players && ref && this.verified.has(sid)) await this.creditInvite(userId, ref);
    if (this.state.players.get(client.sessionId) !== p) return; // left while the invite was credited
    client.send("game", { game: doc?.game ?? null, invites: Math.min(INVITES_MAX, Number(doc?.invites) || 0), serverTime: now });
    if (!doc) client.send("noProgress", { serverTime: now });
    else client.send("progress", { ...(sanitizeProgress(doc) ?? {}), serverTime: now });
    client.send("spins", this.spinView(spin, now));

    // Daily Reward: today's day unlocks on join (server clock), then the client gets the calendar.
    const daily = readDaily(doc);
    this.dailies.set(client.sessionId, daily);
    if (rollDaily(daily)) await this.saveDaily(client.sessionId, daily);
    if (this.dailies.get(client.sessionId) === daily) client.send("daily", dailyView(daily));
    void this.sendLeaderboard(client);
  }
}
