// Teen Patti — a dealer-controlled card table
//
// One person (the dealer) creates a table and shares a link. Each player opens
// the link on their phone and types their name; that is all they do to join.
// From then on the dealer controls everything:
//   - deal any number of cards to everyone, or send one card (random or a
//     specific card picked from the deck) to one player; take cards back
//   - give or take money from any player, collect boot, award or split the pot
//   - set whose turn it is, pack / reveal / sit out players, force a show
//   - change the rules on the fly (cards per hand, decks, boot, bet limits,
//     turn order, blind play) and undo any mistake
// Players can see their cards, bet (blind or seen chaal), pack and ask for a show.
// The table keeps a running "net" per player (chips now minus money given) so
// settling up at the end is easy.
//
// Runs on its own Socket.IO namespace (/teenpatti) and keeps tables in memory
// only, so nothing touches the autodialer database.

const crypto = require('crypto');

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['S', 'H', 'D', 'C'];
const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));
const SUIT_ORDER = Object.fromEntries(SUITS.map((s, i) => [s, i]));
const RANK_LABEL = { T: '10' };
const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };

const MAX_PLAYERS = 20;
const MAX_AMOUNT = 1e12;
const LOG_LIMIT = 80;
const UNDO_LIMIT = 40;
const IDLE_TTL_MS = 24 * 60 * 60 * 1000; // tables with no activity for a day are dropped

const DEFAULT_SETTINGS = {
  cardsPerHand: 3,     // cards dealt to each player when a round starts
  decks: 1,            // 1-4 standard 52-card decks shuffled together
  boot: 10,            // ante collected from every player at round start
  startChips: 1000,    // money every new player receives on joining (0 = dealer gives manually)
  enforceTurns: true,  // players may only bet / pack / show on their turn
  enforceLimits: true, // blind bets 1x-2x stake, seen bets 2x-4x stake, show only with 2 left
  allowBlind: true,    // players start blind and choose when to look at their cards
  currency: '₹',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const rooms = new Map(); // code -> room

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeToken() { return crypto.randomBytes(12).toString('base64url'); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Card ids are rank + suit + deck index, e.g. "AS0", "TH1".
function freshDeck(decks) {
  const d = [];
  for (let k = 0; k < decks; k++) for (const s of SUITS) for (const r of RANKS) d.push(r + s + k);
  return shuffle(d);
}

function sortCards(cards) {
  return cards.slice().sort((a, b) =>
    (SUIT_ORDER[a[1]] - SUIT_ORDER[b[1]]) || (RANK_VALUE[b[0]] - RANK_VALUE[a[0]]) || a.localeCompare(b));
}

function cardName(id) { return (RANK_LABEL[id[0]] || id[0]) + SUIT_SYMBOL[id[1]]; }

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function cleanName(v) {
  return (v || '').toString().replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

function cleanSettings(patch, base) {
  const s = { ...base };
  if (!patch || typeof patch !== 'object') return s;
  const num = (k, lo, hi) => {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') return;
    const v = toInt(patch[k]);
    if (v !== null) s[k] = Math.min(hi, Math.max(lo, v));
  };
  num('cardsPerHand', 1, 13);
  num('decks', 1, 4);
  num('boot', 0, MAX_AMOUNT);
  num('startChips', 0, MAX_AMOUNT);
  for (const k of ['enforceTurns', 'enforceLimits', 'allowBlind']) {
    if (typeof patch[k] === 'boolean') s[k] = patch[k];
  }
  if (typeof patch.currency === 'string') s.currency = patch.currency.replace(/[<>]/g, '').trim().slice(0, 4);
  return s;
}

// ---------------------------------------------------------------------------
// Hand ranking (used to label hands and suggest a winner; the dealer decides)
// Trail > Pure sequence > Sequence > Color > Pair > High card.
// A-K-Q is the top sequence, A-2-3 second, then K-Q-J down to 4-3-2.
// With more than 3 cards, the best 3-card combination counts.
// ---------------------------------------------------------------------------
const CATEGORY_NAMES = ['High card', 'Pair', 'Color', 'Sequence', 'Pure sequence', 'Trail'];

function score3(cards) {
  const vals = cards.map(c => RANK_VALUE[c[0]]).sort((x, y) => y - x);
  const flush = cards.every(c => c[1] === cards[0][1]);
  const [a, b, c] = vals;
  let seq = 0;
  if (a - 1 === b && b - 1 === c) seq = a === 14 ? 15 : a;
  else if (a === 14 && b === 3 && c === 2) seq = 14;
  if (a === b && b === c) return { cat: 5, tb: [a] };
  if (seq && flush) return { cat: 4, tb: [seq] };
  if (seq) return { cat: 3, tb: [seq] };
  if (flush) return { cat: 2, tb: vals };
  if (a === b || b === c) return { cat: 1, tb: [b, a === b ? c : a] };
  return { cat: 0, tb: vals };
}

function scoreSmall(cards) {
  const vals = cards.map(c => RANK_VALUE[c[0]]).sort((x, y) => y - x);
  if (vals.length === 2 && vals[0] === vals[1]) return { cat: 1, tb: [vals[0], 0] };
  return { cat: 0, tb: vals };
}

function compareScore(x, y) {
  if (x.cat !== y.cat) return x.cat - y.cat;
  const n = Math.max(x.tb.length, y.tb.length);
  for (let i = 0; i < n; i++) {
    const d = (x.tb[i] || 0) - (y.tb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function bestHand(cards) {
  if (!cards || !cards.length) return null;
  if (cards.length < 3) return { ...scoreSmall(cards), cards: cards.slice() };
  let best = null;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      for (let k = j + 1; k < cards.length; k++) {
        const combo = [cards[i], cards[j], cards[k]];
        const s = score3(combo);
        if (!best || compareScore(s, best) > 0) best = { ...s, cards: combo };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------
function createRoom(hostName, settings) {
  const s = cleanSettings(settings, DEFAULT_SETTINGS);
  const room = {
    code: makeCode(),
    hostKey: makeToken(),
    hostName: cleanName(hostName) || 'Dealer',
    settings: s,
    players: new Map(), // id -> player
    order: [],          // seat order (player ids)
    deck: freshDeck(s.decks),
    pot: 0,
    stake: s.boot,
    turn: null,
    phase: 'lobby',     // lobby | playing | show | done
    roundNo: 0,
    suggested: null,    // { ids, reason }
    log: [],
    logSeq: 0,
    undo: [],
    sockets: new Map(), // socketId -> { role: 'host' | 'player', playerId }
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addLog(room, text) {
  room.log.push({ id: ++room.logSeq, t: Date.now(), text });
  if (room.log.length > LOG_LIMIT) room.log.splice(0, room.log.length - LOG_LIMIT);
}

function money(room, n) { return room.settings.currency + Number(n).toLocaleString('en-IN'); }

function inHand(p) { return !!p && !p.packed && !p.sittingOut && p.cards.length > 0; }
function activeIds(room) { return room.order.filter(id => inHand(room.players.get(id))); }

// Next player in seat order after `fromId` who is still in the hand.
function nextTurn(room, fromId) {
  const ids = room.order;
  const n = ids.length;
  if (!n) return null;
  const start = ids.indexOf(fromId);
  for (let step = 1; step <= n; step++) {
    const id = ids[(((start + step) % n) + n) % n];
    if (inHand(room.players.get(id))) return id;
  }
  return null;
}

// Before every change to the game, remember the state so the dealer can undo.
function snapshot(room, label) {
  const state = {
    deck: room.deck, pot: room.pot, stake: room.stake, turn: room.turn,
    phase: room.phase, roundNo: room.roundNo, suggested: room.suggested,
    players: [...room.players.values()].map(p => ({
      id: p.id, chips: p.chips, given: p.given, cards: p.cards, seen: p.seen, packed: p.packed,
      revealed: p.revealed, sittingOut: p.sittingOut, lastAction: p.lastAction,
    })),
  };
  room.undo.push({ label, json: JSON.stringify(state) });
  if (room.undo.length > UNDO_LIMIT) room.undo.shift();
}

function restore(room) {
  const entry = room.undo.pop();
  if (!entry) return null;
  const s = JSON.parse(entry.json);
  room.deck = s.deck; room.pot = s.pot; room.stake = s.stake; room.turn = s.turn;
  room.phase = s.phase; room.roundNo = s.roundNo; room.suggested = s.suggested;
  const known = new Set();
  for (const ps of s.players) {
    const p = room.players.get(ps.id);
    if (p) { Object.assign(p, ps); known.add(ps.id); }
  }
  // Players who joined after the snapshot had no cards at that time.
  for (const p of room.players.values()) if (!known.has(p.id)) p.cards = [];
  if (room.turn && !room.players.has(room.turn)) room.turn = null;
  return entry.label;
}

function limitsFor(room, p) {
  const blind = room.settings.allowBlind && !p.seen;
  const base = Math.max(1, room.stake);
  return { blind, min: blind ? base : base * 2, max: blind ? base * 2 : base * 4 };
}

// When everyone else has packed, flag the last player for the dealer to award.
function checkLastStanding(room) {
  if (room.phase !== 'playing') return;
  const act = activeIds(room);
  const lastFlag = room.suggested && room.suggested.reason === 'Last player standing';
  if (act.length === 1) {
    room.turn = null;
    if (!lastFlag || room.suggested.ids[0] !== act[0]) {
      room.suggested = { ids: act, reason: 'Last player standing' };
      addLog(room, `${room.players.get(act[0]).name} is the last player standing`);
    }
  } else if (lastFlag) {
    room.suggested = null;
    if (!room.turn && act.length > 1) room.turn = act[0];
  }
}

function applyBet(room, p, amount, label) {
  const blind = room.settings.allowBlind && !p.seen;
  p.chips -= amount;
  room.pot += amount;
  room.stake = Math.max(room.stake, blind ? amount : Math.ceil(amount / 2));
  p.lastAction = `${label || (blind ? 'Blind' : 'Chaal')} ${money(room, amount)}`;
  addLog(room, `${p.name}: ${p.lastAction}`);
  if (room.turn === p.id) room.turn = nextTurn(room, p.id);
}

function doShow(room) {
  const act = activeIds(room);
  for (const id of act) {
    const p = room.players.get(id);
    p.revealed = true;
    p.seen = true;
  }
  room.phase = 'show';
  room.turn = null;
  let best = null;
  let winners = [];
  for (const id of act) {
    const h = bestHand(room.players.get(id).cards);
    const c = best ? compareScore(h, best) : 1;
    if (c > 0) { best = h; winners = [id]; } else if (c === 0) winners.push(id);
  }
  room.suggested = winners.length ? { ids: winners, reason: CATEGORY_NAMES[best.cat] } : null;
  if (winners.length) {
    const names = winners.map(id => room.players.get(id).name).join(' & ');
    addLog(room, `Show! Best hand: ${names} (${CATEGORY_NAMES[best.cat]})`);
  }
}

function dealRoundRobin(room, recipients, count) {
  let dealt = 0;
  for (let i = 0; i < count; i++) {
    for (const p of recipients) {
      if (!room.deck.length) return { dealt, ranOut: true };
      p.cards.push(room.deck.pop());
      dealt++;
    }
  }
  return { dealt, ranOut: false };
}

function collectAllCards(room, newDeck) {
  for (const p of room.players.values()) p.cards = [];
  room.deck = newDeck ? freshDeck(room.settings.decks) : shuffle(room.deck);
}

// ---------------------------------------------------------------------------
// Per-viewer state (each player only ever receives their own cards)
// ---------------------------------------------------------------------------
function viewFor(room, who, hostDeck) {
  const isHost = who.role === 'host';
  const online = new Set();
  let hostOnline = false;
  for (const w of room.sockets.values()) {
    if (w.role === 'host') hostOnline = true; else online.add(w.playerId);
  }
  const players = room.order.map(id => {
    const p = room.players.get(id);
    const mine = who.playerId === id;
    const seen = p.seen || !room.settings.allowBlind;
    const canSee = isHost || p.revealed || (mine && seen);
    const v = {
      id, name: p.name, chips: p.chips, given: p.given, net: p.chips - p.given,
      connected: online.has(id), seen, packed: p.packed, revealed: p.revealed,
      sittingOut: p.sittingOut, inHand: inHand(p), cardCount: p.cards.length,
      lastAction: p.lastAction, cards: canSee ? p.cards : null,
    };
    if (canSee && p.cards.length) {
      const h = bestHand(p.cards);
      v.hand = { name: CATEGORY_NAMES[h.cat], cards: h.cards };
    }
    if (isHost) v.token = p.token;
    if (mine) v.limits = limitsFor(room, p);
    return v;
  });
  const view = {
    code: room.code, phase: room.phase, roundNo: room.roundNo, pot: room.pot, stake: room.stake,
    turn: room.turn, settings: room.settings, hostName: room.hostName, hostOnline,
    players, activeCount: activeIds(room).length, suggested: room.suggested,
    deckCount: room.deck.length, log: room.log.slice(-40), me: who.playerId || null, isHost,
  };
  if (isHost) {
    view.deck = hostDeck;
    view.undoLabel = room.undo.length ? room.undo[room.undo.length - 1].label : null;
  }
  return view;
}

// ---------------------------------------------------------------------------
// Socket wiring
// ---------------------------------------------------------------------------
function setupTeenPatti(io) {
  const ns = io.of('/teenpatti');

  function broadcast(room) {
    room.lastActive = Date.now();
    const hostDeck = sortCards(room.deck);
    for (const [sid, who] of room.sockets) ns.to(sid).emit('tp:state', viewFor(room, who, hostDeck));
  }

  ns.on('connection', (socket) => {
    let room = null;
    let who = null; // { role, playerId }

    function bind(r, w) {
      if (room && room !== r) { room.sockets.delete(socket.id); broadcast(room); }
      room = r; who = w;
      r.sockets.set(socket.id, w);
    }

    const reply = (cb) => (typeof cb === 'function' ? cb : () => {});

    // Wrap a dealer-only action. fn returns an error string, or an object to
    // send back, or nothing on success.
    function hostAction(event, fn) {
      socket.on(event, (data, cb) => {
        const done = reply(cb);
        if (!room || !who || who.role !== 'host' || !rooms.has(room.code)) {
          return done({ ok: false, error: 'Only the dealer can do that' });
        }
        try {
          const res = fn(room, data || {});
          if (typeof res === 'string') return done({ ok: false, error: res });
          done({ ok: true, ...(res || {}) });
          broadcast(room);
        } catch (e) {
          console.error('[teenpatti]', event, e);
          done({ ok: false, error: 'Something went wrong' });
        }
      });
    }

    function playerAction(event, fn) {
      socket.on(event, (data, cb) => {
        const done = reply(cb);
        const p = room && who && who.role === 'player' ? room.players.get(who.playerId) : null;
        if (!p || !rooms.has(room.code)) return done({ ok: false, error: 'You are not at this table' });
        try {
          const res = fn(room, p, data || {});
          if (typeof res === 'string') return done({ ok: false, error: res });
          done({ ok: true });
          broadcast(room);
        } catch (e) {
          console.error('[teenpatti]', event, e);
          done({ ok: false, error: 'Something went wrong' });
        }
      });
    }

    function getPlayer(r, id) { return r.players.get(id) || null; }

    // ---- joining ----------------------------------------------------------
    socket.on('tp:create', (data, cb) => {
      const done = reply(cb);
      const r = createRoom(data?.name, data?.settings);
      bind(r, { role: 'host' });
      addLog(r, `${r.hostName} opened table ${r.code}`);
      done({ ok: true, code: r.code, hostKey: r.hostKey });
      broadcast(r);
    });

    socket.on('tp:host-attach', (data, cb) => {
      const done = reply(cb);
      const r = rooms.get((data?.code || '').toString().toUpperCase().trim());
      if (!r || !data?.key || data.key !== r.hostKey) return done({ ok: false, error: 'Table not found or dealer link is wrong' });
      bind(r, { role: 'host' });
      done({ ok: true, code: r.code });
      broadcast(r);
    });

    // Let the join screen show which table you're about to join.
    socket.on('tp:peek', (data, cb) => {
      const done = reply(cb);
      const r = rooms.get((data?.code || '').toString().toUpperCase().trim());
      if (!r) return done({ ok: false, error: 'No table with that code' });
      done({ ok: true, code: r.code, hostName: r.hostName, players: r.order.length });
    });

    socket.on('tp:join', (data, cb) => {
      const done = reply(cb);
      const r = rooms.get((data?.code || '').toString().toUpperCase().trim());
      if (!r) return done({ ok: false, error: 'No table with that code' });
      const name = cleanName(data?.name);
      if (!name) return done({ ok: false, error: 'Enter your name' });
      const taken = [...r.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase());
      if (taken) return done({ ok: false, error: 'That name is taken. Use another, or ask the dealer for your personal link.' });
      if (r.order.length >= MAX_PLAYERS) return done({ ok: false, error: 'This table is full' });
      const p = {
        id: crypto.randomUUID(), token: makeToken(), name,
        chips: r.settings.startChips, given: r.settings.startChips,
        cards: [], seen: false, packed: false, revealed: false, sittingOut: false, lastAction: null,
      };
      r.players.set(p.id, p);
      r.order.push(p.id);
      bind(r, { role: 'player', playerId: p.id });
      addLog(r, `${name} joined${p.chips ? ` with ${money(r, p.chips)}` : ''}`);
      done({ ok: true, code: r.code, token: p.token, playerId: p.id });
      broadcast(r);
    });

    socket.on('tp:rejoin', (data, cb) => {
      const done = reply(cb);
      const r = rooms.get((data?.code || '').toString().toUpperCase().trim());
      const p = r && data?.token ? [...r.players.values()].find(x => x.token === data.token) : null;
      if (!p) return done({ ok: false, error: 'This seat no longer exists' });
      bind(r, { role: 'player', playerId: p.id });
      done({ ok: true, code: r.code, playerId: p.id, name: p.name });
      broadcast(r);
    });

    // ---- dealer: rounds & cards --------------------------------------------
    hostAction('tp:new-round', (r, d) => {
      if (!r.order.length) return 'No players at the table yet';
      const count = d.deal === false ? 0 : Math.min(13, Math.max(1, toInt(d.count) || r.settings.cardsPerHand));
      snapshot(r, `Start round ${r.roundNo + 1}`);
      if (r.pot > 0 && r.phase !== 'done') addLog(r, `Pot of ${money(r, r.pot)} carried into the next round`);
      collectAllCards(r, true);
      r.roundNo++;
      r.phase = 'playing';
      r.stake = r.settings.boot;
      r.suggested = null;
      for (const p of r.players.values()) {
        p.seen = !r.settings.allowBlind;
        p.packed = false; p.revealed = false; p.lastAction = null;
      }
      addLog(r, `Round ${r.roundNo} started`);
      if (d.boot !== false && r.settings.boot > 0) {
        let collected = 0;
        for (const id of r.order) {
          const p = r.players.get(id);
          if (p.sittingOut) continue;
          if (p.chips < r.settings.boot) {
            p.sittingOut = true;
            addLog(r, `${p.name} can't pay the boot and sits out`);
            continue;
          }
          p.chips -= r.settings.boot;
          collected += r.settings.boot;
        }
        r.pot += collected;
        if (collected) addLog(r, `Boot of ${money(r, r.settings.boot)} collected (${money(r, collected)})`);
      }
      if (count) {
        const recipients = r.order.map(id => r.players.get(id)).filter(p => !p.sittingOut);
        const res = dealRoundRobin(r, recipients, count);
        addLog(r, `Dealer dealt ${count} card${count > 1 ? 's' : ''} to each player`);
        if (res.ranOut) addLog(r, 'The deck ran out while dealing');
      }
      const n = r.order.length;
      const startIdx = (r.roundNo - 1) % n;
      r.turn = nextTurn(r, r.order[(startIdx - 1 + n) % n]);
      checkLastStanding(r);
    });

    hostAction('tp:send-card', (r, d) => {
      const p = getPlayer(r, d.playerId);
      if (!p) return 'Player not found';
      let card;
      if (d.cardId) {
        const idx = r.deck.indexOf(d.cardId);
        if (idx === -1) return 'That card is not in the deck';
        snapshot(r, `Send ${cardName(d.cardId)} to ${p.name}`);
        card = r.deck.splice(idx, 1)[0];
      } else {
        if (!r.deck.length) return 'The deck is empty';
        snapshot(r, `Send a card to ${p.name}`);
        card = r.deck.pop();
      }
      p.cards.push(card);
      addLog(r, `Dealer sent a card to ${p.name}`);
      if (r.phase === 'playing' && p.cards.length === 1 && !p.packed && !p.sittingOut && !r.turn) r.turn = p.id;
      checkLastStanding(r);
      return { card };
    });

    hostAction('tp:deal-each', (r, d) => {
      const count = Math.min(13, Math.max(1, toInt(d.count) || 1));
      const recipients = r.order.map(id => r.players.get(id)).filter(p => !p.sittingOut && !p.packed);
      if (!recipients.length) return 'No one to deal to';
      if (!r.deck.length) return 'The deck is empty';
      snapshot(r, `Deal ${count} to everyone`);
      const res = dealRoundRobin(r, recipients, count);
      addLog(r, `Dealer dealt ${count} more card${count > 1 ? 's' : ''} to everyone`);
      if (res.ranOut) addLog(r, 'The deck ran out while dealing');
      if (r.phase === 'playing' && !r.turn) r.turn = activeIds(r)[0] || null;
      checkLastStanding(r);
    });

    hostAction('tp:take-card', (r, d) => {
      const p = getPlayer(r, d.playerId);
      if (!p) return 'Player not found';
      const idx = p.cards.indexOf(d.cardId);
      if (idx === -1) return 'That player does not have that card';
      snapshot(r, `Take ${cardName(d.cardId)} from ${p.name}`);
      const [card] = p.cards.splice(idx, 1);
      r.deck.splice(crypto.randomInt(r.deck.length + 1), 0, card);
      addLog(r, `Dealer took a card back from ${p.name}`);
      if (r.turn === p.id && !inHand(p)) r.turn = nextTurn(r, p.id);
      checkLastStanding(r);
    });

    hostAction('tp:collect-cards', (r) => {
      snapshot(r, 'Collect all cards');
      collectAllCards(r, true);
      for (const p of r.players.values()) { p.revealed = false; p.seen = !r.settings.allowBlind; }
      r.turn = null;
      addLog(r, 'Dealer collected all cards and shuffled');
    });

    hostAction('tp:shuffle', (r) => {
      r.deck = shuffle(r.deck);
      addLog(r, 'Dealer shuffled the deck');
    });

    hostAction('tp:show', (r) => {
      if (activeIds(r).length < 1) return 'No one has cards in this hand';
      snapshot(r, 'Show all hands');
      doShow(r);
    });

    // ---- dealer: money ---------------------------------------------------
    hostAction('tp:money', (r, d) => {
      const amount = toInt(d.amount);
      if (!amount || amount <= 0 || amount > MAX_AMOUNT) return 'Enter an amount';
      const take = d.op === 'take';
      const targets = d.playerId === 'all' ? r.order.map(id => r.players.get(id)) : [getPlayer(r, d.playerId)];
      if (!targets.length || targets.some(p => !p)) return 'Player not found';
      if (take) {
        const short = targets.find(p => p.chips < amount);
        if (short) return `${short.name} only has ${money(r, short.chips)}`;
      }
      const who = d.playerId === 'all' ? 'everyone' : targets[0].name;
      snapshot(r, `${take ? 'Take' : 'Give'} ${money(r, amount)} ${take ? 'from' : 'to'} ${who}`);
      for (const p of targets) {
        const delta = take ? -amount : amount;
        p.chips += delta;
        p.given += delta;
      }
      addLog(r, `Dealer ${take ? 'took' : 'gave'} ${money(r, amount)} ${take ? 'from' : 'to'} ${who}`);
    });

    hostAction('tp:award', (r, d) => {
      const ids = Array.isArray(d.playerIds) ? [...new Set(d.playerIds)].filter(id => r.players.has(id)) : [];
      if (!ids.length) return 'Pick who wins';
      if (r.pot <= 0) return 'The pot is empty';
      const pot = r.pot;
      const names = ids.map(id => r.players.get(id).name).join(' & ');
      snapshot(r, `Award ${money(r, pot)} to ${names}`);
      const share = Math.floor(pot / ids.length);
      let rest = pot - share * ids.length;
      for (const id of ids) {
        const p = r.players.get(id);
        const amt = share + (rest > 0 ? 1 : 0);
        if (rest > 0) rest--;
        p.chips += amt;
      }
      r.pot = 0;
      r.phase = 'done';
      r.turn = null;
      r.suggested = null;
      addLog(r, ids.length > 1 ? `${names} split the pot of ${money(r, pot)}` : `${names} won the pot of ${money(r, pot)}`);
    });

    hostAction('tp:bet-for', (r, d) => {
      const p = getPlayer(r, d.playerId);
      if (!p) return 'Player not found';
      const amount = toInt(d.amount);
      if (!amount || amount <= 0) return 'Enter an amount';
      if (amount > p.chips) return `${p.name} only has ${money(r, p.chips)}`;
      snapshot(r, `Bet ${money(r, amount)} for ${p.name}`);
      applyBet(r, p, amount);
    });

    // ---- dealer: turns, player state, rules ---------------------------------
    hostAction('tp:set-turn', (r, d) => {
      if (d.playerId && !r.players.has(d.playerId)) return 'Player not found';
      r.turn = d.playerId || null;
      if (r.turn) addLog(r, `Dealer: it's ${r.players.get(r.turn).name}'s turn`);
    });

    hostAction('tp:next-turn', (r) => {
      const next = nextTurn(r, r.turn);
      if (!next) return 'No one is left in the hand';
      r.turn = next;
    });

    hostAction('tp:player-state', (r, d) => {
      const p = getPlayer(r, d.playerId);
      if (!p) return 'Player not found';
      const changes = [];
      const label = [];
      for (const k of ['packed', 'seen', 'revealed', 'sittingOut']) {
        if (typeof d[k] === 'boolean' && d[k] !== p[k]) changes.push(k);
      }
      if (!changes.length) return;
      snapshot(r, `Update ${p.name}`);
      for (const k of changes) {
        p[k] = d[k];
        if (k === 'packed') { label.push(d[k] ? 'packed' : 'back in the hand'); p.lastAction = d[k] ? 'Packed' : null; }
        if (k === 'seen' && d[k]) label.push('marked as seen');
        if (k === 'revealed') label.push(d[k] ? 'cards shown to everyone' : 'cards hidden again');
        if (k === 'sittingOut') label.push(d[k] ? 'sitting out' : 'back at the table');
      }
      if (label.length) addLog(r, `Dealer: ${p.name} ${label.join(', ')}`);
      if (r.turn === p.id && !inHand(p)) r.turn = nextTurn(r, p.id);
      checkLastStanding(r);
    });

    hostAction('tp:settings', (r, d) => {
      const before = r.settings;
      r.settings = cleanSettings(d.settings, r.settings);
      if (r.phase !== 'playing') r.stake = r.settings.boot;
      if (before.decks !== r.settings.decks) addLog(r, `Dealer set ${r.settings.decks} deck${r.settings.decks > 1 ? 's' : ''} (from next round)`);
      addLog(r, 'Dealer updated the game settings');
    });

    hostAction('tp:undo', (r) => {
      const label = restore(r);
      if (!label) return 'Nothing to undo';
      addLog(r, `Dealer undid: ${label}`);
    });

    hostAction('tp:kick', (r, d) => {
      const p = getPlayer(r, d.playerId);
      if (!p) return 'Player not found';
      // Their cards go back into the deck; undo history would reference them, so clear it.
      for (const c of p.cards) r.deck.splice(crypto.randomInt(r.deck.length + 1), 0, c);
      if (r.turn === p.id) r.turn = nextTurn(r, p.id);
      r.players.delete(p.id);
      r.order = r.order.filter(id => id !== p.id);
      r.undo = [];
      for (const [sid, w] of r.sockets) {
        if (w.playerId === p.id) { ns.to(sid).emit('tp:kicked'); r.sockets.delete(sid); }
      }
      addLog(r, `Dealer removed ${p.name} from the table (${money(r, p.chips)} in chips, net ${p.chips - p.given >= 0 ? '+' : ''}${money(r, p.chips - p.given)})`);
      checkLastStanding(r);
    });

    // ---- players --------------------------------------------------------
    playerAction('tp:see', (r, p) => {
      if (p.seen) return;
      p.seen = true;
      p.lastAction = 'Seen';
      addLog(r, `${p.name} looked at their cards`);
    });

    playerAction('tp:bet', (r, p, d) => {
      if (r.phase !== 'playing') return 'Betting opens when the dealer starts a round';
      if (!inHand(p)) return "You're not in this hand";
      if (r.settings.enforceTurns && r.turn !== p.id) return 'Wait for your turn';
      const amount = toInt(d.amount);
      if (!amount || amount <= 0) return 'Enter an amount';
      if (amount > p.chips) return `You only have ${money(r, p.chips)}`;
      if (r.settings.enforceLimits) {
        const { min, max } = limitsFor(r, p);
        const allIn = amount === p.chips && p.chips < min;
        if (!allIn && (amount < min || amount > max)) return `Bet between ${money(r, min)} and ${money(r, max)}`;
      }
      snapshot(r, `${p.name} bet ${money(r, amount)}`);
      applyBet(r, p, amount);
    });

    playerAction('tp:pack', (r, p) => {
      if (!inHand(p)) return "You're not in this hand";
      if (r.phase === 'playing' && r.settings.enforceTurns && r.turn !== p.id) return 'Wait for your turn';
      snapshot(r, `${p.name} packed`);
      p.packed = true;
      p.lastAction = 'Packed';
      addLog(r, `${p.name} packed`);
      if (r.turn === p.id) r.turn = nextTurn(r, p.id);
      checkLastStanding(r);
    });

    playerAction('tp:show-request', (r, p) => {
      if (r.phase !== 'playing') return 'You can ask for a show during a round';
      if (!inHand(p)) return "You're not in this hand";
      if (r.settings.enforceTurns && r.turn !== p.id) return 'Wait for your turn';
      const act = activeIds(r);
      if (act.length < 2) return 'There is no one to show against';
      if (r.settings.enforceLimits && act.length !== 2) return 'A show is allowed only when 2 players are left';
      const cost = Math.min(p.chips, limitsFor(r, p).min);
      snapshot(r, `${p.name} asked for a show`);
      if (cost > 0) applyBet(r, p, cost, 'Show');
      addLog(r, `${p.name} asked for a show`);
      doShow(r);
    });

    socket.on('tp:leave', () => {
      if (!room) return;
      room.sockets.delete(socket.id);
      broadcast(room);
      room = null; who = null;
    });

    socket.on('disconnect', () => {
      if (!room) return;
      room.sockets.delete(socket.id);
      if (rooms.has(room.code)) broadcast(room);
    });
  });

  // Drop tables nobody has touched for a day.
  setInterval(() => {
    const now = Date.now();
    for (const [code, r] of rooms) {
      if (now - r.lastActive > IDLE_TTL_MS) rooms.delete(code);
    }
  }, 30 * 60 * 1000).unref();

  console.log('  Teen Patti namespace ready at /teenpatti');
}

module.exports = { setupTeenPatti, _internal: { bestHand, compareScore, CATEGORY_NAMES } };
