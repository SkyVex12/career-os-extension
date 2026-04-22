// background.js (Manifest V3 service worker)
//
// Supports:
// - CO_SET_AUTH: save backend + auth token in chrome.storage.local
// - CO_API: proxy API requests through background fetch, inject X-Auth-Token
// - DOWNLOAD_BLOB_URL: download blob/object URLs (or http URLs) via chrome.downloads
// - CO_DOWNLOAD_COVER_LETTER_DOCX: generate a minimal DOCX from a string and download it

const DEFAULT_BACKEND = "https://career-os.onrender.com";
const CHATGPT_GPT_URL =
  "https://chatgpt.com/g/g-69bae439336881919d76677f0f547cf4-resume-builder/c/69baf345-f5c8-832a-abf0-24646d3ac559";

// In-flight guards prevent duplicate tab creation when the same message arrives
// twice before storage has been updated.
let gptOpenInFlight = false;
let automationStartInFlight = false;
let automationNextInFlight = false;

async function getConfig() {
  const { backend, authToken } = await chrome.storage.local.get([
    "backend",
    "authToken",
  ]);
  return {
    backend: (backend || DEFAULT_BACKEND).replace(/\/$/, ""),
    authToken: (authToken || "").trim(),
  };
}

function buildUrl(base, path, query) {
  const cleanBase = (base || DEFAULT_BACKEND).replace(/\/$/, "");
  const cleanPath = (path || "").startsWith("/") ? path : `/${path || ""}`;
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  return `${cleanBase}${cleanPath}${qs}`;
}

// --------------------
// Minimal ZIP builder (STORE, no compression) for DOCX
// --------------------
function crc32(bytes) {
  // Standard CRC32 (IEEE)
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function u16(n) {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function encodeUtf8(str) {
  return new TextEncoder().encode(str);
}

function concatUint8(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function makeZipStore(fileEntries) {
  // fileEntries: [{name, data:Uint8Array}]
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of fileEntries) {
    const nameBytes = encodeUtf8(f.name);
    const data = f.data;
    const crc = crc32(data);
    const size = data.length;

    // Local file header
    // signature 0x04034b50
    const localHeader = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(0), // compression 0 = store
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0), // extra len
    ]);

    localParts.push(localHeader, nameBytes, data);

    // Central directory header
    // signature 0x02014b50
    const centralHeader = new Uint8Array([
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk start
      ...u16(0), // internal attrs
      ...u32(0), // external attrs
      ...u32(offset),
    ]);

    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralData = concatUint8(centralParts);
  offset += centralData.length;

  const fileCount = fileEntries.length;

  // End of central directory record
  const eocd = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(fileCount),
    ...u16(fileCount),
    ...u32(centralData.length),
    ...u32(centralStart),
    ...u16(0), // comment length
  ]);

  const out = concatUint8([...localParts, centralData, eocd]);
  return out;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function coverLetterToDocxBytes(text) {
  const safe = String(text || "").replace(/\r\n/g, "\n");
  const lines = safe.split("\n");

  // WordprocessingML paragraph runs.
  // Use <w:br/> for blank lines via empty paragraphs.
  const paras = lines
    .map((line) => {
      if (!line.trim()) {
        return `<w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p>`;
      }
      return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`;
    })
    .join("");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paras}
    <w:sectPr/>
  </w:body>
</w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const files = [
    { name: "[Content_Types].xml", data: encodeUtf8(contentTypesXml) },
    { name: "_rels/.rels", data: encodeUtf8(relsXml) },
    { name: "word/document.xml", data: encodeUtf8(documentXml) },
  ];

  return makeZipStore(files);
}

function uint8ToBase64(u8) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function sanitizeFilename(name) {
  return String(name || "cover_letter.docx")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

// Wait for a download to complete (or fail).
// NOTE: chrome.downloads.download() returns immediately after queuing.
// Without waiting, the UI can appear to download all resumes first and then
// all cover letters. This makes downloads truly per-user in sequence.
function waitForDownloadComplete(downloadId, timeoutMs = 120000) {
  return new Promise((resolve) => {
    if (!downloadId) return resolve({ ok: false, error: "Missing downloadId" });

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch (_) {}
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: "Download timed out" });
    }, timeoutMs);

    const onChanged = (delta) => {
      if (!delta || delta.id !== downloadId) return;
      if (delta.error && delta.error.current) {
        finish({ ok: false, error: delta.error.current });
        return;
      }
      if (delta.state && delta.state.current) {
        if (delta.state.current === "complete") {
          finish({ ok: true });
        } else if (delta.state.current === "interrupted") {
          finish({ ok: false, error: "interrupted" });
        }
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) return;

      // 1) Save token/backend from UI (login screen, settings, etc.)
      if (msg.type === "CO_SET_AUTH") {
        const { token, backend } = msg.payload || {};
        const toSave = {};

        if (typeof backend === "string" && backend.trim()) {
          toSave.backend = backend.trim().replace(/\/$/, "");
        }
        if (typeof token === "string") {
          toSave.authToken = token.trim();
        }

        if (Object.keys(toSave).length) {
          await chrome.storage.local.set(toSave);
        }

        sendResponse({ ok: true });
        return;
      }

      // 2) API proxy
      // payload: { path, method, query, json, headers }
      if (msg.type === "CO_API") {
        const {
          path,
          method = "GET",
          query,
          json,
          headers,
        } = msg.payload || {};
        if (!path || typeof path !== "string") {
          sendResponse({
            ok: false,
            status: 0,
            data: { error: "Missing path" },
          });
          return;
        }

        const cfg = await getConfig();
        const url = buildUrl(cfg.backend, path, query);

        const reqHeaders = new Headers(headers || {});
        // JSON body? ensure content-type
        if (json !== undefined && !reqHeaders.has("Content-Type")) {
          reqHeaders.set("Content-Type", "application/json");
        }
        // Inject token (if present)
        if (cfg.authToken) {
          reqHeaders.set("X-Auth-Token", cfg.authToken);
        }

        const res = await fetch(url, {
          method,
          headers: reqHeaders,
          body: json !== undefined ? JSON.stringify(json) : undefined,
        });

        const ct = (res.headers.get("content-type") || "").toLowerCase();
        let data;
        if (ct.includes("application/json")) {
          data = await res.json();
        } else {
          data = await res.text();
        }

        sendResponse({ ok: res.ok, status: res.status, data });
        return;
      }

      // 3) Download handler (existing)
      if (msg.type === "DOWNLOAD_BLOB_URL") {
        const { url, filename, saveAs } = msg.payload || {};
        if (!url || !filename) {
          sendResponse({ ok: false, error: "Missing url/filename" });
          return;
        }

        const downloadId = await new Promise((resolve) => {
          chrome.downloads.download(
            { url, filename, saveAs: !!saveAs },
            (id) => {
              const err = chrome.runtime.lastError;
              if (err) resolve({ error: err.message });
              else resolve({ id });
            },
          );
        });

        if (!downloadId || downloadId.error) {
          sendResponse({
            ok: false,
            error: downloadId?.error || "Download failed",
          });
          return;
        }

        const waited = await waitForDownloadComplete(downloadId.id);
        if (!waited.ok) {
          sendResponse({
            ok: false,
            error: waited.error || "Download failed",
            downloadId: downloadId.id,
          });
          return;
        }

        sendResponse({ ok: true, downloadId: downloadId.id });
        return;
      }

      // 4a) Generate cover letter DOCX and return as base64 (for file injection)
      if (msg.type === "CO_COVER_LETTER_DOCX_B64") {
        const { text } = msg.payload || {};
        const cl = String(text || "").trim();
        if (!cl) { sendResponse({ ok: false, error: "Empty text" }); return; }
        const docxBytes = coverLetterToDocxBytes(cl);
        sendResponse({ ok: true, b64: uint8ToBase64(docxBytes) });
        return;
      }

      // 4) Generate cover letter DOCX and download
      if (msg.type === "CO_DOWNLOAD_COVER_LETTER_DOCX") {
        const { text, filename, saveAs } = msg.payload || {};
        const cl = String(text || "").trim();
        if (!cl) {
          sendResponse({ ok: false, error: "Empty cover letter text" });
          return;
        }

        const docxBytes = coverLetterToDocxBytes(cl);
        const b64 = uint8ToBase64(docxBytes);
        const mime =
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        const dataUrl = `data:${mime};base64,${b64}`;

        const safeName = filename || "cover_letter.docx";

        const created = await new Promise((resolve) => {
          chrome.downloads.download(
            { url: dataUrl, filename: safeName, saveAs: !!saveAs },
            (id) => {
              const err = chrome.runtime.lastError;
              if (err) resolve({ error: err.message });
              else resolve({ id });
            },
          );
        });

        if (!created || created.error) {
          sendResponse({
            ok: false,
            error: created?.error || "Download failed",
          });
          return;
        }

        const waited = await waitForDownloadComplete(created.id);
        if (!waited.ok) {
          sendResponse({
            ok: false,
            error: waited.error || "Download failed",
            downloadId: created.id,
          });
          return;
        }

        sendResponse({ ok: true, downloadId: created.id });
        return;
      }

      // 5) Open ChatGPT tab for GPT-assisted generation
      // payload: { company, position, jd }
      if (msg.type === "CO_GPT_OPEN") {
        if (gptOpenInFlight) {
          sendResponse({ ok: false, error: "GPT already in progress" });
          return;
        }
        gptOpenInFlight = true;
        try {
        const { company, position, jd, gptUrl, prompt, mode, autoClose } = msg.payload || {};
        const originTabId = sender.tab?.id;

        if (!company || !position) {
          sendResponse({ ok: false, error: "Missing company or position" });
          return;
        }

        if (!gptUrl) {
          sendResponse({ ok: false, error: "GPT URL is not set. Please set it in the login settings." });
          return;
        }

        // Deduplicate: if a GPT tab is already open and not yet consumed, reject duplicate
        const prevJob = (await chrome.storage.local.get(["gptJob"])).gptJob;
        if (prevJob?.gptTabId && !prevJob?.consumed) {
          // Verify the tab still exists
          const tabExists = await chrome.tabs.get(prevJob.gptTabId).then(() => true).catch(() => false);
          if (tabExists) {
            sendResponse({ ok: false, error: "GPT already in progress" });
            return;
          }
        }

        // Close any stale GPT tab
        if (prevJob?.gptTabId) {
          chrome.tabs.remove(prevJob.gptTabId).catch(() => {});
        }

        const newJob = { company, position, jd: jd || "", originTabId, consumed: false, prompt: prompt || null, mode: mode || "resume", autoClose: !!autoClose, gptTabId: null };
        await chrome.storage.local.set({ gptJob: newJob });

        const gptTab = await chrome.tabs.create({ url: gptUrl, active: true });
        await chrome.storage.local.set({ gptJob: { ...newJob, gptTabId: gptTab.id } });

        sendResponse({ ok: true });
        return;
        } finally {
          gptOpenInFlight = false;
        }
      }

      // 6) GPT response from chatgpt-bridge.js — relay to origin tab and optionally close GPT tab
      // payload: { text, conversationUrl } on success, { error } on failure
      if (msg.type === "CO_GPT_RESULT") {
        const stored = await chrome.storage.local.get(["gptJob", "close_gpt_tab"]);
        const originTabId = stored.gptJob?.originTabId;

        if (originTabId) {
          chrome.tabs
            .sendMessage(originTabId, {
              type: "CO_GPT_RESULT",
              text: msg.payload?.text || null,
              error: msg.payload?.error || null,
              mode: stored.gptJob?.mode || "resume",
              conversationUrl: msg.payload?.conversationUrl || null,
            })
            .catch(() => {});
        }

        // Clear the active GPT tab marker before closing it so the next GPT step
        // (for example cover letter right after resume) can start immediately.
        if (stored.gptJob) {
          await chrome.storage.local.set({
            gptJob: {
              ...stored.gptJob,
              consumed: true,
              gptTabId: null,
            },
          });
        }

        // Close the ChatGPT tab if user opted in OR if automation requested auto-close
        const shouldClose = stored.gptJob?.autoClose || stored.close_gpt_tab;
        const tabToClose = stored.gptJob?.gptTabId || sender.tab?.id;
        if (shouldClose && tabToClose) {
          chrome.tabs.remove(tabToClose).catch(() => {});
        }

        sendResponse({ ok: true });
        return;
      }

      // 7) Fetch a backend file with auth and return base64 — used for "Fill Upload Field"
      if (msg.type === "CO_FETCH_FILE") {
        const { url } = msg.payload || {};
        if (!url) {
          sendResponse({ ok: false, error: "Missing url" });
          return;
        }
        const cfg = await getConfig();
        const headers = new Headers();
        if (cfg.authToken) headers.set("X-Auth-Token", cfg.authToken);
        const res = await fetch(url, { headers });
        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP ${res.status}` });
          return;
        }
        const ab = await res.arrayBuffer();
        const b64 = uint8ToBase64(new Uint8Array(ab));
        const ct = res.headers.get("content-type") || "application/octet-stream";
        sendResponse({ ok: true, b64, contentType: ct });
        return;
      }

      // 8) Automation: start queue
      if (msg.type === "AUTOMATION_START") {
        if (automationStartInFlight) {
          sendResponse({ ok: false, error: "Automation start already in progress" });
          return;
        }
        automationStartInFlight = true;
        try {
        const { queue } = msg.payload || {};
        if (!Array.isArray(queue) || !queue.length) {
          sendResponse({ ok: false, error: "Empty queue" });
          return;
        }

        // Resume from currentIndex if a stopped automation exists
        const existing = (await chrome.storage.local.get(["automation"])).automation;
        const canResume = existing && !existing.active && Array.isArray(existing.queue) && existing.queue.length > 0;

        const resumeQueue = canResume ? existing.queue : queue;
        const rawIndex = canResume ? (existing.currentIndex || 0) : 0;
        // If index is past the end (previous run completed fully), start fresh
        const resumeIndex = rawIndex < resumeQueue.length ? rawIndex : 0;
        const resumeResults = (canResume && resumeIndex > 0) ? (existing.results || []) : [];
        const startUrl = resumeQueue[resumeIndex].url;

        // Write storage FIRST so the new tab reads active:true immediately on load
        await chrome.storage.local.set({
          automation: {
            active: true,
            tabId: -1,
            queue: resumeQueue,
            currentIndex: resumeIndex,
            results: resumeResults,
          },
          automationJobContext: null,
        });

        const tab = await chrome.tabs.create({ url: startUrl, active: true });

        // Update with real tabId
        await chrome.storage.local.set({
          automation: {
            active: true,
            tabId: tab.id,
            queue: resumeQueue,
            currentIndex: resumeIndex,
            results: resumeResults,
          },
        });

        sendResponse({ ok: true, tabId: tab.id, resumedFrom: resumeIndex });
        return;
        } finally {
          automationStartInFlight = false;
        }
      }

      // 9) Automation: advance to next job
      if (msg.type === "AUTOMATION_NEXT") {
        if (automationNextInFlight) {
          sendResponse({ ok: true, ignored: true, reason: "advance already in progress" });
          return;
        }
        automationNextInFlight = true;
        try {
        const { status, reason } = msg.payload || {};
        const stored = await chrome.storage.local.get(["automation"]);
        const automation = stored.automation;

        if (!automation) {
          sendResponse({ ok: false, error: "No automation state" });
          return;
        }

        const senderTabId = sender.tab?.id;
        if (automation.tabId && senderTabId && automation.tabId !== senderTabId) {
          sendResponse({ ok: true, ignored: true, reason: "stale automation tab" });
          return;
        }

        const results = [...(automation.results || [])];
        const queue = automation.queue || [];
        const currentIndex = automation.currentIndex || 0;

        results.push({
          url: queue[currentIndex]?.url || "",
          status: status || "applied",
          reason: reason || null,
        });

        const nextIndex = currentIndex + 1;

        if (nextIndex >= queue.length) {
          await chrome.storage.local.set({
            automation: { ...automation, active: false, currentIndex: nextIndex, results },
            automationJobContext: null,
          });
          sendResponse({ ok: true, done: true });
          return;
        }

        // Open next job in a new tab — keep current tab open (applied confirmation or manual)
        const nextTab = await chrome.tabs.create({ url: queue[nextIndex].url, active: true });

        await chrome.storage.local.set({
          automation: { ...automation, active: true, tabId: nextTab.id, currentIndex: nextIndex, results },
          automationJobContext: null,
        });

        sendResponse({ ok: true });
        return;
        } finally {
          automationNextInFlight = false;
        }
      }

      // 10) Automation: stop
      if (msg.type === "AUTOMATION_STOP") {
        const stored = await chrome.storage.local.get(["automation"]);
        if (stored.automation) {
          await chrome.storage.local.set({
            automation: { ...stored.automation, active: false },
          });
        }
        sendResponse({ ok: true });
        return;
      }

      // 11) Automation: status query
      if (msg.type === "AUTOMATION_STATUS") {
        const stored = await chrome.storage.local.get(["automation"]);
        sendResponse(stored.automation || { active: false });
        return;
      }

      // 12) Automation: navigate the automation tab to an external URL
      if (msg.type === "AUTOMATION_NAVIGATE") {
        const { url } = msg.payload || {};
        if (!url) { sendResponse({ ok: false, error: "Missing url" }); return; }
        const stored = await chrome.storage.local.get(["automation"]);
        const tabId = stored.automation?.tabId;
        if (!tabId) { sendResponse({ ok: false, error: "No automation tab" }); return; }
        await chrome.tabs.update(tabId, { url });
        sendResponse({ ok: true });
        return;
      }

      // Unknown message type: ignore
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: String(e) });
    }
  })();

  return true; // async response
});
