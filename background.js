chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "DOWNLOAD_BLOB_URL") return;
  const { url, filename, saveAs } = msg.payload || {};
  if (!url || !filename) {
    sendResponse({ ok: false, error: "Missing url/filename" });
    return true;
  }
  chrome.downloads.download({ url, filename, saveAs: !!saveAs }, (downloadId) => {
    const err = chrome.runtime.lastError;
    if (err) sendResponse({ ok: false, error: err.message });
    else sendResponse({ ok: true, downloadId });
  });
  return true;
});
