(() => {
  if (window.WebFeedbackPdf) {
    return;
  }

  const PAGE_WIDTH = 1240;
  const PAGE_HEIGHT = 1754;
  const MARGIN = 82;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
  const PAGE_WIDTH_PT = 595.28;
  const PAGE_HEIGHT_PT = 841.89;
  const FONT_FAMILY = "\"HarmonyOS Sans SC\", \"HarmonyOS Sans\", \"鸿蒙黑体\", \"Microsoft YaHei\", system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif";
  const COLORS = {
    text: "#101828",
    muted: "#667085",
    faint: "#98a2b3",
    line: "#d0d5dd",
    border: "#e4e7ec",
    panel: "#f8fafc",
    panelStrong: "#f2f4f7",
    primary: "#1769e0",
    primaryDark: "#0f55b8",
    primarySoft: "#eef4ff",
    quoteLine: "#bcd2ff",
    ai: "#b45309",
    aiSoft: "#fffbeb"
  };

  async function exportFeedbackPdf({ title, url, items, aiFindings = [] }) {
    const exportedAt = new Date();
    const pageTitle = title || "未命名页面";
    const reportTitle = buildReportTitle(pageTitle, exportedAt);
    const pages = await renderReportPages({ pageTitle, url, items: items || [], aiFindings: aiFindings || [], exportedAt });
    const blob = buildImagePdf(pages);
    downloadBlob(blob, `${sanitizeFileName(reportTitle)}.pdf`);
  }

  async function renderReportPages({ pageTitle, url, items, aiFindings, exportedAt }) {
    const pages = [];
    let canvas = createPage();
    let ctx = canvas.getContext("2d");
    let y = MARGIN;

    const finishPage = () => {
      drawPageFooter(ctx, pages.length + 1);
      pages.push(canvas);
    };

    const newPage = () => {
      finishPage();
      canvas = createPage();
      ctx = canvas.getContext("2d");
      y = MARGIN;
    };

    const ensureSpace = (height) => {
      if (y + height > PAGE_HEIGHT - MARGIN) {
        newPage();
      }
    };

    y = drawReportHeader(ctx, {
      pageTitle: pageTitle || "未命名页面",
      url: url || "",
      exportedAt,
      count: items.length + aiFindings.length
    });

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const textHeight = getFeedbackTextHeight(ctx, item.issue || "");
      const quoteHeight = item.selectedText ? getQuoteHeight(ctx, item.selectedText) : 0;
      ensureSpace(78 + textHeight + quoteHeight + 42);

      y = drawFeedbackFlowHeader(ctx, item, index + 1, y);
      y = drawFeedbackText(ctx, item.issue || "", y);

      if (item.selectedText) {
        y = drawQuote(ctx, item.selectedText, y);
      }

      if (item.imageDataUrl) {
        const image = await loadImage(item.imageDataUrl);
        const imageSize = getFittedImageSize(image, CONTENT_WIDTH, 700);
        ensureSpace(imageSize.height + 78);
        y = drawEvidenceTitle(ctx, y);
        drawImageEvidence(ctx, image, y, imageSize);
        y += imageSize.height + 36;
      }

      y += 18;
    }

    if (aiFindings.length) {
      ensureSpace(120);
      y = drawAiSectionHeader(ctx, y);

      for (let index = 0; index < aiFindings.length; index += 1) {
        const finding = aiFindings[index];
        const height = getAiFindingHeight(ctx, finding);
        ensureSpace(height + 38);
        y = drawAiFinding(ctx, finding, index + 1, y);
      }
    }

    finishPage();
    return pages;
  }

  function createPage() {
    const canvas = document.createElement("canvas");
    canvas.width = PAGE_WIDTH;
    canvas.height = PAGE_HEIGHT;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    return canvas;
  }

  function setFont(ctx, weight, size) {
    ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
  }

  function drawReportHeader(ctx, { pageTitle, url, exportedAt, count }) {
    let y = MARGIN;

    drawRule(ctx, y - 34);
    ctx.fillStyle = COLORS.text;
    setFont(ctx, 850, 42);
    ctx.fillText("网页反馈标注报告", MARGIN, y + 18);

    ctx.textAlign = "right";
    ctx.fillStyle = COLORS.faint;
    setFont(ctx, 600, 20);
    ctx.fillText("Web Feedback Marker", PAGE_WIDTH - MARGIN, y + 6);
    setFont(ctx, 400, 19);
    ctx.fillText(formatDateOnly(exportedAt), PAGE_WIDTH - MARGIN, y + 36);
    ctx.textAlign = "left";

    y += 70;

    ctx.fillStyle = COLORS.primaryDark;
    setFont(ctx, 800, 26);
    ctx.fillText(`共 ${count} 条反馈`, MARGIN, y);

    const sourceX = MARGIN + 180;
    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 500, 22);
    const titleLines = wrapText(ctx, pageTitle || "未命名页面", CONTENT_WIDTH - 180, 1);
    ctx.fillText(titleLines[0] || "未命名页面", sourceX, y);

    y += 36;
    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 400, 20);
    const urlLines = wrapText(ctx, url || "-", CONTENT_WIDTH, 1);
    ctx.fillText(urlLines[0] || "-", MARGIN, y);

    y += 52;
    drawRule(ctx, y);
    return y + 46;
  }

  function drawFeedbackFlowHeader(ctx, item, number, y) {
    drawRule(ctx, y);
    y += 34;

    const badgeSize = 44;
    const badgeX = MARGIN + badgeSize / 2;
    const badgeY = y + 18;
    ctx.fillStyle = COLORS.primary;
    ctx.beginPath();
    ctx.arc(badgeX, badgeY, badgeSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    setFont(ctx, 800, 21);
    ctx.textAlign = "center";
    ctx.fillText(String(number), badgeX, badgeY + 8);
    ctx.textAlign = "left";

    const headingX = MARGIN + badgeSize + 22;
    ctx.fillStyle = COLORS.text;
    setFont(ctx, 850, 31);
    ctx.fillText(`标注点 ${number}`, headingX, y + 16);

    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 500, 22);
    ctx.fillText(`${item.category || "其他"} · ${getItemTypeLabel(item)} · ${formatDateOnly(item.createdAt)}`, headingX, y + 50);
    return y + 76;
  }

  function drawFeedbackText(ctx, text, y) {
    setFont(ctx, 850, 30);
    const lines = wrapText(ctx, text || "未填写反馈内容", CONTENT_WIDTH, 10);
    ctx.fillStyle = COLORS.text;
    const lineHeight = 44;
    lines.forEach((line, index) => {
      ctx.fillText(line, MARGIN, y + index * lineHeight);
    });

    return y + lines.length * lineHeight + 44;
  }

  function getFeedbackTextHeight(ctx, text) {
    setFont(ctx, 850, 30);
    const lines = wrapText(ctx, text || "未填写反馈内容", CONTENT_WIDTH, 10);
    return lines.length * 44 + 44;
  }

  function drawQuote(ctx, text, y) {
    setFont(ctx, 400, 26);
    const quoteX = MARGIN + 28;
    const lines = wrapText(ctx, text, CONTENT_WIDTH - 76, 6);

    ctx.strokeStyle = COLORS.quoteLine;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(MARGIN + 4, y);
    ctx.lineTo(MARGIN + 4, y + 56 + lines.length * 38);
    ctx.stroke();

    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 800, 22);
    ctx.fillText("引用", quoteX, y + 25);

    ctx.fillStyle = "#475467";
    setFont(ctx, 400, 25);
    lines.forEach((line, index) => {
      ctx.fillText(line, quoteX, y + 68 + index * 38);
    });

    return y + 86 + lines.length * 38;
  }

  function getQuoteHeight(ctx, text) {
    setFont(ctx, 400, 26);
    const lines = wrapText(ctx, text, CONTENT_WIDTH - 76, 6);
    return 86 + lines.length * 38;
  }

  function drawEvidenceTitle(ctx, y) {
    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 800, 21);
    ctx.fillText("截图证据", MARGIN, y + 20);
    return y + 44;
  }

  function drawRule(ctx, y) {
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(MARGIN, y);
    ctx.lineTo(PAGE_WIDTH - MARGIN, y);
    ctx.stroke();
  }

  function drawImageEvidence(ctx, image, y, size) {
    const x = MARGIN + (CONTENT_WIDTH - size.width) / 2;

    ctx.save();
    roundRect(ctx, x, y, size.width, size.height, 12);
    ctx.clip();
    ctx.drawImage(image, x, y, size.width, size.height);
    ctx.restore();
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1.25;
    roundRect(ctx, x, y, size.width, size.height, 12);
    ctx.stroke();
  }

  function getFittedImageSize(image, maxWidth, maxHeight) {
    const naturalWidth = Math.max(1, image.naturalWidth || image.width || 1);
    const naturalHeight = Math.max(1, image.naturalHeight || image.height || 1);
    const aspectRatio = naturalWidth / naturalHeight;
    const heightLimit = aspectRatio < 0.72 ? Math.min(maxHeight, 820) : maxHeight;
    const scale = Math.min(maxWidth / naturalWidth, heightLimit / naturalHeight, 1);

    return {
      width: Math.max(1, Math.round(naturalWidth * scale)),
      height: Math.max(1, Math.round(naturalHeight * scale))
    };
  }

  function drawPageFooter(ctx, pageNumber) {
    const y = PAGE_HEIGHT - 44;
    ctx.strokeStyle = "#eef2f7";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(MARGIN, y - 28);
    ctx.lineTo(PAGE_WIDTH - MARGIN, y - 28);
    ctx.stroke();

    ctx.fillStyle = COLORS.faint;
    setFont(ctx, 500, 18);
    ctx.fillText("网页反馈标注器 · Web Feedback Marker", MARGIN, y);
    ctx.textAlign = "right";
    ctx.fillText(`第 ${pageNumber} 页`, PAGE_WIDTH - MARGIN, y);
    ctx.textAlign = "left";
  }

  function getItemTypeLabel(item) {
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

  function formatDateOnly(value) {
    if (!value) {
      return "-";
    }
    return new Date(value).toLocaleDateString("zh-CN");
  }

  function drawAiSectionHeader(ctx, y) {
    drawRule(ctx, y);
    y += 48;
    ctx.fillStyle = COLORS.ai;
    setFont(ctx, 850, 32);
    ctx.fillText("AI 检查结果", MARGIN, y);
    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 400, 20);
    ctx.fillText("以下内容由用户配置的 AI 服务识别，默认需要人工确认。", MARGIN, y + 34);
    return y + 74;
  }

  function drawAiFinding(ctx, finding, number, y) {
    const badgeSize = 38;
    const badgeX = MARGIN + badgeSize / 2;
    const badgeY = y + 18;

    ctx.fillStyle = COLORS.ai;
    ctx.beginPath();
    ctx.arc(badgeX, badgeY, badgeSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    setFont(ctx, 800, 18);
    ctx.textAlign = "center";
    ctx.fillText(String(number), badgeX, badgeY + 7);
    ctx.textAlign = "left";

    const x = MARGIN + badgeSize + 20;
    ctx.fillStyle = COLORS.text;
    setFont(ctx, 800, 25);
    ctx.fillText(finding.errorType || "疑似问题", x, y + 12);

    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 500, 19);
    ctx.fillText(`${getAiStatusText(finding.status)} · ${finding.category || "其他"} · ${formatDateOnly(finding.createdAt)}`, x, y + 42);

    let nextY = y + 78;
    nextY = drawAiTextBlock(ctx, "问题", finding.reason || finding.issue || "AI 检查发现疑似问题。", nextY);
    if (finding.originalText) {
      nextY = drawAiTextBlock(ctx, "原文", finding.originalText, nextY);
    }
    if (finding.suggestedText) {
      nextY = drawAiTextBlock(ctx, "建议", finding.suggestedText, nextY);
    }

    return nextY + 26;
  }

  function drawAiTextBlock(ctx, label, text, y) {
    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 800, 19);
    ctx.fillText(label, MARGIN + 58, y);

    ctx.fillStyle = label === "建议" ? COLORS.ai : "#475467";
    setFont(ctx, 400, 22);
    const lines = wrapText(ctx, text || "-", CONTENT_WIDTH - 160, 4);
    lines.forEach((line, index) => {
      ctx.fillText(line, MARGIN + 124, y + index * 32);
    });

    return y + Math.max(32, lines.length * 32) + 12;
  }

  function getAiFindingHeight(ctx, finding) {
    let height = 104;
    height += getAiTextBlockHeight(ctx, finding.reason || finding.issue || "AI 检查发现疑似问题。");
    if (finding.originalText) {
      height += getAiTextBlockHeight(ctx, finding.originalText);
    }
    if (finding.suggestedText) {
      height += getAiTextBlockHeight(ctx, finding.suggestedText);
    }
    return height + 26;
  }

  function getAiTextBlockHeight(ctx, text) {
    setFont(ctx, 400, 22);
    const lines = wrapText(ctx, text || "-", CONTENT_WIDTH - 160, 4);
    return Math.max(32, lines.length * 32) + 12;
  }

  function getAiStatusText(status) {
    return status === "confirmed" ? "已确认" : "待确认";
  }

  function buildReportTitle(pageTitle, date) {
    return `${truncateText(pageTitle, 20)} - ${formatDateStamp(date)} - ${formatTimeStamp(date)} - 反馈标注`;
  }

  function truncateText(value, maxLength) {
    const text = String(value || "未命名页面").trim() || "未命名页面";
    return Array.from(text).slice(0, maxLength).join("");
  }

  function formatDateStamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }

  function formatTimeStamp(date) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}${minutes}`;
  }

  function wrapText(ctx, text, maxWidth, maxLines = Infinity) {
    const normalized = String(text || "").replace(/\r/g, "");
    const lines = [];

    normalized.split("\n").forEach((paragraph) => {
      let line = "";
      Array.from(paragraph || " ").forEach((char) => {
        const candidate = `${line}${char}`;
        if (line && ctx.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = char;
        } else {
          line = candidate;
        }
      });
      lines.push(line);
    });

    if (lines.length <= maxLines) {
      return lines;
    }

    const limited = lines.slice(0, maxLines);
    limited[limited.length - 1] = `${limited[limited.length - 1].slice(0, -1)}...`;
    return limited;
  }

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function buildImagePdf(pageCanvases) {
    const encoder = new TextEncoder();
    const chunks = [];
    const offsets = [0];
    let offset = 0;
    const pageCount = pageCanvases.length;
    const pageIds = [];
    const contentIds = [];
    const imageIds = [];
    let nextId = 3;

    for (let index = 0; index < pageCount; index += 1) {
      pageIds.push(nextId++);
      contentIds.push(nextId++);
      imageIds.push(nextId++);
    }

    const objectCount = nextId - 1;

    const writeString = (value) => {
      const bytes = encoder.encode(value);
      chunks.push(bytes);
      offset += bytes.length;
    };

    const writeBytes = (bytes) => {
      chunks.push(bytes);
      offset += bytes.length;
    };

    const startObject = (id) => {
      offsets[id] = offset;
      writeString(`${id} 0 obj\n`);
    };

    writeString("%PDF-1.3\n%\xE2\xE3\xCF\xD3\n");

    startObject(1);
    writeString("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    startObject(2);
    writeString(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>\nendobj\n`);

    for (let index = 0; index < pageCount; index += 1) {
      const pageId = pageIds[index];
      const contentId = contentIds[index];
      const imageId = imageIds[index];
      const imageName = `Im${index + 1}`;
      const jpegBytes = dataUrlToBytes(pageCanvases[index].toDataURL("image/jpeg", 0.92));
      const content = `q\n${PAGE_WIDTH_PT} 0 0 ${PAGE_HEIGHT_PT} 0 0 cm\n/${imageName} Do\nQ\n`;

      startObject(pageId);
      writeString(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH_PT} ${PAGE_HEIGHT_PT}] /Resources << /XObject << /${imageName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`
      );

      startObject(contentId);
      writeString(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);

      startObject(imageId);
      writeString(
        `<< /Type /XObject /Subtype /Image /Width ${pageCanvases[index].width} /Height ${pageCanvases[index].height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
      );
      writeBytes(jpegBytes);
      writeString("\nendstream\nendobj\n");
    }

    const xrefOffset = offset;
    writeString(`xref\n0 ${objectCount + 1}\n`);
    writeString("0000000000 65535 f \n");
    for (let id = 1; id <= objectCount; id += 1) {
      writeString(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
    }
    writeString(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

    return new Blob(chunks, { type: "application/pdf" });
  }

  function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(",")[1] || "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片加载失败。"));
      image.src = src;
    });
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sanitizeFileName(value) {
    return String(value)
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 90) || "网页反馈";
  }

  window.WebFeedbackPdf = {
    exportFeedbackPdf
  };
})();
