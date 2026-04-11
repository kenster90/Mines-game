/**
 * MINES — Firebase Cloud Functions  (Node 20)
 *
 * Deploy:
 *   cd functions
 *   npm install
 *   firebase deploy --only functions
 *
 * These functions are the ONLY thing that may write balanceCents.
 * Firestore rules hard-block all frontend balance writes.
 *
 * Functions:
 *   createUser   — called once at registration
 *   startGame    — deducts bet, stores server seed, returns seedHash
 *   resolveGame  — reveal / cashout / bust — updates balance, returns outcome
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp }      = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();

const GRID_SIZE  = 25;
const HOUSE_EDGE = 0.97;   // 3% house edge
const MAX_BET_CENTS  = 1_000_000;   // 10,000 coins max bet
const START_BALANCE  = 100_000;     // 1,000 coins starting balance (cents)

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive mine positions from a seed string using HMAC-SHA256.
 * Scores every cell and picks the `mineCount` lowest-scoring ones.
 * Deterministic: same seed + mineCount always → same mine positions.
 */
function deriveMines(seed, mineCount) {
  const scores = Array.from({ length: GRID_SIZE }, (_, i) => {
    const hmac = crypto.createHmac("sha256", seed);
    hmac.update(`mine:${i}`);
    const buf = hmac.digest();
    const val = buf.readUInt32BE(0) / 0x100000000;
    return { i, val };
  });
  return scores
    .sort((a, b) => a.val - b.val)
    .slice(0, mineCount)
    .map(x => x.i);
}

/**
 * Multiplier as integer numerator over 10000 (4 dp), floored in house's favour.
 */
function calcMultInt(revealed, mineCount) {
  if (revealed === 0) return 10000;
  const safe = GRID_SIZE - mineCount;
  let num = 1, den = 1;
  for (let i = 0; i < revealed; i++) {
    num *= (GRID_SIZE - i);
    den *= (safe - i);
  }
  return Math.floor((num / den) * HOUSE_EDGE * 10000);
}

function winCents(betCents, revealed, mineCount) {
  return Math.floor(betCents * calcMultInt(revealed, mineCount) / 10000);
}

function sha256hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function assertAuth(context) {
  if (!context.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  return context.auth.uid;
}

// ─────────────────────────────────────────────────────────────────────────────
//  createUser
//  Called once at registration. Creates the Firestore user doc with a locked
//  starting balance. Using a Cloud Function means the initial balance is set
//  server-side and cannot be spoofed.
// ─────────────────────────────────────────────────────────────────────────────
exports.createUser = onCall(async (request) => {
  const uid      = assertAuth(request);
  const { username, email } = request.data;

  if (!username || username.length < 2) throw new HttpsError("invalid-argument", "Username too short.");

  const userRef = db.collection("users").doc(uid);
  const snap    = await userRef.get();
  if (snap.exists) throw new HttpsError("already-exists", "User already exists.");

  const userData = {
    username,
    email,
    balanceCents: START_BALANCE,
    gamesPlayed:  0,
    history:      [],
    createdAt:    FieldValue.serverTimestamp(),
  };
  await userRef.set(userData);
  return userData;
});

// ─────────────────────────────────────────────────────────────────────────────
//  startGame
//  Atomically deducts the bet from the user's balance and writes a pending
//  game document. Returns gameId and seedHash (NOT the raw seed).
// ─────────────────────────────────────────────────────────────────────────────
exports.startGame = onCall(async (request) => {
  const uid = assertAuth(request);
  const { betCents, mineCount } = request.data;

  // Validate inputs
  if (!Number.isInteger(betCents) || betCents < 1 || betCents > MAX_BET_CENTS)
    throw new HttpsError("invalid-argument", "Invalid bet amount.");
  if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount > 24)
    throw new HttpsError("invalid-argument", "Invalid mine count.");

  const userRef = db.collection("users").doc(uid);

  // Generate a cryptographically random server seed — never sent to client
  const serverSeed = crypto.randomBytes(32).toString("hex");
  const seedHash   = sha256hex(serverSeed);  // this IS sent to client

  // Atomic transaction: check balance and deduct bet
  const gameRef = db.collection("games").doc();
  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError("not-found", "User not found.");

    const currentBalance = userSnap.data().balanceCents;
    if (currentBalance < betCents) throw new HttpsError("failed-precondition", "Insufficient funds.");

    // Deduct bet
    tx.update(userRef, { balanceCents: currentBalance - betCents });

    // Write pending game — stores the seed server-side
    tx.set(gameRef, {
      uid,
      betCents,
      mineCount,
      serverSeed,        // secret until game ends
      seedHash,          // shown to player upfront for provable fairness
      revealed:          [],
      status:            "active",
      createdAt:         FieldValue.serverTimestamp(),
    });

    // Mark pending on user doc so refresh recovery works
    tx.update(userRef, { pendingGame: { gameId: gameRef.id } });
  });

  // Return new balance so frontend stays in sync
  const fresh = await userRef.get();
  return {
    gameId:          gameRef.id,
    seedHash,
    newBalanceCents: fresh.data().balanceCents,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
//  resolveGame
//  Handles three actions:
//    "reveal"  — player clicked a cell
//    "cashout" — player is cashing out (must have revealed ≥ 1 gem)
//    "bust"    — forfeit / refund (called on logout or refresh recovery)
//
//  This is the only place balanceCents is incremented (on win) or stays
//  reduced (on loss). The frontend NEVER touches balanceCents directly.
// ─────────────────────────────────────────────────────────────────────────────
exports.resolveGame = onCall(async (request) => {
  const uid = assertAuth(request);
  const { gameId, action, cellIndex } = request.data;

  if (!gameId)     throw new HttpsError("invalid-argument", "Missing gameId.");
  if (!["reveal", "cashout", "bust"].includes(action))
    throw new HttpsError("invalid-argument", "Invalid action.");

  const gameRef = db.collection("games").doc(gameId);
  const userRef = db.collection("users").doc(uid);

  const [gameSnap, userSnap] = await Promise.all([gameRef.get(), userRef.get()]);

  if (!gameSnap.exists)          throw new HttpsError("not-found", "Game not found.");
  if (!userSnap.exists)          throw new HttpsError("not-found", "User not found.");
  if (gameSnap.data().uid !== uid) throw new HttpsError("permission-denied", "Not your game.");
  if (gameSnap.data().status !== "active")
    throw new HttpsError("failed-precondition", "Game is not active.");

  const game = gameSnap.data();
  const mines = deriveMines(game.serverSeed, game.mineCount);

  // ── BUST (forfeit / refund) ────────────────────────────────────────────────
  if (action === "bust") {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(userRef);
      tx.update(gameRef, { status: "busted", endedAt: FieldValue.serverTimestamp() });
      // Refund the original bet
      tx.update(userRef, {
        balanceCents: fresh.data().balanceCents + game.betCents,
        gamesPlayed:  FieldValue.increment(1),  // always counted
        pendingGame:  null,
      });
    });
    const fresh = await userRef.get();
    return {
      newBalanceCents: fresh.data().balanceCents,
      mineIndices:     mines,
      serverSeed:      game.serverSeed,
      done:            true,
    };
  }

  // ── REVEAL ────────────────────────────────────────────────────────────────
  if (action === "reveal") {
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= GRID_SIZE)
      throw new HttpsError("invalid-argument", "Invalid cell index.");
    if (game.revealed.includes(cellIndex))
      throw new HttpsError("failed-precondition", "Cell already revealed.");

    const isMine     = mines.includes(cellIndex);
    const newRevealed = [...game.revealed, cellIndex];
    const gemsFound  = newRevealed.filter(c => !mines.includes(c)).length;
    const allSafeFound = gemsFound === (GRID_SIZE - game.mineCount);

    if (isMine) {
      // Loss — game over, no balance change (bet already deducted at start)
      await db.runTransaction(async (tx) => {
        tx.update(gameRef, {
          revealed:  newRevealed,
          status:    "lost",
          endedAt:   FieldValue.serverTimestamp(),
        });
        tx.update(userRef, {
          gamesPlayed: FieldValue.increment(1),
          pendingGame: null,
          history: FieldValue.arrayUnion({
            won: false,
            amountCents: game.betCents,
            ts: Date.now(),
          }),
        });
      });
      const fresh = await userRef.get();
      return {
        isMine:          true,
        mineIndices:     mines,
        serverSeed:      game.serverSeed,
        newBalanceCents: fresh.data().balanceCents,
        done:            true,
      };
    } else {
      // Safe cell
      await gameRef.update({ revealed: newRevealed });
      const fresh = await userRef.get();
      return {
        isMine:          false,
        mineIndices:     null,
        newBalanceCents: fresh.data().balanceCents,
        done:            allSafeFound,   // true = frontend should auto-cashout
      };
    }
  }

  // ── CASHOUT ────────────────────────────────────────────────────────────────
  if (action === "cashout") {
    const gemsFound = game.revealed.filter(c => !mines.includes(c)).length;
    if (gemsFound < 1) throw new HttpsError("failed-precondition", "No gems revealed yet.");

    const payout = winCents(game.betCents, gemsFound, game.mineCount);
    const mult   = (calcMultInt(gemsFound, game.mineCount) / 10000).toFixed(2);

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(userRef);
      tx.update(gameRef, {
        status:   "won",
        payout,
        endedAt:  FieldValue.serverTimestamp(),
      });
      tx.update(userRef, {
        balanceCents: fresh.data().balanceCents + payout,
        gamesPlayed:  FieldValue.increment(1),
        pendingGame:  null,
        history: FieldValue.arrayUnion({
          won: true,
          amountCents: payout,
          ts: Date.now(),
        }),
      });
    });
    const fresh = await userRef.get();
    return {
      winCents:        payout,
      multiplier:      mult,
      mineIndices:     mines,
      serverSeed:      game.serverSeed,   // reveal seed now so player can verify hash
      newBalanceCents: fresh.data().balanceCents,
      done:            true,
    };
  }
});
