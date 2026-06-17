// ============================================================
// 漏检趋势追溯系统 — 前端逻辑
// ============================================================

let defects = [];
let projects = [];
let editingDate = null;
let trendChart = null;
let editingDefectId = null;
let editingProjectId = null;

function currentProjectId() {
  const val = document.getElementById("projectSelect").value;
  return val ? parseInt(val) : null;
}

// ---------------- 工具函数 ----------------

function fmtPct(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return "--";
  return v.toFixed(digits) + "%";
}

function adjustColor(color, amount) {
  const hex = color.replace("#", "");
  const r = Math.max(0, Math.min(255, parseInt(hex.substr(0, 2), 16) + amount));
  const g = Math.max(0, Math.min(255, parseInt(hex.substr(2, 2), 16) + amount));
  const b = Math.max(0, Math.min(255, parseInt(hex.substr(4, 2), 16) + amount));
  return "#" + r.toString(16).padStart(2, "0") + g.toString(16).padStart(2, "0") + b.toString(16).padStart(2, "0");
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function showToast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || ("请求失败 " + res.status));
  }
  return res.json();
}

function getDefectCodes() {
  return defects.map(d => d.code);
}

function getDefectLabels() {
  return defects.reduce((acc, d) => { acc[d.code] = d.name; return acc; }, {});
}

function getDefectColors() {
  return defects.reduce((acc, d) => { acc[d.code] = d.color; return acc; }, {});
}

// ---------------- Tabs ----------------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "chart") loadChart();
    if (btn.dataset.tab === "manage") loadDefects();
  });
});

// ---------------- KPI ----------------

async function loadKpis() {
  const pid = currentProjectId();
  if (!pid) {
    document.getElementById("kpiToday").textContent = "--";
    document.getElementById("kpiMonth").textContent = "--";
    document.getElementById("kpiYear").textContent = "--";
    return;
  }
  try {
    const data = await api(`/api/stats/overview?project_id=${pid}`);
    document.getElementById("kpiToday").textContent = fmtPct(data.today.leak_rate);
    document.getElementById("kpiMonth").textContent = fmtPct(data.month.leak_rate);
    document.getElementById("kpiYear").textContent = fmtPct(data.year.leak_rate);
  } catch (e) {
  }
}

// ---------------- 不良类型加载与表单生成 ----------------

async function loadDefects() {
  try {
    defects = await api("/api/defects");
    renderDefectGrid();
    loadDefectsTable();
  } catch (e) {
    showToast(e.message, true);
  }
}

function renderDefectGrid() {
  const grid = document.getElementById("defectGrid");
  grid.innerHTML = "";
  defects.forEach((d, idx) => {
    const label = document.createElement("label");
    label.className = "field defect-field";
    label.innerHTML = `
      <span>${d.name}</span>
      <input type="number" min="0" placeholder="0" id="f_${d.code}" data-defect="${d.code}">
    `;
    label.querySelector("span").style.setProperty("--dot", d.color);
    grid.appendChild(label);
  });
}

// ---------------- 数据录入表单 ----------------

const form = document.getElementById("recordForm");
const dateInput = document.getElementById("f_date");
const inputQtyInput = document.getElementById("f_input_qty");
const hintEl = document.getElementById("formHint");

dateInput.value = todayISO();

dateInput.addEventListener("change", async () => {
  await tryLoadExisting(dateInput.value);
  dateInput.blur();
});

function clearForm(keepDate = true) {
  const d = dateInput.value;
  form.reset();
  if (keepDate) dateInput.value = d || todayISO();
  editingDate = null;
  document.getElementById("formTitle").textContent = "录入当日数据";
  document.getElementById("submitBtn").textContent = "保存";
  hintEl.textContent = "";
}

async function tryLoadExisting(dateStr) {
  const pid = currentProjectId();
  if (!pid || !dateStr) return;
  const rec = await api(`/api/records/${dateStr}?project_id=${pid}`).catch(() => null);
  if (rec) {
    editingDate = dateStr;
    inputQtyInput.value = rec.input_qty;
    defects.forEach((d) => {
      const val = rec.defect_data && rec.defect_data[d.code] !== undefined ? rec.defect_data[d.code] : "";
      document.getElementById("f_" + d.code).value = val;
    });
    document.getElementById("formTitle").textContent = `编辑 ${dateStr} 的记录`;
    document.getElementById("submitBtn").textContent = "更新";
  } else {
    editingDate = null;
    defects.forEach((d) => (document.getElementById("f_" + d.code).value = ""));
    inputQtyInput.value = "";
    document.getElementById("formTitle").textContent = "录入当日数据";
    document.getElementById("submitBtn").textContent = "保存";
  }
  hintEl.textContent = "";
}

function checkDefectSum() {
  const inputQty = Number(inputQtyInput.value || 0);
  const total = defects.reduce((s, d) => s + Number(document.getElementById("f_" + d.code).value || 0), 0);
  if (inputQty > 0 && total > inputQty) {
    hintEl.textContent = `提示：不良总数（${total}）超过投入数（${inputQty}），请检查输入是否正确`;
  } else {
    hintEl.textContent = "";
  }
}

inputQtyInput.addEventListener("input", checkDefectSum);
function bindDefectInputListeners() {
  defects.forEach((d) => {
    const el = document.getElementById("f_" + d.code);
    if (el) el.addEventListener("input", checkDefectSum);
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pid = currentProjectId();
  if (!pid) {
    showToast("请先添加并选择一个专案", true);
    return;
  }
  const payload = {
    date: dateInput.value,
    input_qty: Number(inputQtyInput.value || 0),
    project_id: pid,
  };
  defects.forEach((d) => (payload[d.code] = Number(document.getElementById("f_" + d.code).value || 0)));

  try {
    await api("/api/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast(editingDate ? "记录已更新" : "记录已保存");
    clearForm();
    loadRecords();
    loadKpis();
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById("resetBtn").addEventListener("click", () => clearForm(false));

// ---------------- 记录表格 ----------------

async function loadRecords() {
  const pid = currentProjectId();
  if (!pid) {
    const tbody = document.getElementById("recordsTbody");
    tbody.innerHTML = "";
    document.getElementById("recordCount").textContent = "";
    return;
  }
  const rows = await api(`/api/records?limit=200&project_id=${pid}`).catch(() => []);
  const tbody = document.getElementById("recordsTbody");
  tbody.innerHTML = "";
  document.getElementById("recordCount").textContent = rows.length ? `共 ${rows.length} 条` : "";

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const warn = r.leak_rate !== null && r.leak_rate > 5;
    tr.innerHTML = `
      <td>${r.date}</td>
      <td>${r.input_qty}</td>
      <td>${r.defect_total}</td>
      <td class="rate-cell ${warn ? "warn" : ""}">${fmtPct(r.leak_rate)}</td>
      <td><button class="btn danger-text" data-del="${r.date}">删除</button></td>
    `;
    tr.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-del]")) return;
      dateInput.value = r.date;
      tryLoadExisting(r.date);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const d = btn.dataset.del;
      const pid = currentProjectId();
      if (!pid) {
        showToast("请先选择一个专案", true);
        return;
      }
      if (!confirm(`确定删除 ${d} 的记录吗？此操作不可恢复。`)) return;
      await api(`/api/records/${d}?project_id=${pid}`, { method: "DELETE" });
      showToast("已删除");
      if (editingDate === d) clearForm();
      loadRecords();
      loadKpis();
    })
  );
}

// ---------------- 图表 ----------------

function prettyLabel(label, granularity) {
  if (granularity === "day") return label.slice(5);
  if (granularity === "week") {
    const weekNum = label.split("-W")[1];
    return "W" + weekNum;
  }
  if (granularity === "month") {
    const m = label.split("-")[1];
    return parseInt(m) + "M";
  }
  if (granularity === "year") {
    return "Y" + label;
  }
  return label;
}

function defaultRange(granularity) {
  const end = new Date();
  const start = new Date();
  if (granularity === "day") start.setDate(end.getDate() - 29);
  else if (granularity === "week") start.setDate(end.getDate() - 7 * 12);
  else if (granularity === "month") start.setMonth(end.getMonth() - 11);
  else start.setFullYear(end.getFullYear() - 4);
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const [s, e] = defaultRange(btn.dataset.g);
    document.getElementById("rangeStart").value = s;
    document.getElementById("rangeEnd").value = e;
    loadChart();
  });
});

document.getElementById("refreshChartBtn").addEventListener("click", loadChart);
document.getElementById("rangeStart").addEventListener("change", () => {
  loadChart();
  document.getElementById("rangeStart").blur();
});
document.getElementById("rangeEnd").addEventListener("change", () => {
  loadChart();
  document.getElementById("rangeEnd").blur();
});

function currentGranularity() {
  return document.querySelector(".seg-btn.active").dataset.g;
}

async function loadChart() {
  const pid = currentProjectId();
  if (!pid) {
    const thead = document.getElementById("chartDataThead");
    const tbody = document.getElementById("chartDataTbody");
    thead.innerHTML = "";
    tbody.innerHTML = "";
    if (trendChart) {
      trendChart.destroy();
      trendChart = null;
    }
    return;
  }
  const g = currentGranularity();
  let start = document.getElementById("rangeStart").value;
  let end = document.getElementById("rangeEnd").value;
  if (!start || !end) {
    [start, end] = defaultRange(g);
    document.getElementById("rangeStart").value = start;
    document.getElementById("rangeEnd").value = end;
  }

  const data = await api(`/api/summary?granularity=${g}&start=${start}&end=${end}&project_id=${pid}`).catch((e) => {
    showToast(e.message, true);
    return null;
  });
  if (!data) return;

  defects = data.defects;
  renderChart(data.buckets, g);
  renderChartDataTable(data.buckets, g);
}

function renderChart(buckets, granularity) {
  const labels = buckets.map((b) => prettyLabel(b.label, granularity));
  const defectLabels = getDefectLabels();
  const defectColors = getDefectColors();

  const chartCanvas = document.getElementById("trendChart");
  const chartCtx = chartCanvas.getContext("2d");

  const barDatasets = defects.map((d, idx) => {
    const gradient = chartCtx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, d.color);
    gradient.addColorStop(1, adjustColor(d.color, -15));

    return {
      type: "bar",
      label: d.name,
      data: buckets.map((b) => b[d.code] || 0),
      backgroundColor: gradient,
      hoverBackgroundColor: d.color,
      stack: "defects",
      yAxisID: "y",
      rates: buckets.map((b) => b.rates && b.rates[d.code]),
      borderWidth: 0,
      borderRadius: { topLeft: 3, topRight: 3, bottomLeft: 3, bottomRight: 3 },
      borderSkipped: false,
      order: 2,
      datalabels: {
        display: (ctx) => {
          const v = ctx.dataset.rates[ctx.dataIndex];
          return v !== null && v !== undefined && v > 0;
        },
        formatter: (value, ctx) => {
          const v = ctx.dataset.rates[ctx.dataIndex];
          return v ? v.toFixed(2) + "%" : "";
        },
        color: "#FFFFFF",
        font: { size: 10, weight: "600", family: "ui-monospace, Consolas, monospace" },
        anchor: "center",
        align: "center",
        textShadowBlur: 3,
        textShadowColor: "rgba(0,0,0,0.4)",
      },
    };
  });

  const lineDataset = {
    type: "line",
    label: "漏检率(%)",
    data: buckets.map((b) => b.leak_rate),
    borderColor: "#D64545",
    backgroundColor: "transparent",
    yAxisID: "y1",
    tension: 0.4,
    pointRadius: 5,
    pointHoverRadius: 8,
    pointBackgroundColor: "#D64545",
    pointBorderColor: "#FFFFFF",
    pointBorderWidth: 2,
    pointHoverBackgroundColor: "#FFFFFF",
    pointHoverBorderColor: "#D64545",
    pointHoverBorderWidth: 3,
    pointShadowBlur: 8,
    pointShadowColor: "rgba(214, 69, 69, 0.4)",
    borderWidth: 3,
    spanGaps: true,
    fill: false,
    order: 0,
    datalabels: {
      display: true,
      formatter: (value) => {
        return value !== null && value !== undefined ? value.toFixed(2) + "%" : "";
      },
      color: "#D64545",
      font: { size: 11, weight: "700", family: "ui-monospace, Consolas, monospace" },
      anchor: "end",
      align: "top",
      offset: 4,
      textShadowBlur: 4,
      textShadowColor: "rgba(255,255,255,0.8)",
    },
  };

  const ctx = document.getElementById("trendChart").getContext("2d");
  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    data: { labels, datasets: [...barDatasets, lineDataset] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      animation: {
        duration: 800,
        easing: "easeOutQuart",
      },
      scales: {
        x: { 
          stacked: true, 
          ticks: { 
            autoSkip: true, 
            maxRotation: 45, 
            minRotation: 0,
            font: { size: 11, weight: "500" },
            color: "#6B7785",
          },
          grid: { 
            display: true,
            color: "rgba(226, 230, 235, 0.5)",
            lineWidth: 1,
            drawBorder: false,
          },
          border: { color: "#E2E6EB" },
        },
        y: {
          stacked: true,
          position: "left",
          title: { display: true, text: "不良数量（个）", font: { size: 12, weight: "600" }, color: "#6B7785" },
          grid: { 
            color: "rgba(238, 241, 244, 0.8)", 
            lineWidth: 1,
            drawBorder: false,
          },
          border: { display: false },
          ticks: { font: { size: 11 }, color: "#6B7785" },
        },
        y1: {
          position: "right",
          title: { display: true, text: "漏检率（%）", font: { size: 12, weight: "600" }, color: "#D64545" },
          grid: { drawOnChartArea: false },
          border: { display: false },
          ticks: { font: { size: 11 }, color: "#D64545" },
          beginAtZero: true,
        },
      },
      plugins: {
        legend: { 
          position: "bottom", 
          labels: { 
            boxWidth: 14, 
            boxHeight: 14,
            padding: 16,
            font: { size: 12, weight: "500" },
            usePointStyle: true,
            pointStyle: "rectRounded",
          },
        },
        tooltip: {
          backgroundColor: "rgba(28, 36, 48, 0.95)",
          titleFont: { size: 13, weight: "600" },
          bodyFont: { size: 12 },
          padding: 12,
          cornerRadius: 8,
          displayColors: true,
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.type === "line") return `📉 漏检率：${ctx.parsed.y?.toFixed(2)}%`;
              const rate = ctx.dataset.rates[ctx.dataIndex];
              const rateStr = rate ? `（${rate.toFixed(2)}%）` : "";
              return `${ctx.dataset.label}：${ctx.parsed.y} 个 ${rateStr}`;
            },
          },
        },
        datalabels: {},
      },
    },
    plugins: [ChartDataLabels],
  });
}

function renderChartDataTable(buckets, granularity) {
  const thead = document.getElementById("chartDataThead");
  const tbody = document.getElementById("chartDataTbody");

  const headerCells = ["项目"];
  buckets.forEach(b => headerCells.push(prettyLabel(b.label, granularity)));
  headerCells.push("合计");

  thead.innerHTML = `<tr>${headerCells.map(h => `<th>${h}</th>`).join("")}</tr>`;

  tbody.innerHTML = "";

  const renderRow = (label, getValue) => {
    const cells = [label];
    let total = 0;
    let hasValue = false;
    buckets.forEach(b => {
      const v = getValue(b);
      cells.push(v);
      if (typeof v === 'number' && !Number.isNaN(v)) {
        total += v;
        hasValue = true;
      }
    });
    const totalVal = getValue({ total: true });
    cells.push(hasValue && total > 0 ? `<strong>${total}</strong>` : (totalVal || `<strong>--</strong>`));
    tbody.innerHTML += `<tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;
  };

  renderRow("投入数", b => b.input_qty);

  renderRow("漏检数", b => b.defect_total);

  renderRow("漏检率(%)", b => {
    if (b.total) {
      const totalInput = buckets.reduce((s, b) => s + b.input_qty, 0);
      const totalDefect = buckets.reduce((s, b) => s + b.defect_total, 0);
      return totalInput > 0 ? `<strong>${fmtPct(totalDefect / totalInput * 100)}</strong>` : `<strong>--</strong>`;
    }
    return fmtPct(b.leak_rate);
  });

  defects.forEach(d => {
    renderRow(d.name, b => b[d.code] || 0);
  });

  defects.forEach(d => {
    renderRow(d.name + "漏检率(%)", b => {
      if (b.total) {
        const totalInput = buckets.reduce((s, b) => s + b.input_qty, 0);
        const totalDefect = buckets.reduce((s, b) => s + (b[d.code] || 0), 0);
        return totalInput > 0 ? `<strong>${fmtPct(totalDefect / totalInput * 100)}</strong>` : `<strong>--</strong>`;
      }
      return fmtPct(b.rates && b.rates[d.code]);
    });
  });
}

// ---------------- 不良类型管理 ----------------

function loadDefectsTable() {
  const tbody = document.getElementById("defectsTbody");
  tbody.innerHTML = "";
  defects.forEach((d) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="color-dot" style="background: ${d.color};"></span></td>
      <td>${d.code}</td>
      <td>${d.name}</td>
      <td>
        <button class="btn ghost small" data-edit="${d.id}">编辑</button>
        <button class="btn danger-text small" data-del="${d.id}">删除</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      const id = parseInt(btn.dataset.edit);
      const d = defects.find(x => x.id === id);
      if (!d) return;
      editingDefectId = id;
      document.getElementById("m_code").value = d.code;
      document.getElementById("m_name").value = d.name;
      document.getElementById("m_code").disabled = true;
      document.getElementById("addDefectBtn").style.display = "none";
      document.getElementById("updateDefectBtn").style.display = "inline-block";
    });
  });

  tbody.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      const id = parseInt(btn.dataset.del);
      const d = defects.find(x => x.id === id);
      if (!d) return;
      if (!confirm(`确定删除不良类型「${d.name}」吗？此操作不可恢复。`)) return;
      try {
        defects = await api("/api/defects/" + id, { method: "DELETE" });
        loadDefectsTable();
        renderDefectGrid();
        showToast("已删除");
      } catch (e) {
        showToast(e.message, true);
      }
    });
  });
}

document.getElementById("addDefectBtn").addEventListener("click", async () => {
  const code = document.getElementById("m_code").value.trim();
  const name = document.getElementById("m_name").value.trim();

  if (!code) {
    showToast("请输入代码", true);
    return;
  }
  if (!name) {
    showToast("请输入名称", true);
    return;
  }

  try {
    defects = await api("/api/defects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name }),
    });
    loadDefectsTable();
    renderDefectGrid();
    document.getElementById("m_code").value = "";
    document.getElementById("m_name").value = "";
    showToast("已新增");
  } catch (e) {
    showToast(e.message, true);
  }
});

document.getElementById("updateDefectBtn").addEventListener("click", async () => {
  if (editingDefectId === null) return;
  const name = document.getElementById("m_name").value.trim();

  if (!name) {
    showToast("请输入名称", true);
    return;
  }

  try {
    defects = await api("/api/defects/" + editingDefectId, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    loadDefectsTable();
    renderDefectGrid();
    cancelDefectEdit();
    showToast("已更新");
  } catch (e) {
    showToast(e.message, true);
  }
});

document.getElementById("cancelDefectBtn").addEventListener("click", cancelDefectEdit);

function cancelDefectEdit() {
  editingDefectId = null;
  document.getElementById("m_code").value = "";
  document.getElementById("m_name").value = "";
  document.getElementById("m_code").disabled = false;
  document.getElementById("addDefectBtn").style.display = "inline-block";
  document.getElementById("updateDefectBtn").style.display = "none";
}

// ---------------- 专案管理 ----------------

async function loadProjects() {
  projects = await api("/api/projects");
  const select = document.getElementById("projectSelect");
  const currentVal = select.value;
  if (projects.length === 0) {
    select.innerHTML = `<option value="" disabled>请先添加专案</option>`;
    select.disabled = true;
    document.getElementById("formProjectBadge").textContent = "当前专案：--";
  } else {
    select.innerHTML = projects.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
    if (projects.find(p => p.id == currentVal)) {
      select.value = currentVal;
    } else {
      select.value = projects[0].id;
    }
    select.disabled = false;
    const project = projects.find(p => p.id == currentProjectId());
    document.getElementById("formProjectBadge").textContent = "当前专案：" + (project?.name || "--");
  }
  renderProjectsTable();
}

function renderProjectsTable() {
  const tbody = document.getElementById("projectsTbody");
  const uniqueProjects = projects.filter((p, idx, arr) => arr.findIndex(x => x.id === p.id) === idx);
  tbody.innerHTML = uniqueProjects.map(p => `
    <tr>
      <td>${p.name}</td>
      <td>${p.code || "-"}</td>
      <td>${p.description || "-"}</td>
      <td>
        <button class="btn ghost small" onclick="editProject(${p.id})">编辑</button>
        <button class="btn danger small" onclick="deleteProject(${p.id})">删除</button>
      </td>
    </tr>
  `).join("");
}

function editProject(id) {
  const p = projects.find(x => x.id === id);
  if (!p) return;
  editingProjectId = id;
  document.getElementById("p_name").value = p.name;
  document.getElementById("p_code").value = p.code || "";
  document.getElementById("p_description").value = p.description || "";
  document.getElementById("p_code").disabled = id === 1;
  document.getElementById("addProjectBtn").style.display = "none";
  document.getElementById("updateProjectBtn").style.display = "inline-block";
}

function cancelProjectEdit() {
  editingProjectId = null;
  document.getElementById("p_name").value = "";
  document.getElementById("p_code").value = "";
  document.getElementById("p_description").value = "";
  document.getElementById("p_code").disabled = false;
  document.getElementById("addProjectBtn").style.display = "inline-block";
  document.getElementById("updateProjectBtn").style.display = "none";
}

document.getElementById("addProjectBtn").addEventListener("click", async () => {
  const name = document.getElementById("p_name").value.trim();
  const code = document.getElementById("p_code").value.trim();
  const description = document.getElementById("p_description").value.trim();

  if (!name) {
    showToast("请输入名称", true);
    return;
  }

  try {
    projects = await api("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, code, description }),
    });
    loadProjects();
    cancelProjectEdit();
    showToast("已新增");
  } catch (e) {
    showToast(e.message, true);
  }
});

document.getElementById("updateProjectBtn").addEventListener("click", async () => {
  const name = document.getElementById("p_name").value.trim();
  const code = document.getElementById("p_code").value.trim();
  const description = document.getElementById("p_description").value.trim();

  if (!name) {
    showToast("请输入名称", true);
    return;
  }

  try {
    projects = await api(`/api/projects/${editingProjectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, code, description }),
    });
    renderProjectsTable();
    loadProjects();
    cancelProjectEdit();
    showToast("已更新");
  } catch (e) {
    showToast(e.message, true);
  }
});

document.getElementById("cancelProjectBtn").addEventListener("click", cancelProjectEdit);

async function deleteProject(id) {
  if (!confirm("确定删除该专案吗？删除后无法恢复。")) return;
  try {
    projects = await api(`/api/projects/${id}`, { method: "DELETE" });
    renderProjectsTable();
    loadProjects();
    showToast("已删除");
  } catch (e) {
    showToast(e.message, true);
  }
}

document.getElementById("projectSelect").addEventListener("change", () => {
  const project = projects.find(p => p.id == currentProjectId());
  document.getElementById("formProjectBadge").textContent = "当前专案：" + (project?.name || "--");
  clearForm();
  loadKpis();
  loadRecords();
  loadChart();
});

// ---------------- 初始化 ----------------

(function init() {
  const [s, e] = defaultRange("day");
  document.getElementById("rangeStart").value = s;
  document.getElementById("rangeEnd").value = e;
  loadProjects().then(() => {
    const project = projects.find(p => p.id == currentProjectId());
    document.getElementById("formProjectBadge").textContent = "当前专案：" + (project?.name || "--");
  });
  loadDefects();
  loadKpis();
  loadRecords();
})();