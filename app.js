const SHEET_ID = "1vpfKyGL95e_c1aK919Qkj_lMxlC9fjHwayWy85CGowg";
const GID = "246109221";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}&t=${Date.now()}`;

const MONTH_ORDER = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];

const RUB = (n) => Math.round(n).toLocaleString("ru-RU") + " ₸";
const PCT = (n, d = 1) => (isFinite(n) ? n.toFixed(d).replace(".", ",") + "%" : "—");

function toNumber(raw) {
  if (!raw) return 0;
  const s = String(raw).replace(/ /g, "").replace(/ /g, "").replace("%", "").replace(",", ".");
  const v = parseFloat(s);
  return isFinite(v) ? v : 0;
}

async function fetchCsv() {
  const res = await fetch(CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

function buildRecords(rows, blocks) {
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

function monthlyOverall(records, months) {
  const byMonth = aggregate(records, (r) => r.monthIdx);
  return months.map((m) => ({ monthIdx: m, label: cap(MONTH_ORDER[m]), ...(byMonth.get(m) || { qty: 0, revenue: 0, cost: 0, marginTg: 0, marginPct: 0 }) }));
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function signedPct(n, d = 1) { return (n >= 0 ? "+" : "") + PCT(n, d); }

function classifyDriver(first, last) {
  const priceF = first.qty ? first.revenue / first.qty : 0;
  const priceL = last.qty ? last.revenue / last.qty : 0;
  const costF = first.qty ? first.cost / first.qty : 0;
  const costL = last.qty ? last.cost / last.qty : 0;
  const priceChg = priceF ? ((priceL - priceF) / priceF) * 100 : 0;
  const costChg = costF ? ((costL - costF) / costF) * 100 : 0;
  const gap = costChg - priceChg;
  if (gap > 5 && costChg > 0) return `рост себестоимости (${signedPct(costChg)}) обгоняет цену (${signedPct(priceChg)})`;
  if (gap > 5 && costChg <= 0) return `цена снижается быстрее себестоимости (цена ${signedPct(priceChg)}, себестоимость ${signedPct(costChg)}) — скидки съедают маржу`;
  if (priceChg < -3 && gap <= 5) return `снижение цены реализации (${signedPct(priceChg)}), скидки/акции`;
  if (Math.abs(priceChg) < 3 && Math.abs(costChg) < 3) return "изменение структуры продаж (микс), цена и себестоимость почти не менялись";
  return `смешанный эффект: цена ${signedPct(priceChg)}, себестоимость ${signedPct(costChg)}`;
}

function declineTable(records, dimension, months) {
  const keyFn = dimension === "sku"
    ? (r) => r.sku
    : (r) => r[dimension];
  const grouped = new Map();
  for (const r of records) {
    const key = keyFn(r);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }
  const totalRevenue = records.reduce((s, r) => s + r.revenue, 0);
  const minShare = dimension === "sku" ? 0.001 : 0.003; // 0.1% / 0.3% materiality floor
  const rows = [];
  for (const [key, recs] of grouped) {
    const byMonth = aggregate(recs, (r) => r.monthIdx);
    const monthKeys = [...byMonth.keys()].sort((a, b) => a - b);
    if (monthKeys.length < 2) continue;
    const first = byMonth.get(monthKeys[0]);
    const last = byMonth.get(monthKeys[monthKeys.length - 1]);
    const periodRevenue = recs.reduce((s, r) => s + r.revenue, 0);
    if (totalRevenue > 0 && periodRevenue / totalRevenue < minShare) continue;
    const delta = last.marginPct - first.marginPct;
    rows.push({
      key,
      category: recs[0].category,
      factory: recs[0].factory,
      periodRevenue,
      share: totalRevenue ? (periodRevenue / totalRevenue) * 100 : 0,
      firstMonth: cap(MONTH_ORDER[monthKeys[0]]),
      lastMonth: cap(MONTH_ORDER[monthKeys[monthKeys.length - 1]]),
      firstMarginPct: first.marginPct,
      lastMarginPct: last.marginPct,
      delta,
      driver: classifyDriver(first, last),
    });
  }
  rows.sort((a, b) => a.delta - b.delta);
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

function xyzAnalysis(records, months) {
  const bySku = new Map();
  for (const r of records) {
    if (!bySku.has(r.sku)) bySku.set(r.sku, new Map());
    const m = bySku.get(r.sku);
    m.set(r.monthIdx, (m.get(r.monthIdx) || 0) + r.qty);
  }
  const result = new Map();
  for (const [sku, monthMap] of bySku) {
    const series = months.map((m) => monthMap.get(m) || 0);
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

async function main() {
  try {
    const text = await fetchCsv();
    const rows = parseCsv(text);
    const blocks = detectBlocks(rows);
    if (blocks.length === 0) throw new Error("Не удалось найти месячные блоки в таблице — проверьте структуру листа.");
    const records = buildRecords(rows, blocks);
    const months = activeMonths(records);
    if (months.length === 0) throw new Error("В таблице пока нет данных о продажах ни за один месяц.");
    render(records, months, blocks);
    document.getElementById("updatedAt").textContent = "Обновлено: " + new Date().toLocaleString("ru-RU");
  } catch (e) {
    document.getElementById("loadingState").hidden = true;
    const err = document.getElementById("errorState");
    err.hidden = false;
    err.textContent = "Не удалось загрузить данные: " + e.message;
    console.error(e);
  }
}

function render(records, months, blocks) {
  document.getElementById("loadingState").hidden = true;
  const startLabel = cap(MONTH_ORDER[months[0]]);
  const endLabel = cap(MONTH_ORDER[months[months.length - 1]]);
  document.getElementById("periodLabel").textContent =
    `Период: ${startLabel} – ${endLabel} 2026 · ${blocks.length} мес. в таблице, ${months.length} с данными`;

  const monthly = monthlyOverall(records, months);
  renderKpis(monthly);
  renderTrendCharts(monthly);

  const declineData = {
    category: declineTable(records, "category", months),
    factory: declineTable(records, "factory", months),
    sku: declineTable(records, "sku", months),
  };
  renderDeclineSection(declineData);

  const abc = abcAnalysis(records);
  const xyz = xyzAnalysis(records, months);
  const combined = [...abc.entries()].map(([sku, a]) => {
    const x = xyz.get(sku) || { cv: Infinity, xyz: "Z", activeCount: 0 };
    return { sku, ...a, cv: x.cv, xyz: x.xyz, activeCount: x.activeCount, cls: a.abc + x.xyz };
  });
  renderAbcXyz(combined);
  renderInsights(monthly, declineData, combined);

  document.getElementById("kpiSection").hidden = false;
  document.getElementById("trendSection").hidden = false;
  document.getElementById("declineSection").hidden = false;
  document.getElementById("insightsSection").hidden = false;
  document.getElementById("abcxyzSection").hidden = false;
}

function renderKpis(monthly) {
  const last = monthly[monthly.length - 1];
  const prev = monthly.length > 1 ? monthly[monthly.length - 2] : null;
  const cards = [
    { label: `Выручка, ${last.label}`, value: RUB(last.revenue), delta: prev ? pctDelta(last.revenue, prev.revenue) : null },
    { label: `Себестоимость, ${last.label}`, value: RUB(last.cost), delta: prev ? pctDelta(last.cost, prev.cost) : null, inverse: true },
    { label: `Маржа, ${last.label}`, value: RUB(last.marginTg), delta: prev ? pctDelta(last.marginTg, prev.marginTg) : null },
    { label: `Маржа %, ${last.label}`, value: PCT(last.marginPct), delta: prev ? { pp: last.marginPct - prev.marginPct } : null },
  ];
  const el = document.getElementById("kpiSection");
  el.innerHTML = cards.map((c) => {
    let deltaHtml = "";
    if (c.delta !== null && c.delta !== undefined) {
      if (typeof c.delta === "object") {
        const up = c.delta.pp >= 0;
        deltaHtml = `<div class="kpi-delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${c.delta.pp >= 0 ? "+" : ""}${c.delta.pp.toFixed(1).replace(".", ",")} п.п. к пред. мес.</div>`;
      } else {
        const goodDir = c.inverse ? c.delta < 0 : c.delta >= 0;
        deltaHtml = `<div class="kpi-delta ${goodDir ? "up" : "down"}">${c.delta >= 0 ? "▲" : "▼"} ${PCT(Math.abs(c.delta))} к пред. мес.</div>`;
      }
    }
    return `<div class="kpi-card"><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div>${deltaHtml}</div>`;
  }).join("");
}

function pctDelta(a, b) { return b !== 0 ? ((a - b) / Math.abs(b)) * 100 : 0; }

let charts = {};
function renderTrendCharts(monthly) {
  const labels = monthly.map((m) => m.label);
  if (charts.revCost) charts.revCost.destroy();
  if (charts.marginPct) charts.marginPct.destroy();

  charts.revCost = new Chart(document.getElementById("revCostChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Выручка", data: monthly.map((m) => m.revenue), backgroundColor: "#4da3ff" },
        { label: "Себестоимость", data: monthly.map((m) => m.cost), backgroundColor: "#f5b84d" },
        { label: "Маржа, тг", data: monthly.map((m) => m.marginTg), type: "line", borderColor: "#3ecf8e", backgroundColor: "#3ecf8e", tension: 0.3 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: "#e7edf2" } } },
      scales: { x: { ticks: { color: "#8a97a3" } }, y: { ticks: { color: "#8a97a3" } } } },
  });

  charts.marginPct = new Chart(document.getElementById("marginPctChart"), {
    type: "line",
    data: { labels, datasets: [{ label: "Маржа, %", data: monthly.map((m) => m.marginPct), borderColor: "#4da3ff", backgroundColor: "rgba(77,163,255,0.15)", fill: true, tension: 0.3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: "#e7edf2" } } },
      scales: { x: { ticks: { color: "#8a97a3" } }, y: { ticks: { color: "#8a97a3" } } } },
  });
}

let currentDim = "category";
function renderDeclineSection(data) {
  document.querySelectorAll("#declineTabs .tab").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll("#declineTabs .tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentDim = btn.dataset.dim;
      drawDeclineTable(data[currentDim], currentDim);
    };
  });
  drawDeclineTable(data[currentDim], currentDim);
}

function drawDeclineTable(rows, dim) {
  const label = dim === "sku" ? "Номенклатура" : dim === "category" ? "Категория" : "Фабрика";
  const table = document.getElementById("declineTable");
  table.querySelector("thead").innerHTML = `<tr>
    <th>${label}</th><th>Доля выручки</th><th>Маржа% (начало)</th><th>Маржа% (конец)</th><th>Δ п.п.</th><th>Вероятная причина</th>
  </tr>`;
  const top = rows.slice(0, 30);
  table.querySelector("tbody").innerHTML = top.map((r) => `
    <tr>
      <td>${escapeHtml(r.key)}${dim === "sku" ? `<br><span class="muted">${escapeHtml(r.category)} / ${escapeHtml(r.factory)}</span>` : ""}</td>
      <td class="num">${PCT(r.share)}</td>
      <td class="num">${PCT(r.firstMarginPct)} (${r.firstMonth})</td>
      <td class="num">${PCT(r.lastMarginPct)} (${r.lastMonth})</td>
      <td class="num delta ${r.delta < 0 ? "down" : "up"}">${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(1).replace(".", ",")}</td>
      <td>${r.driver}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="muted">Нет данных, удовлетворяющих порогу значимости.</td></tr>`;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function renderAbcXyz(rows) {
  STATE.rows = rows;
  const classFilter = document.getElementById("classFilter");
  classFilter.innerHTML = `<option value="">Все классы</option>` + ["AX","AY","AZ","BX","BY","BZ","CX","CY","CZ"].map((c) => `<option value="${c}">${c}</option>`).join("");
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
      <td>${r.xyz}</td>
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

function renderInsights(monthly, declineData, combined) {
  const items = [];
  const first = monthly[0], last = monthly[monthly.length - 1];
  if (monthly.length > 1) {
    const trend = last.marginPct - first.marginPct;
    items.push(`Маржинальность по всей выручке ${trend < 0 ? "снизилась" : "выросла"} с ${PCT(first.marginPct)} в ${first.label.toLowerCase()} до ${PCT(last.marginPct)} в ${last.label.toLowerCase()} (${trend >= 0 ? "+" : ""}${trend.toFixed(1).replace(".", ",")} п.п.).`);
  }

  const topCatDeclines = declineData.category.filter((r) => r.delta < -1).slice(0, 3);
  for (const r of topCatDeclines) {
    items.push(`По категории «${r.key}» (${PCT(r.share)} выручки периода) маржа упала с ${PCT(r.firstMarginPct)} до ${PCT(r.lastMarginPct)} — ${r.driver}. Нужно пересмотреть закупочную цену и розничную наценку по этой категории.`);
  }
  const topFactDeclines = declineData.factory.filter((r) => r.delta < -1).slice(0, 2);
  for (const r of topFactDeclines) {
    items.push(`По фабрике «${r.key}» (${PCT(r.share)} выручки периода) маржа упала с ${PCT(r.firstMarginPct)} до ${PCT(r.lastMarginPct)} — ${r.driver}. Нужно пересогласовать закупочные условия с поставщиком или искать альтернативную фабрику по этой позиции.`);
  }
  const topSkuDeclines = declineData.sku.filter((r) => r.delta < -5).slice(0, 3);
  for (const r of topSkuDeclines) {
    items.push(`Позиция «${r.key}» потеряла ${Math.abs(r.delta).toFixed(1).replace(".", ",")} п.п. маржи (${r.driver}) — нужно скорректировать цену продажи или заменить поставщика по этой номенклатуре.`);
  }

  const sparse = combined.filter((r) => r.activeCount <= 2).length;
  if (combined.length > 0 && sparse / combined.length > 0.5) {
    items.push(`${sparse} из ${combined.length} номенклатур (${PCT((sparse / combined.length) * 100, 0)}) продавались всего 1-2 месяца из ${monthly.length} — это нормально при постоянном обновлении партий/принтов, но по этой причине почти весь ассортимент попадает в класс Z. Для решений по страховому запасу ориентируйтесь на разрез по категориям и фабрикам выше, а не на отдельные номенклатуры.`);
  }

  const cz = combined.filter((r) => r.cls === "CZ");
  const az = combined.filter((r) => r.cls === "AZ");
  const ax = combined.filter((r) => r.cls === "AX" || r.cls === "AY");
  if (cz.length > 0) {
    items.push(`${cz.length} позиций попали в класс CZ (низкий вклад в выручку, нерегулярный спрос) — нужно вывести их из постоянного ассортимента и распродать остатки.`);
  }
  if (az.length > 0) {
    items.push(`${az.length} позиций в классе AZ дают заметную выручку, но спрос нерегулярный — нужно закупать их под подтверждённые заказы, а не держать на складе постоянно.`);
  }
  if (ax.length > 0) {
    items.push(`Держите запас в первую очередь под ${ax.length} позиций класса AX/AY — они формируют основную выручку при предсказуемом спросе.`);
  }

  document.getElementById("insightsList").innerHTML = items.map((i) => `<li>${i}</li>`).join("");
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  document.getElementById("loadingState").hidden = false;
  document.getElementById("errorState").hidden = true;
  main();
});

main();
