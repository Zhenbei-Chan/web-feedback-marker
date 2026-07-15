const STORAGE_KEY = "webFeedbackAssistant.items";
const AI_FINDINGS_KEY = "webFeedbackAssistant.aiFindings";
const AI_SETTINGS_KEY = "webFeedbackAssistant.aiSettings";
const AI_SCAN_STATE_KEY = "webFeedbackAssistant.aiScanState";
const GUIDE_SEEN_KEY = "webFeedbackAssistant.popupGuideSeen";
const AiCore = globalThis.WebFeedbackAiCore || createPopupAiCoreFallback();
const PageAccess = globalThis.WebFeedbackPageAccess;
const AiProvider = globalThis.WebFeedbackAiProvider;


function createPopupAiCoreFallback() {
  const RENDER_MODE = {
    MARKER: "marker",
    LIST_ONLY: "listOnly"
  };

  return {
    RENDER_MODE,
    normalizeStoredFindings(items) {
      return (Array.isArray(items) ? items : []).map((item) => {
        const renderMode = item.renderMode || (item.shape ? RENDER_MODE.MARKER : RENDER_MODE.LIST_ONLY);
        return {
          ...item,
          source: item.source || "ai",
          status: item.status || "pending",
          category: item.category || mapFallbackAiCategory(item.errorType),
          renderMode,
          shape: renderMode === RENDER_MODE.MARKER ? item.shape : null
        };
      });
    },
    isDisplayableFinding(item) {
      return item?.status !== "dismissed";
    },
    mapCategory: mapFallbackAiCategory
  };
}

function mapFallbackAiCategory(errorType) {
  const text = String(errorType || "");
  if (/错|漏|多|重复|标点|占位|日期|数字|单位/.test(text)) {
    return "内容错误";
  }
  return "其他";
}
const state = {
  tab: null,
  pageAccessible: false,
  guideSeen: true,
  guideVisible: false,
  page: {
    title: "",
    url: "",
    selectionText: ""
  },
  items: [],
  aiFindings: [],
  aiSettings: null,
  aiScanState: null
};

let aiProgressTimer = 0;
let aiProgressStartedAt = 0;
let aiProgressMessage = "";
let lastPopupWarningLog = "";

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
  aiScanBtn: document.querySelector("#aiScanBtn"),
  aiSettingsOpenBtn: document.querySelector("#aiSettingsOpenBtn"),
  aiSettingsPanel: document.querySelector("#aiSettingsPanel"),
  aiSettingsCloseBtn: document.querySelector("#aiSettingsCloseBtn"),
  aiSettingsSaveBtn: document.querySelector("#aiSettingsSaveBtn"),
  aiProviderSelect: document.querySelector("#aiProviderSelect"),
  aiBaseUrlInput: document.querySelector("#aiBaseUrlInput"),
  aiModelInput: document.querySelector("#aiModelInput"),
  aiApiKeyInput: document.querySelector("#aiApiKeyInput"),
  aiProviderHint: document.querySelector("#aiProviderHint"),
  exportHtmlBtn: document.querySelector("#exportHtmlBtn"),
  exportPdfBtn: document.querySelector("#exportPdfBtn"),
  clearCurrentBtn: document.querySelector("#clearCurrentBtn")
};

init();

async function init() {
  bindEvents();

  try {
    [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.page = {
      title: state.tab?.title || "",
      url: state.tab?.url || "",
      selectionText: ""
    };
    await ensurePageAccess();
    state.pageAccessible = true;
    await injectContentScripts();
    await refreshPageContext();
    await loadGuideState();
    await loadItems();
    await loadAiState();
    await reconcileAiScanState();
    render();
    if (!renderAiScanState()) {
      setStatus("已读取当前页面。");
    }
  } catch (error) {
    render();
    setStatus(getFriendlyErrorMessage(error, "初始化失败。"), true);
  }
}

function bindEvents() {
  els.startAnnotationBtn.addEventListener("click", startAnnotationMode);
  els.aiScanBtn.addEventListener("click", scanCurrentPageWithAi);
  els.aiSettingsOpenBtn.addEventListener("click", openAiSettings);
  els.aiSettingsCloseBtn.addEventListener("click", () => setAiSettingsVisible(false));
  els.aiSettingsSaveBtn.addEventListener("click", saveAiSettings);
  els.aiProviderSelect.addEventListener("change", applyAiProviderPreset);
  els.exportHtmlBtn.addEventListener("click", exportCurrentPageHtml);
  els.exportPdfBtn.addEventListener("click", exportCurrentPagePdf);
  els.clearCurrentBtn.addEventListener("click", clearCurrentPageItems);
  els.guideToggleBtn.addEventListener("click", toggleGuidePanel);
  els.guideDismissBtn.addEventListener("click", dismissGuidePanel);
  els.feedbackList.addEventListener("click", onFeedbackListClick);
  els.status.addEventListener("click", onStatusClick);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
}

async function injectContentScripts() {
  await chrome.scripting.executeScript({
    target: { tabId: state.tab.id },
    files: ["src/ai-core.js", "src/snapshot-core.js", "src/pdf.js", "src/content.js"]
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
    await ensurePageAccess();
    await markGuideSeen();
    await injectContentScripts();
    await chrome.tabs.sendMessage(state.tab.id, { type: "START_ANNOTATION_MODE" });
    window.close();
  } catch (error) {
    setStatus(getFriendlyErrorMessage(error, "无法进入批注模式。"), true);
  }
}

async function scanCurrentPageWithAi() {
  try {
    await ensurePageAccess();
    await loadAiState();
    await reconcileAiScanState();

    if (!isAiConfigured(state.aiSettings)) {
      setAiSettingsVisible(true);
      setStatus("请先完成 AI 检查设置。", true);
      return;
    }

    await ensureAiHostPermission(state.aiSettings);
    await injectContentScripts();
    startAiProgress("正在启动 AI 检查任务...");

    const response = await chrome.tabs.sendMessage(state.tab.id, { type: "AI_SCAN_PAGE" });
    if (response?.error) {
      throw new Error(response.error);
    }

    await loadAiState();
    render();
    if (response?.status === "started" || response?.status === "running") {
      setStatus(response.message || "AI 检查已开始，页面会继续显示进度。");
      return;
    }

    stopAiProgress();
    setStatus(formatAiScanResult(response), response?.status === "no_text" || response?.status === "unmapped");
  } catch (error) {
    stopAiProgress();
    setStatus(getFriendlyErrorMessage(error, "AI 检查失败。"), true);
  }
}

function onRuntimeMessage(message) {
  if (message?.type !== "AI_SCAN_PROGRESS" || message.tabId !== state.tab?.id) {
    return;
  }

  updateAiProgress(message.progress);
}

function onStorageChanged(changes, areaName) {
  if (areaName !== "local") {
    return;
  }

  if (changes[AI_SCAN_STATE_KEY]) {
    state.aiScanState = changes[AI_SCAN_STATE_KEY].newValue || null;
    renderAiScanState();
  }

  if (changes[AI_FINDINGS_KEY]) {
    state.aiFindings = AiCore.normalizeStoredFindings(Array.isArray(changes[AI_FINDINGS_KEY].newValue) ? changes[AI_FINDINGS_KEY].newValue : []);
    render();
  }
}

function startAiProgress() {
  aiProgressStartedAt = Date.now();
  aiProgressMessage = "AI 检查进行中，进度见页面右下角。";
  els.aiScanBtn.disabled = true;
  setStatus(aiProgressMessage);
  window.clearInterval(aiProgressTimer);
}

function updateAiProgress(progress) {
  if (!progress) {
    return;
  }

  aiProgressMessage = "AI 检查进行中，进度见页面右下角。";
  setStatus(aiProgressMessage);
}

function stopAiProgress() {
  window.clearInterval(aiProgressTimer);
  aiProgressTimer = 0;
  aiProgressStartedAt = 0;
  aiProgressMessage = "";
  els.aiScanBtn.disabled = !state.page.url;
}

function renderAiScanState() {
  const scanState = state.aiScanState;
  if (!scanState || scanState.pageUrl !== state.page.url) {
    return false;
  }

  if (scanState.status === "running") {
    const progress = scanState.progress || {};
    if (!aiProgressTimer) {
      startAiProgress(scanState.message || "AI 检查进行中...");
    }
    updateAiProgress({
      ...progress,
      message: scanState.message || progress.message
    });
    return true;
  }

  stopAiProgress();
  setStatus(formatAiScanResult(scanState), scanState.status === "no_text" || scanState.status === "unmapped" || scanState.status === "error");
  return true;
}

function formatAiScanResult(response) {
  if (response?.message) {
    return response.message;
  }

  if (response?.status === "error") {
    return response.message || "AI 检查失败。";
  }

  const checkedText = response?.checkedChars
    ? `已检查约 ${response.checkedChars} 字`
    : response?.checkedBlocks
    ? "已完成正文检查"
    : "已完成检查";

  if (response?.status === "no_text") {
    return "未发起 AI 检查：当前页面没有提取到可检查正文。";
  }

  if (response?.status === "no_issue") {
    return `AI 检查完成：${checkedText}，未发现待确认问题。`;
  }

  if (response?.status === "unmapped") {
    return `AI 已返回 ${response.rawCount || 0} 条疑似问题，已放入反馈清单；其中部分结果未能在页面画标记。`;
  }

  if (response?.status === "duplicate") {
    return `AI 检查完成：${checkedText}，疑似问题已存在，无新增标记。`;
  }

  return `AI 检查完成：新增 ${response?.count || 0} 条待确认内容。`;
}

async function saveAiSettings() {
  try {
    const settings = readAiSettingsForm();
    if (!AiProvider.isConfigured(settings)) {
      setStatus("请填写完整的 AI 检查设置。", true);
      return;
    }

    await ensureAiHostPermission(settings);
    await chrome.storage.local.set({ [AI_SETTINGS_KEY]: settings });
    state.aiSettings = settings;
    setAiSettingsVisible(false);
    setStatus("AI 检查设置已保存。");
  } catch (error) {
    setStatus(getFriendlyErrorMessage(error, "AI 检查设置保存失败。"), true);
  }
}

function readAiSettingsForm() {
  const provider = els.aiProviderSelect.value || "custom";
  return {
    enabled: true,
    provider,
    baseUrl: els.aiBaseUrlInput.value.trim(),
    model: els.aiModelInput.value.trim(),
    apiKey: AiProvider.resolveApiKey(provider, els.aiApiKeyInput.value, state.aiSettings)
  };
}

async function openAiSettings() {
  try {
    await loadAiState();
    setAiSettingsVisible(true);
    els.aiProviderSelect.focus();
  } catch (error) {
    setStatus(getFriendlyErrorMessage(error, "无法打开 AI 设置。"), true);
  }
}

function applyAiProviderPreset() {
  const preset = AiProvider.getPreset(els.aiProviderSelect.value);
  els.aiBaseUrlInput.value = preset.baseUrl;
  els.aiModelInput.value = preset.model;
  els.aiApiKeyInput.value = "";
  const storedProvider = AiProvider.normalizeSettings(state.aiSettings || {}).provider;
  els.aiApiKeyInput.placeholder = storedProvider === els.aiProviderSelect.value
    ? "已保存；留空保持不变"
    : "请输入该服务的 API Key";
  els.aiProviderHint.textContent = preset.hint;
}

async function ensureAiHostPermission(settings) {
  if (settings?.provider === "mock") {
    return;
  }

  const origin = AiProvider.getOriginPattern(settings?.baseUrl);
  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (hasPermission) {
    return;
  }

  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error("未授权 AI 服务访问权限，无法发起检查。");
  }
}

function isAiConfigured(settings) {
  return AiProvider.isConfigured(settings);
}

async function exportCurrentPageHtml() {
  try {
    await ensurePageAccess();
    const items = getDisplayPageItems();
    if (!items.length) {
      setStatus("当前页面没有可导出的反馈。", true);
      return;
    }

    await injectContentScripts();
    const response = await chrome.tabs.sendMessage(state.tab.id, {
      type: "EXPORT_HTML_REPORT",
      itemIds: items.map((item) => item.id).filter(Boolean)
    });

    if (response?.error) {
      throw new Error(response.error);
    }

    setStatus("快照 HTML 已生成。");
  } catch (error) {
    setStatus(getFriendlyErrorMessage(error, "快照 HTML 导出失败。"), true);
  }
}

async function exportCurrentPagePdf() {
  try {
    const items = getDisplayPageItems();
    const aiFindings = getDisplayAiFindings();
    if (!items.length && !aiFindings.length) {
      setStatus("当前页面没有可导出的反馈。", true);
      return;
    }

    await window.WebFeedbackPdf.exportFeedbackPdf({
      title: state.page.title || "网页反馈",
      url: state.page.url,
      items,
      aiFindings
    });
    setStatus("PDF 已生成。");
  } catch (error) {
    setStatus(getFriendlyErrorMessage(error, "PDF 导出失败。"), true);
  }
}

async function clearCurrentPageItems() {
  const currentUrl = state.page.url;
  const remaining = state.items.filter((item) => item.pageUrl !== currentUrl);
  const remainingAiFindings = state.aiFindings.filter((item) => item.pageUrl !== currentUrl);
  state.items = remaining;
  state.aiFindings = remainingAiFindings;
  await chrome.storage.local.set({
    [STORAGE_KEY]: remaining,
    [AI_FINDINGS_KEY]: remainingAiFindings
  });
  await notifyCurrentTabItemsCleared(currentUrl);
  render();
  setStatus("已清空当前页反馈和 AI 标记。");
}

async function deleteFeedbackItem(itemId) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item || item.pageUrl !== state.page.url) {
    setStatus("没有找到要删除的反馈。", true);
    return;
  }

  const confirmed = window.confirm("确定删除这条反馈吗？");
  if (!confirmed) {
    return;
  }

  state.items = state.items.filter((entry) => entry.id !== itemId);
  await chrome.storage.local.set({ [STORAGE_KEY]: state.items });
  await notifyCurrentTabItemsChanged();
  render();
  setStatus("已删除 1 条反馈。");
}

async function notifyCurrentTabItemsChanged() {
  if (!state.tab?.id) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(state.tab.id, { type: "FEEDBACK_ITEMS_CHANGED" });
  } catch (_error) {
    // The page overlay may not be active. Storage has already been updated.
  }
}

async function notifyCurrentTabItemsCleared(pageUrl) {
  if (!state.tab?.id) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(state.tab.id, {
      type: "CLEAR_CURRENT_PAGE_FEEDBACK",
      pageUrl
    });
  } catch (_error) {
    await notifyCurrentTabItemsChanged();
  }
}

async function loadItems() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  state.items = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function loadAiState() {
  const result = await chrome.storage.local.get([AI_FINDINGS_KEY, AI_SETTINGS_KEY, AI_SCAN_STATE_KEY]);
  state.aiFindings = AiCore.normalizeStoredFindings(Array.isArray(result[AI_FINDINGS_KEY]) ? result[AI_FINDINGS_KEY] : []);
  state.aiSettings = result[AI_SETTINGS_KEY]
    ? AiProvider.normalizeSettings(result[AI_SETTINGS_KEY])
    : null;
  state.aiScanState = result[AI_SCAN_STATE_KEY] || null;
  fillAiSettingsForm();
}

async function reconcileAiScanState() {
  const scanState = state.aiScanState;
  if (!scanState || scanState.pageUrl !== state.page.url || scanState.status !== "running") {
    return;
  }

  let runtimeState = null;
  try {
    runtimeState = await chrome.tabs.sendMessage(state.tab.id, { type: "GET_AI_SCAN_RUNTIME_STATE" });
  } catch (_error) {
    runtimeState = null;
  }

  if (runtimeState?.running) {
    return;
  }

  const interruptedState = {
    ...scanState,
    status: "interrupted",
    message: "上次 AI 检查已中断，请重新开始。",
    updatedAt: new Date().toISOString()
  };
  state.aiScanState = interruptedState;
  await chrome.storage.local.set({ [AI_SCAN_STATE_KEY]: interruptedState });
  stopAiProgress();
}

function fillAiSettingsForm() {
  const settings = state.aiSettings || {};
  els.aiProviderSelect.value = settings.provider || "zhipu";
  const preset = AiProvider.getPreset(els.aiProviderSelect.value);
  els.aiBaseUrlInput.value = settings.baseUrl || preset.baseUrl;
  els.aiModelInput.value = settings.model || preset.model;
  els.aiApiKeyInput.value = "";
  els.aiApiKeyInput.placeholder = settings.apiKey
    ? "已保存；留空保持不变"
    : "只保存在本地";
  els.aiProviderHint.textContent = preset.hint;
}

async function loadGuideState() {
  const result = await chrome.storage.local.get(GUIDE_SEEN_KEY);
  state.guideSeen = result[GUIDE_SEEN_KEY] === true;
  state.guideVisible = !state.guideSeen;
}

function render() {
  els.pageTitle.textContent = state.page.title || "未命名页面";
  els.pageUrl.textContent = state.page.url;

  const items = getDisplayPageItems();
  const aiFindings = getDisplayAiFindings();
  els.currentCount.textContent = `共 ${items.length} 条，AI ${aiFindings.length} 条`;
  els.exportPdfBtn.disabled = items.length === 0 && aiFindings.length === 0;
  els.clearCurrentBtn.disabled = items.length === 0 && aiFindings.length === 0;
  els.startAnnotationBtn.disabled = !state.pageAccessible;
  els.exportHtmlBtn.disabled = !state.pageAccessible || items.length === 0;
  els.aiScanBtn.disabled = !state.pageAccessible || !state.page.url;
  renderAiScanState();

  setGuideVisible(state.guideVisible);
  renderFeedbackList(items, aiFindings);
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

function setAiSettingsVisible(isVisible) {
  els.aiSettingsPanel.hidden = !isVisible;
}

function renderFeedbackList(items, aiFindings = []) {
  const listItems = [
    ...items.map((item) => ({ kind: "manual", item })),
    ...aiFindings.map((item) => ({ kind: "ai", item }))
  ];

  if (!listItems.length) {
    els.feedbackList.innerHTML = `<div class="empty">暂无反馈</div>`;
    return;
  }

  els.feedbackList.innerHTML = listItems
    .map((entry, index) => {
      const item = entry.item;
      if (entry.kind === "ai") {
        return renderAiFindingCard(item, index + 1);
      }

      const typeText = getTypeText(item);
      const image = item.imageDataUrl ? `<img src="${item.imageDataUrl}" alt="反馈截图 ${index + 1}" />` : "";
      const quote = item.selectedText ? `<p>引用：${escapeHtml(limitText(item.selectedText, 72))}</p>` : "";
      const location = `<p>位置：${escapeHtml(getDisplayLocation(item))}</p>`;

      return `
        <article class="feedback-card">
          <div class="feedback-card-head">
            <h3>${index + 1}. [${escapeHtml(item.category)}] ${typeText}反馈</h3>
            <button class="delete-feedback" type="button" data-delete-id="${escapeHtml(item.id)}" aria-label="删除第 ${index + 1} 条反馈">删除</button>
          </div>
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

function renderAiFindingCard(item, number) {
  const locationText = item.renderMode === AiCore.RENDER_MODE.LIST_ONLY
    ? "未定位，未在页面画标记"
    : "已定位到页面文字";
  return `
    <article class="feedback-card feedback-card-ai">
      <div class="feedback-card-head">
        <h3>${number}. [${escapeHtml(item.category || "其他")}] AI 待确认</h3>
        <button class="delete-feedback" type="button" data-delete-ai-id="${escapeHtml(item.id)}" aria-label="删除第 ${number} 条 AI 结果">非问题</button>
      </div>
      <p>类型：${escapeHtml(item.errorType || "疑似问题")} · ${escapeHtml(locationText)}</p>
      <p>原因：${escapeHtml(limitText(item.reason || item.issue || "", 90))}</p>
      ${item.originalText ? `<p>原文：${escapeHtml(limitText(item.originalText, 72))}</p>` : ""}
      ${item.suggestedText ? `<p>建议：${escapeHtml(limitText(item.suggestedText, 72))}</p>` : ""}
    </article>
  `;
}

function getCurrentPageItems() {
  return state.items.filter((item) => item.pageUrl === state.page.url);
}

function getDisplayPageItems() {
  return getCurrentPageItems().slice().reverse();
}

function getCurrentPageAiFindings() {
  return state.aiFindings.filter((item) => item.pageUrl === state.page.url && AiCore.isDisplayableFinding(item));
}

function getDisplayAiFindings() {
  return sortItemsByReadingOrder(getCurrentPageAiFindings());
}

function sortItemsByReadingOrder(items) {
  return items.slice().sort((left, right) => {
    const leftY = getItemSortY(left);
    const rightY = getItemSortY(right);
    if (Math.abs(leftY - rightY) > 24) {
      return leftY - rightY;
    }
    return getItemSortX(left) - getItemSortX(right);
  });
}

function getItemSortY(item) {
  const shape = item?.shape || {};
  const value = shape.y ?? shape.y1 ?? shape.top ?? 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function getItemSortX(item) {
  const shape = item?.shape || {};
  const value = shape.x ?? shape.x1 ?? shape.left ?? 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function onFeedbackListClick(event) {
  const deleteAiButton = event.target.closest("[data-delete-ai-id]");
  if (deleteAiButton) {
    event.preventDefault();
    event.stopPropagation();
    deleteAiFinding(deleteAiButton.dataset.deleteAiId);
    return;
  }

  const deleteButton = event.target.closest("[data-delete-id]");
  if (!deleteButton) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  deleteFeedbackItem(deleteButton.dataset.deleteId);
}
async function deleteAiFinding(itemId) {
  const item = state.aiFindings.find((entry) => entry.id === itemId);
  if (!item || item.pageUrl !== state.page.url) {
    setStatus("没有找到这条 AI 检查结果。", true);
    return;
  }

  const confirmed = window.confirm("确定将这条 AI 结果标记为非问题吗？");
  if (!confirmed) {
    return;
  }

  state.aiFindings = state.aiFindings.filter((entry) => entry.id !== itemId);
  await chrome.storage.local.set({ [AI_FINDINGS_KEY]: state.aiFindings });
  await notifyCurrentTabItemsChanged();
  render();
  setStatus("已移除 1 条 AI 待确认结果。");
}

async function ensurePageAccess() {
  if (!state.tab?.id) {
    throw new Error("没有找到当前标签页。");
  }

  const kind = PageAccess.classifyUrl(state.tab.url || "");
  let fileAccessAllowed = false;
  if (kind === PageAccess.PAGE_KIND.LOCAL_FILE) {
    fileAccessAllowed = Boolean(await chrome.extension.isAllowedFileSchemeAccess());
  }
  const errorMessage = PageAccess.getAccessError({
    url: state.tab.url || "",
    fileAccessAllowed
  });
  if (errorMessage) {
    throw new Error(errorMessage);
  }
  state.pageAccessible = true;
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
  if (isError) {
    lastPopupWarningLog = buildPopupWarningLog(message);
    els.status.innerHTML = `
      <span>${escapeHtml(message || "操作失败。")}</span>
      <button type="button" class="status-copy" data-copy-status-log>复制日志</button>
    `;
  } else {
    els.status.textContent = message;
  }
  els.status.classList.toggle("is-error", isError);
}

function onStatusClick(event) {
  if (!event.target.closest("[data-copy-status-log]")) {
    return;
  }

  copyPopupWarningLog();
}

async function copyPopupWarningLog() {
  try {
    await writePopupClipboardText(lastPopupWarningLog || buildPopupWarningLog("手动复制弹窗警告日志。"));
    setStatus("日志已复制，可发给我定位。");
  } catch (_error) {
    setStatus("日志复制失败，请重新点击复制日志。", true);
  }
}

async function writePopupClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("copy_failed");
  }
}

function buildPopupWarningLog(message) {
  const settings = state.aiSettings
    ? {
      ...state.aiSettings,
      apiKey: state.aiSettings.apiKey ? "[已隐藏]" : ""
    }
    : null;
  return JSON.stringify({
    type: "web-feedback-marker-popup-warning",
    capturedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime?.getManifest?.().version || "",
    warningMessage: String(message || ""),
    page: state.page,
    tab: state.tab
      ? {
        id: state.tab.id,
        url: state.tab.url,
        title: state.tab.title,
        status: state.tab.status
      }
      : null,
    aiScanState: state.aiScanState || null,
    aiSettings: settings
  }, null, 2);
}

function getFriendlyErrorMessage(error, fallback = "操作失败。") {
  const rawMessage = String(error?.message || error || fallback || "").trim();
  if (!rawMessage) {
    return fallback;
  }

  if (/Could not establish connection|Receiving end does not exist|message port closed|Extension context invalidated/i.test(rawMessage)) {
    return "插件暂时无法连接当前页面。请刷新网页后重新打开插件；如果当前是浏览器设置页、Chrome 商店或受保护页面，请换普通网页使用。";
  }

  if (/Cannot access contents|The extensions gallery|chrome:\/\/|edge:\/\//i.test(rawMessage)) {
    return "当前页面不允许插件注入脚本。请在普通网页或已授权的本地 HTML 文件中使用；如果是本地文件，请确认已开启“允许访问文件网址”并刷新页面。";
  }

  if (/Failed to fetch|NetworkError|network/i.test(rawMessage)) {
    return "网络请求失败。请检查网络连接、AI 服务地址，以及是否已授权插件访问该服务。";
  }

  if (/timeout|timed out|AbortError|超时/i.test(rawMessage)) {
    return "AI 检查未完成：服务多次没有返回结果。可以稍后重试；如果多次失败，请换用 Mock 测试模式或响应更快的模型。";
  }

  return rawMessage;
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
