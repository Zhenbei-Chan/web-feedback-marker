importScripts("ai-core.js", "ai-provider.js", "snapshot-core.js", "cdp-capture.js");

const AiCore = globalThis.WebFeedbackAiCore;
const AiProvider = globalThis.WebFeedbackAiProvider;
const CdpCapture = globalThis.WebFeedbackCdpCapture;
const AI_SETTINGS_KEY = "webFeedbackAssistant.aiSettings";
const AI_SCAN_MAX_RETRIES = 2;
const AI_SCAN_BATCH_MAX_CHARS = 900;
const AI_SCAN_BLOCK_MAX_CHARS = 900;
const AI_REQUEST_TIMEOUT_MS = 45000;
const CAPTURE_MIN_INTERVAL_MS = 550;

const NOTIFICATION_ICON = "assets/icons/icon-128.png";
const notificationTargets = new Map();
let captureQueue = Promise.resolve();
let fullPageCaptureQueue = Promise.resolve();
let lastCaptureAt = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CAPTURE_VISIBLE_TAB") {
    const windowId = sender.tab?.windowId;
    captureVisibleTabSafely(windowId)
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((error) => sendResponse({ error: error.message || "截图失败。" }));

    return true;
  }

  if (message?.type === "CAPTURE_FULL_PAGE_CDP") {
    const tabId = sender.tab?.id;
    captureFullPageSafely(tabId)
      .then((snapshot) => sendResponse({ snapshot }))
      .catch((error) => sendResponse({ error: error.message || "整页截图失败。" }));

    return true;
  }

  if (message?.type === "AI_SCAN_TEXT") {
    scanTextBlocks(message.blocks, sender)
      .then(async (result) => {
        const findings = result.findings || [];
        let notificationResult = createEmptyNotificationResult();
        if (message.notify) {
          notificationResult = await showAiScanNotification({
            sender,
            title: "AI 检查完成",
            message: `已检查约 ${result.totalChars || 0} 字，返回 ${findings.length} 条候选问题。`,
            priority: 0
          });
        }
        sendResponse({
          findings,
          notificationSent: notificationResult.sent,
          notificationPermission: notificationResult.permissionLevel,
          notificationError: notificationResult.error,
          totalChars: result.totalChars || 0,
          failedBlocks: result.failedBlocks || 0
        });
      })
      .catch(async (error) => {
        const messageText = error.message || "AI 检查失败。";
        let notificationResult = createEmptyNotificationResult();
        if (message.notify) {
          notificationResult = await showAiScanNotification({
            sender,
            title: "AI 检查失败",
            message: messageText,
            priority: 1
          });
        }
        sendResponse({
          error: messageText,
          notificationSent: notificationResult.sent,
          notificationPermission: notificationResult.permissionLevel,
          notificationError: notificationResult.error
        });
      });

    return true;
  }

  if (message?.type === "GET_NOTIFICATION_STATUS") {
    getNotificationStatus()
      .then((status) => sendResponse(status))
      .catch((error) => sendResponse({
        supported: false,
        permissionLevel: "unknown",
        error: normalizeNotificationError(error, "unknown")
      }));

    return true;
  }

  if (message?.type === "SHOW_NOTIFICATION") {
    showExtensionNotification(message, sender)
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((error) => sendResponse({ error: error.message || "通知发送失败。" }));

    return true;
  }

  return false;
});

function captureVisibleTabSafely(windowId) {
  const operation = captureQueue.then(async () => {
    const waitMs = Math.max(0, CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastCaptureAt));
    if (waitMs > 0) {
      await wait(waitMs);
    }
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } finally {
      lastCaptureAt = Date.now();
    }
  });
  captureQueue = operation.catch(() => {});
  return operation;
}

function captureFullPageSafely(tabId) {
  const operation = fullPageCaptureQueue.then(() => CdpCapture.captureFullPage(tabId, chrome.debugger));
  fullPageCaptureQueue = operation.catch(() => {});
  return operation;
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    const target = notificationTargets.get(notificationId);
    notificationTargets.delete(notificationId);
    safeChromeCall(() => chrome.notifications.clear(notificationId));

    if (!target?.tabId) {
      return;
    }

    if (target.windowId) {
      safeChromeCall(() => chrome.windows.update(target.windowId, { focused: true }));
    }
    safeChromeCall(() => chrome.tabs.update(target.tabId, { active: true }));
  });
}

if (chrome.notifications?.onClosed) {
  chrome.notifications.onClosed.addListener((notificationId) => {
    notificationTargets.delete(notificationId);
  });
}

async function showExtensionNotification(message, sender) {
  if (!chrome.notifications?.create) {
    throw new Error("当前浏览器不支持插件系统通知。");
  }

  const status = await getNotificationStatus();
  if (status.permissionLevel !== "granted" && status.permissionLevel !== "unknown") {
    throw new Error(normalizeNotificationError(null, status.permissionLevel));
  }

  const notificationId = `web-feedback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  notificationTargets.set(notificationId, {
    tabId: sender.tab?.id || null,
    windowId: sender.tab?.windowId || null
  });

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: NOTIFICATION_ICON,
    title: limitNotificationText(message.title || "网页反馈标注器", 64),
    message: limitNotificationText(message.message || "任务已完成。", 180),
    contextMessage: limitNotificationText(message.contextMessage || sender.tab?.title || "", 80),
    priority: Number(message.priority || 0)
  });

  return status;
}

function limitNotificationText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : text;
}

function safeChromeCall(callback) {
  try {
    const result = callback();
    if (result?.catch) {
      result.catch(() => {});
    }
  } catch (_error) {
    // Notification click handling is best-effort.
  }
}

async function scanTextBlocks(blocks, sender) {
  const settings = await loadAiSettings();
  validateAiSettings(settings);

  const validBlocks = Array.isArray(blocks)
    ? blocks
      .filter((block) => block?.id && block?.text && block.text.trim().length >= 20)
      .map((block) => {
        const text = String(block.text || "").trim();
        return {
          ...block,
          text,
          charCount: Math.max(0, Number(block.charCount) || text.length)
        };
      })
    : [];

  if (!validBlocks.length) {
    return {
      findings: [],
      totalChars: 0,
      failedBlocks: 0
    };
  }

  const scanBlocks = splitOversizedBlocks(validBlocks);
  const batches = createScanBatches(scanBlocks);
  const findings = [];
  const totalChars = scanBlocks.reduce((sum, block) => sum + block.charCount, 0);
  let doneChars = 0;
  const failedBlocks = [];
  reportAiScanProgress(sender, {
    stage: "start",
    done: 0,
    total: batches.length,
    doneChars,
    totalChars,
    message: "正在准备检查正文..."
  });

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    reportAiScanProgress(sender, {
      stage: "requesting",
      done: index,
      total: batches.length,
      doneChars,
      totalChars,
      message: "正在检查正文..."
    });

    try {
      const blockFindings = await scanSingleBatchWithRetry(settings, batch);
      blockFindings.forEach((finding) => {
        findings.push(finding);
      });
    } catch (error) {
      batch.blocks.forEach((block) => {
        failedBlocks.push({
          id: block.id,
          error: normalizeAiErrorMessage(error?.message || "AI 服务处理该段正文失败。")
        });
      });
    }

    doneChars += batch.charCount;
    reportAiScanProgress(sender, {
      stage: "processing",
      done: index + 1,
      total: batches.length,
      doneChars,
      totalChars,
      found: findings.length,
      message: "正在检查正文..."
    });
  }

  if (failedBlocks.length === scanBlocks.length) {
    reportAiScanProgress(sender, {
      stage: "failed",
      done: 0,
      total: batches.length,
      doneChars: 0,
      totalChars,
      found: 0,
      message: "AI 检查未完成，服务连续请求失败。"
    });
    throw new Error(getAiServiceFailureMessage(failedBlocks[0]?.error));
  }

  reportAiScanProgress(sender, {
    stage: "done",
    done: batches.length,
    total: batches.length,
    doneChars: totalChars,
    totalChars,
    found: findings.length,
    message: "AI 检查请求完成，正在整理结果。"
  });

  return {
    findings: AiCore.dedupeFindings(findings),
    totalChars,
    failedBlocks: failedBlocks.length
  };
}

function createEmptyNotificationResult() {
  return {
    sent: false,
    permissionLevel: "unknown",
    error: ""
  };
}

async function getNotificationStatus() {
  if (!chrome.notifications?.create) {
    return {
      supported: false,
      permissionLevel: "unsupported"
    };
  }

  if (!chrome.notifications?.getPermissionLevel) {
    return {
      supported: true,
      permissionLevel: "unknown"
    };
  }

  const permissionLevel = await chrome.notifications.getPermissionLevel();
  return {
    supported: true,
    permissionLevel: permissionLevel || "unknown"
  };
}

function normalizeNotificationError(error, permissionLevel = "unknown") {
  if (permissionLevel === "denied") {
    return "系统通知未开启：请在 Chrome 设置和系统通知设置中允许 Chrome 发送通知。";
  }

  if (permissionLevel === "unsupported") {
    return "当前浏览器不支持插件系统通知，请回到页面查看检查结果。";
  }

  return error?.message || "通知发送失败：请检查 Chrome 或系统通知设置。";
}

async function showAiScanNotification({ sender, title, message, priority = 0 }) {
  try {
    const status = await showExtensionNotification({
      title,
      message,
      contextMessage: sender.tab?.title || "",
      priority
    }, sender);
    return {
      sent: true,
      permissionLevel: status?.permissionLevel || "unknown",
      error: ""
    };
  } catch (error) {
    let permissionLevel = "unknown";
    try {
      permissionLevel = (await getNotificationStatus()).permissionLevel;
    } catch (_statusError) {
      permissionLevel = "unknown";
    }
    return {
      sent: false,
      permissionLevel,
      error: normalizeNotificationError(error, permissionLevel)
    };
  }
}

function reportAiScanProgress(sender, progress) {
  const payload = {
    type: "AI_SCAN_PROGRESS",
    tabId: sender.tab?.id || null,
    progress
  };

  if (sender.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, payload).catch(() => {});
  }

  chrome.runtime.sendMessage(payload).catch(() => {});
}

async function loadAiSettings() {
  const result = await chrome.storage.local.get(AI_SETTINGS_KEY);
  return AiProvider.normalizeSettings(result[AI_SETTINGS_KEY] || {});
}

function validateAiSettings(settings) {
  AiProvider.validateSettings(settings);
}

function splitOversizedBlocks(blocks) {
  return blocks.flatMap((block) => {
    const text = String(block.text || "").trim();
    if (text.length <= AI_SCAN_BLOCK_MAX_CHARS) {
      return [{ ...block, charCount: text.length }];
    }

    return splitTextIntoChunks(text, AI_SCAN_BLOCK_MAX_CHARS).map((chunk, index) => ({
      ...block,
      id: `${block.id}_part_${index + 1}`,
      sourceBlockId: block.sourceBlockId || block.id,
      text: chunk,
      charCount: chunk.length
    }));
  });
}

function splitTextIntoChunks(text, maxLength) {
  const chunks = [];
  let rest = String(text || "").trim();
  const minSoftCut = Math.floor(maxLength * 0.55);

  while (rest.length > maxLength) {
    const windowText = rest.slice(0, maxLength + 1);
    let cut = Math.max(
      windowText.lastIndexOf("。"),
      windowText.lastIndexOf("！"),
      windowText.lastIndexOf("？"),
      windowText.lastIndexOf("；"),
      windowText.lastIndexOf("."),
      windowText.lastIndexOf("!"),
      windowText.lastIndexOf("?"),
      windowText.lastIndexOf(";")
    );

    if (cut < minSoftCut) {
      cut = Math.max(windowText.lastIndexOf("，"), windowText.lastIndexOf(","));
    }

    if (cut < minSoftCut) {
      cut = maxLength;
    } else {
      cut += 1;
    }

    const chunk = rest.slice(0, cut).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    rest = rest.slice(cut).trim();
  }

  if (rest) {
    chunks.push(rest);
  }

  return chunks;
}

function createScanBatches(blocks) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  blocks.forEach((block) => {
    const charCount = Math.max(0, Number(block.charCount) || String(block.text || "").length);
    if (current.length && currentChars + charCount > AI_SCAN_BATCH_MAX_CHARS) {
      batches.push({
        id: `batch_${batches.length + 1}`,
        blocks: current,
        charCount: currentChars
      });
      current = [];
      currentChars = 0;
    }

    current.push(block);
    currentChars += charCount;
  });

  if (current.length) {
    batches.push({
      id: `batch_${batches.length + 1}`,
      blocks: current,
      charCount: currentChars
    });
  }

  return batches;
}

async function scanSingleBatch(settings, batch) {
  for (let attempt = 0; attempt <= AI_SCAN_MAX_RETRIES; attempt += 1) {
    try {
      return await requestBatchScan(settings, batch);
    } catch (error) {
      if (!isRetryableAiError(error) || attempt === AI_SCAN_MAX_RETRIES) {
        throw error;
      }
      await wait(700 * (attempt + 1));
    }
  }

  return [];
}

async function scanSingleBatchWithRetry(settings, batch) {
  return scanSingleBatch(settings, batch);
}

async function requestBatchScan(settings, batch) {
  if (settings.provider === "mock") {
    return requestMockBatchScan(batch);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  let response;

  try {
    const request = AiProvider.buildRequest(settings, buildBatchPrompt(batch));
    response = await fetch(request.url, {
      ...request.options,
      signal: controller.signal
    });
  } catch (error) {
    const normalized = normalizeAiErrorMessage(error?.name === "AbortError"
      ? `AI 服务响应超时（超过 ${Math.round(AI_REQUEST_TIMEOUT_MS / 1000)} 秒）。`
      : error?.message);
    const wrapped = new Error(normalized);
    wrapped.retryable = true;
    throw wrapped;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(formatAiHttpError(response.status, detail));
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw error;
  }

  let data;
  try {
    data = await response.json();
  } catch (_error) {
    const wrapped = new Error("AI 服务返回的响应不是有效 JSON。");
    wrapped.retryable = true;
    throw wrapped;
  }

  const content = AiProvider.readResponseText(settings.provider, data);
  if (!content) {
    const wrapped = new Error("AI 服务没有返回检查结果，可能是模型响应为空或内容被服务商拦截。");
    wrapped.retryable = true;
    throw wrapped;
  }
  try {
    return AiCore.normalizeProviderFindings(parseJsonArray(content))
      .map((finding) => assignFindingBlockId(finding, batch))
      .filter((finding) => finding.blockId);
  } catch (error) {
    const wrapped = new Error(normalizeAiErrorMessage(error?.message || "AI 返回格式异常。"));
    wrapped.retryable = true;
    throw wrapped;
  }
}

function buildBatchPrompt(batch) {
  return {
    maxOutputTokens: 700,
    systemPrompt: [
      "你是专业的中文网页内容校对助手。",
      "请使用严格低错模式，只检查客观、可证明、可直接定位的错误。",
      "只允许返回这些类型：错别字、错字、别字、多字、漏字、重复字、标点错误、占位符遗漏、占位文本、日期错误、数字错误、单位错误。",
      "不要返回主观表达建议、风格优化、语气优化、普通改写建议、结构建议、标题吸引力建议。",
      "不要判断金额、价格、编号、统计数字是否真实，除非同一段文本内部明显自相矛盾。",
      "如果只是读起来不够顺、不够精炼、可优化，但没有明确错误，不要返回。",
      "错别字、错字、别字、多字、漏字、重复字必须只返回最短错误片段，不要返回整句改写。",
      "错别字建议必须保留原文语义、词性和语气，只做最小文字纠错；不要用近义词、推测词或更书面的表达替换原文。",
      "例如“属是”在表示确实、的确的语境里应建议为“属实”，不要改成“似乎”这类语义改写；无法确认时返回空数组。",
      "如果 original_text 和 suggested_text 相同，或只差空格、大小写、英文品牌大小写，不要返回。",
      "如果 reason 表示没有错误、只是建议检查、无法确定、可能更好，不要返回。",
      "每条结果必须能指出原文、建议文本和明确原因，confidence 必须大于等于 0.82。",
      "只返回 JSON 对象，不要返回解释性文字、Markdown 代码块或自然语言说明。",
      "固定格式为：{\"items\": []}。",
      "如果没有问题，返回 {\"items\": []}。"
    ].join("\n"),
    userPrompt: [
      "请检查以下网页文本块，并按字段返回：",
      "返回 JSON 对象，items 数组里的每一项包含：block_id, error_type, original_text, suggested_text, reason, severity, confidence, context。",
      "block_id 必须使用文本块标题里的 block_id，例如 block_1。",
      "只返回高确定性的低级错误；不确定时宁可返回空数组。",
      "文本块：",
      formatBatchText(batch.blocks)
    ].join("\n")
  };
}

async function requestMockBatchScan(batch) {
  await wait(180);
  const mockItems = [];
  batch.blocks.forEach((block) => {
    const text = String(block.text || "");
    if (text.includes("确诊按钮")) {
      mockItems.push({
        blockId: block.id,
        errorType: "错别字",
        originalText: "确诊按钮",
        suggestedText: "确认按钮",
        reason: "界面操作语境应为“确认按钮”，不是医疗语境的“确诊按钮”。",
        severity: "medium",
        confidence: 0.96,
        context: limitMockContext(text, "确诊按钮")
      });
    }

    if (/Lorem ipsum/i.test(text)) {
      mockItems.push({
        blockId: block.id,
        errorType: "占位文本",
        originalText: "Lorem ipsum",
        suggestedText: "",
        reason: "疑似开发测试占位文本未清理。",
        severity: "high",
        confidence: 0.98,
        context: limitMockContext(text, "Lorem ipsum")
      });
    }

    if (text.includes("重复重复")) {
      mockItems.push({
        blockId: block.id,
        errorType: "重复字",
        originalText: "重复重复",
        suggestedText: "重复",
        reason: "同一词语连续重复，疑似多输入一次。",
        severity: "medium",
        confidence: 0.94,
        context: limitMockContext(text, "重复重复")
      });
    }
  });

  return AiCore.normalizeProviderFindings(mockItems);
}

function limitMockContext(text, needle) {
  const source = String(text || "");
  const index = source.indexOf(needle);
  if (index < 0) {
    return source.slice(0, 120);
  }
  return source.slice(Math.max(0, index - 40), Math.min(source.length, index + needle.length + 40));
}

function formatBatchText(blocks) {
  return blocks
    .map((block) => `[${block.id}]\n${block.text}\n[/${block.id}]`)
    .join("\n\n");
}

function assignFindingBlockId(finding, batch) {
  const knownIds = new Map(batch.blocks.map((block) => [block.id, block.sourceBlockId || block.id]));
  if (finding.blockId && knownIds.has(finding.blockId)) {
    return {
      ...finding,
      blockId: knownIds.get(finding.blockId)
    };
  }

  const matchedBlock = batch.blocks.find((block) => finding.originalText && block.text.includes(finding.originalText));
  return {
    ...finding,
    blockId: matchedBlock?.sourceBlockId || matchedBlock?.id || batch.blocks[0]?.sourceBlockId || batch.blocks[0]?.id || ""
  };
}

function isRetryableAiError(error) {
  return error?.retryable === true || /500|502|503|504|timeout|network|Failed to fetch/i.test(String(error?.message || ""));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAiHttpError(status, detail) {
  const readableDetail = getReadableAiErrorDetail(detail);
  if (status >= 500) {
    return `AI 服务暂时不可用（${status}）。建议稍后重试；如果连续失败，请缩短检查范围或更换模型/服务商。${readableDetail}`;
  }
  if (status === 401 || status === 403) {
    return `AI 服务鉴权失败（${status}）。请检查 API Key、服务地址和模型权限。${readableDetail}`;
  }
  if (status === 429) {
    return `AI 服务请求过于频繁（429）。请稍后重试。${readableDetail}`;
  }
  return `AI 服务请求失败（${status}）。${readableDetail}`;
}

function getReadableAiErrorDetail(detail) {
  const text = String(detail || "").trim();
  if (!text) {
    return "";
  }

  try {
    const jsonText = text.startsWith("{") ? text : text.match(/\{[\s\S]*\}/)?.[0];
    const parsed = JSON.parse(jsonText || text);
    const message = parsed?.error?.message || parsed?.message || parsed?.error;
    return message ? `服务返回：${String(message).slice(0, 120)}。` : "";
  } catch (_error) {
    return `服务返回：${text.slice(0, 120)}。`;
  }
}

function getAiServiceFailureMessage(errorMessage) {
  return normalizeAiErrorMessage(errorMessage || "AI 服务处理失败。可能是服务端临时异常、限流、模型不稳定或当前页面正文触发处理失败。");
}

function normalizeAiErrorMessage(message) {
  const text = String(message || "").trim();
  if (!text) {
    return "AI 检查失败。请稍后重试，或检查 AI 服务设置。";
  }

  if (/不是有效 JSON|返回格式异常|valid JSON|JSON/i.test(text)) {
    return "AI 返回格式异常：服务没有按要求返回可解析的检查结果。插件会自动重试；如果连续出现，请稍后重试或换用响应更稳定的模型。";
  }

  if (/abort|timeout|timed out|超时/i.test(text)) {
    return `AI 检查未完成：AI 服务连续 ${AI_SCAN_MAX_RETRIES + 1} 次未在 ${Math.round(AI_REQUEST_TIMEOUT_MS / 1000)} 秒内返回。当前页面可能文本较长或服务繁忙。可以稍后重试，或改用响应更快的模型 / Mock 测试模式。`;
  }

  if (/Failed to fetch|NetworkError|network/i.test(text)) {
    return "无法连接 AI 服务。请检查网络、服务地址、浏览器是否已授权访问该 AI 服务。";
  }

  return text;
}

function parseJsonArray(content) {
  const text = stripJsonFence(String(content || "").trim());
  if (!text) {
    return [];
  }

  const parsed = parseJsonValue(text);
  if (parsed !== null) {
    return extractFindingArray(parsed);
  }

  if (isNoIssueAiText(text)) {
    return [];
  }

  const embeddedJson = extractEmbeddedJson(text);
  if (embeddedJson) {
    return extractFindingArray(embeddedJson);
  }

  throw new Error("AI 返回内容不是有效 JSON。");
}

function parseJsonValue(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function extractFindingArray(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const candidates = [
    parsed.items,
    parsed.findings,
    parsed.results,
    parsed.errors,
    parsed.data
  ];
  const array = candidates.find(Array.isArray);
  return array || [];
}

function stripJsonFence(text) {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}

function isNoIssueAiText(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  return /没有发现问题|未发现问题|无明显问题|无问题|没有错误|未发现错误|没有检测到|未检测到/.test(normalized);
}

function extractEmbeddedJson(text) {
  const source = String(text || "");
  const objectText = extractBalancedJsonText(source, "{", "}");
  if (objectText) {
    const parsedObject = parseJsonValue(objectText);
    if (parsedObject !== null) {
      return parsedObject;
    }
  }

  const arrayText = extractBalancedJsonText(source, "[", "]");
  if (arrayText) {
    const parsedArray = parseJsonValue(arrayText);
    if (parsedArray !== null) {
      return parsedArray;
    }
  }

  return null;
}

function extractBalancedJsonText(source, openChar, closeChar) {
  const start = source.indexOf(openChar);
  if (start < 0) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return "";
}
