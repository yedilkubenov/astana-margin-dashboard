const SHEET_ID = "1vpfKyGL95e_c1aK919Qkj_lMxlC9fjHwayWy85CGowg";
const YEAR_GIDS = { 2025: "1624628020", 2026: "246109221" };

const MONTH_ORDER = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];

const RUB = (n) => Math.round(n).toLocaleString("ru-RU") + " ₸";
const PCT = (n, d = 1) => (isFinite(n) ? n.toFixed(d).replace(".", ",") + "%" : "—");

function toNumber(raw) {
  if (!raw) return 0;
  const s = String(raw).replace(/[\s ]/g, "").replace("%", "").replace(",", ".");
  const v = parseFloat(s);
  return isFinite(v) ? v : 0;
}

function csvUrlForGid(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}&t=${Date.now()}`;
}

async function fetchCsv(gid) {
  const res = await fetch(csvUrlForGid(gid), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} (gid ${gid})`);
  return res.text();
}

function parseCsv(text) {
  const parsed = Papa.parse(text, { skipEmptyLines: false });
  return parsed.data;
}

// Detect month blocks by scanning header row 1 for "Категория" markers,
// and pulling the nearest non-empty label above it (row 0) as the month name.
function detectBlocks(rows) {
  const row0 = rows[0] || [];
  const row1 = rows[1] || [];
  const blocks = [];
  let lastLabel = "";
  for (let c = 0; c < row1.length; c++) {
    if (row0[c] && row0[c].trim()) lastLabel = row0[c].trim();
    if ((row1[c] || "").trim().toLowerCase() === "категория") {
      blocks.push({ month: lastLabel.toLowerCase(), col: c });
    }
  }
  blocks.sort((a, b) => MONTH_ORDER.indexOf(a.month) - MONTH_ORDER.indexOf(b.month));
  return blocks;
}

function buildRecords(rows, blocks, year) {
  const records = [];
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    for (const block of blocks) {
      const c = block.col;
      const category = (row[c] || "").trim();
      const factory = (row[c + 1] || "").trim();
      const sku = (row[c + 2] || "").trim();
      if (!sku) continue;
      const qty = toNumber(row[c + 3]);
      const revenue = toNumber(row[c + 4]);
      const cost = toNumber(row[c + 5]);
      const marginTg = toNumber(row[c + 6]);
      if (revenue === 0 && qty === 0) continue;
      records.push({
        year,
        month: block.month,
        monthIdx: MONTH_ORDER.indexOf(block.month),
        category, factory, sku, qty, revenue, cost, marginTg,
        marginPct: revenue !== 0 ? (marginTg / revenue) * 100 : 0,
      });
    }
  }
  return records;
}

function activeMonths(records) {
  const set = new Set(records.map((r) => r.monthIdx));
  return [...set].sort((a, b) => a - b);
}

// Composite key that sorts correctly across a year boundary (e.g. Dec 2025 < Jan 2026).
function periodKeyOf(r) { return r.year * 12 + r.monthIdx; }
function keyToLabel(key) {
  const month = ((key % 12) + 12) % 12;
  const year = Math.round((key - month) / 12);
  return `${cap(MONTH_ORDER[month])} ${year}`;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function aggregate(records, keyFn) {
  const map = new Map();
  for (const r of records) {
    const key = keyFn(r);
    if (!map.has(key)) map.set(key, { qty: 0, revenue: 0, cost: 0, marginTg: 0 });
    const a = map.get(key);
    a.qty += r.qty; a.revenue += r.revenue; a.cost += r.cost; a.marginTg += r.marginTg;
  }
  for (const a of map.values()) a.marginPct = a.revenue !== 0 ? (a.marginTg / a.revenue) * 100 : 0;
  return map;
}

function groupBy(records, keyFn) {
  const map = new Map();
  for (const r of records) {
    const key = keyFn(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

function monthlyOverall(records, keys) {
  const byKey = aggregate(records, periodKeyOf);
  return keys.map((k) => ({ key: k, label: keyToLabel(k), ...(byKey.get(k) || { qty: 0, revenue: 0, cost: 0, marginTg: 0, marginPct: 0 }) }));
}

function periodTotals(monthly) {
  const revenue = monthly.reduce((s, m) => s + m.revenue, 0);
  const cost = monthly.reduce((s, m) => s + m.cost, 0);
  const marginTg = monthly.reduce((s, m) => s + m.marginTg, 0);
  const marginPct = revenue !== 0 ? (marginTg / revenue) * 100 : 0;
  return { revenue, cost, marginTg, marginPct };
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function periodLabelText(sel) {
  const fromLabel = keyToLabel(sel.fromKey);
  const toLabel = keyToLabel(sel.toKey);
  return sel.fromKey === sel.toKey ? fromLabel : `${fromLabel} – ${toLabel}`;
}

// ---------- single-period decline table (no comparison) ----------
function declineTable(records, dimension, keys) {
  const keyFn = dimension === "sku" ? (r) => r.sku : (r) => r[dimension];
  const grouped = groupBy(records, keyFn);
  const totalRevenue = records.reduce((s, r) => s + r.revenue, 0);
  const minShare = dimension === "sku" ? 0.001 : 0.003; // 0.1% / 0.3% materiality floor
  const rows = [];
  for (const [entKey, recs] of grouped) {
    const byMonth = aggregate(recs, periodKeyOf);
    const monthKeys = [...byMonth.keys()].sort((a, b) => a - b);
    const periodRevenue = recs.reduce((s, r) => s + r.revenue, 0);
    if (totalRevenue > 0 && periodRevenue / totalRevenue < minShare) continue;
    const periodMarginTg = recs.reduce((s, r) => s + r.marginTg, 0);
    const periodMarginPct = periodRevenue !== 0 ? (periodMarginTg / periodRevenue) * 100 : 0;
    let delta = null;
    if (monthKeys.length >= 2) {
      const first = byMonth.get(monthKeys[0]);
      const last = byMonth.get(monthKeys[monthKeys.length - 1]);
      delta = last.marginPct - first.marginPct;
    }
    const monthlyMarginPct = keys.map((k) => (byMonth.has(k) ? byMonth.get(k).marginPct : null));
    rows.push({
      key: entKey,
      category: recs[0].category,
      factory: recs[0].factory,
      periodRevenue,
      share: totalRevenue ? (periodRevenue / totalRevenue) * 100 : 0,
      periodMarginPct,
      monthlyMarginPct,
      delta,
    });
  }
  rows.sort((a, b) => {
    if (a.delta !== null && b.delta !== null) return a.delta - b.delta;
    if (a.delta !== null) return -1;
    if (b.delta !== null) return 1;
    return a.periodMarginPct - b.periodMarginPct;
  });
  return rows;
}

// ---------- period A vs period B decline/comparison table ----------
function declineTableCompare(recordsA, recordsB, dimension) {
  const keyFn = dimension === "sku" ? (r) => r.sku : (r) => r[dimension];
  const groupA = groupBy(recordsA, keyFn);
  const groupB = groupBy(recordsB, keyFn);
  const totalA = recordsA.reduce((s, r) => s + r.revenue, 0);
  const totalB = recordsB.reduce((s, r) => s + r.revenue, 0);
  const totalCombined = totalA + totalB;
  const minShare = dimension === "sku" ? 0.001 : 0.003;
  const keys = new Set([...groupA.keys(), ...groupB.keys()]);
  const rows = [];
  for (const key of keys) {
    const recsA = groupA.get(key) || [];
    const recsB = groupB.get(key) || [];
    const revA = recsA.reduce((s, r) => s + r.revenue, 0);
    const revB = recsB.reduce((s, r) => s + r.revenue, 0);
    if (totalCombined > 0 && (revA + revB) / totalCombined < minShare) continue;
    const mgA = recsA.reduce((s, r) => s + r.marginTg, 0);
    const mgB = recsB.reduce((s, r) => s + r.marginTg, 0);
    const marginPctA = revA !== 0 ? (mgA / revA) * 100 : null;
    const marginPctB = revB !== 0 ? (mgB / revB) * 100 : null;
    const delta = marginPctA !== null && marginPctB !== null ? marginPctA - marginPctB : null;
    const sample = recsA[0] || recsB[0];
    rows.push({
      key,
      category: sample.category,
      factory: sample.factory,
      revA,
      shareA: totalA ? (revA / totalA) * 100 : 0,
      marginPctA,
      marginPctB,
      delta,
    });
  }
  rows.sort((a, b) => {
    if (a.delta !== null && b.delta !== null) return a.delta - b.delta;
    if (a.delta !== null) return -1;
    if (b.delta !== null) return 1;
    return b.revA - a.revA;
  });
  return rows;
}

function abcAnalysis(records) {
  const bySku = aggregate(records, (r) => r.sku);
  const meta = new Map();
  for (const r of records) if (!meta.has(r.sku)) meta.set(r.sku, { category: r.category, factory: r.factory });
  const total = [...bySku.values()].reduce((s, a) => s + a.revenue, 0);
  const sorted = [...bySku.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
  let cum = 0;
  const result = new Map();
  for (const [sku, a] of sorted) {
    cum += a.revenue;
    const cumPct = total ? (cum / total) * 100 : 0;
    const abc = cumPct <= 80 ? "A" : cumPct <= 95 ? "B" : "C";
    result.set(sku, { ...a, ...meta.get(sku), share: total ? (a.revenue / total) * 100 : 0, cumPct, abc });
  }
  return result;
}

function xyzAnalysis(records, keys) {
  const bySku = new Map();
  for (const r of records) {
    if (!bySku.has(r.sku)) bySku.set(r.sku, new Map());
    const m = bySku.get(r.sku);
    const k = periodKeyOf(r);
    m.set(k, (m.get(k) || 0) + r.qty);
  }
  const result = new Map();
  const canCompute = keys.length >= 2;
  for (const [sku, monthMap] of bySku) {
    if (!canCompute) {
      result.set(sku, { cv: NaN, xyz: null, activeCount: monthMap.size });
      continue;
    }
    const series = keys.map((k) => monthMap.get(k) || 0);
    const mean = series.reduce((s, v) => s + v, 0) / series.length;
    const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / series.length;
    const cv = mean ? (Math.sqrt(variance) / mean) * 100 : Infinity;
    const activeCount = series.filter((v) => v > 0).length;
    let xyz;
    if (activeCount < 3) xyz = "Z";
    else if (cv <= 10) xyz = "X";
    else if (cv <= 25) xyz = "Y";
    else xyz = "Z";
    result.set(sku, { cv, xyz, activeCount });
  }
  return result;
}

const CELL_HINTS = {
  AX: "Стабильные хиты продаж — держать в постоянном наличии, не допускать дефицита.",
  AY: "Важный вклад в выручку при колебаниях спроса — увеличить страховой запас и точнее планировать закупки.",
  AZ: "Высокая выручка, но нерегулярный спрос — закупать под подтверждённый спрос/предзаказ, не накапливать излишки.",
  BX: "Стабильный средний вклад — держать текущий уровень запасов без изменений.",
  BY: "Средний вклад при среднем колебании — пересмотреть периодичность заказов.",
  BZ: "Средний вклад, нерегулярный спрос — сократить страховой запас, закупать точечно.",
  CX: "Низкий вклад, но стабильный спрос — закупать редко и крупными партиями.",
  CY: "Низкий вклад, среднее колебание — сократить ассортимент до ключевых позиций.",
  CZ: "Низкий вклад и нерегулярный спрос — кандидаты на вывод из ассортимента или распродажу остатков.",
};

let STATE = { rows: [], sortKey: "revenue", sortDir: -1, page: 1, pageSize: 50, search: "", classFilter: "" };
let RAW = { perYear: {}, years: [], allRecords: [], timeline: [] };

async function main() {
  try {
    const yearEntries = Object.entries(YEAR_GIDS);
    const fetched = await Promise.all(yearEntries.map(async ([year, gid]) => {
      const text = await fetchCsv(gid);
      const rows = parseCsv(text);
      const blocks = detectBlocks(rows);
      if (blocks.length === 0) return null;
      const records = buildRecords(rows, blocks, Number(year));
      const months = activeMonths(records);
      if (months.length === 0) return null;
      return [Number(year), { records, months }];
    }));

    const perYear = {};
    for (const entry of fetched) if (entry) perYear[entry[0]] = entry[1];
    const years = Object.keys(perYear).map(Number).sort((a, b) => a - b);
    if (years.length === 0) throw new Error("В таблице пока нет данных о продажах ни за один год.");

    const allRecords = years.flatMap((y) => perYear[y].records);
    const keySet = new Set();
    for (const y of years) for (const m of perYear[y].months) keySet.add(y * 12 + m);
    const timeline = [...keySet].sort((a, b) => a - b).map((key) => ({ key, label: keyToLabel(key) }));
    RAW = { perYear, years, allRecords, timeline };

    document.getElementById("loadingState").hidden = true;
    const coverage = years.map((y) => {
      const m = perYear[y].months;
      return `${y}: ${cap(MONTH_ORDER[m[0]])}–${cap(MONTH_ORDER[m[m.length - 1]])}`;
    }).join(" · ");
    document.getElementById("periodLabel").textContent = `Данные в таблице: ${coverage}`;
    document.getElementById("periodSection").hidden = false;

    setupPeriodControls();
    applyPeriod();
    document.getElementById("updatedAt").textContent = "Обновлено: " + new Date().toLocaleString("ru-RU");
  } catch (e) {
    document.getElementById("loadingState").hidden = true;
    const err = document.getElementById("errorState");
    err.hidden = false;
    err.textContent = "Не удалось загрузить данные: " + e.message;
    console.error(e);
  }
}

function setupPeriodControls() {
  const fromA = document.getElementById("fromA");
  const toA = document.getElementById("toA");
  const fromB = document.getElementById("fromB");
  const toB = document.getElementById("toB");
  const compareToggle = document.getElementById("compareToggle");
  const periodBRow = document.getElementById("periodBRow");

  const opts = RAW.timeline.map((t) => `<option value="${t.key}">${t.label}</option>`).join("");
  fromA.innerHTML = opts; toA.innerHTML = opts;
  fromB.innerHTML = opts; toB.innerHTML = opts;

  const minKey = RAW.timeline[0].key;
  const maxKey = RAW.timeline[RAW.timeline.length - 1].key;

  // Default Period A to the latest available year's full range.
  const latestYear = RAW.years[RAW.years.length - 1];
  const latestYearMonths = RAW.perYear[latestYear].months;
  const defaultFromA = latestYear * 12 + latestYearMonths[0];
  const defaultToA = latestYear * 12 + latestYearMonths[latestYearMonths.length - 1];
  fromA.value = defaultFromA;
  toA.value = defaultToA;

  // Default Period B to the same month range, previous year (clamped to available data).
  const defaultFromB = clamp(defaultFromA - 12, minKey, maxKey);
  const defaultToB = clamp(defaultToA - 12, minKey, maxKey);
  fromB.value = Math.min(defaultFromB, defaultToB);
  toB.value = Math.max(defaultFromB, defaultToB);

  fromA.onchange = () => {
    if (Number(fromA.value) > Number(toA.value)) toA.value = fromA.value;
    applyPeriod();
  };
  toA.onchange = () => {
    if (Number(toA.value) < Number(fromA.value)) fromA.value = toA.value;
    applyPeriod();
  };
  fromB.onchange = () => {
    if (Number(fromB.value) > Number(toB.value)) toB.value = fromB.value;
    applyPeriod();
  };
  toB.onchange = () => {
    if (Number(toB.value) < Number(fromB.value)) fromB.value = toB.value;
    applyPeriod();
  };
  compareToggle.onchange = () => {
    periodBRow.hidden = !compareToggle.checked;
    applyPeriod();
  };
}

function readSelector(suffix) {
  const fromKey = Number(document.getElementById("from" + suffix).value);
  const toKey = Number(document.getElementById("to" + suffix).value);
  const keys = RAW.timeline.filter((t) => t.key >= fromKey && t.key <= toKey).map((t) => t.key);
  const records = RAW.allRecords.filter((r) => { const k = periodKeyOf(r); return k >= fromKey && k <= toKey; });
  return { fromKey, toKey, keys, records };
}

function applyPeriod() {
  const A = readSelector("A");
  document.getElementById("periodInfoA").textContent =
    A.keys.length <= 1 ? "выбран 1 месяц" : `выбрано месяцев: ${A.keys.length}`;

  const compareEnabled = document.getElementById("compareToggle").checked;
  let B = null;
  if (compareEnabled) {
    B = readSelector("B");
    document.getElementById("periodInfoB").textContent =
      B.keys.length <= 1 ? "выбран 1 месяц" : `выбрано месяцев: ${B.keys.length}`;
  }

  render(A, B);
}

function render(A, B) {
  const monthlyA = monthlyOverall(A.records, A.keys);
  const monthlyB = B ? monthlyOverall(B.records, B.keys) : null;
  const labelA = periodLabelText(A);
  const labelB = B ? periodLabelText(B) : null;

  renderKpis(monthlyA, monthlyB, labelA, labelB);
  renderTrendCharts(monthlyA, monthlyB, labelA, labelB);
  document.getElementById("trendPeriodLabel").textContent = B
    ? `Период A: ${labelA} · Период B: ${labelB}`
    : `Период: ${labelA}`;

  const dims = ["category", "factory", "sku"];
  if (!B) {
    const declineData = {};
    for (const d of dims) declineData[d] = declineTable(A.records, d, A.keys);
    renderDeclineSection(declineData, { type: "single", keys: A.keys });
    document.getElementById("declineHint").textContent =
      `Период: ${labelA}. Доля выручки и маржа считаются по выбранному периоду. «Итого» — за весь выбранный период целиком, дальше — помесячно (месяц указан с годом). Показаны только позиции с заметной долей в выручке периода.`;
  } else {
    const declineData = {};
    for (const d of dims) declineData[d] = declineTableCompare(A.records, B.records, d);
    renderDeclineSection(declineData, { type: "compare", labelA, labelB });
    document.getElementById("declineHint").textContent =
      `Сравнение маржи между Периодом A (${labelA}) и Периодом B (${labelB}). Доля выручки — в рамках Периода A. Показаны только позиции с заметной долей в объединённой выручке обоих периодов.`;
  }

  const abc = abcAnalysis(A.records);
  const xyz = xyzAnalysis(A.records, A.keys);
  const hasXyz = A.keys.length >= 2;
  const combined = [...abc.entries()].map(([sku, a]) => {
    const x = xyz.get(sku) || { cv: NaN, xyz: null, activeCount: 0 };
    return { sku, ...a, cv: x.cv, xyz: x.xyz, activeCount: x.activeCount, cls: a.abc + (x.xyz || "") };
  });
  renderAbcXyz(combined, hasXyz);
  document.getElementById("abcxyzPeriodLabel").textContent = `Период: ${labelA}`;

  document.getElementById("kpiSection").hidden = false;
  document.getElementById("trendSection").hidden = false;
  document.getElementById("declineSection").hidden = false;
  document.getElementById("abcxyzSection").hidden = false;
}

function renderKpis(monthlyA, monthlyB, labelA, labelB) {
  const el = document.getElementById("kpiSection");

  if (!monthlyB) {
    const last = monthlyA[monthlyA.length - 1];
    const prev = monthlyA.length > 1 ? monthlyA[monthlyA.length - 2] : null;
    const cards = [
      { label: `Выручка, ${last.label}`, value: RUB(last.revenue), delta: prev ? pctDelta(last.revenue, prev.revenue) : null },
      { label: `Себестоимость, ${last.label}`, value: RUB(last.cost), delta: prev ? pctDelta(last.cost, prev.cost) : null, inverse: true },
      { label: `Маржа, ${last.label}`, value: RUB(last.marginTg), delta: prev ? pctDelta(last.marginTg, prev.marginTg) : null },
      { label: `Маржа %, ${last.label}`, value: PCT(last.marginPct), delta: prev ? { pp: last.marginPct - prev.marginPct } : null },
    ];
    el.innerHTML = cards.map(renderKpiCard).join("");
    return;
  }

  const totalsA = periodTotals(monthlyA);
  const totalsB = periodTotals(monthlyB);
  const cards = [
    { label: `Выручка, A (${labelA})`, value: RUB(totalsA.revenue), delta: pctDelta(totalsA.revenue, totalsB.revenue), sub: `B (${labelB}): ${RUB(totalsB.revenue)}` },
    { label: `Себестоимость, A (${labelA})`, value: RUB(totalsA.cost), delta: pctDelta(totalsA.cost, totalsB.cost), inverse: true, sub: `B (${labelB}): ${RUB(totalsB.cost)}` },
    { label: `Маржа, A (${labelA})`, value: RUB(totalsA.marginTg), delta: pctDelta(totalsA.marginTg, totalsB.marginTg), sub: `B (${labelB}): ${RUB(totalsB.marginTg)}` },
    { label: `Маржа %, A (${labelA})`, value: PCT(totalsA.marginPct), delta: { pp: totalsA.marginPct - totalsB.marginPct }, sub: `B (${labelB}): ${PCT(totalsB.marginPct)}` },
  ];
  el.innerHTML = cards.map(renderKpiCard).join("");
}

function renderKpiCard(c) {
  let deltaHtml = "";
  if (c.delta !== null && c.delta !== undefined) {
    if (typeof c.delta === "object") {
      const up = c.delta.pp >= 0;
      deltaHtml = `<div class="kpi-delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${c.delta.pp >= 0 ? "+" : ""}${c.delta.pp.toFixed(1).replace(".", ",")} п.п.</div>`;
    } else {
      const goodDir = c.inverse ? c.delta < 0 : c.delta >= 0;
      deltaHtml = `<div class="kpi-delta ${goodDir ? "up" : "down"}">${c.delta >= 0 ? "▲" : "▼"} ${PCT(Math.abs(c.delta))}</div>`;
    }
  }
  const subHtml = c.sub ? `<div class="muted" style="font-size:12px;margin-top:4px;">${c.sub}</div>` : "";
  return `<div class="kpi-card"><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div>${deltaHtml}${subHtml}</div>`;
}

function pctDelta(a, b) { return b !== 0 ? ((a - b) / Math.abs(b)) * 100 : 0; }

let charts = {};
function renderTrendCharts(monthlyA, monthlyB, labelA, labelB) {
  if (charts.revCost) charts.revCost.destroy();
  if (charts.marginPct) charts.marginPct.destroy();

  const maxLen = monthlyB ? Math.max(monthlyA.length, monthlyB.length) : monthlyA.length;
  const labels = Array.from({ length: maxLen }, (_, i) => {
    if (!monthlyB) return monthlyA[i] ? monthlyA[i].label : "";
    const la = monthlyA[i] ? monthlyA[i].label : null;
    const lb = monthlyB[i] ? monthlyB[i].label : null;
    if (la && lb) return `${la} / ${lb}`;
    return la || lb || `#${i + 1}`;
  });

  const revDatasets = !monthlyB
    ? [
        { label: "Выручка", data: monthlyA.map((m) => m.revenue), backgroundColor: "#4da3ff" },
        { label: "Себестоимость", data: monthlyA.map((m) => m.cost), backgroundColor: "#f5b84d" },
        { label: "Маржа, тг", data: monthlyA.map((m) => m.marginTg), backgroundColor: "#3ecf8e" },
      ]
    : [
        { label: `Выручка (A: ${labelA})`, data: pad(monthlyA.map((m) => m.revenue), maxLen), backgroundColor: "#4da3ff" },
        { label: `Выручка (B: ${labelB})`, data: pad(monthlyB.map((m) => m.revenue), maxLen), backgroundColor: "#1c5c94" },
        { label: `Маржа, тг (A: ${labelA})`, data: pad(monthlyA.map((m) => m.marginTg), maxLen), backgroundColor: "#3ecf8e" },
        { label: `Маржа, тг (B: ${labelB})`, data: pad(monthlyB.map((m) => m.marginTg), maxLen), backgroundColor: "#1f7a52" },
      ];

  charts.revCost = new Chart(document.getElementById("revCostChart"), {
    type: "bar",
    data: { labels, datasets: revDatasets },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: "#e7edf2" } } },
      scales: { x: { ticks: { color: "#8a97a3" } }, y: { ticks: { color: "#8a97a3" } } } },
  });

  const crosshairPlugin = {
    id: "marginCrosshair",
    afterEvent(chart, args) {
      const e = args.event;
      if (e.type === "mousemove") {
        chart.$crosshairY = e.y;
        chart.draw();
      } else if (e.type === "mouseout") {
        chart.$crosshairY = null;
        chart.draw();
      }
    },
    afterDraw(chart) {
      const y = chart.$crosshairY;
      if (y == null) return;
      const { ctx, chartArea, scales } = chart;
      if (y < chartArea.top || y > chartArea.bottom) return;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.strokeStyle = "rgba(231,237,242,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
      const value = scales.y.getValueForPixel(y);
      ctx.setLineDash([]);
      ctx.fillStyle = "#e7edf2";
      ctx.font = "11px -apple-system, sans-serif";
      ctx.fillText(PCT(value), chartArea.left + 6, y - 4);
      ctx.restore();
    },
  };

  const marginPctDatasets = !monthlyB
    ? [{ label: "Маржа, %", data: monthlyA.map((m) => m.marginPct), borderColor: "#4da3ff", backgroundColor: "rgba(77,163,255,0.15)", fill: true, tension: 0.3 }]
    : [
        { label: `Маржа, % (A: ${labelA})`, data: pad(monthlyA.map((m) => m.marginPct), maxLen), borderColor: "#4da3ff", backgroundColor: "rgba(77,163,255,0.1)", fill: true, tension: 0.3 },
        { label: `Маржа, % (B: ${labelB})`, data: pad(monthlyB.map((m) => m.marginPct), maxLen), borderColor: "#f5b84d", backgroundColor: "rgba(245,184,77,0.1)", fill: true, tension: 0.3 },
      ];

  charts.marginPct = new Chart(document.getElementById("marginPctChart"), {
    type: "line",
    data: { labels, datasets: marginPctDatasets },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: "#e7edf2" } } },
      scales: { x: { ticks: { color: "#8a97a3" } }, y: { ticks: { color: "#8a97a3" } } } },
    plugins: [crosshairPlugin],
  });
}

function pad(arr, len) { return Array.from({ length: len }, (_, i) => (i < arr.length ? arr[i] : null)); }

let currentDim = "category";
function renderDeclineSection(dataByDim, mode) {
  function draw() {
    if (mode.type === "single") drawDeclineTable(dataByDim[currentDim], currentDim, mode.keys);
    else drawDeclineTableCompare(dataByDim[currentDim], currentDim, mode.labelA, mode.labelB);
  }
  document.querySelectorAll("#declineTabs .tab").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll("#declineTabs .tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentDim = btn.dataset.dim;
      draw();
    };
  });
  draw();
}

function drawDeclineTable(rows, dim, keys) {
  const label = dim === "sku" ? "Номенклатура" : dim === "category" ? "Категория" : "Фабрика";
  const table = document.getElementById("declineTable");
  const monthTh = keys.map((k) => `<th>${keyToLabel(k)}</th>`).join("");
  const showDelta = keys.length > 1;
  const colCount = 3 + keys.length + (showDelta ? 1 : 0);
  table.querySelector("thead").innerHTML = `<tr>
    <th>${label}</th><th>Доля выручки</th><th>Маржа %, итого</th>${monthTh}${showDelta ? "<th>Δ п.п.</th>" : ""}
  </tr>`;
  const top = rows.slice(0, 30);
  table.querySelector("tbody").innerHTML = top.map((r) => {
    const monthTds = r.monthlyMarginPct.map((v) => `<td class="num">${v == null ? "—" : PCT(v)}</td>`).join("");
    const deltaTd = showDelta
      ? `<td class="num delta ${r.delta == null ? "" : r.delta < 0 ? "down" : "up"}">${r.delta == null ? "—" : (r.delta >= 0 ? "+" : "") + r.delta.toFixed(1).replace(".", ",")}</td>`
      : "";
    return `
    <tr>
      <td>${escapeHtml(r.key)}${dim === "sku" ? `<br><span class="muted">${escapeHtml(r.category)} / ${escapeHtml(r.factory)}</span>` : ""}</td>
      <td class="num">${PCT(r.share)}</td>
      <td class="num">${PCT(r.periodMarginPct)}</td>
      ${monthTds}
      ${deltaTd}
    </tr>`;
  }).join("") || `<tr><td colspan="${colCount}" class="muted">Нет данных, удовлетворяющих порогу значимости.</td></tr>`;
}

function drawDeclineTableCompare(rows, dim, labelA, labelB) {
  const label = dim === "sku" ? "Номенклатура" : dim === "category" ? "Категория" : "Фабрика";
  const table = document.getElementById("declineTable");
  table.querySelector("thead").innerHTML = `<tr>
    <th>${label}</th><th>Доля выручки, A</th><th>Маржа %, A (${labelA})</th><th>Маржа %, B (${labelB})</th><th>Δ п.п. (A−B)</th>
  </tr>`;
  const top = rows.slice(0, 30);
  table.querySelector("tbody").innerHTML = top.map((r) => `
    <tr>
      <td>${escapeHtml(r.key)}${dim === "sku" ? `<br><span class="muted">${escapeHtml(r.category)} / ${escapeHtml(r.factory)}</span>` : ""}</td>
      <td class="num">${PCT(r.shareA)}</td>
      <td class="num">${r.marginPctA == null ? "—" : PCT(r.marginPctA)}</td>
      <td class="num">${r.marginPctB == null ? "—" : PCT(r.marginPctB)}</td>
      <td class="num delta ${r.delta == null ? "" : r.delta < 0 ? "down" : "up"}">${r.delta == null ? "—" : (r.delta >= 0 ? "+" : "") + r.delta.toFixed(1).replace(".", ",")}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">Нет данных, удовлетворяющих порогу значимости.</td></tr>`;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function renderAbcXyz(rows, hasXyz) {
  STATE.rows = rows;
  const classFilter = document.getElementById("classFilter");
  const classOptions = hasXyz ? ["AX","AY","AZ","BX","BY","BZ","CX","CY","CZ"] : ["A","B","C"];
  classFilter.innerHTML = `<option value="">Все классы</option>` + classOptions.map((c) => `<option value="${c}">${c}</option>`).join("");
  classFilter.onchange = () => { STATE.classFilter = classFilter.value; STATE.page = 1; drawAbcTable(); };
  document.getElementById("skuSearch").oninput = (e) => { STATE.search = e.target.value.toLowerCase(); STATE.page = 1; drawAbcTable(); };
  document.querySelectorAll("#abcxyzTable th").forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.key;
      if (STATE.sortKey === key) STATE.sortDir *= -1; else { STATE.sortKey = key; STATE.sortDir = -1; }
      drawAbcTable();
    };
  });

  const matrixTotal = rows.reduce((s, r) => s + r.revenue, 0);
  const matrix = document.getElementById("matrixGrid");
  if (!hasXyz) {
    matrix.innerHTML = `<div class="matrix-cell" style="grid-column: 1 / -1;">
      <div class="cls-hint">Для XYZ-анализа выберите период не короче 2 месяцев. Сейчас показан только ABC (по вкладу в выручку выбранного периода).</div>
    </div>` + ["A","B","C"].map((cls) => {
      const cellRows = rows.filter((r) => r.cls === cls);
      const revShare = matrixTotal ? (cellRows.reduce((s, r) => s + r.revenue, 0) / matrixTotal) * 100 : 0;
      return `<div class="matrix-cell">
        <div class="cls-name">${cls}</div>
        <div class="cls-count">${cellRows.length} SKU</div>
        <div class="cls-share">${PCT(revShare)} выручки</div>
      </div>`;
    }).join("");
  } else {
    const order = ["AX","AY","AZ","BX","BY","BZ","CX","CY","CZ"];
    matrix.innerHTML = order.map((cls) => {
      const cellRows = rows.filter((r) => r.cls === cls);
      const revShare = matrixTotal ? (cellRows.reduce((s, r) => s + r.revenue, 0) / matrixTotal) * 100 : 0;
      return `<div class="matrix-cell">
        <div class="cls-name">${cls}</div>
        <div class="cls-count">${cellRows.length} SKU</div>
        <div class="cls-share">${PCT(revShare)} выручки</div>
        <div class="cls-hint">${CELL_HINTS[cls]}</div>
      </div>`;
    }).join("");
  }

  drawAbcTable();
}

function drawAbcTable() {
  let rows = STATE.rows;
  if (STATE.classFilter) rows = rows.filter((r) => r.cls === STATE.classFilter);
  if (STATE.search) {
    const q = STATE.search;
    rows = rows.filter((r) => r.sku.toLowerCase().includes(q) || (r.category || "").toLowerCase().includes(q) || (r.factory || "").toLowerCase().includes(q));
  }
  const revShareKey = { revShare: "share" }[STATE.sortKey] || STATE.sortKey;
  rows = [...rows].sort((a, b) => {
    const va = a[revShareKey], vb = b[revShareKey];
    if (typeof va === "string") return STATE.sortDir * va.localeCompare(vb);
    return STATE.sortDir * ((va ?? 0) - (vb ?? 0));
  });

  const totalPages = Math.max(1, Math.ceil(rows.length / STATE.pageSize));
  STATE.page = Math.min(STATE.page, totalPages);
  const pageRows = rows.slice((STATE.page - 1) * STATE.pageSize, STATE.page * STATE.pageSize);

  document.querySelector("#abcxyzTable tbody").innerHTML = pageRows.map((r) => `
    <tr>
      <td>${escapeHtml(r.sku)}</td>
      <td>${escapeHtml(r.category || "")}</td>
      <td>${escapeHtml(r.factory || "")}</td>
      <td class="num">${RUB(r.revenue)}</td>
      <td class="num">${PCT(r.share, 2)}</td>
      <td class="num">${PCT(r.marginPct)}</td>
      <td class="num">${isFinite(r.cv) ? PCT(r.cv, 0) : "—"}</td>
      <td><span class="badge ${r.abc}">${r.abc}</span></td>
      <td>${r.xyz || "—"}</td>
      <td>${r.cls}</td>
    </tr>`).join("") || `<tr><td colspan="10" class="muted">Ничего не найдено.</td></tr>`;

  const pag = document.getElementById("pagination");
  const pages = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - STATE.page) <= 2) pages.push(p);
    else if (pages[pages.length - 1] !== "…") pages.push("…");
  }
  pag.innerHTML = pages.map((p) => p === "…" ? `<span class="muted">…</span>` : `<button class="${p === STATE.page ? "active" : ""}" data-p="${p}">${p}</button>`).join("");
  pag.querySelectorAll("button").forEach((b) => b.onclick = () => { STATE.page = parseInt(b.dataset.p, 10); drawAbcTable(); });
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  document.getElementById("loadingState").hidden = false;
  document.getElementById("errorState").hidden = true;
  main();
});

main();
