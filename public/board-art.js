(function attachBoardArt(root) {
  "use strict";
  const layouts = root.ParlorEngine.BOARD_LAYOUTS;
  const svgNode = (tag, attrs = {}, text) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const add = (parent, tag, attrs, text) => { const node = svgNode(tag, attrs, text); parent.append(node); return node; };
  const line = (parent, x1, y1, x2, y2, attrs = {}) => add(parent, "line", { x1, y1, x2, y2, ...attrs });
  const label = (parent, x, y, text, attrs = {}) => add(parent, "text", { x, y, "text-anchor": "middle", "font-size": 15, fill: "#4c6251", ...attrs }, text);

  function chessBoard(svg, spec) {
    const { inset, cell } = spec;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      add(svg, "rect", { x: inset + col * cell, y: inset + row * cell, width: cell, height: cell,
        fill: (col + row) % 2 ? "#507361" : "#f1e6ce", "data-board-cell": `${col}:${row}` });
    }
    add(svg, "rect", { x: inset, y: inset, width: cell * 8, height: cell * 8, fill: "none", stroke: "#3e5b49", "stroke-width": 3 });
    for (let index = 0; index < 8; index++) {
      label(svg, inset + (index + .5) * cell, spec.height - 25, "abcdefgh"[index], { "font-size": 18 });
      label(svg, 33, inset + (index + .5) * cell + 6, 8 - index, { "font-size": 18 });
      label(svg, spec.width - 31, inset + (index + .5) * cell + 6, 8 - index, { "font-size": 14, opacity: .65 });
    }
  }

  function xiangqiBoard(svg, spec) {
    const { inset, cell } = spec, x = (col) => inset + col * cell, y = (row) => inset + row * cell;
    const grid = add(svg, "g", { fill: "none", stroke: "#927a52", "stroke-width": 2 });
    for (let row = 0; row < 10; row++) line(grid, x(0), y(row), x(8), y(row));
    for (let col = 0; col < 9; col++) {
      if (col === 0 || col === 8) line(grid, x(col), y(0), x(col), y(9));
      else { line(grid, x(col), y(0), x(col), y(4)); line(grid, x(col), y(5), x(col), y(9)); }
    }
    for (const row of [0, 7]) {
      line(grid, x(3), y(row), x(5), y(row + 2)); line(grid, x(5), y(row), x(3), y(row + 2));
    }
    add(svg, "rect", { x: inset - 6, y: inset - 6, width: cell * 8 + 12, height: cell * 9 + 12, rx: 2, fill: "none", stroke: "#927a52", "stroke-width": 3 });
    for (const [col, row] of [[1, 2], [7, 2], [1, 7], [7, 7], ...[3, 6].flatMap((r) => [0, 2, 4, 6, 8].map((c) => [c, r]))]) {
      for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
        if ((col === 0 && dx < 0) || (col === 8 && dx > 0)) continue;
        add(grid, "path", { d: `M${x(col) + dx * 8} ${y(row) + dy * 18}v${-dy * 10}h${dx * 10}` });
      }
    }
    label(svg, x(2), y(4.5) + 9, "楚 河", { "font-size": 28, fill: "#8d7045", "letter-spacing": 8 });
    label(svg, x(6), y(4.5) + 9, "汉 界", { "font-size": 28, fill: "#8d7045", "letter-spacing": 8 });
    for (let col = 0; col < 9; col++) label(svg, x(col), spec.height - 25, "九八七六五四三二一"[col], { fill: "#a74e40", "font-size": 16 });
  }

  function jungleBoard(svg, spec) {
    const { inset, cell } = spec;
    const river = new Set(spec.rivers.map((point) => point.join(":")));
    for (let row = 0; row < 9; row++) for (let col = 0; col < 7; col++) {
      add(svg, "rect", { x: inset + col * cell, y: inset + row * cell, width: cell, height: cell,
        fill: river.has(`${col}:${row}`) ? "#a6c7ca" : (col + row) % 2 ? "#d9dfc2" : "#edf0db", stroke: "#849777", "stroke-opacity": .42, "data-board-cell": `${col}:${row}` });
    }
    for (const col of [1, 4]) {
      for (const row of [3.3, 4.4, 5.5]) add(svg, "path", { d: `M${inset + (col + .16) * cell} ${inset + row * cell}q18 -9 36 0t36 0t36 0t36 0`, fill: "none", stroke: "#5a919e", "stroke-width": 2, opacity: .6 });
      label(svg, inset + (col + 1) * cell, inset + 4.6 * cell, "河", { fill: "#497b89", "font-size": 24 });
    }
    for (const [col, row] of spec.traps) {
      const cx = inset + (col + .5) * cell, cy = inset + (row + .5) * cell;
      add(svg, "path", { d: `M${cx} ${cy - 24}l20 20 -20 20 -20 -20z`, fill: "#d8c598", stroke: "#9b895d", "stroke-width": 2 });
      line(svg, cx - 7, cy - 11, cx + 7, cy + 3, { stroke: "#8c7953", "stroke-width": 2 });
      line(svg, cx + 7, cy - 11, cx - 7, cy + 3, { stroke: "#8c7953", "stroke-width": 2 });
      label(svg, cx, cy + 32, "陷阱", { fill: "#8a7654", "font-size": 12 });
    }
    for (const [col, row] of spec.dens) {
      const cx = inset + (col + .5) * cell, cy = inset + (row + .5) * cell, ink = row === 0 ? "#4b7792" : "#ab5447";
      add(svg, "path", { d: `M${cx - 22} ${cy - 6}l22 -20 22 20v23h-16v-16h-12v16h-16z`, fill: ink, opacity: .8 });
      label(svg, cx, cy + 33, row === 0 ? "蓝方兽穴" : "红方兽穴", { fill: ink, "font-size": 12, "font-weight": 600 });
    }
    add(svg, "rect", { x: inset, y: inset, width: cell * 7, height: cell * 9, fill: "none", stroke: "#728a6f", "stroke-width": 3 });
    for (let col = 0; col < 7; col++) label(svg, inset + (col + .5) * cell, spec.height - 24, "ABCDEFG"[col], { "font-size": 14 });
  }

  function arrow(svg, from, to, color, width = 3) {
    line(svg, from[0], from[1], to[0], to[1], { stroke: color, "stroke-width": width, "stroke-linecap": "round" });
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]), size = 10;
    const points = [to, [to[0] - size * Math.cos(angle - .5), to[1] - size * Math.sin(angle - .5)], [to[0] - size * Math.cos(angle + .5), to[1] - size * Math.sin(angle + .5)]];
    add(svg, "polygon", { points: points.map((point) => point.join(",")).join(" "), fill: color });
  }

  function aeroplaneBoard(svg, spec) {
    const { inset, cell, teams, path } = spec, point = ([col, row]) => [inset + (col + .5) * cell, inset + (row + .5) * cell];
    for (const team of teams) {
      const ax = inset + team.airport[0] * cell, ay = inset + team.airport[1] * cell;
      add(svg, "rect", { x: ax, y: ay, width: cell * 4.5, height: cell * 4.5, rx: 26, fill: team.color, "fill-opacity": .1, stroke: team.color, "stroke-opacity": .3, "stroke-width": 2 });
      label(svg, ax + cell * 2.25, ay + 35, `${team.label}机场`, { fill: team.color, "font-size": 20, "font-weight": 600 });
      for (const [index, [x, y]] of [[.7, 1.1], [2.7, 1.1], [.7, 3.1], [2.7, 3.1]].entries()) {
        const [cx, cy] = point([team.airport[0] + x, team.airport[1] + y]);
        add(svg, "circle", { cx, cy, r: 35, fill: "#f7f2e4", stroke: team.color, "stroke-opacity": .5, "stroke-dasharray": "4 5", "data-airport-slot": `${team.side}:${index + 1}` });
        label(svg, cx, cy + 6, index + 1, { fill: team.color, opacity: .5, "font-size": 18 });
      }
    }
    add(svg, "path", { d: `${path.map((cell, i) => `${i ? "L" : "M"}${point(cell).join(" ")}`).join(" ")}Z`, fill: "none", stroke: "#728a78", "stroke-width": 12, opacity: .14 });
    for (const team of teams) {
      const fromIndex = (team.start + 16) % 52, toIndex = (team.start + 28) % 52;
      const from = point(path[fromIndex]), to = point(path[toIndex]);
      add(svg, "path", { d: `M${from.join(" ")}L${to.join(" ")}`, fill: "none", stroke: team.color, "stroke-width": 3, "stroke-dasharray": "7 7", opacity: .7,
        "data-flight-from": fromIndex + 1, "data-flight-to": toIndex + 1, "data-flight-side": team.side });
      label(svg, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2 - 9, "飞", { fill: team.color, "font-size": 14 });
    }
    path.forEach((position, index) => {
      const [cx, cy] = point(position), color = teams[index % 4].color;
      add(svg, "circle", { cx, cy, r: 26, fill: color, "fill-opacity": .15, stroke: color, "stroke-width": 2, "data-flight-step": index + 1 });
      label(svg, cx, cy + 5, index + 1, { fill: color, "font-size": 13, "font-weight": 600 });
    });
    for (const team of teams) {
      team.home.forEach((position, index) => {
        const [cx, cy] = point(position);
        add(svg, "rect", { x: cx - 26, y: cy - 26, width: 52, height: 52, rx: 13, fill: team.color, "fill-opacity": index === 5 ? .8 : .3, stroke: team.color, "stroke-width": 2,
          "data-home-side": team.side, "data-home-step": index + 1 });
        label(svg, cx, cy + 5, index === 5 ? "终" : index + 1, { fill: index === 5 ? "#fff8e7" : team.color, "font-size": 16 });
      });
      const gate = point(team.gate), start = point(path[team.start]), next = point(path[team.start + 1]);
      add(svg, "circle", { cx: gate[0], cy: gate[1], r: 26, fill: team.color, "fill-opacity": .8, "data-takeoff-side": team.side });
      label(svg, gate[0], gate[1] + 5, "起飞", { fill: "#fff8e7", "font-size": 13, "font-weight": 600 });
      const dx = start[0] - gate[0], dy = start[1] - gate[1], length = Math.hypot(dx, dy);
      arrow(svg, [gate[0] + dx / length * 31, gate[1] + dy / length * 31], [start[0] - dx / length * 31, start[1] - dy / length * 31], team.color);
      arrow(svg, [start[0] + (next[0] - start[0]) * .44, start[1] + (next[1] - start[1]) * .44], [start[0] + (next[0] - start[0]) * .58, start[1] + (next[1] - start[1]) * .58], team.color, 2);
    }
    const center = point([7, 7]);
    add(svg, "path", { d: `M${center[0]} ${center[1] - 15}l4 11 11 4 -11 4 -4 11 -4 -11 -11 -4 11 -4z`, fill: "#a49c70" });
    label(svg, spec.width / 2, spec.height - 27, "52 格环路 · 顺编号前进", { "font-size": 14, fill: "#748172", "letter-spacing": 2 });
  }

  function board(pattern) {
    const spec = layouts[pattern]; if (!spec) return null;
    const svg = svgNode("svg", { viewBox: `0 0 ${spec.width} ${spec.height}`, class: "board-art", "aria-hidden": "true", focusable: "false" });
    add(svg, "rect", { x: 12, y: 12, width: spec.width - 24, height: spec.height - 24, rx: 12, fill: "none", stroke: "#526b51", "stroke-opacity": .2, "stroke-width": 1 });
    ({ chess: chessBoard, xiangqi: xiangqiBoard, jungle: jungleBoard, aeroplane: aeroplaneBoard })[pattern](svg, spec);
    return svg;
  }

  function chessGlyph(svg, role) {
    const ink = { fill: "currentColor", stroke: "currentColor", "stroke-width": 1.4, "stroke-linejoin": "round" };
    const paths = {
      king: "M29 7h6v7h7v5h-7v6h-6v-6h-7v-5h7z M20 29q12-8 24 0l-7 19H27z",
      queen: "M16 21l10 9 6-15 6 15 10-9-7 26H23z",
      rook: "M17 12h8v8h4v-8h6v8h4v-8h8v17h-6l-3 19H26l-3-19h-6z",
      bishop: "M32 9c-17 14-18 24-6 29l-3 10h18l-3-10c12-5 11-15-6-29z",
      knight: "M24 12l5 5c16 0 19 15 17 30H23l5-14-10 4-6-8 13-11z",
      pawn: "M25 31h14l-3 7 6 10H22l6-10z"
    };
    add(svg, "path", { d: paths[role] || paths.pawn, ...ink });
    if (role === "pawn") add(svg, "circle", { cx: 32, cy: 20, r: 9, fill: "currentColor" });
    if (role === "queen") for (const [cx, cy] of [[16, 18], [32, 12], [48, 18]]) add(svg, "circle", { cx, cy, r: 3, fill: "currentColor" });
    if (role === "bishop") add(svg, "path", { d: "M36 18l-9 12", fill: "none", stroke: "var(--piece-stock)", "stroke-width": 3, "stroke-linecap": "round" });
    if (role === "knight") add(svg, "circle", { cx: 29, cy: 23, r: 2, fill: "var(--piece-stock)" });
    add(svg, "path", { d: "M21 49h22l3 7H18z", ...ink });
  }

  function animalGlyph(svg, role) {
    const g = add(svg, "g", { fill: "none", stroke: "currentColor", "stroke-width": 3.3, "stroke-linecap": "round", "stroke-linejoin": "round" });
    if (role === "elephant") {
      add(g, "path", { d: "M23 19c-17-8-21 18-9 23l10-4m17-19c17-8 21 18 9 23l-10-4M22 25c0-14 20-14 20 0v16c0 14-15 13-15 5" });
      add(g, "path", { d: "M26 30h1m10 0h1" }); return;
    }
    if (role === "lion") add(g, "path", { d: "M32 5l8 5 9-1 3 9 7 6-4 9 1 9-10 3-6 8-8-4-8 4-6-8-10-3 1-9-4-9 7-6 3-9 9 1z" });
    if (role === "cat" || role === "wolf") add(g, "path", { d: role === "wolf" ? "M13 26L15 6l15 12m4 0L49 6l2 20" : "M13 24V8l15 10m8 0L51 8v16" });
    if (["tiger", "leopard", "rat"].includes(role)) {
      for (const cx of [16, 48]) add(g, "circle", { cx, cy: 16, r: role === "rat" ? 10 : 7 });
    }
    if (role === "dog") add(g, "path", { d: "M21 15C6 6 5 33 14 35l7-10m22-10c15-9 16 18 7 20l-7-10" });
    add(g, "path", { d: "M13 30c0-23 38-23 38 0 0 13-9 22-19 22S13 43 13 30z", fill: "var(--piece-stock)" });
    for (const cx of [24, 40]) add(svg, "circle", { cx, cy: 30, r: 2.3, fill: "currentColor" });
    add(g, "path", { d: "M28 39l4 4 4-4m-4 4v4" });
    if (role === "tiger") add(g, "path", { d: "M26 15l3 8m9-8-3 8M14 34l7 2m29-2-7 2" });
    if (role === "leopard") for (const [cx, cy] of [[22, 22], [40, 22], [18, 38], [46, 38]]) add(svg, "circle", { cx, cy, r: 2, fill: "currentColor" });
    if (role === "cat" || role === "rat") add(g, "path", { d: "M18 41H7m11 5-9 3m37-8h11m-11 5 9 3" });
  }

  function decorateToken(container, token) {
    const piece = token.piece; if (!piece || !layouts[piece.game] || token.hasImage) return false;
    container.dataset.pieceGame = piece.game; container.dataset.pieceSide = piece.side;
    const ink = piece.game === "xiangqi" ? piece.side === "r" ? "#b84b3d" : "#314438" : piece.game === "chess" && piece.side === "w" ? "#304538" : "#fff6df";
    container.style.setProperty("--piece-ink", ink); container.style.setProperty("--piece-stock", token.color);
    if (piece.game === "xiangqi") {
      const character = document.createElement("b"); character.className = "piece-hanzi"; character.textContent = token.symbol; container.append(character);
    } else {
      const glyph = svgNode("svg", { viewBox: "0 0 64 64", class: "piece-glyph", "aria-hidden": "true", focusable: "false" });
      if (piece.game === "chess") chessGlyph(glyph, piece.role);
      if (piece.game === "jungle") animalGlyph(glyph, piece.role);
      if (piece.game === "aeroplane") add(glyph, "path", { d: "M29 7q3-6 6 0l2 17 20 13v6L37 36l-1 14 8 6v4l-12-4-12 4v-4l8-6-1-14-20 7v-6l20-13z", fill: "currentColor" });
      container.append(glyph);
      if (piece.game === "jungle") {
        const name = document.createElement("b"); name.className = "piece-animal-name"; name.textContent = token.symbol;
        const rank = document.createElement("small"); rank.className = "piece-rank"; rank.textContent = String(piece.rank);
        container.append(name, rank);
      }
    }
    return true;
  }

  root.ParlorBoardArt = Object.freeze({ board, decorateToken });
})(globalThis);
