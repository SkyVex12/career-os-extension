// remotive.js — CareerOS automation for remotive.com
// Handles list page (scrape + start) and job detail page (GPT gen + apply click)

(function () {
  "use strict";

  const PANEL_ID = "co-remotive-panel";
  const OVERLAY_ID = "co-remotive-overlay";
  const STYLE_ID = "co-remotive-style";

  // ---- Utilities ----

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function waitForElement(selectors, timeoutMs = 15000) {
    const sels = Array.isArray(selectors) ? selectors : [selectors];
    return new Promise((resolve) => {
      function check() {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el) return el;
        }
        return null;
      }
      const found = check();
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = check();
        if (el) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  async function apiCall(path, opts = {}) {
    const p = path.startsWith("/") ? path : `/${path}`;
    const resp = await chrome.runtime.sendMessage({
      type: "CO_API",
      payload: {
        path: p,
        method: opts.method || "GET",
        query: opts.query,
        json: opts.json,
      },
    });
    return resp || { ok: false };
  }

  // ---- Page type detection ----

  function isListPage() {
    // /remote-jobs  or  /remote-jobs/category  (1 or 2 segments)
    const segs = location.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    return segs[0] === "remote-jobs" && segs.length <= 2;
  }

  function isDetailPage() {
    // /remote-jobs/category/job-slug  (exactly 3 segments)
    // also handle /remote/jobs/category/job-slug just in case of redirect
    const segs = location.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    return (
      (segs[0] === "remote-jobs" && segs.length === 3) ||
      (segs[0] === "remote" && segs[1] === "jobs" && segs.length >= 4)
    );
  }

  // ---- Date helpers ----

  function parseRelativeDate(text) {
    const t = (text || "").toLowerCase().trim();

    // Remotive uses "-1d ago", "-2d ago", "-3h ago" format
    const remotiveMatch = t.match(/^-(\d+)([dhm])\s*ago$/);
    if (remotiveMatch) {
      const n = parseInt(remotiveMatch[1], 10);
      const unit = remotiveMatch[2];
      const d = new Date();
      if (unit === 'd') d.setDate(d.getDate() - n);
      else if (unit === 'h') d.setHours(d.getHours() - n);
      else if (unit === 'm') d.setMinutes(d.getMinutes() - n);
      return d;
    }

    if (
      t === "today" ||
      t.includes("hour") ||
      t.includes("minute") ||
      t.includes("just now") ||
      t.includes("second") ||
      t.includes("0d") ||
      t === "-0d ago"
    ) {
      return new Date();
    }
    if (t === "yesterday" || t === "1 day ago" || t === "-1d ago") {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d;
    }
    const daysMatch = t.match(/(\d+)\s*day/);
    if (daysMatch) {
      const d = new Date();
      d.setDate(d.getDate() - parseInt(daysMatch[1], 10));
      return d;
    }
    const weeksMatch = t.match(/(\d+)\s*week/);
    if (weeksMatch) {
      const d = new Date();
      d.setDate(d.getDate() - parseInt(weeksMatch[1], 10) * 7);
      return d;
    }
    const parsed = new Date(text);
    if (!isNaN(parsed.getTime())) return parsed;
    return null;
  }

  function isAfterYesterday(date) {
    if (!date) return false;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 1);
    cutoff.setHours(0, 0, 0, 0);
    return date >= cutoff;
  }

  // ---- Styles ----

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; bottom: 24px; left: 24px; z-index: 2147483647;
        font-family: Arial, sans-serif; font-size: 13px;
      }
      #${PANEL_ID} .co-r-card {
        background: #fff; border-radius: 14px; padding: 14px 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,.22); border: 1px solid rgba(0,0,0,.08);
        min-width: 300px; max-width: 380px;
      }
      #${PANEL_ID} .co-r-title {
        font-weight: 900; font-size: 14px; margin-bottom: 10px;
        display: flex; align-items: center; gap: 8px;
      }
      #${PANEL_ID} .co-r-btn {
        display: inline-block; padding: 9px 16px; border: 0;
        border-radius: 10px; cursor: pointer; font-weight: 900;
        font-size: 13px; color: #fff;
      }
      #${PANEL_ID} .co-r-btn-green { background: #16a34a; }
      #${PANEL_ID} .co-r-btn-green:hover { background: #15803d; }
      #${PANEL_ID} .co-r-btn-red { background: #dc2626; }
      #${PANEL_ID} .co-r-btn-red:hover { background: #b91c1c; }
      #${PANEL_ID} .co-r-btn:disabled { background: #9ca3af; cursor: not-allowed; }
      #${PANEL_ID} .co-r-status { margin-top: 10px; font-size: 12px; color: #374151; line-height: 1.5; }
      #${PANEL_ID} .co-r-btns { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
      #${PANEL_ID} .co-r-stats {
        display: flex; gap: 14px; margin-top: 10px;
        font-size: 12px; font-weight: 900; display: none;
      }
      #${PANEL_ID} .co-r-stat-applied { color: #16a34a; }
      #${PANEL_ID} .co-r-stat-skipped { color: #d97706; }
      #${PANEL_ID} .co-r-stat-error { color: #dc2626; }
      #${OVERLAY_ID} {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; background: #1e293b; color: #f8fafc;
        border-radius: 12px; padding: 12px 20px;
        font-family: Arial, sans-serif; font-size: 13px;
        box-shadow: 0 4px 24px rgba(0,0,0,.45); max-width: 420px; width: max-content;
        border: 1px solid rgba(255,255,255,.1); text-align: center;
      }
      #${OVERLAY_ID} .co-ov-title { font-weight: 900; font-size: 14px; margin-bottom: 4px; }
      #${OVERLAY_ID} .co-ov-step { color: #94a3b8; font-size: 12px; }
    `;
    document.head.appendChild(style);
  }

  // ---- Overlay (detail page) ----

  function upsertOverlay(title, step) {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = OVERLAY_ID;
      el.innerHTML =
        '<div class="co-ov-title"></div><div class="co-ov-step"></div>';
      document.documentElement.appendChild(el);
    }
    el.querySelector(".co-ov-title").textContent = title;
    el.querySelector(".co-ov-step").textContent = step || "";
  }

  // ---- LIST PAGE ----

  // Each job is <li x-data="...joburl:..."> containing .job-tile
  // All job metadata is on button[data-job-url] (save/apply buttons)
  function scrapeJobCards() {
    return Array.from(document.querySelectorAll('li[x-data*="joburl"]'));
  }

  function getJobUrlFromCard(card) {
    // Prefer a.remotive-url-visit href — this is the real page URL
    // e.g. https://remotive.com/remote-jobs/software-development/fullstack-developer-...
    const link = card.querySelector('a.remotive-url-visit');
    if (link?.href) return link.href;
    // Fallback: data-job-url (may use /remote/jobs/ path which redirects)
    const btn = card.querySelector('[data-job-url]');
    if (btn) return btn.getAttribute('data-job-url');
    return null;
  }

  function getJobTitleFromCard(card) {
    const btn = card.querySelector('[data-job-title]');
    if (btn) return btn.getAttribute('data-job-title');
    const span = card.querySelector('.job-tile-title a span');
    return span ? span.textContent.trim() : '';
  }

  function getJobDateFromCard(card) {
    // data-publication-date="2026-04-07 20:22:00" — most reliable
    const btn = card.querySelector('[data-publication-date]');
    if (btn) {
      const d = new Date(btn.getAttribute('data-publication-date'));
      if (!isNaN(d.getTime())) return d;
    }
    // Fallback: relative text like "-1d ago", "2d ago", "today"
    const dateEl = card.querySelector('.tw-text-xs span');
    if (dateEl) return parseRelativeDate(dateEl.textContent.trim());
    return null;
  }

  function findLoadMoreButton() {
    return Array.from(document.querySelectorAll('button, a')).find((el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      return (
        t.includes('load more') ||
        t.includes('more jobs') ||
        t.includes('show more') ||
        t === 'more'
      );
    }) || null;
  }

  async function loadAllJobsAfterYesterday(onProgress) {
    const MAX_CLICKS = 30;
    let clicks = 0;

    while (clicks < MAX_CLICKS) {
      const cards = scrapeJobCards();

      // Find oldest date among cards that have a parseable date
      let oldestDate = null;
      let datesFound = 0;
      for (const card of cards) {
        const d = getJobDateFromCard(card);
        if (d) {
          datesFound++;
          if (!oldestDate || d < oldestDate) oldestDate = d;
        }
      }

      // If we can parse dates and the oldest is before yesterday — stop clicking
      if (datesFound > 0 && oldestDate && !isAfterYesterday(oldestDate)) break;

      const btn = findLoadMoreButton();
      if (!btn) break;

      const prevCount = cards.length;
      onProgress?.(`${prevCount} jobs found, loading more...`);
      btn.click();
      await sleep(2500);

      const newCount = scrapeJobCards().length;
      if (newCount <= prevCount) break; // nothing loaded — stop
      clicks++;
    }
  }

  function injectListPanel() {
    if (document.getElementById(PANEL_ID)) return;
    ensureStyles();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="co-r-card">
        <div class="co-r-title">🤖 CareerOS Automation</div>
        <div class="co-r-status" id="co-r-status-text">Click Start to apply to all recent jobs automatically.</div>
        <div class="co-r-btns">
          <button class="co-r-btn co-r-btn-green" id="co-r-start-btn">▶ Start Automation</button>
          <button class="co-r-btn co-r-btn-red" id="co-r-stop-btn" style="display:none;">■ Stop</button>
        </div>
        <div class="co-r-stats" id="co-r-stats">
          <span id="co-r-job-progress"></span>
          <span class="co-r-stat-applied" id="co-r-applied"></span>
          <span class="co-r-stat-skipped" id="co-r-skipped"></span>
          <span class="co-r-stat-error" id="co-r-errors"></span>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    const statusEl = document.getElementById("co-r-status-text");
    const startBtn = document.getElementById("co-r-start-btn");
    const stopBtn = document.getElementById("co-r-stop-btn");
    const statsEl = document.getElementById("co-r-stats");

    function setStatus(msg) {
      statusEl.textContent = msg;
    }

    function showRunning() {
      startBtn.style.display = "none";
      stopBtn.style.display = "inline-block";
      statsEl.style.display = "flex";
    }

    function showStopped() {
      startBtn.style.display = "inline-block";
      startBtn.disabled = false;
      stopBtn.style.display = "none";
    }

    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      setStatus("Loading all jobs posted after yesterday...");

      try {
        await loadAllJobsAfterYesterday(setStatus);

        const cards = scrapeJobCards();
        const qualifying = [];

        for (const card of cards) {
          const date = getJobDateFromCard(card);
          // Include if date unknown (err on inclusion) or within range
          if (date && !isAfterYesterday(date)) continue;
          const url = getJobUrlFromCard(card);
          const title = getJobTitleFromCard(card);
          if (url && !qualifying.find((q) => q.url === url)) {
            qualifying.push({ url, title });
          }
        }

        if (!qualifying.length) {
          setStatus("No jobs found posted after yesterday.");
          startBtn.disabled = false;
          return;
        }

        setStatus(`Starting automation for ${qualifying.length} jobs...`);
        const resp = await chrome.runtime.sendMessage({
          type: "AUTOMATION_START",
          payload: { queue: qualifying },
        });

        if (!resp?.ok) {
          setStatus(`Failed to start: ${resp?.error || "Unknown error"}`);
          startBtn.disabled = false;
          return;
        }

        showRunning();
        pollStatus(setStatus, showStopped, statsEl);
      } catch (e) {
        setStatus(`Error: ${String(e)}`);
        startBtn.disabled = false;
      }
    });

    stopBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "AUTOMATION_STOP" });
      setStatus("Automation stopped.");
      showStopped();
    });

    // Resume display if automation already running
    chrome.runtime.sendMessage({ type: "AUTOMATION_STATUS" }).then((resp) => {
      if (resp?.active) {
        showRunning();
        pollStatus(setStatus, showStopped, statsEl);
      }
    }).catch(() => {});
  }

  function pollStatus(setStatus, showStopped, statsEl) {
    const interval = setInterval(async () => {
      const resp = await chrome.runtime
        .sendMessage({ type: "AUTOMATION_STATUS" })
        .catch(() => null);
      if (!resp) return;

      const { active, queue, currentIndex, results } = resp;
      const total = queue?.length || 0;
      const applied = results?.filter((r) => r.status === "applied").length || 0;
      const manual  = results?.filter((r) => r.status === "manual").length || 0;
      const skipped = results?.filter((r) => r.status === "skipped").length || 0;
      const errors  = results?.filter((r) => r.status === "error").length || 0;

      const idx = Math.min((currentIndex || 0) + 1, total);
      setStatus(active ? `Processing job ${idx} of ${total}...` : `Done — ${total} jobs processed.`);

      statsEl.style.display = "flex";
      document.getElementById("co-r-job-progress").textContent = `${idx}/${total}`;
      document.getElementById("co-r-applied").textContent = `✅ ${applied}`;
      document.getElementById("co-r-skipped").textContent = `⏭ ${skipped + manual}`;
      document.getElementById("co-r-errors").textContent = `❌ ${errors}`;

      if (!active) {
        clearInterval(interval);
        showStopped();
      }
    }, 2000);
  }

  // ---- DETAIL PAGE ----

  function scrapeDetailPage() {
    // ---- Company ----
    // Most reliable: data-company-name on the detail save button
    let company = "";
    const detailSaveBtn = document.querySelector('.job-save-btn--detail[data-company-name]');
    if (detailSaveBtn) {
      company = detailSaveBtn.getAttribute('data-company-name').trim();
    }
    if (!company) {
      // Fallback: "@Company" span next to the mobile title
      const atSpan = Array.from(document.querySelectorAll('span')).find((el) => {
        const t = el.textContent.trim();
        return t.startsWith('@') && t.length < 120;
      });
      if (atSpan) company = atSpan.textContent.trim().replace(/^@/, '').trim();
    }

    // ---- Position ----
    // h1 on detail page is "[Hiring] Job Title @Company" — strip both affixes
    const h1 = document.querySelector('h1');
    let position = h1?.textContent?.trim() || document.title.split('|')[0].trim();
    // Strip "[Hiring] " prefix (any bracket prefix)
    position = position.replace(/^\[.*?\]\s*/i, '').trim();
    // Strip " @Company" suffix
    if (company) {
      const atSuffix = new RegExp(`\\s*@\\s*${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
      position = position.replace(atSuffix, '').trim();
    }
    // Generic @... suffix strip
    position = position.replace(/\s*@[^@]+$/, '').trim();

    // ---- JD ----
    // The description is inside div.left (the main content column)
    // Use innerText to get clean plain text without HTML tags
    let jd = "";
    const leftDiv = document.querySelector('div.left');
    if (leftDiv) {
      jd = leftDiv.innerText.trim();
    }
    if (!jd) {
      // Fallback: tw-mt-8 section which wraps the description
      const mt8 = document.querySelector('div.tw-mt-8');
      if (mt8) jd = mt8.innerText.trim();
    }
    if (!jd) {
      // Last resort: largest innerText block
      let best = '';
      for (const el of document.querySelectorAll('section, article, main, .tw-mt-8')) {
        const t = el.innerText?.trim() || '';
        if (t.length > best.length) best = t;
      }
      jd = best;
    }

    // ---- Apply URL ----
    // The apply button is: a.remotive-btn-chocolate with href to external board
    // It has target="_blank" — we will force same-tab navigation manually
    const applyLink = document.querySelector('a.remotive-btn-chocolate[href]');

    return { position, company, jd, applyLink };
  }

  // Fill the CareerOS panel fields with scraped job data
  function fillPanelFields(company, position, jd, jobUrl) {
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('co_company', company);
    set('co_position', position);
    set('co_jd', jd);
    set('co_url', jobUrl);
    set('co_source_site', 'remotive');
  }

  function waitForGptResult(mode, timeoutMs = 300000) {
    return new Promise((resolve) => {
      const listener = (msg) => {
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

  async function openGptWithRetry(payload, onRetryStatus) {
    let resp = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      resp = await chrome.runtime.sendMessage({
        type: "CO_GPT_OPEN",
        payload,
      });
      if (resp?.ok) return resp;
      if (resp?.error === "GPT already in progress") {
        onRetryStatus?.(attempt + 1);
        await sleep(2000);
        continue;
      }
      break;
    }
    return resp;
  }

  async function runDetailAutomation() {
    const stored = await chrome.storage.local.get(["automation", "gptUrl", "resume_format", "backend", "userIds"]);
    const automation = stored.automation;

    if (!automation?.active) return;

    const gptUrl = stored.gptUrl || "";
    if (!gptUrl) {
      upsertOverlay("⚙ CareerOS Automation", "❌ GPT URL not configured — open CareerOS panel to set it.");
      await sleep(3000);
      await chrome.runtime.sendMessage({ type: "AUTOMATION_NEXT", payload: { status: "error", reason: "GPT URL not configured" } });
      return;
    }

    upsertOverlay("⚙ CareerOS Automation", "Scraping job info...");
    await sleep(1500);

    const { position, company, jd } = scrapeDetailPage();

    if (!position || jd.length < 50) {
      upsertOverlay("⚙ CareerOS Automation", "❌ Could not scrape job info.");
      await sleep(2000);
      await chrome.runtime.sendMessage({ type: "AUTOMATION_NEXT", payload: { status: "error", reason: "Scrape failed" } });
      return;
    }

    // Fill panel fields so user can see what was scraped
    fillPanelFields(company, position, jd, location.href);

    const jobUrl = location.href;
    const resumeFormat = stored.resume_format || "docx";
    const backendBase = (stored.backend || "https://career-os.onrender.com").replace(/\/$/, "");

    // Resolve user IDs
    let userIds = Array.isArray(stored.userIds) ? stored.userIds : [];
    if (!userIds.length) {
      const r = await apiCall("/v1/users");
      const users = Array.isArray(r.data) ? r.data : r.data?.items || [];
      userIds = users.slice(0, 1).map((u) => String(u.id || u.user_id || u));
    }
    if (!userIds.length) {
      upsertOverlay("⚙ CareerOS Automation", "❌ No users configured.");
      await chrome.runtime.sendMessage({ type: "AUTOMATION_NEXT", payload: { status: "error", reason: "No users" } });
      return;
    }
    const userId = userIds[0];

    // ---- Step 1: GPT Resume ----
    upsertOverlay("⚙ CareerOS Automation", `Generating resume for ${position} @ ${company}...`);

    const note =
      "All required and nice-to-have skills should be reflected in the resume experience and skills sections.";
    const jdWithNote = `${jd}\nIMPORTANT:${note}`;

    // Retry CO_GPT_OPEN if a previous GPT tab is still closing
    const gptOpenResp = await openGptWithRetry(
      { company, position, jd: jdWithNote, gptUrl, mode: "automation_resume", autoClose: true },
      (attempt) => {
        upsertOverlay("CareerOS Automation", `Waiting for previous GPT to close... (${attempt})`);
      },
    );


    const resumeResultPromise = waitForGptResult("automation_resume");

    if (!gptOpenResp?.ok) {
      upsertOverlay("⚙ CareerOS Automation", `❌ GPT open failed: ${gptOpenResp?.error}`);
      await sleep(2000);
      await chrome.runtime.sendMessage({ type: "AUTOMATION_NEXT", payload: { status: "error", reason: gptOpenResp?.error } });
      return;
    }

    const resumeResult = await resumeResultPromise;

    if (resumeResult.timeout || resumeResult.error) {
      const reason = resumeResult.timeout ? "GPT timeout" : resumeResult.error;
      upsertOverlay("⚙ CareerOS Automation", `❌ ${reason}`);
      await chrome.runtime.sendMessage({ type: "AUTOMATION_NEXT", payload: { status: "error", reason } });
      return;
    }

    const rawGptText = (resumeResult.text || "").trim();
    const conversationUrl = resumeResult.conversationUrl || gptUrl;

    // Extract JSON from GPT response — strip markdown fences and surrounding prose
    function extractJson(text) {
      // 1. Try direct parse first
      try { JSON.parse(text); return text; } catch (_) {}
      // 2. Strip ```json ... ``` or ``` ... ``` fences
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        const inner = fenceMatch[1].trim();
        try { JSON.parse(inner); return inner; } catch (_) {}
      }
      // 3. Find the outermost { ... } or [ ... ] block
      const start = text.search(/[{[]/);
      if (start === -1) return text;
      let depth = 0;
      let inStr = false;
      let escape = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (escape) { escape = false; continue; }
        if (c === '\\' && inStr) { escape = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
      }
      return text.slice(start);
    }

    const resumeJson = extractJson(rawGptText);

    // Check blocked
    let parsedResume = null;
    try { parsedResume = JSON.parse(resumeJson); } catch (_) {}
    if (parsedResume?.blocked) {
      const reason = parsedResume.block_reason || "Blocked by GPT";
      upsertOverlay("⚙ CareerOS Automation", `⛔ Skipped: ${reason}`);
      await sleep(2000);
      await chrome.runtime.sendMessage({ type: "AUTOMATION_NEXT", payload: { status: "skipped", reason } });
      return;
    }

    // ---- Step 2: Backend resume generation ----
    console.log("[CareerOS] Step 2: backend generate, userId:", userId, "jobUrl:", jobUrl);
    upsertOverlay("⚙ CareerOS Automation", "Generating resume file...");

    const genResp = await apiCall("/v1/ingest/apply-and-generate", {
      method: "POST",
      json: {
        user_id: userId,
        url: jobUrl,
        company,
        position,
        source_site: "remotive",
        jd_text: jd,
        resume_json_text: resumeJson,
        include_cover_letter: false,
        have_to_generate: true,
      },
    });

    console.log("[CareerOS] Step 2 response:", genResp?.ok, genResp?.status, JSON.stringify(genResp?.data)?.slice(0, 200));

    if (!genResp?.ok) {
      upsertOverlay("⚙ CareerOS Automation", `❌ Backend error: ${genResp?.status}`);
      await chrome.runtime.sendMessage({ type: "AUTOMATION_NEXT", payload: { status: "error", reason: `Backend ${genResp?.status}` } });
      return;
    }

    const genData = genResp.data || {};
    const appId = genData.application_id || genData.applicationId || "";

    // Build resume file URL
    const docxRel =
      genData.resume_docx_download_url ||
      (genData.resume_docx_file_id ? `/v1/files/${genData.resume_docx_file_id}/download` : null);
    const pdfRel =
      genData.resume_pdf_download_url ||
      (genData.resume_pdf_file_id ? `/v1/files/${genData.resume_pdf_file_id}/download` : null);

    const docxUrl = docxRel ? (docxRel.startsWith("http") ? docxRel : backendBase + docxRel) : null;
    const pdfUrl = pdfRel ? (pdfRel.startsWith("http") ? pdfRel : backendBase + pdfRel) : null;

    const useUrl = resumeFormat === "pdf" && pdfUrl ? pdfUrl : docxUrl || pdfUrl;
    const useMime =
      useUrl === pdfUrl && pdfUrl
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const useFilename = useMime === "application/pdf" ? "resume.pdf" : "resume.docx";

    // Download to disk (fire and forget)
    if (useUrl) {
      chrome.runtime
        .sendMessage({
          type: "DOWNLOAD_BLOB_URL",
          payload: { url: useUrl, filename: `CareerOS/${userId}/${appId}/${useFilename}`, saveAs: false },
        })
        .catch(() => {});
    }

    // ---- Step 3: GPT Cover Letter (same conversation) ----
    // ---- Step 3: GPT Cover Letter (same conversation) ----
    console.log("[CareerOS] Step 3: cover letter, conversationUrl:", conversationUrl);
    upsertOverlay("CareerOS Automation", "Generating cover letter...");

    const coverLetterPrompt =
      `Write a cover letter for the position of ${position} in ${company}. ` +
      `Begin with a powerful idea instead of 'I'm applying for...'. ` +
      `Connect my specific experience to the company's exact needs. Keep it under 200 words. ` +
      `Use my resume from our conversation and this job description: ${jd}`;

    const coverResultPromise = waitForGptResult("automation_cover_letter");
    const coverOpenResp = await openGptWithRetry(
      {
        company,
        position,
        jd,
        gptUrl: conversationUrl,
        prompt: coverLetterPrompt,
        mode: "automation_cover_letter",
        autoClose: true,
      },
      (attempt) => {
        upsertOverlay("CareerOS Automation", `Waiting to start cover letter... (${attempt})`);
      },
    );

    let coverLetter = "";
    if (coverOpenResp?.ok) {
      const coverResult = await coverResultPromise;
      if (!coverResult.timeout && !coverResult.error) {
        coverLetter = (coverResult.text || "").trim();
      }
    } else {
      console.warn("[CareerOS] Cover letter GPT open failed:", coverOpenResp?.error);
    }


    console.log("[CareerOS] Step 4: saving context, coverLetter length:", coverLetter.length);
    await chrome.storage.local.set({
      automationJobContext: {
        company,
        position,
        jd,
        jobUrl,
        appId,
        userId,
        resumeJson,
        coverLetter,
        conversationUrl,
        resumeFileInfo: useUrl
          ? { label: `${position} @ ${company}`, url: useUrl, mime: useMime, filename: useFilename }
          : null,
      },
    });

    // ---- Step 5: Navigate to external application page ----
    upsertOverlay("⚙ CareerOS Automation", "Finding apply link...");
    await sleep(500);

    // Collect all a.remotive-btn-chocolate links for debugging
    const allApplyLinks = Array.from(document.querySelectorAll("a.remotive-btn-chocolate[href]"))
      .map(a => a.href);
    console.log("[CareerOS] Step 5: all remotive-btn-chocolate links:", allApplyLinks);

    const externalUrl = allApplyLinks.find(h => !h.includes("remotive.com")) || null;
    console.log("[CareerOS] Step 5: chosen external URL:", externalUrl);

    if (!externalUrl) {
      upsertOverlay("⚙ CareerOS Automation", "❌ External apply link not found.");
      await sleep(3000);
      await chrome.runtime.sendMessage({ type: "AUTOMATION_NEXT", payload: { status: "error", reason: "Apply link not found" } });
      return;
    }

    upsertOverlay("⚙ CareerOS Automation", `Going to ${new URL(externalUrl).hostname}...`);
    console.log("[CareerOS] Step 5: navigating to", externalUrl);

    // Use background to update tab URL — more reliable than window.location on SPA
    await chrome.runtime.sendMessage({
      type: "AUTOMATION_NAVIGATE",
      payload: { url: externalUrl },
    });
    // content.js autofill module takes over on the external page
  }

  // ---- Init ----

  console.log("[CareerOS] remotive.js loaded. pathname:", location.pathname,
    "| isListPage:", isListPage(), "| isDetailPage:", isDetailPage());

  ensureStyles();

  if (isListPage()) {
    console.log("[CareerOS] Injecting list panel");
    injectListPanel();
  } else if (isDetailPage()) {
    console.log("[CareerOS] Detail page detected, starting poll");
    upsertOverlay("⚙ CareerOS Automation", "Loading...");

    let pollAttempts = 0;
    const MAX_POLL = 20; // 20 × 500ms = 10s max

    const pollInterval = setInterval(async () => {
      pollAttempts++;
      try {
        const stored = await chrome.storage.local.get(["automation"]);
        console.log("[CareerOS] Poll attempt", pollAttempts, "automation:", JSON.stringify(stored.automation));

        if (stored.automation?.active) {
          clearInterval(pollInterval);
          upsertOverlay("⚙ CareerOS Automation", "Starting...");
          try {
            await runDetailAutomation();
          } catch (e) {
            upsertOverlay("⚙ CareerOS Automation", `❌ Error: ${String(e)}`);
            console.error("[CareerOS] runDetailAutomation error:", e);
            chrome.runtime
              .sendMessage({ type: "AUTOMATION_NEXT", payload: { status: "error", reason: String(e) } })
              .catch(() => {});
          }
        } else if (pollAttempts >= MAX_POLL) {
          clearInterval(pollInterval);
          console.log("[CareerOS] Automation not active after", MAX_POLL, "attempts — removing overlay");
          const ov = document.getElementById(OVERLAY_ID);
          if (ov) ov.remove();
        }
      } catch (e) {
        clearInterval(pollInterval);
        upsertOverlay("⚙ CareerOS Automation", `❌ Init error: ${String(e)}`);
        console.error("[CareerOS] Poll error:", e);
      }
    }, 500);
  } else {
    console.log("[CareerOS] Page not matched as list or detail — no action taken");
  }
})();
