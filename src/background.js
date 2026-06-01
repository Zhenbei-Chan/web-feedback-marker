chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "CAPTURE_VISIBLE_TAB") {
    return false;
  }

  const windowId = sender.tab?.windowId;
  chrome.tabs
    .captureVisibleTab(windowId, { format: "png" })
    .then((dataUrl) => sendResponse({ dataUrl }))
    .catch((error) => sendResponse({ error: error.message || "截图失败。" }));

  return true;
});
