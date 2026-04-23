// chatgpt-bridge.js
// CareerOS: Runs on chatgpt.com to automate sending job info and capturing the response.
// Jobs are keyed per GPT-tab in the background service worker, so multiple
// origin tabs can run independent generations in parallel.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForElement(selectors, timeoutMs = 20000) {
  const sel = Array.isArray(selectors) ? selectors : [selectors];
  return new Promise((resolve) => {
    const check = () => {
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el) return el;
      }
      return null;
    };

    const found = check();
    if (found) return resolve(found);

    const observer = new MutationObserver(() => {
      const el = check();
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

async function requestJob() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "CO_GPT_GET_JOB" });
    return resp?.job || null;
  } catch (_) {
    return null;
  }
}

async function activateSelf() {
  try {
    await chrome.runtime.sendMessage({ type: "CO_ACTIVATE_SELF" });
  } catch (_) {}
}

async function acquireTypingLock() {
  try {
    await chrome.runtime.sendMessage({ type: "CO_GPT_ACQUIRE_TYPING" });
  } catch (_) {}
}

async function releaseTypingLock() {
  try {
    await chrome.runtime.sendMessage({ type: "CO_GPT_RELEASE_TYPING" });
  } catch (_) {}
}

async function waitForFocus(maxMs = 2500) {
  const start = Date.now();
  while (!document.hasFocus() && Date.now() - start < maxMs) {
    await sleep(100);
  }
  return document.hasFocus();
}

// ChatGPT uses ProseMirror-style contenteditable, which ignores naive
// textContent assignment. Try a ladder of increasingly aggressive methods
// and verify the DOM actually reflects the prompt before proceeding.
async function typePrompt(inputEl, prompt) {
  const readText = () => (inputEl.textContent || "").trim();

  inputEl.focus();
  await sleep(80);

  // Method 1: execCommand (works when document is focused)
  try {
    document.execCommand("selectAll", false);
    await sleep(40);
    document.execCommand("insertText", false, prompt);
  } catch (_) {}
  await sleep(120);
  if (readText()) return true;

  // Method 2: synthetic paste with clipboard data
  try {
    inputEl.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", prompt);
    inputEl.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      }),
    );
  } catch (_) {}
  await sleep(120);
  if (readText()) return true;

  // Method 3: direct textContent + InputEvent (last resort)
  try {
    inputEl.textContent = prompt;
    inputEl.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: prompt,
      }),
    );
  } catch (_) {}
  await sleep(120);
  return !!readText();
}

async function sendResult(payload) {
  try {
    await chrome.runtime.sendMessage({ type: "CO_GPT_RESULT", payload });
  } catch (_) {}
}

function getLastAssistantText(baseline) {
  const all = document.querySelectorAll(
    "[data-message-author-role='assistant']",
  );
  if (all.length <= baseline) return "";
  const last = all[all.length - 1];
  // Prefer textContent: it does not depend on layout/visibility, so it
  // still returns the real text in backgrounded tabs (innerText can lag).
  return (last.textContent || last.innerText || "").trim();
}

function hasCompletionMarker(baseline) {
  const all = document.querySelectorAll(
    "[data-message-author-role='assistant']",
  );
  if (all.length <= baseline) return false;
  const last = all[all.length - 1];
  const turn = last.closest("article") || last.parentElement || last;
  // These action buttons are only rendered after the message finishes
  // streaming (copy / thumbs up / regenerate etc.).
  return !!turn.querySelector(
    [
      '[data-testid="copy-turn-action-button"]',
      '[data-testid="good-response-turn-action-button"]',
      '[data-testid="voice-play-turn-action-button"]',
      'button[aria-label*="Copy"]',
      'button[aria-label*="Good response"]',
    ].join(", "),
  );
}

// Wait until generation has actually finished AND the rendered text has been
// stable for a window. Three independent signals must agree: (1) the stop
// button disappeared, (2) a post-generation action button (copy/regenerate)
// is now rendered on the last message, (3) the text hasn't changed for a
// while. Relying on any single signal produced early captures, especially
// for backgrounded tabs where rendering is throttled.
async function waitForStableOutput(baseline, opts = {}) {
  const {
    maxMs = 240_000,
    stableMs = 3500,
    pollMs = 500,
    postStopGraceMs = 1500,
    noStopGraceMs = 20000,
    postFlushWaitMs = 4000,
  } = opts;

  const started = Date.now();
  let sawStop = false;
  let stopDisappearedAt = 0;
  let lastText = "";
  let lastChangeAt = Date.now();
  let flushActivatedAt = 0;

  while (Date.now() - started < maxMs) {
    const stopBtn = document.querySelector(
      '[data-testid="stop-button"], button[aria-label*="Stop"]',
    );
    const currentText = getLastAssistantText(baseline);

    if (currentText && currentText !== lastText) {
      lastText = currentText;
      lastChangeAt = Date.now();
    }

    if (stopBtn) {
      sawStop = true;
      stopDisappearedAt = 0;
    } else if (sawStop && !stopDisappearedAt) {
      stopDisappearedAt = Date.now();
    }

    const stableFor = Date.now() - lastChangeAt;
    const stopSettled = sawStop
      ? stopDisappearedAt && Date.now() - stopDisappearedAt >= postStopGraceMs
      : Date.now() - started >= noStopGraceMs;

    const readyPrimary =
      currentText &&
      stopSettled &&
      stableFor >= stableMs &&
      hasCompletionMarker(baseline);

    // Fallback in case the completion marker never shows up (ChatGPT UI
    // change) — accept text that's been stable for ~3x the normal window.
    const readyFallback =
      currentText && stopSettled && stableFor >= stableMs * 3;

    if (readyPrimary || readyFallback) {
      // If the tab is hidden, ChatGPT may have deferred DOM updates via
      // requestAnimationFrame (paused in background tabs) — meaning the
      // text we just read is likely a stale partial capture. Flash the
      // tab to the foreground so React/RAF can flush pending updates,
      // then fall back into the poll loop to verify stability on the
      // flushed content. Only do this once per run.
      if (document.hidden && !flushActivatedAt) {
        flushActivatedAt = Date.now();
        // Serialize the flush across tabs via the typing lock so multiple
        // finalizing bridges don't thrash each other for focus.
        await acquireTypingLock();
        try {
          await activateSelf();
          await sleep(postFlushWaitMs);
          const flushed = getLastAssistantText(baseline);
          if (flushed && flushed !== lastText) {
            lastText = flushed;
            lastChangeAt = Date.now();
          }
        } finally {
          await releaseTypingLock();
        }
        continue;
      }
      return currentText;
    }

    await sleep(pollMs);
  }

  // Last-ditch: if we've been running hidden the whole time, flush once
  // before giving up so we don't return stale partial text.
  if (document.hidden && !flushActivatedAt) {
    await acquireTypingLock();
    try {
      await activateSelf();
      await sleep(postFlushWaitMs);
    } finally {
      await releaseTypingLock();
    }
  }
  return getLastAssistantText(baseline);
}

(async () => {
  try {
    const job = await requestJob();
    if (!job) return;

    // Wait for ChatGPT's composer input to appear
    const inputEl = await waitForElement(
      ["#prompt-textarea", 'div[contenteditable="true"][tabindex="0"]'],
      25000,
    );

    if (!inputEl) {
      await sendResult({
        error:
          "ChatGPT input not found. Make sure you are logged into ChatGPT.",
      });
      return;
    }

    // Let the page settle after input appears
    await sleep(800);

    // Build the prompt (use custom prompt if provided, e.g. for cover letter)
    const prompt =
      job.prompt ||
      [
        `Company: ${job.company}`,
        `Position: ${job.position}`,
        "",
        "Job Description:",
        job.jd,
      ].join("\n");

    // Acquire the cross-tab typing lock. Multiple GPT tabs opened in
    // rapid succession would otherwise race for focus; only one bridge at
    // a time should be activating its tab and touching the composer.
    // Background releases the lock automatically after 20s as a safety net.
    await acquireTypingLock();

    let baseline = 0;
    let sendClicked = false;
    try {
      await activateSelf();
      await waitForFocus();

      const typed = await typePrompt(inputEl, prompt);
      if (!typed) {
        await sendResult({
          error:
            "Failed to insert prompt into ChatGPT composer (tab may have lost focus).",
        });
        return;
      }

      await sleep(300);

      // Snapshot assistant message count *after* the prompt is in the
      // composer but *before* clicking send — captures any welcome/system
      // message the GPT may have rendered, so we only wait for the new
      // response.
      baseline = document.querySelectorAll(
        "[data-message-author-role='assistant']",
      ).length;

      const sendBtn = await waitForElement(
        ['button[data-testid="send-button"]', 'button[aria-label*="Send"]'],
        6000,
      );

      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        sendClicked = true;
      } else {
        inputEl.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
          }),
        );
        sendClicked = true;
      }

      // Wait briefly for the send to register (user message added to
      // conversation) before releasing — ChatGPT needs focus during this
      // moment for the submission to register reliably.
      await sleep(500);
    } finally {
      await releaseTypingLock();
    }

    if (!sendClicked) {
      await sendResult({ error: "Failed to submit prompt to ChatGPT." });
      return;
    }

    const responseText = await waitForStableOutput(baseline);

    if (!responseText) {
      await sendResult({
        error:
          "No response received from ChatGPT. Are you logged in and is the GPT accessible?",
      });
      return;
    }

    await sendResult({ text: responseText });
  } catch (e) {
    await sendResult({ error: `Bridge error: ${String(e)}` });
  }
})();
