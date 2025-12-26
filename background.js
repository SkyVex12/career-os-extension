// background.js (Manifest V3 service worker)
//
// Supports:
// - CO_SET_AUTH: save backend + auth token in chrome.storage.local
// - CO_API: proxy API requests through background fetch, inject X-Auth-Token
// - DOWNLOAD_BLOB_URL: download blob/object URLs (or http URLs) via chrome.downloads

const DEFAULT_BACKEND = "http://127.0.0.1:8000";

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

      // 3) Download handler (your original feature)
      if (msg.type === "DOWNLOAD_BLOB_URL") {
        const { url, filename, saveAs } = msg.payload || {};
        if (!url || !filename) {
          sendResponse({ ok: false, error: "Missing url/filename" });
          return;
        }

        chrome.downloads.download(
          { url, filename, saveAs: !!saveAs },
          (downloadId) => {
            const err = chrome.runtime.lastError;
            if (err) sendResponse({ ok: false, error: err.message });
            else sendResponse({ ok: true, downloadId });
          }
        );
        return;
      }

      // Unknown message type
      // (Do nothing; keeps console quieter)
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: String(e) });
    }
  })();

  return true; // async response
});
