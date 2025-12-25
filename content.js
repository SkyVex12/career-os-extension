
function isLikelyJobPage() {
  const url = location.href;
  if (/\/jobs\//i.test(url)) return true;
  if (/greenhouse\.io\/.*\/jobs\//i.test(url)) return true;
  if (/lever\.co\/.*\/(?:apply|jobs)/i.test(url)) return true;
  if (/workday\.com/i.test(url)) return true;
  const btn = Array.from(document.querySelectorAll("button,a")).find(el => {
    const t = (el.textContent || "").trim().toLowerCase();
    return t === "apply" || t.includes("apply now");
  });
  return !!btn;
}

async function addToHistory(item) {
  const key = "careeros_history";
  const existing = (await chrome.storage.local.get(key))[key] || [];
  const next = [item, ...existing].slice(0, 50);
  await chrome.storage.local.set({ [key]: next });
}

async function getHistory() {
  const key = "careeros_history";
  return ((await chrome.storage.local.get(key))[key]) || [];
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

const BACKEND_DEFAULT = "http://127.0.0.1:8000";

async function populateUsers(root) {
  const sel = root.querySelector("#co_userId");
  if (!sel || sel.tagName.toLowerCase() !== "select") return;
  try {
    const res = await fetch("http://127.0.0.1:8000/v1/users");
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.items || data.users || []);
    sel.innerHTML = "";
    items.forEach((u) => {
      const id = u.id || u.user_id || u;
      const name = u.name || "";
      const opt = document.createElement("option");
      opt.value = String(id);
      opt.textContent = name ? `${name} (${id})` : String(id);
      sel.appendChild(opt);
    });
    const saved = localStorage.getItem("careeros_user_id") || (items[0]?.id || items[0]?.user_id || "u1");
    sel.value = String(saved);
    sel.addEventListener("change", () => localStorage.setItem("careeros_user_id", sel.value));
  } catch (e) {
    sel.innerHTML = '<option value="u1">u1</option>';
    sel.value = localStorage.getItem("careeros_user_id") || "u1";
  }
}


(() => {
  const PANEL_ID = "careeros-panel-root";
  const STYLE_ID = "careeros-panel-style";

  const url = location.href.toLowerCase();
  const title = (document.title || "").toLowerCase();
  const jobHints = [
    "/jobs", "/job/", "/careers", "/career", "greenhouse", "lever.co", "indeed.com",
    "linkedin.com/jobs", "workday", "apply", "job description", "job posting"
  ];
  const looksLikeJobPage = jobHints.some(h => url.includes(h) || title.includes(h));

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font-family: Arial, sans-serif; }
      #${PANEL_ID} .co-btn { border: 0; border-radius: 999px; padding: 10px 14px; cursor: pointer;
        box-shadow: 0 8px 22px rgba(0,0,0,.2); background: #111; color: #fff; font-weight: 600; }
      #${PANEL_ID} .co-card { width: 360px; max-height: 70vh; overflow: auto; margin-top: 10px;
        border-radius: 14px; background: #fff; box-shadow: 0 10px 30px rgba(0,0,0,.25); border: 1px solid rgba(0,0,0,.08); }
      #${PANEL_ID} .co-head { display:flex; align-items:center; justify-content:space-between; padding: 10px 12px; border-bottom: 1px solid #eee; }
      #${PANEL_ID} .co-title { font-weight: 700; font-size: 13px; }
      #${PANEL_ID} .co-x { border:0; background: transparent; cursor:pointer; font-size: 18px; line-height: 1; padding: 2px 6px; }
      #${PANEL_ID} .co-body { padding: 10px 12px; }
      #${PANEL_ID} label { display:block; font-size: 12px; margin-top: 8px; color:#222; }
      #${PANEL_ID} input, #${PANEL_ID} textarea { width:100%; box-sizing:border-box; margin-top: 4px; padding: 8px; border-radius: 10px;
        border: 1px solid #ddd; font-size: 12px; }
      #${PANEL_ID} textarea { height: 130px; resize: vertical; }
      #${PANEL_ID} .co-row { display:flex; gap:8px; }
      #${PANEL_ID} .co-row > div { flex:1; }
      #${PANEL_ID} .co-action { margin-top: 10px; width:100%; padding: 10px; border:0; border-radius: 12px; cursor:pointer;
        background:#2563eb; color:#fff; font-weight:700; }
      #${PANEL_ID} .co-status { margin-top: 10px; font-size: 12px; white-space: pre-wrap; color:#111; }
      #${PANEL_ID} .co-muted { color:#666; font-size: 11px; margin-top: 8px; }
    `;
    document.documentElement.appendChild(style);
  }

  function buildPanel() {
    const root = document.createElement("div");
    root.id = PANEL_ID;
    root.innerHTML = `
      <button class="co-launch" type="button" aria-label="Open CareerOS"><img class="co-launch-logo" src="${chrome.runtime.getURL(!isLikelyJobPage() ? "assets/closed-logo.png" : "assets/logo.png")}" alt="CareerOS"/></button>
      <div class="co-card" style="display:none;">
        <div class="co-head">
          <div class="co-title"><img src="${chrome.runtime.getURL("assets/logo.png")}" alt="CareerOS" style="height:16px;width:auto;vertical-align:middle"/><span style="margin-left:8px;">Generate Resume (DOCX)</span></div>
          <button class="co-x" type="button" aria-label="Close">×</button>
        </div>
        <div class="co-body">
          <div class="co-row">
            <div>
              <label>User ID</label>
              <select id="co_userId" class="co-input"></select>
            </div>
            <div>
          </div>
          </div>
          <label>Job URL</label>
          <input id="co_url" />

          <label>Company</label>
          <input id="co_company" placeholder="Acme" />

          <label>Position</label>
          <input id="co_position" placeholder="Senior Software Engineer" />

          <label>Job Description (paste)</label>
          <textarea id="co_jd" placeholder="Paste full JD here..."></textarea>

          <button class="co-action" id="co_generate" type="button">Generate</button>
          <div class="co-muted">First time: set base resume via backend PUT /v1/users/{user_id}/base-resume</div>
          <div class="co-status" id="co_status"></div>
        </div>
      </div>
    `;
    return root;
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;
    ensureStyles();

    const root = buildPanel();

    // Attach to <html> instead of <body> to survive some frameworks replacing body content
    document.documentElement.appendChild(root);

    const btn = root.querySelector(".co-launch");
    const card = root.querySelector(".co-card");
    const closeBtn = root.querySelector(".co-x");
    const statusEl = root.querySelector("#co_status");

    const els = {
      userId: root.querySelector("#co_userId"),
      url: root.querySelector("#co_url"),
      company: root.querySelector("#co_company"),
      position: root.querySelector("#co_position"),
      jd: root.querySelector("#co_jd"),
      generate: root.querySelector("#co_generate"),
    };

    function setStatus(msg) { statusEl.textContent = msg; }
    function openCard() { card.style.display = "block"; }
    function closeCard() { card.style.display = "none"; }

    btn.addEventListener("click", () => {
     
      if (card.style.display === "none") {
         btn.innerHTML = `<img class="co-launch-logo" src="${chrome.runtime.getURL("assets/logo.png")}" />`;
        openCard();
      } else {
         btn.innerHTML = `<img class="co-launch-logo" src="${chrome.runtime.getURL("assets/closed-logo.png")}" />`;
        closeCard();
      }
    });
    closeBtn.addEventListener("click", closeCard);

    els.url.value = location.href;

    async function loadSettings() {
      const data = await chrome.storage.local.get(["userId","company","position"]);
      els.userId.value = data.userId || "u1";
                  els.company.value = data.company || "";
      els.position.value = data.position || "";
    }
    async function saveSettings() {
      await chrome.storage.local.set({
        userId: els.userId.value.trim(),company: els.company.value.trim(),
        position: els.position.value.trim(),
      });
    }

    function b64ToBlobUrl(b64, mime) {
      const bytes = atob(b64);
      const arr = new Uint8Array(bytes.length);
      for (let i=0;i<bytes.length;i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: mime });
      return URL.createObjectURL(blob);
    }

    ["change","blur"].forEach(ev => {
      els.userId.addEventListener(ev, saveSettings);
      els.token?.addEventListener(ev, saveSettings);
      els.backend?.addEventListener(ev, saveSettings);
      els.company.addEventListener(ev, saveSettings);
      els.position.addEventListener(ev, saveSettings);
    });

    els.generate.addEventListener("click", async () => {
      const userId = els.userId.value.trim();
      const token = "";
      const backend = "http://127.0.0.1:8000";
      const jobUrl = els.url.value.trim();
      const company = els.company.value.trim();
      const position = els.position.value.trim();
      const jdText = els.jd.value.trim();

      if (!userId || !backend || !jobUrl || !company || !position || jdText.length < 50) {
        setStatus("Missing fields. JD must be at least ~50 chars.");
        return;
      }

      setStatus("Sending to backend...");
      await saveSettings();

      try {
        const res = await fetch(`${backend}/v1/ingest/apply-and-generate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Extension-Token": token,
          },
          body: JSON.stringify({
            user_id: userId,
            url: jobUrl,
            company,
            position,
            jd_text: jdText,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          setStatus(`Backend error (${res.status}):\n${JSON.stringify(data, null, 2)}`);
          return;
        }

        const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (!data.resume_docx_base64) {
  setStatus(`Backend response missing resume_docx_base64.\nRe-download: ${backend}${data.resume_download_url || ""}`);
  return;
}
const docxUrl = b64ToBlobUrl(data.resume_docx_base64, mime);

        const filename = `CareerOS/${userId}/${data.application_id}/resume.docx`;
        const resp = await chrome.runtime.sendMessage({
  type: "DOWNLOAD_BLOB_URL",
  payload: { url: docxUrl, filename, saveAs: true },
});
if (!resp?.ok) {
  setStatus(`✅ Generated, but download failed:\n${resp?.error || "Unknown error"}\nRe-download: ${backend}${data.resume_download_url || ""}`);
  return;
}

        await chrome.storage.local.set({
          lastFileId: data.resume_docx_file_id,
          lastDownloadUrl: `${backend}${data.resume_download_url}`,
        });

        setStatus(`✅ Generated!\napplication_id: ${data.application_id}\nfile_id: ${data.resume_docx_file_id}\nRe-download: ${backend}${data.resume_download_url}`);
      } catch (e) {
        setStatus(`Request failed:\n${String(e)}`);
      }
    });

    loadSettings().then(() => {
      if (looksLikeJobPage) openCard();
    });
  }

  // Many job boards (including Greenhouse) rewrite parts of the DOM after load.
  // We keep the panel alive by re-mounting it if it's removed.
  const observer = new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID)) {
      mountPanel();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Initial mount
  mountPanel();
})();


function renderHistory(panel) {
  const host = panel.querySelector("#co_history");
  if (!host) return;
  getHistory().then(items => {
    host.innerHTML = "";
    if (!items.length) {
      host.innerHTML = '<div class="co-muted">No history yet.</div>';
      return;
    }
    items.slice(0, 10).forEach(it => {
      const row = document.createElement("div");
      row.className = "co-hrow";
      const dt = it.created_at ? new Date(it.created_at).toLocaleString() : "";
      row.innerHTML = `
        <div class="co-hmeta">
          <div class="co-htitle">${escapeHtml(it.company || "")} — ${escapeHtml(it.role || "")}</div>
          <div class="co-hsub">${escapeHtml(it.stage || "")} • ${escapeHtml(dt)}</div>
        </div>
        <div class="co-hactions">
          ${it.resume_download_url ? '<button class="co-btn co-small" data-dl="resume">Resume</button>' : ""}
          ${it.cover_download_url ? '<button class="co-btn co-small" data-dl="cover">Cover</button>' : ""}
        </div>
      `;
      row.querySelectorAll("button[data-dl]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const kind = btn.getAttribute("data-dl");
          const url = kind === "resume" ? it.resume_download_url : it.cover_download_url;
          const filename = (kind === "resume" ? "Resume" : "CoverLetter") + "_" + (it.company || "file").replace(/\W+/g,"_") + ".pdf";
          const abs = url.startsWith("http") ? url : `http://127.0.0.1:8000` + url;
          await chrome.runtime.sendMessage({
            type: "DOWNLOAD_BLOB_URL",
            payload: { url: abs, filename, saveAs: true },
          });
        });
      });
      host.appendChild(row);
    });
  });
}

(function careerosMount() {
  try {
    if (!isLikelyJobPage()) return;
    if (document.getElementById("co_fab")) return;

    const fab = document.createElement("div");
    fab.id = "co_fab";
    fab.className = "co-fab";
    const img = document.createElement("img");
    img.src = chrome.runtime.getURL("icons/icon48.png");
    img.alt = "CareerOS";
    fab.appendChild(img);

    const panel = document.createElement("div");
    panel.id = "co_panel";
    panel.className = "co-panel";
    panel.style.display = "none";
    panel.innerHTML = `
      <div class="co-header">
        <div class="co-title"><img src="${chrome.runtime.getURL("icons/icon48.png")}"/><img src="${chrome.runtime.getURL("assets/logo.png")}" alt="CareerOS" style="height:18px;width:auto;display:block"/></div>
        <button class="co-x" aria-label="Close">×</button>
      </div>
      <div class="co-body">
        <div class="co-muted">Open/close. Your full form panel (if present) will also work.</div>
        <div class="co-section">
          <div style="font-weight:700;margin-bottom:6px">Recent</div>
          <div id="co_history"></div>
        </div>
      </div>
    `;
    panel.querySelector(".co-x")?.addEventListener("click", () => { panel.style.display = "none"; });

    fab.addEventListener("click", () => {
      panel.style.display = (panel.style.display === "none") ? "block" : "none";
      if (panel.style.display !== "none") renderHistory(panel);
    });

    document.body.appendChild(fab);
    document.body.appendChild(panel);
  } catch (e) {}
})();
