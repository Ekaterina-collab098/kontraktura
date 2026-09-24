const test = require("node:test");
const assert = require("node:assert/strict");
const { createCatalogStore, applicationStatus } = require("../lib/catalog-store");
const { parsePayload, parseXml, parseEisSearch, parseEisDescription } = require("../lib/eis-importer");

const card = {
  code: "26.40.41.000-00000001",
  okpd2: "26.40.41.000",
  name: "Микрофон",
  validFrom: "2025-01-01",
  mandatoryFrom: "2025-02-01",
  required: [{ name: "Тип", type: "text", value: "Проводной" }]
};

test("одинаковая карточка не создает лишнюю редакцию", () => {
  const store = createCatalogStore();
  assert.equal(store.importCards([card], { sourceName: "test", verified: true }).created, 1);
  assert.equal(store.importCards([card], { sourceName: "test", verified: true }).unchanged, 1);
  const found = store.search("микрофон", "2025-03-01");
  assert.equal(found.length, 1);
  assert.equal(found[0].revisionNumber, 1);
  assert.equal(found[0].application.code, "mandatory");
});

test("изменение карточки сохраняется новой редакцией", () => {
  const store = createCatalogStore();
  store.importCards([card], { sourceName: "test", verified: true });
  store.importCards([{ ...card, name: "Микрофон обновленный" }], { sourceName: "test", verified: true });
  const revisions = store.getRevisions(1, "2025-03-01");
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].revisionNumber, 2);
  assert.equal(revisions[1].name, "Микрофон");
});

test("статус обязательного применения учитывает границы дат", () => {
  const revision = { validFrom: "2025-01-01", mandatoryFrom: "2025-02-01", validTo: "2025-12-31" };
  assert.equal(applicationStatus(revision, "2024-12-31").code, "not_effective");
  assert.equal(applicationStatus(revision, "2025-01-31").code, "not_mandatory");
  assert.equal(applicationStatus(revision, "2025-02-01").code, "mandatory");
  assert.equal(applicationStatus(revision, "2026-01-01").code, "expired");
});

test("импортер читает нормализованный JSON", () => {
  const cards = parsePayload(Buffer.from(JSON.stringify({ items: [{ ktruCode: card.code, okpd2Code: card.okpd2, fullName: card.name }] })), "feed.json");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].code, card.code);
  assert.equal(cards[0].name, card.name);
});

test("импортер читает XML с пространством имен", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <ns:catalog xmlns:ns="urn:eis:test">
      <ns:catalogPosition>
        <ns:code>${card.code}</ns:code>
        <ns:okpd2Code>${card.okpd2}</ns:okpd2Code>
        <ns:name>${card.name}</ns:name>
        <ns:applicationStartDate>01.02.2025</ns:applicationStartDate>
        <ns:characteristic><ns:name>Тип</ns:name><ns:value>Проводной</ns:value></ns:characteristic>
      </ns:catalogPosition>
    </ns:catalog>`;
  const cards = parseXml(xml);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].mandatoryFrom, "01.02.2025");
  assert.equal(cards[0].required[0].name, "Тип");
});

test("публичный поиск ЕИС читает карточку и даты", () => {
  const html = `<div class="search-registry-entry-block"><a href="/epz/ktru/ktruCard/commonInfo.html?itemId=26.20.11.110-00000160">26.20.11.110-00000160</a>
    <div class="registry-entry__header-mid__h4">План<span>шет</span></div>
    <div class="data-block__title">Обязательное применение</div><div class="data-block__value">09.10.2025 &nbsp;-&nbsp; Бессрочно</div>
    <div class="data-block__title">Включено в каталог</div><div class="data-block__value">12.01.2021</div>
    <div class="data-block__title">Обновлено</div><div class="data-block__value">09.09.2025</div></div>`;
  const [result] = parseEisSearch(html);
  assert.equal(result.name, "Планшет");
  assert.equal(result.mandatoryFrom, "09.10.2025");
  assert.equal(result.validFrom, "12.01.2021");
});

test("публичная карточка ЕИС отделяет обязательные характеристики", () => {
  const html = `<table><tr><td><div>Вес</div><div>характеристика не является обязательной для применения</div></td><td>1</td><td>кг</td></tr>
    <tr><td><div>Тип</div><div>характеристика является обязательной для применения</div></td><td>Стационарный</td><td></td></tr></table>`;
  const result = parseEisDescription(html, { code: card.code, name: card.name });
  assert.equal(result.required.length, 1);
  assert.match(result.required[0].name, /^Тип/);
});
