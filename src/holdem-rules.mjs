// Pure Hold'em rules. The room adapter owns randomness, card placement and permissions.
export class HoldemError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (message, code = "HOLDEM_RULE", status = 409) => { throw new HoldemError(code, message, status); };
const phases = ["waiting", "preflop", "flop", "turn", "river", "complete"];
const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const handNames = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"];
const chips = (value, label, min = 0, max = 8_000_000) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}需要是 ${min}–${max} 的整数。`, "INVALID_HOLDEM", 400);
  return value;
};
const betweenHands = (state) => ["waiting", "complete"].includes(state.phase);
const contenders = (state) => state.players.filter((player) => player.holeCards.length === 2 && player.status !== "folded");
const activePlayers = (state) => contenders(state).filter((player) => player.status === "active" && player.stack > 0);
const clockwise = (players, seat) => [...players].sort((a, b) => ((a.seatIndex - seat + 8) % 8 || 8) - ((b.seatIndex - seat + 8) % 8 || 8));

export function createHoldemPack() {
  const suits = [["hearts", "红桃", "♥"], ["diamonds", "方块", "♦"], ["clubs", "梅花", "♣"], ["spades", "黑桃", "♠"]];
  return { $schema: "./pack.schema.json", id: "holdem-52", name: "德州扑克 · 52 张", tableTitle: "德州牌桌", version: 1,
    cardBack: { label: "PARLOR", theme: "classic", color: "#315d47" }, die: { label: "公共 D6", sides: 6 },
    cards: suits.flatMap(([suit, name, symbol], index) => ranks.map((rank) => ({ key: `${suit}-${rank.toLowerCase()}`, label: `${name} ${rank}`, rank, suit, symbol, tone: index < 2 ? "red" : "black" })) ) };
}

export function compareHoldemRanks(left, right) {
  for (let index = 0; index < Math.max(left.score.length, right.score.length); index++) {
    const difference = (left.score[index] || 0) - (right.score[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function rankFive(cards) {
  const values = cards.map((card) => ranks.indexOf(card.rank) + 2).sort((a, b) => b - a);
  const unique = [...new Set(values)];
  let straight = unique.length === 5 && unique[0] - unique[4] === 4 ? unique[0] : 0;
  if (unique.join(",") === "14,5,4,3,2") straight = 5;
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const groups = [...new Set(values)].map((rank) => ({ rank, count: values.filter((value) => value === rank).length }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  let score;
  if (flush && straight) score = [8, straight];
  else if (groups[0].count === 4) score = [7, groups[0].rank, groups[1].rank];
  else if (groups[0].count === 3 && groups[1].count === 2) score = [6, groups[0].rank, groups[1].rank];
  else if (flush) score = [5, ...values];
  else if (straight) score = [4, straight];
  else if (groups[0].count === 3) score = [3, groups[0].rank, ...groups.slice(1).map((group) => group.rank)];
  else if (groups[0].count === 2 && groups[1].count === 2) score = [2, groups[0].rank, groups[1].rank, groups[2].rank];
  else if (groups[0].count === 2) score = [1, groups[0].rank, ...groups.slice(1).map((group) => group.rank)];
  else score = [0, ...values];
  return { score, name: handNames[score[0]] };
}

export function evaluateHoldem(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7 || cards.some((card) => !card || !ranks.includes(card.rank) || !["hearts", "diamonds", "clubs", "spades"].includes(card.suit))
    || new Set(cards.map((card) => `${card.rank}:${card.suit}`)).size !== cards.length) fail("摊牌需要 5–7 张不重复的标准扑克牌。", "INVALID_HOLDEM", 400);
  let best = null;
  for (let a = 0; a < cards.length - 4; a++) for (let b = a + 1; b < cards.length - 3; b++) for (let c = b + 1; c < cards.length - 2; c++) for (let d = c + 1; d < cards.length - 1; d++) for (let e = d + 1; e < cards.length; e++) {
    const candidate = rankFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    if (!best || compareHoldemRanks(candidate, best) > 0) best = candidate;
  }
  return best;
}

export function holdemPots(players) {
  const levels = [...new Set(players.map((player) => player.committed).filter((value) => value > 0))].sort((a, b) => a - b);
  let previous = 0;
  return levels.map((level) => {
    const paid = players.filter((player) => player.committed >= level);
    const pot = { amount: (level - previous) * paid.length,
      eligible: paid.filter((player) => player.status !== "folded").map((player) => player.playerId) };
    previous = level; return pot;
  });
}

function freshPlayer(player, stack) {
  return { playerId: player.id, seatIndex: player.seatIndex, stack, committed: 0, streetBet: 0, status: "waiting", sittingOut: false,
    holeCards: [], actedAtBet: null, checked: false, revealed: false, rank: null };
}

export function createHoldemState(players, options = {}) {
  if (players.length < 2 || players.length > 8 || new Set(players.map((player) => player.id)).size !== players.length) fail("请先让 2–8 位玩家入座。", "HOLDEM_PLAYERS");
  const buyIn = chips(options.buyIn ?? 1000, "初始筹码", 1, 1_000_000);
  const smallBlind = chips(options.smallBlind ?? 5, "小盲", 1, 100_000), bigBlind = chips(options.bigBlind ?? 10, "大盲", smallBlind, 100_000);
  if (buyIn < bigBlind) fail("初始筹码不能少于大盲。", "INVALID_HOLDEM", 400);
  return { version: 1, deckId: null, matId: null, phase: "waiting", handNumber: 0, decision: 0, buyIn, smallBlind, bigBlind, totalChips: buyIn * players.length,
    dealerId: null, dealerSeat: -1, smallBlindId: null, bigBlindId: null, actorId: null, currentBet: 0, minRaise: bigBlind,
    pending: [], board: [], burns: [], players: [...players].sort((a, b) => a.seatIndex - b.seatIndex).map((player) => freshPlayer(player, buyIn)),
    lastPot: 0, payouts: [], refunds: [], pots: [], showdown: false };
}

function pay(player, amount) {
  const paid = Math.min(player.stack, amount);
  player.stack -= paid; player.committed += paid; player.streetBet += paid;
  if (player.stack === 0) player.status = "all-in";
  return paid;
}

function refundUncalled(state) {
  const paid = [...state.players].sort((a, b) => b.committed - a.committed);
  const refund = paid[0].committed - (paid[1]?.committed || 0);
  if (refund <= 0 || paid[0].status === "folded") return;
  paid[0].committed -= refund; paid[0].streetBet = Math.max(0, paid[0].streetBet - refund); paid[0].stack += refund;
  if (paid[0].status === "all-in") paid[0].status = "active";
  state.refunds.push({ playerId: paid[0].playerId, amount: refund });
}

function settle(state, faceForCard, showdown) {
  refundUncalled(state);
  const live = contenders(state), pots = holdemPots(state.players), gains = new Map();
  state.lastPot = state.players.reduce((sum, player) => sum + player.committed, 0);
  if (showdown) for (const player of live) {
    player.rank = evaluateHoldem([...state.board, ...player.holeCards].map(faceForCard)); player.revealed = true;
  }
  for (const pot of pots) {
    const eligible = live.filter((player) => pot.eligible.includes(player.playerId));
    if (!eligible.length) fail("边池缺少可获胜玩家，请由房主撤销检查。", "HOLDEM_POT");
    let winners = eligible;
    if (showdown) {
      const best = eligible.reduce((current, player) => !current || compareHoldemRanks(player.rank, current.rank) > 0 ? player : current, null);
      winners = eligible.filter((player) => compareHoldemRanks(player.rank, best.rank) === 0);
    }
    winners = clockwise(winners, state.dealerSeat);
    const share = Math.floor(pot.amount / winners.length), remainder = pot.amount % winners.length;
    winners.forEach((player, index) => gains.set(player.playerId, (gains.get(player.playerId) || 0) + share + (index < remainder ? 1 : 0)));
    pot.winners = winners.map((player) => player.playerId);
  }
  state.payouts = [...gains].map(([playerId, amount]) => ({ playerId, amount }));
  for (const player of state.players) { player.stack += gains.get(player.playerId) || 0; player.committed = 0; player.streetBet = 0; }
  state.phase = "complete"; state.pending = []; state.actorId = null; state.currentBet = 0;
  state.pots = pots; state.showdown = showdown;
}

function updateActor(state) {
  state.pending = state.pending.filter((id) => activePlayers(state).some((player) => player.playerId === id));
  const active = activePlayers(state);
  if (active.length === 1) {
    const opposingBet = Math.max(0, ...state.players.filter((player) => player !== active[0]).map((player) => player.streetBet));
    if (active[0].streetBet >= opposingBet) state.pending = [];
  }
  state.actorId = state.pending[0] || null;
  if (!state.actorId) refundUncalled(state);
}

export function holdemLegalActions(state, playerId) {
  const player = state.players.find((player) => player.playerId === playerId);
  if (!player || state.actorId !== playerId || betweenHands(state)) return null;
  const opponentCanCall = activePlayers(state).some((opponent) => opponent.playerId !== playerId);
  const betToMatch = opponentCanCall ? state.currentBet : Math.max(0, ...state.players.filter((opponent) => opponent !== player).map((opponent) => opponent.streetBet));
  const owed = Math.max(0, betToMatch - player.streetBet);
  const raiseOpen = player.actedAtBet === null || (player.checked && state.currentBet > 0) || state.currentBet - player.actedAtBet >= state.minRaise;
  return { canCheck: owed === 0, callAmount: Math.min(player.stack, owed), owed,
    canRaise: opponentCanCall && raiseOpen && player.stack > owed, canAllIn: player.stack <= owed || opponentCanCall && raiseOpen,
    minRaiseTo: state.currentBet === 0 ? state.bigBlind : state.currentBet + state.minRaise,
    maxRaiseTo: player.streetBet + player.stack };
}

export function planHoldem(original, command, context) {
  const state = structuredClone(original), deckOrder = [...context.deckOrder], actor = context.actor;
  const host = () => { if (actor.role !== "host") fail("这一步由房主操作。", "HOST_ONLY", 403); };
  const name = (id) => context.players.find((player) => player.id === id)?.name || "玩家";
  if (command.decision !== undefined && command.decision !== state.decision) fail("行动轮次已经变化，这项旧操作没有执行，请确认当前牌局。", "HOLDEM_STALE");
  let label = "", resetCards = false;
  if (command.type === "holdem-fold-offline") {
    host();
    const target = context.players.find((player) => player.id === state.actorId);
    if (!target || target.id !== command.playerId) fail("请等待这位玩家的行动回合。", "HOLDEM_TURN");
    if (target.connections > 0) fail("这位玩家仍在线，请由本人决定。", "HOLDEM_PLAYER_ONLINE");
    const result = planHoldem(original, { type: "holdem-action", action: "fold", decision: state.decision }, { ...context, actor: target });
    result.label = `德州：${target.name} 暂离，由房主代为弃牌${result.state.phase === "complete" ? `；底池 ${result.state.lastPot} 已结算` : ""}`;
    return result;
  } else if (command.type === "holdem-start") {
    host(); if (!betweenHands(state)) fail("请先完成当前这一手。");
    const playing = state.players.filter((player) => player.stack > 0 && !player.sittingOut);
    if (playing.length < 2) fail("至少两位玩家有筹码并准备入局才能发牌。", "HOLDEM_PLAYERS");
    if (deckOrder.length !== 52) fail("德州牌盒需要完整的 52 张牌。", "HOLDEM_DECK");
    const dealer = clockwise(playing, state.dealerSeat)[0];
    state.dealerId = dealer.playerId; state.dealerSeat = dealer.seatIndex;
    const order = clockwise(playing, dealer.seatIndex);
    const small = playing.length === 2 ? dealer : order[0], big = playing.length === 2 ? order[0] : order[1];
    Object.assign(state, { handNumber: state.handNumber + 1, phase: "preflop", smallBlindId: small.playerId, bigBlindId: big.playerId,
      board: [], burns: [], currentBet: state.bigBlind, minRaise: state.bigBlind, lastPot: 0, payouts: [], refunds: [], pots: [], showdown: false });
    for (const player of state.players) Object.assign(player, { committed: 0, streetBet: 0, holeCards: [], actedAtBet: null, checked: false, revealed: false, rank: null,
      status: playing.includes(player) ? "active" : player.stack === 0 ? "out" : "sitting-out" });
    for (let round = 0; round < 2; round++) for (const player of order) player.holeCards.push(deckOrder.pop());
    pay(small, state.smallBlind); pay(big, state.bigBlind);
    state.pending = clockwise(playing, big.seatIndex).map((player) => player.playerId); updateActor(state);
    resetCards = true;
    label = `德州第 ${state.handNumber} 手：${name(state.dealerId)} 坐庄，盲注 ${state.smallBlind}/${state.bigBlind}`;
  } else if (command.type === "holdem-action") {
    const player = state.players.find((player) => player.playerId === actor.id), legal = holdemLegalActions(state, actor.id);
    if (!legal || !player) fail("还没有轮到你行动。", "HOLDEM_TURN");
    const oldBet = state.currentBet;
    if (command.action === "fold") { player.status = "folded"; label = "德州：弃牌"; }
    else if (command.action === "check") {
      if (!legal.canCheck) fail("当前有下注，请跟注或弃牌。");
      player.checked = true; label = "德州：过牌";
    } else if (command.action === "call") {
      if (legal.canCheck) fail("当前无需跟注，可以过牌。");
      const amount = pay(player, legal.callAmount); label = `德州：${player.stack === 0 ? "全下跟注" : "跟注"} ${amount}`;
    } else if (["raise", "all-in"].includes(command.action)) {
      const target = command.action === "all-in" ? legal.maxRaiseTo : chips(command.to, "加注总额", 1);
      if (target <= player.streetBet || target > legal.maxRaiseTo) fail("加注不能超过自己剩余的筹码。");
      if (target <= state.currentBet) {
        if (command.action !== "all-in") fail("加注总额需要高于当前下注。");
        pay(player, player.stack); label = `德州：全下跟注 ${player.streetBet}`;
      } else {
        if (!legal.canRaise) fail(activePlayers(state).length < 2 ? "其他玩家均已全下或弃牌，你可以跟注或弃牌。" : "这次不足额全下尚未重新开放加注，你可以跟注或弃牌。", "HOLDEM_RAISE_CLOSED");
        if (target < legal.minRaiseTo && target !== legal.maxRaiseTo) fail(`最少加注到 ${legal.minRaiseTo}，筹码不足时可以全下。`, "HOLDEM_MIN_RAISE");
        pay(player, target - player.streetBet);
        const increment = target - state.currentBet;
        if (increment >= state.minRaise) state.minRaise = increment;
        state.currentBet = target;
        label = `德州：${player.stack === 0 ? "全下至" : oldBet === 0 ? "下注" : "加注至"} ${target}`;
      }
    } else fail("请选择过牌、跟注、加注、全下或弃牌。", "INVALID_HOLDEM", 400);
    player.actedAtBet = state.currentBet;
    if (command.action !== "check") player.checked = false;
    state.pending = state.currentBet > oldBet
      ? clockwise(activePlayers(state).filter((other) => other !== player), player.seatIndex).map((other) => other.playerId)
      : state.pending.filter((id) => id !== actor.id);
    if (contenders(state).length === 1) { settle(state, context.faceForCard, false); label += `；${name(state.payouts[0]?.playerId)} 收下底池 ${state.lastPot}`; }
    else updateActor(state);
  } else if (command.type === "holdem-advance") {
    host();
    if (betweenHands(state) || state.actorId) fail("请等这一轮下注结束后再发公共牌。", "HOLDEM_ROUND_OPEN");
    if (state.phase === "river") {
      settle(state, context.faceForCard, true);
      label = `德州摊牌：${state.payouts.map((entry) => `${name(entry.playerId)} 获得 ${entry.amount}`).join("，")}`;
    } else {
      const count = state.phase === "preflop" ? 3 : 1;
      if (deckOrder.length < count + 1) fail("牌盒中的牌不足。", "HOLDEM_DECK");
      state.burns.push(deckOrder.pop());
      for (let index = 0; index < count; index++) state.board.push(deckOrder.pop());
      state.phase = { preflop: "flop", flop: "turn", turn: "river" }[state.phase];
      state.currentBet = 0; state.minRaise = state.bigBlind;
      for (const player of state.players) { player.streetBet = 0; player.actedAtBet = null; player.checked = false; }
      state.pending = clockwise(activePlayers(state), state.dealerSeat).map((player) => player.playerId); updateActor(state);
      label = `德州：发出${{ flop: "翻牌", turn: "转牌", river: "河牌" }[state.phase]}`;
    }
  } else if (command.type === "holdem-join") {
    if (state.players.some((player) => player.playerId === actor.id)) fail("你已经在德州席位中。");
    if (state.players.length >= 8 || state.totalChips + state.buyIn > 8_000_000) fail("德州席位已满。");
    state.players.push(freshPlayer(actor, state.buyIn)); state.totalChips += state.buyIn;
    label = `加入德州，领取 ${state.buyIn} 筹码${betweenHands(state) ? "" : "，下一手开始入局"}`;
  } else if (command.type === "holdem-rebuy") {
    if (!betweenHands(state)) fail("请在两手之间补充筹码。");
    const id = command.playerId || actor.id;
    if (id !== actor.id) host();
    const player = state.players.find((player) => player.playerId === id);
    if (!player) fail("这位玩家尚未加入德州。");
    const amount = chips(command.amount ?? state.buyIn, "补充筹码", 1, 1_000_000);
    chips(player.stack + amount, "个人筹码", 0, 1_000_000); chips(state.totalChips + amount, "桌上筹码");
    player.stack += amount; state.totalChips += amount; label = `为 ${name(id)} 补充 ${amount} 筹码`;
  } else if (command.type === "holdem-sitout") {
    const player = state.players.find((player) => player.playerId === actor.id);
    if (!player) fail("请先加入德州席位。");
    player.sittingOut = !player.sittingOut; label = player.sittingOut ? "德州：下一手休息" : "德州：准备参加下一手";
  } else if (command.type === "holdem-reveal") {
    const player = state.players.find((player) => player.playerId === actor.id);
    if (state.phase !== "complete" || player?.holeCards.length !== 2 || player.revealed) fail("这一手结束后可以亮出自己的底牌。");
    player.revealed = true; label = "德州：亮出自己的底牌";
  } else fail("未知的德州操作。", "INVALID_HOLDEM", 400);
  if (["holdem-start", "holdem-action", "holdem-advance"].includes(command.type)) state.decision++;
  if (state.players.reduce((sum, player) => sum + player.stack + player.committed, 0) !== state.totalChips) fail("筹码总数不一致，操作已取消。", "HOLDEM_CONSERVATION");
  return { state, deckOrder, label, resetCards };
}

export function remapHoldem(state, cardMap, playerMap = new Map()) {
  if (!state) return null;
  state = structuredClone(state);
  const player = (id) => playerMap.get(id) || id, card = (id) => cardMap.get(id) || id;
  for (const key of ["dealerId", "smallBlindId", "bigBlindId", "actorId"]) state[key] = player(state[key]);
  state.pending = state.pending.map(player); state.board = state.board.map(card); state.burns = state.burns.map(card);
  for (const entry of state.players) { entry.playerId = player(entry.playerId); entry.holeCards = entry.holeCards.map(card); }
  for (const entry of [...state.payouts, ...state.refunds]) entry.playerId = player(entry.playerId);
  for (const pot of state.pots) { pot.eligible = pot.eligible.map(player); pot.winners = pot.winners.map(player); }
  return state;
}

export function projectHoldem(state, viewerId) {
  if (!state) return null;
  return { version: state.version, deckId: state.deckId, matId: state.matId, phase: state.phase, handNumber: state.handNumber, decision: state.decision,
    buyIn: state.buyIn, smallBlind: state.smallBlind, bigBlind: state.bigBlind, totalChips: state.totalChips,
    dealerId: state.dealerId, smallBlindId: state.smallBlindId, bigBlindId: state.bigBlindId, actorId: state.actorId,
    currentBet: state.currentBet, pot: state.players.reduce((sum, player) => sum + player.committed, 0), lastPot: state.lastPot,
    board: [...state.board], burnCount: state.burns.length, readyToAdvance: !betweenHands(state) && !state.actorId,
    players: state.players.map(({ actedAtBet, checked, ...player }) => structuredClone(player)),
    payouts: structuredClone(state.payouts), refunds: structuredClone(state.refunds), pots: structuredClone(state.phase === "complete" ? state.pots : holdemPots(state.players)),
    showdown: state.showdown, legal: holdemLegalActions(state, viewerId) };
}

export function validateHoldemState(source, { players, cards, decks, objects }) {
  if (source === null || source === undefined) return null;
  const invalid = () => fail("德州存档的席位、牌序或筹码记录不一致。", "INVALID_HOLDEM", 400);
  if (!source || source.version !== 1 || !phases.includes(source.phase) || !Array.isArray(source.players) || source.players.length < 2 || source.players.length > 8) invalid();
  const state = structuredClone(source), roster = new Map(players.map((player) => [player.id, player])), cardMap = new Map(cards.map((card) => [card.id, card]));
  const deck = decks.find((deck) => deck.id === state.deckId), mat = objects.find((object) => object.id === state.matId);
  const owned = cards.filter((card) => card.deckId === state.deckId);
  if (!deck || mat?.resourceId !== "holdem-mat" || owned.length !== 52 || new Set(owned.map((card) => `${card.face.suit}:${card.face.rank}`)).size !== 52
    || owned.some((card) => !ranks.includes(card.face.rank) || !["hearts", "diamonds", "clubs", "spades"].includes(card.face.suit))) invalid();
  for (const key of ["handNumber", "decision", "currentBet", "totalChips", "lastPot"]) chips(state[key], key);
  chips(state.buyIn, "buyIn", 1, 1_000_000);
  for (const key of ["smallBlind", "bigBlind"]) chips(state[key], key, 1, 100_000);
  chips(state.minRaise, "minRaise", 1);
  if (state.smallBlind > state.bigBlind || state.buyIn < state.bigBlind || !Number.isInteger(state.dealerSeat) || state.dealerSeat < -1 || state.dealerSeat > 7) invalid();
  for (const key of ["pending", "board", "burns", "payouts", "refunds", "pots"]) if (!Array.isArray(state[key]) || state[key].length > 32) invalid();
  if (state.board.length > 5 || state.burns.length > 3 || state.payouts.length > 8) invalid();
  const seenPlayers = new Set(), seenCards = new Set();
  const checkCard = (id, zone, ownerId, faceUp) => {
    const card = cardMap.get(id);
    if (!card || card.deckId !== state.deckId || seenCards.has(id) || card.zone !== zone || card.ownerId !== ownerId || card.faceUp !== faceUp) invalid();
    seenCards.add(id);
  };
  state.players = state.players.map((entry) => {
    const player = roster.get(entry?.playerId);
    if (!player || seenPlayers.has(player.id) || player.seatIndex !== entry.seatIndex || !["waiting", "active", "folded", "all-in", "out", "sitting-out"].includes(entry.status)) invalid();
    seenPlayers.add(player.id);
    for (const key of ["stack", "committed", "streetBet"]) chips(entry[key], key);
    if (entry.streetBet > entry.committed || !Array.isArray(entry.holeCards) || ![0, 2].includes(entry.holeCards.length)) invalid();
    if (entry.actedAtBet !== null) chips(entry.actedAtBet, "actedAtBet");
    if (typeof entry.sittingOut !== "boolean" || typeof entry.checked !== "boolean" || typeof entry.revealed !== "boolean") invalid();
    if (entry.revealed && state.phase !== "complete") invalid();
    for (const id of entry.holeCards) checkCard(id, entry.revealed ? "public" : "hand", entry.revealed ? null : player.id, entry.revealed);
    let rank = null;
    if (entry.rank) {
      if (!entry.revealed || state.board.length !== 5) invalid();
      rank = evaluateHoldem([...state.board, ...entry.holeCards].map((id) => cardMap.get(id)?.face));
      if (JSON.stringify(rank.score) !== JSON.stringify(entry.rank.score)) invalid();
    }
    return { playerId: player.id, seatIndex: entry.seatIndex, stack: entry.stack, committed: entry.committed, streetBet: entry.streetBet,
      status: entry.status, sittingOut: entry.sittingOut, holeCards: [...entry.holeCards], actedAtBet: entry.actedAtBet, checked: entry.checked, revealed: entry.revealed, rank };
  });
  state.board.forEach((id) => checkCard(id, "public", null, true)); state.burns.forEach((id) => checkCard(id, "public", null, false));
  if (owned.some((card) => !seenCards.has(card.id) && card.zone !== "deck")) invalid();
  if (state.players.reduce((sum, player) => sum + player.stack + player.committed, 0) !== state.totalChips) invalid();
  for (const key of ["dealerId", "smallBlindId", "bigBlindId", "actorId"]) if (state[key] !== null && !seenPlayers.has(state[key])) invalid();
  if (new Set(state.pending).size !== state.pending.length || state.pending.some((id) => !state.players.some((player) => player.playerId === id && player.status === "active" && player.stack > 0))
    || state.actorId !== (state.pending[0] || null)) invalid();
  const counts = { waiting: [0, 0], preflop: [0, 0], flop: [3, 1], turn: [4, 2], river: [5, 3] }[state.phase];
  if (counts && (state.board.length !== counts[0] || state.burns.length !== counts[1])) invalid();
  if (state.phase === "complete" && (state.actorId || state.players.some((player) => player.committed))) invalid();
  for (const entry of [...state.payouts, ...state.refunds]) { if (!seenPlayers.has(entry?.playerId)) invalid(); chips(entry.amount, "payout"); }
  for (const pot of state.pots) {
    chips(pot?.amount, "pot");
    if (!Array.isArray(pot.eligible) || !Array.isArray(pot.winners) || !pot.winners.length || pot.eligible.some((id) => !seenPlayers.has(id)) || pot.winners.some((id) => !pot.eligible.includes(id))) invalid();
  }
  if (typeof state.showdown !== "boolean" || state.showdown && (state.phase !== "complete" || state.board.length !== 5)) invalid();
  return state;
}
