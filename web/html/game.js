// Игра 2048 с таблицей рекордов.
// Таблицу ведёт сервер рекордов (часть scores) на порту 3000 того же компьютера, что и страница.
"use strict";

(function () {
  const SIZE = 4;
  const GOAL = 2048;
  const SCORES_URL = `${location.protocol}//${location.hostname}:3000/scores`;
  const HINT = "Стрелки на клавиатуре или свайп сдвигают плитки. Одинаковые числа складываются — соберите 2048!";

  const $ = (id) => document.getElementById(id);
  const boardEl = $("board");
  const scoreEl = $("score");
  const msgEl = $("msg");
  const saveForm = $("save");
  const overEl = $("over");
  const nameEl = $("name");
  const topEl = $("top");
  const statusEl = $("status");

  let grid;
  let score;
  let won;
  let over;

  function emptyCells() {
    const cells = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) if (!grid[r][c]) cells.push([r, c]);
    }
    return cells;
  }

  function addTile() {
    const cells = emptyCells();
    if (!cells.length) return;
    const [r, c] = cells[Math.floor(Math.random() * cells.length)];
    grid[r][c] = Math.random() < 0.9 ? 2 : 4;
  }

  function newGame() {
    grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    score = 0;
    won = false;
    over = false;
    addTile();
    addTile();
    saveForm.hidden = true;
    msgEl.textContent = HINT;
    render();
  }

  // Сдвиг одной линии к её началу: соседние одинаковые плитки складываются, каждая — не больше раза за ход.
  function slide(line) {
    const tiles = line.filter(Boolean);
    const out = [];
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === tiles[i + 1]) {
        out.push(tiles[i] * 2);
        score += tiles[i] * 2;
        i++;
      } else {
        out.push(tiles[i]);
      }
    }
    while (out.length < SIZE) out.push(0);
    return out;
  }

  // Клетки линии номер i в порядке сдвига: для «влево» — строка слева направо, для «вниз» — столбец снизу вверх.
  function lineCells(dir, i) {
    const cells = [];
    for (let j = 0; j < SIZE; j++) {
      const k = dir === "left" || dir === "up" ? j : SIZE - 1 - j;
      cells.push(dir === "left" || dir === "right" ? [i, k] : [k, i]);
    }
    return cells;
  }

  function canMove() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = grid[r][c];
        if (!v) return true;
        if (c + 1 < SIZE && grid[r][c + 1] === v) return true;
        if (r + 1 < SIZE && grid[r + 1][c] === v) return true;
      }
    }
    return false;
  }

  function move(dir) {
    if (over) return;
    let moved = false;
    for (let i = 0; i < SIZE; i++) {
      const cells = lineCells(dir, i);
      const after = slide(cells.map(([r, c]) => grid[r][c]));
      cells.forEach(([r, c], j) => {
        if (grid[r][c] !== after[j]) moved = true;
        grid[r][c] = after[j];
      });
    }
    if (!moved) return;
    addTile();
    if (!won && grid.some((row) => row.some((v) => v >= GOAL))) {
      won = true;
      msgEl.textContent = "Вы собрали 2048! Можно играть дальше — до конца партии.";
    }
    if (!canMove()) {
      over = true;
      overEl.textContent = `Игра окончена. Счёт: ${score}`;
      saveForm.hidden = false;
      nameEl.focus();
    }
    render();
  }

  function render() {
    const cells = grid.flat().map((v) => {
      const cell = document.createElement("div");
      cell.className = v ? `cell v${Math.min(v, 4096)}` : "cell";
      cell.textContent = v || "";
      return cell;
    });
    boardEl.replaceChildren(...cells);
    scoreEl.textContent = score;
  }

  // ---------- таблица рекордов ----------

  async function loadTop() {
    try {
      const res = await fetch(SCORES_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      topEl.replaceChildren(
        ...rows.map((row) => {
          const li = document.createElement("li");
          const name = document.createElement("span");
          const points = document.createElement("b");
          name.textContent = row.name;
          points.textContent = row.score;
          li.append(name, points);
          return li;
        }),
      );
      statusEl.textContent = rows.length ? "" : "Пока пусто — сыграйте первым!";
    } catch {
      topEl.replaceChildren();
      statusEl.textContent = "Сервер рекордов не отвечает";
    }
  }

  async function saveScore(event) {
    event.preventDefault();
    const name = nameEl.value.trim();
    if (!name) return;
    localStorage.setItem("name", name);
    try {
      const res = await fetch(SCORES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, score }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      saveForm.hidden = true;
      await loadTop();
    } catch {
      statusEl.textContent = "Рекорд не записан: сервер рекордов не отвечает";
    }
  }

  // ---------- управление ----------

  const KEYS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  document.addEventListener("keydown", (event) => {
    if (event.target === nameEl) return;
    const dir = KEYS[event.key];
    if (!dir) return;
    event.preventDefault();
    move(dir);
  });

  let touchStart = null;
  boardEl.addEventListener("touchstart", (event) => {
    const t = event.touches[0];
    touchStart = [t.clientX, t.clientY];
  }, { passive: true });
  boardEl.addEventListener("touchend", (event) => {
    if (!touchStart) return;
    const t = event.changedTouches[0];
    const dx = t.clientX - touchStart[0];
    const dy = t.clientY - touchStart[1];
    touchStart = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 30) return;
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? "right" : "left");
    else move(dy > 0 ? "down" : "up");
  });

  $("new").addEventListener("click", () => {
    newGame();
    loadTop();
  });
  saveForm.addEventListener("submit", saveScore);

  nameEl.value = localStorage.getItem("name") || "";
  newGame();
  loadTop();
})();
