const STORAGE_KEY = "webFeedbackAssistant.items";
const GUIDE_SEEN_KEY = "webFeedbackAssistant.popupGuideSeen";

const state = {
  tab: null,
  guideSeen: true,
  guideVisible: false,
  page: {
    title: "",
    url: "",
    selectionText: ""
  },
  items: []
};

const els = {
  pageTitle: document.querySelector("#pageTitle"),
  pageUrl: document.querySelector("#pageUrl"),
  currentCount: document.querySelector("#currentCount"),
  feedbackList: document.querySelector("#feedbackList"),
  status: document.querySelector("#status"),
  assistPanel: document.querySelector("#assistPanel"),
  guideToggleBtn: document.querySelector("#guideToggleBtn"),
  guideDismissBtn: document.querySelector("#guideDismissBtn"),
  startAnnotationBtn: document.querySelector("#startAnnotationBtn"),
  exportPdfBtn: document.querySelector("#exportPdfBtn"),
  clearCurrentBtn: document.querySelector("#clearCurrentBtn")
};

init();

async function init() {
  bindEvents();

  try {
    [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    ensureHttpLikePage();
    await injectContentScripts();
    await refreshPageContext();
    await loadGuideState();
    await loadItems();
    render();
    setStatus("已读取当前页面。");
  } catch (error) {
    setStatus(error.message || "初始化失败。", true);
  }
}

function bindEvents() {
  els.startAnnotationBtn.addEventListener("click", startAnnotationMode);
  els.exportPdfBtn.addEventListener("click", exportCurrentPagePdf);
  els.clearCurrentBtn.addEventListener("click", clearCurrentPageItems);
  els.guideToggleBtn.addEventListener("click", toggleGuidePanel);
  els.guideDismissBtn.addEventListener("click", dismissGuidePanel);
}

async function injectContentScripts() {
  await chrome.scripting.executeScript({
    target: { tabId: state.tab.id },
    files: ["src/pdf.js", "src/content.js"]
  });
}

async function refreshPageContext() {
  const response = await chrome.tabs.sendMessage(state.tab.id, { type: "GET_PAGE_CONTEXT" });

  state.page = {
    title: response?.title || state.tab.title || "",
    url: response?.url || state.tab.url || "",
    selectionText: response?.selectionText || ""
  };
}

async function startAnnotationMode() {
  try {
    ensureHttpLikePage();
    await markGuideSeen();
    await injectContentScripts();
    await chrome.tabs.sendMessage(state.tab.id, { type: "START_ANNOTATION_MODE" });
    window.close();
  } catch (error) {
    setStatus(error.message || "无法进入批注模式。", true);
  }
}

async function exportCurrentPagePdf() {
  try {
    const items = getCurrentPageItems().slice().reverse();
    if (!items.length) {
      setStatus("当前页面没有可导出的反馈。", true);
      return;
    }

    await window.WebFeedbackPdf.exportFeedbackPdf({
      title: state.page.title || "网页反馈",
      url: state.page.url,
      items
    });
    setStatus("PDF 已生成。");
  } catch (error) {
    setStatus(error.message || "PDF 导出失败。", true);
  }
}

async function clearCurrentPageItems() {
  const currentUrl = state.page.url;
  const remaining = state.items.filter((item) => item.pageUrl !== currentUrl);
  state.items = remaining;
  await chrome.storage.local.set({ [STORAGE_KEY]: remaining });
  render();
  setStatus("已清空当前页面反馈。");
}

async function loadItems() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  state.items = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function loadGuideState() {
  const result = await chrome.storage.local.get(GUIDE_SEEN_KEY);
  state.guideSeen = result[GUIDE_SEEN_KEY] === true;
  state.guideVisible = !state.guideSeen;
}

function render() {
  els.pageTitle.textContent = state.page.title || "未命名页面";
  els.pageUrl.textContent = state.page.url;

  const items = getCurrentPageItems();
  els.currentCount.textContent = `共 ${items.length} 条`;
  els.exportPdfBtn.disabled = items.length === 0;
  els.clearCurrentBtn.disabled = items.length === 0;

  setGuideVisible(state.guideVisible);
  renderFeedbackList(items);
}

function toggleGuidePanel() {
  const shouldShow = els.assistPanel.hidden;
  state.guideVisible = shouldShow;
  setGuideVisible(shouldShow);

  if (!shouldShow) {
    markGuideSeen();
  }
}

async function dismissGuidePanel() {
  state.guideVisible = false;
  setGuideVisible(false);
  await markGuideSeen();
}

async function markGuideSeen() {
  state.guideSeen = true;
  await chrome.storage.local.set({ [GUIDE_SEEN_KEY]: true });
}

function setGuideVisible(isVisible) {
  els.assistPanel.hidden = !isVisible;
  els.guideToggleBtn.setAttribute("aria-expanded", String(isVisible));
}

function renderFeedbackList(items) {
  if (!items.length) {
    els.feedbackList.innerHTML = `<div class="empty">暂无反馈</div>`;
    return;
  }

  els.feedbackList.innerHTML = items
    .map((item, index) => {
      const typeText = getTypeText(item);
      const image = item.imageDataUrl ? `<img src="${item.imageDataUrl}" alt="反馈截图 ${index + 1}" />` : "";
      const quote = item.selectedText ? `<p>引用：${escapeHtml(limitText(item.selectedText, 72))}</p>` : "";
      const location = `<p>位置：${escapeHtml(getDisplayLocation(item))}</p>`;

      return `
        <article class="feedback-card">
          <h3>${index + 1}. [${escapeHtml(item.category)}] ${typeText}反馈</h3>
          <p>时间：${escapeHtml(formatTime(item.createdAt))}</p>
          ${quote}
          <p>内容：${escapeHtml(limitText(item.issue, 80))}</p>
          ${location}
          ${image}
        </article>
      `;
    })
    .join("");
}

function getCurrentPageItems() {
  return state.items.filter((item) => item.pageUrl === state.page.url);
}

function ensureHttpLikePage() {
  if (!state.tab?.id) {
    throw new Error("没有找到当前标签页。");
  }

  if (!/^https?:\/\//i.test(state.tab.url || "")) {
    throw new Error("请在普通网页中使用。");
  }
}

function getTypeText(item) {
  if (item.type === "text") {
    return "文本";
  }
  if (item.type === "region") {
    return "区域";
  }
  if (item.type === "point") {
    return "标记点";
  }
  return "截图";
}

function getDisplayLocation(item) {
  if (item.type === "text" || item.selectedText) {
    return "文本引用附近";
  }

  if (item.type === "region" || item.shape?.type === "region") {
    return "框选区域";
  }

  if (item.type === "point" || item.shape?.type === "point") {
    return "标记点附近";
  }

  return "页面可视区域";
}

function formatTime(value) {
  if (!value) {
    return "";
  }

  return new Date(value).toLocaleString("zh-CN");
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("is-error", isError);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function limitText(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value || "";
  }

  return `${value.slice(0, maxLength)}...`;
}
