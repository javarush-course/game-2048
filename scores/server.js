// Сервер рекордов игры 2048.
// HTTP на порту PORT (3000): GET /scores — лучшие результаты, POST /scores — новый результат.
// Рекорды хранит Redis по адресу REDIS_HOST:REDIS_PORT (redis:6379 — так часть называется в compose.yaml).
// Без зависимостей: HTTP — модуль node:http, Redis — маленький клиент протокола RESP поверх node:net.
"use strict";

const http = require("node:http");
const net = require("node:net");

const KEY = "scores"; // упорядоченное множество Redis: участник — имя игрока, оценка — его лучший счёт
const TOP = 10; // сколько строк отдаёт таблица
const NAME_MAX = 20;
const SCORE_MAX = 10_000_000;
const BODY_MAX = 1024;
const REDIS_TIMEOUT_MS = 3000;

function portFrom(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Bad ${name}: ${raw}`);
    process.exit(1);
  }
  return port;
}

const PORT = portFrom("PORT", 3000);
const REDIS_HOST = process.env.REDIS_HOST || "redis";
const REDIS_PORT = portFrom("REDIS_PORT", 6379);

// ---------- Redis: команды массивом строк, ответы протокола RESP2 ----------

class RedisReplyError extends Error {}

function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const s = String(arg);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

// Разбирает один ответ с позиции pos: [значение, следующая позиция] или null, если ответ пришёл не целиком.
function parse(buf, pos) {
  if (pos >= buf.length) return null;
  const eol = buf.indexOf("\r\n", pos);
  if (eol < 0) return null;
  const line = buf.toString("utf8", pos + 1, eol);
  const next = eol + 2;
  switch (buf[pos]) {
    case 0x2b: // +OK
      return [line, next];
    case 0x2d: // -ERR …
      return [new RedisReplyError(line), next];
    case 0x3a: // :1
      return [Number(line), next];
    case 0x24: { // $5\r\nhello
      const len = Number(line);
      if (len < 0) return [null, next];
      if (buf.length < next + len + 2) return null;
      return [buf.toString("utf8", next, next + len), next + len + 2];
    }
    case 0x2a: { // *2\r\n…
      const count = Number(line);
      if (count < 0) return [null, next];
      const items = [];
      let p = next;
      for (let i = 0; i < count; i++) {
        const item = parse(buf, p);
        if (!item) return null;
        items.push(item[0]);
        p = item[1];
      }
      return [items, p];
    }
    default:
      throw new Error("unexpected reply from Redis");
  }
}

class Redis {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.pending = [];
  }

  // Подключение — при первой команде: на старте Redis может быть ещё не готов.
  connect() {
    if (this.sock) return;
    const sock = net.createConnection({ host: this.host, port: this.port });
    sock.setNoDelay(true);
    sock.on("data", (chunk) => {
      if (sock !== this.sock) return;
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    sock.on("error", (err) => this.reset(sock, err));
    sock.on("close", () => this.reset(sock, new Error("connection closed")));
    this.sock = sock;
  }

  // Обрыв или ошибка: ждущие команды получают ошибку, следующая команда подключится заново.
  reset(sock, err) {
    if (sock !== this.sock) return;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    sock.destroy();
    for (const p of this.pending.splice(0)) p.reject(err);
  }

  drain() {
    let pos = 0;
    for (;;) {
      let reply;
      try {
        reply = parse(this.buf, pos);
      } catch (err) {
        this.reset(this.sock, err);
        return;
      }
      if (!reply) break;
      pos = reply[1];
      const p = this.pending.shift();
      if (!p) continue;
      if (reply[0] instanceof Error) p.reject(reply[0]);
      else p.resolve(reply[0]);
    }
    this.buf = this.buf.subarray(pos);
  }

  command(...args) {
    return new Promise((resolve, reject) => {
      this.connect();
      const sock = this.sock;
      const timer = setTimeout(
        () => this.reset(sock, new Error(`no answer in ${REDIS_TIMEOUT_MS} ms`)),
        REDIS_TIMEOUT_MS,
      );
      this.pending.push({
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      sock.write(encode(args));
    });
  }
}

const redis = new Redis(REDIS_HOST, REDIS_PORT);

async function topScores() {
  const flat = await redis.command("ZREVRANGE", KEY, 0, TOP - 1, "WITHSCORES");
  const rows = [];
  for (let i = 0; i < flat.length; i += 2) rows.push({ name: flat[i], score: Number(flat[i + 1]) });
  return rows;
}

async function saveScore(name, score) {
  // GT: у игрока остаётся лучший из его результатов
  await redis.command("ZADD", KEY, "GT", score, name);
  return Number(await redis.command("ZSCORE", KEY, name));
}

// ---------- HTTP ----------

const CORS = {
  // страница игры открыта с другого порта (8080), поэтому ответам нужно разрешение для браузера
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function send(res, status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const type = typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
  res.writeHead(status, { ...CORS, "Content-Type": type, "Cache-Control": "no-store" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function checkEntry(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: "Body must be JSON: {\"name\": \"Anna\", \"score\": 2048}" };
  }
  const name = typeof data?.name === "string" ? data.name.trim() : "";
  const score = data?.score;
  if (!name || [...name].length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    return { error: `name: from 1 to ${NAME_MAX} characters` };
  }
  if (!Number.isInteger(score) || score < 0 || score > SCORE_MAX) {
    return { error: `score: an integer from 0 to ${SCORE_MAX}` };
  }
  return { name, score };
}

function redisFailed(res, err) {
  console.error(`Redis is not available at ${REDIS_HOST}:${REDIS_PORT}: ${err.message}`);
  send(res, 503, { error: "Redis is not available" });
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (path === "/" && req.method === "GET") {
    send(res, 200, "2048 scores server: GET /scores, POST /scores\n");
    return;
  }
  if (path !== "/scores") {
    send(res, 404, { error: "Not found" });
    return;
  }
  if (req.method === "GET") {
    try {
      send(res, 200, await topScores());
    } catch (err) {
      redisFailed(res, err);
    }
    return;
  }
  if (req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      send(res, 413, { error: `Body is larger than ${BODY_MAX} bytes` });
      return;
    }
    const entry = checkEntry(body);
    if (entry.error) {
      send(res, 400, { error: entry.error });
      return;
    }
    try {
      const best = await saveScore(entry.name, entry.score);
      send(res, 201, { name: entry.name, score: entry.score, best });
    } catch (err) {
      redisFailed(res, err);
    }
    return;
  }
  res.setHeader("Allow", "GET, POST, OPTIONS");
  send(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => console.log(`Scores server listening on port ${PORT}`));

// docker stop и Ctrl+C в docker compose up присылают SIGTERM: выходим сразу, а не через 10 секунд по SIGKILL
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
