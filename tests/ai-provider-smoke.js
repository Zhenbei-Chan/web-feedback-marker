const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "ai-provider.js"), "utf8");
const context = { console, URL };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);

const Provider = context.WebFeedbackAiProvider;
if (!Provider) {
  throw new Error("WebFeedbackAiProvider was not exposed");
}

const geminiPreset = Provider.getPreset("gemini");
if (geminiPreset.model !== "gemini-3.5-flash") {
  throw new Error(`Unexpected Gemini model preset: ${geminiPreset.model}`);
}

const geminiRequest = Provider.buildRequest({
  enabled: true,
  provider: "gemini",
  baseUrl: geminiPreset.baseUrl,
  model: geminiPreset.model,
  apiKey: "gemini-test-key"
}, {
  systemPrompt: "system",
  userPrompt: "user",
  maxOutputTokens: 700
});

if (!geminiRequest.url.endsWith("/models/gemini-3.5-flash:generateContent")) {
  throw new Error(`Unexpected Gemini endpoint: ${geminiRequest.url}`);
}
if (geminiRequest.options.headers["x-goog-api-key"] !== "gemini-test-key") {
  throw new Error("Gemini should use x-goog-api-key authentication");
}
if (geminiRequest.options.headers.Authorization) {
  throw new Error("Gemini native requests must not use Bearer authentication");
}

const geminiText = Provider.readResponseText("gemini", {
  candidates: [{ content: { parts: [{ text: "{\"items\":[]}" }] } }]
});
if (geminiText !== '{"items":[]}') {
  throw new Error("Gemini response text was not extracted");
}

const customRequest = Provider.buildRequest({
  enabled: true,
  provider: "custom",
  baseUrl: "https://example.test/api",
  model: "custom-model",
  apiKey: "custom-key"
}, {
  systemPrompt: "system",
  userPrompt: "user",
  maxOutputTokens: 700
});
if (customRequest.url !== "https://example.test/api/v1/chat/completions") {
  throw new Error(`Unexpected OpenAI-compatible endpoint: ${customRequest.url}`);
}
if (customRequest.options.headers.Authorization !== "Bearer custom-key") {
  throw new Error("OpenAI-compatible requests should use Bearer authentication");
}

const openAiText = Provider.readResponseText("custom", {
  choices: [{ message: { content: [{ type: "text", text: "{\"items\":[]}" }] } }]
});
if (openAiText !== '{"items":[]}') {
  throw new Error("OpenAI-compatible response text was not extracted");
}

if (Provider.getOriginPattern(geminiPreset.baseUrl) !== "https://generativelanguage.googleapis.com/*") {
  throw new Error("Gemini host permission pattern is incorrect");
}

const migrated = Provider.normalizeSettings({
  provider: "custom",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  model: "gemini-3.5-flash",
  apiKey: "old-key"
});
if (migrated.provider !== "gemini") {
  throw new Error("Previous native Gemini custom settings should migrate to the Gemini adapter");
}
const migratedRoot = Provider.normalizeSettings({
  provider: "custom",
  baseUrl: "https://generativelanguage.googleapis.com",
  model: "gemini-3.5-flash"
});
if (migratedRoot.baseUrl !== "https://generativelanguage.googleapis.com/v1beta") {
  throw new Error("A Gemini root URL should normalize to the v1beta API base");
}

if (Provider.resolveApiKey("gemini", "", {
  provider: "zhipu",
  apiKey: "zhipu-key"
})) {
  throw new Error("API keys must not be reused across providers");
}
if (Provider.resolveApiKey("zhipu", "", {
  provider: "zhipu",
  apiKey: "zhipu-key"
}) !== "zhipu-key") {
  throw new Error("An unchanged provider should preserve its stored API key");
}

console.log("ai provider smoke passed");
