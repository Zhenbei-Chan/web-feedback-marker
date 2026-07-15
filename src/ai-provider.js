(function exposeAiProvider(global) {
  "use strict";

  const PROVIDER_PRESETS = Object.freeze({
    zhipu: Object.freeze({
      label: "智谱 AI",
      protocol: "openaiCompatible",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4-flash",
      hint: "使用智谱 OpenAI 兼容接口。"
    }),
    deepseek: Object.freeze({
      label: "DeepSeek",
      protocol: "openaiCompatible",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      hint: "使用 DeepSeek OpenAI 兼容接口。"
    }),
    gemini: Object.freeze({
      label: "Google Gemini",
      protocol: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3.5-flash",
      hint: "使用 Gemini 原生 generateContent 接口，不是 OpenAI 兼容接口。"
    }),
    custom: Object.freeze({
      label: "OpenAI-compatible",
      protocol: "openaiCompatible",
      baseUrl: "",
      model: "",
      hint: "仅适用于兼容 OpenAI Chat Completions 协议的服务。"
    }),
    mock: Object.freeze({
      label: "Mock 测试模式",
      protocol: "mock",
      baseUrl: "",
      model: "mock-fixed-json",
      hint: "仅在本地返回固定测试结果，不发送网络请求。"
    })
  });

  function getPreset(provider) {
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
    return { ...preset };
  }

  function getProtocol(provider) {
    return getPreset(provider).protocol;
  }

  function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function normalizeSettings(settings = {}) {
    let baseUrl = normalizeBaseUrl(settings.baseUrl);
    let provider = settings.provider || "zhipu";
    if (
      provider === "custom" &&
      /^https:\/\/generativelanguage\.googleapis\.com\//i.test(`${baseUrl}/`) &&
      !/\/openai(?:\/|$)/i.test(baseUrl)
    ) {
      provider = "gemini";
    }
    if (provider === "gemini" && /^https:\/\/generativelanguage\.googleapis\.com$/i.test(baseUrl)) {
      baseUrl = `${baseUrl}/v1beta`;
    }
    return {
      ...settings,
      provider,
      baseUrl
    };
  }

  function isConfigured(settings) {
    const normalized = normalizeSettings(settings);
    if (normalized.provider === "mock") {
      return true;
    }
    return Boolean(
      normalized.enabled &&
      normalized.baseUrl &&
      String(normalized.model || "").trim() &&
      String(normalized.apiKey || "").trim()
    );
  }

  function resolveApiKey(provider, enteredApiKey, storedSettings) {
    const entered = String(enteredApiKey || "").trim();
    if (entered) {
      return entered;
    }
    const stored = normalizeSettings(storedSettings || {});
    return stored.provider === provider ? String(stored.apiKey || "").trim() : "";
  }

  function validateSettings(settings) {
    const normalized = normalizeSettings(settings);
    if (normalized.provider === "mock") {
      return;
    }
    if (!normalized.enabled) {
      throw new Error("AI 检查未启用，请先完成设置。");
    }
    if (!normalized.baseUrl || !String(normalized.model || "").trim() || !String(normalized.apiKey || "").trim()) {
      throw new Error("AI 检查设置不完整，请填写服务地址、模型和 API Key。");
    }
    getOriginPattern(normalized.baseUrl);
  }

  function getOriginPattern(baseUrl) {
    let url;
    try {
      url = new URL(normalizeBaseUrl(baseUrl));
    } catch (_error) {
      throw new Error("AI 服务地址无效。");
    }
    if (!["https:", "http:"].includes(url.protocol)) {
      throw new Error("AI 服务地址必须是 http 或 https。");
    }
    return `${url.origin}/*`;
  }

  function buildRequest(settings, prompt = {}) {
    const normalized = normalizeSettings(settings);
    validateSettings(normalized);
    const protocol = getProtocol(normalized.provider);
    if (protocol === "gemini") {
      return buildGeminiRequest(normalized, prompt);
    }
    if (protocol === "openaiCompatible") {
      return buildOpenAiCompatibleRequest(normalized, prompt);
    }
    throw new Error("Mock 测试模式不应发起网络请求。");
  }

  function buildOpenAiCompatibleRequest(settings, prompt) {
    const body = {
      model: String(settings.model || "").trim(),
      temperature: 0.1,
      max_tokens: Number(prompt.maxOutputTokens) || 700,
      messages: [
        { role: "system", content: String(prompt.systemPrompt || "") },
        { role: "user", content: String(prompt.userPrompt || "") }
      ]
    };
    if (settings.provider === "zhipu" || settings.provider === "deepseek") {
      body.response_format = { type: "json_object" };
    }
    return {
      url: getOpenAiCompatibleUrl(settings),
      options: {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${String(settings.apiKey || "").trim()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    };
  }

  function buildGeminiRequest(settings, prompt) {
    const baseUrl = normalizeBaseUrl(settings.baseUrl);
    const model = encodeURIComponent(String(settings.model || "").trim());
    const url = /:generateContent(?:\?.*)?$/i.test(baseUrl)
      ? baseUrl
      : /\/models$/i.test(baseUrl)
        ? `${baseUrl}/${model}:generateContent`
        : `${baseUrl}/models/${model}:generateContent`;
    return {
      url,
      options: {
        method: "POST",
        headers: {
          "x-goog-api-key": String(settings.apiKey || "").trim(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: String(prompt.systemPrompt || "") }]
          },
          contents: [{
            role: "user",
            parts: [{ text: String(prompt.userPrompt || "") }]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: Number(prompt.maxOutputTokens) || 700,
            responseMimeType: "application/json"
          }
        })
      }
    };
  }

  function getOpenAiCompatibleUrl(settings) {
    const baseUrl = normalizeBaseUrl(settings.baseUrl);
    if (/\/chat\/completions$/i.test(baseUrl)) {
      return baseUrl;
    }
    if (settings.provider === "zhipu" || /\/v\d+$/i.test(baseUrl)) {
      return `${baseUrl}/chat/completions`;
    }
    return `${baseUrl}/v1/chat/completions`;
  }

  function readResponseText(provider, data) {
    if (getProtocol(provider) === "gemini") {
      const parts = data?.candidates?.[0]?.content?.parts;
      return Array.isArray(parts)
        ? parts.map((part) => String(part?.text || "")).join("").trim()
        : "";
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content.trim();
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => typeof part === "string" ? part : String(part?.text || part?.content || ""))
        .join("")
        .trim();
    }
    return "";
  }

  global.WebFeedbackAiProvider = Object.freeze({
    PROVIDER_PRESETS,
    getPreset,
    getProtocol,
    normalizeBaseUrl,
    normalizeSettings,
    isConfigured,
    resolveApiKey,
    validateSettings,
    getOriginPattern,
    buildRequest,
    getOpenAiCompatibleUrl,
    readResponseText
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
