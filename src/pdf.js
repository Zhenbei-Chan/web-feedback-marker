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
    primarySoft: "#eef4ff"
  };

  async function exportFeedbackPdf({ title, url, items }) {
    const exportedAt = new Date();
    const reportTitle = buildReportTitle(title || "未命名页面", exportedAt);
    const pages = await renderReportPages({ title: reportTitle, url, items, exportedAt });
    const blob = buildImagePdf(pages);
    downloadBlob(blob, `${sanitizeFileName(reportTitle)}.pdf`);
  }

  async function renderReportPages({ title, url, items, exportedAt }) {
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
      title: title || "网页反馈",
      url: url || "",
      exportedAt,
      count: items.length
    });

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      ensureSpace(300);

      y = drawFeedbackCardHeader(ctx, item, index + 1, y);

      y = drawInfoRow(ctx, [
        { label: "反馈时间", value: formatTime(item.createdAt) },
        { label: "反馈位置", value: getReportLocationText(item) }
      ], y);
      y = drawContentBlock(ctx, "反馈内容", item.issue || "", y);

      if (item.selectedText) {
        y = drawQuote(ctx, item.selectedText, y);
      }

      if (item.imageDataUrl) {
        const image = await loadImage(item.imageDataUrl);
        const imageSize = getFittedImageSize(image, CONTENT_WIDTH - 36, 700);
        ensureSpace(imageSize.height + 94);
        y = drawEvidenceTitle(ctx, y);
        drawImageFrame(ctx, image, y, imageSize);
        y += imageSize.height + 42;
      }

      y += 10;
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
    ctx.fillStyle = "#fbfcff";
    ctx.fillRect(0, 0, PAGE_WIDTH, 16);
    return canvas;
  }

  function setFont(ctx, weight, size) {
    ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
  }

  function drawReportHeader(ctx, { title, url, exportedAt, count }) {
    let y = MARGIN;

    ctx.fillStyle = COLORS.primary;
    roundRect(ctx, MARGIN, y, 190, 42, 21);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    setFont(ctx, 800, 21);
    ctx.fillText("反馈标注报告", MARGIN + 22, y + 28);

    ctx.fillStyle = COLORS.text;
    setFont(ctx, 800, 42);
    const titleLines = wrapText(ctx, title, CONTENT_WIDTH, 2);
    titleLines.forEach((line, index) => {
      ctx.fillText(line, MARGIN, y + 96 + index * 52);
    });

    y += 142 + (titleLines.length - 1) * 52;
    y = drawHeaderMeta(ctx, url, exportedAt, count, y);
    return y + 34;
  }

  function drawHeaderMeta(ctx, url, exportedAt, count, y) {
    const gap = 14;
    const cardHeight = 82;
    const cardWidth = Math.floor((CONTENT_WIDTH - gap * 2) / 3);
    drawMetaCard(ctx, "反馈数量", `${count} 条`, MARGIN, y, cardWidth, cardHeight, true);
    drawMetaCard(ctx, "导出时间", formatTime(exportedAt), MARGIN + cardWidth + gap, y, cardWidth, cardHeight);
    drawMetaCard(ctx, "报告类型", "网页反馈标注", MARGIN + (cardWidth + gap) * 2, y, cardWidth, cardHeight);

    y += cardHeight + 16;
    drawMetaCard(ctx, "页面来源", url || "-", MARGIN, y, CONTENT_WIDTH, cardHeight);
    return y + cardHeight + 26;
  }

  function drawMetaCard(ctx, label, value, x, y, width, height, emphasize = false) {
    ctx.fillStyle = emphasize ? COLORS.primarySoft : COLORS.panel;
    roundRect(ctx, x, y, width, height, 14);
    ctx.fill();
    ctx.strokeStyle = emphasize ? "#bfd7ff" : COLORS.border;
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, width, height, 14);
    ctx.stroke();

    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 700, 20);
    ctx.fillText(label, x + 22, y + 28);

    ctx.fillStyle = emphasize ? COLORS.primaryDark : COLORS.text;
    setFont(ctx, emphasize ? 800 : 550, 24);
    const valueLines = wrapText(ctx, value, width - 44, 1);
    ctx.fillText(valueLines[0] || "-", x + 22, y + 58);
  }

  function drawFeedbackCardHeader(ctx, item, number, y) {
    const headerHeight = 96;
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, MARGIN, y, CONTENT_WIDTH, headerHeight, 18);
    ctx.fill();
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    roundRect(ctx, MARGIN, y, CONTENT_WIDTH, headerHeight, 18);
    ctx.stroke();

    const badgeSize = 46;
    ctx.fillStyle = COLORS.primary;
    roundRect(ctx, MARGIN + 22, y + 24, badgeSize, badgeSize, 13);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    setFont(ctx, 800, 22);
    ctx.textAlign = "center";
    ctx.fillText(String(number), MARGIN + 22 + badgeSize / 2, y + 55);
    ctx.textAlign = "left";

    const headingX = MARGIN + 22 + badgeSize + 22;
    ctx.fillStyle = COLORS.text;
    setFont(ctx, 700, 30);
    wrapText(ctx, getItemTypeLabel(item), CONTENT_WIDTH - badgeSize - 18, 1).forEach((line, index) => {
      ctx.fillText(line, headingX, y + 42 + index * 38);
    });

    drawChip(ctx, item.category || "其他", headingX, y + 54);
    return y + headerHeight + 20;
  }

  function drawChip(ctx, text, x, y) {
    setFont(ctx, 700, 20);
    const width = Math.min(210, Math.max(96, Math.ceil(ctx.measureText(text).width) + 34));
    ctx.fillStyle = COLORS.primarySoft;
    roundRect(ctx, x, y, width, 34, 17);
    ctx.fill();
    ctx.fillStyle = "#175cd3";
    ctx.fillText(text, x + 17, y + 24);
  }

  function drawInfoRow(ctx, items, y) {
    const gap = 14;
    const width = Math.floor((CONTENT_WIDTH - gap) / 2);
    const height = 76;

    items.forEach((item, index) => {
      const x = MARGIN + index * (width + gap);
      ctx.fillStyle = COLORS.panel;
      roundRect(ctx, x, y, width, height, 12);
      ctx.fill();
      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, width, height, 12);
      ctx.stroke();

      ctx.fillStyle = COLORS.muted;
      setFont(ctx, 700, 18);
      ctx.fillText(item.label, x + 18, y + 27);

      ctx.fillStyle = COLORS.text;
      setFont(ctx, 500, 21);
      const valueLines = wrapText(ctx, item.value || "-", width - 36, 1);
      ctx.fillText(valueLines[0] || "-", x + 18, y + 57);
    });

    return y + height + 18;
  }

  function drawContentBlock(ctx, label, text, y) {
    const size = 25;
    const lineHeight = 38;
    setFont(ctx, 400, size);
    const lines = wrapText(ctx, text || "-", CONTENT_WIDTH - 44, 10);
    const height = lines.length * lineHeight + 78;

    ctx.fillStyle = "#ffffff";
    roundRect(ctx, MARGIN, y, CONTENT_WIDTH, height, 16);
    ctx.fill();
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    roundRect(ctx, MARGIN, y, CONTENT_WIDTH, height, 16);
    ctx.stroke();

    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 700, size);
    ctx.fillText(label, MARGIN + 22, y + 36);

    setFont(ctx, 400, size);
    ctx.fillStyle = COLORS.text;
    lines.forEach((line, index) => {
      ctx.fillText(line, MARGIN + 22, y + 76 + index * lineHeight);
    });

    return y + height + 18;
  }

  function drawQuote(ctx, text, y) {
    setFont(ctx, 400, 24);
    const lines = wrapText(ctx, text, CONTENT_WIDTH - 68, 6);
    const height = lines.length * 36 + 76;

    ctx.fillStyle = COLORS.panelStrong;
    roundRect(ctx, MARGIN, y + 10, CONTENT_WIDTH, height, 14);
    ctx.fill();

    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 700, 22);
    ctx.fillText("引用文本", MARGIN + 24, y + 44);

    ctx.fillStyle = "#475467";
    setFont(ctx, 400, 24);
    lines.forEach((line, index) => {
      ctx.fillText(line, MARGIN + 24, y + 82 + index * 36);
    });

    return y + height + 30;
  }

  function drawEvidenceTitle(ctx, y) {
    ctx.fillStyle = COLORS.muted;
    setFont(ctx, 700, 22);
    ctx.fillText("证据截图", MARGIN, y + 26);
    return y + 44;
  }

  function drawRule(ctx, y) {
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(MARGIN, y);
    ctx.lineTo(PAGE_WIDTH - MARGIN, y);
    ctx.stroke();
  }

  function drawImageFrame(ctx, image, y, size) {
    const x = MARGIN + (CONTENT_WIDTH - size.width) / 2;

    ctx.fillStyle = COLORS.panel;
    roundRect(ctx, x, y, size.width, size.height, 16);
    ctx.fill();
    ctx.save();
    roundRect(ctx, x, y, size.width, size.height, 16);
    ctx.clip();
    ctx.drawImage(image, x, y, size.width, size.height);
    ctx.restore();
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, size.width, size.height, 16);
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
      return "文本反馈";
    }
    if (item.type === "region") {
      return "区域反馈";
    }
    if (item.type === "point") {
      return "标记点反馈";
    }
    return "截图反馈";
  }

  function getFallbackLocationText(item) {
    return getReportLocationText(item);
  }

  function getReportLocationText(item) {
    if (item.type === "text" || item.selectedText) {
      return "文本引用附近，已附周边截图";
    }

    if (item.shape?.type === "region" || item.type === "region") {
      return item.snapshotRangeText || "框选区域，已附区域截图";
    }

    if (item.shape?.type === "point" || item.type === "point") {
      return item.snapshotRangeText || "标记点附近，已附周边截图";
    }

    return "页面可视区域，已附截图";
  }

  function formatTime(value) {
    if (!value) {
      return "-";
    }
    return new Date(value).toLocaleString("zh-CN");
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
