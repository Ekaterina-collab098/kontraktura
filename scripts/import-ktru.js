const { readFileSync } = require("node:fs");
const { basename, resolve } = require("node:path");
const { createCatalogStore } = require("../lib/catalog-store");
const { parsePayload } = require("../lib/eis-importer");

const filename = process.argv[2];
if (!filename) {
  console.error("Использование: npm run import -- <путь-к-выгрузке-ЕИС.xml|json|zip|gz>");
  process.exitCode = 1;
} else {
  try {
    const fullPath = resolve(filename);
    const cards = parsePayload(readFileSync(fullPath), basename(fullPath));
    if (!cards.length) throw new Error("В файле не найдено карточек КТРУ");
    const database = process.env.KTRU_DATABASE || resolve(__dirname, "..", "data", "ktru.sqlite");
    const store = createCatalogStore(database);
    const result = store.importCards(cards, { sourceName: "eis-manual-export", sourceUrl: `file://${fullPath}`, verified: true });
    console.log(`Получено: ${result.received}; новых редакций: ${result.created}; без изменений: ${result.unchanged}.`);
  } catch (error) {
    console.error(`Импорт не выполнен: ${error.message}`);
    process.exitCode = 1;
  }
}
