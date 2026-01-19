// background.js (Manifest V3 service worker)
//
// Supports:
// - CO_SET_AUTH: save backend + auth token in chrome.storage.local
// - CO_API: proxy API requests through background fetch, inject X-Auth-Token
// - DOWNLOAD_BLOB_URL: download blob/object URLs (or http URLs) via chrome.downloads
// - CO_DOWNLOAD_COVER_LETTER_DOCX: generate a minimal DOCX from a string and download it

const DEFAULT_BACKEND = "https://career-os.onrender.com";

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

        chrome.downloads.download(
          { url, filename, saveAs: !!saveAs },
          (downloadId) => {
            const err = chrome.runtime.lastError;
            if (err) sendResponse({ ok: false, error: err.message });
            else sendResponse({ ok: true, downloadId });
          },
        );
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

        const safeName = sanitizeFilename(filename || "cover_letter.docx");

        chrome.downloads.download(
          { url: dataUrl, filename: safeName, saveAs: !!saveAs },
          (downloadId) => {
            const err = chrome.runtime.lastError;
            if (err) sendResponse({ ok: false, error: err.message });
            else sendResponse({ ok: true, downloadId });
          },
        );
        return;
      }

      // Unknown message type: ignore
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: String(e) });
    }
  })();

  return true; // async response
});
