import {
  loadState,
  saveState,
  createEmptyState,
  id,
  localDate,
  extractTagNames,
  parseSomnio,
  validateBackup,
  mergeStates,
  exportBackup,
  requestPersistentStorage,
  restoreConflict,
} from "./data.js";
import {
  connectDrive,
  disconnectDrive,
  isDriveConnected,
  isNativeAndroid,
  syncDrive,
} from "./drive.js";
import { lessons, glossary } from "./content.js";
import { renderMarkdown, plainText, escapeHTML as esc } from "./markdown.js";
import { icon } from "./icons.js";
import { pickImage, pasteImage, openDrawing, fileToImage } from "./media.js";
import {
  alive,
  tagTypes,
  tagSymbols,
  isLucid,
  defaultEntryType,
  buildGraph,
  diaryStats,
  dateLabel,
  daysBack,
  dayKey,
  demoState,
} from "./model.js";

const $ = (s, root = document) => root.querySelector(s),
  $$ = (s, root = document) => [...root.querySelectorAll(s)];
let state,
  demo = false,
  realState,
  mapView,
  route = "diary",
  search = "",
  typeFilter = "all",
  tagFilter = "",
  pageSize = 30,
  installPrompt,
  saveChain = Promise.resolve(),
  editorDirty = false,
  syncing = false,
  savePending = 0,
  saveFailed = false;
const nav = [
  ["diary", "diary", "Дневник"],
  ["lessons", "lessons", "Уроки"],
  ["library", "library", "Библиотека"],
  ["map", "map", "Карта"],
  ["stats", "stats", "Статистика"],
];
const now = () => new Date().toISOString();
const activeEntries = () => alive(state.entries);
const activeTags = () => alive(state.tags);
const button = (text, ic, cls = "", attrs = "") =>
  `<button class="btn ${cls}" ${attrs}>${ic ? icon(ic) : ""}<span>${text}</span></button>`;
const empty = (title, body, action = "") =>
  `<div class="empty-state"><div class="empty-mark">${icon("moon", 36)}</div><h2>${title}</h2><p>${body}</p>${action}</div>`;
function toast(text, error = false) {
  const el = document.createElement("div");
  el.className = `toast ${error ? "error" : ""}`;
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), error ? 10000 : 4500);
}
async function persist() {
  if (demo) return;
  const snapshot = structuredClone(state);
  savePending++;
  saveChain = saveChain.catch(() => {}).then(() => saveState(snapshot));
  try {
    const saved = await saveChain;
    if (saved) state = mergeStates(state, saved);
    saveFailed = false;
  } catch (e) {
    saveFailed = true;
    e.mobPersistence = true;
    toast(
      `Не удалось сохранить: ${e.message}. Скачайте резервную копию.`,
      true,
    );
    const status = $(".offline-status");
    if (status) status.textContent = "Есть несохранённые изменения";
    throw e;
  } finally {
    savePending--;
  }
}
function chips(entry) {
  return entry.tagIds
    .map((tid) => activeTags().find((t) => t.id === tid))
    .filter(Boolean)
    .map(
      (t) =>
        `<button class="tag-chip ${t.type}" data-filter-tag="${esc(t.id)}">${esc(tagSymbols[t.type])} ${esc(t.name)}</button>`,
    )
    .join("");
}
function heading(kicker, title, desc, action = "") {
  return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${desc}</p></div>${action}</div>`;
}
function render() {
  if (!state) return;
  mapView?.destroy();
  mapView = null;
  route = location.hash.slice(1).split("/")[0] || "diary";
  if (!nav.some((n) => n[0] === route) && !["settings", "tags"].includes(route))
    route = "diary";
  const stats = diaryStats(state);
  $("#app").innerHTML =
    `<aside class="sidebar"><a class="brand" href="#diary"><img src="./mob.svg" alt="" width="50"><span>MOB<small>MIND OVER BODY</small></span></a><div class="side-label">ВАШЕ ПРОСТРАНСТВО</div><nav aria-label="Основная навигация">${nav.map(([key, ic, label]) => `<a href="#${key}" class="nav-link ${route === key ? "active" : ""}" ${route === key ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span>${key === "diary" && stats.total ? `<small>${stats.total}</small>` : ""}</a>`).join("")}</nav><div class="side-bottom"><div class="local-card"><span class="status-dot"></span><strong>Личное пространство</strong><p>Ваши истории остаются у вас.<br>Работает без интернета.</p></div><a href="#settings" class="nav-link ${route === "settings" ? "active" : ""}">${icon("settings")}<span>Настройки и данные</span></a><span class="version">MOB 1.0 <span>•</span> Исследуйте изнутри</span></div></aside><div class="workspace"><header class="topbar"><span class="breadcrumb">Пространство <span>/</span> ${nav.find((n) => n[0] === route)?.[2] || (route === "tags" ? "Теги" : "Настройки")}</span><span class="offline-status"><span class="status-dot"></span>${navigator.onLine ? "Сохранение на устройстве" : "Офлайн · всё доступно"}</span><button class="icon-btn mobile-settings" aria-label="Настройки" data-action="settings">${icon("settings")}</button></header>${demo ? `<div class="demo-banner"><span>Пример дневника · вымышленные записи, изменения не сохраняются</span><button data-action="exit-demo">Вернуться к моим данным ${icon("close", 16)}</button></div>` : ""}<main id="main" tabindex="-1">${{ diary: renderDiary, lessons: renderLessons, library: renderLibrary, map: renderMap, stats: renderStats, settings: renderSettings, tags: renderTags }[route]()}</main><nav class="mobile-nav" aria-label="Мобильная навигация">${nav.map(([key, ic, label]) => `<a href="#${key}" class="${route === key ? "active" : ""}" ${route === key ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span></a>`).join("")}</nav></div>`;
  bindCommon();
  ({
    diary: bindDiary,
    lessons: bindLessons,
    library: bindLibrary,
    map: bindMap,
    stats: bindStats,
    settings: bindSettings,
    tags: bindTags,
  })[route]();
  document.title = `MOB · ${nav.find((n) => n[0] === route)?.[2] || "Личное пространство"}`;
}
function renderDiary() {
  const stats = diaryStats(state);
  return `${heading("ДНЕВНИК СНОВ И ПРАКТИК", "Между сном и явью", "Сохраняйте ускользающее. Замечайте связи.", button("Новая запись", "plus", "primary", 'data-action="new-entry"'))}<section class="hero"><div class="hero-copy"><div class="hero-date">${icon("moon", 16)} ${dateLabel(localDate(), { day: "numeric", month: "long", weekday: "long" })}</div><h2>С чего началась<br>ваша история сегодня?</h2><p>Сон, мимолётный образ или маленькое открытие.<br> У каждого воспоминания есть своё место.</p>${button("Записать воспоминание", "arrow", "light", 'data-action="new-entry"')}</div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit orbit-three"></div><div class="planet"></div><span class="star star-one">✦</span><span class="star star-two">+</span><span class="star star-three">·</span><div class="art-coordinate">55° N · ВНУТРИ ВАС</div></div></section><div class="overview">${[
    [stats.dreams, "сновидений", "moon"],
    [stats.lucid, "осознанных снов", "flame"],
    [stats.practice, "дневных практик", "sun"],
    [stats.locations, "локаций на карте", "map"],
  ]
    .map(
      ([n, l, ic]) =>
        `<div class="metric"><span class="metric-icon">${icon(ic)}</span><div><strong>${n}</strong><span>${l}</span></div></div>`,
    )
    .join(
      "",
    )}</div><div class="journal-layout"><section class="journal-main"><div class="section-title"><h2>Ваши записи <span>${stats.total}</span></h2><a href="#tags" class="text-link">Управлять тегами ${icon("arrow", 16)}</a></div><div class="journal-tools"><div class="segmented" role="group" aria-label="Тип записей">${[
    ["all", "Все"],
    ["dream", "Сны"],
    ["practice", "Практики"],
  ]
    .map(
      ([v, l]) =>
        `<button data-type="${v}" class="${typeFilter === v ? "selected" : ""}">${l}</button>`,
    )
    .join(
      "",
    )}</div><label class="search-field">${icon("search", 18)}<input id="diary-search" type="search" placeholder="Найти воспоминание" value="${esc(search)}" aria-label="Поиск по дневнику"></label></div>${tagFilter ? `<div class="filter-notice">Тег: ${esc(activeTags().find((t) => t.id === tagFilter)?.name || tagFilter)} <button data-action="clear-tag">Сбросить ${icon("close", 14)}</button></div>` : ""}<div id="entry-list">${entryList()}</div></section><aside class="journal-aside"><div class="practice-card"><div class="eyebrow">МАЛЕНЬКАЯ ПРАКТИКА</div><div class="practice-illustration">${icon("sun", 35)}</div><h3>Остановитесь на мгновение</h3><p>Что вы сейчас видите, слышите и чувствуете? Заметьте три детали вокруг и вернитесь к своему дню.</p><button class="text-link" data-action="quick-practice">Записать наблюдение ${icon("arrow", 16)}</button></div><div class="course-teaser"><div class="eyebrow">ПУТЬ ИССЛЕДОВАТЕЛЯ</div><h3>Научиться помнить</h3><p>Первые шаги к более ясным снам начинаются утром.</p><a href="#lessons" class="text-link">Открыть курс ${icon("arrow", 16)}</a><div class="mini-progress"><span style="width:${(completedCount() / Math.max(1, lessons.length)) * 100}%"></span></div><small>${completedCount()} из ${lessons.length} уроков пройдено</small></div>${stats.total === 0 ? `<button class="demo-link" data-action="demo">${icon("map")} Посмотреть пример дневника</button>` : ""}</aside></div>`;
}
function matchingEntries() {
  const q = search.trim().toLocaleLowerCase("ru");
  return activeEntries()
    .filter(
      (e) =>
        (typeFilter === "all" || e.type === typeFilter) &&
        (!tagFilter || e.tagIds.includes(tagFilter)) &&
        (!q ||
          `${e.title} ${e.body} ${e.tagIds.map((tid) => activeTags().find((t) => t.id === tid)?.name || "").join(" ")}`
            .toLocaleLowerCase("ru")
            .includes(q)),
    )
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
    );
}
function entryList() {
  const entries = matchingEntries();
  if (!entries.length)
    return empty(
      activeEntries().length
        ? "Пока ничего не найдено"
        : "Первое воспоминание — начало пути",
      activeEntries().length
        ? "Попробуйте другой запрос или снимите фильтры."
        : "Запишите хотя бы один образ. Или перенесите историю из Somnio — ваши теги и даты сохранятся.",
      activeEntries().length
        ? ""
        : `<div class="button-row">${button("Добавить запись", "plus", "primary", 'data-action="new-entry"')}${button("Импорт Somnio", "upload", "", 'data-action="import"')}</div>`,
    );
  let day = "";
  return (
    entries
      .slice(0, pageSize)
      .map((e) => {
        const dayHead =
          day !== e.date
            ? `<div class="date-divider"><span>${e.date === localDate() ? "Сегодня" : dateLabel(e.date, { day: "numeric", month: "long", year: "numeric" })}</span><i></i></div>`
            : "";
        day = e.date;
        return `${dayHead}<article class="entry-card ${isLucid(e, state.tags) ? "lucid" : ""}"><div class="entry-top"><span class="entry-type">${icon(e.type === "dream" ? "moon" : "sun", 15)} ${e.type === "dream" ? "Сновидение" : "Дневная практика"}</span>${isLucid(e, state.tags) ? `<span class="lucid-label">${icon("flame", 13)} ОС</span>` : ""}<button class="icon-btn" data-edit="${esc(e.id)}" aria-label="Редактировать ${esc(e.title)}">${icon("edit", 17)}</button></div><button class="entry-open" data-open-entry="${esc(e.id)}"><h3>${esc(e.title || "Без названия")}</h3><p>${esc(plainText(e.body).slice(0, 260))}${plainText(e.body).length > 260 ? "…" : ""}</p></button>${
          e.images?.length
            ? `<div class="entry-images">${e.images
                .slice(0, 3)
                .map(
                  (i) =>
                    `<button data-open-entry="${esc(e.id)}"><img src="${esc(i.src)}" alt="${esc(i.caption || "Иллюстрация записи")}" loading="lazy"></button>`,
                )
                .join("")}</div>`
            : ""
        }<div class="entry-footer"><div class="tag-list">${chips(e)}</div><span>${new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" }).format(new Date(e.createdAt))}</span></div></article>`;
      })
      .join("") +
    (entries.length > pageSize
      ? button(
          `Ещё записи (${entries.length - pageSize})`,
          "chevron",
          "",
          'data-action="more"',
        )
      : "")
  );
}
function bindCommon() {
  $$('[data-action="new-entry"]').forEach(
    (b) => (b.onclick = () => openEditor()),
  );
  $$('[data-action="import"]').forEach((b) => (b.onclick = () => importFile()));
  $$("[data-filter-tag]").forEach(
    (b) =>
      (b.onclick = () => {
        tagFilter = b.dataset.filterTag;
        search = "";
        typeFilter = "all";
        if (route === "diary") render();
        else location.hash = "diary";
      }),
  );
  $$("[data-edit]").forEach(
    (b) =>
      (b.onclick = () =>
        openEditor(state.entries.find((e) => e.id === b.dataset.edit))),
  );
  $$("[data-open-entry]").forEach(
    (b) => (b.onclick = () => openEntry(b.dataset.openEntry)),
  );
  $$('[data-action="settings"]').forEach(
    (b) => (b.onclick = () => (location.hash = "settings")),
  );
  $$('[data-action="exit-demo"]').forEach(
    (b) =>
      (b.onclick = () => {
        demo = false;
        state = realState;
        realState = null;
        tagFilter = "";
        render();
      }),
  );
  $$('[data-action="demo"]').forEach(
    (b) =>
      (b.onclick = () => {
        if (savePending || syncing)
          return toast("Дождитесь завершения сохранения или синхронизации");
        realState = state;
        state = demoState();
        demo = true;
        render();
      }),
  );
}
function bindDiary() {
  $("#diary-search").oninput = (e) => {
    search = e.target.value;
    pageSize = 30;
    $("#entry-list").innerHTML = entryList();
    bindCommon();
    bindMore();
  };
  $$("[data-type]").forEach(
    (b) =>
      (b.onclick = () => {
        typeFilter = b.dataset.type;
        pageSize = 30;
        render();
      }),
  );
  $('[data-action="clear-tag"]')?.addEventListener("click", () => {
    tagFilter = "";
    render();
  });
  $('[data-action="quick-practice"]')?.addEventListener("click", () =>
    openEditor(null, {
      type: "practice",
      title: "Три детали настоящего",
      body: "Сегодня я замечаю:\n\n- Вижу: \n- Слышу: \n- Чувствую: ",
    }),
  );
  bindMore();
}
function bindMore() {
  $('[data-action="more"]')?.addEventListener("click", () => {
    pageSize += 30;
    $("#entry-list").innerHTML = entryList();
    bindCommon();
    bindMore();
  });
}

function dialog(content, cls = "") {
  const el = document.createElement("dialog");
  el.className = `modal ${cls}`;
  el.innerHTML = content;
  document.body.append(el);
  el.showModal();
  el.addEventListener("close", () => el.remove());
  el.addEventListener("click", (e) => {
    if (
      e.target === el &&
      e.clientX >= el.getBoundingClientRect().left &&
      e.clientX <= el.getBoundingClientRect().right &&
      e.clientY >= el.getBoundingClientRect().top &&
      e.clientY <= el.getBoundingClientRect().bottom
    )
      return;
    if (
      e.target === el &&
      el.dispatchEvent(new Event("cancel", { cancelable: true }))
    )
      el.close();
  });
  $$("[data-close]", el).forEach(
    (b) =>
      (b.onclick = () => {
        const event = new Event("cancel", { cancelable: true });
        if (el.dispatchEvent(event)) el.close();
      }),
  );
  return el;
}
function modalHead(kicker, title) {
  return `<div class="modal-heading"><div><div class="eyebrow">${kicker}</div><h2>${title}</h2></div><button class="icon-btn" data-close aria-label="Закрыть">${icon("close")}</button></div>`;
}
async function confirmAction(title, text, label = "Продолжить") {
  return new Promise((resolve) => {
    const el = dialog(
      `${modalHead("ПОДТВЕРЖДЕНИЕ", esc(title))}<p>${esc(text)}</p><div class="modal-actions">${button("Отмена", null, "", "data-close")}${button(label, null, "primary", "data-confirm")}</div>`,
      "confirm-modal",
    );
    let done = false;
    $("[data-confirm]", el).onclick = () => {
      done = true;
      resolve(true);
      el.close();
    };
    el.addEventListener("close", () => {
      if (!done) resolve(false);
    });
  });
}
function openEntry(entryId) {
  const e = state.entries.find((e) => e.id === entryId);
  if (!e) return;
  const el = dialog(
    `${modalHead(e.type === "dream" ? "СНОВИДЕНИЕ" : "ДНЕВНАЯ ПРАКТИКА", esc(e.title || "Без названия"))}<div class="reader-meta">${dateLabel(e.date, { day: "numeric", month: "long", year: "numeric" })} <div class="tag-list">${chips(e)}</div></div><div class="prose">${renderMarkdown(e.body)}</div>${e.images.map((i) => `<figure><img class="reader-image" src="${esc(i.src)}" alt="${esc(i.caption || "Иллюстрация")}"><figcaption>${esc(i.caption || "")}</figcaption></figure>`).join("")}<div class="modal-actions">${button("Удалить", "trash", "danger", "data-delete")}${button("Редактировать", "edit", "primary", "data-edit-current")}</div>`,
    "reader-modal",
  );
  $("[data-edit-current]", el).onclick = () => {
    el.close();
    openEditor(e);
  };
  $("[data-delete]", el).onclick = async () => {
    if (
      await confirmAction(
        "Удалить запись?",
        "Запись исчезнет из дневника и карты. Удаление будет передано при синхронизации.",
        "Удалить",
      )
    ) {
      e.deletedAt = now();
      e.updatedAt = now();
      await persist();
      el.close();
      render();
      toast("Запись удалена");
    }
  };
  $$("[data-filter-tag]", el).forEach(
    (b) =>
      (b.onclick = () => {
        tagFilter = b.dataset.filterTag;
        el.close();
        location.hash = "diary";
        render();
      }),
  );
}

function openEditor(existing = null, preset = {}) {
  let savedDraft = null;
  try {
    if (!existing && !Object.keys(preset).length)
      savedDraft = JSON.parse(localStorage.getItem("mob-editor-draft"));
  } catch {}
  const entry = structuredClone(
    existing || {
      id: id("entry"),
      title: "",
      body: "",
      date: localDate(),
      type: defaultEntryType(state.entries, localDate()),
      tagIds: [],
      images: [],
      createdAt: now(),
      updatedAt: now(),
      ...savedDraft,
      ...preset,
    },
  );
  let manualType = !!existing || !!preset.type || !!savedDraft,
    dirty = false,
    editing = true;
  const selected = new Set(entry.tagIds);
  const el = dialog(
    `${modalHead(existing ? "РЕДАКТИРОВАНИЕ" : "НОВОЕ ВОСПОМИНАНИЕ", existing ? "Вернуться к истории" : "Что хочется сохранить?")}<form id="entry-form"><div class="editor-meta"><label>Дата<input name="date" type="date" required value="${esc(entry.date)}"></label><label>Тип записи<select name="type"><option value="dream" ${entry.type === "dream" ? "selected" : ""}>Сновидение</option><option value="practice" ${entry.type === "practice" ? "selected" : ""}>Дневная практика</option></select></label></div><label class="sr-only" for="entry-title">Название</label><input id="entry-title" name="title" class="title-input" placeholder="Дайте воспоминанию имя" maxlength="240" value="${esc(entry.title)}"><div class="editor-toolbar"><div class="segmented"><button type="button" data-mode="write" class="selected">Текст</button><button type="button" data-mode="preview">Просмотр</button></div><span class="markdown-label">Markdown</span><button type="button" class="icon-btn" data-format="bold" aria-label="Жирный текст"><b>B</b></button><button type="button" class="icon-btn" data-format="italic" aria-label="Курсив"><i>I</i></button><button type="button" class="icon-btn" data-format="list" aria-label="Список">≡</button></div><label class="sr-only" for="entry-body">Текст записи</label><textarea name="body" id="entry-body" placeholder="Начните с того, что осталось в памяти…\n\nТеги можно добавлять прямо в тексте: @Лес или %[Дом у моря].">${esc(entry.body)}</textarea><div id="markdown-preview" class="prose" hidden></div><div class="editor-hint">@тег или %[тег с пробелами] <span id="draft-status">${savedDraft ? "Черновик восстановлен" : "Только на вашем устройстве"}</span></div><div class="editor-section"><label for="tag-input">Теги и связи</label><div id="selected-tags" class="tag-list"></div><div class="inline-form"><input id="tag-input" placeholder="Добавить тег…" autocomplete="off" list="tag-options"><datalist id="tag-options">${activeTags()
      .map((t) => `<option value="${esc(t.name)}">${tagTypes[t.type]}</option>`)
      .join(
        "",
      )}</datalist><select id="tag-type" aria-label="Тип нового тега">${Object.entries(
      tagTypes,
    )
      .map(
        ([v, l]) =>
          `<option value="${v}" ${v === "theme" ? "selected" : ""}>${l}</option>`,
      )
      .join(
        "",
      )}</select>${button("Добавить", "plus", "", 'type="button" data-add-tag')}</div><div id="tag-suggestions" class="tag-list"></div></div><div class="editor-section"><label>Иллюстрации</label><div class="media-toolbar">${button("Из файла", "image", "", 'type="button" data-media="file"')}${button("Камера", "camera", "", 'type="button" data-media="camera"')}${button("Нарисовать", "draw", "", 'type="button" data-media="draw"')}</div><p class="hint">Изображение можно также вставить из буфера обмена.</p><div id="editor-images" class="editor-images"></div></div><div class="modal-actions"><button type="button" class="btn" data-close>Отмена</button><button type="submit" class="btn primary">${icon("check")} Сохранить запись</button></div></form>`,
    "editor-modal",
  );
  const form = $("#entry-form", el),
    body = $('[name="body"]', el);
  const pendingTags = savedDraft?.pendingTags || [];
  const read = () => ({
    ...entry,
    title: $('[name="title"]', el).value.trim(),
    body: body.value,
    date: $('[name="date"]', el).value,
    type: $('[name="type"]', el).value,
    tagIds: [...selected],
  });
  const changed = () => {
    dirty = true;
    editorDirty = true;
    const data = read();
    if (!existing && !demo) {
      try {
        localStorage.setItem(
          "mob-editor-draft",
          JSON.stringify({ ...data, images: [], pendingTags }),
        );
        $("#draft-status", el).textContent = "Текст черновика сохранён";
      } catch {
        $("#draft-status", el).textContent = "Черновик только в открытом окне";
      }
    }
  };
  function renderSelected() {
    $("#selected-tags", el).innerHTML = [...selected]
      .map((tid) => [...activeTags(), ...pendingTags].find((t) => t.id === tid))
      .filter(Boolean)
      .map(
        (t) =>
          `<button type="button" class="tag-chip ${t.type}" data-remove-tag="${esc(t.id)}">${tagSymbols[t.type]} ${esc(t.name)} ${icon("close", 12)}</button>`,
      )
      .join("");
    $$("[data-remove-tag]", el).forEach(
      (b) =>
        (b.onclick = () => {
          selected.delete(b.dataset.removeTag);
          renderSelected();
          changed();
        }),
    );
  }
  function addTag(name, type = "theme") {
    name = name
      .trim()
      .replace(/^[@%]/, "")
      .replace(/^\[|\]$/g, "")
      .trim()
      .slice(0, 100);
    if (!name) return;
    let tag = [...activeTags(), ...pendingTags].find(
      (t) => t.name.toLowerCase() === name.toLowerCase(),
    );
    if (!tag) {
      tag = {
        id: id("tag"),
        name,
        type: name.toLowerCase() === "ос" ? "result" : type,
        description: "",
        image: null,
        createdAt: now(),
        updatedAt: now(),
      };
      pendingTags.push(tag);
    }
    selected.add(tag.id);
    renderSelected();
    changed();
  }
  function renderImages() {
    $("#editor-images", el).innerHTML = entry.images
      .map(
        (im, i) =>
          `<div class="image-edit"><img src="${esc(im.src)}" alt="Иллюстрация ${i + 1}"><input aria-label="Подпись к иллюстрации ${i + 1}" data-caption="${i}" value="${esc(im.caption || "")}" placeholder="Подпись…"><button type="button" class="icon-btn" data-remove-image="${i}" aria-label="Удалить иллюстрацию ${i + 1}">${icon("close", 16)}</button></div>`,
      )
      .join("");
    $$("[data-remove-image]", el).forEach(
      (b) =>
        (b.onclick = () => {
          entry.images.splice(Number(b.dataset.removeImage), 1);
          renderImages();
          changed();
        }),
    );
    $$("[data-caption]", el).forEach(
      (input) =>
        (input.oninput = () => {
          entry.images[Number(input.dataset.caption)].caption = input.value;
          changed();
        }),
    );
  }
  const attach = (im) => {
    if (!im || !editing) return;
    if (entry.images.length >= 12)
      return toast("Не более 12 иллюстраций в одной записи", true);
    entry.images.push(im);
    renderImages();
    changed();
  };
  $$("[data-media]", el).forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          if (b.dataset.media === "draw") openDrawing({ onSave: attach });
          else
            attach(await pickImage({ capture: b.dataset.media === "camera" }));
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
  el.addEventListener("paste", async (e) => {
    try {
      attach(await pasteImage(e));
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("[data-add-tag]", el).onclick = () => {
    addTag($("#tag-input", el).value, $("#tag-type", el).value);
    $("#tag-input", el).value = "";
  };
  $("#tag-input", el).onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("[data-add-tag]", el).click();
    }
  };
  body.oninput = () => {
    changed();
    const match = body.value
      .slice(0, body.selectionStart)
      .match(/(?:^|\s)[@%]([^\s@%\[\]]*)$/u);
    $("#tag-suggestions", el).innerHTML = match
      ? activeTags()
          .filter((t) =>
            t.name.toLowerCase().startsWith(match[1].toLowerCase()),
          )
          .slice(0, 6)
          .map(
            (t) =>
              `<button type="button" class="tag-chip" data-suggestion="${esc(t.id)}">${esc(t.name)}</button>`,
          )
          .join("")
      : "";
    $$("[data-suggestion]", el).forEach(
      (b) =>
        (b.onclick = () => {
          const t = activeTags().find((t) => t.id === b.dataset.suggestion);
          const before = body.value.slice(0, body.selectionStart),
            after = body.value.slice(body.selectionStart);
          body.value =
            before.replace(/[@%][^\s@%\[\]]*$/u, `@[${t.name}] `) + after;
          addTag(t.name, t.type);
          $("#tag-suggestions", el).innerHTML = "";
          body.focus();
        }),
    );
  };
  $('[name="title"]', el).oninput = changed;
  $('[name="date"]', el).onchange = () => {
    if (!manualType)
      $('[name="type"]', el).value = defaultEntryType(
        state.entries,
        $('[name="date"]', el).value,
      );
    changed();
  };
  $('[name="type"]', el).onchange = () => {
    manualType = true;
    changed();
  };
  $$("[data-mode]", el).forEach(
    (b) =>
      (b.onclick = () => {
        const preview = b.dataset.mode === "preview";
        body.hidden = preview;
        $("#markdown-preview", el).hidden = !preview;
        $("#markdown-preview", el).innerHTML =
          renderMarkdown(body.value) ||
          '<p class="hint">Здесь появится форматированный текст.</p>';
        $$("[data-mode]", el).forEach((x) =>
          x.classList.toggle("selected", x === b),
        );
      }),
  );
  $$("[data-format]", el).forEach(
    (b) =>
      (b.onclick = () => {
        const a = body.selectionStart,
          z = body.selectionEnd,
          text = body.value.slice(a, z);
        const wrap =
          b.dataset.format === "bold"
            ? "**"
            : b.dataset.format === "italic"
              ? "*"
              : "";
        const replacement = wrap
          ? wrap + (text || "текст") + wrap
          : "\n- " + text;
        body.setRangeText(replacement, a, z, "select");
        body.focus();
        changed();
      }),
  );
  el.addEventListener("cancel", async (e) => {
    e.preventDefault();
    if (
      !dirty ||
      (await confirmAction(
        "Закрыть запись?",
        "Несохранённые изменения не попадут в дневник. Текст новой записи останется в черновике.",
        "Закрыть",
      ))
    )
      el.close();
  });
  el.addEventListener("close", () => {
    editing = false;
    editorDirty = false;
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const value = read();
    if (!value.body.trim() && !value.title && !entry.images.length) {
      toast("Добавьте текст, название или иллюстрацию", true);
      return;
    }
    const submit = $('[type="submit"]', el);
    submit.disabled = true;
    try {
      extractTagNames(value.body).forEach((n) => addTag(n));
      value.tagIds = [...selected];
      value.title =
        value.title ||
        plainText(value.body).split("\n")[0].slice(0, 80) ||
        "Воспоминание";
      value.updatedAt = now();
      state.tags.push(
        ...pendingTags.filter(
          (t) =>
            selected.has(t.id) &&
            !state.tags.some((existing) => existing.id === t.id),
        ),
      );
      const ix = state.entries.findIndex((e) => e.id === value.id);
      if (ix >= 0) state.entries[ix] = value;
      else state.entries.push(value);
      await persist();
      if (!existing && !demo) {
        try {
          localStorage.removeItem("mob-editor-draft");
        } catch {}
      }
      dirty = false;
      editorDirty = false;
      el.close();
      render();
      toast("Запись сохранена");
    } catch (err) {
      toast(err.message, true);
      submit.disabled = false;
    }
  };
  renderSelected();
  renderImages();
}

function renderTags() {
  return `${heading("СЛОВАРЬ ВАШЕГО МИРА", "Теги и связи", "Места, персонажи и повторяющиеся мотивы ваших историй.", button("Создать тег", "plus", "primary", "data-new-tag"))}<div class="tag-type-legend">${Object.entries(
    tagTypes,
  )
    .map(([v, l]) => `<span class="tag-chip ${v}">${tagSymbols[v]} ${l}</span>`)
    .join("")}</div><div class="tag-grid">${
    activeTags()
      .map(
        (t) =>
          `<article class="tag-card"><button data-edit-tag="${esc(t.id)}" class="tag-visual ${t.type}">${t.image ? `<img src="${esc(t.image.src || t.image)}" alt="${esc(t.name)}">` : `<span>${tagSymbols[t.type]}</span>`}</button><div><span class="eyebrow">${tagTypes[t.type]}</span><h3>${esc(t.name)}</h3><p>${esc(t.description || "Добавьте описание — оно поможет узнать этот образ.")}</p><div class="tag-card-actions"><button class="text-link" data-filter-tag="${esc(t.id)}">${activeEntries().filter((e) => e.tagIds.includes(t.id)).length} записей ${icon("arrow", 14)}</button><button class="icon-btn" data-edit-tag="${esc(t.id)}" aria-label="Редактировать тег ${esc(t.name)}">${icon("edit", 16)}</button></div></div></article>`,
      )
      .join("") ||
    empty(
      "Дайте своим образам имена",
      "Создайте локацию или персонажа, чтобы они появились на карте.",
    )
  }</div>`;
}
function bindTags() {
  $("[data-new-tag]").onclick = () => openTagEditor();
  $$("[data-edit-tag]").forEach(
    (b) =>
      (b.onclick = () =>
        openTagEditor(activeTags().find((t) => t.id === b.dataset.editTag))),
  );
}
function openTagEditor(existing) {
  const tag = structuredClone(
    existing || {
      id: id("tag"),
      name: "",
      type: "location",
      description: "",
      image: null,
      createdAt: now(),
      updatedAt: now(),
    },
  );
  const el = dialog(
    `${modalHead("ТЕГ", existing ? "Настроить образ" : "Новый образ")}<form id="tag-form"><label>Имя<input name="name" required maxlength="100" value="${esc(tag.name)}" placeholder="Например, Тихий лес"></label><label>Тип<select name="type">${Object.entries(
      tagTypes,
    )
      .map(
        ([v, l]) =>
          `<option value="${v}" ${tag.type === v ? "selected" : ""}>${l}</option>`,
      )
      .join(
        "",
      )}</select></label><label>Описание<textarea name="description" rows="5" placeholder="Как выглядит это место? Что вы о нём помните?">${esc(tag.description)}</textarea></label><div id="tag-image-preview"></div><div class="media-toolbar">${button("Файл", "image", "", 'type="button" data-image="file"')}${button("Камера", "camera", "", 'type="button" data-image="camera"')}${button("Рисунок", "draw", "", 'type="button" data-image="draw"')}</div><p class="hint">Можно вставить изображение из буфера обмена.</p><div class="modal-actions">${existing ? button("Удалить", "trash", "danger", 'type="button" data-delete-tag') : ""}<button type="submit" class="btn primary">${icon("check")} Сохранить тег</button></div></form>`,
  );
  const showImage = () => {
    $("#tag-image-preview", el).innerHTML = tag.image
      ? `<div class="tag-image-preview"><img src="${esc(tag.image.src)}" alt="Иллюстрация тега"><button class="icon-btn" type="button" data-remove-tag-image aria-label="Удалить изображение">${icon("close")}</button></div>`
      : "";
    $("[data-remove-tag-image]", el)?.addEventListener("click", () => {
      tag.image = null;
      showImage();
    });
  };
  const attach = (i) => {
    if (i) {
      tag.image = i;
      showImage();
    }
  };
  $$("[data-image]", el).forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          if (b.dataset.image === "draw")
            openDrawing({ initial: tag.image?.src, onSave: attach });
          else
            attach(await pickImage({ capture: b.dataset.image === "camera" }));
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
  el.addEventListener("paste", async (e) => {
    try {
      attach(await pasteImage(e));
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#tag-form", el).onsubmit = async (e) => {
    e.preventDefault();
    tag.name = $('[name="name"]', el).value.trim();
    if (!tag.name) return;
    const duplicate = activeTags().find(
      (t) => t.id !== tag.id && t.name.toLowerCase() === tag.name.toLowerCase(),
    );
    if (duplicate) return toast("Тег с таким именем уже есть", true);
    tag.type = $('[name="type"]', el).value;
    tag.description = $('[name="description"]', el).value;
    tag.updatedAt = now();
    const ix = state.tags.findIndex((t) => t.id === tag.id);
    if (ix >= 0) state.tags[ix] = tag;
    else state.tags.push(tag);
    await persist();
    el.close();
    render();
    toast("Тег сохранён");
  };
  $("[data-delete-tag]", el)?.addEventListener("click", async () => {
    if (
      await confirmAction(
        "Удалить тег?",
        "Записи сохранятся. Тег и его связи исчезнут с карты.",
        "Удалить",
      )
    ) {
      existing.deletedAt = now();
      existing.updatedAt = now();
      await persist();
      el.close();
      render();
    }
  });
  showImage();
}

function completedCount() {
  return lessons.filter(
    (l) => state.progress[l.id] === true || state.progress[l.id]?.completed,
  ).length;
}
function renderLessons() {
  const total = lessons.length,
    done = completedCount();
  return `${heading("ПУТЬ ИССЛЕДОВАТЕЛЯ", "Знание становится опытом", "Сны, внимание, воображение и внутренние миры — в своём ритме.")}<div class="course-banner"><div><span class="eyebrow">ПОЛНЫЙ КУРС MOB</span><h2>Исследуйте себя.<br>Шаг за шагом.</h2><p>${total} урока · 12 модулей · теория и практика</p></div><div class="course-progress"><strong>${done}<span> / ${total}</span></strong><span>уроков пройдено</span><div class="mini-progress"><span style="width:${(done / Math.max(total, 1)) * 100}%"></span></div></div></div><div class="lesson-layout"><aside class="course-outline"><span class="eyebrow">МОДУЛИ КУРСА</span>${[...new Set(lessons.map((l) => l.module))].map((m, i) => `<a href="#module-${i}" data-module-link="${i}">${esc(m)}</a>`).join("")}</aside><div class="lesson-modules">${[
    ...new Set(lessons.map((l) => l.module)),
  ]
    .map(
      (m, mi) =>
        `<section id="module-${mi}" class="lesson-module"><div class="section-title"><h2>${esc(m)}</h2></div>${lessons
          .filter((l) => l.module === m)
          .map((l) => {
            const completed =
              state.progress[l.id] === true || state.progress[l.id]?.completed;
            return `<button class="lesson-card ${completed ? "complete" : ""}" data-lesson="${esc(l.id)}"><span class="lesson-number">${completed ? icon("check") : String(lessons.indexOf(l) + 1).padStart(2, "0")}</span><span class="lesson-copy"><strong>${esc(l.title)}</strong><span>${esc(l.summary)}</span><small>${l.duration} мин чтения <span>·</span> Практическое задание</small></span>${icon("arrow", 20)}</button>`;
          })
          .join("")}</section>`,
    )
    .join("")}</div></div>`;
}
function bindLessons() {
  $$("[data-lesson]").forEach(
    (b) => (b.onclick = () => openLesson(b.dataset.lesson)),
  );
  $$("[data-module-link]").forEach(
    (a) =>
      (a.onclick = (e) => {
        e.preventDefault();
        $(`#module-${a.dataset.moduleLink}`).scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "instant"
            : "smooth",
          block: "start",
        });
      }),
  );
}
function sourceList(sources) {
  return sources?.length
    ? `<div class="source-list"><h3>Источники и дальнейшее чтение</h3>${sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)} ${icon("arrow", 13)}</a>`).join("")}</div>`
    : "";
}
function openLesson(lid) {
  const lesson = lessons.find((l) => l.id === lid);
  const completed =
    state.progress[lid] === true || state.progress[lid]?.completed;
  const el = dialog(
    `${modalHead(esc(lesson.module), esc(lesson.title))}<div class="reader-meta">${lesson.duration} мин чтения · Сохранено для чтения офлайн</div><div class="prose">${renderMarkdown(lesson.body)}</div><div class="practice-task"><span class="eyebrow">ПОПРОБУЙТЕ САМИ</span><div class="prose">${renderMarkdown(lesson.practice)}</div>${button("Записать результат", "plus", "", "data-lesson-practice")}</div>${sourceList(lesson.sources)}<div class="modal-actions">${button(completed ? "Отметить непройденным" : "Урок пройден", "check", "primary", "data-complete")}</div>`,
    "reader-modal",
  );
  $("[data-complete]", el).onclick = async () => {
    state.progress[lid] = { completed: !completed, updatedAt: now() };
    await persist();
    el.close();
    render();
    toast(completed ? "Отметка снята" : "Прогресс сохранён");
  };
  $("[data-lesson-practice]", el).onclick = () => {
    el.close();
    openEditor(null, {
      type: "practice",
      title: `Практика: ${lesson.title}`,
      body: `## Задание\n\n${lesson.practice}\n\n## Мои наблюдения\n\n`,
    });
  };
}
function renderLibrary() {
  return `${heading("ЗНАНИЯ ПОД РУКОЙ", "Библиотека", "Понятия, методы и ответы — с опорой на источники.")}<label class="search-field library-search">${icon("search")}<input id="library-search" type="search" placeholder="Например: MILD, память сна или внутренний мир" aria-label="Поиск по библиотеке"></label><div class="library-categories"><button class="selected" data-category="">Все темы <span>${glossary.length}</span></button>${[...new Set(glossary.map((g) => g.category))].map((c) => `<button data-category="${esc(c)}">${esc(c)}</button>`).join("")}</div><div id="glossary-grid" class="glossary-grid">${glossaryCards(glossary)}</div>`;
}
function glossaryCards(items) {
  return (
    items
      .map(
        (g) =>
          `<button class="glossary-card" data-glossary="${esc(g.id)}"><span class="eyebrow">${esc(g.category)}</span><h3>${esc(g.term)}</h3><p>${esc(g.summary)}</p><span class="text-link">Читать справку ${icon("arrow", 15)}</span></button>`,
      )
      .join("") ||
    empty(
      "Такой темы пока нет",
      "Попробуйте более короткий запрос или другую категорию.",
    )
  );
}
function bindLibrary() {
  let category = "";
  const update = () => {
    const q = $("#library-search").value.toLowerCase();
    $("#glossary-grid").innerHTML = glossaryCards(
      glossary.filter(
        (g) =>
          (!category || g.category === category) &&
          `${g.term} ${g.summary} ${g.body}`.toLowerCase().includes(q),
      ),
    );
    bindCards();
  };
  const bindCards = () =>
    $$("[data-glossary]").forEach(
      (b) =>
        (b.onclick = () => {
          const g = glossary.find((g) => g.id === b.dataset.glossary);
          dialog(
            `${modalHead(esc(g.category), esc(g.term))}<div class="prose">${renderMarkdown(g.body)}</div>${sourceList(g.sources)}`,
            "reader-modal",
          );
        }),
    );
  $("#library-search").oninput = update;
  $$("[data-category]").forEach(
    (b) =>
      (b.onclick = () => {
        category = b.dataset.category;
        $$("[data-category]").forEach((x) =>
          x.classList.toggle("selected", x === b),
        );
        update();
      }),
  );
  bindCards();
}

function renderMap() {
  const graph = buildGraph(state);
  return `${heading("АТЛАС ВНУТРЕННЕГО МИРА", "У всего есть свои связи", "Места ваших снов складываются в мир. Персонажи прокладывают маршруты.", `<a class="btn" href="#tags">${icon("tag")} Настроить теги</a>`)}<div class="map-toolbar"><div class="map-legend"><span><i class="legend-dot"></i> Локации ${graph.nodes.length}</span><span>${icon("flame", 14)} Осознанные сны</span><span>${icon("character", 14)} Персонажи ${graph.characters.length}</span></div><div class="button-row"><button class="icon-btn" data-map-zoom="1.2" aria-label="Приблизить карту">+</button><button class="icon-btn" data-map-zoom="0.83333" aria-label="Отдалить карту">−</button><button class="btn compact" data-map-reset>Вся карта</button></div></div><div class="map-container"><canvas id="dream-map" tabindex="0" aria-label="Карта локаций. Tab — выбрать, Enter — открыть, стрелки — перемещение, плюс и минус — масштаб."></canvas><span class="map-engine">RUSTERIZE · АТЛАС MOB</span>${!graph.nodes.length ? `<div class="map-empty">${empty("Ваш мир начинается с места", "Создайте тег «Локация» и добавьте его к записи. Совместные упоминания станут связями.", button("Создать локацию", "plus", "primary", "data-create-location"))}</div>` : ""}<div class="map-help">Перетаскивайте локации · Колесо или ± для масштаба · Нажмите, чтобы открыть записи</div></div><div class="map-below"><section><h2>Места вашего мира</h2><div class="location-list">${graph.nodes.map((n) => `<button data-map-open="${esc(n.id)}" class="location-item"><span class="location-symbol">${tagSymbols.location}</span><span><strong>${esc(n.name)}</strong><small>${n.count} записей ${n.lucidCount ? `· ${n.lucidCount} ОС` : ""}</small></span>${icon("arrow", 16)}</button>`).join("") || '<p class="hint">Здесь появится доступный список всех локаций.</p>'}</div></section><aside class="map-explainer"><span class="eyebrow">КАК ЧИТАТЬ КАРТУ</span><p>Линия соединяет места, которые встретились в одной записи. Чем чаще — тем сильнее связь.</p><p>Огонёк отмечает записи с тегом «ОС». Больше осознанных снов — ярче свечение.</p></aside></div>`;
}
async function bindMap() {
  const graph = buildGraph(state);
  const open = (tid) => openLocation(tid);
  $$("[data-map-open]").forEach(
    (b) => (b.onclick = () => open(b.dataset.mapOpen)),
  );
  $("[data-create-location]")?.addEventListener("click", () => openTagEditor());
  try {
    const { createDreamMap } = await import("./rusterize.js");
    if (route !== "map") return;
    const canvas = $("#dream-map");
    const view = await createDreamMap(canvas, {
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, image: n.image?.src || n.image })),
      characters: graph.characters.map((n) => ({
        ...n,
        image: n.image?.src || n.image,
      })),
      onOpen: open,
      onMove: (tid, pos) => {
        const t = state.tags.find((t) => t.id === tid);
        if (t) {
          t.x = pos.x;
          t.y = pos.y;
          t.updatedAt = now();
          persist().catch(() => {});
        }
      },
    });
    if (route !== "map" || !canvas.isConnected || canvas !== $("#dream-map")) {
      view.destroy();
      return;
    }
    mapView = view;
    $$("[data-map-zoom]").forEach(
      (b) => (b.onclick = () => mapView?.zoom(Number(b.dataset.mapZoom))),
    );
    $("[data-map-reset]").onclick = () => mapView?.reset();
  } catch (e) {
    toast(
      `Карта не загрузилась: ${e.message}. Список локаций доступен ниже.`,
      true,
    );
  }
}
function openLocation(tid) {
  const tag = activeTags().find((t) => t.id === tid);
  if (!tag) return;
  const entries = activeEntries()
    .filter((e) => e.tagIds.includes(tid))
    .sort((a, b) => b.date.localeCompare(a.date));
  const el = dialog(
    `${modalHead(tagTypes[tag.type], esc(tag.name))}${tag.image ? `<img class="location-cover" src="${esc(tag.image.src || tag.image)}" alt="${esc(tag.name)}">` : ""}<p>${esc(tag.description || "У этого места ещё нет описания.")}</p><div class="section-title"><h3>Записи · ${entries.length}</h3><button class="text-link" data-location-edit>Настроить ${icon("edit", 16)}</button></div>${entries.map((e) => `<button class="location-entry" data-location-entry="${esc(e.id)}"><span>${dateLabel(e.date)}</span><strong>${esc(e.title)}</strong>${icon("arrow", 16)}</button>`).join("") || '<p class="hint">Добавьте этот тег к записи, чтобы она появилась здесь.</p>'}`,
  );
  $$("[data-location-entry]", el).forEach(
    (b) =>
      (b.onclick = () => {
        el.close();
        openEntry(b.dataset.locationEntry);
      }),
  );
  $("[data-location-edit]", el).onclick = () => {
    el.close();
    openTagEditor(tag);
  };
}

function renderStats() {
  const s = diaryStats(state),
    entries = activeEntries(),
    days = daysBack(84),
    max = Math.max(
      1,
      ...days.map((d) => entries.filter((e) => e.date === d).length),
    ),
    recent = daysBack(28);
  const weeks = Array.from({ length: 4 }, (_, i) =>
    recent.slice(i * 7, i * 7 + 7),
  );
  const topTags = activeTags()
    .map((t) => ({
      ...t,
      count: entries.filter((e) => e.tagIds.includes(t.id)).length,
    }))
    .filter((t) => t.count)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return `${heading("НАБЛЮДАЙТЕ ЗА ИЗМЕНЕНИЯМИ", "Ритм вашей практики", "Личные наблюдения, без гонки за идеальным результатом.")}<div class="stats-grid">${[
    [s.dreams, "записанных сновидений", "moon"],
    [s.lucid, "осознанных снов", "flame"],
    [s.days, "дней с записями", "sun"],
    [
      s.dreams ? `${Math.round((s.lucid / s.dreams) * 100)}%` : "—",
      "ОС среди записанных снов",
      "stats",
    ],
  ]
    .map(
      ([n, l, ic]) =>
        `<div class="stat-card">${icon(ic, 24)}<strong>${n}</strong><span>${l}</span></div>`,
    )
    .join(
      "",
    )}</div><section class="panel"><div class="section-title"><div><h2>Календарь наблюдений</h2><p>Последние 12 недель · нажмите на день, чтобы посмотреть записи</p></div><span class="eyebrow">${dateLabel(days[0])} — ${dateLabel(days.at(-1))}</span></div><div class="heatmap">${days
    .map((d) => {
      const count = entries.filter((e) => e.date === d).length;
      return `<button class="heatmap-day" data-day="${d}" style="--intensity:${count ? 0.25 + (count / max) * 0.75 : 0}" aria-label="${dateLabel(d)}: ${count} записей" title="${dateLabel(d)}: ${count} записей"><span>${Number(d.slice(-2))}</span></button>`;
    })
    .join(
      "",
    )}</div><div class="heatmap-legend"><span>Нет записей</span><i></i><i></i><i></i><i></i><span>Больше записей</span></div></section><div class="stats-columns"><section class="panel"><div class="section-title"><div><h2>Сны и дневные практики</h2><p>Количество записей за последние четыре недели</p></div></div><div class="bar-chart">${weeks
    .map((w) => {
      const dreams = entries.filter(
          (e) => w.includes(e.date) && e.type === "dream",
        ).length,
        practice = entries.filter(
          (e) => w.includes(e.date) && e.type === "practice",
        ).length,
        ceiling = Math.max(
          1,
          ...weeks.map((w) => entries.filter((e) => w.includes(e.date)).length),
        );
      return `<div class="bar-group"><div class="bar-area"><div class="chart-bar dream" style="height:${(dreams / ceiling) * 150}px"><span>${dreams}</span></div><div class="chart-bar practice" style="height:${(practice / ceiling) * 150}px"><span>${practice}</span></div></div><small>${dateLabel(w[0], { day: "numeric", month: "short" })}</small></div>`;
    })
    .join(
      "",
    )}</div><div class="chart-legend"><span><i class="dream"></i> Сны</span><span><i class="practice"></i> Практики</span></div></section><section class="panel"><div class="section-title"><div><h2>Повторяющиеся образы</h2><p>Теги, которые встречаются чаще других</p></div></div><div class="tag-ranking">${topTags.map((t) => `<button data-filter-tag="${esc(t.id)}"><span>${tagSymbols[t.type]} ${esc(t.name)}</span><strong>${t.count}</strong><i style="width:${(t.count / Math.max(1, topTags[0].count)) * 100}%"></i></button>`).join("") || '<p class="hint">Добавляйте теги — здесь появятся ваши повторяющиеся мотивы.</p>'}</div></section></div><p class="stats-note">Доля ОС рассчитывается только среди записей типа «Сновидение» с тегом «ОС». Дневник отражает то, что вы записали, а не все сны и не объективную оценку навыка.</p>`;
}
function bindStats() {
  $$("[data-day]").forEach(
    (b) =>
      (b.onclick = () => {
        const entries = activeEntries().filter((e) => e.date === b.dataset.day);
        const el = dialog(
          `${modalHead("ДНЕВНИК", dateLabel(b.dataset.day, { day: "numeric", month: "long", year: "numeric" }))}${entries.map((e) => `<button class="location-entry" data-day-entry="${esc(e.id)}">${icon(e.type === "dream" ? "moon" : "sun", 18)}<strong>${esc(e.title)}</strong>${icon("arrow", 16)}</button>`).join("") || "<p>В этот день нет записей.</p>"}${button("Добавить запись", "plus", "primary", "data-new-day")}`,
        );
        $$("[data-day-entry]", el).forEach(
          (x) =>
            (x.onclick = () => {
              el.close();
              openEntry(x.dataset.dayEntry);
            }),
        );
        $("[data-new-day]", el).onclick = () => {
          el.close();
          openEditor(null, {
            date: b.dataset.day,
            type: defaultEntryType(state.entries, b.dataset.day),
          });
        };
      }),
  );
}

function renderSettings() {
  return `${heading("ВАШИ ДАННЫЕ — ВАШИ ПРАВИЛА", "Настройки пространства", "Без аккаунта MOB, без сервера и без сбора ваших историй.")}<div class="settings-grid"><section class="panel"><div class="settings-icon">${icon("cloud", 26)}</div><h2>Google Диск</h2><p>Объединяйте записи, иллюстрации, карту и прогресс на своих устройствах. Подключение нужно только для синхронизации.</p><div class="connection-status"><span class="status-dot ${isDriveConnected() ? "" : "muted"}"></span>${isDriveConnected() ? "Google Диск подключён" : "Сейчас данные только на этом устройстве"}</div>${isNativeAndroid() ? '<p class="hint">Подключение откроет системный выбор аккаунта Google.</p>' : `<details class="oauth-details"><summary>Настроить подключение</summary><p>Для прямого доступа к Google Диску нужен OAuth Client ID вашего проекта Google Cloud. Он не является секретом. <a href="https://github.com/USBashka/MindOverBody/blob/main/docs/GOOGLE_DRIVE.md" target="_blank" rel="noopener">Инструкция по настройке</a></p><label>Google OAuth Client ID<input id="google-client-id" autocomplete="off" placeholder="…apps.googleusercontent.com" value="${esc(state.settings.googleClientId || "")}"></label>${button("Сохранить Client ID", null, "", "data-save-client")}</details>`}<div class="button-row">${button(isDriveConnected() ? "Синхронизировать" : "Подключить Google Диск", "cloud", "primary", `data-connect ${syncing ? "disabled" : ""}`)}${isDriveConnected() ? button("Отключить", null, "", "data-disconnect") : ""}</div><p class="hint">${state.settings.lastSync ? `Последняя синхронизация: ${new Date(state.settings.lastSync).toLocaleString("ru-RU")}` : "Синхронизация запускается вами. Google увидит только предоставленную ему копию."}</p></section><section class="panel"><div class="settings-icon">${icon("upload", 26)}</div><h2>Импорт и резервные копии</h2><p>Перенесите дневник из Somnio или восстановите резервную копию MOB. Импорт объединяет данные и пропускает дубликаты.</p><div class="settings-actions">${button("Импорт Somnio или MOB", "upload", "", 'data-action="import"')}${button("Скачать резервную копию JSON", "download", "", 'data-export="json"')}${button("Экспорт дневника в Markdown", "download", "", 'data-export="markdown"')}${button("Экспорт таблицы CSV", "download", "", 'data-export="csv"')}</div><p class="hint">JSON сохраняет всё, включая рисунки и карту. Храните копию в надёжном месте.</p></section><section class="panel"><div class="settings-icon">${icon("settings", 26)}</div><h2>Приложение на вашем устройстве</h2><p>${isNativeAndroid() ? "Вы используете Android APK. Приложение и уроки доступны без интернета." : "Установите MOB на домашний экран: дневник будет открываться как отдельное приложение и работать офлайн."}</p><div class="button-row">${!isNativeAndroid() ? button("Установить PWA", "download", "primary", "data-install") : ""}${button("Защитить локальное хранилище", null, "", "data-persist-storage")}</div><p id="storage-status" class="hint">Очистка данных браузера или удаление приложения может удалить записи. Регулярно делайте резервные копии.</p><p class="hint">На Android: меню Chrome → «Установить приложение». APK доступен в <a href="https://github.com/USBashka/MindOverBody/releases" target="_blank" rel="noopener">релизах GitHub</a>.</p></section><section class="panel"><div class="settings-icon">${icon("tag", 26)}</div><h2>Сохранённые версии</h2><p>Если одна запись менялась на разных устройствах, её альтернативные версии сохраняются здесь. Выбранная версия заменит текущую, а текущая сохранится в архиве.</p><div class="conflict-list">${
    (state.conflicts || [])
      .slice(-20)
      .reverse()
      .map(
        (c) =>
          `<div><span>${esc(c.record.title || c.record.name || "Сохранённая версия")}<small>${c.record.deletedAt ? "Удалённая версия · " : ""}${new Date(c.record.updatedAt).toLocaleString("ru")}</small></span><button class="text-link" data-restore="${esc(c.id)}">${c.record.deletedAt ? "Вернуть удаление" : "Восстановить"}</button></div>`,
      )
      .join("") || '<p class="hint">Альтернативных версий пока нет.</p>'
  }</div></section></div><div class="about-footer"><img src="./mob.svg" alt="MOB" width="70"><div><strong>Mind Over Body</strong><p>Личный дневник. Внутренний мир. Пространство для исследования.</p><a href="https://github.com/USBashka/MindOverBody" target="_blank" rel="noopener">Исходный код</a> · <a href="https://github.com/USBashka/Rusterize" target="_blank" rel="noopener">Rusterize</a> · <a href="https://github.com/USBashka/MindOverBody/blob/main/docs/PRIVACY.md" target="_blank" rel="noopener">Приватность</a></div></div>`;
}
function download(name, text, mime = "application/json") {
  if (window.MOBAndroid?.exportFile) {
    window.MOBAndroid.exportFile(name, mime, text);
    toast("Выберите место для сохранения");
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function bindSettings() {
  $("[data-save-client]")?.addEventListener("click", async () => {
    state.settings.googleClientId = $("#google-client-id").value.trim();
    await persist();
    toast("Client ID сохранён на этом устройстве");
  });
  $("[data-connect]").onclick = async () => {
    if (demo) return toast("Синхронизация недоступна в примере");
    if (syncing) return;
    syncing = true;
    const b = $("[data-connect]");
    b.disabled = true;
    try {
      if (!isDriveConnected())
        await connectDrive(
          $("#google-client-id")?.value.trim() ||
            state.settings.googleClientId ||
            "",
        );
      const result = await syncDrive(state);
      state = mergeStates(state, result.state);
      state.settings.lastSync = result.syncedAt;
      await persist();
      toast("Данные объединены с Google Диском");
    } catch (e) {
      toast(e.message, true);
    } finally {
      syncing = false;
      render();
    }
  };
  $("[data-disconnect]")?.addEventListener("click", () => {
    disconnectDrive();
    render();
    toast("Google Диск отключён. Локальные записи сохранены.");
  });
  $$("[data-export]").forEach(
    (b) =>
      (b.onclick = () => {
        const stamp = localDate();
        if (b.dataset.export === "json")
          download(`mob-backup-${stamp}.json`, exportBackup(state));
        else if (b.dataset.export === "markdown") {
          const markdown = activeEntries()
            .sort((a, b) => b.date.localeCompare(a.date))
            .map(
              (e) =>
                `# ${e.title}\n\n${e.date} · ${e.type === "dream" ? "Сновидение" : "Практика"}\n\n${e.body}\n\n${e.tagIds
                  .map((tid) => activeTags().find((t) => t.id === tid))
                  .filter(Boolean)
                  .map((t) => `@${t.name}`)
                  .join(
                    " ",
                  )}\n\n${e.images.map((i) => `![${i.caption.replace(/[\[\]]/g, "")}](${i.src})`).join("\n\n")}`,
            )
            .join("\n\n---\n\n");
          download(`mob-diary-${stamp}.md`, markdown, "text/markdown");
        } else {
          const cell = (v) =>
            `"${String(v)
              .replace(/^[=+@\-\t\r]/, "'$&")
              .replaceAll('"', '""')}"`;
          download(
            `mob-diary-${stamp}.csv`,
            "\ufeff" +
              [
                ["Дата", "Тип", "Название", "Текст", "Теги"],
                ...activeEntries().map((e) => [
                  e.date,
                  e.type,
                  e.title,
                  e.body,
                  e.tagIds
                    .map(
                      (tid) =>
                        activeTags().find((t) => t.id === tid)?.name || "",
                    )
                    .filter(Boolean)
                    .join("; "),
                ]),
              ]
                .map((row) => row.map(cell).join(","))
                .join("\r\n"),
            "text/csv",
          );
        }
      }),
  );
  $("[data-install]")?.addEventListener("click", async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      installPrompt = null;
    } else
      dialog(
        `${modalHead("УСТАНОВКА", "MOB на домашнем экране")}<p>В Chrome на Android откройте меню ⋮ и выберите <strong>«Установить приложение»</strong> или «Добавить на главный экран».</p><p>На компьютере используйте значок установки в адресной строке Chrome или Edge. На iPhone: «Поделиться» → «На экран Домой».</p><p class="hint">После первого открытия приложение и курс доступны без интернета.</p>`,
      );
  });
  $("[data-persist-storage]").onclick = async () => {
    const granted = await requestPersistentStorage();
    $("#storage-status").textContent = granted
      ? "Браузер разрешил постоянное хранение. Резервные копии всё равно полезны."
      : "Браузер не предоставил постоянное хранилище. Установка PWA и регулярные копии помогут сохранить записи.";
  };
  $$("[data-restore]").forEach(
    (b) =>
      (b.onclick = async () => {
        state = restoreConflict(state, b.dataset.restore);
        await persist();
        render();
        toast("Версия восстановлена");
      }),
  );
}
async function importFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024)
      return toast("Файл слишком большой: максимум 100 МБ", true);
    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      let preview, label;
      if (raw?.version === 1 && Array.isArray(raw.entries)) {
        const incoming = validateBackup(raw);
        preview = mergeStates(state, incoming);
        label = `Резервная копия MOB: ${alive(incoming.entries).length} записей и ${alive(incoming.tags).length} тегов.`;
      } else {
        const result = parseSomnio(raw, state);
        preview = result.state;
        label = `Somnio: ${result.imported} новых записей, ${result.skipped} пропущено.${result.warnings.length ? ` Замечаний: ${result.warnings.length}. ${result.warnings.slice(0, 3).join(" ")}` : ""}`;
      }
      if (
        await confirmAction(
          "Импорт дневника",
          `${label} Текущие данные будут объединены с импортом. Продолжить?`,
          "Импортировать",
        )
      ) {
        state = mergeStates(state, preview);
        await persist();
        render();
        toast("Импорт завершён");
      }
    } catch (e) {
      toast(`Не удалось импортировать: ${e.message}`, true);
    }
  };
  input.click();
}

$(".skip-link").onclick = (e) => {
  e.preventDefault();
  $("#main")?.focus();
};
window.addEventListener("hashchange", () => {
  render();
  window.scrollTo(0, 0);
});
window.addEventListener("beforeunload", (e) => {
  if (editorDirty || savePending || saveFailed) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.mobPersistence) e.preventDefault();
});
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
});
window.addEventListener("online", () => {
  const el = $(".offline-status");
  if (el)
    el.innerHTML = '<span class="status-dot"></span>Сохранение на устройстве';
});
window.addEventListener("offline", () => {
  const el = $(".offline-status");
  if (el)
    el.innerHTML = '<span class="status-dot"></span>Офлайн · всё доступно';
});
async function boot() {
  try {
    state = await loadState();
    render();
    if ("serviceWorker" in navigator && !isNativeAndroid()) {
      const registration = await navigator.serviceWorker.register(
        new URL("../sw.js", import.meta.url),
      );
      if (registration.waiting)
        toast(
          "Обновление готово. Закройте окна MOB и откройте приложение снова.",
        );
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", (e) => {
          if (
            e.target.state === "installed" &&
            navigator.serviceWorker.controller
          )
            toast("Обновление установится после закрытия всех окон MOB.");
        });
      });
    }
  } catch (e) {
    if (!state) {
      $("#app").innerHTML =
        `<div class="boot"><h1>Не удалось открыть хранилище</h1><p>${esc(e.message)}</p><p>Разрешите хранение данных в браузере и перезагрузите приложение.</p><button class="btn primary" id="retry-boot">Попробовать снова</button></div>`;
      $("#retry-boot").onclick = () => location.reload();
    } else console.warn("Offline registration:", e.message);
  }
}
boot();
