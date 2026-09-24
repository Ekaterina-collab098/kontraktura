const { createReadStream, readFileSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { extname, join, normalize } = require("node:path");
const { createCatalogStore } = require("./lib/catalog-store");
const { downloadFeed, parsePayload, fetchEisCatalog } = require("./lib/eis-importer");
const { createDocx } = require("./lib/docx-generator");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DATABASE_PATH = process.env.KTRU_DATABASE || (process.env.VERCEL ? ":memory:" : join(ROOT, "data", "ktru.sqlite"));
const FEED_URL = process.env.KTRU_FEED_URL || "";
const ADMIN_TOKEN = process.env.KTRU_ADMIN_TOKEN || "";
const store = createCatalogStore(DATABASE_PATH);
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

if (store.getStatus().cards === 0) {
  const demo = JSON.parse(readFileSync(join(ROOT, "data", "demo-catalog.json"), "utf8"));
  store.importCards(demo, { sourceName: "demo-seed", verified: false });
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
}

function isAdmin(request) {
  if (ADMIN_TOKEN) return request.headers.authorization === `Bearer ${ADMIN_TOKEN}`;
  if (process.env.VERCEL) return false;
  const address = request.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address.endsWith(":127.0.0.1");
}

async function readBody(request, maxBytes = 100 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Размер загрузки превышает 100 МБ"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function synchronize() {
  if (!FEED_URL) throw new Error("Не задан KTRU_FEED_URL с адресом официальной выгрузки ЕИС");
  const { buffer, finalUrl } = await downloadFeed(FEED_URL);
  const cards = parsePayload(buffer, new URL(finalUrl).pathname);
  if (!cards.length) throw new Error("В официальной выгрузке не найдено карточек КТРУ");
  return store.importCards(cards, { sourceName: "eis-official-feed", sourceUrl: finalUrl, verified: true });
}

async function api(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/status") {
    return json(response, 200, { ...store.getStatus(), feedConfigured: Boolean(FEED_URL) });
  }
  if (request.method === "GET" && url.pathname === "/api/catalog") {
    const query = url.searchParams.get("q") || "";
    let items = store.search(query, url.searchParams.get("date"), url.searchParams.get("limit"));
    if (query.trim().length >= 2) {
      try {
        const remote = await fetchEisCatalog(query, url.searchParams.get("limit"));
        if (remote.length) {
          store.importCards(remote, { sourceName: "eis-public-catalog", sourceUrl: "https://zakupki.gov.ru/epz/ktru/search/results.html", verified: true });
          const remoteItems = remote.flatMap(card => store.search(card.code, url.searchParams.get("date"), 1));
          const seen = new Set(remoteItems.map(item => item.code));
          items = [...remoteItems, ...items.filter(item => !seen.has(item.code))].slice(0, Math.min(Number(url.searchParams.get("limit")) || 20, 100));
        }
      } catch (error) {
        console.error("Публичный каталог ЕИС недоступен:", error.message);
      }
    }
    return json(response, 200, { items });
  }
  const revisionsMatch = url.pathname.match(/^\/api\/catalog\/(\d+)\/revisions$/);
  if (request.method === "GET" && revisionsMatch) {
    return json(response, 200, { items: store.getRevisions(revisionsMatch[1], url.searchParams.get("date")) });
  }
  const cardMatch = url.pathname.match(/^\/api\/catalog\/(\d+)$/);
  if (request.method === "GET" && cardMatch) {
    const card = store.getCard(cardMatch[1], url.searchParams.get("date"), url.searchParams.get("revision"));
    return card ? json(response, 200, card) : json(response, 404, { error: "Карточка не найдена" });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/sync") {
    if (!isAdmin(request)) return json(response, 401, { error: "Требуется административный токен" });
    return json(response, 200, await synchronize());
  }
  if (request.method === "POST" && url.pathname === "/api/admin/import") {
    if (!isAdmin(request)) return json(response, 401, { error: "Требуется административный токен" });
    const buffer = await readBody(request);
    const filename = url.searchParams.get("filename") || "eis-export";
    const cards = parsePayload(buffer, filename);
    if (!cards.length) return json(response, 422, { error: "В файле не найдено карточек КТРУ" });
    return json(response, 200, store.importCards(cards, { sourceName: "eis-manual-export", verified: true }));
  }
  if (request.method === "POST" && url.pathname === "/api/document") {
    const body = JSON.parse((await readBody(request, 1024 * 1024)).toString("utf8"));
    if (!body.text || typeof body.text !== "string") return json(response, 422, { error: "Текст описания не указан" });
    const document = createDocx(body.text);
    response.writeHead(200, {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": "attachment; filename=description.docx",
      "content-length": document.length,
      "cache-control": "no-store"
    });
    return response.end(document);
  }
  return json(response, 404, { error: "API endpoint не найден" });
}

function staticFile(response, pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const safePath = normalize(relative);
  if (safePath.startsWith("..") || safePath.includes("\0") || safePath.startsWith("data") || safePath.startsWith("lib")) {
    return json(response, 404, { error: "Файл не найден" });
  }
  const filename = join(ROOT, safePath);
  try {
    const stat = statSync(filename);
    if (!stat.isFile()) return json(response, 404, { error: "Файл не найден" });
    response.writeHead(200, { "content-type": mimeTypes[extname(filename)] || "application/octet-stream", "content-length": stat.size });
    createReadStream(filename).pipe(response);
  } catch {
    json(response, 404, { error: "Файл не найден" });
  }
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await api(request, response, url);
    else if (request.method === "GET" || request.method === "HEAD") staticFile(response, url.pathname);
    else json(response, 405, { error: "Метод не поддерживается" });
  } catch (error) {
    console.error(error);
    json(response, error.statusCode || 500, { error: error.message || "Внутренняя ошибка" });
  }
}

const server = createServer(handleRequest);

if (require.main === module && !process.env.VERCEL) {
  server.listen(PORT, HOST, () => {
    console.log(`Контрактура запущена: http://${HOST}:${PORT}`);
    if (!FEED_URL) console.log("Автосинхронизация КТРУ отключена: задайте KTRU_FEED_URL.");
  });
}

if (FEED_URL && !process.env.VERCEL) {
  synchronize().then(result => console.log("КТРУ синхронизирован", result)).catch(error => console.error("Ошибка первой синхронизации:", error.message));
  const intervalHours = Math.max(1, Number(process.env.KTRU_SYNC_HOURS || 24));
  setInterval(() => synchronize().catch(error => console.error("Ошибка синхронизации:", error.message)), intervalHours * 60 * 60 * 1000).unref();
}

module.exports = { server, synchronize, handleRequest };
