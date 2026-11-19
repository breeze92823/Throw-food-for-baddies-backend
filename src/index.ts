import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { connectDb } from "./db.js";
import { installRoomReporter } from "./legion-room-reporter.js";
import { startReporter } from "./reporter.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Listens on PORT (or 2567).
await listen(app);

// On Bloxity hosting (no-ops locally): list this pod's rooms on the game's Bloxity page ("Open Rooms")
// and report verified players' scores to Bloxity's hosted leaderboards.
installRoomReporter();
startReporter();
