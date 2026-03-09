const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const PORT = process.env.PORT || 3000;
const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const DEFAULT_TURN_TIMEOUT_SEC = 20;
const DEFAULT_AUTO_NEXT_HAND_SEC = 8;
const DEFAULT_REBUY_AMOUNT = 1000;
const MAX_CHIPS = 10000;

const PHASES = ["preflop", "flop", "turn", "river"];
const ACTIVE_PHASES = new Set(PHASES);
const SUITS = ["S", "H", "D", "C"];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, code: `${RANK_LABEL[rank] || rank}${suit}` });
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function combinations(arr, k) {
  const out = [];
  function bt(start, pick) {
    if (pick.length === k) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i < arr.length; i += 1) {
      pick.push(arr[i]);
      bt(i + 1, pick);
      pick.pop();
    }
  }
  bt(0, []);
  return out;
}

function evaluateFive(cards) {
  const ranks = cards.map((c) => c.rank);
  const suits = cards.map((c) => c.suit);
  const rankCounts = new Map();
  for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) || 0) + 1);

  const groups = [...rankCounts.entries()].map(([rank, count]) => ({ rank, count }));
  groups.sort((a, b) => b.count - a.count || b.rank - a.rank);

  const isFlush = suits.every((s) => s === suits[0]);
  const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a);

  let isStraight = false;
  let straightHigh = 0;
  if (uniqueRanks.length === 5) {
    if (uniqueRanks[0] - uniqueRanks[4] === 4) {
      isStraight = true;
      straightHigh = uniqueRanks[0];
    } else if (JSON.stringify(uniqueRanks) === JSON.stringify([14, 5, 4, 3, 2])) {
      isStraight = true;
      straightHigh = 5;
    }
  }

  if (isStraight && isFlush) return { category: 8, tiebreak: [straightHigh], name: "Straight Flush" };
  if (groups[0].count === 4) return { category: 7, tiebreak: [groups[0].rank, groups[1].rank], name: "Four of a Kind" };
  if (groups[0].count === 3 && groups[1].count === 2) return { category: 6, tiebreak: [groups[0].rank, groups[1].rank], name: "Full House" };
  if (isFlush) return { category: 5, tiebreak: [...ranks].sort((a, b) => b - a), name: "Flush" };
  if (isStraight) return { category: 4, tiebreak: [straightHigh], name: "Straight" };
  if (groups[0].count === 3) {
    const kickers = groups.slice(1).map((g) => g.rank).sort((a, b) => b - a);
    return { category: 3, tiebreak: [groups[0].rank, ...kickers], name: "Three of a Kind" };
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    const hp = Math.max(groups[0].rank, groups[1].rank);
    const lp = Math.min(groups[0].rank, groups[1].rank);
    return { category: 2, tiebreak: [hp, lp, groups[2].rank], name: "Two Pair" };
  }
  if (groups[0].count === 2) {
    const kickers = groups.slice(1).map((g) => g.rank).sort((a, b) => b - a);
    return { category: 1, tiebreak: [groups[0].rank, ...kickers], name: "One Pair" };
  }
  return { category: 0, tiebreak: [...ranks].sort((a, b) => b - a), name: "High Card" };
}

function compareEval(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i += 1) {
    const av = a.tiebreak[i] || 0;
    const bv = b.tiebreak[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function bestOfSeven(cards7) {
  const all = combinations(cards7, 5);
  let best = null;
  for (const hand of all) {
    const ev = evaluateFive(hand);
    if (!best || compareEval(ev, best) > 0) best = ev;
  }
  return best;
}

function randomId(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function asBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function cleanName(raw) {
  const name = (raw || "Player").toString().trim();
  return name.slice(0, 16) || "Player";
}

function makePlayer({ id, name, isBot = false }) {
  return {
    id,
    name,
    isBot,
    chips: STARTING_CHIPS,
    cards: [],
    folded: false,
    connected: true,
    status: "waiting",
    streetBet: 0,
    totalBet: 0,
    hasActed: false,
    lastActionSeq: -1,
  };
}

function makeSpectator({ id, name }) {
  return { id, name, connected: true };
}

function createRoom(roomId) {
  return {
    id: roomId,
    createdAt: Date.now(),
    hostId: null,
    players: [],
    spectators: [],

    handNo: 0,
    dealerIndex: -1,
    phase: "waiting",
    deck: [],
    board: [],
    pot: 0,

    currentTurn: null,
    currentBet: 0,
    minRaise: BIG_BLIND,
    turnDeadline: null,
    turnToken: 0,

    buttonId: null,
    smallBlindId: null,
    bigBlindId: null,

    message: "플레이어를 기다리는 중",
    actionLog: [],
    winners: [],

    settings: {
      locked: false,
      autoStart: true,
      turnTimeoutSec: DEFAULT_TURN_TIMEOUT_SEC,
      autoNextHandSec: DEFAULT_AUTO_NEXT_HAND_SEC,
    },
    nextHandAt: null,
  };
}

const rooms = new Map();
const turnTimers = new Map();
const nextHandTimers = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, createRoom(roomId));
  return rooms.get(roomId);
}

function pushLog(room, text) {
  room.actionLog.push(`[H${room.handNo}] ${text}`);
  if (room.actionLog.length > 80) {
    room.actionLog.splice(0, room.actionLog.length - 80);
  }
}

function getConnectedPlayers(room) {
  return room.players.filter((p) => p.connected);
}

function getContenders(room) {
  return room.players.filter((p) => p.connected && !p.folded);
}

function canAct(p) {
  return p.connected && !p.folded && p.chips > 0;
}

function indexOfPlayer(room, id) {
  return room.players.findIndex((p) => p.id === id);
}

function nextConnectedIndex(room, fromIdx) {
  if (!room.players.length) return -1;
  for (let i = 1; i <= room.players.length; i += 1) {
    const idx = (fromIdx + i + room.players.length) % room.players.length;
    if (room.players[idx].connected) return idx;
  }
  return -1;
}

function nextCanActIndex(room, fromIdx) {
  if (!room.players.length) return -1;
  for (let i = 1; i <= room.players.length; i += 1) {
    const idx = (fromIdx + i + room.players.length) % room.players.length;
    if (canAct(room.players[idx])) return idx;
  }
  return -1;
}

function bumpTurnToken(room) {
  room.turnToken += 1;
}

function setTurn(room, playerId) {
  room.currentTurn = playerId;
  bumpTurnToken(room);
}

function clearTurnTimer(roomId) {
  const t = turnTimers.get(roomId);
  if (t) clearTimeout(t);
  turnTimers.delete(roomId);
}

function clearNextHandTimer(roomId) {
  const t = nextHandTimers.get(roomId);
  if (t) clearTimeout(t);
  nextHandTimers.delete(roomId);
}

function moveTurnToNext(room) {
  const from = indexOfPlayer(room, room.currentTurn);
  const next = nextCanActIndex(room, from < 0 ? 0 : from);
  setTurn(room, next >= 0 ? room.players[next].id : null);
}

function resetStreet(room, firstTurnId) {
  room.currentBet = 0;
  room.minRaise = BIG_BLIND;
  for (const p of room.players) {
    p.streetBet = 0;
    p.hasActed = false;
    p.status = p.connected && !p.folded ? (p.chips > 0 ? "thinking" : "all-in") : p.status;
  }
  setTurn(room, firstTurnId);
}

function payBlind(room, player, amount, label) {
  const paid = Math.min(player.chips, amount);
  player.chips -= paid;
  player.streetBet += paid;
  player.totalBet += paid;
  room.pot += paid;
  player.status = paid < amount ? `${label} all-in` : label;
  pushLog(room, `${player.name} ${label.toUpperCase()} ${paid}`);
}

function beginHand(room) {
  const connected = getConnectedPlayers(room);
  if (connected.length < MIN_PLAYERS) {
    room.message = "최소 2명이 필요합니다.";
    return false;
  }

  clearNextHandTimer(room.id);
  room.nextHandAt = null;

  room.handNo += 1;
  room.phase = "preflop";
  room.deck = shuffle(createDeck());
  room.board = [];
  room.pot = 0;
  room.winners = [];
  room.currentBet = 0;
  room.minRaise = BIG_BLIND;
  room.turnDeadline = null;
  room.buttonId = null;
  room.smallBlindId = null;
  room.bigBlindId = null;

  for (const p of room.players) {
    if (!p.connected) {
      p.folded = true;
      p.cards = [];
      p.status = "offline";
      p.streetBet = 0;
      p.totalBet = 0;
      p.hasActed = false;
      continue;
    }

    if (p.chips < BIG_BLIND) p.chips = STARTING_CHIPS;
    p.cards = [room.deck.pop(), room.deck.pop()];
    p.folded = false;
    p.streetBet = 0;
    p.totalBet = 0;
    p.hasActed = false;
    p.status = "thinking";
  }

  room.dealerIndex = nextConnectedIndex(room, room.dealerIndex);

  let sbIndex = -1;
  let bbIndex = -1;
  if (connected.length === 2) {
    sbIndex = room.dealerIndex;
    bbIndex = nextConnectedIndex(room, room.dealerIndex);
  } else {
    sbIndex = nextConnectedIndex(room, room.dealerIndex);
    bbIndex = nextConnectedIndex(room, sbIndex);
  }

  if (room.dealerIndex < 0 || sbIndex < 0 || bbIndex < 0) {
    room.phase = "waiting";
    room.message = "플레이어 수가 부족합니다.";
    setTurn(room, null);
    return false;
  }

  const dealer = room.players[room.dealerIndex];
  const sb = room.players[sbIndex];
  const bb = room.players[bbIndex];

  room.buttonId = dealer.id;
  room.smallBlindId = sb.id;
  room.bigBlindId = bb.id;

  payBlind(room, sb, SMALL_BLIND, "sb");
  payBlind(room, bb, BIG_BLIND, "bb");

  room.currentBet = Math.max(room.currentBet, bb.streetBet);

  const firstTurnIndex = connected.length === 2
    ? (canAct(room.players[room.dealerIndex]) ? room.dealerIndex : nextCanActIndex(room, room.dealerIndex))
    : nextCanActIndex(room, bbIndex);

  setTurn(room, firstTurnIndex >= 0 ? room.players[firstTurnIndex].id : null);
  room.message = `핸드 #${room.handNo} 시작`;
  pushLog(room, `Hand #${room.handNo} started (BTN: ${dealer.name})`);
  return true;
}

function normalizeAction(input) {
  if (typeof input === "string") return { type: input, amount: null };
  if (input && typeof input === "object") {
    return {
      type: (input.type || "").toString().toLowerCase(),
      amount: Number.isFinite(Number(input.amount)) ? Number(input.amount) : null,
    };
  }
  return { type: "", amount: null };
}

function actionError(code, message) {
  return { ok: false, code, reason: message };
}

function applyAction(room, playerId, rawAction) {
  const action = normalizeAction(rawAction);
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return actionError("PLAYER_NOT_FOUND", "플레이어를 찾을 수 없습니다.");
  if (!ACTIVE_PHASES.has(room.phase)) return actionError("INVALID_PHASE", "현재 라운드에서는 행동할 수 없습니다.");
  if (room.currentTurn !== playerId) return actionError("NOT_YOUR_TURN", "내 턴이 아닙니다.");
  if (!canAct(p)) return actionError("CANNOT_ACT", "지금은 행동할 수 없습니다.");

  const toCall = Math.max(0, room.currentBet - p.streetBet);

  if (action.type === "fold") {
    p.folded = true;
    p.hasActed = true;
    p.status = "fold";
    room.message = `${p.name} 폴드`;
    pushLog(room, `${p.name} folds`);
    return { ok: true };
  }

  if (action.type === "check") {
    if (toCall !== 0) return actionError("CHECK_NOT_ALLOWED", "체크할 수 없습니다.");
    p.hasActed = true;
    p.status = "check";
    room.message = `${p.name} 체크`;
    pushLog(room, `${p.name} checks`);
    return { ok: true };
  }

  if (action.type === "call") {
    if (toCall === 0) return actionError("NOTHING_TO_CALL", "콜할 금액이 없습니다.");
    if (p.chips < toCall) return actionError("INSUFFICIENT_CHIPS", "칩이 부족합니다. 올인을 사용하세요.");

    p.chips -= toCall;
    p.streetBet += toCall;
    p.totalBet += toCall;
    p.hasActed = true;
    p.status = p.chips === 0 ? "all-in" : "call";

    room.pot += toCall;
    room.message = `${p.name} 콜 ${toCall}`;
    pushLog(room, `${p.name} calls ${toCall}`);
    return { ok: true };
  }

  if (action.type === "bet") {
    if (room.currentBet !== 0) return actionError("BET_NOT_ALLOWED", "이미 베팅이 있습니다. 레이즈를 사용하세요.");
    const amount = Math.max(BIG_BLIND, Math.floor(action.amount || BIG_BLIND));
    if (p.chips < amount) return actionError("INSUFFICIENT_CHIPS", "칩이 부족합니다. 올인을 사용하세요.");

    p.chips -= amount;
    p.streetBet += amount;
    p.totalBet += amount;
    p.hasActed = true;
    p.status = p.chips === 0 ? "all-in" : "bet";

    room.pot += amount;
    room.currentBet = p.streetBet;
    room.minRaise = Math.max(BIG_BLIND, amount);

    for (const o of room.players) {
      if (o.id !== p.id && canAct(o)) o.hasActed = false;
    }

    room.message = `${p.name} 베팅 ${amount}`;
    pushLog(room, `${p.name} bets ${amount}`);
    return { ok: true };
  }

  if (action.type === "raise") {
    if (room.currentBet === 0) return actionError("RAISE_NOT_ALLOWED", "먼저 베팅이 필요합니다.");
    const raiseBy = Math.floor(action.amount || room.minRaise);
    if (raiseBy < room.minRaise) return actionError("RAISE_TOO_SMALL", `최소 레이즈는 ${room.minRaise}입니다.`);

    const totalPut = toCall + raiseBy;
    if (p.chips < totalPut) return actionError("INSUFFICIENT_CHIPS", "칩이 부족합니다. 올인을 사용하세요.");

    p.chips -= totalPut;
    p.streetBet += totalPut;
    p.totalBet += totalPut;
    p.hasActed = true;
    p.status = p.chips === 0 ? "all-in" : "raise";

    room.pot += totalPut;
    room.currentBet = p.streetBet;
    room.minRaise = raiseBy;

    for (const o of room.players) {
      if (o.id !== p.id && canAct(o)) o.hasActed = false;
    }

    room.message = `${p.name} 레이즈 +${raiseBy}`;
    pushLog(room, `${p.name} raises +${raiseBy}`);
    return { ok: true };
  }

  if (action.type === "allin") {
    if (p.chips <= 0) return actionError("INSUFFICIENT_CHIPS", "올인할 칩이 없습니다.");
    const put = p.chips;
    const prevBet = room.currentBet;

    p.chips = 0;
    p.streetBet += put;
    p.totalBet += put;
    p.hasActed = true;
    p.status = "all-in";

    room.pot += put;

    if (p.streetBet > prevBet) {
      const raiseBy = p.streetBet - prevBet;
      room.currentBet = p.streetBet;
      if (raiseBy >= room.minRaise) room.minRaise = raiseBy;

      for (const o of room.players) {
        if (o.id !== p.id && canAct(o)) o.hasActed = false;
      }
    }

    room.message = `${p.name} 올인 ${put}`;
    pushLog(room, `${p.name} all-in ${put}`);
    return { ok: true };
  }

  return actionError("UNKNOWN_ACTION", "알 수 없는 액션입니다.");
}

function isBettingRoundComplete(room) {
  const contenders = getContenders(room);
  if (contenders.length <= 1) return true;

  for (const p of contenders) {
    if (p.chips === 0) continue;
    if (!p.hasActed) return false;
    if (p.streetBet !== room.currentBet) return false;
  }
  return true;
}

function firstPostflopTurnId(room) {
  const buttonIdx = indexOfPlayer(room, room.buttonId);
  const firstIdx = nextCanActIndex(room, buttonIdx);
  return firstIdx >= 0 ? room.players[firstIdx].id : null;
}

function dealCommunity(room, count) {
  for (let i = 0; i < count; i += 1) room.board.push(room.deck.pop());
}

function clockwiseOrder(room) {
  const btnIdx = indexOfPlayer(room, room.buttonId);
  const ordered = [];
  for (let i = 1; i <= room.players.length; i += 1) {
    const idx = (btnIdx + i + room.players.length) % room.players.length;
    ordered.push(room.players[idx].id);
  }
  return ordered;
}

function showdown(room) {
  const contribPlayers = room.players.filter((p) => p.totalBet > 0);
  const activeByShowdown = contribPlayers.filter((p) => !p.folded);

  if (!activeByShowdown.length) {
    room.phase = "result";
    setTurn(room, null);
    room.turnDeadline = null;
    room.nextHandAt = null;
    room.message = "쇼다운 대상이 없습니다.";
    return;
  }

  const scores = new Map();
  for (const p of activeByShowdown) {
    scores.set(p.id, bestOfSeven([...p.cards, ...room.board]));
  }

  const levels = [...new Set(contribPlayers.map((p) => p.totalBet))].sort((a, b) => a - b);
  const payouts = new Map(room.players.map((p) => [p.id, 0]));
  const clock = clockwiseOrder(room);

  let prev = 0;
  for (const level of levels) {
    const participants = contribPlayers.filter((p) => p.totalBet >= level);
    const sidePot = (level - prev) * participants.length;
    prev = level;

    const eligible = participants.filter((p) => !p.folded);
    if (!eligible.length || sidePot <= 0) continue;

    eligible.sort((a, b) => compareEval(scores.get(b.id), scores.get(a.id)));
    const best = scores.get(eligible[0].id);
    const winners = eligible.filter((p) => compareEval(scores.get(p.id), best) === 0);

    const winnersClock = [...winners].sort((a, b) => clock.indexOf(a.id) - clock.indexOf(b.id));

    const base = Math.floor(sidePot / winnersClock.length);
    let rem = sidePot % winnersClock.length;

    const paidWinners = [];
    for (const w of winnersClock) {
      const extra = rem > 0 ? 1 : 0;
      if (rem > 0) rem -= 1;
      const gain = base + extra;
      payouts.set(w.id, payouts.get(w.id) + gain);
      paidWinners.push(`${w.name}+${gain}`);
    }

    pushLog(room, `Side pot ${sidePot} -> ${paidWinners.join(" ")}`);
  }

  room.winners = [];
  for (const p of room.players) {
    const gain = payouts.get(p.id) || 0;
    if (gain > 0) {
      p.chips += gain;
      room.winners.push({ id: p.id, name: p.name, amount: gain, hand: scores.get(p.id)?.name || "-" });
    }
  }

  room.phase = "result";
  setTurn(room, null);
  room.turnDeadline = null;
  room.message = `쇼다운: ${room.winners.map((w) => `${w.name} +${w.amount}`).join(", ")}`;
  pushLog(room, room.message);
}

function advancePhase(room) {
  const contenders = getContenders(room);
  if (contenders.length <= 1) {
    const winner = contenders[0];
    if (winner) {
      winner.chips += room.pot;
      room.winners = [{ id: winner.id, name: winner.name, amount: room.pot, hand: "상대 폴드" }];
      room.message = `${winner.name} 승리 (상대 폴드)`;
      pushLog(room, `${winner.name} wins ${room.pot} (all folded)`);
    }
    room.phase = "result";
    setTurn(room, null);
    room.turnDeadline = null;
    return;
  }

  if (room.phase === "preflop") {
    room.phase = "flop";
    dealCommunity(room, 3);
    resetStreet(room, firstPostflopTurnId(room));
    room.message = "플랍 공개";
    pushLog(room, "Flop dealt");
    return;
  }
  if (room.phase === "flop") {
    room.phase = "turn";
    dealCommunity(room, 1);
    resetStreet(room, firstPostflopTurnId(room));
    room.message = "턴 공개";
    pushLog(room, "Turn dealt");
    return;
  }
  if (room.phase === "turn") {
    room.phase = "river";
    dealCommunity(room, 1);
    resetStreet(room, firstPostflopTurnId(room));
    room.message = "리버 공개";
    pushLog(room, "River dealt");
    return;
  }
  if (room.phase === "river") {
    room.phase = "showdown";
    showdown(room);
  }
}

function progressGame(room) {
  while (ACTIVE_PHASES.has(room.phase)) {
    const contenders = getContenders(room);
    if (contenders.length <= 1) {
      advancePhase(room);
      return;
    }

    const anyActor = room.players.some((p) => canAct(p));
    if (!anyActor || isBettingRoundComplete(room)) {
      advancePhase(room);
      continue;
    }

    const current = room.players.find((p) => p.id === room.currentTurn);
    if (!current || !canAct(current)) {
      moveTurnToNext(room);
      continue;
    }

    return;
  }
}

function roomStateFor(room, viewerId) {
  return {
    id: room.id,
    phase: room.phase,
    handNo: room.handNo,
    pot: room.pot,
    board: room.board,
    currentTurn: room.currentTurn,
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    turnDeadline: room.turnDeadline,
    nextHandAt: room.nextHandAt,

    buttonId: room.buttonId,
    smallBlindId: room.smallBlindId,
    bigBlindId: room.bigBlindId,

    hostId: room.hostId,
    message: room.message,
    winners: room.winners,
    actionLog: room.actionLog,

    settings: room.settings,
    seatCount: room.players.filter((p) => p.connected).length,
    maxPlayers: MAX_PLAYERS,

    spectators: room.spectators.filter((s) => s.connected).map((s) => ({ id: s.id, name: s.name })),

    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      chips: p.chips,
      folded: p.folded,
      connected: p.connected,
      status: p.status,
      streetBet: p.streetBet,
      totalBet: p.totalBet,
      cards: p.id === viewerId || room.phase === "result" ? p.cards : [{ code: "??" }, { code: "??" }],
    })),
  };
}

function emitRoom(io, room) {
  for (const p of room.players) {
    if (p.connected && !p.isBot) io.to(p.id).emit("room_state", roomStateFor(room, p.id));
  }
  for (const s of room.spectators) {
    if (s.connected) io.to(s.id).emit("room_state", roomStateFor(room, s.id));
  }
}

function scheduleTurnTimeout(io, room) {
  clearTurnTimer(room.id);

  if (!ACTIVE_PHASES.has(room.phase) || !room.currentTurn) {
    room.turnDeadline = null;
    return;
  }

  const current = room.players.find((p) => p.id === room.currentTurn);
  if (!current) {
    room.turnDeadline = null;
    return;
  }

  const timeoutSec = Math.max(5, Math.min(60, Number(room.settings.turnTimeoutSec) || DEFAULT_TURN_TIMEOUT_SEC));
  room.turnDeadline = Date.now() + timeoutSec * 1000;
  const token = room.turnToken;

  if (current.isBot) return;

  const timer = setTimeout(() => {
    const r = rooms.get(room.id);
    if (!r) return;
    if (!ACTIVE_PHASES.has(r.phase)) return;
    if (r.currentTurn !== current.id) return;
    if (r.turnToken !== token) return;

    applyAction(r, current.id, { type: "fold" });
    moveTurnToNext(r);
    progressGame(r);
    emitRoom(io, r);
    scheduleTurnTimeout(io, r);
    maybeBotAct(io, r);
    scheduleAutoNextHand(io, r);
  }, timeoutSec * 1000);

  turnTimers.set(room.id, timer);
}

function scheduleAutoNextHand(io, room) {
  clearNextHandTimer(room.id);

  if (room.phase !== "result" || !asBool(room.settings.autoStart)) {
    room.nextHandAt = null;
    return;
  }

  const connected = getConnectedPlayers(room);
  if (connected.length < MIN_PLAYERS) {
    room.nextHandAt = null;
    return;
  }

  const sec = Math.max(3, Math.min(20, Number(room.settings.autoNextHandSec) || DEFAULT_AUTO_NEXT_HAND_SEC));
  room.nextHandAt = Date.now() + sec * 1000;

  const timer = setTimeout(() => {
    const r = rooms.get(room.id);
    if (!r || r.phase !== "result") return;
    const ok = beginHand(r);
    if (!ok) {
      emitRoom(io, r);
      return;
    }
    progressGame(r);
    emitRoom(io, r);
    scheduleTurnTimeout(io, r);
    maybeBotAct(io, r);
  }, sec * 1000);

  nextHandTimers.set(room.id, timer);
}

function maybeBotAct(io, room) {
  if (!ACTIVE_PHASES.has(room.phase) || !room.currentTurn) return;

  const current = room.players.find((p) => p.id === room.currentTurn);
  if (!current || !current.isBot || !canAct(current)) return;

  const token = room.turnToken;

  setTimeout(() => {
    const r = rooms.get(room.id);
    if (!r || !ACTIVE_PHASES.has(r.phase) || !r.currentTurn) return;
    if (r.currentTurn !== current.id || r.turnToken !== token) return;

    const me = r.players.find((p) => p.id === current.id);
    if (!me) return;

    const toCall = Math.max(0, r.currentBet - me.streetBet);
    const ranks = me.cards.map((c) => c.rank).sort((a, b) => b - a);
    const strong = ranks[0] >= 13 || ranks[0] === ranks[1];

    let action = { type: "check" };
    if (toCall > 0) {
      if (!strong && toCall >= BIG_BLIND * 2 && Math.random() < 0.25) {
        action = { type: "fold" };
      } else if (me.chips <= toCall) {
        action = { type: "allin" };
      } else if (strong && me.chips > toCall + r.minRaise && Math.random() < 0.25) {
        action = { type: "raise", amount: r.minRaise };
      } else {
        action = { type: "call" };
      }
    } else if (strong && me.chips >= BIG_BLIND * 2 && Math.random() < 0.35) {
      action = { type: "bet", amount: BIG_BLIND * 2 };
    }

    const result = applyAction(r, me.id, action);
    if (!result.ok) {
      applyAction(r, me.id, toCall > 0 ? { type: "call" } : { type: "check" });
    }

    moveTurnToNext(r);
    progressGame(r);
    emitRoom(io, r);
    scheduleTurnTimeout(io, r);
    maybeBotAct(io, r);
    scheduleAutoNextHand(io, r);
  }, 700 + Math.floor(Math.random() * 400));
}

function emitError(socket, code, message) {
  socket.emit("error_message", { code, message });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

io.on("connection", (socket) => {
  socket.on("join_room", (payload = {}) => {
    const roomId = (payload.roomId || randomId(6)).toUpperCase();
    const name = cleanName(payload.name);

    const room = getRoom(roomId);
    socket.join(roomId);

    if (room.players.some((p) => p.id === socket.id) || room.spectators.some((s) => s.id === socket.id)) {
      socket.emit("joined", { roomId, playerId: socket.id, role: "player" });
      emitRoom(io, room);
      return;
    }

    const seatedCount = room.players.filter((p) => p.connected).length;
    const handRunning = ACTIVE_PHASES.has(room.phase);
    const shouldSpectate = handRunning || asBool(room.settings.locked) || seatedCount >= MAX_PLAYERS;

    if (shouldSpectate) {
      room.spectators.push(makeSpectator({ id: socket.id, name }));
      socket.emit("joined", { roomId, playerId: socket.id, role: "spectator" });
      pushLog(room, `${name} joined as spectator`);
      emitRoom(io, room);
      return;
    }

    const p = makePlayer({ id: socket.id, name, isBot: false });
    room.players.push(p);
    if (!room.hostId) room.hostId = socket.id;

    socket.emit("joined", { roomId, playerId: socket.id, role: "player" });
    pushLog(room, `${name} joined table`);
    emitRoom(io, room);
  });

  socket.on("sit_in", ({ roomId } = {}) => {
    const room = rooms.get((roomId || "").toUpperCase());
    if (!room) return;

    const spec = room.spectators.find((s) => s.id === socket.id && s.connected);
    if (!spec) return;

    if (ACTIVE_PHASES.has(room.phase)) {
      emitError(socket, "HAND_RUNNING", "핸드 진행 중이라 다음 핸드부터 착석할 수 있습니다.");
      return;
    }
    if (asBool(room.settings.locked)) {
      emitError(socket, "ROOM_LOCKED", "현재 방이 잠겨 있습니다.");
      return;
    }
    if (room.players.filter((p) => p.connected).length >= MAX_PLAYERS) {
      emitError(socket, "TABLE_FULL", "테이블이 가득 찼습니다.");
      return;
    }

    room.spectators = room.spectators.filter((s) => s.id !== socket.id);
    room.players.push(makePlayer({ id: socket.id, name: spec.name, isBot: false }));
    pushLog(room, `${spec.name} sits in`);

    if (!room.hostId) room.hostId = socket.id;

    socket.emit("joined", { roomId: room.id, playerId: socket.id, role: "player" });
    emitRoom(io, room);
  });

  socket.on("update_settings", ({ roomId, settings } = {}) => {
    const room = rooms.get((roomId || "").toUpperCase());
    if (!room || room.hostId !== socket.id) return;

    if (settings && typeof settings === "object") {
      if (Object.prototype.hasOwnProperty.call(settings, "locked")) {
        room.settings.locked = asBool(settings.locked);
      }
      if (Object.prototype.hasOwnProperty.call(settings, "autoStart")) {
        room.settings.autoStart = asBool(settings.autoStart);
      }
    }

    pushLog(room, `Settings updated (locked=${room.settings.locked}, autoStart=${room.settings.autoStart})`);
    emitRoom(io, room);
    scheduleAutoNextHand(io, room);
  });

  socket.on("rebuy", ({ roomId } = {}) => {
    const room = rooms.get((roomId || "").toUpperCase());
    if (!room) return;

    const p = room.players.find((x) => x.id === socket.id);
    if (!p) {
      emitError(socket, "SPECTATOR_CANNOT_REBUY", "관전자는 리바이할 수 없습니다.");
      return;
    }
    if (ACTIVE_PHASES.has(room.phase)) {
      emitError(socket, "HAND_RUNNING", "핸드 진행 중에는 리바이할 수 없습니다.");
      return;
    }

    const amount = Math.max(100, Math.min(5000, Number(room.settings.rebuyAmount) || DEFAULT_REBUY_AMOUNT));
    if (p.chips >= MAX_CHIPS) {
      emitError(socket, "MAX_CHIPS_REACHED", "최대 칩 보유량에 도달했습니다.");
      return;
    }

    const gain = Math.min(amount, MAX_CHIPS - p.chips);
    p.chips += gain;
    pushLog(room, `${p.name} rebuys +${gain}`);
    room.message = `${p.name} 리바이 +${gain}`;
    emitRoom(io, room);
  });
  socket.on("add_bot", ({ roomId } = {}) => {
    const room = rooms.get((roomId || "").toUpperCase());
    if (!room) return;
    if (room.hostId !== socket.id) {
      emitError(socket, "NOT_HOST", "방장만 봇을 추가할 수 있습니다.");
      return;
    }
    if (ACTIVE_PHASES.has(room.phase)) {
      emitError(socket, "HAND_RUNNING", "핸드 진행 중에는 봇을 추가할 수 없습니다.");
      return;
    }
    if (room.players.filter((p) => p.connected).length >= MAX_PLAYERS) {
      emitError(socket, "TABLE_FULL", "테이블이 가득 찼습니다.");
      return;
    }

    const bot = makePlayer({ id: `bot-${Date.now()}-${Math.floor(Math.random() * 10000)}`, name: `BOT-${room.players.length + 1}`, isBot: true });
    room.players.push(bot);
    pushLog(room, `${bot.name} added`);

    emitRoom(io, room);
  });

  socket.on("start_hand", ({ roomId } = {}) => {
    const room = rooms.get((roomId || "").toUpperCase());
    if (!room) return;
    if (room.hostId !== socket.id) {
      emitError(socket, "NOT_HOST", "방장만 핸드를 시작할 수 있습니다.");
      return;
    }
    if (ACTIVE_PHASES.has(room.phase)) {
      emitError(socket, "HAND_RUNNING", "이미 핸드가 진행 중입니다.");
      return;
    }

    const ok = beginHand(room);
    if (!ok) {
      emitRoom(io, room);
      return;
    }

    progressGame(room);
    emitRoom(io, room);
    scheduleTurnTimeout(io, room);
    maybeBotAct(io, room);
  });

  socket.on("action", ({ roomId, action, actionSeq } = {}) => {
    const room = rooms.get((roomId || "").toUpperCase());
    if (!room) return;
    if (!ACTIVE_PHASES.has(room.phase)) return;

    const p = room.players.find((x) => x.id === socket.id);
    if (!p) {
      emitError(socket, "SPECTATOR_CANNOT_ACT", "관전자는 액션할 수 없습니다.");
      return;
    }

    const seq = Number.isFinite(Number(actionSeq)) ? Number(actionSeq) : null;
    if (seq !== null && seq <= p.lastActionSeq) {
      emitError(socket, "DUPLICATE_ACTION", "중복 액션은 무시되었습니다.");
      return;
    }

    const result = applyAction(room, socket.id, action);
    if (!result.ok) {
      emitError(socket, result.code || "ACTION_ERROR", result.reason || "액션 실패");
      return;
    }

    if (seq !== null) p.lastActionSeq = seq;

    moveTurnToNext(room);
    progressGame(room);
    emitRoom(io, room);
    scheduleTurnTimeout(io, room);
    maybeBotAct(io, room);
    scheduleAutoNextHand(io, room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const p = room.players.find((x) => x.id === socket.id);
      if (p) {
        p.connected = false;
        p.status = "offline";

        if (ACTIVE_PHASES.has(room.phase) && !p.folded) {
          p.folded = true;
          pushLog(room, `${p.name} disconnected -> auto fold`);
        }

        if (room.hostId === socket.id) {
          const nextHost = room.players.find((x) => x.connected && !x.isBot);
          room.hostId = nextHost ? nextHost.id : null;
        }

        if (room.currentTurn === socket.id) moveTurnToNext(room);

        progressGame(room);
        emitRoom(io, room);
        scheduleTurnTimeout(io, room);
        maybeBotAct(io, room);
        scheduleAutoNextHand(io, room);
      }

      const s = room.spectators.find((x) => x.id === socket.id);
      if (s) {
        s.connected = false;
        room.spectators = room.spectators.filter((x) => x.connected);
        emitRoom(io, room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hold'em director build running on http://localhost:${PORT}`);
});





