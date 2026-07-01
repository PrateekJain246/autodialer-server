// Impostor — a social-deduction party game
// Self-contained module. Each player joins from their own phone with a room code.
// Everyone gets the same secret word except the impostor(s). Players give one-word
// clues in turn, then vote out who they think the impostor is.
//
// Runs on its own Socket.IO namespace (/game) and stores rooms in memory only —
// games are ephemeral, so nothing touches the autodialer database.

const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------------
// Word packs — each category is a list of words drawn at random for a round.
// ---------------------------------------------------------------------------
const WORD_PACKS = {
  Animals: ['Elephant', 'Penguin', 'Kangaroo', 'Dolphin', 'Tiger', 'Octopus', 'Giraffe', 'Hedgehog', 'Panda', 'Falcon', 'Crocodile', 'Squirrel'],
  Food: ['Pizza', 'Sushi', 'Burger', 'Pancake', 'Spaghetti', 'Taco', 'Popcorn', 'Chocolate', 'Mango', 'Dumpling', 'Ice Cream', 'Samosa'],
  Places: ['Beach', 'Airport', 'Library', 'Hospital', 'Stadium', 'Museum', 'Volcano', 'Desert', 'Casino', 'Jungle', 'Lighthouse', 'Subway'],
  Movies: ['Titanic', 'Avatar', 'Frozen', 'Inception', 'Jaws', 'Gladiator', 'Shrek', 'Matrix', 'Joker', 'Up', 'Interstellar', 'Coco'],
  Sports: ['Cricket', 'Tennis', 'Boxing', 'Surfing', 'Archery', 'Cycling', 'Skiing', 'Bowling', 'Football', 'Golf', 'Karate', 'Rowing'],
  Jobs: ['Doctor', 'Pilot', 'Chef', 'Teacher', 'Firefighter', 'Astronaut', 'Farmer', 'Barber', 'Detective', 'Plumber', 'Magician', 'Lawyer'],
  Objects: ['Umbrella', 'Telescope', 'Guitar', 'Compass', 'Candle', 'Anchor', 'Mirror', 'Backpack', 'Hammer', 'Balloon', 'Ladder', 'Whistle'],
};

const CATEGORIES = Object.keys(WORD_PACKS);

// ---------------------------------------------------------------------------
// In-memory room store
// ---------------------------------------------------------------------------
const rooms = new Map(); // code -> room

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A public view of the room that is safe to broadcast to everyone.
function publicRoom(room) {
  const players = [...room.players.values()].map(p => ({
    id: p.id, nickname: p.nickname, connected: p.connected,
    score: p.score, isHost: p.id === room.hostId,
    hasClue: room.round ? room.round.clues.has(p.id) : false,
    hasVoted: room.round ? room.round.votes.has(p.id) : false,
  }));
  const view = {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    categories: CATEGORIES,
    players,
  };
  if (room.round && (room.phase === 'clue' || room.phase === 'vote' || room.phase === 'results')) {
    view.category = room.round.category;
    view.turnOrder = room.round.turnOrder;
    view.currentTurnIndex = room.round.currentTurnIndex;
    // Clues revealed in turn order, only those already submitted.
    view.clues = room.round.turnOrder
      .filter(pid => room.round.clues.has(pid))
      .map(pid => ({ playerId: pid, nickname: room.players.get(pid)?.nickname, clue: room.round.clues.get(pid) }));
  }
  if (room.round && room.phase === 'results') {
    view.results = room.round.results;
  }
  return view;
}

function broadcastRoom(ns, room) {
  ns.to(room.code).emit('game:room', publicRoom(room));
}

// Send each player their private role card for the current round.
function sendRoles(ns, room) {
  for (const p of room.players.values()) {
    if (!p.socketId) continue;
    const isImpostor = room.round.impostorIds.has(p.id);
    ns.to(p.socketId).emit('game:role', {
      role: isImpostor ? 'impostor' : 'crew',
      category: room.round.category,
      word: isImpostor ? null : room.round.word,
    });
  }
}

function activePlayers(room) {
  return [...room.players.values()].filter(p => p.connected);
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------
function startRound(ns, room, opts) {
  const players = activePlayers(room);
  const category = (opts.category && WORD_PACKS[opts.category]) ? opts.category : pick(CATEGORIES);
  const word = pick(WORD_PACKS[category]);

  let impostorCount = Math.max(1, Math.min(opts.impostorCount || 1, players.length - 2));
  const shuffled = shuffle(players.map(p => p.id));
  const impostorIds = new Set(shuffled.slice(0, impostorCount));

  room.phase = 'clue';
  room.round = {
    category, word, impostorIds,
    turnOrder: shuffle(players.map(p => p.id)),
    currentTurnIndex: 0,
    clues: new Map(),
    votes: new Map(),
    results: null,
  };

  sendRoles(ns, room);
  broadcastRoom(ns, room);
}

function maybeAdvanceToVote(ns, room) {
  const everyoneSubmitted = room.round.turnOrder.every(pid => room.round.clues.has(pid));
  if (everyoneSubmitted) {
    room.phase = 'vote';
  }
  broadcastRoom(ns, room);
}

function tallyAndFinish(ns, room) {
  const round = room.round;
  // Count votes
  const tally = new Map();
  for (const target of round.votes.values()) {
    tally.set(target, (tally.get(target) || 0) + 1);
  }
  let topVoted = null, topCount = -1, tie = false;
  for (const [pid, count] of tally.entries()) {
    if (count > topCount) { topCount = count; topVoted = pid; tie = false; }
    else if (count === topCount) { tie = true; }
  }

  const impostorIds = [...round.impostorIds];
  const caught = !tie && topVoted != null && round.impostorIds.has(topVoted);
  const crewWins = caught;

  // Award points: crew wins -> each non-impostor +1; impostor wins -> each impostor +2
  for (const p of room.players.values()) {
    const isImp = round.impostorIds.has(p.id);
    if (crewWins && !isImp) p.score += 1;
    if (!crewWins && isImp) p.score += 2;
  }

  round.results = {
    word: round.word,
    category: round.category,
    impostorIds,
    impostorNames: impostorIds.map(id => room.players.get(id)?.nickname).filter(Boolean),
    votes: [...round.votes.entries()].map(([voter, target]) => ({
      voter, voterName: room.players.get(voter)?.nickname,
      target, targetName: room.players.get(target)?.nickname,
    })),
    tally: [...tally.entries()].map(([pid, count]) => ({
      playerId: pid, nickname: room.players.get(pid)?.nickname, count,
    })).sort((a, b) => b.count - a.count),
    topVoted, tie,
    winner: crewWins ? 'crew' : 'impostor',
  };
  room.phase = 'results';
  broadcastRoom(ns, room);
}

function maybeTally(ns, room) {
  const voters = activePlayers(room);
  const allVoted = voters.every(p => room.round.votes.has(p.id));
  if (allVoted) tallyAndFinish(ns, room);
  else broadcastRoom(ns, room);
}

// Remove empty rooms / clean up host assignment when players leave.
function reassignHostIfNeeded(room) {
  if (!room.players.has(room.hostId) || !room.players.get(room.hostId).connected) {
    const next = activePlayers(room)[0];
    room.hostId = next ? next.id : room.hostId;
  }
}

// ---------------------------------------------------------------------------
// Socket wiring
// ---------------------------------------------------------------------------
function setupGame(io) {
  const ns = io.of('/game');

  ns.on('connection', (socket) => {
    let currentCode = null;
    let currentPlayerId = null;

    function room() { return currentCode ? rooms.get(currentCode) : null; }
    function isHost(r) { return r && r.hostId === currentPlayerId; }

    socket.on('game:create', (data, cb) => {
      const nickname = (data?.nickname || 'Player').toString().slice(0, 20).trim() || 'Player';
      const code = makeRoomCode();
      const playerId = uuidv4();
      const r = {
        code, hostId: playerId, phase: 'lobby',
        players: new Map(), round: null,
      };
      r.players.set(playerId, { id: playerId, nickname, socketId: socket.id, connected: true, score: 0 });
      rooms.set(code, r);

      currentCode = code; currentPlayerId = playerId;
      socket.join(code);
      cb?.({ ok: true, code, playerId });
      broadcastRoom(ns, r);
    });

    socket.on('game:join', (data, cb) => {
      const code = (data?.code || '').toString().toUpperCase().trim();
      const nickname = (data?.nickname || 'Player').toString().slice(0, 20).trim() || 'Player';
      const r = rooms.get(code);
      if (!r) return cb?.({ ok: false, error: 'Room not found' });
      if (r.phase !== 'lobby') return cb?.({ ok: false, error: 'Game already in progress' });
      if (activePlayers(r).length >= 10) return cb?.({ ok: false, error: 'Room is full' });

      const playerId = uuidv4();
      r.players.set(playerId, { id: playerId, nickname, socketId: socket.id, connected: true, score: 0 });
      currentCode = code; currentPlayerId = playerId;
      socket.join(code);
      cb?.({ ok: true, code, playerId });
      broadcastRoom(ns, r);
    });

    // Rejoin after a refresh / dropped connection (client stores code+playerId).
    socket.on('game:rejoin', (data, cb) => {
      const code = (data?.code || '').toString().toUpperCase().trim();
      const playerId = data?.playerId;
      const r = rooms.get(code);
      if (!r || !r.players.has(playerId)) return cb?.({ ok: false, error: 'Session expired' });
      const p = r.players.get(playerId);
      p.socketId = socket.id; p.connected = true;
      currentCode = code; currentPlayerId = playerId;
      socket.join(code);
      cb?.({ ok: true, code, playerId });
      // Re-send private role if a round is active.
      if (r.round && (r.phase === 'clue' || r.phase === 'vote' || r.phase === 'results')) {
        const isImpostor = r.round.impostorIds.has(playerId);
        socket.emit('game:role', {
          role: isImpostor ? 'impostor' : 'crew',
          category: r.round.category,
          word: isImpostor ? null : r.round.word,
        });
      }
      broadcastRoom(ns, r);
    });

    socket.on('game:start', (data, cb) => {
      const r = room();
      if (!r || !isHost(r)) return cb?.({ ok: false, error: 'Only the host can start' });
      if (activePlayers(r).length < 3) return cb?.({ ok: false, error: 'Need at least 3 players' });
      startRound(ns, r, { category: data?.category, impostorCount: data?.impostorCount || 1 });
      cb?.({ ok: true });
    });

    socket.on('game:clue', (data, cb) => {
      const r = room();
      if (!r || r.phase !== 'clue') return cb?.({ ok: false, error: 'Not in clue phase' });
      // Enforce turn order: only the current player may submit.
      const turnPid = r.round.turnOrder[r.round.currentTurnIndex];
      if (turnPid !== currentPlayerId) return cb?.({ ok: false, error: 'Not your turn yet' });
      const clue = (data?.clue || '').toString().slice(0, 24).trim();
      if (!clue) return cb?.({ ok: false, error: 'Enter a one-word clue' });
      if (/\s/.test(clue)) return cb?.({ ok: false, error: 'One word only' });
      r.round.clues.set(currentPlayerId, clue);
      r.round.currentTurnIndex++;
      cb?.({ ok: true });
      maybeAdvanceToVote(ns, r);
    });

    socket.on('game:vote', (data, cb) => {
      const r = room();
      if (!r || r.phase !== 'vote') return cb?.({ ok: false, error: 'Not in voting phase' });
      const target = data?.target;
      if (!r.players.has(target)) return cb?.({ ok: false, error: 'Invalid vote' });
      if (target === currentPlayerId) return cb?.({ ok: false, error: "You can't vote for yourself" });
      r.round.votes.set(currentPlayerId, target);
      cb?.({ ok: true });
      maybeTally(ns, r);
    });

    // Host forces the tally early (in case someone is idle).
    socket.on('game:force-reveal', (data, cb) => {
      const r = room();
      if (!r || !isHost(r) || r.phase !== 'vote') return cb?.({ ok: false });
      tallyAndFinish(ns, r);
      cb?.({ ok: true });
    });

    socket.on('game:next-round', (data, cb) => {
      const r = room();
      if (!r || !isHost(r)) return cb?.({ ok: false, error: 'Only the host can continue' });
      r.phase = 'lobby';
      r.round = null;
      broadcastRoom(ns, r);
      cb?.({ ok: true });
    });

    socket.on('game:leave', () => {
      const r = room();
      if (!r) return;
      r.players.delete(currentPlayerId);
      socket.leave(r.code);
      if (activePlayers(r).length === 0) { rooms.delete(r.code); }
      else { reassignHostIfNeeded(r); broadcastRoom(ns, r); }
      currentCode = null; currentPlayerId = null;
    });

    socket.on('disconnect', () => {
      const r = room();
      if (!r || !r.players.has(currentPlayerId)) return;
      const p = r.players.get(currentPlayerId);
      p.connected = false; p.socketId = null;
      // In the lobby, a disconnect removes the player outright; mid-game we keep
      // their slot so they can rejoin.
      if (r.phase === 'lobby') r.players.delete(currentPlayerId);
      if (activePlayers(r).length === 0) {
        // Keep in-progress rooms briefly so everyone can reconnect; drop empty lobbies now.
        if (r.phase === 'lobby') rooms.delete(r.code);
      } else {
        reassignHostIfNeeded(r);
      }
      if (rooms.has(r.code)) broadcastRoom(ns, r);
    });
  });

  // Periodically sweep abandoned rooms (all disconnected) to avoid leaks.
  setInterval(() => {
    for (const [code, r] of rooms.entries()) {
      if (activePlayers(r).length === 0) rooms.delete(code);
    }
  }, 10 * 60 * 1000);

  console.log('  Impostor game namespace ready at /game');
}

module.exports = { setupGame };
