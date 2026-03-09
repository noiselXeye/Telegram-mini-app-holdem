const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const socket = io();

let myId = null;
let roomId = null;
let myRole = "spectator";
let latestState = null;
let timerTick = null;
let actionSeq = 0;
let prevBoardCount = 0;
let prevHandNo = 0;

const ACTIVE_PHASES = new Set(["preflop", "flop", "turn", "river"]);

const roomInput = document.getElementById("roomInput");
const joinBtn = document.getElementById("joinBtn");
const copyBtn = document.getElementById("copyBtn");
const startBtn = document.getElementById("startBtn");
const botBtn = document.getElementById("botBtn");
const sitInBtn = document.getElementById("sitInBtn");
const rebuyBtn = document.getElementById("rebuyBtn");

const checkBtn = document.getElementById("checkBtn");
const callBtn = document.getElementById("callBtn");
const betBtn = document.getElementById("betBtn");
const raiseInput = document.getElementById("raiseInput");
const raiseBtn = document.getElementById("raiseBtn");
const allinBtn = document.getElementById("allinBtn");
const foldBtn = document.getElementById("foldBtn");

const lockedToggle = document.getElementById("lockedToggle");
const autoStartToggle = document.getElementById("autoStartToggle");
const rebuyAmountInput = document.getElementById("rebuyAmountInput");

const phaseBadge = document.getElementById("phaseBadge");
const potValue = document.getElementById("potValue");
const currentBetNode = document.getElementById("currentBet");
const minRaiseNode = document.getElementById("minRaise");
const seatInfoNode = document.getElementById("seatInfo");
const turnText = document.getElementById("turnText");
const timerText = document.getElementById("timerText");
const nextHandText = document.getElementById("nextHandText");
const boardCards = document.getElementById("boardCards");
const playersNode = document.getElementById("players");
const spectatorsNode = document.getElementById("spectators");
const messageNode = document.getElementById("message");
const winnersNode = document.getElementById("winners");
const actionLogNode = document.getElementById("actionLog");
const networkBanner = document.getElementById("networkBanner");

const themeBtns = Array.from(document.querySelectorAll(".theme-btn"));

const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RED_SUITS = new Set(["H", "D"]);

const playerNodeMap = new Map();
const boardCardEls = [];

function getDisplayName() {
  const user = tg?.initDataUnsafe?.user;
  if (!user) return "Guest";
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || user.username || `User${user.id}`;
}

function parseCardCode(code) {
  if (!code || code === "??") return null;
  const suit = code.slice(-1);
  const rank = code.slice(0, -1);
  if (!SUIT_SYMBOL[suit] || !rank) return null;
  return { rank, suit, symbol: SUIT_SYMBOL[suit], isRed: RED_SUITS.has(suit) };
}

function cardEl(code) {
  const div = document.createElement("div");
  div.className = "card";
  setCardContent(div, code);
  return div;
}

function setCardContent(node, code) {
  node.className = "card";
  node.dataset.code = code;

  if (code === "??") {
    node.classList.add("back");
    node.innerHTML = '<div class="card-back-mark">♠</div>';
    return;
  }

  const parsed = parseCardCode(code);
  if (!parsed) {
    node.textContent = code;
    return;
  }

  node.dataset.rank = parsed.rank;
  node.dataset.suit = parsed.suit;
  if (parsed.isRed) node.classList.add("red");
  node.innerHTML = `
    <div class="corner top"><span>${parsed.rank}</span><span>${parsed.symbol}</span></div>
    <div class="pip">${parsed.symbol}</div>
    <div class="corner bottom"><span>${parsed.rank}</span><span>${parsed.symbol}</span></div>
  `;
}

function setActionButtons(enabled) {
  [checkBtn, callBtn, betBtn, raiseBtn, allinBtn, foldBtn].forEach((b) => {
    b.disabled = !enabled;
  });
}

function playerMe(state) {
  return state.players.find((p) => p.id === myId);
}

function toCall(state, me) {
  return Math.max(0, state.currentBet - me.streetBet);
}

function setStatusText(text) {
  messageNode.textContent = text;
}

function chosenAmount(state) {
  const min = state?.minRaise || 20;
  return Math.max(min, Number(raiseInput.value) || min);
}

function updateActionButtons(state) {
  const me = playerMe(state);
  const myTurn = state.currentTurn === myId;

  if (!me || myRole !== "player") {
    setActionButtons(false);
    return;
  }

  rebuyBtn.disabled = ACTIVE_PHASES.has(state.phase);

  if (!myTurn || me.folded || !me.connected || me.chips <= 0) {
    setActionButtons(false);
    return;
  }

  setActionButtons(true);

  const callAmt = toCall(state, me);
  const amount = chosenAmount(state);

  checkBtn.disabled = callAmt !== 0;
  callBtn.disabled = callAmt === 0 || me.chips < callAmt;
  betBtn.disabled = state.currentBet !== 0 || me.chips < amount;
  raiseBtn.disabled = state.currentBet === 0 || amount < (state.minRaise || 20) || me.chips < callAmt + amount;
}

function positionTag(state, id) {
  if (state.buttonId === id) return "BTN";
  if (state.smallBlindId === id) return "SB";
  if (state.bigBlindId === id) return "BB";
  return "";
}

function renderTimer() {
  if (!latestState) return;

  if (!latestState.turnDeadline) {
    timerText.textContent = "타이머: -";
  } else {
    const sec = Math.max(0, Math.ceil((latestState.turnDeadline - Date.now()) / 1000));
    timerText.textContent = `타이머: ${sec}s`;
  }

  if (!latestState.nextHandAt) {
    nextHandText.textContent = "다음 핸드: -";
  } else {
    const sec = Math.max(0, Math.ceil((latestState.nextHandAt - Date.now()) / 1000));
    nextHandText.textContent = `다음 핸드: ${sec}s`;
  }
}

function ensureBoardSlots() {
  if (boardCardEls.length) return;
  for (let i = 0; i < 5; i += 1) {
    const el = cardEl("??");
    boardCardEls.push(el);
    boardCards.appendChild(el);
  }
}

function updateBoard(state) {
  ensureBoardSlots();

  const revealFrom = state.board.length > prevBoardCount || state.handNo !== prevHandNo
    ? prevBoardCount
    : 999;

  for (let i = 0; i < 5; i += 1) {
    const code = state.board[i]?.code || "??";
    const el = boardCardEls[i];
    if (el.dataset.code !== code || state.handNo !== prevHandNo) {
      setCardContent(el, code);
      if (i >= revealFrom && code !== "??") {
        el.classList.add("deal");
        el.style.animationDelay = `${i * 70}ms`;
      }
    }
  }

  prevBoardCount = state.board.length;
  prevHandNo = state.handNo;
}

function createPlayerNode(playerId) {
  const root = document.createElement("div");
  root.className = "player";
  root.dataset.playerId = playerId;

  const header = document.createElement("div");
  header.className = "player-header";

  const nameStrong = document.createElement("strong");
  const chipsSpan = document.createElement("span");
  header.appendChild(nameStrong);
  header.appendChild(chipsSpan);

  const meta = document.createElement("div");
  meta.className = "player-meta";

  const cards = document.createElement("div");
  cards.className = "cards hand-cards";
  cards.appendChild(cardEl("??"));
  cards.appendChild(cardEl("??"));

  root.appendChild(header);
  root.appendChild(meta);
  root.appendChild(cards);

  return { root, nameStrong, chipsSpan, meta, cards };
}

function updatePlayerNode(bundle, p, state, winnerSet) {
  bundle.root.classList.toggle("me", p.id === myId);
  bundle.root.classList.toggle("turn", p.id === state.currentTurn);
  bundle.root.classList.toggle("winner", winnerSet.has(p.id));

  const pos = positionTag(state, p.id);
  const who = `${p.name}${p.isBot ? " (BOT)" : ""}${p.id === myId ? " (ME)" : ""}`;
  bundle.nameStrong.innerHTML = `${who} ${pos ? `<span class="pos">${pos}</span>` : ""}`;
  bundle.chipsSpan.textContent = `${p.chips} chips`;
  bundle.meta.textContent = `${p.folded ? "폴드" : p.status} / street ${p.streetBet} / total ${p.totalBet}`;

  bundle.cards.classList.toggle("winner-hand", winnerSet.has(p.id));

  const cards = p.cards || [{ code: "??" }, { code: "??" }];
  const c0 = cards[0]?.code || "??";
  const c1 = cards[1]?.code || "??";
  const first = bundle.cards.children[0];
  const second = bundle.cards.children[1];

  if (first.dataset.code !== c0 || state.handNo !== prevHandNo) {
    setCardContent(first, c0);
    first.classList.add("hand-card");
    first.style.animationDelay = "0ms";
  }
  if (second.dataset.code !== c1 || state.handNo !== prevHandNo) {
    setCardContent(second, c1);
    second.classList.add("hand-card");
    second.style.animationDelay = "45ms";
  }
}

function updatePlayers(state) {
  const winnerSet = new Set((state.winners || []).map((w) => w.id));
  const activeIds = new Set();

  state.players.forEach((p, idx) => {
    activeIds.add(p.id);
    if (!playerNodeMap.has(p.id)) {
      playerNodeMap.set(p.id, createPlayerNode(p.id));
    }

    const bundle = playerNodeMap.get(p.id);
    updatePlayerNode(bundle, p, state, winnerSet);

    const currentAtIdx = playersNode.children[idx] || null;

    // Prevent full detach/reattach every render to reduce hand-card flicker.
    if (bundle.root.parentNode !== playersNode) {
      playersNode.insertBefore(bundle.root, currentAtIdx);
    } else if (currentAtIdx !== bundle.root) {
      playersNode.insertBefore(bundle.root, currentAtIdx);
    }
  });

  for (const [pid, bundle] of playerNodeMap.entries()) {
    if (!activeIds.has(pid)) {
      bundle.root.remove();
      playerNodeMap.delete(pid);
    }
  }
}

function render(state) {
  latestState = state;

  phaseBadge.textContent = state.phase;
  potValue.textContent = state.pot;
  currentBetNode.textContent = state.currentBet;
  minRaiseNode.textContent = state.minRaise;
  seatInfoNode.textContent = `${state.seatCount}/${state.maxPlayers}`;

  const turnPlayer = state.players.find((p) => p.id === state.currentTurn);
  turnText.textContent = turnPlayer ? `턴: ${turnPlayer.name}` : "턴: -";

  updateBoard(state);
  updatePlayers(state);

  const specs = state.spectators || [];
  spectatorsNode.textContent = specs.length ? `관전자: ${specs.map((s) => s.name).join(", ")}` : "관전자 없음";

  const me = playerMe(state);
  const callAmt = me ? toCall(state, me) : 0;
  const amount = chosenAmount(state);
  checkBtn.textContent = callAmt === 0 ? "체크" : "체크 불가";
  callBtn.textContent = `콜${callAmt > 0 ? ` (${callAmt})` : ""}`;
  betBtn.textContent = `베팅 (${amount})`;
  raiseBtn.textContent = `레이즈 (+${amount})`;

  const canSit = myRole === "spectator" && !ACTIVE_PHASES.has(state.phase);
  sitInBtn.disabled = !canSit;

  const isHost = state.hostId === myId;
  startBtn.disabled = !isHost;
  botBtn.disabled = !isHost;
  lockedToggle.disabled = !isHost;
  autoStartToggle.disabled = !isHost;
  rebuyAmountInput.disabled = !isHost;

  lockedToggle.checked = !!state.settings?.locked;
  autoStartToggle.checked = !!state.settings?.autoStart;
  rebuyAmountInput.value = String(state.settings?.rebuyAmount || 1000);

  rebuyBtn.disabled = myRole !== "player" || ACTIVE_PHASES.has(state.phase);

  setStatusText(state.message || "-");

  winnersNode.textContent = state.winners?.length
    ? `승자: ${state.winners.map((w) => `${w.name} (${w.hand}) +${w.amount}`).join(" / ")}`
    : "";

  actionLogNode.textContent = (state.actionLog || []).slice(-20).join("\n");

  if (!timerTick) timerTick = setInterval(renderTimer, 250);
  renderTimer();
  updateActionButtons(state);
}

function joinRoom() {
  const fromQuery = new URLSearchParams(location.search).get("room");
  const entered = roomInput.value.trim().toUpperCase();
  const picked = entered || fromQuery || "";

  socket.emit("join_room", {
    roomId: picked,
    name: getDisplayName(),
  });
}

function sendAction(action) {
  if (!roomId) return;
  actionSeq += 1;
  socket.emit("action", { roomId, action, actionSeq });
}

joinBtn.addEventListener("click", joinRoom);

copyBtn.addEventListener("click", async () => {
  if (!roomId) return;
  const url = `${location.origin}?room=${encodeURIComponent(roomId)}`;
  await navigator.clipboard.writeText(url);
  setStatusText("초대 링크를 복사했습니다.");
});

startBtn.addEventListener("click", () => {
  if (!roomId) return;
  socket.emit("start_hand", { roomId });
});

botBtn.addEventListener("click", () => {
  if (!roomId) return;
  socket.emit("add_bot", { roomId });
});

sitInBtn.addEventListener("click", () => {
  if (!roomId) return;
  socket.emit("sit_in", { roomId });
});

rebuyBtn.addEventListener("click", () => {
  if (!roomId) return;
  socket.emit("rebuy", { roomId });
});

checkBtn.addEventListener("click", () => sendAction({ type: "check" }));
callBtn.addEventListener("click", () => sendAction({ type: "call" }));
betBtn.addEventListener("click", () => sendAction({ type: "bet", amount: chosenAmount(latestState || { minRaise: 20 }) }));
raiseBtn.addEventListener("click", () => {
  const amount = chosenAmount(latestState || { minRaise: 20 });
  sendAction({ type: "raise", amount });
});
allinBtn.addEventListener("click", () => sendAction({ type: "allin" }));
foldBtn.addEventListener("click", () => sendAction({ type: "fold" }));

raiseInput.addEventListener("input", () => {
  if (latestState) {
    const min = latestState.minRaise || 20;
    if ((Number(raiseInput.value) || 0) < min) raiseInput.value = String(min);
    updateActionButtons(latestState);
  }
});

function emitSettings() {
  if (!roomId) return;
  socket.emit("update_settings", {
    roomId,
    settings: {
      locked: lockedToggle.checked,
      autoStart: autoStartToggle.checked,
      rebuyAmount: Number(rebuyAmountInput.value) || 1000,
    },
  });
}

lockedToggle.addEventListener("change", emitSettings);
autoStartToggle.addEventListener("change", emitSettings);
rebuyAmountInput.addEventListener("change", emitSettings);

themeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = btn.dataset.theme || "classic";
    document.body.dataset.deckTheme = theme;
    localStorage.setItem("deckTheme", theme);
  });
});

socket.on("joined", ({ roomId: rid, playerId, role }) => {
  roomId = rid;
  myId = playerId;
  myRole = role || "player";

  roomInput.value = roomId;
  const next = new URL(location.href);
  next.searchParams.set("room", roomId);
  history.replaceState({}, "", next.toString());

  prevBoardCount = 0;
  prevHandNo = 0;
  playerNodeMap.clear();
  playersNode.innerHTML = "";
  boardCards.innerHTML = "";
  boardCardEls.length = 0;

  setStatusText(`방 ${roomId} 입장 완료 (${myRole === "player" ? "플레이어" : "관전자"})`);
});

socket.on("room_state", render);

socket.on("error_message", (err) => {
  if (!err) return;
  if (typeof err === "string") {
    setStatusText(`오류: ${err}`);
    return;
  }
  setStatusText(`오류[${err.code || "UNKNOWN"}]: ${err.message || "실패"}`);
});

socket.on("disconnect", () => {
  networkBanner.classList.remove("hidden");
});

socket.on("connect", () => {
  networkBanner.classList.add("hidden");
  if (roomId) joinRoom();
});

const savedTheme = localStorage.getItem("deckTheme") || "classic";
document.body.dataset.deckTheme = savedTheme;

const qRoom = new URLSearchParams(location.search).get("room");
if (qRoom) roomInput.value = qRoom.toUpperCase();
setActionButtons(false);



