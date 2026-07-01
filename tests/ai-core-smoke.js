const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "ai-core.js"), "utf8");
const context = { console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);

const AiCore = context.WebFeedbackAiCore;
if (!AiCore) {
  throw new Error("WebFeedbackAiCore was not exposed");
}

const reliable = AiCore.normalizeProviderFindings([
  {
    block_id: "block_1",
    error_type: "错别字",
    original_text: "确诊按钮",
    suggested_text: "确认按钮",
    reason: "此处语境为操作确认。",
    confidence: 0.95
  },
  {
    block_id: "block_2",
    error_type: "表达优化",
    original_text: "这个文案可以更好",
    suggested_text: "这个文案可以更清晰",
    reason: "风格建议",
    confidence: 0.99
  },
  {
    block_id: "block_3",
    error_type: "错别字",
    original_text: "归纳",
    suggested_text: "归纳",
    reason: "检查文本，没有错别字。",
    confidence: 0.99
  },
  {
    block_id: "block_4",
    error_type: "错别字",
    original_text: "属是",
    suggested_text: "似乎",
    reason: "根据上下文，此处应为表示推测的词。",
    confidence: 0.95,
    context: "这个文件夹属是有点深不可测"
  },
  {
    block_id: "block_5",
    error_type: "错别字",
    original_text: "感觉",
    suggested_text: "认为",
    reason: "语义更明确。",
    confidence: 0.96,
    context: "我感觉这个方案可行。"
  }
]);

if (reliable.length !== 2) {
  throw new Error(`Expected two reliable findings, got ${reliable.length}`);
}

const knownCorrection = reliable.find((item) => item.originalText === "属是");
if (!knownCorrection || knownCorrection.suggestedText !== "属实") {
  throw new Error("Known correction should rewrite 属是 to 属实");
}

if (reliable.some((item) => item.originalText === "感觉")) {
  throw new Error("Semantic rewrite should not be treated as a typo");
}

const normalized = AiCore.normalizeStoredFindings([
  {
    id: "ai_1",
    pageUrl: "https://example.com",
    errorType: "错别字",
    originalText: "确诊按钮",
    suggestedText: "确认按钮",
    reason: "此处语境为操作确认。",
    shape: null
  }
]);

if (normalized[0].renderMode !== AiCore.RENDER_MODE.LIST_ONLY) {
  throw new Error("Unmapped finding should be list-only");
}

const deduped = AiCore.dedupeFindings([normalized[0], { ...normalized[0], id: "ai_2" }]);
if (deduped.length !== 1) {
  throw new Error(`Expected dedupe to keep one finding, got ${deduped.length}`);
}

console.log("ai-core smoke passed");
