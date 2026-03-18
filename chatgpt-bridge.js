// chatgpt-bridge.js
// CareerOS: Runs on chatgpt.com to automate sending job info and capturing the response.

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

async function sendResult(payload) {
  try {
    await chrome.runtime.sendMessage({ type: "CO_GPT_RESULT", payload });
  } catch (_) {}
}

(async () => {
  try {
    // Read pending job from storage
    const data = await chrome.storage.local.get(["gptJob"]);
    const job = data.gptJob;

    // Nothing to do if no pending job or already consumed
    if (!job || job.consumed) return;

    // Mark as consumed immediately to prevent duplicate runs
    await chrome.storage.local.set({ gptJob: { ...job, consumed: true } });

    // Wait for ChatGPT's composer input to appear
    const inputEl = await waitForElement(
      ["#prompt-textarea", 'div[contenteditable="true"][tabindex="0"]'],
      25000
    );

    if (!inputEl) {
      await sendResult({
        error:
          "ChatGPT input not found. Make sure you are logged into ChatGPT.",
      });
      return;
    }

    // Let the page settle after input appears
    await sleep(1500);

    // Snapshot existing assistant messages so we can detect the new one
    const baseline = document.querySelectorAll(
      "[data-message-author-role='assistant']"
    ).length;

    // Build the prompt
    const prompt = [
      `Company: ${job.company}`,
      `Position: ${job.position}`,
      "",
      "Job Description:",
      job.jd,
    ].join("\n");

    // Type into the contenteditable input
    inputEl.focus();
    await sleep(200);
    document.execCommand("selectAll", false);
    await sleep(100);
    const inserted = document.execCommand("insertText", false, prompt);

    // Fallback if execCommand didn't work (some browsers restrict it)
    if (!inserted || !(inputEl.textContent || "").trim()) {
      inputEl.textContent = prompt;
      inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, data: prompt }));
    }

    await sleep(600);

    // Click the send button
    const sendBtn = await waitForElement(
      ['button[data-testid="send-button"]', 'button[aria-label*="Send"]'],
      6000
    );

    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      // Fallback: press Enter
      inputEl.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
    }

    // Poll for generation to complete (max 3 minutes)
    const timeout = 180_000;
    const startTime = Date.now();
    let generationStarted = false;

    while (Date.now() - startTime < timeout) {
      const stopBtn = document.querySelector(
        '[data-testid="stop-button"], button[aria-label*="Stop"]'
      );

      if (stopBtn) {
        generationStarted = true;
      } else if (generationStarted) {
        // Stop button disappeared — generation finished
        await sleep(1200); // wait for final render
        break;
      } else if (Date.now() - startTime > 8000) {
        // Never saw a stop button after 8s — check if a new message appeared anyway
        const current = document.querySelectorAll(
          "[data-message-author-role='assistant']"
        ).length;
        if (current > baseline) break;
      }

      await sleep(600);
    }

    // Grab the last assistant message
    const allMsgs = document.querySelectorAll(
      "[data-message-author-role='assistant']"
    );

    if (allMsgs.length <= baseline) {
      await sendResult({
        error:
          "No response received from ChatGPT. Are you logged in and is the GPT accessible?",
      });
      return;
    }

    const lastMsg = allMsgs[allMsgs.length - 1];
    const responseText = (lastMsg.innerText || lastMsg.textContent || "").trim();

    if (!responseText) {
      await sendResult({ error: "GPT response was empty." });
      return;
    }

    await sendResult({ text: responseText });
  } catch (e) {
    await sendResult({ error: `Bridge error: ${String(e)}` });
  }
})();
