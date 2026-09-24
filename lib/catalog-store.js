const { createHash } = require("node:crypto");
const { mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isoDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})|^(\d{1,2})[.](\d{1,2})[.](\d{4})/);
  if (!match) return null;
  const [, year, month, day, ruDay, ruMonth, ruYear] = match;
  return `${ruYear || year}-${String(ruMonth || month).padStart(2, "0")}-${String(ruDay || day).padStart(2, "0")}`;
}

function applicationStatus(revision, date = new Date().toISOString().slice(0, 10)) {
  const asOf = isoDate(date);
  if (!asOf) return { code: "unknown", label: "Дата не определена" };
  if (revision.validTo && asOf > revision.validTo) return { code: "expired", label: "Редакция не действует на выбранную дату" };
  if (revision.validFrom && asOf < revision.validFrom) return { code: "not_effective", label: "Редакция еще не действует" };
  if (!revision.mandatoryFrom) return { code: "unknown", label: "Дата обязательного применения не указана источником" };
  if (asOf < revision.mandatoryFrom) return { code: "not_mandatory", label: `Обязательное применение с ${revision.mandatoryFrom}` };
  return { code: "mandatory", label: "Обязательно к применению" };
}

function createCatalogStore(filename = ":memory:") {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      okpd2 TEXT,
      name TEXT NOT NULL,
      search_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES cards(id),
      revision_number INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_url TEXT,
      source_updated_at TEXT,
      imported_at TEXT NOT NULL,
      valid_from TEXT,
      mandatory_from TEXT,
      valid_to TEXT,
      source_status TEXT,
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_current INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL,
      UNIQUE(card_id, revision_number)
    );
    CREATE INDEX IF NOT EXISTS revisions_card_current ON revisions(card_id, is_current);
    CREATE INDEX IF NOT EXISTS revisions_dates ON revisions(card_id, valid_from, valid_to);
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      source_name TEXT NOT NULL,
      source_url TEXT,
      status TEXT NOT NULL,
      received_count INTEGER NOT NULL DEFAULT 0,
      created_count INTEGER NOT NULL DEFAULT 0,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      error_text TEXT
    );
  `);
  const cardColumns = db.prepare("PRAGMA table_info(cards)").all();
  if (!cardColumns.some(column => column.name === "search_text")) {
    db.exec("ALTER TABLE cards ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
  }

  const statements = {
    cardByCode: db.prepare("SELECT * FROM cards WHERE code = ?"),
    insertCard: db.prepare("INSERT INTO cards (code, okpd2, name, search_text, created_at) VALUES (?, ?, ?, ?, ?)"),
    updateCard: db.prepare("UPDATE cards SET okpd2 = ?, name = ?, search_text = ? WHERE id = ?"),
    currentRevision: db.prepare("SELECT * FROM revisions WHERE card_id = ? AND is_current = 1 ORDER BY revision_number DESC LIMIT 1"),
    maxRevision: db.prepare("SELECT COALESCE(MAX(revision_number), 0) AS number FROM revisions WHERE card_id = ?"),
    retireRevisions: db.prepare("UPDATE revisions SET is_current = 0 WHERE card_id = ? AND is_current = 1"),
    insertRevision: db.prepare(`INSERT INTO revisions
      (card_id, revision_number, content_hash, source_name, source_url, source_updated_at, imported_at, valid_from, mandatory_from, valid_to, source_status, is_verified, is_current, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`),
    insertRun: db.prepare("INSERT INTO sync_runs (started_at, source_name, source_url, status) VALUES (?, ?, ?, 'running')"),
    finishRun: db.prepare(`UPDATE sync_runs SET finished_at = ?, status = ?, received_count = ?, created_count = ?, unchanged_count = ?, error_text = ? WHERE id = ?`)
  };

  function normalizeCard(card) {
    const code = String(card.code || card.ktru || "").trim();
    const name = String(card.name || card.catalogName || "").trim();
    if (!/^\d{2}\.\d{2}\.\d{2}\.\d{3}-.+$/.test(code)) throw new Error(`Некорректный код КТРУ: ${code || "не указан"}`);
    if (!name) throw new Error(`Не указано наименование для ${code}`);
    return {
      ...card,
      code,
      ktru: code,
      okpd2: String(card.okpd2 || card.okpd || code.split("-")[0]).trim(),
      name,
      catalogName: String(card.catalogName || name).trim(),
      validFrom: isoDate(card.validFrom),
      mandatoryFrom: isoDate(card.mandatoryFrom),
      validTo: isoDate(card.validTo),
      required: Array.isArray(card.required) ? card.required : [],
      optional: Array.isArray(card.optional) ? card.optional : [],
      cases: Array.isArray(card.cases) ? card.cases : []
    };
  }

  function startRun(meta) {
    return Number(statements.insertRun.run(new Date().toISOString(), meta.sourceName, meta.sourceUrl || null).lastInsertRowid);
  }

  function finishRun(id, status, counters, error = null) {
    statements.finishRun.run(new Date().toISOString(), status, counters.received, counters.created, counters.unchanged, error, id);
  }

  function importCards(cards, meta = {}) {
    const source = {
      sourceName: meta.sourceName || "manual-import",
      sourceUrl: meta.sourceUrl || null,
      verified: meta.verified === true
    };
    const runId = startRun(source);
    const counters = { received: cards.length, created: 0, unchanged: 0 };
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const rawCard of cards) {
        const card = normalizeCard(rawCard);
        const now = new Date().toISOString();
        const searchText = `${card.name} ${card.catalogName} ${card.code} ${card.okpd2}`.toLocaleLowerCase("ru-RU");
        let stored = statements.cardByCode.get(card.code);
        if (!stored) {
          const result = statements.insertCard.run(card.code, card.okpd2, card.name, searchText, now);
          stored = { id: Number(result.lastInsertRowid) };
        } else {
          statements.updateCard.run(card.okpd2, card.name, searchText, stored.id);
        }
        const payload = stableStringify(card);
        const hash = createHash("sha256").update(payload).digest("hex");
        const current = statements.currentRevision.get(stored.id);
        if (current?.content_hash === hash) {
          counters.unchanged += 1;
          continue;
        }
        const revisionNumber = Number(statements.maxRevision.get(stored.id).number) + 1;
        statements.retireRevisions.run(stored.id);
        statements.insertRevision.run(
          stored.id, revisionNumber, hash, source.sourceName, source.sourceUrl,
          card.sourceUpdatedAt || null, now, card.validFrom, card.mandatoryFrom,
          card.validTo, card.status || null, source.verified ? 1 : 0, payload
        );
        counters.created += 1;
      }
      db.exec("COMMIT");
      finishRun(runId, "success", counters);
      return { runId, ...counters };
    } catch (error) {
      db.exec("ROLLBACK");
      finishRun(runId, "error", counters, error.message);
      throw error;
    }
  }

  function revisionDto(row, date) {
    const payload = JSON.parse(row.payload_json);
    return {
      ...payload,
      id: row.card_id,
      revisionId: row.id,
      revisionNumber: row.revision_number,
      source: { name: row.source_name, url: row.source_url, verified: Boolean(row.is_verified) },
      importedAt: row.imported_at,
      sourceUpdatedAt: row.source_updated_at,
      validFrom: row.valid_from,
      mandatoryFrom: row.mandatory_from,
      validTo: row.valid_to,
      application: applicationStatus({ validFrom: row.valid_from, mandatoryFrom: row.mandatory_from, validTo: row.valid_to }, date)
    };
  }

  function search(query = "", date, limit = 20) {
    const normalizedQuery = query.trim().toLocaleLowerCase("ru-RU");
    const value = `%${normalizedQuery}%`;
    const rows = db.prepare(`SELECT c.id AS card_id, c.code, c.okpd2, c.name, r.*
      FROM cards c JOIN revisions r ON r.card_id = c.id AND r.is_current = 1
      WHERE c.search_text LIKE ? OR c.code LIKE ? OR c.okpd2 LIKE ?
      ORDER BY CASE WHEN r.is_verified = 1 THEN 0 ELSE 1 END, CASE WHEN c.code = ? THEN 0 ELSE 1 END, c.name LIMIT ?`).all(value, value, value, query.trim(), Math.min(Number(limit) || 20, 100));
    return rows.map(row => revisionDto(row, date));
  }

  function getCard(id, date, revisionId) {
    let row;
    if (revisionId) {
      row = db.prepare("SELECT card_id, * FROM revisions WHERE id = ? AND card_id = ?").get(Number(revisionId), Number(id));
    } else if (date) {
      row = db.prepare(`SELECT card_id, * FROM revisions WHERE card_id = ?
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_to IS NULL OR valid_to >= ?)
        ORDER BY is_verified DESC, COALESCE(valid_from, '') DESC, revision_number DESC LIMIT 1`).get(Number(id), isoDate(date), isoDate(date));
    }
    if (!row) row = statements.currentRevision.get(Number(id));
    return row ? revisionDto({ ...row, card_id: Number(id) }, date) : null;
  }

  function getRevisions(id, date) {
    return db.prepare("SELECT card_id, * FROM revisions WHERE card_id = ? ORDER BY revision_number DESC").all(Number(id)).map(row => revisionDto(row, date));
  }

  function getStatus() {
    const counts = db.prepare("SELECT COUNT(*) AS cards, SUM(CASE WHEN is_verified = 1 THEN 1 ELSE 0 END) AS verified FROM revisions WHERE is_current = 1").get();
    const lastRun = db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").get() || null;
    return { cards: Number(counts.cards), verified: Number(counts.verified || 0), lastRun };
  }

  return { db, importCards, search, getCard, getRevisions, getStatus, applicationStatus };
}

module.exports = { createCatalogStore, applicationStatus, isoDate, stableStringify };
