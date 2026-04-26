// content.js
// CareerOS content script with login/logout + user picker.
const BACKEND_DEFAULT = "https://career-os.onrender.com";

let CO_USER_MAP = new Map(); // user_id -> { id, name }
let CO_ALL_USERS = []; // [{id, name}]
let CO_EXISTS_CACHE = new Map(); // user_id -> { exists, created_at, created_by, raw }
let _coGptMsgListener = null;

function canonicalizeUrl(input) {
  try {
    const u = new URL(input);
    u.hash = "";
    const params = new URLSearchParams(u.search);
    const sorted = new URLSearchParams();
    Array.from(params.keys())
      .sort()
      .forEach((k) => params.getAll(k).forEach((v) => sorted.append(k, v)));
    u.search = sorted.toString() ? "?" + sorted.toString() : "";
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch (e) {
    return (input || "").split("#")[0].replace(/\/$/, "");
  }
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[m],
  );
}

function isLikelyJobPage() {
  const url = location.href;
  if (/\/jobs\//i.test(url)) return true;
  if (/greenhouse\.io\/.*\/jobs\//i.test(url)) return true;
  if (/lever\.co\/.*\/(?:apply|jobs)/i.test(url)) return true;
  if (/workday\.com/i.test(url)) return true;
  const btn = Array.from(document.querySelectorAll("button,a")).find((el) => {
    const t = (el.textContent || "").trim().toLowerCase();
    return t === "apply" || t.includes("apply now");
  });
  return !!btn;
}

function b64ToBlobUrl(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type: mime });
  return URL.createObjectURL(blob);
}

function extractCreatedByName(existsData) {
  if (!existsData) return "";
  if (typeof existsData.created_by === "string" && existsData.created_by.trim())
    return existsData.created_by.trim();
  if (typeof existsData.createdBy === "string" && existsData.createdBy.trim())
    return existsData.createdBy.trim();
  if (
    existsData.application &&
    typeof existsData.application.created_by === "string" &&
    existsData.application.created_by.trim()
  ) {
    return existsData.application.created_by.trim();
  }
  if (
    existsData.application &&
    existsData.application.created_by &&
    existsData.application.created_by.name
  ) {
    return String(existsData.application.created_by.name);
  }
  return "";
}

function extractCreatedAt(existsData) {
  const a = existsData?.application || null;
  const raw = a?.created_at || existsData?.created_at || null;
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : "";
}

// ---- background proxied API ----
async function apiCall(path, { method = "GET", query, json, headers } = {}) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const resp = await chrome.runtime.sendMessage({
    type: "CO_API",
    payload: { path: p, method, query, json, headers },
  });
  if (!resp) return { ok: false, status: 0, data: null };
  return resp;
}

async function pushAuthToBackground({ token, backend }) {
  await chrome.runtime.sendMessage({
    type: "CO_SET_AUTH",
    payload: { token: token || "", backend: backend || "" },
  });
}

async function setAuthState({ token, principal, backend }) {
  const toSave = {
    authToken: token || "",
    principal: principal || null,
    backend: backend || BACKEND_DEFAULT,
  };
  await chrome.storage.local.set(toSave);
  await pushAuthToBackground({
    token: toSave.authToken,
    backend: toSave.backend,
  });
}

async function clearAuthState() {
  await chrome.storage.local.set({ authToken: "", principal: null });
  const { backend } = await chrome.storage.local.get(["backend"]);
  await pushAuthToBackground({
    token: "",
    backend: backend || BACKEND_DEFAULT,
  });
}

async function ensureLoggedIn() {
  const { authToken } = await chrome.storage.local.get(["authToken"]);
  return !!(authToken && String(authToken).trim());
}

// ---- shake FULL panel (card) reliably ----
function shakePanel(cardEl) {
  if (!cardEl) return;
  cardEl.classList.remove("co-card-shake");
  void cardEl.offsetWidth;
  cardEl.classList.add("co-card-shake");
  setTimeout(() => cardEl.classList.remove("co-card-shake"), 900);
}

// ---- user picker ----
async function setupUserPicker(root) {
  const listEl = root.querySelector("#co_user_list");
  const chipsEl = root.querySelector("#co_user_chips");
  const searchEl = root.querySelector("#co_user_search");
  const btnAll = root.querySelector("#co_user_select_all");
  const btnClear = root.querySelector("#co_user_clear");

  if (!listEl || !chipsEl || !searchEl || !btnAll || !btnClear) return;

  const saved = await chrome.storage.local.get(["userIds", "allUsersSelected"]);
  let selected = new Set(Array.isArray(saved.userIds) ? saved.userIds : []);
  let allMode = !!saved.allUsersSelected;

  function getSelectedIds() {
    if (allMode) return CO_ALL_USERS.map((u) => String(u.id));
    return Array.from(selected).filter(Boolean);
  }
  root.__coGetSelectedUserIds = getSelectedIds;

  async function saveSelected() {
    await chrome.storage.local.set({
      userIds: getSelectedIds(),
      allUsersSelected: allMode,
    });
  }

  function setAllModeOn() {
    allMode = true;
    selected = new Set(CO_ALL_USERS.map((u) => String(u.id)));
    saveSelected().catch(() => {});
    render();
    root.__coOnSelectionChange?.();
  }

  function clearAll() {
    allMode = false;
    selected = new Set();
    saveSelected().catch(() => {});
    render();
    root.__coOnSelectionChange?.();
  }

  function toggleUser(id) {
    id = String(id);
    if (allMode) allMode = false;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    saveSelected().catch(() => {});
    render();
    root.__coOnSelectionChange?.();
  }

  function removeChip(id) {
    id = String(id);
    if (allMode) allMode = false;
    selected.delete(id);
    saveSelected().catch(() => {});
    render();
    root.__coOnSelectionChange?.();
  }

  function renderChips() {
    const ids = getSelectedIds();
    chipsEl.innerHTML = "";

    if (!ids.length) {
      chipsEl.innerHTML = `<div class="co-muted">No users selected.</div>`;
      return;
    }

    if (allMode) {
      const chip = document.createElement("div");
      chip.className = "co-chip";
      chip.innerHTML = `All users <button class="co-chip-x" type="button" aria-label="Remove">×</button>`;
      chip.querySelector(".co-chip-x").addEventListener("click", clearAll);
      chipsEl.appendChild(chip);
      return;
    }

    ids.forEach((id) => {
      const u = CO_USER_MAP.get(String(id));
      const label = u?.name ? u.name : String(id);

      const chip = document.createElement("div");
      chip.className = "co-chip";
      chip.innerHTML = `${escapeHtml(
        label,
      )} <button class="co-chip-x" type="button" aria-label="Remove">×</button>`;
      chip
        .querySelector(".co-chip-x")
        .addEventListener("click", () => removeChip(id));
      chipsEl.appendChild(chip);
    });
  }

  function renderList() {
    const q = (searchEl.value || "").trim().toLowerCase();
    const filtered = !q
      ? CO_ALL_USERS
      : CO_ALL_USERS.filter(
          (u) =>
            (u.name || "").toLowerCase().includes(q) ||
            String(u.id).toLowerCase().includes(q),
        );

    listEl.innerHTML = "";

    if (!filtered.length) {
      listEl.innerHTML = `<div class="co-user-row"><div class="co-muted">No matching users.</div></div>`;
      return;
    }

    filtered.forEach((u) => {
      const id = String(u.id);
      const checked = allMode ? true : selected.has(id);

      const cache = CO_EXISTS_CACHE.get(id);
      const appliedText =
        cache && cache.exists
          ? `Applied${cache.created_at ? ` • ${cache.created_at}` : ""}${
              cache.created_by ? ` • by ${cache.created_by}` : ""
            }`
          : "";

      const row = document.createElement("div");
      row.className = "co-user-row";
      row.innerHTML = `
        <input class="co-user-checkbox" type="checkbox" ${
          checked ? "checked" : ""
        } />
        <div class="co-user-left">
          <div class="co-user-name">${escapeHtml(u.name || id)}</div>
          <div class="co-user-id" title="${escapeHtml(id)}">${escapeHtml(
            id,
          )}</div>
        </div>
        <div class="co-user-right-slot">
          ${
            appliedText
              ? `<div class="co-user-badge" title="${escapeHtml(
                  appliedText,
                )}">${escapeHtml(appliedText)}</div>`
              : ``
          }
        </div>
      `;

      const cb = row.querySelector("input");
      cb.addEventListener("change", () => toggleUser(id));

      row.addEventListener("click", (e) => {
        const tag = (e.target?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "button") return;
        toggleUser(id);
      });

      listEl.appendChild(row);
    });
  }

  function render() {
    renderChips();
    renderList();
  }

  try {
    const r = await apiCall("/v1/users");
    if (!r.ok) throw new Error("Failed to load users");

    const data = r.data;
    const items = Array.isArray(data) ? data : data.items || data.users || [];

    CO_USER_MAP = new Map();
    CO_ALL_USERS = items.map((u) => {
      const id = String(u.id || u.user_id || u);
      const name = u.name || "";
      const obj = { id, name };
      CO_USER_MAP.set(id, obj);
      return obj;
    });

    if (allMode) selected = new Set(CO_ALL_USERS.map((x) => String(x.id)));

    if (!allMode && selected.size === 0) {
      allMode = true;
      selected = new Set(CO_ALL_USERS.map((x) => String(x.id)));
      await saveSelected();
    }

    render();
  } catch (e) {
    CO_USER_MAP = new Map();
    CO_ALL_USERS = [];
    listEl.innerHTML = `<div class="co-user-row"><div class="co-muted">Cannot load users (check auth/backend).</div></div>`;
    renderChips();
  }

  btnAll.addEventListener("click", setAllModeOn);
  btnClear.addEventListener("click", clearAll);
  searchEl.addEventListener("input", renderList);

  root.__coRenderUserList = renderList;
}

// ---- EXISTS check -> updates right side badges ----
async function updateExistsForSelected(root, cardEl, jobUrl) {
  if (!(await ensureLoggedIn())) return;
  const url = (jobUrl || "").trim();
  if (!url) return;

  // const selected = root.__coGetSelectedUserIds?.() || [];
  const selected = CO_ALL_USERS.map((u) => String(u.id));
  if (!selected.length) return;

  const norm = canonicalizeUrl(url);

  const CONCURRENCY = 6;
  let idx = 0;

  async function worker() {
    const returns = [];
    while (idx < selected.length) {
      const uid = String(selected[idx++]);
      try {
        const r = await apiCall("/v1/applications/exists", {
          query: { user_id: uid, url: url },
        });
        if (!r.ok) continue;

        const data = r.data || {};
        const exists = !!data.exists;
        const created_at = exists ? extractCreatedAt(data) : "";
        const created_by = exists ? extractCreatedByName(data) : "";
        if (exists) {
          returns.push({ user_id: uid, created_at, created_by, raw: data });
        }

        CO_EXISTS_CACHE.set(uid, { exists, created_at, created_by, raw: data });
      } catch {
      } finally {
        root.__coRenderUserList?.();
      }
    }
    return returns;
  }

  const results = await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () =>
      worker(),
    ),
  );
  const pickerSelected = new Set(
    (root.__coGetSelectedUserIds?.() || []).map(String),
  );
  const anyApplied =
    pickerSelected.size > 0
      ? Array.from(pickerSelected).some(
          (uid) => CO_EXISTS_CACHE.get(uid)?.exists,
        )
      : false;
  const normUrl = canonicalizeUrl(url);
  if (anyApplied && root.__coShakenUrl !== normUrl) {
    root.__coShakenUrl = normUrl;
    shakePanel(cardEl);
  }

  return results;
}

// ---- main panel ----
(() => {
  const PANEL_ID = "careeros-panel-root";
  const STYLE_ID = "careeros-panel-style";

  const url = location.href.toLowerCase();
  const title = (document.title || "").toLowerCase();
  const jobHints = [
    "/jobs",
    "/job/",
    "/careers",
    "/career",
    "greenhouse",
    "lever.co",
    "indeed.com",
    "linkedin.com/jobs",
    "workday",
    "apply",
    "job description",
    "job posting",
  ];
  const looksLikeJobPage = jobHints.some(
    (h) => url.includes(h) || title.includes(h),
  );

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} { position: fixed; right: 16px; bottom: 10vh; z-index: 2147483647; font-family: Arial, sans-serif; }
      #${PANEL_ID} .co-launch { border:0; background:transparent; padding:0; cursor:pointer; }
      #${PANEL_ID} .co-launch-logo { height: 50px; width: 90px; display:block; }
      #${PANEL_ID} .co-card { width: 430px; max-height: 75vh; overflow: auto; margin-top: 10px;
        border-radius: 14px; background: #fff; box-shadow: 0 10px 30px rgba(0,0,0,.25);
        border: 1px solid rgba(0,0,0,.08); transform: translateZ(0); }
      #${PANEL_ID} .co-head { display:flex; align-items:center; justify-content:space-between; padding: 10px 12px; border-bottom: 1px solid #eee; }
      #${PANEL_ID} .co-title { font-weight: 900; font-size: 13px; display:flex; align-items:center; gap:8px; }
      #${PANEL_ID} .co-x { border:0; background: transparent; cursor:pointer; font-size: 18px; line-height: 1; padding: 2px 6px; }
      #${PANEL_ID} .co-body { padding: 10px 12px; }
      #${PANEL_ID} label { display:block; font-size: 12px; margin-top: 8px; color:#111; font-weight:900; }
      #${PANEL_ID} input, #${PANEL_ID} textarea, #${PANEL_ID} select {
        width:100%; box-sizing:border-box; margin-top: 4px; padding: 10px; border-radius: 12px;
        border: 1px solid #e5e7eb; font-size: 12px;
      }
      #${PANEL_ID} textarea { resize: vertical; }
      #${PANEL_ID} .co-action {
        margin-top: 10px; width:100%; padding: 10px; border:0; border-radius: 12px;
        cursor:pointer; background:#2563eb; color:#fff; font-weight:900;
      }
      #${PANEL_ID} .co-action:hover { background:#1e40af; }
      #${PANEL_ID} .co-action:active { background:#1e3a8a; }
      #${PANEL_ID} .co-action.secondary { background:#111; }
      #${PANEL_ID} .co-status { margin-top: 10px; font-size: 12px; white-space: pre-wrap; color:#111; }
      #${PANEL_ID} .co-muted { color:#6b7280; font-size: 11px; margin-top: 8px; }
      #${PANEL_ID} .co-divider { height:1px; background:#eee; margin:10px 0; }
      #${PANEL_ID} .co-pill { display:inline-block; font-size:11px; padding:3px 8px; border-radius:999px; background:#f3f4f6; color:#111; border:1px solid #e5e7eb; }

      /* user picker */
      #${PANEL_ID} .co-userpicker{ border:1px solid #e5e7eb; border-radius:12px; padding:10px; background:#fafafa; }
      #${PANEL_ID} .co-userpicker-top{ display:flex; gap:8px; align-items:center; }
      #${PANEL_ID} .co-user-search{ flex:1; margin-top:0 !important; background:#fff; }
      #${PANEL_ID} .co-user-ghost{
        border:1px solid #e5e7eb; background:#fff; border-radius:10px;
        padding:8px 10px; font-size:12px; cursor:pointer; font-weight:900; white-space:nowrap;
      }
      #${PANEL_ID} .co-user-ghost:hover{ background:#f3f4f6; }
      #${PANEL_ID} .co-user-chips{ display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
      #${PANEL_ID} .co-chip{
        display:inline-flex; align-items:center; gap:6px;
        padding:6px 9px; border-radius:999px;
        background:#fff; border:1px solid #e5e7eb;
        font-size:12px; font-weight:900;
      }
      #${PANEL_ID} .co-chip .co-chip-x{ border:0; background:transparent; cursor:pointer; font-size:14px; line-height:1; padding:0 2px; color:#6b7280; }

      #${PANEL_ID} .co-user-list{
        margin-top:10px;
        max-height:220px;
        overflow:auto;
        background:#fff;
        border:1px solid #e5e7eb;
        border-radius:12px;
      }
      #${PANEL_ID} .co-user-row{
        display:grid;
        grid-template-columns: 18px 1fr auto;
        gap:10px;
        align-items:center;
        padding:10px;
        border-bottom:1px solid #f1f5f9;
        cursor:pointer;
      }
      #${PANEL_ID} .co-user-row:hover{ background:#f8fafc; }
      #${PANEL_ID} .co-user-row:last-child{ border-bottom:0; }
      #${PANEL_ID} .co-user-checkbox{ width:16px; height:16px; }

      #${PANEL_ID} .co-user-left{ min-width:0; display:flex; flex-direction:column; gap:2px; }
      #${PANEL_ID} .co-user-name{ font-size:12px; font-weight:900; color:#111827; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #${PANEL_ID} .co-user-id{ font-size:11px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width: 240px; }
      #${PANEL_ID} .co-user-right-slot{ align-self:end; }
      #${PANEL_ID} .co-user-badge{ font-size:11px; font-weight:900; color:#991b1b; background: rgba(220,38,38,.08); border: 1px solid rgba(220,38,38,.22); padding:6px 8px; border-radius: 10px; white-space:nowrap; max-width: 200px; overflow:hidden; text-overflow:ellipsis; }

      @keyframes co-card-shake {
        0%,100%{ transform: translateX(0); }
        15%{ transform: translateX(-10px); }
        30%{ transform: translateX(10px); }
        45%{ transform: translateX(-8px); }
        60%{ transform: translateX(8px); }
        75%{ transform: translateX(-5px); }
        90%{ transform: translateX(5px); }
      }
      #${PANEL_ID} .co-card.co-card-shake{ animation: co-card-shake .55s ease-in-out 0s 2; }

      /* upload section */
      #${PANEL_ID} .co-section-toggle{
        margin-top:10px; width:100%; padding:8px 10px;
        border:1px solid #d1d5db; border-radius:10px;
        cursor:pointer; background:#f9fafb; color:#374151;
        font-weight:900; font-size:12px; text-align:left;
      }
      #${PANEL_ID} .co-section-toggle:hover{ background:#f3f4f6; }
      #${PANEL_ID} .co-upload-section{
        border:1px solid #bbf7d0; border-radius:12px;
        padding:10px; margin-top:6px; background:#f0fdf4;
      }
      #${PANEL_ID} .co-upload-section input[type="file"]{
        padding:6px; cursor:pointer;
      }
      #${PANEL_ID} .co-upload-ok{ color:#15803d; }
      #${PANEL_ID} .co-upload-err{ color:#dc2626; }
    `;
    document.documentElement.appendChild(style);
  }

  function buildPanel() {
    const root = document.createElement("div");
    root.id = PANEL_ID;
    root.innerHTML = `
      <button class="co-launch" type="button" aria-label="Open CareerOS">
        <img class="co-launch-logo" src="${chrome.runtime.getURL(
          !isLikelyJobPage() ? "assets/closed-logo.png" : "assets/logo.png",
        )}" alt="CareerOS"/>
      </button>

      <div class="co-card" style="display:none;">
        <div class="co-head">
          <div class="co-title">
            <img src="${chrome.runtime.getURL(
              "assets/logo.png",
            )}" alt="CareerOS" style="height:16px;width:auto;vertical-align:middle"/>
            <span>CareerOS</span>
            <span id="co_auth_pill" class="co-pill" style="display:none;"></span>
          </div>
          <button class="co-x" type="button" aria-label="Close">x</button>
        </div>

        <div class="co-body">
          <div id="co_auth_view">
            <label>Backend</label>
            <input id="co_backend" placeholder="http://127.0.0.1:8000" />
            <label>GPT URL</label>
            <input id="co_gpt_url" placeholder="https://chatgpt.com/g/..." />
            <div class="co-divider"></div>
            <label>Email</label>
            <input id="co_email" placeholder="you@example.com" autocomplete="username"/>
            <label>Password</label>
            <input id="co_password" type="password" placeholder="••••••••" autocomplete="current-password"/>
            <button class="co-action" id="co_login" type="button">Login</button>
            <div class="co-muted">Press Enter on email/password to login.</div>
            <div class="co-status" id="co_auth_status"></div>
          </div>

          <div id="co_app_view" style="display:none;">
            <button class="co-section-toggle" id="co_users_toggle" type="button">▾ Users</button>
            <div class="co-userpicker" id="co_userpicker">
              <div id="co_user_chips" class="co-user-chips"></div>
              <div id="co_users_expandable" style="display:none;">
                <div class="co-userpicker-top">
                  <input id="co_user_search" class="co-user-search" placeholder="Search users..." />
                  <button id="co_user_select_all" class="co-user-ghost" type="button">All users</button>
                  <button id="co_user_clear" class="co-user-ghost" type="button">Clear</button>
                </div>
                <div id="co_user_list" class="co-user-list"></div>
                <div class="co-muted" style="margin-top:6px;">Applied hint is on the right of the user ID line. Hover user id to see full id.</div>
              </div>
            </div>
            <label>Source site</label>
            <input id="co_source_site" placeholder="indeed" />
            <label>Job URL</label>
            <input id="co_url" />
            <label>Company</label>
            <input id="co_company" placeholder="Acme" />
            <label>Position</label>
            <input id="co_position" placeholder="Senior Software Engineer" />
            <label>Job Description (paste)</label>
            <textarea id="co_jd" placeholder="Paste full JD here..."></textarea>
            <label>Important Note (for GPT)</label>
            <input id="co_important_note" placeholder="e.g. Focus on Python skills, avoid mentioning X..." />
            <label>Resume JSON (GPT output) / (Cover Letter Input)</label>
            <textarea id="co_resume_json" placeholder="GPT-generated resume JSON will appear here..."></textarea>
            <label>Cover Letter (GPT output)</label>
            <textarea id="co_cover_letter" placeholder="GPT-generated cover letter will appear here..."></textarea>

            <label>Resume download</label>
            <div class="co-row" style="display:flex; gap:8px; align-items:center;">
              <select id="co_resume_format" style="flex:1;">
                <option value="docx">DOCX</option>
                <option value="pdf">PDF</option>
                <option value="both">DOCX + PDF</option>
              </select>
              <label style="display:flex; align-items:center; gap:6px; font-size:12px; margin-top:4px; white-space:nowrap;">
                <input id="co_close_gpt_tab" type="checkbox" style="width:auto; margin:0;" />
                Close GPT tab
              </label>
            </div>
            <div class="co-row" style="display:flex; gap:8px; align-items:center;">
              <button class="co-action" id="co_generate" type="button">Generate</button>
              <button class="co-action" id="co_gpt_gen" type="button" style="background:#7c3aed;">GPT Gen</button>
              <button class="co-action" id="co_gpt_cover_letter" type="button" style="background:#0891b2;">C Letter</button>
              <button class="co-action" id="co_save" type="button">Save</button>
            </div>
            <button class="co-action" id="co_fill_upload" type="button" style="background:#b45309;">Fill Upload Field</button>
            <div id="co_resume_picker" style="display:none; margin-top:4px; border:1px solid #b45309; border-radius:6px; padding:6px;">
              <div class="co-muted" style="margin-bottom:4px;">Select resume to fill:</div>
              <div id="co_resume_picker_list"></div>
              <button class="co-action secondary" id="co_resume_picker_cancel" type="button" style="margin-top:4px; width:100%;">Cancel</button>
            </div>

            <button class="co-section-toggle" id="co_upload_toggle" type="button">▾ Upload Tailored Resume</button>
            <div id="co_upload_section" class="co-upload-section" style="display:none;">
              <label>Application ID</label>
              <input id="co_upload_app_id" placeholder="Auto-filled after Generate / Save" />
              <label>Resume File (.pdf, .doc, .docx)</label>
              <input id="co_upload_file" type="file" accept=".pdf,.doc,.docx" />
              <button class="co-action" id="co_upload_btn" type="button" style="background:#059669;">Upload</button>
              <div class="co-status" id="co_upload_status"></div>
            </div>

            <div class="co-muted">First time: set base resume via backend PUT /v1/users/{user_id}/base-resume</div>
            <div class="co-status" id="co_status"></div>
            <button class="co-action secondary" id="co_logout" type="button">Logout</button>
          </div>
        </div>
      </div>
    `;
    return root;
  }

  async function refreshExistsInList(root, cardEl, els) {
    const jobUrl = (els.url?.value || "").trim();
    if (!jobUrl) return;
    const data = await updateExistsForSelected(root, cardEl, jobUrl);

    const selectedIds = new Set(
      (root.__coGetSelectedUserIds?.() || []).map(String),
    );
    const latest_application = data
      .flat()
      ?.filter((item) => selectedIds.has(String(item.user_id)))
      ?.sort((a, b) => {
        const atA = a.created_at || "";
        const atB = b.created_at || "";
        return new Date(atB) - new Date(atA);
      })[0]?.raw?.application;

    console.log("latest_application:", latest_application);
    if (!latest_application) return;
    els.company.value = latest_application?.company || "";
    els.position.value = latest_application?.role || "";
    els.source_site.value = latest_application?.source_site || "";
    els.jd.value = latest_application?.jd_text || "";
    if (latest_application?.id && els.upload_app_id) {
      els.upload_app_id.value = latest_application.id;
    }
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;
    ensureStyles();

    const root = buildPanel();
    document.documentElement.appendChild(root);

    const btn = root.querySelector(".co-launch");
    const card = root.querySelector(".co-card");
    const closeBtn = root.querySelector(".co-x");

    const authView = root.querySelector("#co_auth_view");
    const appView = root.querySelector("#co_app_view");
    const authPill = root.querySelector("#co_auth_pill");

    const authStatusEl = root.querySelector("#co_auth_status");
    const statusEl = root.querySelector("#co_status");

    const els = {
      backend: root.querySelector("#co_backend"),
      gpt_url: root.querySelector("#co_gpt_url"),
      email: root.querySelector("#co_email"),
      password: root.querySelector("#co_password"),
      login: root.querySelector("#co_login"),

      source_site: root.querySelector("#co_source_site"),

      url: root.querySelector("#co_url"),
      company: root.querySelector("#co_company"),
      position: root.querySelector("#co_position"),
      jd: root.querySelector("#co_jd"),
      important_note: root.querySelector("#co_important_note"),
      resume_json: root.querySelector("#co_resume_json"),
      cover_letter: root.querySelector("#co_cover_letter"),
      resume_format: root.querySelector("#co_resume_format"),
      close_gpt_tab: root.querySelector("#co_close_gpt_tab"),

      generate: root.querySelector("#co_generate"),
      gpt_gen: root.querySelector("#co_gpt_gen"),
      gpt_cover_letter: root.querySelector("#co_gpt_cover_letter"),
      save: root.querySelector("#co_save"),
      logout: root.querySelector("#co_logout"),
      fill_upload: root.querySelector("#co_fill_upload"),
      resume_picker: root.querySelector("#co_resume_picker"),
      resume_picker_list: root.querySelector("#co_resume_picker_list"),
      resume_picker_cancel: root.querySelector("#co_resume_picker_cancel"),

      users_toggle: root.querySelector("#co_users_toggle"),
      users_expandable: root.querySelector("#co_users_expandable"),

      upload_toggle: root.querySelector("#co_upload_toggle"),
      upload_section: root.querySelector("#co_upload_section"),
      upload_app_id: root.querySelector("#co_upload_app_id"),
      upload_file: root.querySelector("#co_upload_file"),
      upload_btn: root.querySelector("#co_upload_btn"),
      upload_status: root.querySelector("#co_upload_status"),
    };

    // Re-evaluate upload_app_id from cache whenever selection changes (no API call)
    root.__coOnSelectionChange = () => {
      if (!els.upload_app_id) return;
      const selectedIds = new Set(
        (root.__coGetSelectedUserIds?.() || []).map(String),
      );
      let latestAppId = "";
      let latestDate = "";
      for (const [uid, cache] of CO_EXISTS_CACHE) {
        if (!selectedIds.has(uid) || !cache.exists) continue;
        const appId = cache.raw?.application?.id;
        const createdAt =
          cache.raw?.application?.created_at || cache.created_at || "";
        if (!appId) continue;
        if (!latestDate || createdAt > latestDate) {
          latestDate = createdAt;
          latestAppId = String(appId);
        }
      }
      els.upload_app_id.value = latestAppId;
    };

    function setAuthStatus(msg) {
      authStatusEl.textContent = msg;
    }
    function setStatus(msg) {
      statusEl.textContent = msg;
    }
    function openCard() {
      card.style.display = "block";
    }
    function closeCard() {
      card.style.display = "none";
    }

    function showAuth(principal) {
      authView.style.display = "block";
      appView.style.display = "none";
      authPill.style.display = principal ? "inline-block" : "none";
      authPill.textContent = principal
        ? `${principal.type}: ${principal.name || ""}`
        : "";
      setStatus("");
    }
    function showApp(principal) {
      authView.style.display = "none";
      appView.style.display = "block";
      authPill.style.display = principal ? "inline-block" : "none";
      authPill.textContent = principal
        ? `${principal.type}: ${principal.name || ""}`
        : "";
      setAuthStatus("");
    }

    btn.addEventListener("click", () => {
      if (card.style.display === "none") {
        btn.innerHTML = `<img class="co-launch-logo" src="${chrome.runtime.getURL(
          "assets/logo.png",
        )}" />`;
        openCard();
      } else {
        btn.innerHTML = `<img class="co-launch-logo" src="${chrome.runtime.getURL(
          "assets/closed-logo.png",
        )}" />`;
        closeCard();
      }
    });
    closeBtn.addEventListener("click", closeCard);

    ["change", "blur"].forEach((ev) => {
      els.backend.addEventListener(ev, async () => {
        const backend = (els.backend.value || "").trim() || BACKEND_DEFAULT;
        await chrome.storage.local.set({ backend });
        const { authToken } = await chrome.storage.local.get(["authToken"]);
        await pushAuthToBackground({ token: authToken || "", backend });
      });
      els.gpt_url.addEventListener(ev, async () => {
        const gptUrl = (els.gpt_url.value || "").trim();
        await chrome.storage.local.set({ gptUrl });
      });
    });

    function handleEnterToLogin(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        els.login.click();
      }
    }
    els.email.addEventListener("keydown", handleEnterToLogin);
    els.password.addEventListener("keydown", handleEnterToLogin);

    async function saveAppSettings() {
      await chrome.storage.local.set({
        company: els.company.value.trim(),
        position: els.position.value.trim(),
        source_site: els.source_site.value.trim(),
        resume_format: (els.resume_format?.value || "docx").trim(),
        close_gpt_tab: !!els.close_gpt_tab?.checked,
      });
    }

    ["change", "blur"].forEach((ev) => {
      els.company.addEventListener(ev, saveAppSettings);
      els.position.addEventListener(ev, saveAppSettings);
      els.source_site.addEventListener(ev, saveAppSettings);
      els.resume_format?.addEventListener(ev, saveAppSettings);
    });
    els.close_gpt_tab?.addEventListener("change", saveAppSettings);

    els.url.addEventListener("blur", () => {
      refreshExistsInList(root, card, els).catch(() => {});
    });

    // LOGIN
    els.login.addEventListener("click", async () => {
      const backend = (els.backend.value || "").trim() || BACKEND_DEFAULT;
      const email = (els.email.value || "").trim();
      const password = els.password.value || "";

      if (!email || !password) {
        setAuthStatus("Email + password required.");
        return;
      }

      setAuthStatus("Logging in...");
      await chrome.storage.local.set({ backend });
      await pushAuthToBackground({ token: "", backend });

      try {
        const r = await apiCall("/v1/auth/login", {
          method: "POST",
          json: { email, password },
        });

        if (!r.ok) {
          setAuthStatus(
            `Login failed (${r.status}):\n${JSON.stringify(r.data, null, 2)}`,
          );
          return;
        }

        const data = r.data || {};
        if (!data.token) {
          setAuthStatus("Login succeeded but response missing token.");
          return;
        }

        await setAuthState({
          token: data.token,
          principal: data.principal || null,
          backend,
        });

        els.password.value = "";
        showApp(data.principal || null);

        await setupUserPicker(root);

        root.querySelector("#co_userpicker")?.addEventListener("click", () => {
          clearTimeout(root.__coCheckTimer);
          root.__coCheckTimer = setTimeout(
            () => refreshExistsInList(root, card, els).catch(() => {}),
            180,
          );
        });
        root.querySelector("#co_user_search")?.addEventListener("input", () => {
          clearTimeout(root.__coCheckTimer);
          root.__coCheckTimer = setTimeout(
            () => refreshExistsInList(root, card, els).catch(() => {}),
            260,
          );
        });

        els.url.value = location.href;

        await refreshExistsInList(root, card, els);

        setAuthStatus("✅ Logged in.");
      } catch (e) {
        setAuthStatus(`Login error:\n${String(e)}`);
      }
    });

    // LOGOUT
    els.logout.addEventListener("click", async () => {
      setStatus("Logging out...");
      try {
        await apiCall("/v1/auth/logout", { method: "POST" });
        await clearAuthState();
        CO_EXISTS_CACHE.clear();
        showAuth(null);
        setStatus("");
        setAuthStatus("✅ Logged out.");
      } catch (e) {
        await clearAuthState();
        CO_EXISTS_CACHE.clear();
        showAuth(null);
        setAuthStatus(
          `Logged out locally. (Error calling backend: ${String(e)})`,
        );
        setStatus("");
      }
    });

    // UPLOAD TOGGLE
    els.users_toggle?.addEventListener("click", () => {
      const visible = els.users_expandable.style.display !== "none";
      els.users_expandable.style.display = visible ? "none" : "block";
      els.users_toggle.textContent = visible ? "▾ Users" : "▴ Users";
    });

    els.upload_toggle?.addEventListener("click", () => {
      const visible = els.upload_section.style.display !== "none";
      els.upload_section.style.display = visible ? "none" : "block";
      els.upload_toggle.textContent = visible
        ? "▾ Upload Tailored Resume"
        : "▴ Upload Tailored Resume";
    });

    // UPLOAD TAILORED RESUME
    els.upload_btn?.addEventListener("click", async () => {
      const appId = (els.upload_app_id?.value || "").trim();
      const file = els.upload_file?.files?.[0];

      function setUploadStatus(msg, isErr = false) {
        if (!els.upload_status) return;
        els.upload_status.textContent = msg;
        els.upload_status.className =
          "co-status " + (isErr ? "co-upload-err" : "co-upload-ok");
      }

      const selectedForUpload = root.__coGetSelectedUserIds?.() || [];
      if (selectedForUpload.length > 1) {
        setUploadStatus(
          "Upload is not allowed for multiple users. Please select a single user.",
          true,
        );
        return;
      }

      if (!appId) {
        setUploadStatus("Application ID is required.", true);
        return;
      }
      if (!file) {
        setUploadStatus("Please select a file (.pdf, .doc, or .docx).", true);
        return;
      }

      const ext = file.name.split(".").pop().toLowerCase();
      if (!["pdf", "doc", "docx"].includes(ext)) {
        setUploadStatus("Only .pdf, .doc, or .docx files are accepted.", true);
        return;
      }

      setUploadStatus("Uploading...");
      els.upload_btn.disabled = true;

      try {
        const { authToken, backend } = await chrome.storage.local.get([
          "authToken",
          "backend",
        ]);
        const backendBase = (backend || BACKEND_DEFAULT)
          .trim()
          .replace(/\/$/, "");

        const formData = new FormData();
        formData.append("application_id", appId);
        formData.append("file", file);

        const res = await fetch(
          `${backendBase}/v1/ingest/upload-tailored-resume`,
          {
            method: "POST",
            headers: { "X-Auth-Token": authToken || "" },
            body: formData,
          },
        );

        const ct = (res.headers.get("content-type") || "").toLowerCase();
        const data = ct.includes("application/json")
          ? await res.json()
          : await res.text();

        if (res.ok) {
          setUploadStatus("✅ Resume uploaded successfully.");
          els.upload_file.value = "";
        } else {
          const detail =
            typeof data === "object"
              ? JSON.stringify(data, null, 2)
              : String(data);
          setUploadStatus(`Upload failed (${res.status}):\n${detail}`, true);
        }
      } catch (e) {
        setUploadStatus(`Upload error:\n${String(e)}`, true);
      } finally {
        els.upload_btn.disabled = false;
      }
    });

    const apply_and_generate = async ({
      selected,
      jobUrl,
      company,
      position,
      jdText,
      resumeJsonText,
      sourceSite,
      resumeFormat,
      wantCoverLetter,
      haveToGenerate = true,
    }) => {
      if (
        !selected.length ||
        !jobUrl ||
        !company ||
        !position ||
        jdText.length < 50
      ) {
        setStatus("Missing fields. JD must be at least ~50 chars.");
        return { ok: false };
      }

      setStatus("Preparing JD keys (cache-aware)...");
      await saveAppSettings();

      const mime =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      try {
        let okCount = 0;
        const failures = [];

        for (const uid of selected) {
          const name = CO_USER_MAP.get(String(uid))?.name || String(uid);
          setStatus(
            `${haveToGenerate ? "Generating" : "Saving"} for ${name}... (${okCount}/${selected.length})`,
          );

          const r = await apiCall("/v1/ingest/apply-and-generate", {
            method: "POST",
            json: {
              user_id: uid,
              url: jobUrl,
              company,
              position,
              source_site: sourceSite,
              jd_text: jdText,
              resume_json_text: resumeJsonText || "",
              include_cover_letter: wantCoverLetter,
              have_to_generate: haveToGenerate,
            },
          });

          if (!r.ok) {
            failures.push({ uid, status: r.status });
            continue;
          }

          if (!haveToGenerate) {
            // Auto-fill upload section with application_id from save response
            const savedData = r.data || {};
            const savedAppId =
              savedData.application_id || savedData.applicationId || "";
            if (savedAppId && els.upload_app_id && !els.upload_app_id.value) {
              els.upload_app_id.value = savedAppId;
            }
            okCount++;
            continue;
          }
          const data = r.data || {};
          const backendBase = (els.backend?.value || "" || BACKEND_DEFAULT)
            .trim()
            .replace(/\/$/, "");
          const appId = data.application_id || data.applicationId || "";
          const resumeFolder = `CareerOS/${uid}/${appId}`;

          // Auto-fill upload section with the latest application_id
          if (appId && els.upload_app_id && !els.upload_app_id.value) {
            els.upload_app_id.value = appId;
          }

          async function downloadHttpUrl(url, filename) {
            const resp = await chrome.runtime.sendMessage({
              type: "DOWNLOAD_BLOB_URL",
              payload: { url, filename, saveAs: true },
            });
            return !!resp?.ok;
          }

          let downloaded = false;

          const docxRel =
            data.resume_docx_download_url ||
            (data.resume_docx_file_id
              ? `/v1/files/${data.resume_docx_file_id}/download`
              : null);

          const pdfRel =
            data.resume_pdf_download_url ||
            (data.resume_pdf_file_id
              ? `/v1/files/${data.resume_pdf_file_id}/download`
              : null);

          const docxUrlAbs = docxRel
            ? docxRel.startsWith("http")
              ? docxRel
              : backendBase + docxRel
            : null;

          const pdfUrlAbs = pdfRel
            ? pdfRel.startsWith("http")
              ? pdfRel
              : backendBase + pdfRel
            : null;

          if (docxUrlAbs || pdfUrlAbs) {
            if (resumeFormat === "pdf") {
              if (pdfUrlAbs) {
                downloaded = await downloadHttpUrl(
                  pdfUrlAbs,
                  `${resumeFolder}/resume.pdf`,
                );
              } else if (docxUrlAbs) {
                downloaded = await downloadHttpUrl(
                  docxUrlAbs,
                  `${resumeFolder}/resume.docx`,
                );
              }
            } else if (resumeFormat === "both") {
              let ok1 = false;
              let ok2 = false;
              if (docxUrlAbs)
                ok1 = await downloadHttpUrl(
                  docxUrlAbs,
                  `${resumeFolder}/resume.docx`,
                );
              if (pdfUrlAbs)
                ok2 = await downloadHttpUrl(
                  pdfUrlAbs,
                  `${resumeFolder}/resume.pdf`,
                );
              downloaded = ok1 || ok2;
            } else {
              if (docxUrlAbs) {
                downloaded = await downloadHttpUrl(
                  docxUrlAbs,
                  `${resumeFolder}/resume.docx`,
                );
              } else if (pdfUrlAbs) {
                downloaded = await downloadHttpUrl(
                  pdfUrlAbs,
                  `${resumeFolder}/resume.pdf`,
                );
              }
            }

            if (!downloaded) {
              failures.push({ uid, status: "download_failed" });
              continue;
            }

            // ✅ Cover letter as DOCX (Option A) using background generator
            if (wantCoverLetter && data.cover_letter) {
              const clText = String(data.cover_letter || "").trim();
              console.log("Cover letter text:", clText);
              if (clText) {
                const companySafe = (company || "Company").replace(
                  /[<>:"/\\|?*]/g,
                  "_",
                );
                const positionSafe = (position || "Role").replace(
                  /[<>:"/\\|?*]/g,
                  "_",
                );
                const clName = `${resumeFolder}/Cover_Letter.docx`;

                const resp = await chrome.runtime.sendMessage({
                  type: "CO_DOWNLOAD_COVER_LETTER_DOCX",
                  payload: { text: clText, filename: clName, saveAs: true },
                });

                // optional fallback to txt if docx download fails
                if (!resp?.ok) {
                  const clBlob = new Blob([clText], { type: "text/plain" });
                  const clUrl = URL.createObjectURL(clBlob);
                  await downloadHttpUrl(
                    clUrl,
                    `${resumeFolder}/cover_letter.txt`,
                  );
                  setTimeout(() => URL.revokeObjectURL(clUrl), 30_000);
                }
              }
            }

            // Save resume info for "Fill Upload Field"
            const _fillUrl =
              resumeFormat === "pdf" && pdfUrlAbs
                ? pdfUrlAbs
                : docxUrlAbs || pdfUrlAbs;
            const _fillMime =
              _fillUrl === pdfUrlAbs && pdfUrlAbs
                ? "application/pdf"
                : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            const _fillExt = _fillMime === "application/pdf" ? "pdf" : "docx";
            await saveResumeEntry({
              label: `${position} @ ${company}`,
              url: _fillUrl,
              mime: _fillMime,
              filename: `resume.${_fillExt}`,
            });

            okCount++;
            continue;
          }

          if (data.resume_docx_base64) {
            const docxUrl = b64ToBlobUrl(data.resume_docx_base64, mime);
            const filename = `${resumeFolder}/resume.docx`;

            const ok = await downloadHttpUrl(docxUrl, filename);
            if (!ok) {
              failures.push({ uid, status: "download_failed" });
              continue;
            }

            // Save resume info for "Fill Upload Field" (base64 path — store b64 directly since blob URLs expire)
            await saveResumeEntry({
              label: `${position} @ ${company}`,
              b64: data.resume_docx_base64,
              mime,
              filename: "resume.docx",
            });

            okCount++;
            continue;
          }

          failures.push({ uid, status: "missing_files" });
        }

        if (failures.length) {
          setStatus(
            `✅ Done. ${haveToGenerate ? "Generated" : "Saved"} for ${okCount}/${selected.length} users.\nFailed: ${failures.length}`,
          );
        } else {
          setStatus(
            `✅ Done. ${haveToGenerate ? "Generated" : "Saved"} for ${okCount}/${selected.length} users.`,
          );
        }

        await refreshExistsInList(root, card, els);
        return { ok: failures.length === 0 };
      } catch (e) {
        setStatus(`Request failed:\n${String(e)}`);
        return { ok: false };
      }
    };
    // GENERATE
    els.generate.addEventListener("click", async () => {
      const selected = root.__coGetSelectedUserIds?.() || [];
      const jobUrl = (els.url.value || "").trim();
      const company = (els.company.value || "").trim();
      const position = (els.position.value || "").trim();
      const jdText = (els.jd.value || "").trim();
      const resumeJsonText = (els.resume_json?.value || "").trim();
      const sourceSite = (els.source_site.value || "").trim();
      const resumeFormat = (els.resume_format?.value || "docx").trim();

      await apply_and_generate({
        selected,
        jobUrl,
        company,
        position,
        jdText,
        resumeJsonText,
        wantCoverLetter: false,
        sourceSite,
        resumeFormat,
      });
    });

    els.save.addEventListener("click", async () => {
      const company = (els.company.value || "").trim();
      const position = (els.position.value || "").trim();
      const sourceSite = (els.source_site.value || "").trim();
      const jobUrl = (els.url.value || "").trim();
      const jdText = (els.jd.value || "").trim();
      const resumeJsonText = (els.resume_json?.value || "").trim();
      const resumeFormat = (els.resume_format?.value || "docx").trim();

      await apply_and_generate({
        selected: root.__coGetSelectedUserIds?.() || [],
        jobUrl,
        company,
        position,
        jdText,
        resumeJsonText,
        wantCoverLetter: false,
        sourceSite,
        resumeFormat,
        haveToGenerate: false,
      });
    });

    // GPT GEN
    els.gpt_gen?.addEventListener("click", async () => {
      const company = (els.company.value || "").trim();
      const position = (els.position.value || "").trim();
      const jd = (els.jd.value || "").trim();
      const note = (els.important_note?.value || "").trim();
      const jdWithNote =
        jd +
        (note
          ? `\nIMPORTANT:${note}`
          : "\nIMPORTANT:All required and nice-to-have skills should be reflected in the resume experience and skills sections.");

      const selectedForGpt = root.__coGetSelectedUserIds?.() || [];
      if (selectedForGpt.length > 1) {
        setStatus(
          "GPT Gen is not allowed for multiple users. Please select a single user.",
        );
        return;
      }

      if (!company || !position) {
        setStatus("Company and Position are required for GPT Gen.");
        return;
      }

      setStatus("Opening ChatGPT... waiting for GPT response.");
      els.gpt_gen.disabled = true;
      els.gpt_gen.textContent = "Waiting for GPT...";

      const resp = await chrome.runtime.sendMessage({
        type: "CO_GPT_OPEN",
        payload: {
          company,
          position,
          jd: jdWithNote,
          gptUrl: (els.gpt_url.value || "").trim(),
        },
      });

      if (!resp?.ok) {
        setStatus(`Failed to open ChatGPT: ${resp?.error || "Unknown error"}`);
        els.gpt_gen.disabled = false;
        els.gpt_gen.textContent = "GPT Gen";
      }
    });

    // Helper: save a resume entry to storage (keyed by label, max 20 entries)
    async function saveResumeEntry({ label, url, b64, mime, filename }) {
      const stored = await chrome.storage.local.get(["savedResumes"]);
      const list = Array.isArray(stored.savedResumes)
        ? stored.savedResumes
        : [];
      const filtered = list.filter((r) => r.label !== label); // replace if same label
      filtered.push({
        label,
        url: url || null,
        b64: b64 || null,
        mime,
        filename,
      });
      await chrome.storage.local.set({ savedResumes: filtered.slice(-20) });
    }

    // Helper: fetch bytes for a saved resume entry
    async function fetchResumeBytes(info) {
      if (info.b64) {
        const raw = atob(info.b64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return { bytes, mime: info.mime };
      }
      const resp = await chrome.runtime.sendMessage({
        type: "CO_FETCH_FILE",
        payload: { url: info.url },
      });
      if (!resp?.ok) throw new Error(resp?.error || "Fetch failed");
      const raw = atob(resp.b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return { bytes, mime: resp.contentType || info.mime };
    }

    // Helper: inject a resume File into the page's file input
    async function injectResumeToPage(info) {
      const fileInputs = Array.from(
        document.querySelectorAll('input[type="file"]'),
      );
      const target =
        fileInputs.find((el) => {
          const accept = (el.accept || "").toLowerCase();
          return !accept || /pdf|doc|docx|word|application/.test(accept);
        }) || fileInputs[0];

      if (!target) {
        setStatus("No file upload field found on this page.");
        return false;
      }

      els.fill_upload.disabled = true;
      els.fill_upload.textContent = "Filling...";

      let bytes, mime;
      try {
        ({ bytes, mime } = await fetchResumeBytes(info));
      } catch (e) {
        setStatus(`Failed to fetch resume: ${e.message}`);
        els.fill_upload.disabled = false;
        els.fill_upload.textContent = "Fill Upload Field";
        return false;
      }

      const file = new File([bytes], info.filename, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "files",
      ).set;
      nativeSetter.call(target, dt.files);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));

      setStatus(`✅ "${info.label}" injected into upload field.`);
      els.fill_upload.disabled = false;
      els.fill_upload.textContent = "Fill Upload Field";
      return true;
    }

    // FILL UPLOAD FIELD
    els.fill_upload?.addEventListener("click", async () => {
      // Hide picker if already open (toggle)
      if (els.resume_picker.style.display !== "none") {
        els.resume_picker.style.display = "none";
        return;
      }

      const stored = await chrome.storage.local.get(["savedResumes"]);
      const list = Array.isArray(stored.savedResumes)
        ? stored.savedResumes
        : [];

      if (!list.length) {
        setStatus("No saved resumes. Generate a resume first.");
        return;
      }

      if (list.length === 1) {
        await injectResumeToPage(list[0]);
        await chrome.storage.local.set({ savedResumes: [] });
        return;
      }

      // Multiple — show picker
      els.resume_picker_list.innerHTML = "";
      list.forEach((info, idx) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex; gap:4px; margin-bottom:4px;";

        const btn = document.createElement("button");
        btn.className = "co-action";
        btn.style.cssText = "flex:1; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;";
        btn.textContent = info.label;
        btn.title = info.label;
        btn.addEventListener("click", async () => {
          els.resume_picker.style.display = "none";
          const ok = await injectResumeToPage(info);
          if (ok) {
            const updated = list.filter((_, i) => i !== idx);
            await chrome.storage.local.set({ savedResumes: updated });
          }
        });

        const removeBtn = document.createElement("button");
        removeBtn.className = "co-action secondary";
        removeBtn.style.cssText = "flex:none; width:18px; height:18px; padding:0; font-size:11px; line-height:18px; text-align:center; align-self:center; min-width:unset;";
        removeBtn.textContent = "×";
        removeBtn.title = "Remove";
        removeBtn.addEventListener("click", async () => {
          const updated = list.filter((_, i) => i !== idx);
          await chrome.storage.local.set({ savedResumes: updated });
          row.remove();
          if (!els.resume_picker_list.children.length) {
            els.resume_picker.style.display = "none";
          }
        });

        row.appendChild(btn);
        row.appendChild(removeBtn);
        els.resume_picker_list.appendChild(row);
      });
      els.resume_picker.style.display = "";
    });

    els.resume_picker_cancel?.addEventListener("click", () => {
      els.resume_picker.style.display = "none";
    });

    // COVER LETTER
    els.gpt_cover_letter?.addEventListener("click", async () => {
      const company = (els.company.value || "").trim();
      const position = (els.position.value || "").trim();
      const jd = (els.jd.value || "").trim();
      const resumeJson = (els.resume_json.value || "").trim();

      if (!company || !position) {
        setStatus("Company and Position are required for Cover Letter.");
        return;
      }
      if (!resumeJson) {
        setStatus(
          "Resume JSON is required for Cover Letter. Run GPT Gen first.",
        );
        return;
      }

      const coverLetterPrompt =
        `Write a cover letter for the position of ${position} in ${company}, which begins with a powerful idea instead of 'I'm applying for...'\n` +
        `It connects my specific experience to the company's exact needs and builds trust. Keep the text below 200 words. My experience:${resumeJson}. Job description:${jd}`;

      setStatus("Opening ChatGPT... waiting for cover letter response.");
      els.gpt_cover_letter.disabled = true;
      els.gpt_cover_letter.textContent = "Waiting for GPT...";

      const gptUrl = (els.gpt_url.value || "").trim();
      const resp = await chrome.runtime.sendMessage({
        type: "CO_GPT_OPEN",
        payload: {
          company,
          position,
          jd,
          gptUrl,
          prompt: coverLetterPrompt,
          mode: "cover_letter",
        },
      });

      if (!resp?.ok) {
        setStatus(`Failed to open ChatGPT: ${resp?.error || "Unknown error"}`);
        els.gpt_cover_letter.disabled = false;
        els.gpt_cover_letter.textContent = "C Letter";
      }
    });

    // Listener for GPT response relayed from background.js
    const _coGptMessageListener = (msg) => {
      if (!msg || msg.type !== "CO_GPT_RESULT") return false;

      const mode = msg.mode || "resume";

      // Automation modes are handled by remotive.js (on detail page)
      // or by the standalone automation autofill module (on external boards).
      if (
        mode === "automation_resume" ||
        mode === "automation_cover_letter" ||
        mode === "qa"
      ) {
        return false;
      }

      if (mode === "cover_letter") {
        els.gpt_cover_letter.disabled = false;
        els.gpt_cover_letter.textContent = "C Letter";
        if (msg.error) {
          setStatus(`GPT error: ${msg.error}`);
          return false;
        }
        const text = (msg.text || "").trim();
        if (!text) {
          setStatus("GPT returned empty cover letter.");
          return false;
        }
        els.cover_letter.value = text;
        setStatus("Cover letter generated.");
        return false;
      }

      els.gpt_gen.disabled = false;
      els.gpt_gen.textContent = "GPT Gen";

      if (msg.error) {
        setStatus(`GPT error: ${msg.error}`);
        return false;
      }

      const text = (msg.text || "").trim();
      if (!text) {
        setStatus("GPT returned empty response.");
        return false;
      }

      els.resume_json.value = text;

      // Parse GPT JSON and check blocked flag
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (_) {}

      if (parsed?.blocked) {
        const reason = parsed.block_reason || "No reason provided.";
        setStatus(`⛔ You shouldn't apply to this job because of: ${reason}`);
        return false;
      }

      setStatus("GPT response received. Generating resume...");

      const selected = root.__coGetSelectedUserIds?.() || [];
      const jobUrl = (els.url.value || "").trim();
      const company = (els.company.value || "").trim();
      const position = (els.position.value || "").trim();
      const jdText = (els.jd.value || "").trim();
      const sourceSite = (els.source_site.value || "").trim();
      const resumeFormat = (els.resume_format?.value || "docx").trim();

      apply_and_generate({
        selected,
        jobUrl,
        company,
        position,
        jdText,
        resumeJsonText: text,
        wantCoverLetter: false,
        sourceSite,
        resumeFormat,
      }).then((result) => {
        if (!result?.ok) {
          const current = (statusEl.textContent || "").trim();
          setStatus(
            `${current}\n💡 Resume JSON is saved in the textarea — click Generate to retry without re-running GPT.`,
          );
        }
      });

      return false;
    };

    if (_coGptMsgListener) {
      chrome.runtime.onMessage.removeListener(_coGptMsgListener);
    }
    _coGptMsgListener = _coGptMessageListener;
    chrome.runtime.onMessage.addListener(_coGptMsgListener);

    (async () => {
      const data = await chrome.storage.local.get([
        "backend",
        "gptUrl",
        "authToken",
        "principal",
        "company",
        "position",
        "source_site",
        "resume_format",
        "close_gpt_tab",
      ]);

      els.backend.value = data.backend || BACKEND_DEFAULT;
      els.gpt_url.value = data.gptUrl || "";
      els.company.value = data.company || "";
      els.position.value = data.position || "";
      els.source_site.value = data.source_site || "";
      if (els.resume_format)
        els.resume_format.value = data.resume_format || "docx";
      if (els.close_gpt_tab) els.close_gpt_tab.checked = !!data.close_gpt_tab;
      els.url.value = location.href;

      await pushAuthToBackground({
        token: data.authToken || "",
        backend: els.backend.value,
      });

      const isLoggedIn = !!(data.authToken && String(data.authToken).trim());
      if (!isLoggedIn) {
        showAuth(null);
      } else {
        showApp(data.principal || null);
        await setupUserPicker(root);

        root.querySelector("#co_userpicker")?.addEventListener("click", () => {
          clearTimeout(root.__coCheckTimer);
          root.__coCheckTimer = setTimeout(
            () => refreshExistsInList(root, card, els).catch(() => {}),
            180,
          );
        });
        root.querySelector("#co_user_search")?.addEventListener("input", () => {
          clearTimeout(root.__coCheckTimer);
          root.__coCheckTimer = setTimeout(
            () => refreshExistsInList(root, card, els).catch(() => {}),
            260,
          );
        });

        await refreshExistsInList(root, card, els);
      }

      if (looksLikeJobPage) {
        card.style.display = "block";
        btn.innerHTML = `<img class="co-launch-logo" src="${chrome.runtime.getURL(
          "assets/logo.png",
        )}" />`;
      }
    })().catch(() => {});
  }

  const observer = new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID)) mountPanel();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  mountPanel();
})();

// ============================================================
// Automation autofill — runs on external job boards
// ============================================================
(async function coAutomationAutofill() {
  "use strict";

  // Only run in the top frame — content.js is injected with all_frames: true
  const isTopFrame = (() => {
    try {
      return window.top === window;
    } catch (_) {
      return false;
    }
  })();

  const isEmbeddedGreenhouseFrame =
    /greenhouse\.io|job-boards\.greenhouse/.test(location.hostname) &&
    /\/(?:embed\/)?job_app\b/i.test(location.pathname + location.search);

  const isEmbeddedAdpFrame =
    location.hostname.includes("workforcenow.adp.com") &&
    /recruitment\.html\b/i.test(location.pathname + location.search);

  if (!isTopFrame && !isEmbeddedGreenhouseFrame && !isEmbeddedAdpFrame) return;

  if (location.hostname.includes("remotive.com")) return;

  if (
    isTopFrame &&
    document.querySelector(
      'iframe[src*="job-boards.greenhouse.io/embed/job_app"], iframe[src*="greenhouse.io/embed/job_app"]',
    )
  ) {
    console.log("[CareerOS] Embedded Greenhouse iframe detected; waiting for iframe automation.");
    return;
  }

  if (
    isTopFrame &&
    !isEmbeddedAdpFrame &&
    document.querySelector(
      'iframe[src*="workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html"], iframe[src*="recruitment/recruitment.html"]',
    )
  ) {
    console.log("[CareerOS] Embedded ADP iframe detected; waiting for iframe automation.");
    return;
  }

  // Per-page execution lock to prevent duplicate runs (SPA re-injection, etc.)
  if (window.__co_autofill_running) return;
  window.__co_autofill_running = true;

  // One-shot guard so AUTOMATION_NEXT can only fire once per page load
  let __co_next_sent = false;
  async function sendNext(payload) {
    if (__co_next_sent) return;
    __co_next_sent = true;
    // Retry up to 3 times — Manifest V3 service worker may be dormant
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await chrome.runtime.sendMessage({ type: "AUTOMATION_NEXT", payload });
        return;
      } catch (_) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // SAFETY TIMEOUT: ensure automation ALWAYS advances, even if the code stalls
  // or encounters an unhandled edge case (iframe-only forms, unexpected page state, etc.)
  const __co_safety_timer = setTimeout(() => {
    if (!__co_next_sent) {
      console.warn("[CareerOS] Safety timeout — forcing AUTOMATION_NEXT (manual)");
      sendNext({ status: "manual", reason: "safety timeout" });
    }
  }, 90_000); // 90 seconds max per external ATS page

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function isPanel(el) { return !!el.closest("#careeros-panel-root"); }
  function isVis(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    // offsetParent is null for fixed/sticky elements, <dialog>, and <body>/<html>
    // — check position and dialog ancestry before concluding hidden
    if (el.offsetParent === null) {
      if (s.position === "fixed" || s.position === "sticky") return true;
      if (el.closest("dialog[open]")) return true;
      if (el.tagName === "BODY" || el.tagName === "HTML") return true;
      return false;
    }
    return true;
  }

  // ---- Shadow DOM helpers ----
  function queryShadowAll(root, selector) {
    const results = Array.from(root.querySelectorAll?.(selector) || []);
    for (const el of (root.querySelectorAll?.("*") || [])) {
      if (el.shadowRoot) results.push(...queryShadowAll(el.shadowRoot, selector));
    }
    return results;
  }

  // ---- Shared helpers ----

  function nativeFill(el, value) {
    if (!value && value !== 0) return;
    const tag = el.tagName;
    const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype
                : tag === "SELECT"   ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Set a <select> by matching option text (case-insensitive partial match)
  function selectByText(el, text) {
    const t = String(text).toLowerCase().trim();
    const opt = Array.from(el.options).find(o =>
      o.text.toLowerCase().includes(t) || o.value.toLowerCase().includes(t)
    );
    if (opt) { nativeFill(el, opt.value); return true; }
    return false;
  }

  // Click a radio/checkbox by matching its label text
  function clickRadioByText(name, text) {
    const t = String(text).toLowerCase().trim();
    const inputs = Array.from(document.querySelectorAll(`input[type="radio"][name="${name}"], input[type="checkbox"][name="${name}"]`));
    const target = inputs.find(inp => {
      const lbl = document.querySelector(`label[for="${inp.id}"]`);
      const lblText = (lbl?.textContent || inp.value || "").toLowerCase();
      return lblText.includes(t);
    });
    if (target && !target.checked) { target.click(); return true; }
    return false;
  }

  // Rippling custom-select fill: open dropdown, type to filter, click matching option
  function waitForOptions(timeoutMs = 3000) {
    return new Promise(resolve => {
      const check = () => {
        const opts = Array.from(document.querySelectorAll('[role="option"]'));
        if (opts.length) return opts;
        return null;
      };
      const found = check();
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const opts = check();
        if (opts) { obs.disconnect(); clearTimeout(timer); resolve(opts); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => { obs.disconnect(); resolve([]); }, timeoutMs);
    });
  }

  function fireClick(el) {
    el.dispatchEvent(new PointerEvent("pointerover",  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseenter",     { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerdown",  { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mousedown",      { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new PointerEvent("pointerup",    { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mouseup",        { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("click",          { bubbles: true, cancelable: true, view: window }));
  }

  async function ripplingWaitClosed(timeoutMs = 1500) {
    const t = Date.now();
    while (Date.now() - t < timeoutMs) {
      if (!document.querySelector('[role="option"]')) return true;
      await sleep(80);
    }
    return false;
  }

  async function ripplingOpenDropdown(controller) {
    // Close any stale open dropdown first
    if (document.querySelector('[role="option"]')) {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      document.body.click();
      await ripplingWaitClosed(1000);
    }

    const searchInput = controller.querySelector('input[data-testid="input-select-search-input"]');
    const combobox = controller.querySelector('[role="combobox"]');

    if (searchInput && isVis(searchInput)) {
      fireClick(searchInput);
      searchInput.focus();
    } else if (combobox) {
      combobox.focus();
      await sleep(50);
      fireClick(combobox);
    }
  }

  async function ripplingSelectFill(controller, answer) {
    if (!controller || !answer) return;
    const t = answer.toLowerCase().trim();

    for (let attempt = 0; attempt < 3; attempt++) {
      await ripplingOpenDropdown(controller);

      const opts = await waitForOptions(3000);
      if (!opts.length) {
        console.warn("[CareerOS] No options appeared for answer:", answer);
        return;
      }

      const match =
        opts.find(o => o.textContent.trim().toLowerCase() === t) ||
        opts.find(o => o.textContent.trim().toLowerCase().includes(t)) ||
        opts.find(o => t.includes(o.textContent.trim().toLowerCase()));

      if (!match) {
        console.warn("[CareerOS] No option matched:", answer, "| available:", opts.map(o => o.textContent.trim()));
        document.body.click();
        return;
      }

      // Click the option — try the element and its text child
      fireClick(match);
      const inner = match.querySelector("p,span") || match.firstElementChild;
      if (inner) fireClick(inner);

      // Verify: dropdown should close after selection
      const closed = await ripplingWaitClosed(1000);
      if (closed) {
        console.log(`[CareerOS] Selected "${match.textContent.trim()}" for answer "${answer}" (attempt ${attempt + 1})`);
        return;
      }

      console.warn(`[CareerOS] Dropdown still open after attempt ${attempt + 1}, retrying...`);
      // Escape to close before retry
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      await ripplingWaitClosed(800);
    }
  }

  async function fetchResumeBytes(fileInfo) {
    const resp = await chrome.runtime.sendMessage({ type: "CO_FETCH_FILE", payload: { url: fileInfo.url } });
    if (!resp?.ok) throw new Error(resp?.error || "Fetch failed");
    const raw = atob(resp.b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { bytes, mime: resp.contentType || fileInfo.mime };
  }

  async function injectFileIntoInput(input, fileInfo) {
    const { bytes, mime } = await fetchResumeBytes(fileInfo);
    const file = new File([bytes], fileInfo.filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set;
    setter.call(input, dt.files);
    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function waitForGptResult(mode, timeoutMs = 240000) {
    return new Promise(resolve => {
      const listener = msg => {
        if (!msg || msg.type !== "CO_GPT_RESULT" || msg.mode !== mode) return false;
        chrome.runtime.onMessage.removeListener(listener);
        clearTimeout(timer);
        resolve(msg);
        return false;
      };
      chrome.runtime.onMessage.addListener(listener);
      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ timeout: true });
      }, timeoutMs);
    });
  }

  async function askGpt(ctx, prompt, mode) {
    const resultPromise = waitForGptResult(mode);
    let resp = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      resp = await chrome.runtime.sendMessage({
        type: "CO_GPT_OPEN",
        payload: { company: ctx.company, position: ctx.position, jd: "", gptUrl: ctx.conversationUrl, prompt, mode, autoClose: true },
      });
      if (resp?.ok) break;
      if (resp?.error === "GPT already in progress") {
        await sleep(2000);
        continue;
      }
      break;
    }
    if (!resp?.ok) return null;
    const result = await resultPromise;
    if (result.timeout || result.error) return null;
    return (result.text || "").trim();
  }

  function parseQaResponse(text, count) {
    const answers = [];
    for (let i = 1; i <= count; i++) {
      const re = new RegExp(`A${i}:\\s*([\\s\\S]*?)(?=A${i + 1}:|$)`, "i");
      const m = text.match(re);
      answers.push(m ? m[1].trim() : "");
    }
    return answers;
  }

  async function waitForFormSignals(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const visibleFields = Array.from(
        document.querySelectorAll(
          'input:not([type="hidden"]), textarea, select, button[type="submit"], input[type="file"]',
        ),
      ).filter((el) => !isPanel(el) && isVis(el));
      if (visibleFields.length) return true;
      await sleep(500);
    }
    return false;
  }

  function hasVisibleApplicationSignals() {
    const visibleResumeInput = Array.from(document.querySelectorAll('input[type="file"]'))
      .some((el) => !isPanel(el) && isVis(el));

    if (visibleResumeInput) return true;

    const visibleQuestionFields = Array.from(
      document.querySelectorAll('textarea, select, input[type="tel"], input[type="url"], input[type="number"]'),
    ).some((el) => !isPanel(el) && isVis(el));

    if (visibleQuestionFields) return true;

    const visibleAppTextInputs = Array.from(
      document.querySelectorAll('input[type="text"], input[type="email"]'),
    ).filter((el) => !isPanel(el) && isVis(el));

    if (visibleAppTextInputs.some((el) => !isLikelyNonApplicationField(el))) return true;

    const actionBtn = findVisibleButtonByText(
      /\b(apply|submit application|continue application|continue to application|review application|save and continue)\b/,
    );
    return !!actionBtn;
  }

  function isLikelyLoginPage() {
    const hasApplicationSignals = hasVisibleApplicationSignals();
    const hasPassword = !!document.querySelector('input[type="password"]');
    if (hasPassword && !hasApplicationSignals) return true;

    const hasLoginInputs =
      !!document.querySelector(
        'input[name*="user" i], input[name*="login" i], input[name*="sign" i], input[autocomplete="username"], input[autocomplete="current-password"]',
      );
    const hasAuthButtons =
      !!findVisibleButtonByText(/\bsign in\b|\blog in\b|\bcontinue with email\b|\bcreate account\b/);
    if (hasLoginInputs && hasAuthButtons && !hasApplicationSignals) return true;

    const text = (document.body?.innerText || "").toLowerCase();
    return (
      !hasApplicationSignals &&
      (text.includes("sign in") || text.includes("log in") || text.includes("login")) &&
      (text.includes("password") || text.includes("email") || text.includes("username"))
    );
  }

  function findVisibleButtonByText(pattern) {
    return Array.from(document.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit']"))
      .find((el) => {
        if (isPanel(el) || !isVis(el)) return false;
        if (el.disabled || el.getAttribute("aria-disabled") === "true" || el.getAttribute("data-disabled") === "true") return false;
        const text = (
          el.textContent ||
          el.value ||
          el.getAttribute("aria-label") ||
          ""
        )
          .trim()
          .toLowerCase();
        return pattern.test(text);
      }) || null;
  }

  function findPrimaryActionButton() {
    const submitBtn = Array.from(document.querySelectorAll(
      'button[type="submit"], button[data-testid="Apply"], input[type="submit"]',
    )).find(b => !b.disabled && b.getAttribute("data-disabled") !== "true" && !isPanel(b) && isVis(b));
    if (submitBtn) return { button: submitBtn, kind: "submit" };

    const nextBtn = findVisibleButtonByText(
      /\b(next|continue|review|continue application|continue to application|submit application|apply)\b/,
    );
    if (nextBtn) return { button: nextBtn, kind: "progress" };

    return { button: null, kind: "none" };
  }

  function isLikelyNonApplicationField(el, labelText = "") {
    const text = [
      labelText,
      el?.name || "",
      el?.id || "",
      el?.placeholder || "",
      el?.getAttribute?.("aria-label") || "",
    ]
      .join(" ")
      .trim()
      .toLowerCase();

    if (!text) return false;
    if (/\b(search|newsletter|coupon|discount|promo|gift card|giftcard|quantity|qty|cart)\b/.test(text)) {
      return true;
    }

    const container = el.closest?.("header, footer, nav, [role='search'], #SearchModal, #CartDrawer, [id*='cart'], [class*='cart'], [class*='search'], [class*='newsletter']");
    return !!container;
  }

  function findExternalApplicationUrl() {
    const pageText = (document.body?.innerText || "").trim();
    if (!pageText) return "";

    const hasApplyCue = /\b(how to apply|applying process|application form|fill in this form|questionnaire|apply here)\b/i.test(pageText);
    if (!hasApplyCue) return "";

    const textUrls = pageText.match(/https?:\/\/[^\s<>"')]+/gi) || [];
    const anchorUrls = Array.from(document.querySelectorAll("a[href]"))
      .map((el) => el.href)
      .filter(Boolean);

    return [...textUrls, ...anchorUrls].find((rawUrl) => {
      try {
        const u = new URL(rawUrl, location.href);
        return u.hostname && u.hostname !== location.hostname;
      } catch (_) {
        return false;
      }
    }) || "";
  }

  async function clickConsentAndContinueGates() {
    const patterns = [
      /\bi agree\b/,
      /\bi accept\b/,
      /\baccept\b/,
      /\bconsent(?:\s+and\s+continue)?\b/,
      /\bagree(?:\s+and\s+continue)?\b/,
      /\bcontinue application\b/,
      /\bcontinue to application\b/,
      /\bproceed\b/,
    ];

    for (let pass = 0; pass < 4; pass++) {
      if (await waitForFormSignals(250)) break;
      if (isLikelyLoginPage()) break;
      let clicked = false;
      for (const pattern of patterns) {
        const btn = findVisibleButtonByText(pattern);
        if (!btn) continue;
        fireClick(btn);
        clicked = true;
        await sleep(1500);
        break;
      }
      if (!clicked) break;
    }
  }

  async function waitForLoginCompletion(timeoutMs = 10 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await clickConsentAndContinueGates();

      if (!isLikelyLoginPage()) {
        const ready = await waitForFormSignals(4000);
        if (ready || !isLikelyLoginPage()) return true;
      }

      await sleep(1000);
    }
    return false;
  }

  // ---- Gate click (reveal hidden forms) ----

  async function clickGateIfNeeded() {
    const real = Array.from(document.querySelectorAll('input[type="text"],input[type="email"],input[type="tel"],textarea'))
      .filter(el => !isPanel(el) && isVis(el));
    if (real.length) return;
    const btn = Array.from(document.querySelectorAll("button,a[role='button'],a")).find(el => {
      if (isPanel(el)) return false;
      const t = (el.textContent || "").trim().toLowerCase();
      return /i'?m interested|apply now|apply for this|start application|begin application|^apply$/.test(t);
    });
    if (btn) { btn.click(); await sleep(3000); }
    await clickConsentAndContinueGates();
  }

  // ---- Site handlers ----

  // SmartRecruiters — reads __OC_CONTEXT__ via injected script (main world),
  // finds inputs inside Shadow DOM (<spl-input>, <spl-dropzone> custom elements)
  const SMARTRECRUITERS = {
    detect: () => /smartrecruiters\.com|jobs\.smartrecruiters\.com/.test(location.hostname),

    // SR is a multi-step Angular form: Resume → Personal Info → Screening Questions → Submit
    // After injecting resume, we need to advance through steps until the screening section appears.
    async advanceToScreeningQuestions() {
      // Wait for SR to accept/process the uploaded resume (the dropzone updates)
      await sleep(2000);

      // Try clicking through form steps up to 8 times
      for (let step = 0; step < 8; step++) {
        // Check if screening questions are now visible in the DOM
        const qBlock = document.querySelector('[data-test*="question-"]');
        if (qBlock && isVis(qBlock)) {
          console.log("[CareerOS] SR screening questions section found.");
          return;
        }

        // Look for progress/next buttons — SR uses various patterns
        const nextBtn = findVisibleButtonByText(/\b(next|continue|submit|apply|save\s+and\s+continue|review)\b/)
          || Array.from(queryShadowAll(document, 'button, [role="button"]')).find(el => {
            if (isPanel(el) || !isVis(el) || el.disabled) return false;
            const t = (el.textContent || el.getAttribute("aria-label") || "").trim().toLowerCase();
            return /\b(next|continue|submit|apply)\b/.test(t);
          });

        // Also look for consent/privacy checkboxes that might gate the next button
        const uncheckedConsent = document.querySelector(
          'input[type="checkbox"][data-test*="consent"]:not(:checked), ' +
          'input[type="checkbox"][data-test*="privacy"]:not(:checked)'
        );
        if (uncheckedConsent) {
          uncheckedConsent.click();
          await sleep(500);
        }

        // Also check spl-checkbox in shadow DOM (SR consent checkboxes)
        const splCheckboxes = queryShadowAll(document, 'input[type="checkbox"]').filter(cb => {
          const wrapper = cb.closest?.('[data-test*="consent"]') || cb.getRootNode()?.host?.closest?.('[data-test*="consent"]');
          return wrapper && !cb.checked;
        });
        for (const cb of splCheckboxes) { cb.click(); await sleep(300); }

        if (nextBtn) {
          console.log("[CareerOS] SR advancing form: clicking", nextBtn.textContent?.trim());
          fireClick(nextBtn);
          await sleep(2500);
        } else {
          // No button found — wait a bit for dynamic rendering
          await sleep(2000);
        }
      }
      console.log("[CareerOS] SR could not find screening questions section after advancing.");
    },

    // Read __OC_CONTEXT__ from the page's main world via a script injection
    _getOcContext() {
      return new Promise(resolve => {
        const key = "__co_oc_ctx_" + Date.now();
        const script = document.createElement("script");
        script.textContent = `
          (function(){
            var ctx = window.__OC_CONTEXT__ || null;
            document.dispatchEvent(new CustomEvent("${key}", {detail: ctx ? JSON.stringify(ctx) : null}));
          })();
        `;
        document.addEventListener(key, e => resolve(e.detail ? JSON.parse(e.detail) : null), { once: true });
        document.head.appendChild(script);
        script.remove();
        // Timeout fallback
        setTimeout(() => resolve(null), 2000);
      });
    },

    getResumeInput() {
      // SR new UI: resume dropzone is <spl-dropzone> inside <oc-apply-with-resume>
      // Its shadow contains: input[type="file"][accept*=".doc"]
      const resumeZone = document.querySelector("oc-apply-with-resume spl-dropzone");
      if (resumeZone?.shadowRoot) {
        const inp = resumeZone.shadowRoot.querySelector('input[type="file"]');
        if (inp) return inp;
      }
      // Fallback: any non-image file input in shadow DOM
      const allInputs = queryShadowAll(document, 'input[type="file"]').filter(el => !isPanel(el));
      return allInputs.find(el => {
        const accept = (el.accept || "").toLowerCase();
        return !accept.includes("image") && !accept.includes(".jpg") && !accept.includes(".png") && !accept.includes(".gif");
      }) || null;
    },

    async getQuestions() {
      const ctx = await this._getOcContext();
      const qs = ctx?.screeningConfiguration?.questions || [];
      const SKIP_TYPES = new Set(["info", "files", "file"]);
      return qs
        .filter(q => q.label && !SKIP_TYPES.has((q.type || "").toLowerCase()))
        .map(q => ({
          id: q.id,
          label: q.label,
          type: q.type, // radio, textarea, select, currency
          options: (q.fields || []).flatMap(f =>
            (f.questionsFieldValues || f.values || []).map(v => ({ value: v.fieldValue, label: v.label }))
          ),
          fieldName: (q.fields || [])[0]?.name || "value",
        }));
    },

    // SR renders each screening question in a section with data-test="question-{id}"
    // Inputs live inside <spl-input> shadow: input.c-spl-input
    // Radios live as: input[type="radio"][value="1/0/9"]  (not in shadow)
    // Textareas: <spl-textarea> shadow or plain <textarea>
    findElementForQuestion(question) {
      const type = (question.type || "").toLowerCase();
      const block = document.querySelector(`[data-test="question-${question.id}"]`);
      if (!block) return null;

      // Radio / boolean — return the block so fill() can scan for radios
      if (type === "radio" || type === "boolean") {
        return block;
      }

      // Checkbox — return the block for fill() to find checkboxes
      if (type === "checkbox") {
        return block;
      }

      // Select — SR uses <spl-select>, <spl-dropdown>, or custom web components
      if (type === "select" || type.includes("select")) {
        const splSelect = block.querySelector("spl-select, spl-dropdown, spl-listbox");
        if (splSelect) return splSelect;
        // Fallback: native select
        const nativeSelect = block.querySelector("select");
        if (nativeSelect) return nativeSelect;
        // Try a button or control that acts as a select trigger
        const trigger = block.querySelector('[role="combobox"], [role="listbox"], button[aria-haspopup]');
        if (trigger) return trigger;
        // Last resort: return the block itself so fill() can try to interact with it
        return block;
      }

      // Textarea / text / currency — find spl-input or spl-textarea in question block
      const splInput = block.querySelector("spl-input, spl-textarea");
      if (splInput?.shadowRoot) {
        const inp = splInput.shadowRoot.querySelector("input, textarea");
        if (inp) return inp;
      }
      const direct = block.querySelector("input:not([type='hidden']):not([type='radio']):not([type='checkbox']), textarea, select");
      if (direct) return direct;

      return null;
    },

    async fill(el, answer, question) {
      const type = (question?.type || "").toLowerCase();
      if (!answer) return;

      // Radio / boolean
      if (type === "radio" || type === "boolean") {
        const block = el;
        if (!block) return;
        const radios = block.querySelectorAll('input[type="radio"]');
        // Also check shadow DOM for radios
        const shadowRadios = queryShadowAll(block, 'input[type="radio"]');
        const allRadios = [...new Set([...radios, ...shadowRadios])];
        const t = answer.toLowerCase().trim();
        const target = allRadios.find(r => {
          const lbl = document.querySelector(`label[for="${r.id}"]`) ||
                      r.closest("label") ||
                      r.parentElement?.querySelector("span,label");
          return (lbl?.textContent || r.value || "").toLowerCase().includes(t);
        });
        if (target && !target.checked) target.click();
        return;
      }

      // Checkbox — click to check
      if (type === "checkbox") {
        const block = el;
        if (!block) return;
        const checkboxes = [...block.querySelectorAll('input[type="checkbox"]'), ...queryShadowAll(block, 'input[type="checkbox"]')];
        for (const cb of checkboxes) {
          if (!cb.checked) cb.click();
        }
        return;
      }

      // Select — handle spl-select / spl-dropdown / native select / block fallback
      if (type === "select" || type.includes("select")) {
        const tagLow = (el.tagName || "").toLowerCase();

        // Native <select>
        if (tagLow === "select") { selectByText(el, answer); return; }

        // spl-select / spl-dropdown / spl-listbox web components
        const isSplWidget = tagLow.startsWith("spl-");
        // Also handle the case where el is the question block
        const widget = isSplWidget ? el : el.querySelector?.("spl-select, spl-dropdown, spl-listbox");
        const clickTarget = widget || el.querySelector?.('[role="combobox"], button[aria-haspopup], [class*="control"]') || el;

        fireClick(clickTarget);
        await sleep(600);

        // Match answer against known options from __OC_CONTEXT__
        const opts = question.options || [];
        const ansLower = answer.toLowerCase().trim();
        const match = opts.find(o => o.label.toLowerCase() === ansLower)
          || opts.find(o => o.label.toLowerCase().includes(ansLower))
          || opts.find(o => ansLower.includes(o.label.toLowerCase()));
        const matchLabel = match ? match.label.toLowerCase() : ansLower;

        // Find and click the rendered option
        const allOptions = [...document.querySelectorAll('[role="option"]'), ...queryShadowAll(document, '[role="option"]')];
        let optEl = allOptions.find(o => o.textContent.trim().toLowerCase() === matchLabel);
        if (!optEl) optEl = allOptions.find(o => o.textContent.trim().toLowerCase().includes(matchLabel));
        if (!optEl && match) optEl = allOptions.find(o => o.textContent.trim().toLowerCase().includes(ansLower));
        if (optEl) { fireClick(optEl); await sleep(300); return; }

        // Fallback: try search input inside the widget
        const searchRoot = widget || el;
        const searchInput = searchRoot.shadowRoot?.querySelector("input") || searchRoot.querySelector?.("input");
        if (searchInput) {
          nativeFill(searchInput, answer);
          await sleep(600);
          const firstOpt = document.querySelector('[role="option"]') || searchRoot.shadowRoot?.querySelector('[role="option"]');
          if (firstOpt) fireClick(firstOpt);
        }
        return;
      }

      // Default: native fill
      if (el) nativeFill(el, answer);
    },
  };

  // Rippling ATS (ats.rippling.com)
  // Fields: data-testid="field" wrappers with aria-labelledby spans + data-input inputs.
  // Selects are custom comboboxes with [data-testid="select-controller"] — no native <select>.
  const RIPPLING = {
    detect: () => location.hostname.includes("ats.rippling.com"),

    getResumeInput() {
      return document.querySelector('input[data-testid="input-resume"]') ||
        document.querySelector('input[type="File"][accept*=".doc"]') || null;
    },

    getCoverLetterInput() {
      return document.querySelector('input[data-testid="input-cover_letter"]') || null;
    },

    getQuestions() {
      const fields = [];
      const seen = new Set();

      // Profile fields filled from resume parse — skip from GPT
      const PROFILE_SKIP = new Set([
        "first_name", "last_name", "email", "pronouns",
        "phone_number", "linkedin_link", "website_link",
        "location", "externalPlaceId", "aiOptOut",
      ]);

      // SMS opt-in radio — add as a question for GPT
      const smsGroup = document.querySelector('[data-testid="sms_opt_in"]');
      if (smsGroup && isVis(smsGroup)) {
        const options = Array.from(smsGroup.querySelectorAll('input[type="radio"]')).map(r => {
          const lId = r.getAttribute('aria-labelledby') || "";
          const lbl = lId ? document.getElementById(lId) : null;
          return { label: lbl?.textContent?.trim() || r.value, value: r.value };
        });
        fields.push({
          label: "Do you consent to receiving text message updates from the company regarding your job application?",
          type: "radio_group",
          radioGroup: smsGroup,
          options,
        });
        seen.add(smsGroup);
      }

      // 1. Direct text/number/textarea inputs (non-profile, non-hidden)
      document.querySelectorAll(
        'input[data-input]:not([type="hidden"]):not([data-input="select-search-input"]), ' +
        'textarea[id^="field-"]'
      ).forEach(inp => {
        if (isPanel(inp) || !isVis(inp) || seen.has(inp)) return;
        const dataInput = inp.getAttribute("data-input") || "";
        if (PROFILE_SKIP.has(dataInput)) return;
        seen.add(inp);
        // Label: nearest field block → label span, then fall back to surrounding <p>
        const fieldBlock = inp.closest('[data-testid="field"]');
        const labelEl = fieldBlock?.querySelector('[id$="-label"]');
        const container = inp.closest(".marginY--36");
        const pEl = container?.querySelector("p.css-i4dt0z, p.edalr1o0");
        const label = pEl?.textContent?.trim() || labelEl?.textContent?.trim() || inp.placeholder || dataInput;
        if (!label) return;
        fields.push({ label, type: inp.tagName.toLowerCase(), element: inp });
      });

      // 2. Custom question selects — [data-testid^="customQuestions."]
      document.querySelectorAll('[data-testid^="customQuestions."]').forEach(wrapper => {
        if (isPanel(wrapper) || seen.has(wrapper)) return;
        seen.add(wrapper);
        const container = wrapper.closest(".marginY--36");
        const pEl = container?.querySelector("p.css-i4dt0z, p.edalr1o0");
        const label = pEl?.textContent?.trim();
        if (!label) return;
        const selectController = wrapper.querySelector('[data-testid="select-controller"]');
        if (!selectController || !isVis(selectController)) return;
        fields.push({ label, type: "select", selectController, options: [] });
      });

      // 3. EEO selects — [data-testid^="eeoc."]
      document.querySelectorAll('[data-testid^="eeoc."]').forEach(wrapper => {
        if (isPanel(wrapper) || seen.has(wrapper)) return;
        seen.add(wrapper);
        const fieldBlock = wrapper.closest('[data-testid="field"]');
        const labelEl = fieldBlock?.querySelector('[id$="-label"]');
        const label = labelEl?.textContent?.trim();
        if (!label) return;
        const selectController = wrapper.querySelector('[data-testid="select-controller"]');
        if (!selectController || !isVis(selectController)) return;
        fields.push({ label, type: "select", selectController, options: [], isEEO: true });
      });

      return fields;
    },

    // Open each select dropdown briefly to collect option labels, then close
    async prepareQuestions(questions) {
      for (const q of questions) {
        if (q.type !== "select" || !q.selectController) continue;
        try {
          await ripplingOpenDropdown(q.selectController);
          const opts = await waitForOptions(2000);
          q.options = opts.map(o => ({ label: o.textContent.trim(), value: o.textContent.trim() })).filter(o => o.label);
          // Close via Escape
          document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
          await ripplingWaitClosed(1200);
        } catch (_) {}
      }
    },

    findElementForQuestion(q) { return q.element || q.selectController || q.radioGroup || null; },

    async fill(el, answer, question) {
      const type = question?.type;
      if (type === "select") {
        await ripplingSelectFill(question.selectController, answer);
      } else if (type === "radio_group") {
        const t = answer.toLowerCase().trim();
        const radios = Array.from((question.radioGroup || el).querySelectorAll('input[type="radio"]'));
        const target = radios.find(r => {
          const lId = r.getAttribute('aria-labelledby') || "";
          const lbl = lId ? document.getElementById(lId) : null;
          return (lbl?.textContent || r.value || "").toLowerCase().includes(t);
        });
        if (target && !target.checked) target.click();
      } else {
        nativeFill(el, answer);
      }
    },
  };

  // Greenhouse
  const GREENHOUSE = {
    detect: () => /greenhouse\.io|job-boards\.greenhouse/.test(location.hostname),

    getResumeInput() {
      // New Greenhouse (2025+): file input with id="resume"
      const byId = document.querySelector('input[type="file"]#resume');
      if (byId && !isPanel(byId)) return byId;
      // Greenhouse with data-field wrapper
      const byDataField = document.querySelector('[data-field="resume"] input[type="file"]');
      if (byDataField && !isPanel(byDataField)) return byDataField;
      // Legacy: #resume_input, or data-custom-resumeinfo-field
      const byAttr = document.querySelector('input[data-custom-resumeinfo-field="true"]');
      if (byAttr && !isPanel(byAttr)) return byAttr;
      // Fallback: file input near a label containing "resume" or "cv"
      return Array.from(document.querySelectorAll('input[type="file"]')).find(el => {
        if (isPanel(el)) return false;
        // Check wrapper text OR the input's own id/name
        const wrapper = el.closest('.field-wrapper, .field, [data-field]');
        const text = (wrapper?.textContent || el.id || el.name || "").toLowerCase();
        return text.includes("resume") || text.includes("cv");
      }) || null;
    },

    getCoverLetterInput() {
      // New Greenhouse (2025+): file input with id="cover_letter"
      const byId = document.querySelector('input[type="file"]#cover_letter');
      if (byId && !isPanel(byId)) return byId;
      const byDataField = document.querySelector('[data-field="cover_letter"] input[type="file"]');
      if (byDataField && !isPanel(byDataField)) return byDataField;
      return Array.from(document.querySelectorAll('input[type="file"]')).find(el => {
        if (isPanel(el)) return false;
        const wrapper = el.closest('.field-wrapper, .field, [data-field]');
        const text = (wrapper?.textContent || el.id || el.name || "").toLowerCase();
        return text.includes("cover letter") || text.includes("cover_letter");
      }) || null;
    },

    getQuestions() {
      const fields = [];
      const seen = new Set();
      // Greenhouse wraps each field in .field-wrapper (new) or .field (legacy)
      document.querySelectorAll(".field-wrapper, .field, .form-field, [class*='question']").forEach(block => {
        if (isPanel(block)) return;
        const label = block.querySelector("label, legend");
        if (!label) return;
        const labelText = label.textContent.trim().replace(/\s*\*\s*$/, "");
        if (!labelText) return;

        // Skip file inputs (resume/cover letter handled separately)
        if (block.querySelector('input[type="file"]')) return;

        // 1. Native input/textarea/select
        let input = block.querySelector('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select');

        // 2. React-select combobox (Greenhouse uses react-select for dropdowns)
        let reactSelect = null;
        if (!input || input.getAttribute("role") === "combobox") {
          const combo = block.querySelector('[role="combobox"]');
          if (combo) {
            reactSelect = combo.closest('.select-shell, [class*="container"]') || combo.parentElement?.parentElement;
            if (!input) input = combo; // use the combobox input as element
          }
        }

        // 3. Checkbox groups
        const checkboxes = block.querySelectorAll('input[type="checkbox"]');
        if (checkboxes.length && !input) {
          // Treat as a multi-option question
          const opts = Array.from(checkboxes).map(cb => {
            const cbLabel = block.querySelector(`label[for="${cb.id}"]`);
            return { label: cbLabel?.textContent?.trim() || cb.value, value: cb.value, el: cb };
          });
          if (seen.has(labelText)) return;
          seen.add(labelText);
          fields.push({ label: labelText, element: checkboxes[0], type: "checkbox_group", checkboxes: opts, options: opts });
          return;
        }

        // 4. Radio groups
        const radios = block.querySelectorAll('input[type="radio"]');
        if (radios.length) {
          const opts = Array.from(radios).map(r => {
            const rLabel = block.querySelector(`label[for="${r.id}"]`);
            return { label: rLabel?.textContent?.trim() || r.value, value: r.value, el: r };
          });
          if (seen.has(labelText)) return;
          seen.add(labelText);
          fields.push({ label: labelText, element: radios[0], type: "radio_group", radios: opts, options: opts });
          return;
        }

        if (!input || !isVis(input)) return;
        if (seen.has(input)) return;
        seen.add(input);

        const q = { label: labelText, element: input, type: input.tagName.toLowerCase() };
        if (reactSelect) {
          q.type = "react_select";
          q.reactSelectContainer = reactSelect;
        }
        fields.push(q);
      });
      return fields;
    },

    findElementForQuestion(q) { return q.element || null; },

    async fill(el, answer, question) {
      if (!answer) return;
      const qType = question?.type || "";

      // React-select dropdown
      if (qType === "react_select") {
        const container = question.reactSelectContainer;
        if (!container) { nativeFill(el, answer); return; }
        // Click to open the dropdown
        const control = container.querySelector('[class*="control"]') || container;
        fireClick(control);
        await sleep(400);
        // Type to filter
        const comboInput = container.querySelector('input[role="combobox"]') || el;
        comboInput.focus();
        nativeFill(comboInput, answer);
        await sleep(600);
        // Pick the first matching option
        const options = document.querySelectorAll('[class*="option"], [role="option"]');
        const ansLower = answer.toLowerCase();
        let matched = Array.from(options).find(o => o.textContent.trim().toLowerCase() === ansLower);
        if (!matched) matched = Array.from(options).find(o => o.textContent.trim().toLowerCase().includes(ansLower));
        if (!matched && options.length) matched = options[0];
        if (matched) {
          fireClick(matched);
          await sleep(300);
        }
        return;
      }

      // Radio group
      if (qType === "radio_group" && question.radios) {
        const ansLower = answer.toLowerCase();
        let match = question.radios.find(r => r.label.toLowerCase() === ansLower);
        if (!match) match = question.radios.find(r => r.label.toLowerCase().includes(ansLower));
        if (!match) match = question.radios.find(r => ansLower.includes(r.label.toLowerCase()));
        if (match) { match.el.click(); return; }
      }

      // Checkbox group
      if (qType === "checkbox_group" && question.checkboxes) {
        const ansLower = answer.toLowerCase();
        for (const cb of question.checkboxes) {
          if (ansLower.includes(cb.label.toLowerCase()) || cb.label.toLowerCase().includes(ansLower) || ansLower === "yes" || ansLower === "true") {
            if (!cb.el.checked) cb.el.click();
          }
        }
        return;
      }

      // Native select
      if (el.tagName === "SELECT") {
        selectByText(el, answer);
        return;
      }

      // Default: native fill for input/textarea
      nativeFill(el, answer);
    },
  };

  // Workday
  const WORKDAY = {
    detect: () => /myworkdayjobs\.com|workday\.com/.test(location.hostname),

    getResumeInput() {
      return Array.from(document.querySelectorAll('input[type="file"]')).find(el => {
        const section = el.closest("[data-automation-id],[aria-label]");
        const text = (section?.getAttribute("aria-label") || section?.textContent || "").toLowerCase();
        return text.includes("resume") || text.includes("cv");
      }) || null;
    },

    getQuestions() {
      const fields = [];
      document.querySelectorAll("[data-automation-id*='formField'],[data-automation-id*='questionField']").forEach(block => {
        if (isPanel(block)) return;
        const label = block.querySelector("label,[data-automation-id*='label']");
        const input = block.querySelector("input:not([type='hidden']):not([type='file']), textarea, select");
        if (!label || !input || !isVis(input)) return;
        fields.push({ label: label.textContent.trim(), element: input, type: input.tagName.toLowerCase() });
      });
      return fields;
    },

    findElementForQuestion(q) { return q.element || null; },
    async fill(el, answer) { nativeFill(el, answer); },
  };

  // Workable (apply.workable.com)
  // Form rendered inside a <dialog> modal. Uses data-ui attributes.
  const WORKABLE = {
    detect: () => /workable\.com/.test(location.hostname),

    _dialog() {
      return document.querySelector('dialog[open], dialog[data-ui="modal"]') || document;
    },

    getResumeInput() {
      const root = this._dialog();
      return root.querySelector('input[data-ui="resume"][type="file"]')
        || root.querySelector('input[type="file"][accept*=".pdf"]')
        || null;
    },

    getCoverLetterInput() {
      const root = this._dialog();
      return root.querySelector('input[data-ui="cover-letter"][type="file"]') || null;
    },

    getQuestions() {
      const root = this._dialog();
      const fields = [];
      const seen = new Set();

      // Workable wraps each field in a <section> or <div> with a <label>
      root.querySelectorAll("section, .form-group, [data-ui]").forEach(block => {
        if (isPanel(block)) return;
        // Skip file upload and resume/cover-letter sections
        if (block.querySelector('input[type="file"]')) return;
        const dataUi = block.getAttribute("data-ui") || "";
        if (dataUi === "resume" || dataUi === "cover-letter" || dataUi === "modal") return;

        const label = block.querySelector("label, legend");
        if (!label) return;
        const labelText = label.textContent.trim().replace(/\s*\*\s*$/, "").replace(/\s+/g, " ");
        if (!labelText || labelText.length < 2) return;

        // Find input element
        let input = block.querySelector('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select');

        // React-select (phone country, etc.)
        let reactSelect = null;
        if (!input) {
          const combo = block.querySelector('[role="combobox"]');
          if (combo) {
            reactSelect = combo.closest('[class*="container"]') || combo.parentElement?.parentElement;
            input = combo;
          }
        }

        // Radio group
        const radios = block.querySelectorAll('input[type="radio"]');
        if (radios.length) {
          const opts = Array.from(radios).map(r => {
            const rLabel = block.querySelector(`label[for="${r.id}"]`) || r.closest("label") || r.parentElement;
            return { label: rLabel?.textContent?.trim() || r.value, value: r.value, el: r };
          });
          if (seen.has(labelText)) return;
          seen.add(labelText);
          fields.push({ label: labelText, element: radios[0], type: "radio_group", radios: opts, options: opts });
          return;
        }

        // Checkbox group
        const checkboxes = block.querySelectorAll('input[type="checkbox"]');
        if (checkboxes.length && !input) {
          const opts = Array.from(checkboxes).map(cb => {
            const cbLabel = block.querySelector(`label[for="${cb.id}"]`);
            return { label: cbLabel?.textContent?.trim() || cb.value, value: cb.value, el: cb };
          });
          if (seen.has(labelText)) return;
          seen.add(labelText);
          fields.push({ label: labelText, element: checkboxes[0], type: "checkbox_group", checkboxes: opts, options: opts });
          return;
        }

        if (!input) return;
        if (seen.has(input)) return;
        seen.add(input);

        const q = { label: labelText, element: input, type: input.tagName.toLowerCase() };
        if (reactSelect) {
          q.type = "react_select";
          q.reactSelectContainer = reactSelect;
        }
        // Collect options for native select
        if (input.tagName === "SELECT") {
          q.options = Array.from(input.options).filter(o => o.value).map(o => ({ label: o.textContent.trim(), value: o.value }));
        }
        fields.push(q);
      });

      // Fallback: grab any visible text/textarea inputs not yet captured (flat forms)
      const selector = 'input[type="text"],input[type="email"],input[type="tel"],input[type="url"],input[type="number"],textarea';
      root.querySelectorAll(selector).forEach(el => {
        if (!isVis(el) || isPanel(el) || seen.has(el)) return;
        if ((el.value || "").trim()) return; // already filled
        let lbl = "";
        if (el.id) {
          const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l) lbl = l.textContent.trim();
        }
        if (!lbl) lbl = el.closest("label")?.textContent?.trim() || "";
        if (!lbl) lbl = el.getAttribute("aria-label") || el.placeholder || el.name || "";
        if (!lbl) return;
        seen.add(el);
        fields.push({ label: lbl, element: el, type: el.tagName.toLowerCase() });
      });

      return fields;
    },

    findElementForQuestion(q) { return q.element || null; },

    async fill(el, answer, question) {
      if (!answer) return;
      const qType = question?.type || "";

      if (qType === "react_select") {
        const container = question.reactSelectContainer;
        if (!container) { nativeFill(el, answer); return; }
        const control = container.querySelector('[class*="control"]') || container;
        fireClick(control);
        await sleep(400);
        const comboInput = container.querySelector('input[role="combobox"]') || el;
        comboInput.focus();
        nativeFill(comboInput, answer);
        await sleep(600);
        const options = document.querySelectorAll('[class*="option"], [role="option"]');
        const ansLower = answer.toLowerCase();
        let matched = Array.from(options).find(o => o.textContent.trim().toLowerCase() === ansLower)
          || Array.from(options).find(o => o.textContent.trim().toLowerCase().includes(ansLower));
        if (!matched && options.length) matched = options[0];
        if (matched) { fireClick(matched); await sleep(300); }
        return;
      }

      if (qType === "radio_group" && question.radios) {
        const ansLower = answer.toLowerCase();
        const match = question.radios.find(r => r.label.toLowerCase() === ansLower)
          || question.radios.find(r => r.label.toLowerCase().includes(ansLower))
          || question.radios.find(r => ansLower.includes(r.label.toLowerCase()));
        if (match) { match.el.click(); return; }
      }

      if (qType === "checkbox_group" && question.checkboxes) {
        const ansLower = answer.toLowerCase();
        for (const cb of question.checkboxes) {
          if (ansLower.includes(cb.label.toLowerCase()) || ansLower === "yes" || ansLower === "true") {
            if (!cb.el.checked) cb.el.click();
          }
        }
        return;
      }

      if (el.tagName === "SELECT") { selectByText(el, answer); return; }

      nativeFill(el, answer);
    },
  };

  // Generic fallback
  const GENERIC = {
    detect: () => true,

    getResumeInput() {
      const all = Array.from(document.querySelectorAll('input[type="file"]')).filter(el => !isPanel(el) && isVis(el));
      // Skip image/avatar inputs
      return all.find(el => {
        const accept = (el.accept || "").toLowerCase();
        const name = (el.name || el.id || "").toLowerCase();
        const nearLabel = (document.querySelector(`label[for="${el.id}"]`)?.textContent || "").toLowerCase();
        const isImage = accept.includes("image") || accept.includes(".jpg") || accept.includes(".png") || name.includes("photo") || name.includes("avatar") || nearLabel.includes("photo") || nearLabel.includes("avatar");
        return !isImage;
      }) || null;
    },

    getQuestions() {
      const fields = [];
      const seen = new Set();
      const selector = 'input[type="text"],input[type="email"],input[type="tel"],input[type="url"],input[type="number"],textarea,select';
      document.querySelectorAll(selector).forEach(el => {
        if (!isVis(el) || isPanel(el) || seen.has(el)) return;
        if ((el.value || "").trim()) return;
        // Get label — try multiple strategies (standard, Zoho, Lever, etc.)
        let label = "";
        // 1. Standard: label[for]
        if (el.id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) label = lbl.textContent.trim();
        }
        // 2. Wrapping <label>
        if (!label) label = el.closest("label")?.textContent?.trim() || "";
        // 3. aria-label / aria-labelledby
        if (!label) label = el.getAttribute("aria-label") || "";
        if (!label) {
          const lblId = el.getAttribute("aria-labelledby");
          if (lblId) label = document.getElementById(lblId)?.textContent?.trim() || "";
        }
        // 4. Walk up through ancestor containers to find a label
        //    Handles: Zoho (.crc-form-row > label), Lever (.application-field > label),
        //    and other ATS with row-based layouts.
        //    Try multiple ancestor levels since the label may be in a grandparent row.
        if (!label) {
          let ancestor = el.parentElement;
          for (let depth = 0; depth < 8 && ancestor && !label; depth++) {
            const rowLabel = ancestor.querySelector(':scope > label, :scope > .label');
            if (rowLabel) {
              label = rowLabel.textContent.trim();
              break;
            }
            ancestor = ancestor.parentElement;
          }
        }
        // 5. placeholder / name fallback
        if (!label) label = el.placeholder || el.name || "";
        if (!label) return;
        if (isLikelyNonApplicationField(el, label)) return;
        seen.add(el);
        fields.push({ label, element: el, type: el.tagName.toLowerCase() });
      });
      return fields;
    },

    findElementForQuestion(q) { return q.element || null; },
    async fill(el, answer) { nativeFill(el, answer); },
  };

  // ADP WorkforceNow — Angular SPA, form rendered inside same-origin iframe
  // Inputs use: input[id], select[id], textarea; labels use <label for="...">
  // Resume upload: input[type="file"] near text "resume"/"cv"
  const ADP = {
    detect: () => location.hostname.includes("workforcenow.adp.com"),

    _root() {
      // ADP renders the apply form inside an iframe — find it and use its contentDocument
      // If we're already inside the iframe (content script runs in all_frames), use document directly
      if (location.href.includes("recruitment.html")) return document;
      const iframe = document.querySelector('iframe[src*="recruitment"], iframe[src*="adp"]');
      return iframe?.contentDocument || document;
    },

    getResumeInput() {
      const root = this._root();
      const all = Array.from(root.querySelectorAll('input[type="file"]')).filter(el => !isPanel(el));
      return all.find(el => {
        const lbl = el.id ? root.querySelector(`label[for="${el.id}"]`) : null;
        const nearby = (lbl?.textContent || el.name || el.closest("div,section")?.textContent || "").toLowerCase();
        const accept = (el.accept || "").toLowerCase();
        return (nearby.includes("resume") || nearby.includes("cv")) &&
               !accept.includes("image");
      }) || all.find(el => {
        const accept = (el.accept || "").toLowerCase();
        return !accept.includes("image") && !accept.includes(".jpg") && !accept.includes(".png");
      }) || null;
    },

    getQuestions() {
      const root = this._root();
      const fields = [];
      const seen = new Set();

      // ADP renders fields as: <div class="..."><label for="X">Label</label><input id="X"...></div>
      root.querySelectorAll("label[for]").forEach(lbl => {
        if (isPanel(lbl)) return;
        const id = lbl.getAttribute("for");
        const el = id ? root.getElementById(id) : null;
        if (!el || seen.has(el)) return;
        const tag = el.tagName.toLowerCase();
        if (!["input", "select", "textarea"].includes(tag)) return;
        if (el.type === "hidden" || el.type === "file" || el.type === "submit" || el.type === "button") return;
        if (!isVis(el)) return;
        seen.add(el);
        const options = tag === "select"
          ? Array.from(el.options).filter(o => o.value).map(o => ({ label: o.text.trim(), value: o.value }))
          : [];
        fields.push({ label: lbl.textContent.trim(), element: el, type: tag, options });
      });

      // Also catch aria-label inputs not covered by <label for>
      root.querySelectorAll("input[aria-label], textarea[aria-label]").forEach(el => {
        if (isPanel(el) || seen.has(el) || !isVis(el)) return;
        if (el.type === "hidden" || el.type === "file") return;
        seen.add(el);
        fields.push({ label: el.getAttribute("aria-label").trim(), element: el, type: el.tagName.toLowerCase(), options: [] });
      });

      return fields;
    },

    findElementForQuestion(q) { return q.element || null; },

    async fill(el, answer, question) {
      if (question?.type === "select") {
        selectByText(el, answer);
      } else {
        nativeFill(el, answer);
      }
    },
  };

  function detectHandler() {
    if (ADP.detect()) return ADP;
    if (RIPPLING.detect()) return RIPPLING;
    if (SMARTRECRUITERS.detect()) return SMARTRECRUITERS;
    if (GREENHOUSE.detect()) return GREENHOUSE;
    if (WORKDAY.detect()) return WORKDAY;
    if (WORKABLE.detect()) return WORKABLE;
    return GENERIC;
  }

  // ---- Main entry ----

  const stored = await chrome.storage.local.get(["automation", "automationJobContext"]);
  if (!stored.automation?.active) return;
  const ctx = stored.automationJobContext;
  if (!ctx) return;

  const SKIP = ["linkedin.com", "angel.co", "wellfound.com"];
  if (SKIP.some(d => location.hostname.includes(d))) {
    await sendNext({ status: "skipped", reason: location.hostname });
    return;
  }

  // Workday: complex multi-step SPA that requires account creation/login.
  // Skip immediately and move to next job instead of stalling.
  if (/myworkdayjobs\.com|workday\.com/.test(location.hostname)) {
    console.log("[CareerOS] Workday detected — skipping (requires account creation).");
    await sendNext({ status: "skipped", reason: "Workday (requires login)" });
    return;
  }

  await new Promise(r => { if (document.readyState === "complete") return r(); window.addEventListener("load", r, { once: true }); });
  // ADP loads an Angular SPA that takes several seconds to render
  const baseWait = location.hostname.includes("adp.com") ? 5000 : 2000;
  await sleep(baseWait);
  if (location.hostname.includes("adp.com")) {
    await waitForFormSignals(15000);
  }

  await clickGateIfNeeded();
  await sleep(1000);
  await clickConsentAndContinueGates();

  // Detect iframe-only application forms (e.g., Comeet, Breezy, JazzHR)
  // If clicking the gate button loaded a cross-origin iframe but the top frame
  // still has no form fields, the GENERIC handler would find nothing to fill.
  // Skip early instead of stalling.
  if (!hasVisibleApplicationSignals()) {
    const formIframes = Array.from(document.querySelectorAll("iframe")).filter(f => {
      const src = (f.src || "").toLowerCase();
      return (src.includes("apply") || src.includes("job") || src.includes("career") || src.includes("form")) &&
             f.offsetWidth > 100 && f.offsetHeight > 100;
    });
    if (formIframes.length) {
      console.log("[CareerOS] Application form is inside an iframe — cannot autofill cross-origin. Skipping.");
      await sendNext({ status: "manual", reason: "iframe application form" });
      return;
    }
  }

  if (isLikelyLoginPage()) {
    if (location.hostname.includes("adp.com")) {
      console.log("[CareerOS] ADP login page detected; leaving tab open and skipping job.");
      await sendNext({ status: "skipped", reason: "adp login required" });
      return;
    }
    console.log("[CareerOS] Login page detected; waiting for manual login.");
    const loginDone = await waitForLoginCompletion();
    if (!loginDone) {
      await sendNext({ status: "manual", reason: "login required" });
      return;
    }
    await sleep(1500);
  }

  const handler = detectHandler();
  const isGenericHandler = handler === GENERIC;
  const handlerName = handler === ADP ? "ADP" : handler === RIPPLING ? "Rippling" : handler === SMARTRECRUITERS ? "SmartRecruiters" : handler === GREENHOUSE ? "Greenhouse" : handler === WORKDAY ? "Workday" : handler === WORKABLE ? "Workable" : "Generic";
  console.log("[CareerOS] Autofill handler:", handlerName);

  // 1. Resume file — only into the resume input, never the cover letter input
  if (ctx.resumeFileInfo) {
    const resumeInput = handler.getResumeInput();
    // Exclude Rippling's cover_letter input from resume injection
    const coverLetterInput = handler.getCoverLetterInput ? handler.getCoverLetterInput() : null;
    const safeResumeInput = (resumeInput && resumeInput !== coverLetterInput) ? resumeInput : null;
    console.log("[CareerOS] Resume input found:", !!safeResumeInput);
    if (safeResumeInput) await injectFileIntoInput(safeResumeInput, ctx.resumeFileInfo).catch(() => {});
  }

  // 1b. Cover letter file — generate DOCX from cover letter text and inject
  if (handler.getCoverLetterInput) {
    const clInput = handler.getCoverLetterInput();
    if (clInput && ctx.coverLetter) {
      const clText = String(ctx.coverLetter).trim();
      if (clText) {
        const resp = await chrome.runtime.sendMessage({ type: "CO_COVER_LETTER_DOCX_B64", payload: { text: clText } }).catch(() => null);
        if (resp?.ok) {
          const raw = atob(resp.b64);
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          const file = new File([bytes], "cover_letter.docx", { type: mime });
          const dt = new DataTransfer();
          dt.items.add(file);
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set;
          setter.call(clInput, dt.files);
          clInput.dispatchEvent(new Event("input",  { bubbles: true }));
          clInput.dispatchEvent(new Event("change", { bubbles: true }));
          console.log("[CareerOS] Cover letter DOCX injected.");
        }
      }
    }
  }

  // 1c. SmartRecruiters: advance through multi-step form to reach screening questions
  if (handler.advanceToScreeningQuestions) {
    await handler.advanceToScreeningQuestions();
  }

  // 2. Collect questions
  const questions = await Promise.resolve(handler.getQuestions());
  const externalApplicationUrl = isGenericHandler ? findExternalApplicationUrl() : "";
  // Let handler fetch options (e.g. Rippling opens each select briefly)
  if (handler.prepareQuestions) await handler.prepareQuestions(questions);
  console.log("[CareerOS] Questions found:", questions.length, questions.map(q => `${q.label} [${q.options?.length || 0} opts]`));

  if (externalApplicationUrl) {
    console.log("[CareerOS] Generic page points to an external application URL; leaving tab open and continuing automation:", externalApplicationUrl);
    await sendNext({ status: "manual", reason: "external application link" });
    return;
  }

  if (!questions.length) {
    if (isGenericHandler) {
      console.log("[CareerOS] Generic/custom site with no detected questions; leaving tab open and continuing automation.");
      await sendNext({ status: "manual", reason: "custom site" });
      return;
    }
    // Register submit listener and exit — user fills manually
    document.addEventListener("submit", () => {
      sleep(1500).then(() => sendNext({ status: "applied" }));
    }, { once: true, capture: true });
    return;
  }

  // 3. Build GPT prompt — include options for select/radio so GPT picks the right value
  const questionLines = questions.map((q, i) => {
    let line = `Q${i + 1}: ${q.label}`;
    if (q.options?.length) {
      line += `\n  Options: ${q.options.map(o => o.label).join(" | ")}`;
    }
    return line;
  }).join("\n");

  const qaPrompt =
    `Fill these job application form fields for the ${ctx.position} position at ${ctx.company}.\n` +
    `Use my personal info and experience from our resume conversation.\n` +
    `For each question, answer on its own line as: A1: answer\n` +
    `For Yes/No questions, answer Yes or No.\n` +
    `For select/radio, choose the closest matching option text exactly as written.\n\n` +
    questionLines;

  const gptText = await askGpt(ctx, qaPrompt, "qa");
  console.log("[CareerOS] GPT QA response:", gptText?.slice(0, 300));

  if (gptText) {
    const answers = parseQaResponse(gptText, questions.length);
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const answer = answers[i];
      if (!answer) continue;
      let el = handler.findElementForQuestion(q);
      // Retry once: scroll down and wait for lazy-rendered elements (SR multi-step)
      if (!el) {
        window.scrollBy(0, 400);
        await sleep(800);
        el = handler.findElementForQuestion(q);
      }
      // BOOLEAN type: try clickRadioByText by fieldName as fallback when no element found
      if (!el) {
        const type = (q.type || "").toUpperCase();
        if ((type === "BOOLEAN" || type === "RADIO") && q.fieldName) {
          clickRadioByText(q.fieldName, answer);
        }
        continue;
      }
      await handler.fill(el, answer, q).catch((e) => console.warn("[CareerOS] Fill error:", q.label, e));
    }
  }

  // 4. Auto-submit
  await sleep(800);

  // Find the submit/apply button — must be enabled
  const action = findPrimaryActionButton();
  const submitBtn = action.button;

  // Detect captcha/blocker — if a turnstile/recaptcha/hcaptcha is present and visible, skip auto-submit
  const hasCaptcha = !!(
    document.querySelector("#turnstile-container, .cf-turnstile, .h-captcha, .g-recaptcha, iframe[src*='captcha']")
  ) && isVis(document.querySelector("#turnstile-container, .cf-turnstile, .h-captcha, .g-recaptcha, iframe[src*='captcha']"));

  if (hasCaptcha) {
    console.log("[CareerOS] Captcha detected — leaving tab for manual completion.");
    await sendNext({ status: "manual", reason: "captcha" });
    return;
  }

  if (!submitBtn) {
    console.log("[CareerOS] No enabled submit button found — leaving tab for manual completion.");
    await sendNext({ status: "manual", reason: "no action button" });
    return;
  }

  console.log(`[CareerOS] Auto-${action.kind === "submit" ? "submitting" : "advancing"}:`, submitBtn.textContent.trim());

  // Listen for form submit event or URL change as success signal
  let submitted = false;
  const submitListener = () => { submitted = true; };
  document.addEventListener("submit", submitListener, { once: true, capture: true });

  const urlBefore = location.href;
  fireClick(submitBtn);

  // Wait up to 15s for actual success: navigation, submit event, or confirmation element
  // Do NOT treat button-disabled as success — React disables it immediately on click
  // Minimum 2s before checking — React router may do minor URL updates on click
  await sleep(2000);

  const deadline = Date.now() + 13000;
  let successDetected = false;
  let advancedStep = false;

  while (Date.now() < deadline) {
    await sleep(400);

    // Hard success signals
    if (submitted) { successDetected = true; break; }
    if (location.href !== urlBefore) { successDetected = true; break; }
    if (action.kind === "progress" && await waitForFormSignals(250)) {
      advancedStep = true;
      break;
    }

    const successEl = document.querySelector(
      '[data-testid*="success"], [data-testid*="confirmation"], [data-testid*="thank"],' +
      ' [class*="successMessage"], [class*="confirmationPage"]'
    );
    if (successEl && isVis(successEl)) { successDetected = true; break; }

    // Captcha that appeared after click — leave for manual
    const captchaAfter = document.querySelector("#turnstile-container, .cf-turnstile, .h-captcha, .g-recaptcha");
    if (captchaAfter && isVis(captchaAfter)) {
      document.removeEventListener("submit", submitListener, { capture: true });
      console.log("[CareerOS] Captcha appeared after submit — leaving tab.");
      await sendNext({ status: "manual", reason: "captcha after submit" });
      return;
    }

    // Button re-enabled means submission was rejected (validation error) — stop waiting
    const btnStillPresent = document.contains(submitBtn);
    if (btnStillPresent && !submitBtn.disabled && submitBtn.getAttribute("data-disabled") !== "true") {
      console.log("[CareerOS] Submit button re-enabled — likely a validation error, leaving tab.");
      break;
    }
  }

  document.removeEventListener("submit", submitListener, { capture: true });

  if (successDetected) {
    console.log("[CareerOS] Submitted successfully.");
    await sleep(1500);
    await sendNext({ status: "applied" });
  } else if (advancedStep) {
    console.log("[CareerOS] Advanced to next application step â€” leaving tab for continued automation/manual review.");
    await sendNext({ status: "manual", reason: "advanced to next step" });
  } else {
    console.log("[CareerOS] Could not confirm submission — leaving tab for manual completion.");
    await sendNext({ status: "manual", reason: "submit unconfirmed" });
  }

})().catch(e => console.error("[CareerOS] Autofill error:", e));
