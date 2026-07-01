((root) => {
  const MIN_AI_CONFIDENCE = 0.82;
  const STATUS = {
    PENDING: "pending",
    CONFIRMED: "confirmed",
    DISMISSED: "dismissed"
  };
  const LOCATION_STATUS = {
    EXACT: "exact",
    UNMAPPED: "unmapped"
  };
  const RENDER_MODE = {
    MARKER: "marker",
    LIST_ONLY: "listOnly"
  };
  const OBJECTIVE_ERROR_TYPES = [
    "错别字",
    "错字",
    "别字",
    "多字",
    "漏字",
    "重复字",
    "标点错误",
    "占位符遗漏",
    "占位文本",
    "日期错误",
    "数字错误",
    "单位错误"
  ];
  const SUBJECTIVE_ERROR_TYPES = [
    "表达不清",
    "表达歧义",
    "歧义",
    "语气",
    "风格",
    "不够通顺",
    "建议优化",
    "可优化",
    "结构问题",
    "上下文不一致"
  ];
  const UNSUPPORTED_NUMERIC_ERROR_PATTERN = /数字|数值|金额|价格|数量|编号|号码/;
  const TYPO_LIKE_ERROR_PATTERN = /错别字|错字|别字/;
  const KNOWN_TEXT_CORRECTIONS = [
    {
      original: "属是",
      suggested: "属实",
      reason: "常见词应为“属实”，表示确实、的确。"
    }
  ];

  function normalizeProviderFindings(items) {
    return (Array.isArray(items) ? items : [])
      .map(normalizeProviderFinding)
      .filter(isReliableProviderFinding);
  }

  function normalizeProviderFinding(item = {}) {
    const finding = {
      blockId: String(item.block_id || item.blockId || "").trim(),
      errorType: String(item.error_type || item.errorType || "其他").trim() || "其他",
      originalText: String(item.original_text || item.originalText || "").trim(),
      suggestedText: String(item.suggested_text || item.suggestedText || "").trim(),
      reason: String(item.reason || "").trim(),
      severity: normalizeSeverity(item.severity),
      confidence: normalizeConfidence(item.confidence),
      context: String(item.context || "").trim()
    };
    return applyKnownCorrection(finding);
  }

  function normalizeFinding(item = {}) {
    const locationStatus = item.locationStatus || (item.shape ? LOCATION_STATUS.EXACT : LOCATION_STATUS.UNMAPPED);
    const renderMode = item.renderMode || (locationStatus === LOCATION_STATUS.EXACT && item.shape ? RENDER_MODE.MARKER : RENDER_MODE.LIST_ONLY);
    return {
      ...item,
      source: "ai",
      status: item.status || STATUS.PENDING,
      category: item.category || mapCategory(item.errorType),
      errorType: item.errorType || "其他",
      originalText: item.originalText || "",
      suggestedText: item.suggestedText || "",
      reason: item.reason || "",
      severity: normalizeSeverity(item.severity),
      confidence: normalizeConfidence(item.confidence),
      context: item.context || "",
      locationStatus,
      renderMode,
      shape: renderMode === RENDER_MODE.MARKER ? item.shape : null
    };
  }

  function normalizeStoredFindings(items) {
    return (Array.isArray(items) ? items : []).map(normalizeFinding);
  }

  function isDisplayableFinding(item) {
    const finding = normalizeFinding(item);
    if (finding.status === STATUS.CONFIRMED || finding.status === STATUS.DISMISSED) {
      return false;
    }

    if (!finding.originalText || !finding.reason) {
      return false;
    }

    if (finding.suggestedText && isTrivialSuggestion(finding.originalText, finding.suggestedText)) {
      return false;
    }

    if (isNoIssueReason(finding.reason)) {
      return false;
    }

    if (isUnsupportedNumericFinding(finding)) {
      return false;
    }

    return !isOverbroadTypoFinding(finding);
  }

  function shouldRenderPageMarker(item) {
    const finding = normalizeFinding(item);
    return isDisplayableFinding(finding)
      && finding.renderMode === RENDER_MODE.MARKER
      && finding.locationStatus === LOCATION_STATUS.EXACT
      && Boolean(finding.shape);
  }

  function mergeUniqueFindings(newFindings, existingFindings) {
    const seen = new Set(normalizeStoredFindings(existingFindings).map(getDedupKey));
    const uniqueFindings = normalizeStoredFindings(newFindings).filter((finding) => {
      const key = getDedupKey(finding);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    return uniqueFindings;
  }

  function dedupeFindings(findings) {
    const seen = new Set();
    return normalizeStoredFindings(findings).filter((finding) => {
      const key = getDedupKey(finding);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function getDedupKey(finding = {}) {
    return [
      normalizeComparableText(finding.originalText),
      normalizeComparableText(finding.suggestedText),
      normalizeComparableText(finding.reason)
    ].join("|");
  }

  function mapCategory(errorType) {
    const type = String(errorType || "");
    if (/错别字|错字|别字|多字|漏字|重复字|标点|占位|日期|数字|单位|事实/.test(type)) {
      return "内容错误";
    }
    if (/表达|歧义|语病/.test(type)) {
      return "表达不清";
    }
    if (/上下文|结构|不一致|逻辑/.test(type)) {
      return "结构问题";
    }
    return "其他";
  }

  function isReliableProviderFinding(item) {
    if (!item.originalText || !item.reason) {
      return false;
    }

    if (isSubjectiveErrorType(item.errorType) || !isObjectiveErrorType(item.errorType)) {
      return false;
    }

    if (isUnsupportedNumericFinding(item)) {
      return false;
    }

    if (item.confidence !== null && item.confidence < MIN_AI_CONFIDENCE) {
      return false;
    }

    if (requiresSuggestion(item.errorType) && !item.suggestedText) {
      return false;
    }

    if (requiresSuggestion(item.errorType) && isTrivialSuggestion(item.originalText, item.suggestedText)) {
      return false;
    }

    if (isLikelySemanticRewrite(item)) {
      return false;
    }

    if (isNoIssueReason(item.reason)) {
      return false;
    }

    return !isOverbroadTypoFinding(item);
  }

  function isObjectiveErrorType(errorType) {
    return OBJECTIVE_ERROR_TYPES.some((type) => String(errorType || "").includes(type));
  }

  function isSubjectiveErrorType(errorType) {
    return SUBJECTIVE_ERROR_TYPES.some((type) => String(errorType || "").includes(type));
  }

  function isUnsupportedNumericFinding(item) {
    return UNSUPPORTED_NUMERIC_ERROR_PATTERN.test(String(item?.errorType || ""));
  }

  function applyKnownCorrection(finding) {
    const correction = findKnownCorrection(finding.originalText);
    if (!correction) {
      return finding;
    }

    const confidence = finding.confidence === null
      ? 0.9
      : Math.max(finding.confidence, 0.9);
    return {
      ...finding,
      errorType: "错别字",
      suggestedText: correction.suggested,
      reason: correction.reason,
      confidence
    };
  }

  function findKnownCorrection(originalText) {
    const normalizedOriginal = normalizeComparableText(originalText);
    return KNOWN_TEXT_CORRECTIONS.find((correction) => (
      normalizeComparableText(correction.original) === normalizedOriginal
    )) || null;
  }

  function isLikelySemanticRewrite(item) {
    if (!TYPO_LIKE_ERROR_PATTERN.test(String(item?.errorType || ""))) {
      return false;
    }

    const original = normalizeComparableText(item.originalText);
    const suggested = normalizeComparableText(item.suggestedText);
    if (!original || !suggested || isTrivialSuggestion(original, suggested)) {
      return false;
    }

    const originalChars = Array.from(original);
    const suggestedChars = Array.from(suggested);
    if (Math.max(originalChars.length, suggestedChars.length) > 4) {
      return false;
    }

    const originalCjk = originalChars.filter(isCjkChar);
    const suggestedCjk = suggestedChars.filter(isCjkChar);
    if (!originalCjk.length || !suggestedCjk.length) {
      return false;
    }

    return !suggestedCjk.some((char) => originalCjk.includes(char));
  }

  function isCjkChar(char) {
    return /[\u3400-\u9fff]/.test(char);
  }

  function requiresSuggestion(errorType) {
    return !/占位/.test(String(errorType || ""));
  }

  function normalizeComparableText(value) {
    return String(value || "")
      .replace(/\s+/g, "")
      .replace(/[“”]/g, "\"")
      .replace(/[‘’]/g, "'")
      .trim();
  }

  function isTrivialSuggestion(originalText, suggestedText) {
    const original = normalizeComparableText(originalText);
    const suggested = normalizeComparableText(suggestedText);
    return Boolean(original && suggested && (original === suggested || original.toLowerCase() === suggested.toLowerCase()));
  }

  function isNoIssueReason(reason) {
    const text = String(reason || "").replace(/\s+/g, "");
    return !text
      || /没有错误|无错误|未发现错误|没有错别字|无明显错误|看起来都相同|检查文本|确保没有|无法确定|不确定/.test(text)
      || text === "无"
      || text === "无。";
  }

  function isOverbroadTypoFinding(item) {
    const type = String(item?.errorType || "");
    if (!/错别字|错字|别字|多字|漏字|重复字/.test(type)) {
      return false;
    }

    const originalLength = Array.from(item.originalText || "").length;
    const suggestedLength = Array.from(item.suggestedText || "").length;
    return Math.max(originalLength, suggestedLength) > 12;
  }

  function normalizeSeverity(value) {
    const normalized = String(value || "").toLowerCase();
    return ["low", "medium", "high"].includes(normalized) ? normalized : "medium";
  }

  function normalizeConfidence(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return null;
    }
    return Math.max(0, Math.min(1, number));
  }

  root.WebFeedbackAiCore = {
    STATUS,
    LOCATION_STATUS,
    RENDER_MODE,
    normalizeProviderFindings,
    normalizeProviderFinding,
    normalizeFinding,
    normalizeStoredFindings,
    isDisplayableFinding,
    shouldRenderPageMarker,
    mergeUniqueFindings,
    dedupeFindings,
    getDedupKey,
    mapCategory,
    normalizeComparableText,
    isTrivialSuggestion,
    isNoIssueReason,
    isOverbroadTypoFinding,
    isUnsupportedNumericFinding,
    isLikelySemanticRewrite
  };
})(globalThis);
