const elements = {
  search: document.querySelector("#productSearch"),
  suggestions: document.querySelector("#suggestions"),
  hero: document.querySelector("#searchSection"),
  workspace: document.querySelector("#workspace"),
  productName: document.querySelector("#productName"),
  catalogName: document.querySelector("#catalogName"),
  okpd: document.querySelector("#okpdCode"),
  ktru: document.querySelector("#ktruCode"),
  useCases: document.querySelector("#useCases"),
  required: document.querySelector("#requiredCharacteristics"),
  optional: document.querySelector("#optionalCharacteristics"),
  requiredCount: document.querySelector("#requiredCount"),
  optionalCount: document.querySelector("#optionalCount"),
  quantity: document.querySelector("#quantity"),
  purchaseDate: document.querySelector("#purchaseDate"),
  revisionSelect: document.querySelector("#revisionSelect"),
  applicationStatus: document.querySelector("#applicationStatus"),
  snapshotNote: document.querySelector("#snapshotNote"),
  dataStatus: document.querySelector("#dataStatus"),
  score: document.querySelector("#scoreValue"),
  scoreRing: document.querySelector("#scoreRing"),
  scoreTitle: document.querySelector("#scoreTitle"),
  checkList: document.querySelector("#checkList"),
  lawDialog: document.querySelector("#lawDialog"),
  toast: document.querySelector("#toast")
};

let selectedProduct = null;
let selectedCase = 0;
let toastTimer;
let searchTimer;

elements.purchaseDate.value = new Date().toISOString().slice(0, 10);

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка HTTP ${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character]);
}

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatDate(value) {
  if (!value) return "не указана";
  return new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`));
}

async function loadStatus() {
  try {
    const status = await api("/api/status");
    const lastSuccess = status.lastRun?.status === "success";
    elements.dataStatus.innerHTML = `<i></i> ${status.verified} актуальных · ${status.cards} всего`;
    elements.dataStatus.title = lastSuccess
      ? `Последняя синхронизация: ${new Date(status.lastRun.finished_at).toLocaleString("ru-RU")}`
      : status.feedConfigured ? "Источник настроен, ожидается успешная синхронизация" : "Официальный feed URL пока не настроен";
  } catch {
    elements.dataStatus.innerHTML = "<i></i> Сервер данных недоступен";
  }
}

async function searchCatalog(query) {
  const params = new URLSearchParams({ q: query.trim(), date: elements.purchaseDate.value, limit: "20" });
  return (await api(`/api/catalog?${params}`)).items;
}

async function showSuggestions(query) {
  elements.suggestions.innerHTML = `<div class="empty-suggestion">Поиск в локальном зеркале КТРУ...</div>`;
  elements.suggestions.classList.add("open");
  try {
    const matches = await searchCatalog(query);
    elements.suggestions.innerHTML = matches.length
      ? matches.map(item => `<button class="suggestion" type="button" role="option" data-product="${item.id}"><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.catalogName)}</small></span><code>${escapeHtml(item.ktru)}</code></button>`).join("")
      : `<div class="empty-suggestion">Совпадений в загруженном каталоге нет. Проверьте синхронизацию с ЕИС.</div>`;
  } catch (error) {
    elements.suggestions.innerHTML = `<div class="empty-suggestion">${escapeHtml(error.message)}. Запустите приложение командой <b>npm start</b>.</div>`;
  }
}

function defaultCases(product) {
  if (product.cases?.length) return product.cases;
  const name = `${product.name} ${product.catalogName || ""}`.toLocaleLowerCase("ru-RU");
  if (name.includes("микрофон")) return [
    { icon: "◉", title: "Конференц-зал", note: "Выступления и совещания" },
    { icon: "◌", title: "Рабочее место", note: "Видеосвязь и запись речи" },
    { icon: "◇", title: "Мероприятия", note: "Мобильное использование" }
  ];
  if (name.includes("компьютер") || name.includes("ноутбук") || name.includes("планшет")) return [
    { icon: "▣", title: "Офисная работа", note: "Документы и ведомственные системы" },
    { icon: "⌂", title: "Работа вне офиса", note: "Мобильное использование" }
  ];
  if (name.includes("принтер")) return [{ icon: "▤", title: "Офисная печать", note: "Печать документов" }];
  return [{ icon: "◇", title: "Основная потребность", note: "Укажите назначение в документации" }];
}

function suggestedOptional(product, caseTitle) {
  if (product.optional?.length) return product.optional;
  const name = `${product.name} ${product.catalogName || ""}`.toLocaleLowerCase("ru-RU");
  if (name.includes("микрофон")) {
    const common = [
      { name: "Длина кабеля", value: "Не менее 3 м", reason: "Расстояние от места выступающего до установленного звукового оборудования превышает 2 м." },
      { name: "Разъем подключения", value: "XLR", reason: "Требуется совместимость с имеющимся у заказчика микшерным пультом." }
    ];
    return caseTitle === "Рабочее место" ? [{ name: "Подключение по USB", value: "Наличие", reason: "Требуется прямое подключение к рабочему компьютеру без отдельного микшерного пульта." }, ...common] : common;
  }
  if (name.includes("компьютер") || name.includes("ноутбук") || name.includes("планшет")) return [
    { name: "Предустановленная операционная система", value: "Наличие", reason: "Необходимо для работы в информационных системах заказчика без приобретения дополнительной лицензии." },
    { name: "Русская раскладка клавиатуры", value: "Наличие", reason: "Требуется для работы сотрудников заказчика с русскоязычными документами." }
  ];
  if (name.includes("принтер")) return [
    { name: "Двусторонняя печать", value: "Наличие", reason: "Позволяет сократить расход бумаги при печати служебных документов." },
    { name: "Сетевой интерфейс", value: "Наличие", reason: "Требуется для общего использования оборудования сотрудниками подразделения." }
  ];
  return [];
}

function renderControl(item, index) {
  const label = escapeHtml(item.name);
  if (item.type === "select" && item.options?.length) {
    return `<select data-required-value="${index}" aria-label="${label}">${item.options.map(option => `<option>${escapeHtml(option)}</option>`).join("")}</select>`;
  }
  const type = item.type === "number" ? "number" : "text";
  return `<input data-required-value="${index}" type="${type}" value="${escapeHtml(item.value || "")}" aria-label="${label}">${item.unit ? `<span class="unit-suffix">${escapeHtml(item.unit)}</span>` : ""}`;
}

function renderSource(product) {
  const application = product.application || { code: "unknown", label: "Статус не определен" };
  elements.applicationStatus.textContent = application.label;
  elements.applicationStatus.className = `status ${application.code === "mandatory" ? "success" : application.code === "unknown" ? "warning" : "muted"}`;
  const sourceLabel = product.source?.verified ? "Официальная выгрузка ЕИС" : "Демонстрационная или непроверенная запись";
  elements.snapshotNote.innerHTML = `<b>${sourceLabel}</b><br>Редакция № ${product.revisionNumber}. Импорт: ${new Date(product.importedAt).toLocaleString("ru-RU")}. Дата обязательного применения: ${formatDate(product.mandatoryFrom)}.${product.sourceUpdatedAt ? ` Обновлено в источнике: ${escapeHtml(product.sourceUpdatedAt)}.` : ""}`;
}

function renderProduct(product) {
  selectedProduct = product;
  const cases = defaultCases(product);
  if (selectedCase >= cases.length) selectedCase = 0;
  const required = product.required || [];
  const optional = suggestedOptional(product, cases[selectedCase]?.title);
  elements.productName.textContent = product.name;
  elements.catalogName.textContent = product.catalogName || product.name;
  elements.okpd.textContent = product.okpd2 || "—";
  elements.ktru.textContent = product.ktru;
  renderSource(product);
  elements.useCases.innerHTML = cases.map((item, index) => `
    <button class="use-case ${index === selectedCase ? "selected" : ""}" type="button" data-case="${index}">
      <span class="case-icon">${escapeHtml(item.icon || "◇")}</span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.note || "")}</small>
    </button>`).join("");
  elements.required.innerHTML = required.length ? required.map((item, index) => `
    <div class="characteristic">
      <div class="char-name">${escapeHtml(item.name)}<small>${escapeHtml(item.hint || "Характеристика позиции КТРУ")}</small></div>
      <div class="value-control">${renderControl(item, index)}</div>
      <div class="char-source">КТРУ · обязательно</div>
    </div>`).join("") : `<div class="empty-suggestion">В импортированной редакции нет распознанных характеристик. Проверьте исходную выгрузку ЕИС.</div>`;
  elements.optional.innerHTML = optional.map((item, index) => `
    <div class="characteristic optional-char" data-optional-row="${index}">
      <input class="char-toggle" type="checkbox" data-optional="${index}" aria-label="Добавить характеристику ${escapeHtml(item.name)}">
       <div class="char-name">${escapeHtml(item.name)}<small>Предложено для сценария «${escapeHtml(cases[selectedCase].title)}»</small></div>
      <div class="optional-fields disabled">
        <input type="text" value="${escapeHtml(item.value || "")}" aria-label="Значение характеристики ${escapeHtml(item.name)}">
        <span class="justification-label">Обоснование необходимости</span>
        <textarea aria-label="Обоснование характеристики ${escapeHtml(item.name)}">${escapeHtml(item.reason || "")}</textarea>
      </div>
    </div>`).join("") || `<div class="empty-suggestion">Дополнительные характеристики не предложены. Используйте их только при объективной потребности.</div>`;
  elements.requiredCount.textContent = `${required.length} ${plural(required.length, "характеристика", "характеристики", "характеристик")}`;
  updateCompliance();
}

async function loadRevisions(cardId, selectedRevisionId) {
  const result = await api(`/api/catalog/${cardId}/revisions?date=${encodeURIComponent(elements.purchaseDate.value)}`);
  elements.revisionSelect.innerHTML = result.items.map(item => `<option value="${item.revisionId}" ${item.revisionId === selectedRevisionId ? "selected" : ""}>Редакция № ${item.revisionNumber} · ${formatDate(item.validFrom)}${item.source?.verified ? " · ЕИС" : " · демо"}</option>`).join("");
}

async function selectProductById(id, revisionId) {
  const params = new URLSearchParams({ date: elements.purchaseDate.value });
  if (revisionId) params.set("revision", revisionId);
  try {
    const product = await api(`/api/catalog/${id}?${params}`);
    selectedCase = 0;
    elements.search.value = product.name.toLocaleLowerCase("ru-RU");
    elements.suggestions.classList.remove("open");
    renderProduct(product);
    await loadRevisions(product.id, product.revisionId);
    elements.hero.classList.add("hidden");
    elements.workspace.classList.remove("hidden");
    history.replaceState(null, "", `?product=${product.id}&date=${elements.purchaseDate.value}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    showToast(error.message);
  }
}

async function performSearch() {
  try {
    const matches = await searchCatalog(elements.search.value);
    if (matches.length === 1) await selectProductById(matches[0].id);
    else await showSuggestions(elements.search.value);
  } catch (error) {
    showToast(error.message);
  }
}

function updateCompliance() {
  if (!selectedProduct) return;
  const toggles = [...document.querySelectorAll("[data-optional]")];
  const included = toggles.filter(toggle => toggle.checked);
  const missingReasons = included.filter(toggle => !toggle.closest(".optional-char").querySelector("textarea").value.trim());
  const official = selectedProduct.source?.verified;
  const mandatoryKnown = selectedProduct.application?.code !== "unknown";
  const score = Math.max(30, 96 - (official ? 0 : 22) - (mandatoryKnown ? 0 : 14) - included.length * 3 - missingReasons.length * 22);
  elements.optionalCount.textContent = `${included.length} выбрано`;
  elements.score.textContent = score;
  elements.scoreRing.style.background = `radial-gradient(circle at center, white 58%, transparent 60%), conic-gradient(${score >= 80 ? "var(--green-2)" : "var(--orange)"} 0 ${score}%, #e5e9e5 ${score}% 100%)`;
  elements.scoreTitle.textContent = missingReasons.length ? "Нужно обоснование" : score >= 80 ? "Основные условия соблюдены" : "Есть что проверить";
  elements.checkList.innerHTML = `
    <li class="${official ? "" : "warn"}">${official ? "Редакция получена из официальной выгрузки" : "Источник карточки не подтвержден как ЕИС"}</li>
    <li class="${mandatoryKnown ? "" : "warn"}">${escapeHtml(selectedProduct.application?.label || "Дата применения не определена")}</li>
    <li class="${missingReasons.length ? "warn" : ""}">${missingReasons.length ? "Заполните обоснование дополнительных требований" : "Для выбранных доп. требований есть обоснование"}</li>
    <li class="warn">Проверьте нормирование и национальный режим</li>`;
}

function buildDescription() {
  const required = [...elements.required.querySelectorAll(".characteristic")].map(row => {
    const name = row.querySelector(".char-name").childNodes[0].textContent.trim();
    const input = row.querySelector("input, select");
    const unit = row.querySelector(".unit-suffix")?.textContent || "";
    return `- ${name}: ${input.value}${unit ? ` ${unit}` : ""}`;
  });
  const optional = [...elements.optional.querySelectorAll(".optional-char.included")].map(row => {
    const name = row.querySelector(".char-name").childNodes[0].textContent.trim();
    return `- ${name}: ${row.querySelector("input[type=text]").value}\n  Обоснование: ${row.querySelector("textarea").value}`;
  });
  const cases = defaultCases(selectedProduct);
  return `ПРОЕКТ ОПИСАНИЯ ОБЪЕКТА ЗАКУПКИ\n\nНаименование: ${selectedProduct.name}\nОКПД2: ${selectedProduct.okpd2}\nКТРУ: ${selectedProduct.ktru}\nРедакция карточки: ${selectedProduct.revisionNumber}\nИсточник: ${selectedProduct.source?.verified ? "официальная выгрузка ЕИС" : "не подтвержден"}\nПланируемая дата размещения: ${elements.purchaseDate.value}\nСтатус применения: ${selectedProduct.application?.label}\nКоличество: ${elements.quantity.value} ${document.querySelector("#unit").value}\nНазначение: ${cases[selectedCase].title}\n\nОБЯЗАТЕЛЬНЫЕ ХАРАКТЕРИСТИКИ КТРУ\n${required.join("\n") || "Не распознаны в выгрузке."}\n\nДОПОЛНИТЕЛЬНЫЕ ХАРАКТЕРИСТИКИ\n${optional.length ? optional.join("\n") : "Не установлены."}\n\nПеред размещением закупки проверьте нормирование, национальный режим и оригинал карточки в ЕИС.`;
}

async function downloadWord() {
  if (!selectedProduct) return showToast("Сначала выберите позицию каталога");
  try {
    const response = await fetch("/api/document", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: buildDescription() }) });
    if (!response.ok) throw new Error((await response.json()).error || "Не удалось сформировать документ");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = `Описание объекта закупки - ${selectedProduct.ktru}.docx`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast("Документ Word сформирован");
  } catch (error) {
    showToast(error.message);
  }
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast(successMessage);
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2800);
}

elements.search.addEventListener("input", event => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => showSuggestions(event.target.value), 220);
});
elements.search.addEventListener("focus", event => showSuggestions(event.target.value));
elements.search.addEventListener("keydown", event => { if (event.key === "Enter") performSearch(); });
document.querySelector("#searchButton").addEventListener("click", performSearch);
elements.suggestions.addEventListener("click", event => {
  const button = event.target.closest("[data-product]");
  if (button) selectProductById(button.dataset.product);
});
document.addEventListener("click", event => { if (!event.target.closest(".search-shell")) elements.suggestions.classList.remove("open"); });
document.querySelectorAll("[data-search]").forEach(button => button.addEventListener("click", () => {
  elements.search.value = button.dataset.search;
  showSuggestions(button.dataset.search);
  elements.search.focus();
}));
document.querySelector("#backToSearch").addEventListener("click", () => {
  elements.workspace.classList.add("hidden");
  elements.hero.classList.remove("hidden");
  history.replaceState(null, "", location.pathname);
  window.scrollTo({ top: 0, behavior: "smooth" });
});
elements.useCases.addEventListener("click", event => {
  const button = event.target.closest("[data-case]");
  if (!button) return;
  selectedCase = Number(button.dataset.case);
  elements.useCases.querySelectorAll(".use-case").forEach(item => item.classList.toggle("selected", item === button));
  if (selectedProduct) renderProduct(selectedProduct);
});
elements.optional.addEventListener("change", event => {
  const toggle = event.target.closest("[data-optional]");
  if (toggle) {
    const row = toggle.closest(".optional-char");
    row.classList.toggle("included", toggle.checked);
    row.querySelector(".optional-fields").classList.toggle("disabled", !toggle.checked);
  }
  updateCompliance();
});
elements.optional.addEventListener("input", updateCompliance);
elements.purchaseDate.addEventListener("change", () => { if (selectedProduct) selectProductById(selectedProduct.id); });
elements.revisionSelect.addEventListener("change", () => selectProductById(selectedProduct.id, elements.revisionSelect.value));
document.querySelector("#quantityMinus").addEventListener("click", () => elements.quantity.value = Math.max(1, Number(elements.quantity.value) - 1));
document.querySelector("#quantityPlus").addEventListener("click", () => elements.quantity.value = Math.max(1, Number(elements.quantity.value) + 1));
document.querySelector("#copyCode").addEventListener("click", () => copyText(`ОКПД2: ${selectedProduct.okpd2}\nКТРУ: ${selectedProduct.ktru}`, "Коды скопированы"));
document.querySelector("#copyDescription").addEventListener("click", () => copyText(buildDescription(), "Проект описания скопирован"));
document.querySelector("#downloadWord").addEventListener("click", downloadWord);
document.querySelectorAll("#openLaw, #openLawTop").forEach(button => button.addEventListener("click", () => elements.lawDialog.showModal()));
document.querySelector("#closeLaw").addEventListener("click", () => elements.lawDialog.close());
elements.lawDialog.addEventListener("click", event => { if (event.target === elements.lawDialog) elements.lawDialog.close(); });
document.querySelectorAll("[data-toast]").forEach(button => button.addEventListener("click", () => showToast(button.dataset.toast)));

loadStatus();
const link = new URLSearchParams(window.location.search);
if (link.get("date")) elements.purchaseDate.value = link.get("date");
if (link.get("product")) selectProductById(link.get("product"));
