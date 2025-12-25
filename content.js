
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
      <button class="co-btn" type="button">CareerOS</button>
      <div class="co-card" style="display:none;">
        <div class="co-head">
          <div class="co-title">CareerOS • Generate Resume (DOCX)</div>
          <button class="co-x" type="button" aria-label="Close">×</button>
        </div>
        <div class="co-body">
          <div class="co-row">
            <div>
              <label>User ID</label>
              <select id="co_userId" class="co-input"></select>
            </div>
            <div>
              <label class="co-hidden">Token</label>
              <input id="co_token" placeholder="EXTENSION_TOKEN" />
            </div>
          </div>

          <label class="co-hidden">Backend URL</label>
          <input id="co_backend" placeholder="http://localhost:8000" />

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

    const btn = root.querySelector(".co-btn");
    const card = root.querySelector(".co-card");
    const closeBtn = root.querySelector(".co-x");
    const statusEl = root.querySelector("#co_status");

    const els = {
      userId: root.querySelector("#co_userId"),
      token: root.querySelector("#co_token"),
      backend: root.querySelector("#co_backend"),
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
      if (card.style.display === "none") openCard(); else closeCard();
    });
    closeBtn.addEventListener("click", closeCard);

    els.url.value = location.href;

    async function loadSettings() {
      const data = await chrome.storage.local.get(["userId","token","backend","company","position"]);
      els.userId.value = data.userId || "u1";
      els.token.value = data.token || "";
      els.backend.value = data.backend || "http://localhost:8000";
      els.company.value = data.company || "";
      els.position.value = data.position || "";
    }
    async function saveSettings() {
      await chrome.storage.local.set({
        userId: els.userId.value.trim(),
        token: els.token.value.trim(),
        backend: els.backend.value.trim(),
        company: els.company.value.trim(),
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
      els.token.addEventListener(ev, saveSettings);
      els.backend.addEventListener(ev, saveSettings);
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
