export const tagTypes = {
  modifier: "Модификатор",
  location: "Локация",
  character: "Персонаж",
  theme: "Тема",
  reference: "Референс",
  result: "Результат",
};
export const tagSymbols = {
  modifier: "✦",
  location: "⌖",
  character: "♧",
  theme: "#",
  reference: "↗",
  result: "◇",
};
export const alive = (records) => records.filter((r) => !r.deletedAt);
export const isLucid = (entry, tags) =>
  entry.tagIds.some((id) =>
    tags.some(
      (t) =>
        t.id === id &&
        !t.deletedAt &&
        ["ос", "lucid", "осознанный сон"].includes(t.name.trim().toLowerCase()),
    ),
  );
export function defaultEntryType(entries, date) {
  return alive(entries).some((e) => e.date === date) ? "practice" : "dream";
}
export function buildGraph(state) {
  const entries = alive(state.entries),
    tags = alive(state.tags),
    locations = tags.filter((t) => t.type === "location");
  const locationIndex = new Map(locations.map((t, i) => [t.id, i]));
  const characterTags = tags.filter((t) => t.type === "character");
  const characterLocations = new Map(
    characterTags.map((t) => [t.id, new Set()]),
  );
  const lucidIds = new Set(
    tags
      .filter((t) =>
        ["ос", "lucid", "осознанный сон"].includes(t.name.trim().toLowerCase()),
      )
      .map((t) => t.id),
  );
  const counts = new Map(),
    lucidCounts = new Map(),
    pairs = new Map();
  for (const entry of entries) {
    const ids = [...new Set(entry.tagIds)],
      places = ids
        .filter((id) => locationIndex.has(id))
        .sort((a, b) => locationIndex.get(a) - locationIndex.get(b));
    const lucid = ids.some((id) => lucidIds.has(id));
    for (const id of places) {
      counts.set(id, (counts.get(id) || 0) + 1);
      if (lucid) lucidCounts.set(id, (lucidCounts.get(id) || 0) + 1);
    }
    for (let i = 0; i < places.length; i++)
      for (let j = i + 1; j < places.length; j++) {
        const key = JSON.stringify([places[i], places[j]]);
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    for (const id of ids)
      if (characterLocations.has(id))
        for (const place of places) characterLocations.get(id).add(place);
  }
  const nodes = locations.map((t, i) => {
    const angle = i * 2.39996,
      radius = Math.min(270, 105 + 30 * Math.sqrt(i));
    return {
      ...t,
      x: t.x ?? 500 + Math.cos(angle) * radius,
      y: t.y ?? 350 + Math.sin(angle) * radius,
      count: counts.get(t.id) || 0,
      lucidCount: lucidCounts.get(t.id) || 0,
    };
  });
  const edges = [...pairs]
    .map(([key, count]) => {
      const [source, target] = JSON.parse(key);
      return { source, target, count };
    })
    .sort(
      (a, b) =>
        locationIndex.get(a.source) - locationIndex.get(b.source) ||
        locationIndex.get(a.target) - locationIndex.get(b.target),
    );
  const characters = characterTags
    .map((t) => ({
      ...t,
      locations: [...characterLocations.get(t.id)].sort(
        (a, b) => locationIndex.get(a) - locationIndex.get(b),
      ),
    }))
    .filter((t) => t.locations.length);
  return { nodes, edges, characters };
}
export function diaryStats(state) {
  const entries = alive(state.entries),
    dreams = entries.filter((e) => e.type === "dream");
  return {
    total: entries.length,
    dreams: dreams.length,
    practice: entries.length - dreams.length,
    lucid: dreams.filter((e) => isLucid(e, state.tags)).length,
    days: new Set(entries.map((e) => e.date)).size,
    locations: alive(state.tags).filter((t) => t.type === "location").length,
  };
}
export function dateLabel(date, options = { day: "numeric", month: "long" }) {
  return new Intl.DateTimeFormat("ru-RU", options).format(
    new Date(`${date}T12:00:00`),
  );
}
export function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function daysBack(count, end = new Date()) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(end);
    d.setDate(d.getDate() - count + 1 + i);
    return dayKey(d);
  });
}
export function demoState() {
  const now = new Date().toISOString(),
    date = dayKey(new Date()),
    y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = dayKey(y);
  const z = new Date();
  z.setDate(z.getDate() - 2);
  const tags = [
    ["forest", "Тихий лес", "location", 300, 300],
    ["station", "Станция у моря", "location", 690, 240],
    ["house", "Дом с маяком", "location", 560, 520],
    ["guide", "Проводник", "character"],
    ["lucid", "ОС", "result"],
    ["flight", "Полёт", "theme"],
  ].map(([id, name, type, x, y]) => ({
    id: `demo-${id}`,
    name,
    type,
    description: "Вымышленный пример. Замените собственным описанием.",
    image: null,
    x,
    y,
    createdAt: now,
    updatedAt: now,
  }));
  const entries = [
    {
      title: "Станция, которой нет на карте",
      body: "Я вышел из поезда на маленькой станции. За перроном начиналось море, а вместо часов над входом медленно вращалась луна.\n\nЯ посмотрел на неё второй раз и понял: **это сон**. Никуда не спеша, я пошёл к берегу. Проводник показал тропинку к лесу.\n\n> Что помогло осознаться: необычные часы и повторная проверка.\n\nВ следующий раз хочу рассмотреть вывеску станции.",
      date,
      type: "dream",
      tagIds: ["demo-station", "demo-forest", "demo-guide", "demo-lucid"],
    },
    {
      title: "Пять минут внимания",
      body: "Сел у окна и наблюдал за дыханием. Несколько раз отвлёкся на планы и спокойно вернулся к ощущениям.\n\n- Получилось замечать момент отвлечения.\n- После практики легче сосредоточиться.\n- Завтра попробую без таймера.",
      date,
      type: "practice",
      tagIds: [],
    },
    {
      title: "Дом на краю тихого леса",
      body: "Тропа привела к небольшому дому с маяком на крыше. В окнах горел тёплый свет. Я помню запах хвои и длинные тени от деревьев.\n\nВ конце я взлетел над лесом. Это было естественно, и я не догадался, что сплю.",
      date: yesterday,
      type: "dream",
      tagIds: ["demo-house", "demo-forest", "demo-flight"],
    },
    {
      title: "Разговор с проводником",
      body: "На станции меня встретил проводник в зелёном пальто. Он спросил, куда я хочу попасть, и протянул пустую карту. Ответа я не помню.",
      date: dayKey(z),
      type: "dream",
      tagIds: ["demo-station", "demo-guide"],
    },
  ].map((e, i) => ({
    ...e,
    id: `demo-entry-${i}`,
    images: [],
    createdAt: now,
    updatedAt: now,
  }));
  return {
    version: 1,
    entries,
    tags,
    progress: {},
    settings: {},
    conflicts: [],
  };
}
