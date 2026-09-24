const { gunzipSync, inflateRawSync } = require("node:zlib");
const http = require("node:http");
const https = require("node:https");

const MAX_ARCHIVE_SIZE = 100 * 1024 * 1024;

function decodeXml(value = "") {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
}

function tagValue(xml, names) {
  for (const name of names) {
    const match = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`, "i"));
    if (match) return decodeXml(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  }
  return null;
}

function tagBlocks(xml, names) {
  const result = [];
  for (const name of names) {
    const expression = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`, "gi");
    let match;
    while ((match = expression.exec(xml))) result.push(match[1]);
    if (result.length) break;
  }
  return result;
}

function normalizeCharacteristic(value) {
  const name = String(value.name || value.characteristicName || value.title || "").trim();
  if (!name) return null;
  const values = value.options || value.values || value.valueList;
  const normalizedValues = Array.isArray(values) ? values.map(item => typeof item === "object" ? item.value || item.name : item).filter(Boolean) : [];
  return {
    name,
    hint: value.hint || value.description || "Характеристика позиции КТРУ",
    type: normalizedValues.length ? "select" : "text",
    options: normalizedValues,
    value: value.value || value.defaultValue || "",
    unit: value.unit || value.unitName || "",
    required: value.required !== false
  };
}

function findValue(object, names) {
  for (const name of names) {
    if (object[name] !== undefined && object[name] !== null) return object[name];
  }
  return null;
}

function normalizeJsonCard(value) {
  const characteristics = findValue(value, ["required", "characteristics", "characteristicList", "productCharacteristics"]) || [];
  return {
    code: findValue(value, ["code", "ktru", "ktruCode", "positionCode"]),
    okpd2: findValue(value, ["okpd2", "okpd", "okpd2Code"]),
    name: findValue(value, ["name", "catalogName", "fullName", "positionName"]),
    catalogName: findValue(value, ["catalogName", "fullName", "name", "positionName"]),
    validFrom: findValue(value, ["validFrom", "effectiveDate", "inclusionDate", "startDate"]),
    mandatoryFrom: findValue(value, ["mandatoryFrom", "applicationStartDate", "mandatoryApplicationDate"]),
    validTo: findValue(value, ["validTo", "expirationDate", "endDate", "cancelDate"]),
    sourceUpdatedAt: findValue(value, ["sourceUpdatedAt", "updateDate", "publishDate"]),
    status: findValue(value, ["status", "state"]),
    required: Array.isArray(characteristics) ? characteristics.map(normalizeCharacteristic).filter(Boolean) : [],
    optional: Array.isArray(value.optional) ? value.optional : [],
    cases: Array.isArray(value.cases) ? value.cases : []
  };
}

function collectJsonCards(value, result = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return result;
  seen.add(value);
  if (!Array.isArray(value)) {
    const code = findValue(value, ["code", "ktru", "ktruCode", "positionCode"]);
    if (/^\d{2}\.\d{2}\.\d{2}\.\d{3}-.+$/.test(String(code || ""))) {
      result.push(normalizeJsonCard(value));
      return result;
    }
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) collectJsonCards(nested, result, seen);
  return result;
}

function parseXml(xml) {
  let blocks = tagBlocks(xml, ["catalogPosition", "ktruPosition", "position", "product"]);
  if (!blocks.length) blocks = [xml];
  const cards = [];
  for (const block of blocks) {
    const code = tagValue(block, ["code", "ktruCode", "positionCode"]);
    if (!/^\d{2}\.\d{2}\.\d{2}\.\d{3}-.+$/.test(code || "")) continue;
    const characteristicBlocks = tagBlocks(block, ["characteristic", "productCharacteristic"]);
    const required = characteristicBlocks.map(item => normalizeCharacteristic({
      name: tagValue(item, ["name", "characteristicName"]),
      description: tagValue(item, ["description"]),
      value: tagValue(item, ["value", "valueText"]),
      unit: tagValue(item, ["unit", "unitName", "okeiName"])
    })).filter(Boolean);
    cards.push({
      code,
      okpd2: tagValue(block, ["okpd2Code", "okpdCode", "okpd2"]),
      name: tagValue(block, ["name", "positionName", "fullName"]),
      catalogName: tagValue(block, ["fullName", "positionName", "name"]),
      validFrom: tagValue(block, ["effectiveDate", "inclusionDate", "startDate"]),
      mandatoryFrom: tagValue(block, ["applicationStartDate", "mandatoryApplicationDate"]),
      validTo: tagValue(block, ["expirationDate", "endDate", "cancelDate"]),
      sourceUpdatedAt: tagValue(block, ["updateDate", "publishDate"]),
      status: tagValue(block, ["status", "state"]),
      required
    });
  }
  return cards;
}

function unzip(buffer) {
  const files = [];
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("Не найдена центральная директория ZIP");
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Повреждена структура ZIP");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (uncompressedSize > MAX_ARCHIVE_SIZE) throw new Error(`Файл ${name} превышает допустимый размер`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (/\.(xml|json)$/i.test(name)) {
      if (method === 0) files.push({ name, data: compressed });
      else if (method === 8) files.push({ name, data: inflateRawSync(compressed) });
      else throw new Error(`Метод сжатия ZIP ${method} не поддерживается`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function parsePayload(buffer, filename = "feed") {
  if (buffer.length > MAX_ARCHIVE_SIZE) throw new Error("Выгрузка превышает 100 МБ");
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return unzip(buffer).flatMap(file => parsePayload(file.data, file.name));
  }
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return parsePayload(gunzipSync(buffer), filename.replace(/\.gz$/i, ""));
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  if (text.startsWith("{") || text.startsWith("[")) return collectJsonCards(JSON.parse(text));
  if (text.startsWith("<")) return parseXml(text);
  throw new Error(`Неизвестный формат выгрузки ${filename}`);
}

function assertOfficialUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Адрес выгрузки должен использовать HTTPS");
  if (url.hostname !== "zakupki.gov.ru" && !url.hostname.endsWith(".zakupki.gov.ru")) {
    throw new Error("Разрешены только официальные домены zakupki.gov.ru");
  }
  return url;
}

function htmlText(value = "") {
  return decodeXml(String(value).replace(/&nbsp;|&#160;/gi, " ").replace(/<span[^>]*>/gi, "").replace(/<\/span>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function requestText(value, redirects = 0) {
  const url = new URL(value);
  assertOfficialUrl(url.toString());
  if (redirects > 5) return Promise.reject(new Error("Слишком много перенаправлений ЕИС"));
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      headers: { "user-agent": "Kontraktura-KTRU-Sync/0.3", accept: "text/html,application/xhtml+xml" },
      // ЕИС иногда отдает цепочку сертификатов, которую Node не принимает, хотя браузер принимает.
      rejectUnauthorized: false
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(requestText(new URL(response.headers.location, url).toString(), redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`ЕИС вернула HTTP ${response.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size <= MAX_ARCHIVE_SIZE) chunks.push(chunk); });
      response.on("end", () => size > MAX_ARCHIVE_SIZE ? reject(new Error("Ответ ЕИС превышает 100 МБ")) : resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

function parseEisSearch(html) {
  return html.split(/<div class="search-registry-entry-block[^>]*>/i).slice(1).map(block => {
    const codeMatch = block.match(/ktruCard\/commonInfo\.html\?itemId=([^"&]+)/i);
    const nameMatch = block.match(/registry-entry__header-mid__h4[^>]*>([\s\S]*?)<\/div>/i);
    const data = [...block.matchAll(/<div class="data-block__title">\s*([^<]+)[\s\S]*?<div class="data-block__value">\s*([^<]*)/gi)]
      .map(item => [htmlText(item[1]), htmlText(item[2])]);
    const read = label => data.find(item => item[0].toLowerCase().startsWith(label.toLowerCase()))?.[1] || htmlText(block.match(new RegExp(`${label}[\\s\\S]*?data-block__value[^>]*>([\\s\\S]*?)<\\/div>`, "i"))?.[1] || "") || null;
    const mandatory = read("Обязательное применение") || "";
    const dates = mandatory.match(/(\d{2}\.\d{2}\.\d{4})\s*-\s*(Бессрочно|\d{2}\.\d{2}\.\d{4})/i);
    return codeMatch ? {
      code: decodeURIComponent(codeMatch[1]),
      name: htmlText(nameMatch?.[1]),
      okpd2: decodeURIComponent(codeMatch[1]).split("-")[0],
      validFrom: read("Включено в каталог"),
      mandatoryFrom: dates?.[1] || null,
      validTo: dates?.[2] && !/бессрочно/i.test(dates[2]) ? dates[2] : null,
      sourceUpdatedAt: read("Обновлено"),
      sourceUrl: `https://zakupki.gov.ru/epz/ktru/ktruCard/commonInfo.html?itemId=${encodeURIComponent(decodeURIComponent(codeMatch[1]))}`
    } : null;
  }).filter(item => item?.code && item.name);
}

function parseEisDescription(html, card) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => match[1]);
  const required = rows.map(row => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => htmlText(match[1]));
    const marker = /характеристика\s+является\s+обязательной/i.test(htmlText(row)) && !/характеристика\s+не\s+является\s+обязательной/i.test(htmlText(row));
    return marker && cells.length >= 2 ? { name: cells[0], value: cells[1], unit: cells[2] || "", hint: "Обязательная характеристика позиции КТРУ", required: true } : null;
  }).filter(Boolean);
  return { ...card, required };
}

async function fetchEisCatalog(query, limit = 20) {
  const searchUrl = new URL("https://zakupki.gov.ru/epz/ktru/search/results.html");
  searchUrl.search = new URLSearchParams({ searchString: query, morphology: "on", pageNumber: "1", sortDirection: "true", recordsPerPage: "_" + Math.min(Number(limit) || 20, 50), sortBy: "ITEM_CODE", active: "on" });
  const tokens = String(query).toLocaleLowerCase("ru-RU").split(/\s+/).filter(token => token.length >= 3);
  const parsed = parseEisSearch(await requestText(searchUrl.toString()));
  const relevant = parsed.filter(card => {
    const haystack = `${card.name} ${card.code}`.toLocaleLowerCase("ru-RU");
    return !tokens.length || tokens.some(token => haystack.includes(token));
  });
  const results = relevant.slice(0, Math.min(Number(limit) || 20, 20));
  return Promise.all(results.map(async card => {
    const descriptionUrl = `https://zakupki.gov.ru/epz/ktru/ktruCard/ktru-description.html?itemId=${encodeURIComponent(card.code)}`;
    try { return parseEisDescription(await requestText(descriptionUrl), card); } catch { return { ...card, required: [] }; }
  }));
}

async function downloadFeed(value) {
  let url = assertOfficialUrl(value);
  for (let redirects = 0; redirects < 5; redirects += 1) {
    const response = await fetch(url, { redirect: "manual", headers: { "user-agent": "Kontraktura-KTRU-Sync/0.2" } });
    if (response.status >= 300 && response.status < 400) {
      url = assertOfficialUrl(new URL(response.headers.get("location"), url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`ЕИС вернула HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_ARCHIVE_SIZE) throw new Error("Выгрузка превышает 100 МБ");
    return { buffer: Buffer.from(await response.arrayBuffer()), finalUrl: url.toString() };
  }
  throw new Error("Слишком много перенаправлений при загрузке ЕИС");
}

module.exports = { parsePayload, parseXml, collectJsonCards, downloadFeed, assertOfficialUrl, fetchEisCatalog, parseEisSearch, parseEisDescription };
