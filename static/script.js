/* ===================================================================
   Job Crawler — Frontend Logic
   =================================================================== */

// ── State ───────────────────────────────────────────────────────────
let allJobs        = [];
let config         = {};
let sortCol        = "score";
let sortDir        = "desc";
let currentView    = "table";
let notesJobId     = null;
let crawlTimer     = null;
let selectedStatuses = new Set();
let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let currentAiJobId = null;
let jdJobId = null;

// ── DOM refs ─────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Bootstrap ────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await loadConfig();
  await loadJobs();
  initEventListeners();
  initKanban();
  initAiCoverLetter();
  pollCrawlStatus();
});

// ── API helpers ──────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Config ───────────────────────────────────────────────────────────
async function loadConfig() {
  config = await api("/api/config");
  renderConfigModal();
}

async function saveConfig() {
  const locs = [...document.querySelectorAll(".loc-row")].map(row => ({
    city:        row.querySelector(".loc-city").value.trim(),
    distance_km: parseInt(row.querySelector(".loc-dist").value) || 30,
  })).filter(l => l.city);

  const hard = [...document.querySelectorAll(".hard-kw-input")]
    .map(i => i.value.trim()).filter(Boolean);

  const soft = [...document.querySelectorAll(".soft-kw-wrapper")].map(wrapper => {
    const row    = wrapper.querySelector(".soft-kw-row");
    const banned = [...wrapper.querySelectorAll(".ban-chip-word")].map(el => el.textContent);
    return {
      keyword:          row.querySelector(".soft-kw-input").value.trim(),
      rating:           parseInt(row.querySelector(".soft-kw-rating").value) || 5,
      banned_contexts:  banned,
    };
  }).filter(s => s.keyword);

  const sources = [];
  if ($("src-stepstone").checked)     sources.push("stepstone");
  if ($("src-bundesagentur").checked) sources.push("bundesagentur");

  const apiKeyInput = $("ai-api-key").value.trim();
  const maxPagesSS  = parseInt($("max-pages-stepstone").value) || 8;
  config = {
    locations: locs,
    hard_keywords: hard,
    soft_keywords: soft,
    max_days_online:      parseInt($("max-days").value) || 30,
    max_pages_stepstone:  maxPagesSS,
    sources,
    auto_delete_days:     parseInt($("auto-delete-days").value) || 0,
    anthropic_api_key:    apiKeyInput || config.anthropic_api_key || "",
  };

  await api("/api/config", { method: "POST", body: JSON.stringify(config) });
  closeModal("modal-settings");
}

function renderConfigModal() {
  // Locations
  const locList = $("locations-list");
  locList.innerHTML = "";
  (config.locations || []).forEach(l => addLocationRow(l.city, l.distance_km));

  // Hard keywords
  const hardList = $("hard-keywords-list");
  hardList.innerHTML = "";
  (config.hard_keywords || []).forEach(kw => addHardKeywordRow(kw));

  // Soft keywords
  const softList = $("soft-keywords-list");
  softList.innerHTML = "";
  (config.soft_keywords || []).forEach(sk => addSoftKeywordRow(sk.keyword, sk.rating, sk.banned_contexts || []));

  $("max-days").value              = config.max_days_online ?? 30;
  $("max-pages-stepstone").value   = config.max_pages_stepstone ?? 8;
  $("auto-delete-days").value      = config.auto_delete_days ?? 0;
  $("ai-api-key").value            = config.anthropic_api_key || "";
  updateDurationEstimate();

  const srcs = config.sources || [];
  $("src-stepstone").checked     = srcs.includes("stepstone");
  $("src-bundesagentur").checked = srcs.includes("bundesagentur") || srcs.includes("indeed");
}

function addLocationRow(city = "", dist = 30) {
  const row = document.createElement("div");
  row.className = "loc-row";
  row.innerHTML = `
    <input class="input loc-city" placeholder="Stadt z.B. Berlin" value="${esc(city)}" />
    <input class="input loc-dist rating-input" type="number" min="1" max="200"
           value="${dist}" title="Radius in km" />
    <span style="font-size:11px;color:var(--text-muted)">km</span>
    <button class="remove-btn" title="Entfernen">✕</button>`;
  row.querySelector(".remove-btn").onclick = () => row.remove();
  $("locations-list").appendChild(row);
}

function addHardKeywordRow(kw = "") {
  const row = document.createElement("div");
  row.className = "kw-row";
  row.innerHTML = `
    <input class="input hard-kw-input" placeholder="Pflicht-Schlagwort" value="${esc(kw)}" />
    <button class="remove-btn" title="Entfernen">✕</button>`;
  row.querySelector(".remove-btn").onclick = () => row.remove();
  $("hard-keywords-list").appendChild(row);
}

function addSoftKeywordRow(kw = "", rating = 5, banned = []) {
  const wrapper = document.createElement("div");
  wrapper.className = "soft-kw-wrapper";

  const row = document.createElement("div");
  row.className = "kw-row soft-kw-row";
  row.innerHTML = `
    <input class="input soft-kw-input" placeholder="Wunsch-Schlagwort" value="${esc(kw)}" />
    <input class="input soft-kw-rating rating-input" type="number" min="1" max="10"
           value="${rating}" title="Priorität 1–10" />
    <span style="font-size:11px;color:var(--text-muted)">/ 10</span>
    <button class="remove-btn" title="Entfernen">✕</button>`;
  row.querySelector(".remove-btn").onclick = () => wrapper.remove();
  wrapper.appendChild(row);

  const bannedDiv = document.createElement("div");
  bannedDiv.className = "banned-contexts";
  if (banned.length) renderBannedChips(bannedDiv, banned);
  wrapper.appendChild(bannedDiv);

  $("soft-keywords-list").appendChild(wrapper);
}

function renderBannedChips(container, words) {
  if (!words.length) { container.innerHTML = ""; return; }
  container.innerHTML = '<span class="banned-label">Gebannt:</span> ' +
    words.map(w =>
      `<span class="banned-chip"><span class="ban-chip-word">${esc(w)}</span><button class="remove-ban-chip" title="Sperre aufheben">✕</button></span>`
    ).join("");
  container.querySelectorAll(".remove-ban-chip").forEach(btn => {
    btn.onclick = () => {
      btn.closest(".banned-chip").remove();
      if (!container.querySelectorAll(".banned-chip").length) container.innerHTML = "";
    };
  });
}

// ── Jobs ─────────────────────────────────────────────────────────────
async function loadJobs() {
  allJobs = await api("/api/jobs");
  renderTable();
  renderKanban();
}

// ── Table rendering ──────────────────────────────────────────────────
function getFilteredJobs() {
  const q      = $("search-input").value.toLowerCase();
  const source = $("filter-source").value;

  return allJobs.filter(j => {
    if (q && !`${j.title} ${j.company}`.toLowerCase().includes(q)) return false;
    if (selectedStatuses.size > 0 && !selectedStatuses.has(j.status)) return false;
    if (source && j.source !== source) return false;
    return true;
  });
}

function getSortedJobs(jobs) {
  return [...jobs].sort((a, b) => {
    let va = a[sortCol] ?? "";
    let vb = b[sortCol] ?? "";
    if (typeof va === "number") {
      return sortDir === "asc" ? va - vb : vb - va;
    }
    va = String(va).toLowerCase();
    vb = String(vb).toLowerCase();
    return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
  });
}

function renderTable() {
  const jobs = getSortedJobs(getFilteredJobs());
  const tbody = $("job-tbody");
  tbody.innerHTML = "";

  $("empty-state").style.display = jobs.length ? "none" : "block";

  jobs.forEach(j => {
    const score = j.score ?? 0;
    const scoreClass = score >= 20 ? "score-high" : score >= 8 ? "score-mid" : "score-low";
    const tags = renderKwTags(j.matched_soft, true);
    const srcClass = j.source === "stepstone" ? "src-stepstone" : "src-bundesagentur";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-score">
        <span class="score-pill ${scoreClass}">${score}</span>
      </td>
      <td class="col-title">
        <a class="job-link" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">
          ${esc(j.title)}
        </a>
        ${j.url ? `<button class="copy-url-btn" data-url="${esc(j.url)}" title="URL kopieren">⧉</button>` : ""}
      </td>
      <td class="col-company">${esc(j.company)}</td>
      <td class="col-location">${esc(j.location)}</td>
      <td class="col-date">${ageDot(j.published_date)}${formatDate(j.published_date)}${ageBadge(j.published_date)}</td>
      <td class="col-source"><span class="src-badge ${srcClass}">${esc(j.source)}</span></td>
      <td class="col-keywords">${tags}</td>
      <td class="col-status">
        <select class="status-select" data-id="${j.id}">
          ${statusOptions(j.status)}
        </select>
      </td>
      <td class="col-actions">
        <button class="action-btn" title="Beschreibung anzeigen" data-action="desc" data-id="${j.id}">📄</button>
        <button class="action-btn" title="Notiz bearbeiten" data-action="note" data-id="${j.id}" data-title="${esc(j.title)}">📝</button>
        <button class="action-btn" title="Löschen" data-action="delete" data-id="${j.id}">🗑</button>
      </td>`;
    tbody.appendChild(tr);
  });

  // Status change handlers
  tbody.querySelectorAll(".status-select").forEach(sel => {
    sel.onchange = async () => {
      await api(`/api/jobs/${sel.dataset.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: sel.value }),
      });
      const job = allJobs.find(j => j.id === sel.dataset.id);
      if (job) { job.status = sel.value; renderKanban(); }
    };
  });

  // Action handlers
  tbody.querySelectorAll("[data-action]").forEach(btn => {
    btn.onclick = () => handleAction(btn.dataset.action, btn.dataset.id, btn.dataset.title);
  });

  // Copy URL buttons
  tbody.querySelectorAll(".copy-url-btn").forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const url  = btn.dataset.url;
      const done = () => { btn.textContent = "✓"; setTimeout(() => { btn.textContent = "⧉"; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
      } else {
        fallbackCopy(url, done);
      }
    };
  });

  // Keyword ban handlers
  tbody.querySelectorAll(".kw-ban-btn").forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      await api("/api/config/ban", {
        method: "POST",
        body: JSON.stringify({ keyword: btn.dataset.keyword, context: btn.dataset.context }),
      });
      config = await api("/api/config");
      const item = btn.closest(".kw-ctx-item");
      if (item) item.remove();
    };
  });
}

function statusOptions(current) {
  const opts = [
    ["new",        "Offen"],
    ["interested", "Interessiert"],
    ["applied",    "Beworben"],
    ["interview",  "Gespräch"],
    ["rejected",   "Absage"],
    ["no_fit",     "Passt nicht"],
  ];
  return opts.map(([v, l]) =>
    `<option value="${v}"${v === current ? " selected" : ""}>${l}</option>`
  ).join("");
}

function handleAction(action, id, title) {
  if (action === "note") {
    notesJobId = id;
    $("notes-job-title").textContent = title || "Notiz";
    const job = allJobs.find(j => j.id === id);
    $("notes-text").value = job?.notes || "";
    openModal("modal-notes");
  } else if (action === "desc") {
    const job = allJobs.find(j => j.id === id);
    if (job) showDescription(job);
  } else if (action === "delete") {
    if (!confirm("Job löschen?")) return;
    api(`/api/jobs/${id}`, { method: "DELETE" }).then(() => {
      allJobs = allJobs.filter(j => j.id !== id);
      renderTable();
      renderKanban();
    });
  }
}

function showDescription(j) {
  $("desc-job-title").textContent = j.title || "Beschreibung";
  const desc = j.description || "";
  const isShort = desc.length < 120;
  $("desc-meta").innerHTML =
    `<span class="desc-meta-src">${esc(j.source || "")}</span>` +
    `<span class="desc-meta-len">${desc.length} Zeichen</span>` +
    (isShort ? `<span class="desc-meta-warn">⚠ Nur Kurzbeschreibung — Detail-Seite war beim Crawl nicht verfügbar</span>` : "");
  $("desc-text").textContent = desc || "(keine Beschreibung gespeichert)";
  openModal("modal-desc");
}

// ── Kanban rendering ─────────────────────────────────────────────────
const KANBAN_COLS = ["new", "interested", "applied", "interview", "rejected", "no_fit"];

function renderKanban() {
  KANBAN_COLS.forEach(status => {
    const list  = $(`kl-${status}`);
    const count = $(`cnt-${status}`);
    const jobs  = allJobs.filter(j => j.status === status)
                         .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    count.textContent = jobs.length;
    list.innerHTML = "";
    jobs.forEach(j => list.appendChild(makeKanbanCard(j)));
  });
  renderCalendar();
}

function makeKanbanCard(j) {
  const card = document.createElement("div");
  card.className = "kcard";
  card.dataset.id = j.id;

  const tags = renderKwTags((j.matched_soft || []).slice(0, 3));
  const titleHtml =
    `<span class="kcard-title-clickable" data-action="detail" data-id="${j.id}">${esc(j.title)}</span>` +
    (j.url ? `<a class="kcard-ext-link" href="${esc(j.url)}" target="_blank" rel="noopener" title="Stelle öffnen">↗</a>` : "");

  // Date rows — always show a date once it is set, even after moving to another column
  let datesHtml = "";
  if (j.published_date) {
    datesHtml += `<div class="kcard-date-row">
      <span class="kcard-date-label">Online:</span>
      <span>${formatDate(j.published_date)}</span>
    </div>`;
  }
  if (j.status === "applied" || j.applied_date) {
    datesHtml += `<div class="kcard-date-row">
      <span class="kcard-date-label">Beworben:</span>
      <input type="date" class="kcard-date-input" data-field="applied_date" value="${esc(j.applied_date || "")}" />
    </div>`;
  }
  if (j.status === "interview" || j.interview_date) {
    datesHtml += `<div class="kcard-date-row">
      <span class="kcard-date-label">Gespräch:</span>
      <input type="date" class="kcard-date-input" data-field="interview_date" value="${esc(j.interview_date || "")}" />
    </div>`;
  }
  if (j.status === "rejected" || j.rejected_date) {
    datesHtml += `<div class="kcard-date-row">
      <span class="kcard-date-label">Absage:</span>
      <input type="date" class="kcard-date-input" data-field="rejected_date" value="${esc(j.rejected_date || "")}" />
    </div>`;
  }

  const footerLeft = j.source === "custom"
    ? '<span class="kcard-custom-badge">Eigener Eintrag</span>'
    : `Score: ${j.score ?? 0}`;

  card.innerHTML = `
    <div class="kcard-title">${titleHtml}</div>
    <div class="kcard-meta">${esc(j.company)}${j.location ? " · " + esc(j.location) : ""}</div>
    ${datesHtml ? `<div class="kcard-dates">${datesHtml}</div>` : ""}
    <div>${tags}</div>
    <div class="kcard-footer">
      <span class="kcard-score">${footerLeft}</span>
      <div class="kcard-actions">
        <button class="action-btn" title="KI-Bewerbung erstellen" data-action="ai-cover" data-id="${j.id}">✨</button>
        <button class="action-btn" title="Notiz" data-action="note"
                data-id="${j.id}" data-title="${esc(j.title)}">📝</button>
        <button class="action-btn" title="Löschen"
                data-action="delete" data-id="${j.id}">🗑</button>
      </div>
    </div>`;

  // Date inputs — stop mousedown so SortableJS doesn't grab drag events
  card.querySelectorAll(".kcard-date-input").forEach(input => {
    input.addEventListener("mousedown", e => e.stopPropagation());
    input.onchange = async () => {
      await api(`/api/jobs/${j.id}/dates`, {
        method: "PATCH",
        body: JSON.stringify({ [input.dataset.field]: input.value }),
      });
      const job = allJobs.find(j2 => j2.id === j.id);
      if (job) job[input.dataset.field] = input.value;
      renderCalendar();
    };
  });

  card.querySelectorAll("[data-action]").forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      if (btn.dataset.action === "detail")   openJobDetailModal(btn.dataset.id);
      else if (btn.dataset.action === "ai-cover") goToAiCoverForJob(btn.dataset.id);
      else handleAction(btn.dataset.action, btn.dataset.id, btn.dataset.title);
    };
  });

  // Click anywhere on the card body (not on interactive elements) → detail modal
  card.addEventListener("click", e => {
    if (e.target.closest(".kcard-actions") ||
        e.target.closest(".kcard-dates")   ||
        e.target.classList.contains("kcard-ext-link") ||
        e.target.closest(".kcard-ext-link")) return;
    openJobDetailModal(j.id);
  });

  return card;
}

function initKanban() {
  KANBAN_COLS.forEach(status => {
    const list = $(`kl-${status}`);
    Sortable.create(list, {
      group:     "kanban",
      animation: 150,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      dragoverBubble: true,
      onAdd: async (evt) => {
        const id = evt.item.dataset.id;
        const newStatus = evt.to.closest(".kanban-col").dataset.status;
        await api(`/api/jobs/${id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: newStatus }),
        });
        const job = allJobs.find(j => j.id === id);
        if (job) {
          job.status = newStatus;
          renderKanban();   // re-render to update counts & table
          if (currentView === "table") renderTable();
        }
      },
    });
  });
}

// ── Crawl ────────────────────────────────────────────────────────────
let _crawlStartedAt = null;

async function startCrawl() {
  const badge = $("crawl-status");
  badge.textContent = "Starte…";
  badge.className = "status-badge running";
  _crawlStartedAt = Date.now();
  try {
    await api("/api/crawl", { method: "POST" });
    badge.textContent = "Läuft…";
    showProgressBar(0, "");
    startCrawlPoll();
  } catch (e) {
    badge.textContent = e.message;
    badge.className = "status-badge error";
  }
}

function startCrawlPoll() {
  if (crawlTimer) clearInterval(crawlTimer);
  crawlTimer = setInterval(pollCrawlStatus, 2000);
}

function showProgressBar(pct, label) {
  const wrap  = $("crawl-progress-wrap");
  const fill  = $("crawl-progress-fill");
  const lbl   = $("crawl-progress-label");
  wrap.style.display = "block";

  // If pct is 0 and crawl just started, show indeterminate
  if (pct === 0) {
    fill.classList.add("indeterminate");
    fill.style.width = "";
  } else {
    fill.classList.remove("indeterminate");
    fill.style.width = pct + "%";
  }

  // Right side: elapsed + estimated remaining
  let rightText = "";
  if (_crawlStartedAt && pct > 5) {
    const elapsed = (Date.now() - _crawlStartedAt) / 1000;
    const totalEst = elapsed / (pct / 100);
    const remaining = Math.max(0, totalEst - elapsed);
    rightText = `~${fmtSec(remaining)} verbleibend`;
  } else if (_crawlStartedAt) {
    const elapsed = (Date.now() - _crawlStartedAt) / 1000;
    rightText = `${fmtSec(elapsed)} vergangen`;
  }

  lbl.innerHTML = `<span>${label || "Vorbereitung…"}</span><span>${rightText}</span>`;
}

function hideProgressBar() {
  $("crawl-progress-wrap").style.display = "none";
  $("crawl-progress-fill").style.width = "0%";
  $("crawl-progress-fill").classList.remove("indeterminate");
}

function fmtSec(s) {
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
}

async function pollCrawlStatus() {
  try {
    const st = await api("/api/crawl/status");
    const badge = $("crawl-status");
    if (st.running) {
      badge.textContent = "Läuft…";
      badge.className = "status-badge running";
      if (!crawlTimer) startCrawlPoll();
      showProgressBar(st.progress || 0, st.progress_label || "");
    } else {
      if (crawlTimer) { clearInterval(crawlTimer); crawlTimer = null; }
      hideProgressBar();
      _crawlStartedAt = null;
      if (st.error) {
        badge.textContent = "Fehler!";
        badge.className = "status-badge error";
      } else if (st.last_run) {
        badge.textContent = `${st.last_count} Jobs · ${st.last_run.slice(11, 16)}`;
        badge.className = "status-badge done";
        if (allJobs.length === 0 && st.last_count > 0) await loadJobs();
      } else {
        badge.textContent = "–";
        badge.className = "status-badge";
      }
    }
  } catch (_) {}
}

function estimateCrawlMinutes(cfg) {
  const n       = (cfg.locations || []).length;
  const pages   = cfg.max_pages_stepstone || 8;
  const sources = cfg.sources || ["stepstone", "bundesagentur"];
  let sec = 0;
  if (sources.includes("stepstone"))     sec += n * pages * 92;   // ~92s/Seite inkl. Detail-Fetches
  if (sources.includes("bundesagentur")) sec += n * 5   * 27;    // ~5 Seiten im Schnitt
  return Math.max(1, Math.round(sec / 60));
}

function updateDurationEstimate() {
  const el = $("crawl-duration-estimate");
  if (!el) return;
  const pages   = parseInt($("max-pages-stepstone").value) || 8;
  const n       = document.querySelectorAll(".loc-row").length || (config.locations || []).length || 1;
  const sources = [];
  if ($("src-stepstone")?.checked)     sources.push("stepstone");
  if ($("src-bundesagentur")?.checked) sources.push("bundesagentur");
  const min = estimateCrawlMinutes({ locations: Array(n), max_pages_stepstone: pages, sources });
  el.textContent = `→ geschätzte Suchdauer: ~${min} min`;
}

// ── Event listeners ──────────────────────────────────────────────────
function initEventListeners() {
  // Crawl
  $("btn-crawl").onclick = startCrawl;

  // Settings modal
  $("btn-settings").onclick = () => { renderConfigModal(); openModal("modal-settings"); };
  $("modal-close").onclick   = () => closeModal("modal-settings");
  $("btn-cancel-config").onclick = () => closeModal("modal-settings");
  $("btn-save-config").onclick   = saveConfig;

  // Add rows
  $("btn-add-location").onclick = () => { addLocationRow(); updateDurationEstimate(); };
  $("btn-add-hard").onclick     = () => addHardKeywordRow();
  $("btn-add-soft").onclick     = () => addSoftKeywordRow();

  // Live duration estimate update
  ["max-pages-stepstone", "src-stepstone", "src-bundesagentur"].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener("change", updateDurationEstimate);
  });

  // Description modal
  $("desc-close").onclick = () => closeModal("modal-desc");

  // Job detail modal
  $("jd-close").onclick = () => closeModal("modal-job-detail");

  // Rescore button
  $("btn-rescore").onclick = async () => {
    const btn = $("btn-rescore");
    btn.disabled = true;
    btn.textContent = "Bewertet…";
    try {
      const res = await api("/api/rescore", { method: "POST" });
      btn.textContent = `✓ ${res.count} Jobs neu bewertet`;
      await loadJobs();
      setTimeout(() => { btn.textContent = "↻ Neu bewerten"; btn.disabled = false; }, 3000);
    } catch (e) {
      btn.textContent = "Fehler!";
      btn.disabled = false;
    }
  };

  // Custom job modal
  $("btn-add-job").onclick          = () => { clearCustomJobForm(); openModal("modal-custom-job"); };
  $("custom-job-close").onclick     = () => closeModal("modal-custom-job");
  $("btn-cancel-custom-job").onclick = () => closeModal("modal-custom-job");
  $("btn-save-custom-job").onclick  = saveCustomJob;

  // Notes modal
  $("notes-close").onclick = () => closeModal("modal-notes");
  $("btn-save-notes").onclick = async () => {
    if (!notesJobId) return;
    const notes = $("notes-text").value;
    await api(`/api/jobs/${notesJobId}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    });
    const job = allJobs.find(j => j.id === notesJobId);
    if (job) job.notes = notes;
    closeModal("modal-notes");
  };

  // Close modals on overlay click
  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.onclick = e => { if (e.target === overlay) overlay.style.display = "none"; };
  });

  // View toggle
  document.querySelectorAll("[data-view]").forEach(btn => {
    btn.onclick = () => {
      currentView = btn.dataset.view;
      document.querySelectorAll("[data-view]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
      $(`view-${currentView}`).classList.add("active");
      if (currentView === "kanban") { renderKanban(); }
      else if (currentView === "ai-cover") { refreshAiJobDropdown(); }
    };
  });

  // Table filters
  $("search-input").oninput   = renderTable;
  $("filter-source").onchange = renderTable;

  // Status filter chips
  document.querySelectorAll(".filter-chip").forEach(chip => {
    chip.onclick = () => {
      const status = chip.dataset.status;
      if (status === "") {
        selectedStatuses.clear();
      } else {
        if (selectedStatuses.has(status)) selectedStatuses.delete(status);
        else selectedStatuses.add(status);
      }
      document.querySelectorAll(".filter-chip").forEach(c => {
        c.classList.toggle("active",
          c.dataset.status === "" ? selectedStatuses.size === 0 : selectedStatuses.has(c.dataset.status)
        );
      });
      renderTable();
    };
  });

  // Table sorting
  document.querySelectorAll("th.sortable").forEach(th => {
    th.onclick = () => {
      const col = th.dataset.col;
      if (sortCol === col) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortCol = col; sortDir = "desc"; }
      document.querySelectorAll("th.sortable").forEach(t =>
        t.classList.remove("sort-asc", "sort-desc"));
      th.classList.add(sortDir === "asc" ? "sort-asc" : "sort-desc");
      renderTable();
    };
  });
}

// ── Activity Calendar ────────────────────────────────────────────────
const MONTH_NAMES = ["Januar","Februar","März","April","Mai","Juni",
                     "Juli","August","September","Oktober","November","Dezember"];

function buildEventMap() {
  const events = {};
  const add = (date, type, j) => {
    if (!date) return;
    if (!events[date]) events[date] = [];
    events[date].push({ type, title: j.title, company: j.company || "", id: j.id });
  };
  allJobs.forEach(j => {
    add(j.applied_date,   "applied",   j);
    add(j.interview_date, "interview", j);
  });
  return events;
}

function renderCalendar() {
  const cal = $("activity-calendar");
  if (!cal) return;

  const events  = buildEventMap();
  const year    = calMonth.getFullYear();
  const month   = calMonth.getMonth();
  const first   = new Date(year, month, 1);
  const last    = new Date(year, month + 1, 0);
  const startDow = (first.getDay() + 6) % 7; // Monday = 0

  const todayStr = new Date().toISOString().slice(0, 10);

  let grid = "";
  for (let i = 0; i < startDow; i++) grid += `<div class="cal-cell cal-empty"></div>`;
  for (let d = 1; d <= last.getDate(); d++) {
    const ds   = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const evts = events[ds] || [];
    const hasA = evts.some(e => e.type === "applied");
    const hasI = evts.some(e => e.type === "interview");
    const dots = (hasA ? `<span class="cal-dot cal-dot-applied"></span>` : "") +
                 (hasI ? `<span class="cal-dot cal-dot-interview"></span>` : "");
    grid += `<div class="cal-cell${ds === todayStr ? " cal-today" : ""}${evts.length ? " cal-has-events" : ""}" data-date="${ds}">
      <span class="cal-day-num">${d}</span>
      <div class="cal-dots">${dots}</div>
    </div>`;
  }

  cal.innerHTML = `
    <div class="cal-header">
      <button class="cal-nav" id="cal-prev">‹</button>
      <span class="cal-title">${MONTH_NAMES[month]} ${year}</span>
      <button class="cal-nav" id="cal-next">›</button>
    </div>
    <div class="cal-grid">
      <div class="cal-dow">Mo</div><div class="cal-dow">Di</div>
      <div class="cal-dow">Mi</div><div class="cal-dow">Do</div>
      <div class="cal-dow">Fr</div><div class="cal-dow">Sa</div>
      <div class="cal-dow">So</div>
      ${grid}
    </div>
    <div class="cal-events" id="cal-event-list"></div>`;

  $("cal-prev").onclick = () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); };
  $("cal-next").onclick = () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); };

  // Show upcoming events by default
  showCalendarEvents(events, null);

  // Click on day to show that day's events
  cal.querySelectorAll(".cal-cell.cal-has-events").forEach(cell => {
    cell.onclick = () => {
      cal.querySelectorAll(".cal-cell").forEach(c => c.classList.remove("cal-selected"));
      cell.classList.add("cal-selected");
      showCalendarEvents(events, cell.dataset.date);
    };
  });
}

function showCalendarEvents(events, filterDate) {
  const list = $("cal-event-list");
  if (!list) return;

  let entries;
  if (filterDate) {
    entries = [[filterDate, events[filterDate] || []]];
  } else {
    const today = new Date().toISOString().slice(0, 10);
    entries = Object.entries(events)
      .filter(([d]) => d >= today)
      .sort(([a],[b]) => a.localeCompare(b))
      .slice(0, 12);
  }

  const typeLabel = { applied: "Beworben", interview: "Gespräch" };
  const title = filterDate ? formatDate(filterDate) : "Kommende Termine";

  if (!entries.length || entries.every(([,evts]) => !evts.length)) {
    list.innerHTML = `<div class="cal-events-title">${title}</div><div class="cal-no-events">Keine Einträge</div>`;
    return;
  }

  const rows = entries.flatMap(([date, evts]) =>
    evts.map(e => `
      <div class="cal-event-item cal-event-${e.type}">
        <span class="cal-event-dot"></span>
        <div class="cal-event-body">
          ${!filterDate ? `<div class="cal-event-date">${formatDate(date)}</div>` : ""}
          <div class="cal-event-label">${typeLabel[e.type] || e.type}</div>
          <div class="cal-event-title">${esc(e.title)}</div>
          ${e.company ? `<div class="cal-event-company">${esc(e.company)}</div>` : ""}
        </div>
      </div>`)
  ).join("");

  list.innerHTML = `<div class="cal-events-title">${title}</div>${rows}`;
}

// ── Custom job ───────────────────────────────────────────────────────
function clearCustomJobForm() {
  ["cj-title","cj-company","cj-location","cj-url","cj-notes"].forEach(id => { $(id).value = ""; });
}

async function saveCustomJob() {
  const title = $("cj-title").value.trim();
  if (!title) { $("cj-title").focus(); return; }
  await api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      title,
      company:  $("cj-company").value.trim(),
      location: $("cj-location").value.trim(),
      url:      $("cj-url").value.trim(),
      notes:    $("cj-notes").value.trim(),
    }),
  });
  closeModal("modal-custom-job");
  await loadJobs();
}

// ── Modal helpers ─────────────────────────────────────────────────────
function openModal(id)  { $(id).style.display = "flex"; }
function closeModal(id) { $(id).style.display = "none"; }

// ── Utility ──────────────────────────────────────────────────────────
function fallbackCopy(text, cb) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); cb && cb(); } catch (_) {}
  document.body.removeChild(ta);
}

function renderKwTags(matchedSoft, showBan = false) {
  if (!matchedSoft || !matchedSoft.length)
    return '<span style="color:var(--text-muted)">–</span>';
  return matchedSoft.map(m => {
    // Backward compat: old DB entries store plain strings
    if (typeof m === "string") return `<span class="kw-tag">${esc(m)}</span>`;
    const kw = m.keyword || "";
    const contexts = (m.contexts || []).filter(c => c.toLowerCase() !== kw.toLowerCase());
    if (!contexts.length) return `<span class="kw-tag">${esc(kw)}</span>`;
    const ctxHtml = contexts.slice(0, 3).map(c => {
      const ban = showBan
        ? `<button class="kw-ban-btn" data-keyword="${esc(kw)}" data-context="${esc(c)}" title="'${esc(c)}' für '${esc(kw)}' sperren">✕</button>`
        : "";
      return `<span class="kw-ctx-item">${esc(c)}${ban}</span>`;
    }).join(", ");
    return `<span class="kw-tag-group"><span class="kw-tag">${esc(kw)}</span><span class="kw-ctx">(${ctxHtml})</span></span>`;
  }).join(" ");
}

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso) {
  if (!iso) return "–";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
  } catch (_) { return iso; }
}

function dateDaysAgo(iso) {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return Math.round((today - d) / 86400000);
}

function ageDot(iso) {
  const days = dateDaysAgo(iso);
  if (days === null) return "";
  let color;
  if (days === 0)     color = "var(--green)";
  else if (days <= 3) color = "var(--yellow)";
  else if (days <= 7) color = "var(--orange)";
  else                color = "var(--red)";
  const label = days === 0 ? "heute" : days === 1 ? "gestern" : `${days} Tage alt`;
  return `<span class="age-dot" style="background:${color}" title="${label}"></span>`;
}

function ageBadge(iso) {
  const days = dateDaysAgo(iso);
  if (days === 0) return ' <span class="age-badge age-new">NEU</span>';
  if (days === 1) return ' <span class="age-badge age-yesterday">GESTERN</span>';
  if (days === 2) return ' <span class="age-badge age-daybeforeyesterday">VORGESTERN</span>';
  return "";
}

// ── AI Cover Letter ──────────────────────────────────────────────────────────

const AI_LS_FIELDS = [
  { id: "ai-role-prompt", key: "rolePrompt" },
  { id: "ai-my-data",     key: "myData"     },
  { id: "ai-job-desc",    key: "jobDesc"     },
  { id: "ai-instructions",key: "instructions"},
  { id: "ai-rules",       key: "rules"       },
];

let aiUploadedDocs = [];  // [{filename, text, chars}]
let aiChatHistory  = [];  // [{role, content}]  — full conversation
let aiGenerating   = false;
let aiSystemPrompt = "";  // cached system for chat continuation

function initAiCoverLetter() {
  // Restore field values from localStorage
  AI_LS_FIELDS.forEach(({ id, key }) => {
    const el = $(id);
    if (!el) return;
    el.value = localStorage.getItem(`ai_${key}`) || "";
    el.addEventListener("input", () => localStorage.setItem(`ai_${key}`, el.value));
  });

  // Restore model & thinking
  const savedModel = localStorage.getItem("ai_model") || "claude-sonnet-4-6";
  $("ai-model").value = savedModel;
  $("ai-model").addEventListener("change", () => localStorage.setItem("ai_model", $("ai-model").value));

  const savedThinking = localStorage.getItem("ai_thinking") === "true";
  $("ai-thinking").checked = savedThinking;
  $("ai-thinking").addEventListener("change", () =>
    localStorage.setItem("ai_thinking", $("ai-thinking").checked));

  // Collapsible sections
  document.querySelectorAll(".ai-section").forEach(section => {
    const sectionId = section.dataset.section;
    const header    = section.querySelector(".ai-section-header");

    // Restore collapsed state (upload + rules start collapsed by default)
    const stored = localStorage.getItem(`ai_collapsed_${sectionId}`);
    const defaultCollapsed = (sectionId === "upload" || sectionId === "rules");
    if (stored === "true" || (stored === null && defaultCollapsed)) {
      section.dataset.collapsed = "true";
    }

    header.addEventListener("click", e => {
      if (e.target.closest(".ai-section-header-actions")) return;
      const collapsed = section.dataset.collapsed === "true";
      section.dataset.collapsed = collapsed ? "false" : "true";
      localStorage.setItem(`ai_collapsed_${sectionId}`, !collapsed);
    });
  });

  // Document upload
  const uploadArea = $("ai-upload-area");
  const fileInput  = $("ai-file-input");
  uploadArea.addEventListener("click", () => fileInput.click());
  uploadArea.addEventListener("dragover", e => { e.preventDefault(); uploadArea.classList.add("drag-over"); });
  uploadArea.addEventListener("dragleave",  () => uploadArea.classList.remove("drag-over"));
  uploadArea.addEventListener("drop", e => {
    e.preventDefault();
    uploadArea.classList.remove("drag-over");
    handleAiFileUpload(e.dataTransfer.files);
  });
  fileInput.addEventListener("change", () => { handleAiFileUpload(fileInput.files); fileInput.value = ""; });

  // Pull from interested jobs
  $("ai-job-pull").addEventListener("change", function () {
    const id = this.value;
    if (!id) return;
    const job = allJobs.find(j => j.id === id);
    if (job) {
      const parts = [job.title, job.company, job.location, "", job.description || ""].filter(s => s !== undefined && s !== "");
      const text = parts.join("\n");
      $("ai-job-desc").value = text;
      localStorage.setItem("ai_jobDesc", text);
      currentAiJobId = id;
      updateAiJobBadge(id);
    }
    this.value = "";
  });

  // Generate + chat buttons
  $("btn-ai-generate").addEventListener("click", generateCoverLetter);
  $("btn-ai-save").addEventListener("click", saveCurrentCoverLetter);
  $("btn-ai-copy").addEventListener("click", copyAiResult);
  $("btn-ai-reset").addEventListener("click", resetAiOutput);
  $("btn-spell-check").addEventListener("click", runSpellCheck);
  $("btn-diff-accept-all").addEventListener("click", acceptAllDiffChunks);
  $("btn-diff-reject-all").addEventListener("click", rejectAllDiffChunks);
  $("btn-ai-chat-send").addEventListener("click", sendAiChat);
  $("ai-chat-input").addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendAiChat(); }
  });
}

function refreshAiJobDropdown() {
  const sel = $("ai-job-pull");
  if (!sel) return;
  const jobs = allJobs.filter(j => j.status === "interested");
  sel.innerHTML = '<option value="">Von Interessiert laden…</option>';
  jobs.forEach(j => {
    const opt = document.createElement("option");
    opt.value = j.id;
    opt.textContent = `${j.title}${j.company ? " – " + j.company : ""}`;
    sel.appendChild(opt);
  });
}

async function handleAiFileUpload(files) {
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/cover-letter/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.error) { showAiError(data.error); continue; }
      aiUploadedDocs.push({ filename: data.filename, text: data.text, chars: data.chars });
      renderAiUploadedDocs();
    } catch (e) {
      showAiError("Upload fehlgeschlagen: " + e.message);
    }
  }
}

function renderAiUploadedDocs() {
  const container = $("ai-uploaded-files");
  container.innerHTML = "";
  aiUploadedDocs.forEach((doc, i) => {
    const chip = document.createElement("div");
    chip.className = "ai-file-chip";
    chip.innerHTML = `
      <span class="ai-file-chip-name" title="${esc(doc.filename)}">📄 ${esc(doc.filename)}</span>
      <span class="ai-file-chip-meta">${(doc.chars || doc.text.length).toLocaleString()} Z.</span>
      <button class="ai-file-remove" data-idx="${i}" title="Entfernen">✕</button>`;
    chip.querySelector(".ai-file-remove").onclick = () => {
      aiUploadedDocs.splice(i, 1);
      renderAiUploadedDocs();
    };
    container.appendChild(chip);
  });
}

function buildAiMessages() {
  const role         = $("ai-role-prompt").value.trim();
  const myData       = $("ai-my-data").value.trim();
  const jobDesc      = $("ai-job-desc").value.trim();
  const instructions = $("ai-instructions").value.trim();
  const rules        = $("ai-rules").value.trim();
  const docTexts     = aiUploadedDocs.map(d => `[Dokument: ${d.filename}]\n${d.text}`).join("\n\n---\n\n");

  const parts = [];
  if (myData)       parts.push(`=== Meine Daten ===\n${myData}`);
  if (docTexts)     parts.push(`=== Hochgeladene Dokumente ===\n${docTexts}`);
  if (jobDesc)      parts.push(`=== Stellenausschreibung ===\n${jobDesc}`);
  if (instructions) parts.push(`=== Anweisungen für den Text ===\n${instructions}`);
  if (rules)        parts.push(`=== Generelle Vorgaben ===\n${rules}`);

  // Always request a German business-letter recipient block at the top.
  // The AI extracts the company name from the job ad; unknown address fields
  // stay as editable placeholders in square brackets.
  parts.push(
    "=== Briefkopf (Empfänger) ===\n" +
    "Beginne das Bewerbungsschreiben mit dem Empfänger-Briefkopf in genau diesem Format " +
    "(je Feld eine eigene Zeile, unbekannte Felder als eckige Platzhalter belassen):\n\n" +
    "[Firmenname]\n[Straße Hausnummer]\n[PLZ Stadt]\n\n" +
    "Extrahiere den Firmennamen aus der Stellenausschreibung. " +
    "Falls Straße oder PLZ/Stadt nicht bekannt sind, behalte die eckigen Platzhalter."
  );

  return {
    system: role || undefined,
    userContent: parts.join("\n\n---\n\n") || "Schreibe ein professionelles Bewerbungsschreiben.",
  };
}

async function generateCoverLetter() {
  if (aiGenerating) return;

  const { system, userContent } = buildAiMessages();
  aiSystemPrompt = system;
  aiChatHistory  = [{ role: "user", content: userContent }];

  const model    = $("ai-model").value;
  const thinking = $("ai-thinking").checked;

  // Update job label in result header
  updateAiJobBadge(currentAiJobId);

  // Show output panel, hide placeholder
  $("ai-output-placeholder").style.display = "none";
  $("ai-result-section").style.display     = "block";
  $("ai-token-info").style.display         = "none";
  $("ai-chat-section").style.display       = "none";
  $("ai-chat-history").innerHTML           = "";

  const resultEl = $("ai-result-text");
  resultEl.contentEditable = "false";
  resultEl.textContent = "";
  resultEl.classList.add("ai-cursor");
  $("ai-diff-toolbar").style.display = "none";

  const btn = $("btn-ai-generate");
  btn.disabled = true;
  btn.textContent = "⏳ Generiert…";
  aiGenerating = true;

  let generated = "";
  await streamAi(
    { system, messages: aiChatHistory, model, thinking },
    chunk => {
      generated += chunk;
      resultEl.textContent = generated;
      resultEl.scrollTop = resultEl.scrollHeight;
    },
    usage => {
      aiChatHistory.push({ role: "assistant", content: generated });
      resultEl.classList.remove("ai-cursor");
      resultEl.contentEditable = "true";
      showAiTokenInfo(usage, model);
      $("ai-chat-section").style.display = "flex";
      aiGenerating = false;
      btn.disabled = false;
      btn.textContent = "✨ Generieren";
    },
    err => {
      resultEl.classList.remove("ai-cursor");
      resultEl.contentEditable = "true";
      showAiError(err);
      aiGenerating = false;
      btn.disabled = false;
      btn.textContent = "✨ Generieren";
    }
  );
}

async function sendAiChat() {
  const input = $("ai-chat-input");
  const msg   = input.value.trim();
  if (!msg || aiGenerating) return;

  aiGenerating = true;
  aiChatHistory.push({ role: "user", content: msg });
  input.value = "";

  const model    = $("ai-model").value;
  const thinking = $("ai-thinking").checked;

  appendChatBubble("user", msg);

  const assistantDiv = appendChatBubble("assistant", "");
  const bubble = assistantDiv.querySelector(".ai-chat-bubble");
  bubble.classList.add("ai-cursor");

  const btn = $("btn-ai-chat-send");
  btn.disabled = true;

  const history = $("ai-chat-history");
  let generated = "";
  await streamAi(
    { system: aiSystemPrompt, messages: aiChatHistory, model, thinking },
    chunk => {
      generated += chunk;
      bubble.textContent = generated;
      history.scrollTop = history.scrollHeight;
    },
    usage => {
      aiChatHistory.push({ role: "assistant", content: generated });
      bubble.classList.remove("ai-cursor");
      updateAiTokenInfo(usage, model);
      aiGenerating = false;
      btn.disabled = false;
    },
    err => {
      bubble.classList.remove("ai-cursor");
      assistantDiv.remove();
      aiChatHistory.pop();
      showAiError(err);
      aiGenerating = false;
      btn.disabled = false;
    }
  );
}

function appendChatBubble(role, text) {
  const history = $("ai-chat-history");
  const div = document.createElement("div");
  div.className = `ai-chat-msg ai-chat-msg-${role}`;
  const bubble = document.createElement("div");
  bubble.className = "ai-chat-bubble";
  bubble.textContent = text;
  div.appendChild(bubble);
  history.appendChild(div);
  history.scrollTop = history.scrollHeight;
  return div;
}

async function streamAi({ system, messages, model, thinking }, onText, onDone, onError) {
  let res;
  try {
    res = await fetch("/api/cover-letter/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, messages, model, thinking }),
    });
  } catch (e) {
    onError("Netzwerkfehler: " + e.message);
    return;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    onError(err.error || `HTTP ${res.status}`);
    return;
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === "text")  { onText(data.text); }
          else if (data.type === "done")  { onDone(data.usage); return; }
          else if (data.type === "error") { onError(data.error); return; }
        } catch (_) {}
      }
    }
  } catch (e) {
    onError("Stream-Fehler: " + e.message);
  }
}

const AI_PRICING = {
  "claude-opus-4-8":   [5.0, 25.0],
  "claude-sonnet-4-6": [3.0, 15.0],
  "claude-haiku-4-5":  [1.0,  5.0],
};

function formatAiCost(usage, model) {
  const [inP, outP] = AI_PRICING[model] || [3.0, 15.0];
  const usd = usage.cost_usd ?? ((usage.input_tokens / 1e6) * inP + (usage.output_tokens / 1e6) * outP);
  const eur = usage.cost_eur ?? (usd * 0.92);
  return `
    <span title="Input-Token">↑ ${(usage.input_tokens || 0).toLocaleString()} Tok.</span>
    <span title="Output-Token">↓ ${(usage.output_tokens || 0).toLocaleString()} Tok.</span>
    <span class="ai-token-cost" title="Kosten USD">$${usd.toFixed(4)}</span>
    <span class="ai-token-cost" title="Kosten EUR">${eur.toFixed(4)}&nbsp;€</span>
  `;
}

function showAiTokenInfo(usage, model) {
  const el = $("ai-token-info");
  el.style.display = "flex";
  el.innerHTML = formatAiCost(usage, model);
}

function updateAiTokenInfo(usage, model) {
  const el = $("ai-token-info");
  if (el) { el.style.display = "flex"; el.innerHTML = formatAiCost(usage, model); }
}

function showAiError(msg) {
  const panel = $("ai-output-panel");
  const existing = panel.querySelector(".ai-error");
  if (existing) existing.remove();
  const div = document.createElement("div");
  div.className = "ai-error";
  div.textContent = "⚠ " + msg;
  panel.insertBefore(div, panel.firstChild);
  setTimeout(() => div.remove(), 7000);
}

function copyAiResult() {
  const text = $("ai-result-text").innerText;
  if (!text) return;
  const btn  = $("btn-ai-copy");
  const done = () => { btn.textContent = "✓ Kopiert"; setTimeout(() => { btn.textContent = "⧉ Kopieren"; }, 1600); };

  // Build HTML version so paragraphs survive pasting into Word / Outlook
  function textToHtml(t) {
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return t.split(/\n\n+/).map(para =>
      '<p>' + para.split('\n').map(esc).join('<br>') + '</p>'
    ).join('');
  }

  if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    const html = textToHtml(text);
    navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html':  new Blob([html],  { type: 'text/html'  }),
      })
    ]).then(done).catch(() => navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done)));
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function resetAiOutput() {
  aiChatHistory = [];
  aiSystemPrompt = "";
  $("ai-output-placeholder").style.display    = "flex";
  $("ai-result-section").style.display        = "none";
  $("ai-token-info").style.display            = "none";
  $("ai-chat-section").style.display          = "none";
  $("ai-diff-toolbar").style.display          = "none";
  const rt = $("ai-result-text");
  rt.textContent        = "";
  rt.contentEditable    = "false";
  $("ai-chat-history").innerHTML = "";
  $("ai-chat-input").value       = "";
}

// ---------------------------------------------------------------------------
// Spell-check with diff view
// ---------------------------------------------------------------------------

function tokenizeDiff(text) {
  // Split on whitespace runs (kept as tokens) to get word-level diff
  return text.split(/(\s+)/g).filter(t => t.length > 0);
}

function computeLcsDiff(oldText, newText) {
  const a = tokenizeDiff(oldText);
  const b = tokenizeDiff(newText);
  const m = a.length, n = b.length;

  // Guard: very large texts get a single-chunk fallback
  if (m + n > 5000) {
    return oldText === newText ? [{ type: 'unchanged', text: oldText }]
      : [{ type: 'changed', del: oldText, ins: newText }];
  }

  const dp = [];
  for (let i = 0; i <= m; i++) dp[i] = new Int32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1
                                    : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }

  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) { ops.unshift({t:'=', v:a[i-1]}); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.unshift({t:'+', v:b[j-1]}); j--; }
    else { ops.unshift({t:'-', v:a[i-1]}); i--; }
  }

  const segs = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === '=') {
      let text = '';
      while (k < ops.length && ops[k].t === '=') text += ops[k++].v;
      segs.push({ type: 'unchanged', text });
    } else {
      let del = '', ins = '';
      while (k < ops.length && ops[k].t !== '=') {
        if (ops[k].t === '-') del += ops[k].v; else ins += ops[k].v;
        k++;
      }
      segs.push({ type: 'changed', del, ins });
    }
  }
  return segs;
}

function showSpellDiff(originalText, correctedText) {
  const segs = computeLcsDiff(originalText, correctedText);
  const changes = segs.filter(s => s.type === 'changed');
  if (changes.length === 0) { showToast('Keine Fehler gefunden ✓'); return; }

  const resultEl = $('ai-result-text');
  resultEl.contentEditable = 'false';
  resultEl.innerHTML = '';

  for (const seg of segs) {
    if (seg.type === 'unchanged') {
      resultEl.appendChild(document.createTextNode(seg.text));
    } else {
      const chunk = document.createElement('span');
      chunk.className = 'diff-chunk';

      if (seg.del) {
        const del = document.createElement('del');
        del.className = 'diff-del';
        del.textContent = seg.del;
        chunk.appendChild(del);
      }
      if (seg.ins) {
        const ins = document.createElement('ins');
        ins.className = 'diff-ins';
        ins.textContent = seg.ins;
        chunk.appendChild(ins);
      }

      const actions = document.createElement('span');
      actions.className = 'diff-chunk-actions';

      const accept = document.createElement('button');
      accept.className = 'diff-btn diff-accept';
      accept.title = 'Übernehmen';
      accept.textContent = '✓';
      accept.addEventListener('click', () => {
        const ins = chunk.querySelector('.diff-ins');
        chunk.replaceWith(document.createTextNode(ins ? ins.textContent : ''));
        checkDiffDone();
      });

      const reject = document.createElement('button');
      reject.className = 'diff-btn diff-reject';
      reject.title = 'Behalten';
      reject.textContent = '✗';
      reject.addEventListener('click', () => {
        const del = chunk.querySelector('.diff-del');
        chunk.replaceWith(document.createTextNode(del ? del.textContent : ''));
        checkDiffDone();
      });

      actions.appendChild(accept);
      actions.appendChild(reject);
      chunk.appendChild(actions);
      resultEl.appendChild(chunk);
    }
  }

  const toolbar = $('ai-diff-toolbar');
  toolbar.style.display = 'flex';
  toolbar.querySelector('.diff-count').textContent =
    `${changes.length} Änderung${changes.length !== 1 ? 'en' : ''}`;
}

function checkDiffDone() {
  const remaining = $('ai-result-text').querySelectorAll('.diff-chunk').length;
  if (remaining === 0) {
    finishDiff();
  } else {
    $('ai-diff-toolbar').querySelector('.diff-count').textContent =
      `${remaining} Änderung${remaining !== 1 ? 'en' : ''} verbleibend`;
  }
}

function finishDiff() {
  const resultEl = $('ai-result-text');
  const text = resultEl.innerText;
  resultEl.textContent  = text;
  resultEl.contentEditable = 'true';
  $('ai-diff-toolbar').style.display = 'none';
  // Sync last assistant message in chat history
  if (aiChatHistory.length > 0 && aiChatHistory[aiChatHistory.length - 1].role === 'assistant') {
    aiChatHistory[aiChatHistory.length - 1].content = text;
  }
}

function acceptAllDiffChunks() {
  const resultEl = $('ai-result-text');
  Array.from(resultEl.querySelectorAll('.diff-chunk')).forEach(chunk => {
    const ins = chunk.querySelector('.diff-ins');
    chunk.replaceWith(document.createTextNode(ins ? ins.textContent : ''));
  });
  finishDiff();
}

function rejectAllDiffChunks() {
  const resultEl = $('ai-result-text');
  Array.from(resultEl.querySelectorAll('.diff-chunk')).forEach(chunk => {
    const del = chunk.querySelector('.diff-del');
    chunk.replaceWith(document.createTextNode(del ? del.textContent : ''));
  });
  finishDiff();
}

async function runSpellCheck() {
  const resultEl = $('ai-result-text');
  const originalText = resultEl.innerText.trim();
  if (!originalText || aiGenerating) return;

  const btn = $('btn-spell-check');
  btn.disabled = true;
  btn.textContent = '⏳ Prüfe…';

  const model = $('ai-model').value;
  const system = 'Du bist ein präziser Lektor. Korrigiere alle Rechtschreib- und Grammatikfehler im folgenden deutschen Text. Antworte NUR mit dem korrigierten Text — keine Kommentare, keine Erklärungen, keine Formatierungsänderungen.';
  const messages = [{ role: 'user', content: originalText }];

  let corrected = '';
  await streamAi(
    { system, messages, model, thinking: false },
    chunk => { corrected += chunk; },
    () => {
      btn.disabled = false;
      btn.textContent = '✓ Rechtschreibung';
      showSpellDiff(originalText, corrected.trim());
    },
    err => {
      btn.disabled = false;
      btn.textContent = '✓ Rechtschreibung';
      showAiError(err);
    }
  );
}

function showToast(msg, duration = 2500) {
  let toast = document.getElementById('ai-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ai-toast';
    toast.className = 'ai-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('ai-toast-show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('ai-toast-show'), duration);
}

function updateAiJobBadge(jobId) {
  const badge = $("ai-job-badge");
  if (!badge) return;
  if (!jobId) { badge.style.display = "none"; return; }
  const job = allJobs.find(j => j.id === jobId);
  badge.textContent = job ? `📌 ${job.title}${job.company ? " – " + job.company : ""}` : "📌 Stelle ausgewählt";
  badge.style.display = "inline-flex";

  const resultLabel = $("ai-result-job");
  if (resultLabel) resultLabel.textContent = job ? ` — ${job.title}${job.company ? ", " + job.company : ""}` : "";

  const topJob  = $("ai-top-job");
  const topText = $("ai-top-job-text");
  if (topJob && topText) {
    if (job) {
      topText.textContent = `${job.title}${job.company ? "  ·  " + job.company : ""}`;
      topJob.style.display = "block";
    } else {
      topJob.style.display = "none";
    }
  }
}

async function saveCurrentCoverLetter() {
  const content = $("ai-result-text").innerText.trim();
  if (!content) return;

  if (!currentAiJobId) {
    showAiError("Bitte zuerst eine Stelle auswählen (Dropdown oben).");
    return;
  }

  const btn = $("btn-ai-save");
  btn.disabled = true;
  btn.textContent = "Speichert…";

  try {
    await api(`/api/jobs/${currentAiJobId}/cover-letters`, {
      method: "POST",
      body: JSON.stringify({
        content,
        chat_history: aiChatHistory,
        model: $("ai-model").value,
        version_name: "",
      }),
    });
    btn.textContent = "✓ Gespeichert!";
    setTimeout(() => { btn.textContent = "💾 Speichern"; btn.disabled = false; }, 2500);
  } catch (e) {
    showAiError("Speicherfehler: " + e.message);
    btn.textContent = "💾 Speichern";
    btn.disabled = false;
  }
}

function goToAiCoverForJob(jobId) {
  const job = allJobs.find(j => j.id === jobId);
  if (!job) return;

  // Switch to AI-Bewerbung tab
  document.querySelectorAll("[data-view]").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $("btn-view-ai").classList.add("active");
  $("view-ai-cover").classList.add("active");
  currentView = "ai-cover";

  // Fill job description field
  const parts = [job.title, job.company, job.location, "", job.description || ""].filter((s, i) => i < 3 ? s : true);
  $("ai-job-desc").value = parts.join("\n");
  localStorage.setItem("ai_jobDesc", parts.join("\n"));

  // Set current job
  currentAiJobId = jobId;
  updateAiJobBadge(jobId);

  // Expand the job section
  const jobSection = document.querySelector('.ai-section[data-section="job"]');
  if (jobSection) { jobSection.dataset.collapsed = "false"; localStorage.setItem("ai_collapsed_job", "false"); }

  refreshAiJobDropdown();
}

// ── Job Detail Modal ──────────────────────────────────────────────────────────

async function openJobDetailModal(jobId) {
  const job = allJobs.find(j => j.id === jobId);
  if (!job) return;
  jdJobId = jobId;

  // Title & URL
  $("jd-title").textContent = job.title || "Kein Titel";
  const urlEl = $("jd-url");
  if (job.url) { urlEl.href = job.url; urlEl.style.visibility = "visible"; }
  else { urlEl.style.visibility = "hidden"; }

  // Meta
  const score = job.score ?? 0;
  const scoreClass = score >= 20 ? "score-high" : score >= 8 ? "score-mid" : "score-low";
  const parts = [
    job.company ? `<strong>${esc(job.company)}</strong>` : null,
    job.location ? esc(job.location) : null,
    job.source ? `<span class="src-badge src-${job.source}">${esc(job.source)}</span>` : null,
    `<span class="score-pill ${scoreClass}" style="font-size:12px;padding:1px 7px">${score}</span>`,
    job.published_date ? `Online ${formatDate(job.published_date)}` : null,
  ].filter(Boolean);
  $("jd-meta").innerHTML = parts.join('<span class="jd-meta-sep"> · </span>');

  // Status
  $("jd-status").value = job.status || "new";
  $("jd-status").onchange = async () => {
    const status = $("jd-status").value;
    await api(`/api/jobs/${jobId}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
    const j = allJobs.find(j2 => j2.id === jobId);
    if (j) { j.status = status; renderTable(); renderKanban(); }
  };

  // Dates
  $("jd-applied-date").value   = job.applied_date   || "";
  $("jd-interview-date").value = job.interview_date  || "";
  $("jd-rejected-date").value  = job.rejected_date   || "";
  [["jd-applied-date","applied_date"],["jd-interview-date","interview_date"],["jd-rejected-date","rejected_date"]]
    .forEach(([inputId, field]) => {
      $(inputId).onchange = async () => {
        const val = $(inputId).value;
        await api(`/api/jobs/${jobId}/dates`, { method: "PATCH", body: JSON.stringify({ [field]: val }) });
        const j = allJobs.find(j2 => j2.id === jobId);
        if (j) { j[field] = val; renderCalendar(); }
      };
    });

  // Keywords
  $("jd-keywords").innerHTML = renderKwTags(job.matched_soft);

  // Notes
  $("jd-notes").value = job.notes || "";
  $("btn-jd-save-notes").onclick = async () => {
    const notes = $("jd-notes").value;
    await api(`/api/jobs/${jobId}/notes`, { method: "PATCH", body: JSON.stringify({ notes }) });
    const j = allJobs.find(j2 => j2.id === jobId);
    if (j) j.notes = notes;
    const btn = $("btn-jd-save-notes");
    btn.textContent = "✓ Gespeichert";
    setTimeout(() => { btn.textContent = "Notizen speichern"; }, 2000);
  };

  // Description
  $("jd-description").textContent = job.description || "(keine Beschreibung gespeichert)";

  // Cover letters
  await loadJdCoverLetters(jobId);

  openModal("modal-job-detail");
}

async function loadJdCoverLetters(jobId) {
  const container = $("jd-cover-letters");
  const noClEl    = $("jd-no-cl");
  container.innerHTML = "";

  try {
    const cls = await api(`/api/jobs/${jobId}/cover-letters`);

    if (!cls.length) { noClEl.style.display = "block"; return; }
    noClEl.style.display = "none";

    const MODEL_LABEL = {
      "claude-opus-4-8":   "Opus 4.8",
      "claude-sonnet-4-6": "Sonnet 4.6",
      "claude-haiku-4-5":  "Haiku 4.5",
    };

    cls.forEach((cl, i) => {
      const card    = document.createElement("div");
      card.className = "cl-version-card";
      const preview  = (cl.content || "").slice(0, 180).replace(/\n+/g, " ").trim();
      const name     = esc(cl.version_name || `Version ${cls.length - i}`);
      const model    = esc(MODEL_LABEL[cl.model] || cl.model || "");
      const date     = formatDate((cl.created_at || "").slice(0, 10));

      card.innerHTML = `
        <div class="cl-version-header">
          <span class="cl-version-name">${name}</span>
          <button class="cl-delete-btn" title="Löschen" data-cl-id="${esc(cl.id)}">✕</button>
        </div>
        <div class="cl-version-meta">${date}${model ? " · " + model : ""}</div>
        <div class="cl-version-preview">${esc(preview)}${cl.content.length > 180 ? "…" : ""}</div>
        <div class="cl-version-actions">
          <button class="btn btn-ghost btn-sm" data-action="open-cl">In KI-Tab öffnen ↗</button>
        </div>`;

      card.querySelector(".cl-delete-btn").onclick = async () => {
        if (!confirm("Bewerbungsschreiben löschen?")) return;
        await api(`/api/cover-letters/${cl.id}`, { method: "DELETE" });
        await loadJdCoverLetters(jobId);
      };

      card.querySelector("[data-action='open-cl']").onclick = () => openCoverLetterInAiTab(cl, jobId);

      container.appendChild(card);
    });
  } catch (e) {
    container.innerHTML = `<div class="ai-error">Ladefehler: ${esc(e.message)}</div>`;
  }
}

function openCoverLetterInAiTab(cl, jobId) {
  // Switch to AI tab
  document.querySelectorAll("[data-view]").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $("btn-view-ai").classList.add("active");
  $("view-ai-cover").classList.add("active");
  currentView = "ai-cover";

  // Load result + history
  const rtEl = $("ai-result-text");
  rtEl.textContent      = cl.content || "";
  rtEl.contentEditable  = "true";
  $("ai-diff-toolbar").style.display = "none";
  aiChatHistory  = Array.isArray(cl.chat_history) ? cl.chat_history : [];
  aiSystemPrompt = $("ai-role-prompt").value.trim() || undefined;
  currentAiJobId = jobId;

  // Show panels
  $("ai-output-placeholder").style.display = "none";
  $("ai-result-section").style.display     = "block";
  $("ai-token-info").style.display         = "none";
  $("ai-chat-section").style.display       = "flex";
  $("ai-chat-history").innerHTML           = "";

  // Render chat messages beyond the initial generation pair
  for (let i = 2; i < aiChatHistory.length; i++) {
    appendChatBubble(aiChatHistory[i].role, aiChatHistory[i].content);
  }

  updateAiJobBadge(jobId);
  refreshAiJobDropdown();
  closeModal("modal-job-detail");
}
