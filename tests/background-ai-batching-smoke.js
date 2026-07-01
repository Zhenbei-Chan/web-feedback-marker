const fs = require("fs");
const path = require("path");
const vm = require("vm");

const aiCoreSource = fs.readFileSync(path.join(__dirname, "..", "src", "ai-core.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");

const listeners = [];
const context = {
  console,
  setTimeout,
  clearTimeout,
  fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "[]" } }] }) }),
  importScripts(file) {
    if (file === "ai-core.js") {
      vm.runInContext(aiCoreSource, context);
    }
  },
  chrome: {
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage: () => Promise.resolve()
    },
    tabs: {
      sendMessage: () => Promise.resolve(),
      captureVisibleTab: () => Promise.resolve("")
    },
    notifications: {
      create: () => Promise.resolve(),
      getPermissionLevel: () => Promise.resolve("granted"),
      onClicked: { addListener() {} },
      onClosed: { addListener() {} },
      clear: () => Promise.resolve()
    },
    storage: {
      local: { get: async () => ({}) }
    }
  }
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(backgroundSource, context);

const longText = "这是一个很长的测试句子，用于验证文本块会被拆分。".repeat(90);
context.longText = longText;
const chunks = vm.runInContext("splitOversizedBlocks([{ id: 'block_1', text: globalThis.longText, charCount: globalThis.longText.length }])", context);

if (chunks.length < 2) {
  throw new Error(`Expected long block to split, got ${chunks.length}`);
}

if (chunks.some((chunk) => chunk.text.length > 900)) {
  throw new Error("Expected every chunk to stay within max length");
}

const mapped = vm.runInContext("assignFindingBlockId({ blockId: 'block_1_part_2', originalText: '测试' }, { blocks: [{ id: 'block_1_part_2', sourceBlockId: 'block_1', text: '测试' }] })", context);
if (mapped.blockId !== "block_1") {
  throw new Error(`Expected split block id to map back to block_1, got ${mapped.blockId}`);
}

const objectItems = vm.runInContext("parseJsonArray('{\"items\":[{\"original_text\":\"确诊按钮\"}]}')", context);
if (objectItems.length !== 1) {
  throw new Error("Expected JSON object items to parse");
}

const fencedItems = vm.runInContext("parseJsonArray('```json\\n{\"items\":[{\"original_text\":\"确诊按钮\"}]}\\n```')", context);
if (fencedItems.length !== 1) {
  throw new Error("Expected fenced JSON to parse");
}

const embeddedItems = vm.runInContext("parseJsonArray('检查结果如下：{\"items\":[{\"original_text\":\"确诊按钮\"}]}')", context);
if (embeddedItems.length !== 1) {
  throw new Error("Expected embedded JSON object to parse");
}

const noIssueItems = vm.runInContext("parseJsonArray('未发现问题。')", context);
if (noIssueItems.length !== 0) {
  throw new Error("Expected no-issue text to become an empty result");
}

const structuredFormat = vm.runInContext("getStructuredResponseFormat({ provider: 'zhipu' })", context);
if (structuredFormat.response_format?.type !== "json_object") {
  throw new Error("Expected Zhipu requests to use JSON object response format");
}

console.log("background ai batching smoke passed");
