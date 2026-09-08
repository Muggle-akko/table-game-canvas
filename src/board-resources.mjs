// Physical artwork and starting arrangements only. No move, capture or turn rules.
const freezeBoardData = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeBoardData); Object.freeze(value); }
  return value;
};

// The printed board uses a 17-unit square with rectangular and diagonal track
// cells. Coordinates are geometric centers, including half-unit corner turns.
const rotateFlightPoint = ([x, y], turns) => {
  for (let turn = 0; turn < turns; turn++) [x, y] = [17 - y, x];
  return [x, y];
};
const flightQuarter = [
  [[5.5, 15.5], [[4, 15], [6, 15], [6, 17]]],
  [[5, 14.5], [[4, 14], [6, 14], [6, 15], [4, 15]]],
  [[5, 13.5], [[4, 13], [6, 13], [6, 14], [4, 14]]],
  [[5.5, 12.5], [[4, 13], [6, 11], [6, 13]]],
  [[4.5, 11.5], [[4, 11], [6, 11], [4, 13]]],
  [[3.5, 12], [[3, 11], [4, 11], [4, 13], [3, 13]]],
  [[2.5, 12], [[2, 11], [3, 11], [3, 13], [2, 13]]],
  [[1.5, 11.5], [[0, 11], [2, 11], [2, 13]]],
  [[1, 10.5], [[0, 10], [2, 10], [2, 11], [0, 11]]],
  [[1, 9.5], [[0, 9], [2, 9], [2, 10], [0, 10]]],
  [[1, 8.5], [[0, 8], [2, 8], [2, 9], [0, 9]]],
  [[1, 7.5], [[0, 7], [2, 7], [2, 8], [0, 8]]],
  [[1, 6.5], [[0, 6], [2, 6], [2, 7], [0, 7]]]
];
const flightTrack = Array.from({ length: 4 }, (_, turn) => flightQuarter.map(([center, polygon], index) => ({
  center: rotateFlightPoint(center, turn), polygon: polygon.map((point) => rotateFlightPoint(point, turn)),
  side: ["blue", "red", "yellow", "green"][(turn * 13 + index) % 4]
}))).flat();
const flightPath = flightTrack.map((tile) => tile.center);
const flightAirportSlots = [[1.1, 1.1], [2.9, 1.1], [1.1, 2.9], [2.9, 2.9]];
const flightTeams = [
  { side: "red", label: "红", color: "#ef2639", airport: [0, 13] },
  { side: "yellow", label: "黄", color: "#ffd21c", airport: [0, 0] },
  { side: "green", label: "绿", color: "#009d57", airport: [13, 0] },
  { side: "blue", label: "蓝", color: "#078fc9", airport: [13, 13] }
].map((team, turn) => ({
  ...team, heading: turn * 90, start: turn * 13, gate: rotateFlightPoint([4.6, 16.4], turn),
  entry: (49 + turn * 13) % 52, flight: [(17 + turn * 13) % 52, (29 + turn * 13) % 52],
  home: Array.from({ length: 6 }, (_, i) => rotateFlightPoint([8.5, 14.5 - i], turn)),
  homeShape: [[8, 15], [9, 15], [9, 10], [10, 10], [8.5, 8.5], [7, 10], [8, 10]].map((point) => rotateFlightPoint(point, turn))
}));

export const BOARD_LAYOUTS = freezeBoardData({
  chess: { width: 832, height: 832, inset: 64, cell: 88, columns: 8, rows: 8 },
  xiangqi: { width: 832, height: 920, inset: 64, cell: 88, columns: 9, rows: 10 },
  jungle: { width: 744, height: 920, inset: 64, cell: 88, columns: 7, rows: 9,
    rivers: [[1, 3], [2, 3], [4, 3], [5, 3], [1, 4], [2, 4], [4, 4], [5, 4], [1, 5], [2, 5], [4, 5], [5, 5]],
    dens: [[3, 0], [3, 8]], traps: [[2, 0], [4, 0], [3, 1], [2, 8], [4, 8], [3, 7]] },
  aeroplane: { width: 1120, height: 1120, inset: 33, cell: 62, columns: 17, rows: 17,
    path: flightPath, track: flightTrack, teams: flightTeams, airportSlots: flightAirportSlots }
});

const boardMats = [
  { id: "board-chess", game: "chess", label: "国际象棋棋盘", color: "#e9dec4" },
  { id: "board-xiangqi", game: "xiangqi", label: "象棋棋盘", color: "#ecddbc" },
  { id: "board-jungle", game: "jungle", label: "斗兽棋棋盘", color: "#e4e4cc" },
  { id: "board-aeroplane", game: "aeroplane", label: "飞行棋棋盘", color: "#9ed9ee" }
].map((board) => ({ ...board, kind: "mat", pattern: board.game, width: BOARD_LAYOUTS[board.game].width, height: BOARD_LAYOUTS[board.game].height, description: "可单独取用与自由摆放的棋盘" }));

const chessRoles = [
  ["king", "王"], ["queen", "后"], ["rook", "车"], ["bishop", "象"], ["knight", "马"], ["pawn", "兵"]
];
const chessPieces = ["w", "b"].flatMap((side) => chessRoles.map(([role, name]) => ({
  id: `chess-${side}-${role}`, kind: "token", game: "chess", label: `${side === "w" ? "白" : "黑"}${name} · 国际象棋`,
  description: "单枚棋子，可复制、移动与收纳", symbol: name, color: side === "w" ? "#f3ead4" : "#293f35", piece: { game: "chess", role, side }
})));
const xiangqiRoles = [
  ["king", "帅", "将"], ["advisor", "仕", "士"], ["elephant", "相", "象"], ["horse", "马", "马"],
  ["rook", "车", "车"], ["cannon", "炮", "炮"], ["pawn", "兵", "卒"]
];
const xiangqiPieces = ["r", "b"].flatMap((side) => xiangqiRoles.map(([role, red, black]) => ({
  id: `xiangqi-${side}-${role}`, kind: "token", game: "xiangqi", label: `${side === "r" ? "红" : "黑"}${side === "r" ? red : black} · 象棋`,
  description: "单枚棋子，可复制、移动与收纳", symbol: side === "r" ? red : black, color: "#ead8b2", piece: { game: "xiangqi", role, side }
})));
const animalRoles = [
  ["elephant", "象", 8], ["lion", "狮", 7], ["tiger", "虎", 6], ["leopard", "豹", 5],
  ["wolf", "狼", 4], ["dog", "狗", 3], ["cat", "猫", 2], ["rat", "鼠", 1]
];
const junglePieces = ["r", "b"].flatMap((side) => animalRoles.map(([role, name, rank]) => ({
  id: `jungle-${side}-${role}`, kind: "token", game: "jungle", label: `${side === "r" ? "红" : "蓝"}${name} · 斗兽棋`,
  description: `等级 ${rank} · 单枚动物，可自由摆放`, symbol: name, color: side === "r" ? "#b95b4c" : "#4e7a95", piece: { game: "jungle", role, side, rank }
})));
const aircraftPieces = flightTeams.map(({ side, label, color }) => ({
  id: `plane-${side}`, kind: "token", game: "aeroplane", label: `${label}飞机 · 飞行棋`, description: "单架飞机，可复制、移动与收纳",
  symbol: label, color, piece: { game: "aeroplane", role: "plane", side }
}));
const boardGuides = [
  { game: "chess", label: "国际象棋规则指引", text: "国际象棋 · 常见玩法\n\n准备｜白方先行。棋盘右下角为浅格，后放在与己方同色的格子。双方各 16 子。\n\n走法｜王走一格；后沿横、直、斜线；车走横直；象走斜线；马走日字，可跳子。兵向前一格、斜前吃子，起始可走两格，到底线可升变。\n\n特殊｜王车易位、吃过路兵与升变由玩家自行执行；升变可从资源库取出相应棋子。\n\n将军｜王受攻击时需要应将；被将死为负。逼和、重复局面与五十步等和棋条件可开局约定。\n\n操作｜拖走被吃棋子，再移动自己的棋子。可把吃掉的子放到盘外或收纳袋。棋盘不限制落点，也不判定胜负。" },
  { game: "xiangqi", label: "象棋规则指引", text: "象棋 · 常见玩法\n\n准备｜红方先行，双方各 16 子。棋子放在线的交点上。\n\n走法｜车走直线；马走日字，留意蹩马腿；象走田字，不过河，留意塞象眼；士走斜线一格，在九宫内；将帅在九宫内走直线一格。\n\n炮兵｜炮平移不越子，吃子须隔一子。兵卒向前一格，过河后也能左右走，不能后退。\n\n将军｜将帅不能直接照面，受将需应将；将死或困毙通常为负。长将、长捉等按同桌约定。\n\n操作｜双方自行移动、吃子和计时。吃掉的棋子可拖到盘外或袋子。此牌可双击改写。" },
  { game: "jungle", label: "斗兽棋规则指引", text: "斗兽棋 · 常见玩法\n\n等级｜象 8、狮 7、虎 6、豹 5、狼 4、狗 3、猫 2、鼠 1。一般大吃小、同级互吃，鼠能吃象、象不能吃鼠。\n\n地形｜普通陆地横直走一格；只有鼠能下河。狮虎可直线跳过河，河中有鼠挡路则不能跳。河岸间能否吃子开局约定。\n\n陷阱｜进入敌方陷阱通常失去等级保护；离开恢复。自己的兽穴不能进入，进入对方兽穴通常获胜。\n\n操作｜自行走子、吃子和回合交接。棋盘上标出河流、陷阱与双方兽穴，不限制任何移动。" },
  { game: "aeroplane", label: "飞行棋规则指引", text: "飞行棋 · 常见玩法\n\n准备｜每人选一种颜色，四架飞机放在停机坪。掷骰后自行移动，起飞点数开局约定，常见为掷出 6。\n\n路线｜先到停机坪旁的起飞点，再沿顺时针方向进入 52 格环路；绕行后从本色入口进入 6 格终点航道。\n\n跳跃｜落在同色格常可跳 4 格；虚线箭头标出跨越 12 格的飞行路线，经过异色终点航道。连跳顺序与终点反弹可按同桌习惯约定。\n\n碰面｜撞机、叠机、奖励掷骰等由玩家商定与操作；不自动击退任何飞机。\n\n胜利｜常以四架飞机全部抵达终点为胜。用桌上六面骰掷点，自己移动飞机、交接回合。这张指引可编辑。" }
].map((guide) => ({ ...guide, id: `guide-${guide.game}`, kind: "note", description: "常见玩法参考，可双击编辑", width: 400, height: 640, color: "#eee5cf" }));

export const BOARD_RESOURCES = freezeBoardData([...boardMats, ...boardGuides, ...chessPieces, ...xiangqiPieces, ...junglePieces, ...aircraftPieces]);

const pieceOnBoard = (game, resourceId, column, row, intersection = false) => {
  const { inset, cell } = BOARD_LAYOUTS[game];
  return { resourceId, x: inset + (column + (intersection ? 0 : .5)) * cell - 31, y: inset + (row + (intersection ? 0 : .5)) * cell - 31 };
};
const chessSetup = ["b", "w"].flatMap((side) => {
  const back = side === "b" ? 0 : 7, front = side === "b" ? 1 : 6;
  return [
    ...["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"].map((role, col) => pieceOnBoard("chess", `chess-${side}-${role}`, col, back)),
    ...Array.from({ length: 8 }, (_, col) => pieceOnBoard("chess", `chess-${side}-pawn`, col, front))
  ];
});
const xiangqiSetup = ["b", "r"].flatMap((side) => {
  const row = (r) => side === "b" ? r : 9 - r;
  return [
    ...["rook", "horse", "elephant", "advisor", "king", "advisor", "elephant", "horse", "rook"].map((role, col) => pieceOnBoard("xiangqi", `xiangqi-${side}-${role}`, col, row(0), true)),
    ...[1, 7].map((col) => pieceOnBoard("xiangqi", `xiangqi-${side}-cannon`, col, row(2), true)),
    ...[0, 2, 4, 6, 8].map((col) => pieceOnBoard("xiangqi", `xiangqi-${side}-pawn`, col, row(3), true))
  ];
});
const jungleSetup = ["b", "r"].flatMap((side) => [
  ["lion", 0, 0], ["tiger", 6, 0], ["dog", 1, 1], ["cat", 5, 1],
  ["rat", 0, 2], ["leopard", 2, 2], ["wolf", 4, 2], ["elephant", 6, 2]
].map(([role, col, row]) => pieceOnBoard("jungle", `jungle-${side}-${role}`, side === "b" ? col : 6 - col, side === "b" ? row : 8 - row)));
const flightSetup = flightTeams.flatMap((team) => flightAirportSlots.map(([x, y]) =>
  pieceOnBoard("aeroplane", `plane-${team.side}`, team.airport[0] + x, team.airport[1] + y, true)));

export const BOARD_GAME_SETS = freezeBoardData([
  { id: "chess", label: "国际象棋", players: "2 人", description: "棋盘 · 32 枚棋子 · 规则指引", pieces: chessSetup, keywords: "chess 国际 西洋" },
  { id: "xiangqi", label: "象棋", players: "2 人", description: "棋盘 · 32 枚棋子 · 规则指引", pieces: xiangqiSetup, keywords: "中国象棋 中国 红黑" },
  { id: "jungle", label: "斗兽棋", players: "2 人", description: "棋盘 · 16 枚动物 · 规则指引", pieces: jungleSetup, keywords: "动物 jungle" },
  { id: "aeroplane", label: "飞行棋", players: "2–4 人", description: "棋盘 · 16 架飞机 · 骰子 · 规则指引", pieces: flightSetup, keywords: "飞机 aeroplane 飞行" }
].map(({ pieces, ...set }) => ({
  ...set, boardId: `board-${set.id}`, width: BOARD_LAYOUTS[set.id].width + 440, height: BOARD_LAYOUTS[set.id].height,
  members: [{ resourceId: `board-${set.id}`, x: 0, y: 0 }, ...pieces,
    { resourceId: `guide-${set.id}`, x: BOARD_LAYOUTS[set.id].width + 40, y: 0 },
    ...(set.id === "aeroplane" ? [{ resourceId: "die-d6", x: BOARD_LAYOUTS[set.id].width + 64, y: 688 }] : [])]
})));
