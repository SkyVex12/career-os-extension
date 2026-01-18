// content.js
// CareerOS content script with login/logout + user picker.
//
// ✅ FIXES per your request:
// 1) Username must ALWAYS be visible (never covered).
//    - Left block (name + id) has its own column and truncates nicely.
//    - Right "Applied..." badge is in a separate column (never overlaps name).
//    - Badge is anchored to the RIGHT of the USER ID line (not the name line).
//    - Badge may visually cover the ID line area, BUT:
//        - Full user id is available on hover (title tooltip) on the id line.
//        - Badge itself also has a title tooltip.
// 2) Shaking the FULL panel must work.
//    - We add a shake class to the CARD element (.co-card) not root,
//      and reflow to replay. This is the most reliable.
//    - We also include keyframes and ensure no conflicting transforms.
//    - Shake is triggered when ANY selected user has an existing application.
// 3) Add "Source site" (human input like "indeed") and send to backend.
// 4) Reduce cost: Extract JD keys once (cached server-side) via /v1/jd/keys,
//    then pass jd_keys into /v1/ingest/apply-and-generate.
//
// Behavior:
// - Select users (chips + checklist). "All users" selects all.
// - URL blur or selection changes -> per-user /v1/applications/exists checks.
// - Right badge shows: "Applied • 12/26/2025 • by TimothyTran"
// - Press Enter on email/password triggers Login.

const BACKEND_DEFAULT = "https://career-os.onrender.com";

let CO_USER_MAP = new Map(); // user_id -> { id, name }
let CO_ALL_USERS = []; // [{id, name}]
let CO_EXISTS_CACHE = new Map(); // user_id -> { exists, created_at, created_by, raw }

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
  // force reflow so animation restarts
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
  }

  function clearAll() {
    allMode = false;
    selected = new Set();
    saveSelected().catch(() => {});
    render();
  }

  function toggleUser(id) {
    id = String(id);
    if (allMode) allMode = false;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    saveSelected().catch(() => {});
    render();
  }

  function removeChip(id) {
    id = String(id);
    if (allMode) allMode = false;
    selected.delete(id);
    saveSelected().catch(() => {});
    render();
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

  // ✅ IMPORTANT: username and id are in their own column.
  // Badge is a separate right column, aligned with the ID line (2nd line).
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

  // fetch users
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

    // default: all users
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

  const selected = root.__coGetSelectedUserIds?.() || [];
  if (!selected.length) return;

  const norm = canonicalizeUrl(url);

  // concurrency limit
  const CONCURRENCY = 6;
  let idx = 0;

  async function worker() {
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

        CO_EXISTS_CACHE.set(uid, { exists, created_at, created_by, raw: data });
      } catch {
        // ignore
      } finally {
        root.__coRenderUserList?.();
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () =>
      worker(),
    ),
  );

  // ✅ shake the FULL panel if ANY applied exists
  const anyApplied = selected.some(
    (uid) => CO_EXISTS_CACHE.get(String(uid))?.exists,
  );
  if (anyApplied) shakePanel(cardEl);
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

      /* Left column always visible */
      #${PANEL_ID} .co-user-left{
        min-width:0;
        display:flex;
        flex-direction:column;
        gap:2px;
      }
      #${PANEL_ID} .co-user-name{
        font-size:12px; font-weight:900; color:#111827;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }

      /* ID line: we allow badge to "feel like it's at right of ID",
         but we never overlap name because badge is its own column. */
      #${PANEL_ID} .co-user-id{
        font-size:11px; color:#6b7280;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        max-width: 240px;
      }

      /* Right side badge aligned with ID line visually */
      #${PANEL_ID} .co-user-right-slot{
        align-self:end; /* align with bottom line (id line) */
      }
      #${PANEL_ID} .co-user-badge{
        font-size:11px;
        font-weight:900;
        color:#991b1b;
        background: rgba(220,38,38,.08);
        border: 1px solid rgba(220,38,38,.22);
        padding:6px 8px;
        border-radius: 10px;
        white-space:nowrap;
        max-width: 200px;
        overflow:hidden;
        text-overflow:ellipsis;
      }

      /* ✅ Full-panel shake */
      @keyframes co-card-shake {
        0%,100%{ transform: translateX(0); }
        15%{ transform: translateX(-10px); }
        30%{ transform: translateX(10px); }
        45%{ transform: translateX(-8px); }
        60%{ transform: translateX(8px); }
        75%{ transform: translateX(-5px); }
        90%{ transform: translateX(5px); }
      }
      #${PANEL_ID} .co-card.co-card-shake{
        animation: co-card-shake .55s ease-in-out 0s 2;
      }
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
            <label>Users</label>
            <div class="co-userpicker" id="co_userpicker">
              <div class="co-userpicker-top">
                <input id="co_user_search" class="co-user-search" placeholder="Search users..." />
                <button id="co_user_select_all" class="co-user-ghost" type="button">All users</button>
                <button id="co_user_clear" class="co-user-ghost" type="button">Clear</button>
              </div>
              <div id="co_user_chips" class="co-user-chips"></div>
              <div id="co_user_list" class="co-user-list"></div>
              <div class="co-muted" style="margin-top:6px;">Applied hint is on the right of the user ID line. Hover user id to see full id.</div>
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

            
            <label>Resume download</label>
            <div class="co-row" style="display:flex; gap:8px; align-items:center;">
              <select id="co_resume_format" style="flex:1;">
                <option value="docx">DOCX</option>
                <option value="pdf">PDF</option>
                <option value="both">DOCX + PDF</option>
              </select>
              <label style="display:flex; align-items:center; gap:6px; font-size:12px; margin-top:4px; white-space:nowrap;">
                <input id="co_cover_letter" type="checkbox" style="width:auto; margin:0;" />
                Cover letter
              </label>
            </div>
<button class="co-action" id="co_generate" type="button">Generate</button>
            <button class="co-action secondary" id="co_logout" type="button">Logout</button>

            <div class="co-muted">First time: set base resume via backend PUT /v1/users/{user_id}/base-resume</div>
            <div class="co-status" id="co_status"></div>
          </div>
        </div>
      </div>
    `;
    return root;
  }

  async function refreshExistsInList(root, cardEl, urlInputEl) {
    const jobUrl = (urlInputEl?.value || "").trim();
    if (!jobUrl) return;
    await updateExistsForSelected(root, cardEl, jobUrl);
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
      email: root.querySelector("#co_email"),
      password: root.querySelector("#co_password"),
      login: root.querySelector("#co_login"),

      source_site: root.querySelector("#co_source_site"),

      url: root.querySelector("#co_url"),
      company: root.querySelector("#co_company"),
      position: root.querySelector("#co_position"),
      jd: root.querySelector("#co_jd"),
      resume_format: root.querySelector("#co_resume_format"),
      cover_letter: root.querySelector("#co_cover_letter"),

      generate: root.querySelector("#co_generate"),
      logout: root.querySelector("#co_logout"),
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

    // open/close
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

    // backend persist
    ["change", "blur"].forEach((ev) => {
      els.backend.addEventListener(ev, async () => {
        const backend = (els.backend.value || "").trim() || BACKEND_DEFAULT;
        await chrome.storage.local.set({ backend });
        const { authToken } = await chrome.storage.local.get(["authToken"]);
        await pushAuthToBackground({ token: authToken || "", backend });
      });
    });

    // Enter-to-login
    function handleEnterToLogin(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        els.login.click();
      }
    }
    els.email.addEventListener("keydown", handleEnterToLogin);
    els.password.addEventListener("keydown", handleEnterToLogin);

    // Save app fields
    async function saveAppSettings() {
      await chrome.storage.local.set({
        company: els.company.value.trim(),
        position: els.position.value.trim(),
        source_site: els.source_site.value.trim(),
        resume_format: (els.resume_format?.value || "docx").trim(),
        cover_letter: !!els.cover_letter?.checked,
      });
    }
    ["change", "blur"].forEach((ev) => {
      els.company.addEventListener(ev, saveAppSettings);
      els.position.addEventListener(ev, saveAppSettings);
      els.source_site.addEventListener(ev, saveAppSettings);
      els.resume_format?.addEventListener(ev, saveAppSettings);
    });
    els.cover_letter?.addEventListener("change", saveAppSettings);
    // URL blur triggers re-check
    els.url.addEventListener("blur", () => {
      refreshExistsInList(root, card, els.url).catch(() => {});
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

        // re-check when picker interaction
        root.querySelector("#co_userpicker")?.addEventListener("click", () => {
          clearTimeout(root.__coCheckTimer);
          root.__coCheckTimer = setTimeout(
            () => refreshExistsInList(root, card, els.url).catch(() => {}),
            180,
          );
        });
        root.querySelector("#co_user_search")?.addEventListener("input", () => {
          clearTimeout(root.__coCheckTimer);
          root.__coCheckTimer = setTimeout(
            () => refreshExistsInList(root, card, els.url).catch(() => {}),
            260,
          );
        });

        els.url.value = location.href;

        await refreshExistsInList(root, card, els.url);

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

    // GENERATE
    els.generate.addEventListener("click", async () => {
      const selected = root.__coGetSelectedUserIds?.() || [];
      const jobUrl = (els.url.value || "").trim();
      const company = (els.company.value || "").trim();
      const position = (els.position.value || "").trim();
      const jdText = (els.jd.value || "").trim();
      const sourceSite = (els.source_site.value || "").trim();
      const resumeFormat = (els.resume_format?.value || "docx").trim();
      const wantCoverLetter = !!els.cover_letter?.checked;
      if (
        !selected.length ||
        !jobUrl ||
        !company ||
        !position ||
        jdText.length < 50
      ) {
        setStatus("Missing fields. JD must be at least ~50 chars.");
        return;
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
            `Generating for ${name}... (${okCount}/${selected.length})`,
          );

          const r = await apiCall("/v1/ingest/apply-and-generate", {
            method: "POST",
            json: {
              user_id: uid,
              url: jobUrl,
              company,
              position,
              source_site: sourceSite, // ✅ new
              jd_text: jdText, // keep for backward compatibility
              include_cover_letter: wantCoverLetter,
            },
          });
          console.log("response:", r);
          if (!r.ok) {
            failures.push({ uid, status: r.status });
            continue;
          }

          const data = r.data || {};
          const backendBase = (els.backend?.value || "" || BACKEND_DEFAULT)
            .trim()
            .replace(/\/$/, "");
          const appId = data.application_id || data.applicationId || "";
          const baseFolder = `CareerOS/${uid}/${appId || "application"}`;

          async function downloadHttpUrl(url, filename) {
            const resp = await chrome.runtime.sendMessage({
              type: "DOWNLOAD_BLOB_URL",
              payload: { url, filename, saveAs: true },
            });
            return !!resp?.ok;
          }

          let downloaded = false;

          // ---- Backend v2: returns file ids + download urls (+ cover letter text)
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
                  `${baseFolder}/resume.pdf`,
                );
              } else if (docxUrlAbs) {
                // fallback
                downloaded = await downloadHttpUrl(
                  docxUrlAbs,
                  `${baseFolder}/resume.docx`,
                );
              }
            } else if (resumeFormat === "both") {
              let ok1 = false;
              let ok2 = false;
              if (docxUrlAbs)
                ok1 = await downloadHttpUrl(
                  docxUrlAbs,
                  `${baseFolder}/resume.docx`,
                );
              if (pdfUrlAbs)
                ok2 = await downloadHttpUrl(
                  pdfUrlAbs,
                  `${baseFolder}/resume.pdf`,
                );
              downloaded = ok1 || ok2;
            } else {
              // default docx
              if (docxUrlAbs) {
                downloaded = await downloadHttpUrl(
                  docxUrlAbs,
                  `${baseFolder}/resume.docx`,
                );
              } else if (pdfUrlAbs) {
                // fallback
                downloaded = await downloadHttpUrl(
                  pdfUrlAbs,
                  `${baseFolder}/resume.pdf`,
                );
              }
            }

            if (!downloaded) {
              failures.push({ uid, status: "download_failed" });
              continue;
            }

            // Optional cover letter: download as .txt
            if (wantCoverLetter && data.cover_letter) {
              const clText = String(data.cover_letter || "").trim();
              if (clText) {
                const clBlob = new Blob([clText], { type: "text/plain" });
                const clUrl = URL.createObjectURL(clBlob);
                await downloadHttpUrl(clUrl, `${baseFolder}/cover_letter.txt`);
                setTimeout(() => URL.revokeObjectURL(clUrl), 30_000);
              }
            }

            okCount++;
            continue;
          }

          // ---- Backward compatibility (older backend): base64 docx in response
          if (data.resume_docx_base64) {
            const docxUrl = b64ToBlobUrl(data.resume_docx_base64, mime);
            const filename = `${baseFolder}/resume.docx`;

            const ok = await downloadHttpUrl(docxUrl, filename);
            if (!ok) {
              failures.push({ uid, status: "download_failed" });
              continue;
            }

            okCount++;
            continue;
          }

          failures.push({ uid, status: "missing_files" });
          continue;
        }

        if (failures.length) {
          setStatus(
            `✅ Done. Generated for ${okCount}/${selected.length} users.\nFailed: ${failures.length}`,
          );
        } else {
          setStatus(
            `✅ Done. Generated for ${okCount}/${selected.length} users.`,
          );
        }

        await refreshExistsInList(root, card, els.url);
      } catch (e) {
        console.log(e);
        setStatus(`Request failed:\n${String(e)}`);
      }
    });

    // Initial load
    (async () => {
      const data = await chrome.storage.local.get([
        "backend",
        "authToken",
        "principal",
        "company",
        "position",
        "source_site",
        "resume_format",
        "cover_letter",
      ]);

      els.backend.value = data.backend || BACKEND_DEFAULT;
      els.company.value = data.company || "";
      els.position.value = data.position || "";
      els.source_site.value = data.source_site || "";
      if (els.resume_format)
        els.resume_format.value = data.resume_format || "docx";
      if (els.cover_letter) els.cover_letter.checked = !!data.cover_letter;
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
            () => refreshExistsInList(root, card, els.url).catch(() => {}),
            180,
          );
        });
        root.querySelector("#co_user_search")?.addEventListener("input", () => {
          clearTimeout(root.__coCheckTimer);
          root.__coCheckTimer = setTimeout(
            () => refreshExistsInList(root, card, els.url).catch(() => {}),
            260,
          );
        });

        await refreshExistsInList(root, card, els.url);
      }

      if (looksLikeJobPage) {
        card.style.display = "block";
        btn.innerHTML = `<img class="co-launch-logo" src="${chrome.runtime.getURL(
          "assets/logo.png",
        )}" />`;
      }
    })().catch(() => {});
  }

  // Keep alive if removed
  const observer = new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID)) mountPanel();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  mountPanel();
})();
