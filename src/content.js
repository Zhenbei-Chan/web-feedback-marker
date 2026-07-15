(() => {
  if (window.__WEB_FEEDBACK_ASSISTANT_INSTALLED__) {
    return;
  }

  window.__WEB_FEEDBACK_ASSISTANT_INSTALLED__ = true;

  const STORAGE_KEY = "webFeedbackAssistant.items";
  const AI_FINDINGS_KEY = "webFeedbackAssistant.aiFindings";
  const AI_SCAN_STATE_KEY = "webFeedbackAssistant.aiScanState";
  const AiCore = globalThis.WebFeedbackAiCore;
  const SnapshotCore = globalThis.WebFeedbackSnapshotCore;
  const DOCK_POSITION_KEY = "webFeedbackAssistant.dockPosition";
  const CATEGORIES = ["内容错误", "表达不清", "结构问题", "链接问题", "视觉建议", "其他"];
  const MARK_COLOR = "#f04438";
  const DRAFT_COLOR = "#1769e0";
  const AI_MARK_COLOR = "#f59e0b";
  const POINT_CAPTURE_WIDTH = 640;
  const POINT_CAPTURE_HEIGHT = 360;
  const REGION_PADDING = 72;
  const DOCK_WIDTH = 238;
  const DOCK_SIZE = 52;
  const DOCK_MARGIN = 18;
  const DOCK_AVOID_GAP = 12;
  const DOCK_MENU_HEIGHT = 368;
  const DOCK_OBSTACLE_SCAN_TTL = 800;
  const HTML_SNAPSHOT_STYLE_ID = "web-feedback-snapshot-capture-style";
  const MAX_AI_SCAN_BLOCKS = 12;
  const AI_DEBUG_PREVIEW_LENGTH = 160;

  let overlay = null;
  let session = null;
  let pinnedPopoverId = "";
  let highlightedItemId = "";
  let hintTimer = 0;
  let popoverHideTimer = 0;
  let aiScanJob = null;
  let lastAiScanDebug = null;
  let lastWarningLog = "";
  let aiProgressFrame = 0;
  let aiProgressView = {
    active: false,
    displayed: 0,
    target: 0,
    message: "",
    meta: "",
    found: 0,
    startedAt: 0
  };
  let lastSelectionContext = { text: "", rect: null };
  let dockState = {
    side: "right",
    top: null,
    drag: null,
    moved: false
  };
  let floatingObstacleCache = {
    at: 0,
    rects: []
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_PAGE_CONTEXT") {
      sendResponse(getPageContext());
      return true;
    }

    if (message?.type === "START_ANNOTATION_MODE") {
      startAnnotationMode()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ error: getFriendlyErrorMessage(error, "无法进入批注模式。") }));
      return true;
    }

    if (message?.type === "FEEDBACK_ITEMS_CHANGED") {
      syncPageItemsFromStorage()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ error: getFriendlyErrorMessage(error, "无法同步反馈列表。") }));
      return true;
    }

    if (message?.type === "CLEAR_CURRENT_PAGE_FEEDBACK") {
      clearCurrentPageFeedback(message.pageUrl)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ error: getFriendlyErrorMessage(error, "清空当前页反馈失败。") }));
      return true;
    }

    if (message?.type === "EXPORT_HTML_REPORT") {
      exportHtmlReport(message.itemIds)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ error: getFriendlyErrorMessage(error, "HTML 导出失败。") }));
      return true;
    }

    if (message?.type === "AI_SCAN_PAGE") {
      startAiScanPage()
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ error: getFriendlyErrorMessage(error, "AI 检查失败。") }));
      return true;
    }

    if (message?.type === "GET_AI_SCAN_RUNTIME_STATE") {
      getAiScanRuntimeState()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ running: false, error: getFriendlyErrorMessage(error, "无法读取 AI 检查状态。") }));
      return true;
    }

    if (message?.type === "AI_SCAN_PROGRESS") {
      updateAiScanProgress(message.progress);
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  function getPageContext() {
    return {
      title: document.title || "",
      url: location.href,
      selectionText: getSelectionText()
    };
  }

  function getSelectionText() {
    const selection = window.getSelection();
    return selection ? selection.toString().trim() : "";
  }

  async function startAnnotationMode() {
    if (overlay) {
      toggleMenu(true);
      overlay.root.classList.add("is-attention");
      setTimeout(() => overlay?.root.classList.remove("is-attention"), 260);
      return;
    }

    const page = getPageContext();
    const [items, aiFindings, dockPosition] = await Promise.all([loadItems(), loadAiFindings(), loadDockPosition()]);
    dockState = {
      ...dockState,
      ...dockPosition,
      drag: null,
      moved: false
    };
    session = {
      id: crypto.randomUUID(),
      page,
      tool: "browse",
      dragStart: null,
      dragPreview: null,
      draft: null,
      pageItems: getCurrentPageItems(items, page.url).reverse(),
      aiFindings: getCurrentPageAiFindings(aiFindings, page.url),
      newItems: []
    };

    createOverlay();
    applyDockPosition();
    renderAll();
    showHint("批注工具已在页面右下角。");
  }

  function createOverlay() {
    const host = document.createElement("div");
    host.id = "web-feedback-assistant-root";
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${getOverlayStyles()}</style>
      <div class="shell" data-tool="browse" data-menu="closed">
        <canvas class="annotation-canvas"></canvas>
        <div class="markers"></div>
        <div class="capture-layer"></div>

        <section class="quick-entry" aria-label="网页反馈标注器">
          <div class="dock" aria-label="批注操作">
            <button class="dock-action" data-action="region" type="button">
              <strong>框选区域</strong>
              <span>拖拽选择，Ctrl+Alt+1</span>
            </button>
            <button class="dock-action" data-action="point" type="button">
              <strong>添加标记</strong>
              <span>点击定位，Ctrl+Alt+2</span>
            </button>
            <button class="dock-action" data-action="text" type="button">
              <strong>文本反馈</strong>
              <span>选中文字，Ctrl+Alt+3</span>
            </button>
            <button class="dock-action ai-dock-action" data-action="ai-scan" type="button">
              <strong>AI 检查页面</strong>
              <span>生成待确认标记</span>
            </button>
            <button class="dock-action" data-action="export" type="button">
              <strong>导出快照 HTML</strong>
              <span>截图报告，Ctrl+Alt+E</span>
            </button>
            <button class="dock-action subtle" data-action="exit" type="button">
              <strong>退出批注</strong>
              <span>关闭悬浮入口</span>
            </button>
          </div>
          <button id="launcherBtn" class="launcher" type="button" aria-label="打开批注工具">
            <span id="countBadge" class="count">0</span>
            <svg class="launcher-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        </section>

        <aside class="composer" id="composer" aria-label="反馈内容">
          <div class="composer-top">
            <button id="cancelBtn" class="icon-button" type="button" aria-label="取消">×</button>
          </div>
          <div class="field-shell field-select" data-label="分类">
            <select id="categorySelect" aria-label="分类"></select>
          </div>
          <textarea id="issueInput" rows="3" aria-label="反馈内容" placeholder="反馈：描述问题、原因或建议"></textarea>
          <div class="selection-box" id="selectionBox"></div>
          <footer>
            <button id="saveBtn" class="primary" type="button">保存</button>
          </footer>
        </aside>

        <div class="popover" id="popover"></div>
        <div class="hint" id="hint"></div>
      </div>
    `;

    document.documentElement.appendChild(host);

    overlay = {
      host,
      root: shadow.querySelector(".shell"),
      canvas: shadow.querySelector(".annotation-canvas"),
      ctx: shadow.querySelector(".annotation-canvas").getContext("2d"),
      captureLayer: shadow.querySelector(".capture-layer"),
      markers: shadow.querySelector(".markers"),
      quickEntry: shadow.querySelector(".quick-entry"),
      dock: shadow.querySelector(".dock"),
      dockActions: [...shadow.querySelectorAll(".dock-action")],
      launcherBtn: shadow.querySelector("#launcherBtn"),
      countBadge: shadow.querySelector("#countBadge"),
      composer: shadow.querySelector("#composer"),
      categorySelect: shadow.querySelector("#categorySelect"),
      issueInput: shadow.querySelector("#issueInput"),
      selectionBox: shadow.querySelector("#selectionBox"),
      saveBtn: shadow.querySelector("#saveBtn"),
      cancelBtn: shadow.querySelector("#cancelBtn"),
      popover: shadow.querySelector("#popover"),
      hint: shadow.querySelector("#hint")
    };

    overlay.categorySelect.innerHTML = CATEGORIES.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
    bindOverlayEvents();
  }

  function bindOverlayEvents() {
    overlay.launcherBtn.addEventListener("pointerdown", onDockPointerDown);
    overlay.launcherBtn.addEventListener("pointermove", onDockPointerMove);
    overlay.launcherBtn.addEventListener("pointerup", onDockPointerUp);
    overlay.launcherBtn.addEventListener("pointercancel", onDockPointerCancel);
    overlay.launcherBtn.addEventListener("click", onLauncherClick);
    overlay.dockActions.forEach((button) => {
      button.addEventListener("click", () => handleDockAction(button.dataset.action));
    });

    overlay.captureLayer.addEventListener("pointerdown", onPointerDown);
    overlay.captureLayer.addEventListener("pointermove", onPointerMove);
    overlay.captureLayer.addEventListener("pointerup", onPointerUp);
    overlay.saveBtn.addEventListener("click", saveCurrentFeedback);
    overlay.cancelBtn.addEventListener("click", cancelDraft);

    overlay.popover.addEventListener("mouseenter", () => {
      window.clearTimeout(popoverHideTimer);
      overlay.popover.classList.add("is-hovered");
    });
    overlay.popover.addEventListener("mouseleave", () => {
      overlay.popover.classList.remove("is-hovered");
      if (!pinnedPopoverId) {
        schedulePopoverHide();
      }
    });
    overlay.popover.addEventListener("pointerdown", () => window.clearTimeout(popoverHideTimer));
    overlay.popover.addEventListener("click", onPopoverClick);
    overlay.hint.addEventListener("click", onHintClick);

    window.addEventListener("scroll", renderAll, true);
    window.addEventListener("resize", renderAll);
    window.addEventListener("keydown", onShortcutKeyDown, true);
    document.addEventListener("selectionchange", updateSelectionBox);
  }

  function onShortcutKeyDown(event) {
    if (!overlay || !session) {
      return;
    }

    if (event.key === "Escape") {
      if (overlay.composer.classList.contains("is-visible") || session.draft || session.dragPreview || session.tool !== "browse") {
        event.preventDefault();
        cancelDraft();
        return;
      }
      if (overlay.root.dataset.menu === "open") {
        event.preventDefault();
        toggleMenu(false);
      }
      return;
    }

    if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey || isTypingTarget(event.target)) {
      return;
    }

    if (event.key === "1") {
      event.preventDefault();
      beginTool("region");
    }
    if (event.key === "2") {
      event.preventDefault();
      beginTool("point");
    }
    if (event.key === "3") {
      event.preventDefault();
      beginTextFeedback();
    }
    if (event.key.toLowerCase() === "e") {
      event.preventDefault();
      finishAndExport();
    }
  }

  async function handleDockAction(action) {
    if (action === "region") {
      beginTool("region");
      return;
    }

    if (action === "point") {
      beginTool("point");
      return;
    }

    if (action === "text") {
      beginTextFeedback();
      return;
    }

    if (action === "ai-scan") {
      await startAiScanPage();
      return;
    }

    if (action === "export") {
      await finishAndExport();
      return;
    }

    if (action === "exit") {
      closeOverlay();
    }
  }

  function beginTool(tool) {
    session.tool = tool;
    session.dragStart = null;
    session.dragPreview = null;
    pinnedPopoverId = "";
    hidePopover();
    closeComposer();
    toggleMenu(false);
    overlay.root.dataset.tool = tool;

    if (tool === "region") {
      showHint("拖拽框选区域，松开后补充反馈内容。", false, 5000);
    } else {
      showHint(`点击需要标记的位置，将附周边 ${POINT_CAPTURE_WIDTH}×${POINT_CAPTURE_HEIGHT} 截图。`, false, 5000);
    }

    renderAll();
  }

  function beginTextFeedback() {
    const selection = getSelectionContext();
    if (!selection.text || !selection.rect) {
      showHint("请先在网页中选中文本，再从悬浮球选择文本反馈。", true, 5200);
      return;
    }

    const draft = selectionToPointDraft(selection);
    session.draft = {
      ...draft,
      selectedText: selection.text
    };
    session.tool = "browse";
    overlay.root.dataset.tool = "browse";
    toggleMenu(false);
    openComposer();
    renderAll();
  }

  function toggleMenu(forceOpen = null) {
    const shouldOpen = forceOpen === null ? overlay.root.dataset.menu !== "open" : forceOpen;
    overlay.root.dataset.menu = shouldOpen ? "open" : "closed";
    applyDockPosition();
  }

  function onLauncherClick(event) {
    if (dockState.moved) {
      event.preventDefault();
      event.stopPropagation();
      dockState.moved = false;
      return;
    }

    toggleMenu();
  }

  function onDockPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }

    const rect = overlay.quickEntry.getBoundingClientRect();
    dockState.drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY
    };
    dockState.moved = false;
    overlay.root.dataset.dockDragging = "true";
    overlay.launcherBtn.setPointerCapture(event.pointerId);
  }

  function onDockPointerMove(event) {
    if (!dockState.drag || dockState.drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = Math.abs(event.clientX - dockState.drag.startX);
    const deltaY = Math.abs(event.clientY - dockState.drag.startY);
    if (deltaX < 4 && deltaY < 4 && !dockState.moved) {
      return;
    }

    dockState.moved = true;
    toggleMenu(false);

    const entryWidth = getDockEntryWidth();
    const left = clamp(event.clientX - dockState.drag.offsetX, DOCK_MARGIN, window.innerWidth - entryWidth - DOCK_MARGIN);
    const top = clamp(event.clientY - dockState.drag.offsetY, DOCK_MARGIN, window.innerHeight - DOCK_SIZE - DOCK_MARGIN);

    overlay.quickEntry.style.width = `${entryWidth}px`;
    overlay.quickEntry.style.left = `${left}px`;
    overlay.quickEntry.style.top = `${top}px`;
  }

  function onDockPointerUp(event) {
    if (!dockState.drag || dockState.drag.pointerId !== event.pointerId) {
      return;
    }

    const rect = overlay.quickEntry.getBoundingClientRect();
    dockState.side = rect.left + rect.width / 2 < window.innerWidth / 2 ? "left" : "right";
    dockState.top = clamp(rect.top, DOCK_MARGIN, window.innerHeight - DOCK_SIZE - DOCK_MARGIN);
    dockState.drag = null;
    overlay.root.dataset.dockDragging = "false";

    if (overlay.launcherBtn.hasPointerCapture(event.pointerId)) {
      overlay.launcherBtn.releasePointerCapture(event.pointerId);
    }

    applyDockPosition();
    saveDockPosition();
  }

  function onDockPointerCancel(event) {
    if (!dockState.drag || dockState.drag.pointerId !== event.pointerId) {
      return;
    }

    dockState.drag = null;
    dockState.moved = false;
    overlay.root.dataset.dockDragging = "false";
    applyDockPosition();
  }

  function onPointerDown(event) {
    if (session.tool === "browse") {
      return;
    }

    const point = getPagePoint(event);
    if (session.tool === "point") {
      session.draft = {
        type: "point",
        x: point.x,
        y: point.y
      };
      session.tool = "browse";
      overlay.root.dataset.tool = "browse";
      openComposer();
      renderAll();
      return;
    }

    session.dragStart = point;
    session.dragPreview = null;
    overlay.captureLayer.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!session.dragStart || session.tool !== "region") {
      return;
    }

    const point = getPagePoint(event);
    session.dragPreview = normalizeRegion({
      type: "region",
      x: session.dragStart.x,
      y: session.dragStart.y,
      width: point.x - session.dragStart.x,
      height: point.y - session.dragStart.y
    });
    renderAll();
  }

  function onPointerUp(event) {
    if (!session.dragStart || !session.dragPreview) {
      session.dragStart = null;
      session.dragPreview = null;
      return;
    }

    if (session.dragPreview.width >= 8 && session.dragPreview.height >= 8) {
      session.draft = session.dragPreview;
      session.tool = "browse";
      overlay.root.dataset.tool = "browse";
      openComposer();
    }

    session.dragStart = null;
    session.dragPreview = null;
    if (overlay.captureLayer.hasPointerCapture(event.pointerId)) {
      overlay.captureLayer.releasePointerCapture(event.pointerId);
    }
    renderAll();
  }

  function openComposer() {
    updateSelectionBox();
    overlay.composer.classList.add("is-visible");
    positionComposer();
    overlay.issueInput.focus();
  }

  function closeComposer() {
    overlay.composer.classList.remove("is-visible");
  }

  function cancelDraft() {
    session.draft = null;
    session.dragPreview = null;
    closeComposer();
    showHint("已取消当前未保存反馈。");
    renderAll();
  }

  async function saveCurrentFeedback() {
    const issue = overlay.issueInput.value.trim();

    if (!issue) {
      showHint("请填写反馈内容。", true, 4200);
      return;
    }

    const draft = session.draft;
    if (!draft) {
      showHint("请先添加标记点、框选区域，或选择文本反馈。", true, 4200);
      return;
    }

    if (!isViewportShapeVisible(pageShapeToViewport(draft))) {
      showHint("当前标记不在可视区域内，请滚动回标记位置后再保存。", true, 5200);
      return;
    }

    try {
    const number = session.pageItems.length + 1;
    const selectedText = draft.selectedText || "";
    const imageDataUrl = await createFeedbackSnapshot(draft, number);
    const item = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      type: selectedText ? "text" : draft.type,
      pageTitle: session.page.title,
      pageUrl: session.page.url,
      createdAt: new Date().toISOString(),
      category: overlay.categorySelect.value,
      issue,
      selectedText,
      shape: stripDraftMeta(draft),
      locationText: buildLocationText(draft, selectedText),
      imageDataUrl,
      snapshotRangeText: draft.type === "region"
        ? `框选区域外扩 ${REGION_PADDING}px`
        : `标记点周边 ${POINT_CAPTURE_WIDTH}×${POINT_CAPTURE_HEIGHT}px`
    };

    await addItem(item);

    session.pageItems.push(item);
    session.newItems.push(item);
    session.draft = null;
    overlay.issueInput.value = "";
    closeComposer();
    toggleMenu(false);
    renderAll();
    showHint("反馈已保存，已回到浏览模式。");
    } catch (error) {
      showHint(getFriendlyErrorMessage(error, "保存反馈失败，请刷新页面后重试。"), true, 5200);
    }
  }

  async function finishAndExport() {
    if (!session.pageItems.length) {
      showHint("当前页面还没有反馈。", true, 4200);
      return;
    }

    toggleMenu(false);
    await exportHtmlReport(session.pageItems.map((item) => item.id));
    showHint("快照 HTML 已生成。");
  }

  async function exportHtmlReport(itemIds = null) {
    const page = getPageContext();
    const allItems = await loadItems();
    const pageItems = getCurrentPageItems(allItems, page.url).reverse();
    const orderedItems = Array.isArray(itemIds) && itemIds.length
      ? itemIds.map((id) => pageItems.find((item) => item.id === id)).filter(Boolean)
      : pageItems;

    if (!orderedItems.length) {
      throw new Error("当前页面没有可导出的反馈。");
    }

    const annotations = orderedItems.map((item, index) => toExportAnnotation(item, index + 1));
    const snapshot = await captureHtmlSnapshot();
    const html = buildSnapshotHtmlExport({
      page,
      exportedAt: new Date(),
      annotations,
      snapshot
    });
    downloadTextFile(html, `${sanitizeFileName(truncateText(page.title || "网页反馈", 24))}-反馈标注.html`);
  }

  async function captureHtmlSnapshot() {
    const originalX = window.scrollX;
    const originalY = window.scrollY;
    let captureStyle = null;

    overlay?.root.classList.add("is-capturing");
    captureStyle = installSnapshotCaptureStyle();
    await waitNextFrame();
    await waitNextFrame();

    try {
      await warmUpSnapshotPage();
      await scrollToSnapshotPosition(0);
      await waitNextFrame();
      const capture = await chrome.runtime.sendMessage({ type: "CAPTURE_FULL_PAGE_CDP" });
      if (!capture?.snapshot) {
        throw new Error(capture?.error || "无法截取连续网页快照。");
      }
      return capture.snapshot;
    } finally {
      window.scrollTo(originalX, originalY);
      captureStyle?.remove();
      overlay?.root.classList.remove("is-capturing");
      await waitNextFrame();
      if (overlay && session) {
        renderAll();
      }
    }

  }

  function installSnapshotCaptureStyle() {
    document.getElementById(HTML_SNAPSHOT_STYLE_ID)?.remove();
    const style = document.createElement("style");
    style.id = HTML_SNAPSHOT_STYLE_ID;
    style.textContent = `
      html { scroll-behavior: auto !important; scroll-snap-type: none !important; }
      *, *::before, *::after {
        overflow-anchor: none !important;
        scroll-behavior: auto !important;
        scroll-snap-align: none !important;
        animation-play-state: paused !important;
        transition-duration: 0s !important;
      }
    `;
    document.documentElement.appendChild(style);
    return style;
  }

  async function warmUpSnapshotPage() {
    const viewportHeight = Math.max(320, window.innerHeight);
    const positions = SnapshotCore.planScrollPositions({
      documentHeight: getDocumentHeight(),
      viewportHeight
    });
    for (const position of positions) {
      window.scrollTo({ left: 0, top: position, behavior: "auto" });
      await waitNextFrame();
    }
    await waitForSnapshotImages();
    await waitForSnapshotLayoutStable();
  }

  async function waitForSnapshotImages() {
    const pending = [...document.images].filter((image) => !image.complete);
    if (!pending.length) {
      return;
    }
    const settled = Promise.all(pending.map((image) => new Promise((resolve) => {
      if (image.complete) {
        resolve();
        return;
      }
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", resolve, { once: true });
    })));
    await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(resolve, 1200))
    ]);
  }

  async function scrollToSnapshotPosition(scrollY) {
    window.scrollTo({ left: 0, top: scrollY, behavior: "auto" });
    await waitForSnapshotLayoutStable();
  }

  async function waitForSnapshotLayoutStable() {
    let stableFrames = 0;
    let previousY = -1;
    let previousHeight = -1;
    for (let frame = 0; frame < 12; frame += 1) {
      await waitNextFrame();
      const currentY = Math.round(window.scrollY);
      const currentHeight = getDocumentHeight();
      if (currentY === previousY && currentHeight === previousHeight) {
        stableFrames += 1;
        if (stableFrames >= 2) {
          return;
        }
      } else {
        stableFrames = 0;
      }
      previousY = currentY;
      previousHeight = currentHeight;
    }
  }

  function getDocumentHeight() {
    return Math.ceil(Math.max(
      window.innerHeight,
      document.documentElement.scrollHeight,
      document.documentElement.offsetHeight,
      document.body?.scrollHeight || 0,
      document.body?.offsetHeight || 0
    ));
  }

  function buildSnapshotHtmlExport({ page, exportedAt, annotations, snapshot }) {
    const pageTitle = escapeHtml(page.title || "未命名页面");
    const pageUrl = escapeHtml(page.url || location.href);
    const exportedTime = escapeHtml(formatDateOnly(exportedAt));
    const segmentsHtml = snapshot.segments
      .map(renderSnapshotSegment)
      .join("");
    const markersHtml = annotations.map((annotation) => renderSnapshotMarker(annotation, snapshot)).join("");
    const panelHtml = renderSnapshotPanel({
      pageTitle,
      pageUrl,
      exportedTime,
      annotations
    });

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle} - 反馈标注</title>
  <style>${getSnapshotHtmlStyles()}</style>
</head>
<body>
  <header class="wfm-snapshot-header">
    <div>
      <p>网页快照反馈报告</p>
      <h1>${pageTitle}</h1>
      <a href="${pageUrl}" target="_blank" rel="noreferrer">${pageUrl}</a>
    </div>
    <strong>共 ${annotations.length} 条反馈</strong>
  </header>
  <main class="wfm-snapshot-layout">
    <section class="wfm-snapshot-stage" aria-label="网页快照" style="width:${snapshot.viewportWidth}px">
      <div class="wfm-snapshot-canvas">
        ${segmentsHtml}
        <div class="wfm-snapshot-marker-layer">${markersHtml}</div>
      </div>
    </section>
    ${panelHtml}
  </main>
  <script>${getSnapshotHtmlScript(annotations)}</script>
</body>
</html>`;
  }

  function renderSnapshotSegment(segment) {
    return `<img class="wfm-snapshot-segment" data-wfm-segment="${segment.index}" src="${segment.imageDataUrl}" alt="网页快照片段 ${segment.index + 1}" style="aspect-ratio:${segment.width}/${segment.height}">`;
  }

  function renderSnapshotMarker(annotation, snapshot) {
    const shape = annotation.shape || {};
    const point = SnapshotCore.toPercentPosition({
      x: clamp(annotation.point.x || 0, 0, snapshot.viewportWidth),
      y: clamp(annotation.point.y || 0, 0, snapshot.documentHeight)
    }, snapshot);
    const regionRect = SnapshotCore.toPercentRect({
      x: shape.x || 0,
      y: shape.y || 0,
      width: shape.width || 0,
      height: shape.height || 0
    }, snapshot);
    const region = shape.type === "region"
      ? `<span class="wfm-snapshot-region" data-wfm-id="${escapeHtml(annotation.id)}" style="left:${regionRect.left}%;top:${regionRect.top}%;width:${regionRect.width}%;height:${regionRect.height}%"></span>`
      : "";

    return `
      ${region}
      <button class="wfm-snapshot-marker" type="button" data-wfm-id="${escapeHtml(annotation.id)}" data-wfm-anchor="${escapeHtml(annotation.id)}" style="left:${point.left}%;top:${point.top}%" aria-label="标注点 ${annotation.number}">
        ${annotation.number}
      </button>
    `;
  }

  function renderSnapshotPanel({ pageTitle, pageUrl, exportedTime, annotations }) {
    const listHtml = annotations.map(renderSnapshotFeedItem).join("");
    return `
      <aside class="wfm-snapshot-panel" aria-label="修改点全览">
        <header>
          <div>
            <h2>修改点全览</h2>
            <span>共 ${annotations.length} 条</span>
          </div>
          <button class="wfm-snapshot-toggle" type="button" aria-label="收起修改点全览"><span></span></button>
        </header>
        <div class="wfm-snapshot-feed">${listHtml}</div>
        <footer>
          <p><span>原页面</span><strong title="${pageTitle}">${pageTitle}</strong></p>
          <p><span>URL</span><a href="${pageUrl}" title="${pageUrl}" target="_blank" rel="noreferrer">${pageUrl}</a></p>
          <p><span>导出日期</span><strong>${exportedTime}</strong></p>
          <em>网页快照 HTML：主体为导出时的连续截图，标记位置不依赖原网页重新排版。</em>
        </footer>
      </aside>
    `;
  }

  function renderSnapshotFeedItem(annotation) {
    const quote = annotation.selectedText
      ? `<blockquote>${escapeHtml(limitText(annotation.selectedText, 120))}</blockquote>`
      : "";
    const evidence = annotation.imageDataUrl
      ? `<details><summary>截图证据</summary><img src="${annotation.imageDataUrl}" alt="标注点 ${annotation.number} 截图证据"></details>`
      : "";

    return `
      <article class="wfm-snapshot-feed-item" data-wfm-id="${escapeHtml(annotation.id)}" data-wfm-jump="${escapeHtml(annotation.id)}" tabindex="0">
        <span class="wfm-snapshot-feed-number">${annotation.number}</span>
        <div>
          <strong>${escapeHtml(annotation.issue)}</strong>
          <p>${escapeHtml(annotation.category)} · ${escapeHtml(formatDateOnly(annotation.createdAt))}</p>
          ${quote}
          ${evidence}
        </div>
      </article>
    `;
  }

  function getSnapshotHtmlStyles() {
    return `
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body { margin: 0; background: #f4f6fb; color: #101828; font-family: "HarmonyOS Sans SC", "HarmonyOS Sans", "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .wfm-snapshot-header { position: sticky; top: 0; z-index: 20; display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; padding: 18px 420px 18px 32px; border-bottom: 1px solid #e4e7ec; background: rgba(255,255,255,0.94); backdrop-filter: blur(10px); }
      .wfm-snapshot-header p { margin: 0 0 4px; color: #1769e0; font-size: 13px; font-weight: 800; }
      .wfm-snapshot-header h1 { max-width: 920px; margin: 0; overflow: hidden; color: #101828; font-size: 20px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
      .wfm-snapshot-header a { display: block; max-width: 920px; margin-top: 4px; overflow: hidden; color: #667085; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
      .wfm-snapshot-header strong { flex: 0 0 auto; border-radius: 999px; background: #eaf1ff; color: #1769e0; padding: 8px 12px; font-size: 13px; }
      .wfm-snapshot-layout { position: relative; padding: 28px 420px 48px 32px; }
      .wfm-snapshot-stage { max-width: 100%; }
      .wfm-snapshot-canvas { position: relative; overflow: hidden; border: 1px solid #d0d5dd; border-radius: 12px; background: #fff; box-shadow: 0 16px 36px rgba(15, 23, 42, 0.08); }
      .wfm-snapshot-segment { display: block; width: 100%; height: auto; user-select: none; }
      .wfm-snapshot-marker-layer { position: absolute; inset: 0; pointer-events: none; }
      .wfm-snapshot-marker { position: absolute; z-index: 3; display: grid; width: 30px; height: 30px; place-items: center; transform: translate(-50%, -50%); border: 2px solid #fff; border-radius: 999px; background: #1769e0; box-shadow: 0 10px 22px rgba(23, 105, 224, 0.24); color: #fff; cursor: pointer; pointer-events: auto; font: 800 15px/1 system-ui, sans-serif; }
      .wfm-snapshot-marker.is-active { width: 36px; height: 36px; background: #0f55b8; box-shadow: 0 0 0 8px rgba(23, 105, 224, 0.14), 0 12px 28px rgba(23, 105, 224, 0.28); }
      .wfm-snapshot-region { position: absolute; z-index: 2; border: 2px solid rgba(23, 105, 224, 0.72); border-radius: 8px; background: rgba(23, 105, 224, 0.08); pointer-events: none; }
      .wfm-snapshot-region.is-active { box-shadow: 0 0 0 4px rgba(23, 105, 224, 0.14); }
      .wfm-snapshot-panel { position: fixed; top: 92px; right: 24px; z-index: 30; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; width: 360px; max-height: calc(100vh - 116px); overflow: hidden; border: 1px solid rgba(208, 213, 221, 0.92); border-radius: 18px; background: rgba(255, 255, 255, 0.96); box-shadow: 0 18px 50px rgba(15, 23, 42, 0.16); backdrop-filter: blur(10px); }
      .wfm-snapshot-panel.is-collapsed { max-height: 62px; }
      .wfm-snapshot-panel.is-collapsed .wfm-snapshot-feed, .wfm-snapshot-panel.is-collapsed footer { display: none; }
      .wfm-snapshot-panel header { display: flex; justify-content: space-between; align-items: center; min-height: 62px; border-bottom: 1px solid #eef2f7; padding: 14px 16px; }
      .wfm-snapshot-panel h2 { margin: 0; font-size: 18px; line-height: 1.2; }
      .wfm-snapshot-panel header span { color: #667085; font-size: 13px; }
      .wfm-snapshot-toggle { position: relative; width: 30px; height: 30px; border: 1px solid #d8e0ec; border-radius: 8px; background: #fff; cursor: pointer; }
      .wfm-snapshot-toggle span { position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; border-right: 2px solid #1769e0; border-bottom: 2px solid #1769e0; transform: translate(-50%, -62%) rotate(45deg); }
      .wfm-snapshot-panel.is-collapsed .wfm-snapshot-toggle span { transform: translate(-50%, -35%) rotate(225deg); }
      .wfm-snapshot-feed { overflow: auto; }
      .wfm-snapshot-feed-item { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 12px; border-left: 3px solid transparent; border-bottom: 1px solid #eef2f7; cursor: pointer; padding: 14px 16px 14px 13px; }
      .wfm-snapshot-feed-item:hover, .wfm-snapshot-feed-item.is-active { border-left-color: #1769e0; background: #eef4ff; }
      .wfm-snapshot-feed-number { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 999px; background: #1769e0; color: #fff; font: 800 14px/1 system-ui, sans-serif; }
      .wfm-snapshot-feed-item strong { display: block; color: #101828; font-size: 14px; line-height: 1.45; white-space: pre-wrap; }
      .wfm-snapshot-feed-item p { margin: 5px 0 0; color: #667085; font-size: 12px; }
      .wfm-snapshot-feed-item blockquote { margin: 8px 0 0; border-left: 3px solid #bcd2ff; color: #667085; padding-left: 8px; font-size: 12px; line-height: 1.45; }
      .wfm-snapshot-feed-item details { margin-top: 8px; color: #1769e0; font-size: 12px; }
      .wfm-snapshot-feed-item details img { display: block; width: 100%; margin-top: 6px; border: 1px solid #d8e0ec; border-radius: 8px; }
      .wfm-snapshot-panel footer { display: grid; gap: 8px; border-top: 1px solid #e4e7ec; background: #f8fafc; padding: 12px 16px 14px; color: #667085; font-size: 12px; line-height: 1.4; }
      .wfm-snapshot-panel footer p { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 8px; margin: 0; }
      .wfm-snapshot-panel footer span { color: #98a2b3; font-weight: 700; }
      .wfm-snapshot-panel footer strong, .wfm-snapshot-panel footer a { overflow: hidden; color: #667085; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
      .wfm-snapshot-panel footer a { color: #1769e0; }
      .wfm-snapshot-panel footer em { border-top: 1px dashed #d8e0ec; color: #98a2b3; font-style: normal; padding-top: 8px; }
      @media (max-width: 900px) { .wfm-snapshot-header, .wfm-snapshot-layout { padding-right: 24px; } .wfm-snapshot-panel { position: static; width: auto; max-height: none; margin-top: 20px; } }
    `;
  }

  function getSnapshotHtmlScript(annotations) {
    const data = JSON.stringify(annotations.map((annotation) => ({
      id: annotation.id
    }))).replace(/</g, "\\u003c");

    return `
      (() => {
        const annotations = ${data};
        const panel = document.querySelector(".wfm-snapshot-panel");
        const toggle = document.querySelector(".wfm-snapshot-toggle");
        const setActive = (id) => {
          document.querySelectorAll("[data-wfm-id]").forEach((node) => {
            node.classList.toggle("is-active", node.dataset.wfmId === id);
          });
        };
        const jumpTo = (id) => {
          const item = annotations.find((entry) => entry.id === id);
          if (!item) return;
          setActive(id);
          const marker = document.querySelector("[data-wfm-anchor='" + CSS.escape(id) + "']");
          (marker || document.querySelector(".wfm-snapshot-stage"))?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        };
        document.querySelectorAll("[data-wfm-jump],.wfm-snapshot-marker").forEach((node) => {
          node.addEventListener("click", (event) => {
            if (event.target.closest("details")) return;
            event.preventDefault();
            jumpTo(node.dataset.wfmJump || node.dataset.wfmId);
          });
          node.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            jumpTo(node.dataset.wfmJump || node.dataset.wfmId);
          });
        });
        toggle?.addEventListener("click", () => {
          panel?.classList.toggle("is-collapsed");
        });
        if (annotations[0]) {
          setActive(annotations[0].id);
        }
      })();
    `;
  }

  function buildAnnotatedHtmlExport({ page, items, exportedAt }) {
    const clonedHtml = document.documentElement.cloneNode(true);
    cleanupClonedDocument(clonedHtml);
    normalizeClonedResources(clonedHtml);
    freezeClonedLayout(clonedHtml);

    const head = clonedHtml.querySelector("head") || clonedHtml;
    const body = clonedHtml.querySelector("body") || clonedHtml;
    const base = document.createElement("base");
    base.href = location.href;
    head.insertBefore(base, head.firstChild);

    const annotations = items.map((item, index) => toExportAnnotation(item, index + 1));
    const style = document.createElement("style");
    style.textContent = getHtmlExportStyles();
    head.appendChild(style);

    const layer = document.createElement("div");
    layer.id = "wfm-export-root";
    layer.innerHTML = renderHtmlExportLayer({
      page,
      exportedAt,
      annotations
    });
    body.appendChild(layer);

    const script = document.createElement("script");
    script.textContent = getHtmlExportScript(annotations);
    body.appendChild(script);

    return `<!doctype html>\n${clonedHtml.outerHTML}`;
  }

  function cleanupClonedDocument(clonedHtml) {
    clonedHtml.querySelector("#web-feedback-assistant-root")?.remove();
    clonedHtml.querySelectorAll("script").forEach((script) => script.remove());
    clonedHtml.querySelectorAll("meta[http-equiv]").forEach((meta) => {
      if (String(meta.getAttribute("http-equiv") || "").toLowerCase() === "content-security-policy") {
        meta.remove();
      }
    });
  }

  function normalizeClonedResources(clonedHtml) {
    syncClonedElements(clonedHtml, "img", (source, clone) => {
      const resolvedSrc = source.currentSrc ||
        source.src ||
        source.getAttribute("data-src") ||
        source.getAttribute("data-original") ||
        source.getAttribute("data-lazy-src");
      if (resolvedSrc) {
        clone.setAttribute("src", resolvedSrc);
        clone.removeAttribute("srcset");
        clone.removeAttribute("sizes");
        clone.setAttribute("loading", "eager");
      }
    });
    syncClonedElements(clonedHtml, "video, iframe, canvas");
  }

  function freezeClonedLayout(clonedHtml) {
    const layoutWidth = Math.ceil(Math.max(
      window.innerWidth,
      document.documentElement.clientWidth,
      document.documentElement.scrollWidth,
      document.body?.clientWidth || 0,
      document.body?.scrollWidth || 0
    ));
    const layoutHeight = Math.ceil(Math.max(
      window.innerHeight,
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0
    ));
    const body = clonedHtml.querySelector("body") || clonedHtml;

    appendInlineStyle(clonedHtml, `min-width:${layoutWidth}px !important;`);
    appendInlineStyle(body, `min-width:${layoutWidth}px !important;min-height:${layoutHeight}px !important;`);
  }

  function syncClonedElements(clonedHtml, selector, normalize = null) {
    const sourceElements = [...document.querySelectorAll(selector)];
    const clonedElements = [...clonedHtml.querySelectorAll(selector)];

    clonedElements.forEach((clone, index) => {
      const source = sourceElements[index];
      if (!source) {
        return;
      }

      if (normalize) {
        normalize(source, clone);
      }

      freezeClonedElementBox(source, clone);
    });
  }

  function freezeClonedElementBox(source, clone) {
    const rect = source.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    appendInlineStyle(clone, `width:${width}px !important;height:${height}px !important;max-width:none !important;max-height:none !important;`);
  }

  function appendInlineStyle(element, styleText) {
    const existingStyle = element.getAttribute("style") || "";
    element.setAttribute("style", `${existingStyle}${existingStyle.trim().endsWith(";") || !existingStyle ? "" : ";"}${styleText}`);
  }

  function toExportAnnotation(item, number) {
    const shape = item.shape || {};
    const point = getExportMarkerPoint(shape);
    return {
      id: item.id || `item-${number}`,
      number,
      type: item.type || shape.type || "point",
      category: item.category || "其他",
      issue: item.issue || "未填写反馈内容",
      createdAt: item.createdAt || "",
      selectedText: item.selectedText || "",
      imageDataUrl: item.imageDataUrl || "",
      shape,
      point
    };
  }

  function getExportMarkerPoint(shape) {
    if (shape?.type === "region") {
      return {
        x: Math.max(0, Math.round(shape.x || 0)),
        y: Math.max(0, Math.round(shape.y || 0))
      };
    }

    return {
      x: Math.max(0, Math.round(shape?.x || 0)),
      y: Math.max(0, Math.round(shape?.y || 0))
    };
  }

  function renderHtmlExportLayer({ page, exportedAt, annotations }) {
    const markerHtml = annotations.map(renderExportMarker).join("");
    const listHtml = annotations.map(renderExportFeedItem).join("");
    const pageTitle = escapeHtml(page.title || "未命名页面");
    const pageUrl = escapeHtml(page.url || location.href);
    const exportedTime = escapeHtml(formatDateOnly(exportedAt));

    return `
      <div class="wfm-export-markers" aria-hidden="true">${markerHtml}</div>
      <aside class="wfm-export-panel" aria-label="修改点全览">
        <header class="wfm-export-panel-head">
          <div>
            <h2>修改点全览</h2>
            <span>共 ${annotations.length} 条</span>
          </div>
          <button class="wfm-export-toggle" type="button" aria-label="收起修改点全览"><span></span></button>
        </header>
        <div class="wfm-export-feed">${listHtml}</div>
        <footer class="wfm-export-foot">
          <div class="wfm-export-source">
            <p title="${pageTitle}"><span>原页面</span><strong>${pageTitle}</strong></p>
            <p title="${pageUrl}"><span>URL</span><a href="${pageUrl}" target="_blank" rel="noreferrer">${pageUrl}</a></p>
            <p><span>导出日期</span><strong>${exportedTime}</strong></p>
          </div>
          <p class="wfm-export-note">轻量离线 HTML：页面资源来自原网页链接，截图证据已保留。</p>
        </footer>
      </aside>
    `;
  }

  function renderExportMarker(annotation) {
    const region = annotation.shape?.type === "region"
      ? `<span class="wfm-export-region" data-wfm-id="${escapeHtml(annotation.id)}" style="left:${Math.round(annotation.shape.x || 0)}px;top:${Math.round(annotation.shape.y || 0)}px;width:${Math.round(annotation.shape.width || 0)}px;height:${Math.round(annotation.shape.height || 0)}px"></span>`
      : "";
    return `
      ${region}
      <button class="wfm-export-marker" type="button" data-wfm-id="${escapeHtml(annotation.id)}" style="left:${annotation.point.x}px;top:${annotation.point.y}px" aria-label="跳转到标注点 ${annotation.number}">
        ${annotation.number}
      </button>
    `;
  }

  function renderExportFeedItem(annotation) {
    const quote = annotation.selectedText
      ? `<blockquote>${escapeHtml(limitText(annotation.selectedText, 120))}</blockquote>`
      : "";
    const evidence = annotation.imageDataUrl
      ? `<details><summary>截图证据</summary><img src="${annotation.imageDataUrl}" alt="标注点 ${annotation.number} 截图证据" /></details>`
      : "";

    return `
      <button class="wfm-export-feed-item" type="button" data-wfm-id="${escapeHtml(annotation.id)}">
        <span class="wfm-export-feed-number">${annotation.number}</span>
        <span class="wfm-export-feed-body">
          <strong>${escapeHtml(annotation.issue)}</strong>
          <em>${escapeHtml(annotation.category)} · ${escapeHtml(formatDateOnly(annotation.createdAt))}</em>
          ${quote}
          ${evidence}
        </span>
      </button>
    `;
  }

  function getHtmlExportStyles() {
    return `
      html { scroll-behavior: smooth; }
      #wfm-export-root {
        color: #101828;
        font-family: "HarmonyOS Sans SC", "HarmonyOS Sans", "鸿蒙黑体", "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }
      .wfm-export-marker {
        position: absolute;
        z-index: 2147483001;
        display: grid;
        width: 30px;
        height: 30px;
        place-items: center;
        transform: translate(-50%, -50%);
        border: 2px solid #fff;
        border-radius: 999px;
        background: #1769e0;
        box-shadow: 0 10px 22px rgba(23, 105, 224, 0.24);
        color: #fff;
        cursor: pointer;
        font: 800 15px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wfm-export-marker.is-active {
        width: 36px;
        height: 36px;
        background: #0f55b8;
        box-shadow: 0 0 0 8px rgba(23, 105, 224, 0.14), 0 12px 28px rgba(23, 105, 224, 0.28);
      }
      .wfm-export-region {
        position: absolute;
        z-index: 2147483000;
        border: 2px solid rgba(23, 105, 224, 0.28);
        border-radius: 8px;
        background: rgba(23, 105, 224, 0.045);
        pointer-events: none;
      }
      .wfm-export-region.is-active {
        border-color: #1769e0;
        background: rgba(23, 105, 224, 0.08);
        box-shadow: 0 0 0 4px rgba(23, 105, 224, 0.1);
      }
      .wfm-export-panel {
        position: fixed;
        top: 88px;
        right: 22px;
        z-index: 2147483002;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        width: min(360px, calc(100vw - 32px));
        max-height: calc(100vh - 126px);
        overflow: hidden;
        border: 1px solid rgba(208, 213, 221, 0.92);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.16);
        backdrop-filter: blur(10px);
      }
      .wfm-export-panel.is-collapsed {
        max-height: 58px;
      }
      .wfm-export-panel.is-collapsed .wfm-export-feed,
      .wfm-export-panel.is-collapsed .wfm-export-foot {
        display: none;
      }
      .wfm-export-panel-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        min-height: 58px;
        border-bottom: 1px solid #eef2f7;
        padding: 14px 16px;
      }
      .wfm-export-panel h2 {
        margin: 0;
        color: #101828;
        font-size: 18px;
        line-height: 1.2;
      }
      .wfm-export-panel-head span,
      .wfm-export-foot,
      .wfm-export-feed-body em,
      .wfm-export-feed-body blockquote {
        color: #667085;
      }
      .wfm-export-toggle {
        position: relative;
        width: 30px;
        height: 30px;
        border: 1px solid #d8e0ec;
        border-radius: 8px;
        background: #fff;
        cursor: pointer;
        padding: 0;
      }
      .wfm-export-toggle span {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 8px;
        height: 8px;
        border-right: 2px solid #1769e0;
        border-bottom: 2px solid #1769e0;
        transform: translate(-50%, -62%) rotate(45deg);
        transition: transform 0.16s ease;
      }
      .wfm-export-panel.is-collapsed .wfm-export-toggle span {
        transform: translate(-50%, -35%) rotate(225deg);
      }
      .wfm-export-feed {
        overflow: auto;
      }
      .wfm-export-feed-item {
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr);
        gap: 12px;
        width: 100%;
        border: 0;
        border-left: 3px solid transparent;
        border-bottom: 1px solid #eef2f7;
        background: transparent;
        cursor: pointer;
        padding: 14px 16px 14px 13px;
        text-align: left;
      }
      .wfm-export-feed-item:hover,
      .wfm-export-feed-item.is-active {
        border-left-color: #1769e0;
        background: #eef4ff;
      }
      .wfm-export-feed-number {
        display: grid;
        width: 26px;
        height: 26px;
        place-items: center;
        border-radius: 999px;
        background: #1769e0;
        color: #fff;
        font: 800 14px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wfm-export-feed-body {
        display: grid;
        gap: 5px;
        min-width: 0;
      }
      .wfm-export-feed-body strong {
        color: #101828;
        font-size: 14px;
        line-height: 1.45;
        white-space: pre-wrap;
      }
      .wfm-export-feed-body em {
        font-size: 12px;
        font-style: normal;
        line-height: 1.25;
      }
      .wfm-export-feed-body blockquote {
        margin: 4px 0 0;
        border-left: 3px solid #bcd2ff;
        padding-left: 8px;
        font-size: 12px;
        line-height: 1.45;
      }
      .wfm-export-feed-body details {
        margin-top: 4px;
        color: #1769e0;
        font-size: 12px;
      }
      .wfm-export-feed-body details img {
        display: block;
        width: 100%;
        margin-top: 6px;
        border: 1px solid #d8e0ec;
        border-radius: 8px;
      }
      .wfm-export-foot {
        display: grid;
        gap: 10px;
        border-top: 1px solid #e4e7ec;
        background: #f8fafc;
        padding: 12px 16px 14px;
        font-size: 12px;
        line-height: 1.4;
      }
      .wfm-export-foot p {
        margin: 0;
      }
      .wfm-export-source {
        display: grid;
        gap: 7px;
      }
      .wfm-export-source p {
        display: grid;
        grid-template-columns: 58px minmax(0, 1fr);
        gap: 8px;
        align-items: baseline;
        min-width: 0;
      }
      .wfm-export-source span {
        color: #98a2b3;
        font-weight: 700;
      }
      .wfm-export-source strong,
      .wfm-export-source a {
        display: block;
        min-width: 0;
        overflow: hidden;
        color: #667085;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wfm-export-foot a {
        color: #1769e0;
      }
      .wfm-export-note {
        border-top: 1px dashed #d8e0ec;
        color: #98a2b3;
        padding-top: 10px;
      }
      @media print {
        #wfm-export-root { display: none !important; }
      }
    `;
  }

  function getHtmlExportScript(annotations) {
    const data = JSON.stringify(annotations.map((annotation) => ({
      id: annotation.id,
      y: annotation.point.y
    }))).replace(/</g, "\\u003c");

    return `
      (() => {
        const annotations = ${data};
        const panel = document.querySelector(".wfm-export-panel");
        const toggle = document.querySelector(".wfm-export-toggle");
        const setActive = (id) => {
          document.querySelectorAll("[data-wfm-id]").forEach((node) => {
            node.classList.toggle("is-active", node.dataset.wfmId === id);
          });
        };
        const jumpTo = (id) => {
          const item = annotations.find((entry) => entry.id === id);
          if (!item) return;
          setActive(id);
          window.scrollTo({ top: Math.max(0, item.y - 130), behavior: "smooth" });
        };
        document.querySelectorAll(".wfm-export-feed-item,.wfm-export-marker").forEach((node) => {
          node.addEventListener("click", (event) => {
            event.preventDefault();
            jumpTo(node.dataset.wfmId);
          });
        });
        toggle?.addEventListener("click", () => {
          panel?.classList.toggle("is-collapsed");
        });
        if (annotations[0]) {
          setActive(annotations[0].id);
        }
      })();
    `;
  }

  function downloadTextFile(content, fileName) {
    const blob = new Blob([content], { type: "text/html;charset=utf-8" });
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

  async function createFeedbackSnapshot(shape, number) {
    overlay.root.classList.add("is-capturing");
    await waitNextFrame();
    await waitNextFrame();

    let capture;
    try {
      capture = await chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" });
    } finally {
      overlay.root.classList.remove("is-capturing");
    }

    if (!capture?.dataUrl) {
      throw new Error(capture?.error || "无法截取页面。");
    }

    const image = await loadImage(capture.dataUrl);
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };
    const crop = getSnapshotCrop(shape, viewport);
    const scaleX = image.naturalWidth / viewport.width;
    const scaleY = image.naturalHeight / viewport.height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(crop.width * scaleX));
    canvas.height = Math.max(1, Math.round(crop.height * scaleY));
    const ctx = canvas.getContext("2d");

    ctx.drawImage(
      image,
      Math.round(crop.x * scaleX),
      Math.round(crop.y * scaleY),
      Math.round(crop.width * scaleX),
      Math.round(crop.height * scaleY),
      0,
      0,
      canvas.width,
      canvas.height
    );

    ctx.save();
    ctx.scale(scaleX, scaleY);
    drawShape(ctx, pageShapeToViewport(shape), {
      number,
      color: MARK_COLOR,
      draft: false,
      offsetX: -crop.x,
      offsetY: -crop.y
    });
    ctx.restore();

    return canvas.toDataURL("image/jpeg", 0.88);
  }

  function getSnapshotCrop(shape, viewport) {
    const viewportShape = pageShapeToViewport(shape);
    let crop;

    if (shape.type === "region") {
      crop = {
        x: viewportShape.x - REGION_PADDING,
        y: viewportShape.y - REGION_PADDING,
        width: viewportShape.width + REGION_PADDING * 2,
        height: viewportShape.height + REGION_PADDING * 2
      };
    } else {
      const width = Math.min(POINT_CAPTURE_WIDTH, viewport.width);
      const height = Math.min(POINT_CAPTURE_HEIGHT, viewport.height);
      crop = {
        x: viewportShape.x - width / 2,
        y: viewportShape.y - height / 2,
        width,
        height
      };
    }

    crop.x = clamp(crop.x, 0, Math.max(0, viewport.width - crop.width));
    crop.y = clamp(crop.y, 0, Math.max(0, viewport.height - crop.height));
    crop.width = Math.min(crop.width, viewport.width - crop.x);
    crop.height = Math.min(crop.height, viewport.height - crop.y);
    return crop;
  }

  async function addItem(item) {
    const items = await loadItems();
    await setLocalStorage({ [STORAGE_KEY]: [item, ...items] });
  }

  async function startAiScanPage() {
    if (aiScanJob) {
      const message = "AI 检查已在进行中，可关闭弹窗，页面会继续显示进度。";
      resumeAiProgressFromState().catch(() => {
        showHint(message, false, 0);
      });
      return {
        status: "running",
        message
      };
    }

    if (!session) {
      await startAnnotationMode();
    }

    const message = "AI 检查已开始，可关闭弹窗，页面会继续显示进度。";
    const startedAt = Date.now();
    aiScanJob = runAiScanJob(startedAt)
      .then(async (result) => {
        if (!result?.notificationSent) {
          await notifyAiScanFinished(result, startedAt);
        }
        return result;
      })
      .catch(async (error) => {
        const errorMessage = getFriendlyErrorMessage(error, "AI 检查失败。");
        await setAiScanState({
          status: "error",
          message: errorMessage
        });
        showHint(errorMessage, true);
        if (!error?.notificationSent) {
          await notifyAiScanFinished({
            status: "error",
            message: errorMessage
          }, startedAt, true);
        }
      })
      .finally(() => {
        aiScanJob = null;
      });

    showAiProgressHint({
      message,
      doneChars: 0,
      totalChars: 0,
      found: 0,
      startedAt
    });
    return {
      status: "started",
      message
    };
  }

  async function getAiScanRuntimeState() {
    if (!aiScanJob) {
      return {
        running: false
      };
    }

    if (!session) {
      await startAnnotationMode();
    }

    await resumeAiProgressFromState();
    return {
      running: true
    };
  }

  async function runAiScanJob(startedAt = Date.now()) {
    toggleMenu(false);
    lastAiScanDebug = createAiScanDebugSnapshot({
      phase: "starting",
      startedAt
    });
    showAiProgressHint({
      message: "正在准备 AI 检查：提取页面正文...",
      doneChars: 0,
      totalChars: 0,
      found: 0,
      startedAt
    });
    await setAiScanState({
      status: "running",
      phase: "extracting",
      startedAt,
      message: "正在准备 AI 检查：提取页面正文...",
      progress: { done: 0, total: 0, found: 0 }
    });

    const blocks = extractVisibleTextBlocks();
    const checkedChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
    lastAiScanDebug = {
      ...lastAiScanDebug,
      phase: "extracted",
      checkedBlocks: blocks.length,
      checkedChars,
      selectedBlockPreviews: blocks.map(previewScanBlock)
    };
    if (!blocks.length) {
      const message = "未发起 AI 检查：当前页面没有提取到可检查的正文文本。";
      showHint(message, true, 5200, { reason: "no_text" });
      const result = {
        status: "no_text",
        count: 0,
        checkedBlocks: 0,
        checkedChars: 0,
        message
      };
      await setAiScanState(result);
      return result;
    }

    showAiProgressHint({
      message: "正在等待 AI 服务响应...",
      doneChars: 0,
      totalChars: checkedChars,
      found: 0,
      startedAt
    });
    await setAiScanState({
      status: "running",
      phase: "requesting",
      startedAt,
      message: "正在等待 AI 服务响应...",
      checkedBlocks: blocks.length,
      checkedChars,
      progress: { done: 0, total: blocks.length, doneChars: 0, totalChars: checkedChars, found: 0 }
    });

    const response = await chrome.runtime.sendMessage({
      type: "AI_SCAN_TEXT",
      notify: true,
      blocks: blocks.map((block) => ({
        id: block.id,
        text: block.text,
        charCount: block.text.length
      }))
    });

    if (response?.error) {
      const error = new Error(response.error);
      error.notificationSent = response.notificationSent === true;
      error.notificationPermission = response.notificationPermission || "unknown";
      error.notificationError = response.notificationError || "";
      throw error;
    }

    showAiProgressHint({
      message: "AI 服务已返回，正在整理页面标记...",
      doneChars: checkedChars,
      totalChars: checkedChars,
      found: 0,
      startedAt
    });

    const rawFindings = Array.isArray(response?.findings) ? response.findings : [];
    const findings = [];
    const unmappedFindings = [];
    rawFindings.forEach((finding) => {
      const mappedFinding = toAiFinding(finding, blocks);
      if (mappedFinding) {
        findings.push(mappedFinding);
        if (mappedFinding.locationStatus === AiCore.LOCATION_STATUS.UNMAPPED) {
          unmappedFindings.push(finding);
        }
      } else {
        unmappedFindings.push(finding);
      }
    });
    lastAiScanDebug = {
      ...lastAiScanDebug,
      phase: "mapped",
      rawFindingCount: rawFindings.length,
      mappedFindingCount: findings.length,
      unmappedFindingCount: unmappedFindings.length,
      responseTotalChars: response?.totalChars || 0,
      failedBlockCount: response?.failedBlocks || 0,
      notificationSent: response?.notificationSent === true,
      notificationPermission: response?.notificationPermission || "unknown",
      notificationError: response?.notificationError || "",
      rawFindingPreviews: rawFindings.slice(0, 8).map(previewAiFinding),
      unmappedFindingPreviews: unmappedFindings.slice(0, 8).map(previewAiFinding)
    };

    if (rawFindings.length && !findings.length) {
      const message = `AI 已检查完成，但 ${rawFindings.length} 条结果无法对应到页面文字位置，已保留在反馈清单中。`;
      showHint(message, true, 6500, {
        reason: "ai_unmapped",
        rawFindings: rawFindings.slice(0, 8).map(previewAiFinding)
      });
      const result = {
        status: "unmapped",
        count: 0,
        rawCount: rawFindings.length,
        checkedBlocks: blocks.length,
        checkedChars,
        message,
        notificationSent: response.notificationSent === true,
        notificationPermission: response.notificationPermission || "unknown",
        notificationError: response.notificationError || ""
      };
      await setAiScanState(result);
      return result;
    }

    if (!findings.length) {
      const message = `AI 检查完成：已检查约 ${checkedChars} 字，未发现需要标记的问题。`;
      showHint(message, false, 6500);
      const result = {
        status: "no_issue",
        count: 0,
        checkedBlocks: blocks.length,
        checkedChars,
        message,
        notificationSent: response.notificationSent === true,
        notificationPermission: response.notificationPermission || "unknown",
        notificationError: response.notificationError || ""
      };
      await setAiScanState(result);
      return result;
    }

    const saved = await addAiFindings(findings);
    session.aiFindings = getCurrentPageAiFindings(saved.items, session.page.url);
    renderAll();
    const listOnlyCount = findings.filter((finding) => finding.renderMode === AiCore.RENDER_MODE.LIST_ONLY).length;
    const message = saved.addedCount
      ? `AI 检查完成：已检查约 ${checkedChars} 字，新增 ${saved.addedCount} 条待确认结果${listOnlyCount ? `，其中 ${listOnlyCount} 条未能在页面上画标记` : ""}。`
      : `AI 检查完成：已检查约 ${checkedChars} 字，发现的 ${findings.length} 条疑似问题已存在，无新增标记。`;
    showHint(message, false, 6500);
    const result = {
      status: saved.addedCount ? "found" : "duplicate",
      count: saved.addedCount,
      rawCount: rawFindings.length,
      checkedBlocks: blocks.length,
      checkedChars,
      message,
      notificationSent: response.notificationSent === true,
      notificationPermission: response.notificationPermission || "unknown",
      notificationError: response.notificationError || ""
    };
    await setAiScanState(result);
    return result;
  }

  async function notifyAiScanFinished(result = {}, startedAt = 0, isError = false) {
    const elapsed = startedAt ? formatElapsedDuration(Date.now() - startedAt) : "";
    const checkedText = result.checkedChars ? `已检查约 ${result.checkedChars} 字` : "";
    const detail = [buildAiScanNotificationSummary(result, isError), checkedText, elapsed ? `用时 ${elapsed}` : ""]
      .filter(Boolean)
      .join("；");

    const response = await chrome.runtime.sendMessage({
      type: "SHOW_NOTIFICATION",
      title: isError ? "AI 检查失败" : "AI 检查完成",
      message: detail || result.message || "AI 检查已完成。",
      contextMessage: limitText(session?.page?.title || document.title || "", 60),
      priority: isError ? 1 : 0
    }).catch((error) => ({ error: getFriendlyErrorMessage(error, "通知发送失败。") }));

    if (response?.error) {
      lastAiScanDebug = {
        ...(lastAiScanDebug || {}),
        notificationSent: false,
        notificationError: response.error,
        notificationFailedAt: new Date().toISOString()
      };
      return false;
    }

    lastAiScanDebug = {
      ...(lastAiScanDebug || {}),
      notificationSent: true,
      notificationPermission: response?.permissionLevel || "unknown"
    };
    return true;
  }
  function buildAiScanNotificationSummary(result = {}, isError = false) {
    if (isError || result.status === "error") {
      return result.message || "检查未完成，请回到页面查看原因。";
    }

    if (result.status === "found") {
      return `新增 ${result.count || 0} 条待确认标记`;
    }

    if (result.status === "duplicate") {
      return `发现 ${result.rawCount || 0} 条疑似问题，但都已存在，未新增标记`;
    }

    if (result.status === "no_issue") {
      return "未发现需要标记的问题";
    }

    if (result.status === "unmapped") {
      return `AI 返回 ${result.rawCount || 0} 条疑似问题，但未能定位到页面文字`;
    }

    if (result.status === "no_text") {
      return "未提取到可检查的正文内容";
    }

    return result.message || "AI 检查已完成";
  }

  function updateAiScanProgress(progress) {
    if (!progress) {
      return;
    }

    const total = Number(progress.total || 0);
    const done = Number(progress.done || 0);
    const doneChars = Number(progress.doneChars || 0);
    const totalChars = Number(progress.totalChars || 0);
    const suffix = totalChars > 0 ? "" : total > 0 ? `（${done}/${total}）` : "";
    const message = progress.message || `AI 检查处理中${suffix}`;
    showAiProgressHint({
      message,
      doneChars,
      totalChars,
      found: Number(progress.found || 0),
      startedAt: progress.startedAt || aiProgressView.startedAt
    });
    setAiScanState({
      status: "running",
      phase: progress.stage || "requesting",
      message,
      progress
    }).catch(() => {});
  }

  async function setAiScanState(value) {
    const rawStartedAt = value?.startedAt || aiProgressView.startedAt;
    const startedAt = Number(rawStartedAt) || 0;
    const state = {
      pageUrl: session?.page?.url || location.href,
      pageTitle: session?.page?.title || document.title || "",
      updatedAt: new Date().toISOString(),
      ...(value?.status === "running" && startedAt ? { startedAt } : {}),
      ...value
    };
    await setLocalStorage({ [AI_SCAN_STATE_KEY]: state });
  }

  function extractVisibleTextBlocks() {
    const candidates = [];
    const scanRoot = getContentScanRoot();
    const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (shouldSkipTextElement(node)) {
          return NodeFilter.FILTER_REJECT;
        }

        const text = getDirectVisibleText(node);
        if (text.length < 40) {
          return NodeFilter.FILTER_SKIP;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node = walker.nextNode();
    while (node) {
      const text = normalizeScanText(node.innerText || node.textContent || "");
      const rect = node.getBoundingClientRect();
      if (text.length >= 40 && rect.width > 20 && rect.height > 10 && !isLikelyPeripheralViewportRect(rect)) {
        candidates.push({
          text: normalizeAiBlockText(text).slice(0, 900),
          element: node,
          rect: {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height
          }
        });
      }
      node = walker.nextNode();
    }

    const seen = new Set();
    const uniqueBlocks = candidates
      .sort((left, right) => {
        const topDiff = left.rect.y - right.rect.y;
        if (Math.abs(topDiff) > 24) {
          return topDiff;
        }
        return left.rect.x - right.rect.x;
      })
      .filter((block) => {
        const fingerprint = getTextFingerprint(block.text);
        if (!fingerprint || seen.has(fingerprint)) {
          return false;
        }
        seen.add(fingerprint);
        return true;
      });

    const selectedBlocks = uniqueBlocks
      .slice(0, MAX_AI_SCAN_BLOCKS)
      .map((block, index) => ({
        ...block,
        id: `block_${index + 1}`
      }));

    lastAiScanDebug = {
      ...lastAiScanDebug,
      phase: "extracted_candidates",
      scanRoot: describeElement(scanRoot),
      candidateBlockCount: candidates.length,
      uniqueBlockCount: uniqueBlocks.length,
      maxSelectedBlocks: MAX_AI_SCAN_BLOCKS,
      selectedBlockCount: selectedBlocks.length,
      selectedChars: selectedBlocks.reduce((sum, block) => sum + block.text.length, 0),
      candidatePreviews: uniqueBlocks.slice(0, 8).map(previewScanBlock),
      selectedBlockPreviews: selectedBlocks.map(previewScanBlock)
    };

    return selectedBlocks;
  }

  function getTextFingerprint(text) {
    return normalizeScanText(text)
      .replace(/\s+/g, "")
      .slice(0, 240);
  }

  function isLikelyPeripheralViewportRect(rect) {
    if (window.innerWidth < 960) {
      return false;
    }

    const centerX = rect.left + rect.width / 2;
    return centerX < window.innerWidth * 0.18 || centerX > window.innerWidth * 0.78;
  }

  function getContentScanRoot() {
    const semanticRoot = document.querySelector("article, main, [role='main']");
    if (semanticRoot && getVisibleTextLength(semanticRoot) >= 120) {
      return semanticRoot;
    }

    const candidates = [...document.body.querySelectorAll("article, main, section, .article, .content, .post, .entry, .main, #article, #content, #main")]
      .filter((node) => node instanceof Element && !shouldSkipTextElement(node))
      .map((node) => ({
        node,
        textLength: getVisibleTextLength(node),
        rect: node.getBoundingClientRect()
      }))
      .filter((item) => item.textLength >= 120 && item.rect.width > 160 && item.rect.height > 80)
      .sort((left, right) => right.textLength - left.textLength);

    return candidates[0]?.node || document.body;
  }

  function getVisibleTextLength(node) {
    if (!node || shouldSkipTextElement(node)) {
      return 0;
    }
    return normalizeScanText(node.innerText || node.textContent || "").length;
  }

  function shouldSkipTextElement(node) {
    if (!(node instanceof Element)) {
      return true;
    }

    if (overlay?.host && overlay.host.contains(node)) {
      return true;
    }

    const tagName = node.tagName.toLowerCase();
    if (["script", "style", "svg", "noscript", "textarea", "input", "select", "button", "nav", "footer", "header", "aside"].includes(tagName)) {
      return true;
    }

    const role = String(node.getAttribute("role") || "").toLowerCase();
    if (["navigation", "banner", "contentinfo", "complementary", "search", "menu"].includes(role)) {
      return true;
    }

    const identity = `${node.id || ""} ${node.className || ""}`.toLowerCase();
    if (/(^|[-_\s])(nav|navbar|navigation|footer|header|sidebar|aside|toc|catalog|breadcrumb|menu|comment|comments|related|recommend|ad|ads|advert|promotion)([-_\s]|$)/.test(identity)) {
      return true;
    }

    const style = window.getComputedStyle(node);
    return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
  }

  function getDirectVisibleText(node) {
    const text = normalizeScanText(node.innerText || node.textContent || "");
    if (!text) {
      return "";
    }

    const childTextLength = [...node.children]
      .filter((child) => !shouldSkipTextElement(child))
      .reduce((sum, child) => sum + normalizeScanText(child.innerText || child.textContent || "").length, 0);

    if (node.children.length > 3 && childTextLength > text.length * 0.45) {
      return "";
    }

    return text.length - childTextLength > 20 ? text : "";
  }

  function normalizeScanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeAiBlockText(value) {
    return normalizeScanText(value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function toAiFinding(finding, blocks) {
    const block = blocks.find((item) => item.id === finding.blockId) || blocks[0];
    const textMatch = findTextMatch(finding.originalText, block?.element);
    const rect = textMatch?.rect || null;
    const isExact = Boolean(rect && textMatch?.rects?.length);

    return AiCore.normalizeFinding({
      id: createId("ai"),
      source: "ai",
      pageTitle: session.page.title,
      pageUrl: session.page.url,
      createdAt: new Date().toISOString(),
      status: "pending",
      category: AiCore.mapCategory(finding.errorType),
      errorType: finding.errorType || "其他",
      issue: buildAiIssueText(finding),
      originalText: finding.originalText || "",
      suggestedText: finding.suggestedText || "",
      reason: finding.reason || "",
      severity: finding.severity || "medium",
      confidence: finding.confidence ?? null,
      context: finding.context || "",
      locationStatus: isExact ? AiCore.LOCATION_STATUS.EXACT : AiCore.LOCATION_STATUS.UNMAPPED,
      renderMode: isExact ? AiCore.RENDER_MODE.MARKER : AiCore.RENDER_MODE.LIST_ONLY,
      locationNote: isExact ? "" : "未在页面中找到准确文字位置，已保留在反馈清单中。",
      debug: {
        blockId: block?.id || "",
        locationStatus: isExact ? AiCore.LOCATION_STATUS.EXACT : AiCore.LOCATION_STATUS.UNMAPPED
      },
      shape: isExact
        ? {
          type: "aiText",
          x: rect.x + rect.width / 2,
          y: rect.y + Math.min(rect.height / 2, 28),
          width: rect.width,
          height: rect.height,
          rects: textMatch.rects
        }
        : null
    });
  }

  function findTextMatch(text, root = document.body) {
    const target = normalizeScanText(text);
    if (!target) {
      return null;
    }

    const match = findTextNodeMatch(target, root) || (root === document.body ? null : findTextNodeMatch(target, document.body));
    if (!match) {
      return null;
    }

    const range = document.createRange();
    range.setStart(match.node, match.start);
    range.setEnd(match.node, match.end);
    const clientRects = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1);
    const fallbackRect = range.getBoundingClientRect();
    range.detach();

    const rects = (clientRects.length ? clientRects : [fallbackRect])
      .filter((rect) => rect.width > 1 && rect.height > 1)
      .slice(0, 4)
      .map((rect) => ({
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height
      }));

    if (!rects.length) {
      return null;
    }

    return {
      rect: getUnionRect(rects),
      rects
    };
  }

  function findTextNodeMatch(target, root) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || shouldSkipTextElement(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        return normalizeScanText(node.nodeValue).includes(target)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      }
    });

    const node = walker.nextNode();
    if (!node) {
      return null;
    }

    const raw = node.nodeValue || "";
    const index = raw.indexOf(target);
    const start = index >= 0 ? index : 0;
    const end = Math.min(raw.length, start + String(target).length);
    return {
      node,
      start,
      end
    };
  }

  function getUnionRect(rects) {
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    };
  }

  function buildAiIssueText(finding) {
    const parts = [];
    if (finding.originalText) {
      parts.push(`原文：${finding.originalText}`);
    }
    if (finding.suggestedText) {
      parts.push(`建议：${finding.suggestedText}`);
    }
    if (finding.reason) {
      parts.push(`原因：${finding.reason}`);
    }
    return parts.join("\n") || "AI 检查发现疑似问题。";
  }

  async function addAiFindings(findings) {
    const items = await loadAiFindings();
    const pageItems = getCurrentPageItems(items, session.page.url);
    const uniqueFindings = AiCore.mergeUniqueFindings(findings, pageItems);

    const nextItems = [...uniqueFindings, ...items];
    await setLocalStorage({ [AI_FINDINGS_KEY]: nextItems });
    return {
      items: nextItems,
      addedCount: uniqueFindings.length
    };
  }

  async function loadAiFindings() {
    const result = await getLocalStorage(AI_FINDINGS_KEY);
    return AiCore.normalizeStoredFindings(Array.isArray(result[AI_FINDINGS_KEY]) ? result[AI_FINDINGS_KEY] : []);
  }

  async function updateAiFindingStatus(itemId, status) {
    if (status === "confirmed") {
      await confirmAiFinding(itemId);
      return;
    }

    const items = await loadAiFindings();
    const nextItems = items.map((item) => item.id === itemId ? { ...item, status } : item);
    await setLocalStorage({ [AI_FINDINGS_KEY]: nextItems });
    await syncPageItemsFromStorage();
    showHint(status === "confirmed" ? "已确认这条 AI 检查结果。" : "AI 检查结果已更新。");
  }

  async function confirmAiFinding(itemId) {
    const [items, aiFindings] = await Promise.all([loadItems(), loadAiFindings()]);
    const finding = aiFindings.find((item) => item.id === itemId);
    if (!finding) {
      showHint("没有找到这条 AI 标记。", true, 4200);
      return;
    }

    const alreadyExists = items.some((item) => item.sourceAiFindingId === itemId);
    const remainingAiFindings = aiFindings.filter((item) => item.id !== itemId);
    const nextItems = alreadyExists ? items : [await createFeedbackItemFromAiFinding(finding), ...items];
    await setLocalStorage({
      [STORAGE_KEY]: nextItems,
      [AI_FINDINGS_KEY]: remainingAiFindings
    });
    await syncPageItemsFromStorage();
    pinnedPopoverId = "";
    highlightedItemId = "";
    hidePopover();
    showHint(alreadyExists ? "这条 AI 结果已在反馈清单中。" : "已确认问题，并加入正式反馈。");
  }

  async function createFeedbackItemFromAiFinding(finding) {
    const shape = {
      ...(finding.shape || {}),
      type: finding.shape?.type === "point" ? "point" : "text"
    };
    const issue = buildConfirmedAiIssue(finding);
    let imageDataUrl = "";
    try {
      if (shape.x && shape.y && isViewportShapeVisible(pageShapeToViewport(shape))) {
        imageDataUrl = await createFeedbackSnapshot(shape, session.pageItems.length + 1);
      }
    } catch (_error) {
      imageDataUrl = "";
    }

    return {
      id: createId("item"),
      sessionId: session.id,
      source: "ai-confirmed",
      sourceAiFindingId: finding.id,
      type: "text",
      pageTitle: session.page.title,
      pageUrl: session.page.url,
      createdAt: new Date().toISOString(),
      category: finding.category || AiCore.mapCategory(finding.errorType),
      issue,
      selectedText: finding.originalText || "",
      shape,
      locationText: "文本引用附近",
      imageDataUrl,
      snapshotRangeText: `文本引用周边 ${POINT_CAPTURE_WIDTH}×${POINT_CAPTURE_HEIGHT}px`
    };
  }

  function buildConfirmedAiIssue(finding) {
    const parts = [];
    if (finding.reason) {
      parts.push(finding.reason);
    }
    if (finding.suggestedText && !AiCore.isTrivialSuggestion(finding.originalText, finding.suggestedText)) {
      parts.push(`建议：${finding.suggestedText}`);
    }
    return parts.join("\n") || finding.issue || "AI 检查确认的问题。";
  }

  async function deleteAiFinding(itemId) {
    const items = await loadAiFindings();
    const nextItems = items.filter((item) => item.id !== itemId);
    await setLocalStorage({ [AI_FINDINGS_KEY]: nextItems });
    await syncPageItemsFromStorage();
    showHint("已删除这条 AI 标记。");
  }

  async function clearCurrentPageFeedback(pageUrl = location.href) {
    const targetUrl = pageUrl || session?.page?.url || location.href;
    const [items, aiFindings] = await Promise.all([loadItems(), loadAiFindings()]);
    await setLocalStorage({
      [STORAGE_KEY]: items.filter((item) => item.pageUrl !== targetUrl),
      [AI_FINDINGS_KEY]: aiFindings.filter((item) => item.pageUrl !== targetUrl)
    });

    if (session?.page?.url === targetUrl) {
      session.pageItems = [];
      session.aiFindings = [];
      session.newItems = [];
      pinnedPopoverId = "";
      highlightedItemId = "";
      hidePopover();
      renderAll();
      showHint("已清空当前页反馈和 AI 标记。");
    }
  }

  async function deleteItem(itemId) {
    const items = await loadItems();
    const item = items.find((entry) => entry.id === itemId);
    if (!item) {
      showHint("没有找到要删除的反馈。", true, 4200);
      return;
    }

    const confirmed = window.confirm("确定删除这条反馈吗？");
    if (!confirmed) {
      return;
    }

    const remaining = items.filter((item) => item.id !== itemId);
    await setLocalStorage({ [STORAGE_KEY]: remaining });
    await syncPageItemsFromStorage();
    showHint("已删除 1 条反馈。");
  }

  async function loadItems() {
    const result = await getLocalStorage(STORAGE_KEY);
    return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  }

  async function loadDockPosition() {
    const result = await getLocalStorage(DOCK_POSITION_KEY);
    return normalizeDockPosition(result[DOCK_POSITION_KEY]);
  }

  function saveDockPosition() {
    setLocalStorage({
      [DOCK_POSITION_KEY]: {
        side: dockState.side,
        top: dockState.top
      }
    }).catch(() => {});
  }

  function getLocalStorageArea() {
    const storageArea = globalThis.chrome?.storage?.local;
    if (!storageArea) {
      throw new Error("当前页面无法访问插件本地存储，请刷新页面后重试。");
    }

    return storageArea;
  }

  async function getLocalStorage(key) {
    return getLocalStorageArea().get(key);
  }

  async function setLocalStorage(value) {
    return getLocalStorageArea().set(value);
  }

  async function syncPageItemsFromStorage() {
    if (!session) {
      return;
    }

    const [items, aiFindings] = await Promise.all([loadItems(), loadAiFindings()]);
    session.pageItems = getCurrentPageItems(items, session.page.url).reverse();
    session.aiFindings = getCurrentPageAiFindings(aiFindings, session.page.url);
    const currentIds = new Set(session.pageItems.map((item) => item.id));
    const currentAiIds = new Set(session.aiFindings.map((item) => item.id));
    session.newItems = session.newItems.filter((item) => currentIds.has(item.id));

    if (pinnedPopoverId && !currentIds.has(pinnedPopoverId) && !currentAiIds.has(pinnedPopoverId)) {
      pinnedPopoverId = "";
      hidePopover();
    }

    if (highlightedItemId && !currentIds.has(highlightedItemId) && !currentAiIds.has(highlightedItemId)) {
      highlightedItemId = "";
    }

    renderAll();
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== "local" || (!changes[STORAGE_KEY] && !changes[AI_FINDINGS_KEY]) || !session) {
      return;
    }

    syncPageItemsFromStorage().catch(() => {
      showHint("反馈列表同步失败，请重新进入批注模式。", true, 4200);
    });
  }

  function getCurrentPageItems(items, pageUrl) {
    return items.filter((item) => item.pageUrl === pageUrl);
  }

  function getCurrentPageAiFindings(items, pageUrl) {
    return sortItemsByReadingOrder(AiCore.normalizeStoredFindings(getCurrentPageItems(items, pageUrl))
      .filter(isDisplayableAiFinding));
  }

  function isDisplayableAiFinding(item) {
    return AiCore.isDisplayableFinding(item) && !isPeripheralAiFinding(item);
  }

  function isPeripheralAiFinding(item) {
    if (item?.shape?.type !== "aiText") {
      return false;
    }

    const rect = getStoredAiTextMatch(item)?.rect;
    return rect ? isLikelyPeripheralPageRect(rect) : false;
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
    const liveRect = getLiveAiTextRect(item);
    if (liveRect) {
      return liveRect.y;
    }

    const shape = item?.shape || {};
    const value = shape.y ?? shape.y1 ?? shape.top ?? 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function getItemSortX(item) {
    const liveRect = getLiveAiTextRect(item);
    if (liveRect) {
      return liveRect.x;
    }

    const shape = item?.shape || {};
    const value = shape.x ?? shape.x1 ?? shape.left ?? 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function getLiveAiTextRect(item) {
    if (item?.shape?.type !== "aiText" || !item.originalText) {
      return null;
    }

    return getAiTextRenderMatch(item)?.rect || null;
  }

  function getAiTextRenderMatch(item) {
    if (item?.shape?.type !== "aiText" || !item.originalText) {
      return null;
    }

    const textMatch = findTextMatch(item.originalText);
    const storedMatch = getStoredAiTextMatch(item);

    if (!storedMatch) {
      return textMatch;
    }

    if (!textMatch) {
      return storedMatch;
    }

    return getRectDistance(textMatch.rect, storedMatch.rect) > 180 ? storedMatch : textMatch;
  }

  function getManualTextRenderMatch(item) {
    const liveMatch = item?.selectedText ? findTextMatch(item.selectedText) : null;
    const storedMatch = getStoredTextRangeMatch(item);

    if (!storedMatch) {
      return liveMatch;
    }

    if (!liveMatch) {
      return storedMatch;
    }

    return getRectDistance(liveMatch.rect, storedMatch.rect) > 180 ? storedMatch : liveMatch;
  }

  function getStoredAiTextMatch(item) {
    return getStoredTextRangeMatch(item);
  }

  function getStoredTextRangeMatch(item) {
    const rects = Array.isArray(item?.shape?.rects)
      ? item.shape.rects.filter((rect) => Number(rect?.width) > 1 && Number(rect?.height) > 1)
      : [];

    if (!rects.length && item?.shape?.width > 1 && item?.shape?.height > 1) {
      rects.push({
        x: item.shape.x - item.shape.width / 2,
        y: item.shape.y - item.shape.height / 2,
        width: item.shape.width,
        height: item.shape.height
      });
    }

    if (!rects.length) {
      return null;
    }

    return {
      rect: getUnionRect(rects),
      rects
    };
  }

  function isTextRangeShape(shape) {
    return shape?.type === "aiText" || shape?.type === "text";
  }

  function getRectDistance(left, right) {
    if (!left || !right) {
      return 0;
    }

    const leftX = Number(left.x || 0) + Number(left.width || 0) / 2;
    const leftY = Number(left.y || 0) + Number(left.height || 0) / 2;
    const rightX = Number(right.x || 0) + Number(right.width || 0) / 2;
    const rightY = Number(right.y || 0) + Number(right.height || 0) / 2;
    return Math.hypot(leftX - rightX, leftY - rightY);
  }

  function isLikelyPeripheralPageRect(rect) {
    if (window.innerWidth < 960) {
      return false;
    }

    const centerX = Number(rect.x || 0) + Number(rect.width || 0) / 2 - window.scrollX;
    return centerX < window.innerWidth * 0.18 || centerX > window.innerWidth * 0.78;
  }

  function renderAll() {
    if (!overlay || !session) {
      return;
    }

    resizeCanvas();
    applyDockPosition();
    renderCanvas();
    renderMarkers();
    positionComposer();
    updateLauncherCount();
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    if (overlay.canvas.width !== Math.round(width * dpr) || overlay.canvas.height !== Math.round(height * dpr)) {
      overlay.canvas.width = Math.round(width * dpr);
      overlay.canvas.height = Math.round(height * dpr);
      overlay.canvas.style.width = `${width}px`;
      overlay.canvas.style.height = `${height}px`;
      floatingObstacleCache.at = 0;
    }
    overlay.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function renderCanvas() {
    const ctx = overlay.ctx;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    const highlightedItem = [...session.pageItems, ...session.aiFindings].find((item) => item.id === highlightedItemId || item.id === pinnedPopoverId);
    if (highlightedItem?.shape && !isTextRangeShape(highlightedItem.shape)) {
      drawShape(ctx, pageShapeToViewport(highlightedItem.shape), {
        color: highlightedItem.source === "ai" ? AI_MARK_COLOR : MARK_COLOR,
        draft: false,
        offsetX: 0,
        offsetY: 0
      });
    }

    if (session.draft) {
      drawShape(ctx, pageShapeToViewport(session.draft), {
        color: DRAFT_COLOR,
        draft: true,
        offsetX: 0,
        offsetY: 0
      });
    }

    if (session.dragPreview) {
      drawShape(ctx, pageShapeToViewport(session.dragPreview), {
        color: DRAFT_COLOR,
        draft: true,
        offsetX: 0,
        offsetY: 0
      });
    }
  }

  function renderMarkers() {
    overlay.markers.innerHTML = "";

    session.pageItems.forEach((item, index) => {
      if (shouldRenderManualTextMarker(item)) {
        renderTextRangeMarker(item, index + 1, "manual");
      } else {
        renderMarkerButton(item, index + 1, "manual");
      }
    });

    session.aiFindings.forEach((item, index) => {
      if (AiCore.shouldRenderPageMarker(item)) {
        renderTextRangeMarker(item, index + 1, "ai");
      }
    });
  }

  function shouldRenderManualTextMarker(item) {
    return item?.shape?.type === "text" || Boolean(item?.selectedText);
  }

  function renderTextRangeMarker(item, number, kind = "ai") {
    const isTextShape = item.shape?.type === "aiText" || item.shape?.type === "text";
    if (!isTextShape && !(kind === "manual" && item.selectedText)) {
      renderMarkerButton(item, number, kind);
      return;
    }

    const textMatch = kind === "ai" ? getAiTextRenderMatch(item) : getManualTextRenderMatch(item);
    if (!textMatch?.rects?.length) {
      return;
    }

    const rects = textMatch.rects
      .map(pageRectToViewport)
      .filter((rect) => isViewportShapeNear({ type: "region", ...rect }));

    if (!rects.length) {
      return;
    }

    rects.forEach((rect, index) => {
      const marker = document.createElement("button");
      marker.className = kind === "ai" ? "ai-text-marker" : "ai-text-marker manual-text-marker";
      marker.type = "button";
      marker.style.left = `${rect.x}px`;
      marker.style.top = `${rect.y}px`;
      marker.style.width = `${Math.max(18, rect.width)}px`;
      marker.style.height = `${Math.max(14, rect.height + 2)}px`;
      marker.setAttribute("aria-label", `${kind === "ai" ? "AI 标记" : "文本反馈"} ${number}`);
      if (index === 0) {
        const badge = document.createElement("span");
        badge.className = "ai-text-marker-badge";
        badge.textContent = String(number);
        marker.appendChild(badge);
      }
      marker.addEventListener("mouseenter", () => {
        window.clearTimeout(popoverHideTimer);
        highlightedItemId = item.id;
        const nextPoint = {
          x: rect.x,
          y: rect.y + rect.height
        };
        if (kind === "ai") {
          showAiPopover(item, number, nextPoint);
        } else {
          showPopover(item, number, nextPoint);
        }
      });
      marker.addEventListener("mouseleave", () => {
        if (!pinnedPopoverId) {
          highlightedItemId = "";
        }
        if (!pinnedPopoverId && !overlay.popover.matches(":hover")) {
          schedulePopoverHide();
        }
      });
      marker.addEventListener("click", (event) => {
        event.stopPropagation();
        window.clearTimeout(popoverHideTimer);
        pinnedPopoverId = pinnedPopoverId === item.id ? "" : item.id;
        if (pinnedPopoverId) {
          highlightedItemId = item.id;
          const nextPoint = {
            x: rect.x,
            y: rect.y + rect.height
          };
          if (kind === "ai") {
            showAiPopover(item, number, nextPoint);
          } else {
            showPopover(item, number, nextPoint);
          }
        } else {
          highlightedItemId = "";
          hidePopover();
        }
      });
      overlay.markers.appendChild(marker);
    });
  }

  function renderMarkerButton(item, number, kind) {
      if (!item.shape) {
        return;
      }

      const point = getMarkerViewportPoint(item.shape);
      if (!isNearViewport(point)) {
        return;
      }

      const marker = document.createElement("button");
      marker.className = kind === "ai" ? "marker marker-ai" : "marker";
      marker.type = "button";
      marker.textContent = String(number);
      marker.style.left = `${point.x}px`;
      marker.style.top = `${point.y}px`;
      marker.addEventListener("mouseenter", () => {
        window.clearTimeout(popoverHideTimer);
        highlightedItemId = item.id;
        renderCanvas();
        if (kind === "ai") {
          showAiPopover(item, number, point);
        } else {
          showPopover(item, number, point);
        }
      });
      marker.addEventListener("mouseleave", () => {
        if (!pinnedPopoverId) {
          highlightedItemId = "";
          renderCanvas();
        }
        if (!pinnedPopoverId && !overlay.popover.matches(":hover")) {
          schedulePopoverHide();
        }
      });
      marker.addEventListener("click", (event) => {
        event.stopPropagation();
        window.clearTimeout(popoverHideTimer);
        pinnedPopoverId = pinnedPopoverId === item.id ? "" : item.id;
        if (pinnedPopoverId) {
          highlightedItemId = item.id;
          renderCanvas();
          if (kind === "ai") {
            showAiPopover(item, number, point);
          } else {
            showPopover(item, number, point);
          }
        } else {
          highlightedItemId = "";
          renderCanvas();
          hidePopover();
        }
      });
      overlay.markers.appendChild(marker);
  }

  function drawShape(ctx, shape, options) {
    if (!shape || !isViewportShapeNear(shape)) {
      return;
    }

    const x = (shape.x || 0) + options.offsetX;
    const y = (shape.y || 0) + options.offsetY;
    const lineWidth = Math.max(3, Math.round(Math.min(window.innerWidth, window.innerHeight) / 220));

    ctx.save();
    ctx.strokeStyle = options.color;
    ctx.fillStyle = options.color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (shape.type === "region") {
      drawRegionMark(ctx, x, y, shape.width, shape.height, options.color, options.draft);
      if (options.number) {
        drawNumberBadge(ctx, options.number, x, y, options.color);
      }
    } else {
      drawPointMark(ctx, x, y, options.color, options.draft);
      if (options.number) {
        drawNumberBadge(ctx, options.number, x + 20, y - 30, options.color);
      }
    }

    ctx.restore();
  }

  function drawRegionMark(ctx, x, y, width, height, color, isDraft) {
    const handle = 12;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = getShapeFillColor(color);
    ctx.fillRect(x, y, width, height);

    if (isDraft) {
      ctx.setLineDash([7, 7]);
      ctx.lineWidth = 2;
    }

    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);
    ctx.lineWidth = 3;

    const corners = [
      [x, y, 1, 1],
      [x + width, y, -1, 1],
      [x, y + height, 1, -1],
      [x + width, y + height, -1, -1]
    ];
    corners.forEach(([cx, cy, sx, sy]) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * handle);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + sx * handle, cy);
      ctx.stroke();
    });

    ctx.restore();
  }

  function drawPointMark(ctx, x, y, color, isDraft) {
    ctx.save();
    const halo = getShapeHaloColor(color);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, isDraft ? 18 : 24, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + 16);
    ctx.bezierCurveTo(x - 11, y + 3, x - 13, y - 4, x - 13, y - 10);
    ctx.bezierCurveTo(x - 13, y - 18, x - 7, y - 24, x, y - 24);
    ctx.bezierCurveTo(x + 7, y - 24, x + 13, y - 18, x + 13, y - 10);
    ctx.bezierCurveTo(x + 13, y - 4, x + 11, y + 3, x, y + 16);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y - 10, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 12, y + 20);
    ctx.lineTo(x + 12, y + 20);
    ctx.stroke();
    ctx.restore();
  }

  function drawNumberBadge(ctx, number, x, y, color) {
    const radius = 15;
    const badgeX = Math.max(radius + 4, x);
    const badgeY = Math.max(radius + 4, y);
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(badgeX, badgeY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 16px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(number), badgeX, badgeY + 1);
    ctx.restore();
  }

  function showPopover(item, number, point) {
    window.clearTimeout(popoverHideTimer);
    overlay.popover.innerHTML = `
      <strong>${number}. ${escapeHtml(item.category || "其他")}</strong>
      <span>${escapeHtml(formatTime(item.createdAt))}</span>
      <p>${escapeHtml(item.issue || "")}</p>
      ${item.selectedText ? `<em>引用：${escapeHtml(limitText(item.selectedText, 80))}</em>` : ""}
      <button class="popover-delete" type="button" data-delete-id="${escapeHtml(item.id)}">删除这条反馈</button>
    `;
    overlay.popover.style.left = `${clamp(point.x + 16, 12, window.innerWidth - 330)}px`;
    overlay.popover.style.top = `${clamp(point.y + 16, 70, window.innerHeight - 220)}px`;
    overlay.popover.classList.add("is-visible");
  }

  function getShapeFillColor(color) {
    if (color === DRAFT_COLOR) {
      return "rgba(23, 105, 224, 0.08)";
    }
    if (color === AI_MARK_COLOR) {
      return "rgba(245, 158, 11, 0.08)";
    }
    return "rgba(240, 68, 56, 0.06)";
  }

  function getShapeHaloColor(color) {
    if (color === DRAFT_COLOR) {
      return "rgba(23, 105, 224, 0.14)";
    }
    if (color === AI_MARK_COLOR) {
      return "rgba(245, 158, 11, 0.16)";
    }
    return "rgba(240, 68, 56, 0.14)";
  }

  function showAiPopover(item, number, point) {
    window.clearTimeout(popoverHideTimer);
    const statusText = item.status === "confirmed" ? "已确认" : "待确认";
    overlay.popover.innerHTML = `
      <strong>AI ${number}. ${escapeHtml(item.errorType || item.category || "疑似问题")}</strong>
      <span>${escapeHtml(statusText)} · ${escapeHtml(item.category || "其他")} · ${escapeHtml(formatTime(item.createdAt))}</span>
      <p>${escapeHtml(item.reason || item.issue || "AI 检查发现疑似问题。")}</p>
      ${item.locationNote ? `<em>${escapeHtml(item.locationNote)}</em>` : ""}
      ${item.originalText ? `<em>原文：${escapeHtml(limitText(item.originalText, 90))}</em>` : ""}
      ${item.suggestedText ? `<em>建议：${escapeHtml(limitText(item.suggestedText, 90))}</em>` : ""}
      <div class="popover-actions">
        <button class="popover-confirm" type="button" data-confirm-ai-id="${escapeHtml(item.id)}">加入反馈</button>
        <button class="popover-delete" type="button" data-delete-ai-id="${escapeHtml(item.id)}">非问题</button>
      </div>
    `;
    overlay.popover.style.left = `${clamp(point.x + 16, 12, window.innerWidth - 330)}px`;
    overlay.popover.style.top = `${clamp(point.y + 16, 70, window.innerHeight - 250)}px`;
    overlay.popover.classList.add("is-visible");
  }

  function onPopoverClick(event) {
    window.clearTimeout(popoverHideTimer);

    const actionButton = event.target.closest("[data-confirm-ai-id], [data-delete-ai-id], [data-delete-id]");
    if (actionButton) {
      event.preventDefault();
      event.stopPropagation();
      pinnedPopoverId = actionButton.dataset.confirmAiId || actionButton.dataset.deleteAiId || actionButton.dataset.deleteId || pinnedPopoverId;
    }

    const confirmAiButton = event.target.closest("[data-confirm-ai-id]");
    if (confirmAiButton) {
      updateAiFindingStatus(confirmAiButton.dataset.confirmAiId, "confirmed");
      return;
    }

    const deleteAiButton = event.target.closest("[data-delete-ai-id]");
    if (deleteAiButton) {
      deleteAiFinding(deleteAiButton.dataset.deleteAiId);
      return;
    }

    const deleteButton = event.target.closest("[data-delete-id]");
    if (!deleteButton) {
      return;
    }

    deleteItem(deleteButton.dataset.deleteId);
  }

  function schedulePopoverHide(delay = 280) {
    window.clearTimeout(popoverHideTimer);
    popoverHideTimer = window.setTimeout(() => {
      if (!overlay) {
        return;
      }
      if (!pinnedPopoverId && !overlay?.popover.matches(":hover")) {
        highlightedItemId = "";
        renderCanvas();
        hidePopover();
      }
    }, delay);
  }

  function hidePopover() {
    window.clearTimeout(popoverHideTimer);
    overlay.popover.classList.remove("is-visible", "is-hovered");
  }

  function onHintClick(event) {
    if (event.target.closest("[data-copy-debug-log]")) {
      copyLastWarningLog();
      return;
    }

    if (!event.target.closest("[data-close-hint]")) {
      return;
    }

    window.clearTimeout(hintTimer);
    stopAiProgressAnimation();
    overlay.hint.classList.remove("is-visible", "is-error", "has-progress");
    overlay.hint.textContent = "";
  }

  function isTypingTarget(target) {
    const tagName = target?.tagName?.toLowerCase();
    return tagName === "input" || tagName === "textarea" || tagName === "select" || target?.isContentEditable;
  }

  function updateSelectionBox() {
    if (!overlay) {
      return;
    }

    const selectedText = session?.draft?.selectedText || "";
    overlay.selectionBox.innerHTML = selectedText
      ? `<span>引用文本</span><p>${escapeHtml(limitText(selectedText, 140))}</p>`
      : "";
  }

  function updateLauncherCount() {
    const count = session.pageItems.length + session.aiFindings.length;
    overlay.countBadge.textContent = String(count);
    overlay.countBadge.classList.toggle("is-empty", count === 0);
  }

  function applyDockPosition() {
    if (!overlay || dockState.drag) {
      return;
    }

    const entryWidth = getDockEntryWidth();
    dockState = {
      ...dockState,
      ...normalizeDockPosition(dockState)
    };

    const left = dockState.side === "left"
      ? DOCK_MARGIN
      : window.innerWidth - entryWidth - DOCK_MARGIN;
    const visualTop = getAvoidedDockTop(dockState.side, dockState.top);

    overlay.root.dataset.dockSide = dockState.side;
    overlay.quickEntry.style.width = `${entryWidth}px`;
    overlay.quickEntry.style.left = `${left}px`;
    overlay.quickEntry.style.top = `${visualTop}px`;
  }

  function normalizeDockPosition(value) {
    const side = value?.side === "left" ? "left" : "right";
    const topFallback = window.innerHeight - DOCK_SIZE - DOCK_MARGIN;
    const topValue = Number.isFinite(value?.top) ? value.top : topFallback;
    return {
      side,
      top: clamp(topValue, DOCK_MARGIN, Math.max(DOCK_MARGIN, window.innerHeight - DOCK_SIZE - DOCK_MARGIN))
    };
  }

  function getDockEntryWidth() {
    return Math.min(DOCK_WIDTH, Math.max(DOCK_SIZE, window.innerWidth - DOCK_MARGIN * 2));
  }

  function getAvoidedDockTop(side, preferredTop) {
    const maxTop = Math.max(DOCK_MARGIN, window.innerHeight - DOCK_SIZE - DOCK_MARGIN);
    const menuOpen = overlay?.root.dataset.menu === "open";
    const menuSafeTop = DOCK_MENU_HEIGHT + DOCK_AVOID_GAP + DOCK_MARGIN;
    const minTop = menuOpen ? Math.min(menuSafeTop, maxTop) : DOCK_MARGIN;
    const baseTop = clamp(preferredTop, minTop, maxTop);
    const launcherLeft = side === "left"
      ? DOCK_MARGIN
      : window.innerWidth - DOCK_MARGIN - DOCK_SIZE;
    const launcherRight = launcherLeft + DOCK_SIZE;
    const obstacles = getFloatingObstacles().filter((rect) =>
      rect.width <= window.innerWidth * 0.66 &&
      rect.height <= window.innerHeight * 0.9 &&
      rect.right > launcherLeft - DOCK_AVOID_GAP &&
      rect.left < launcherRight + DOCK_AVOID_GAP
    );

    if (!obstacles.length || !hasDockCollision(baseTop, obstacles)) {
      return baseTop;
    }

    const candidates = [baseTop];
    obstacles.forEach((rect) => {
      candidates.push(rect.top - DOCK_SIZE - DOCK_AVOID_GAP);
      candidates.push(rect.bottom + DOCK_AVOID_GAP);
    });

    const available = candidates
      .map((top) => clamp(top, minTop, maxTop))
      .filter((top, index, values) => values.indexOf(top) === index)
      .filter((top) => !hasDockCollision(top, obstacles))
      .sort((a, b) => Math.abs(a - baseTop) - Math.abs(b - baseTop));

    if (available.length) {
      return available[0];
    }

    for (let distance = 8; distance <= maxTop - minTop; distance += 8) {
      const down = clamp(baseTop + distance, minTop, maxTop);
      if (!hasDockCollision(down, obstacles)) {
        return down;
      }

      const up = clamp(baseTop - distance, minTop, maxTop);
      if (!hasDockCollision(up, obstacles)) {
        return up;
      }
    }

    return baseTop;
  }

  function hasDockCollision(top, obstacles) {
    const dockTop = top - DOCK_AVOID_GAP;
    const dockBottom = top + DOCK_SIZE + DOCK_AVOID_GAP;
    return obstacles.some((rect) => rect.bottom > dockTop && rect.top < dockBottom);
  }

  function getFloatingObstacles() {
    const now = Date.now();
    if (now - floatingObstacleCache.at < DOCK_OBSTACLE_SCAN_TTL) {
      return floatingObstacleCache.rects;
    }

    const elements = Array.from(document.body?.querySelectorAll("*") || []);
    const rects = [];

    for (const element of elements) {
      if (!(element instanceof HTMLElement) || element === overlay?.host) {
        continue;
      }

      const style = window.getComputedStyle(element);
      if (style.position !== "fixed" && style.position !== "sticky") {
        continue;
      }

      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || style.pointerEvents === "none") {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (
        rect.width < 28 ||
        rect.height < 28 ||
        rect.right <= 0 ||
        rect.bottom <= 0 ||
        rect.left >= window.innerWidth ||
        rect.top >= window.innerHeight
      ) {
        continue;
      }

      rects.push({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      });
    }

    floatingObstacleCache = { at: now, rects };
    return rects;
  }

  function positionComposer() {
    if (!overlay.composer.classList.contains("is-visible") || !session.draft) {
      return;
    }

    const point = getMarkerViewportPoint(session.draft);
    const margin = 12;
    const gap = 18;
    const width = Math.min(252, window.innerWidth - margin * 2);
    const maxHeight = Math.max(180, window.innerHeight - margin * 2);

    overlay.composer.style.width = `${width}px`;
    overlay.composer.style.maxHeight = `${maxHeight}px`;

    const measured = overlay.composer.getBoundingClientRect();
    const height = Math.min(Math.max(measured.height || 240, 180), maxHeight);
    const positions = [
      { name: "bottom-right", left: point.x + gap, top: point.y + gap },
      { name: "top-right", left: point.x + gap, top: point.y - height - gap },
      { name: "top-left", left: point.x - width - gap, top: point.y - height - gap },
      { name: "bottom-left", left: point.x - width - gap, top: point.y + gap }
    ];
    const visiblePositions = positions.filter((position) =>
      position.left >= margin &&
      position.top >= margin &&
      position.left + width <= window.innerWidth - margin &&
      position.top + height <= window.innerHeight - margin
    );
    const best = (visiblePositions[0] || positions[0]);
    const left = clamp(best.left, margin, window.innerWidth - width - margin);
    const top = clamp(best.top, margin, window.innerHeight - height - margin);

    overlay.composer.style.left = `${left}px`;
    overlay.composer.style.top = `${top}px`;
  }

  function closeOverlay() {
    if (aiScanJob) {
      toggleMenu(false);
      resumeAiProgressFromState().catch(() => {
        showAiProgressHint({
          message: "AI 检查进行中，可继续浏览页面。",
          doneChars: 0,
          totalChars: 0,
          found: 0
        });
      });
      return;
    }

    window.removeEventListener("scroll", renderAll, true);
    window.removeEventListener("resize", renderAll);
    window.removeEventListener("keydown", onShortcutKeyDown, true);
    document.removeEventListener("selectionchange", updateSelectionBox);
    stopAiProgressAnimation();
    overlay.host.remove();
    overlay = null;
    session = null;
    pinnedPopoverId = "";
    highlightedItemId = "";
    window.clearTimeout(hintTimer);
    window.clearTimeout(popoverHideTimer);
  }

  function selectionToPointDraft(selection) {
    if (!selection.text || !selection.rect) {
      return null;
    }

    const rects = Array.isArray(selection.rects) && selection.rects.length
      ? selection.rects
      : [{
        x: selection.rect.x + window.scrollX,
        y: selection.rect.y + window.scrollY,
        width: selection.rect.width,
        height: selection.rect.height
      }];

    return {
      type: "text",
      x: selection.rect.x + selection.rect.width / 2 + window.scrollX,
      y: selection.rect.y + selection.rect.height / 2 + window.scrollY,
      width: selection.rect.width,
      height: selection.rect.height,
      rects
    };
  }

  function getSelectionContext() {
    const liveSelection = readSelectionContext();
    if (liveSelection.text && liveSelection.rect) {
      lastSelectionContext = liveSelection;
      return liveSelection;
    }

    return liveSelection.text ? liveSelection : lastSelectionContext;
  }

  function readSelectionContext() {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : "";
    if (!selection || !text || selection.rangeCount === 0) {
      return { text: "", rect: null };
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return { text, rect: null };
    }

    const rects = [...range.getClientRects()]
      .filter((item) => item.width > 1 && item.height > 1)
      .slice(0, 8)
      .map((item) => ({
        x: item.left + window.scrollX,
        y: item.top + window.scrollY,
        width: item.width,
        height: item.height
      }));

    return { text, rect, rects };
  }

  function getPagePoint(event) {
    return {
      x: event.clientX + window.scrollX,
      y: event.clientY + window.scrollY
    };
  }

  function pageShapeToViewport(shape) {
    if (shape.type === "region") {
      return {
        type: "region",
        x: shape.x - window.scrollX,
        y: shape.y - window.scrollY,
        width: shape.width,
        height: shape.height
      };
    }

    return {
      type: "point",
      x: shape.x - window.scrollX,
      y: shape.y - window.scrollY
    };
  }

  function pageRectToViewport(rect) {
    return {
      x: Number(rect?.x || 0) - window.scrollX,
      y: Number(rect?.y || 0) - window.scrollY,
      width: Number(rect?.width || 0),
      height: Number(rect?.height || 0)
    };
  }

  function getMarkerViewportPoint(shape) {
    const viewportShape = pageShapeToViewport(shape);
    if (viewportShape.type === "region") {
      return {
        x: viewportShape.x,
        y: viewportShape.y
      };
    }
    return viewportShape;
  }

  function normalizeRegion(shape) {
    const x = Math.min(shape.x, shape.x + shape.width);
    const y = Math.min(shape.y, shape.y + shape.height);
    return {
      type: "region",
      x,
      y,
      width: Math.abs(shape.width),
      height: Math.abs(shape.height)
    };
  }

  function stripDraftMeta(draft) {
    if (draft.type === "region") {
      return {
        type: "region",
        x: draft.x,
        y: draft.y,
        width: draft.width,
        height: draft.height
      };
    }

    if (draft.type === "text") {
      return {
        type: "text",
        x: draft.x,
        y: draft.y,
        width: draft.width,
        height: draft.height,
        rects: Array.isArray(draft.rects) ? draft.rects : []
      };
    }

    return {
      type: "point",
      x: draft.x,
      y: draft.y
    };
  }

  function isNearViewport(point) {
    return point.x > -80 && point.y > -80 && point.x < window.innerWidth + 80 && point.y < window.innerHeight + 80;
  }

  function isViewportShapeVisible(shape) {
    if (shape.type === "point") {
      return shape.x >= 0 && shape.y >= 0 && shape.x <= window.innerWidth && shape.y <= window.innerHeight;
    }

    return shape.x + shape.width > 0 &&
      shape.y + shape.height > 0 &&
      shape.x < window.innerWidth &&
      shape.y < window.innerHeight;
  }

  function isViewportShapeNear(shape) {
    if (shape.type === "point") {
      return isNearViewport(shape);
    }

    return shape.x + shape.width > -120 &&
      shape.y + shape.height > -120 &&
      shape.x < window.innerWidth + 120 &&
      shape.y < window.innerHeight + 120;
  }

  function buildLocationText(shape, selectedText) {
    if (shape.type === "region") {
      return `框选区域，截图范围为区域外扩 ${REGION_PADDING}px`;
    }

    const prefix = selectedText ? "文本引用附近" : "标记点附近";
    return `${prefix}，截图范围为周边 ${POINT_CAPTURE_WIDTH}×${POINT_CAPTURE_HEIGHT}px`;
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
      return "AI 检查未完成：服务多次没有返回结果，因此没有生成新的标记。可以稍后重试；如果多次失败，请换用 Mock 测试模式或响应更快的模型。";
    }

    return rawMessage;
  }

  function showHint(message, isError = false, duration = 3200, debugExtra = {}) {
    stopAiProgressAnimation();
    if (isError) {
      lastWarningLog = buildWarningDebugLog(message, debugExtra);
      overlay.hint.innerHTML = `
        <span>${escapeHtml(message || "处理失败，请稍后重试。")}</span>
        <button class="hint-copy" type="button" data-copy-debug-log aria-label="复制排查日志">复制日志</button>
        <button class="hint-close" type="button" data-close-hint aria-label="关闭错误提示">关闭</button>
      `;
    } else {
      overlay.hint.textContent = message;
    }
    overlay.hint.classList.toggle("is-error", isError);
    overlay.hint.classList.remove("has-progress");
    overlay.hint.classList.add("is-visible");
    window.clearTimeout(hintTimer);
    if (!isError && duration > 0) {
      hintTimer = window.setTimeout(() => {
        overlay?.hint.classList.remove("is-visible");
      }, duration);
    }
  }

  function createAiScanDebugSnapshot(extra = {}) {
    return {
      capturedAt: new Date().toISOString(),
      extensionVersion: getExtensionVersion(),
      page: getPageContext(),
      viewport: getViewportDebugInfo(),
      ...extra
    };
  }

  function buildWarningDebugLog(message, extra = {}) {
    const log = {
      type: "web-feedback-marker-warning",
      capturedAt: new Date().toISOString(),
      extensionVersion: getExtensionVersion(),
      warningMessage: String(message || ""),
      page: getPageContext(),
      viewport: getViewportDebugInfo(),
      aiScanDebug: lastAiScanDebug || null,
      aiProgress: {
        active: Boolean(aiProgressView.active),
        displayed: Number(aiProgressView.displayed || 0),
        target: Number(aiProgressView.target || 0),
        message: aiProgressView.message || "",
        found: Number(aiProgressView.found || 0),
        startedAt: aiProgressView.startedAt || 0
      },
      extra
    };

    return safeStringify(log);
  }

  async function copyLastWarningLog() {
    const log = lastWarningLog || buildWarningDebugLog("手动复制最近一次警告日志。");
    try {
      await writeTextToClipboard(log);
      showHint("日志已复制，可发给我定位。", false, 2600);
    } catch (_error) {
      showHint("日志复制失败，请重新点击复制日志。", true, 0, { reason: "copy_log_failed" });
    }
  }

  async function writeTextToClipboard(text) {
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
    document.documentElement.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) {
      throw new Error("copy_failed");
    }
  }

  function getExtensionVersion() {
    try {
      return chrome.runtime?.getManifest?.().version || "";
    } catch (_error) {
      return "";
    }
  }

  function getViewportDebugInfo() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1,
      userAgent: navigator.userAgent
    };
  }

  function describeElement(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const id = element.id ? `#${element.id}` : "";
    const className = String(element.className || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .map((name) => `.${name}`)
      .join("");
    return `${element.tagName.toLowerCase()}${id}${className}`;
  }

  function previewScanBlock(block) {
    return {
      id: block?.id || "",
      charCount: String(block?.text || "").length,
      rect: block?.rect || null,
      element: describeElement(block?.element),
      textPreview: limitText(block?.text || "", AI_DEBUG_PREVIEW_LENGTH)
    };
  }

  function previewAiFinding(finding) {
    return {
      blockId: finding?.blockId || "",
      errorType: finding?.errorType || "",
      originalText: limitText(finding?.originalText || "", AI_DEBUG_PREVIEW_LENGTH),
      suggestedText: limitText(finding?.suggestedText || "", AI_DEBUG_PREVIEW_LENGTH),
      reason: limitText(finding?.reason || "", AI_DEBUG_PREVIEW_LENGTH),
      context: limitText(finding?.context || "", AI_DEBUG_PREVIEW_LENGTH),
      severity: finding?.severity || "",
      confidence: finding?.confidence ?? null
    };
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return JSON.stringify({
        type: "web-feedback-marker-warning",
        capturedAt: new Date().toISOString(),
        warningMessage: "日志序列化失败",
        error: String(error?.message || error)
      }, null, 2);
    }
  }

  function showAiProgressHint({ message, doneChars = 0, totalChars = 0, found = 0, startedAt = 0 }) {
    const safeTotal = Math.max(0, Number(totalChars) || 0);
    const safeDone = safeTotal ? clamp(Number(doneChars) || 0, 0, safeTotal) : 0;
    const target = safeTotal ? Math.min(0.96, safeDone / safeTotal) : 0.08;
    const parsedStartedAt = Number(startedAt) || Number(aiProgressView.startedAt) || 0;
    const nextStartedAt = parsedStartedAt > 0 ? parsedStartedAt : Date.now();

    ensureAiProgressHintDom();
    aiProgressView = {
      active: true,
      displayed: Math.min(aiProgressView.displayed || 0, target),
      target: Math.max(target, aiProgressView.target || 0),
      message: message || "AI 检查进行中",
      meta: "",
      found: Number(found || 0),
      startedAt: nextStartedAt
    };
    overlay.hint.classList.remove("is-error");
    overlay.hint.classList.add("is-visible", "has-progress");
    window.clearTimeout(hintTimer);
    renderAiProgressHint();
    startAiProgressAnimation();
  }

  function ensureAiProgressHintDom() {
    if (overlay.hint.querySelector(".hint-progress-bar i")) {
      return;
    }

    overlay.hint.innerHTML = `
      <div class="hint-progress-head">
        <strong>AI 检查进行中</strong>
        <span></span>
      </div>
      <div class="hint-progress-bar" aria-hidden="true"><i></i></div>
      <div class="hint-progress-foot"></div>
    `;
  }

  function renderAiProgressHint() {
    const title = overlay.hint.querySelector(".hint-progress-head strong");
    const meta = overlay.hint.querySelector(".hint-progress-head span");
    const bar = overlay.hint.querySelector(".hint-progress-bar i");
    const foot = overlay.hint.querySelector(".hint-progress-foot");

    if (title) {
      title.textContent = aiProgressView.message || "AI 检查进行中";
    }
    if (meta) {
      const elapsedText = aiProgressView.startedAt ? `已处理 ${formatElapsedDuration(Date.now() - aiProgressView.startedAt)}` : "";
      meta.textContent = elapsedText;
      meta.hidden = !aiProgressView.startedAt;
    }
    if (bar) {
      bar.style.width = `${Math.max(6, Math.min(99, (aiProgressView.displayed || 0) * 100))}%`;
    }
    if (foot) {
      foot.textContent = "";
      foot.hidden = true;
    }
  }

  function startAiProgressAnimation() {
    if (aiProgressFrame) {
      return;
    }

    const tick = () => {
      if (!aiProgressView.active) {
        aiProgressFrame = 0;
        return;
      }

      const target = Math.max(aiProgressView.target || 0, aiProgressView.displayed || 0);
      aiProgressView.displayed += (target - aiProgressView.displayed) * 0.16;
      if (Math.abs(aiProgressView.displayed - target) < 0.002) {
        aiProgressView.displayed = target;
      }
      renderAiProgressHint();
      aiProgressFrame = window.requestAnimationFrame(tick);
    };

    aiProgressFrame = window.requestAnimationFrame(tick);
  }

  function stopAiProgressAnimation() {
    aiProgressView.active = false;
    if (aiProgressFrame) {
      window.cancelAnimationFrame(aiProgressFrame);
      aiProgressFrame = 0;
    }
  }

  async function resumeAiProgressFromState() {
    const result = await getLocalStorage(AI_SCAN_STATE_KEY);
    const state = result[AI_SCAN_STATE_KEY];
    if (state?.status !== "running" || state.pageUrl !== location.href) {
      return;
    }

    showAiProgressHint({
      message: state.message || "AI 检查进行中",
      doneChars: state.progress?.doneChars || 0,
      totalChars: state.progress?.totalChars || state.checkedChars || 0,
      found: state.progress?.found || 0,
      startedAt: state.startedAt
    });
  }

  function formatElapsedDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.floor((Number(durationMs) || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const two = (value) => String(value).padStart(2, "0");

    if (hours > 0) {
      return `${hours}:${two(minutes)}:${two(seconds)}`;
    }

    return `${two(minutes)}:${two(seconds)}`;
  }

  function waitNextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片加载失败。"));
      image.src = src;
    });
  }

  function formatTime(value) {
    if (!value) {
      return "";
    }
    return new Date(value).toLocaleString("zh-CN");
  }

  function formatShortTime(value) {
    if (!value) {
      return "";
    }

    const date = new Date(value);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }

  function formatDateOnly(value) {
    if (!value) {
      return "";
    }

    return new Date(value).toLocaleDateString("zh-CN");
  }

  function createId(prefix = "item") {
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${id}`;
  }

  function truncateText(value, maxLength) {
    const text = String(value || "").trim();
    if (Array.from(text).length <= maxLength) {
      return text;
    }

    return Array.from(text).slice(0, maxLength).join("");
  }

  function sanitizeFileName(value) {
    return String(value || "网页反馈")
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 90) || "网页反馈";
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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

  function getOverlayStyles() {
    return `
      * {
        box-sizing: border-box;
      }

      .shell {
        position: fixed;
        inset: 0;
        color: #101828;
        font: 14px/1.45 "HarmonyOS Sans SC", "HarmonyOS Sans", "鸿蒙黑体", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: none;
      }

      .shell.is-attention .launcher {
        outline: 4px solid rgba(23, 105, 224, 0.24);
      }

      .annotation-canvas,
      .capture-layer,
      .markers {
        position: fixed;
        inset: 0;
      }

      .annotation-canvas,
      .markers {
        pointer-events: none;
      }

      .capture-layer {
        display: none;
        cursor: crosshair;
        pointer-events: none;
      }

      .shell[data-tool="region"] .capture-layer,
      .shell[data-tool="point"] .capture-layer {
        display: block;
        pointer-events: auto;
      }

      .quick-entry {
        position: fixed;
        display: grid;
        gap: 10px;
        min-height: 52px;
        transition: transform 160ms ease, opacity 160ms ease;
        pointer-events: none;
      }

      .shell[data-dock-side="left"] .quick-entry {
        justify-items: start;
      }

      .shell[data-dock-side="right"] .quick-entry {
        justify-items: end;
      }

      .shell[data-menu="closed"][data-dock-side="left"] .quick-entry:not(:hover) {
        opacity: 0.72;
        transform: translateX(-34px);
      }

      .shell[data-menu="closed"][data-dock-side="right"] .quick-entry:not(:hover) {
        opacity: 0.72;
        transform: translateX(34px);
      }

      .shell[data-menu="open"] .quick-entry,
      .shell[data-dock-dragging="true"] .quick-entry,
      .quick-entry:hover {
        opacity: 1;
        transform: translateX(0);
      }

      .shell[data-tool="region"] .quick-entry,
      .shell[data-tool="point"] .quick-entry {
        opacity: 0.18;
        pointer-events: none;
      }

      .shell[data-tool="region"] .launcher,
      .shell[data-tool="point"] .launcher {
        pointer-events: none;
      }

      .launcher {
        position: relative;
        display: grid;
        place-items: center;
        width: 52px;
        height: 52px;
        min-height: 52px;
        border: 1px solid rgba(16, 24, 40, 0.16);
        border-radius: 999px;
        background: #1769e0;
        color: #fff;
        cursor: pointer;
        font: inherit;
        font-weight: 800;
        padding: 0;
        pointer-events: auto;
        box-shadow: 0 14px 34px rgba(15, 23, 42, 0.24);
        touch-action: none;
      }

      .launcher-icon {
        width: 25px;
        height: 25px;
        fill: none;
        stroke: currentColor;
        stroke-width: 2.25;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .launcher:hover {
        background: #0f55b8;
      }

      .count {
        position: absolute;
        top: -5px;
        right: -5px;
        display: grid;
        min-width: 21px;
        height: 21px;
        align-items: center;
        border: 2px solid #fff;
        border-radius: 999px;
        background: #f04438;
        color: #fff;
        font-size: 12px;
        line-height: 1;
        padding: 0 5px;
      }

      .count.is-empty {
        background: #667085;
      }

      .dock {
        position: absolute;
        bottom: 62px;
        display: none;
        width: 238px;
        gap: 7px;
        padding: 8px;
        border: 1px solid rgba(16, 24, 40, 0.12);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.97);
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.22);
        pointer-events: auto;
      }

      .shell[data-dock-side="left"] .dock {
        left: 0;
      }

      .shell[data-dock-side="right"] .dock {
        right: 0;
      }

      .shell[data-menu="open"] .dock {
        display: grid;
      }

      .dock-action {
        display: grid;
        gap: 2px;
        min-height: 48px;
        border: 1px solid transparent;
        border-radius: 8px;
        background: #fff;
        color: #101828;
        cursor: pointer;
        font: inherit;
        padding: 8px 10px;
        text-align: left;
      }

      .dock-action:hover {
        border-color: #bfd6ff;
        background: #f3f8ff;
      }

      .dock-action strong {
        font-size: 14px;
      }

      .dock-action span {
        color: #667085;
        font-size: 12px;
      }

      .dock-action.subtle {
        background: #f9fafb;
      }

      .ai-dock-action {
        border-color: #f6d98d;
        background: #fffbeb;
      }

      .ai-dock-action:hover {
        border-color: #f6c76d;
        background: #fff4cf;
      }

      button,
      select,
      textarea {
        font: inherit;
      }

      .composer {
        position: fixed;
        display: none;
        width: 252px;
        max-height: calc(100vh - 24px);
        overflow: auto;
        gap: 9px;
        padding: 10px;
        border: 1px solid rgba(16, 24, 40, 0.12);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.24);
        pointer-events: auto;
      }

      .composer.is-visible {
        display: grid;
      }

      .composer-top,
      .composer footer {
        display: flex;
        justify-content: flex-end;
        align-items: center;
      }

      .composer footer {
        justify-content: flex-start;
      }

      .icon-button {
        width: 26px;
        height: 26px;
        min-height: 26px;
        border: 1px solid #d0d5dd;
        border-radius: 999px;
        background: #fff;
        color: #475467;
        cursor: pointer;
        padding: 0;
      }

      select,
      textarea {
        width: 100%;
        border: 1px solid #d0d5dd;
        border-radius: 7px;
        background: #fff;
        color: #101828;
        outline: none;
      }

      .field-shell {
        position: relative;
      }

      .field-select::before {
        position: absolute;
        top: 50%;
        left: 10px;
        z-index: 1;
        color: #667085;
        content: attr(data-label);
        font-size: 12px;
        font-weight: 700;
        pointer-events: none;
        transform: translateY(-50%);
      }

      textarea {
        min-height: 96px;
        padding: 10px;
        resize: none;
      }

      select {
        min-height: 36px;
        padding: 0 8px 0 48px;
      }

      select:focus,
      textarea:focus {
        border-color: #4c8fe8;
        box-shadow: 0 0 0 2px rgba(23, 105, 224, 0.1);
      }

      .primary {
        min-height: 36px;
        border: 1px solid #1769e0;
        border-radius: 7px;
        background: #1769e0;
        color: #fff;
        cursor: pointer;
        font-weight: 700;
        padding: 0 14px;
      }

      .selection-box {
        border: 1px dashed #d0d5dd;
        border-radius: 8px;
        padding: 9px;
        color: #667085;
      }

      .selection-box:empty {
        display: none;
      }

      .selection-box span {
        display: block;
        margin-bottom: 4px;
        color: #344054;
        font-weight: 700;
      }

      .selection-box p {
        max-height: 86px;
        overflow: auto;
        margin: 0;
      }

      .marker {
        position: fixed;
        width: 30px;
        height: 30px;
        min-height: 30px;
        margin: -15px 0 0 -15px;
        border: 2px solid #fff;
        border-radius: 999px;
        background: #f04438;
        color: #fff;
        font-weight: 800;
        line-height: 1;
        padding: 0;
        pointer-events: auto;
        box-shadow: 0 8px 20px rgba(16, 24, 40, 0.28);
      }

      .marker:hover {
        transform: scale(1.06);
      }

      .marker-ai {
        background: #f59e0b;
        color: #101828;
        box-shadow: 0 8px 20px rgba(180, 83, 9, 0.24);
      }

      .ai-text-marker {
        position: fixed;
        border: 0;
        border-radius: 2px;
        background:
          linear-gradient(to top, rgba(245, 158, 11, 0.13) 0 34%, transparent 34%),
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='8' viewBox='0 0 96 8'%3E%3Cpath d='M1 5.1 C 10 2.4, 17 7.1, 27 4.4 S 45 3.5, 55 4.9 S 76 6.3, 95 3.8' fill='none' stroke='%23d99000' stroke-width='2.6' stroke-linecap='round'/%3E%3C/svg%3E");
        background-position: 0 0, left calc(100% - 2px);
        background-repeat: no-repeat, repeat-x;
        background-size: 100% 100%, 96px 8px;
        color: #101828;
        cursor: pointer;
        padding: 0;
        pointer-events: auto;
      }

      .ai-text-marker:hover,
      .ai-text-marker:focus-visible {
        background:
          linear-gradient(to top, rgba(245, 158, 11, 0.2) 0 42%, transparent 42%),
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='8' viewBox='0 0 96 8'%3E%3Cpath d='M1 5.2 C 11 1.8, 18 7.3, 29 4.1 S 48 3.2, 58 5.2 S 77 6.4, 95 3.5' fill='none' stroke='%23f2a900' stroke-width='3.2' stroke-linecap='round'/%3E%3C/svg%3E");
        background-position: 0 0, left calc(100% - 2px);
        background-repeat: no-repeat, repeat-x;
        background-size: 100% 100%, 96px 8px;
        outline: none;
      }

      .manual-text-marker {
        background:
          linear-gradient(to top, rgba(240, 68, 56, 0.12) 0 34%, transparent 34%),
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='8' viewBox='0 0 96 8'%3E%3Cpath d='M1 5.1 C 10 2.4, 17 7.1, 27 4.4 S 45 3.5, 55 4.9 S 76 6.3, 95 3.8' fill='none' stroke='%23e5483f' stroke-width='2.6' stroke-linecap='round'/%3E%3C/svg%3E");
        background-position: 0 0, left calc(100% - 2px);
        background-repeat: no-repeat, repeat-x;
        background-size: 100% 100%, 96px 8px;
      }

      .manual-text-marker:hover,
      .manual-text-marker:focus-visible {
        background:
          linear-gradient(to top, rgba(240, 68, 56, 0.18) 0 42%, transparent 42%),
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='8' viewBox='0 0 96 8'%3E%3Cpath d='M1 5.2 C 11 1.8, 18 7.3, 29 4.1 S 48 3.2, 58 5.2 S 77 6.4, 95 3.5' fill='none' stroke='%23f04438' stroke-width='3.2' stroke-linecap='round'/%3E%3C/svg%3E");
        background-position: 0 0, left calc(100% - 2px);
        background-repeat: no-repeat, repeat-x;
        background-size: 100% 100%, 96px 8px;
      }

      .ai-text-marker-badge {
        position: absolute;
        left: -12px;
        top: calc(100% - 18px);
        display: grid;
        width: 17px;
        height: 17px;
        place-items: center;
        border: 2px solid #fff;
        border-radius: 999px;
        background: #f59e0b;
        box-shadow: 0 6px 16px rgba(180, 83, 9, 0.24);
        color: #101828;
        font-size: 10px;
        font-weight: 850;
        line-height: 1;
      }

      .manual-text-marker .ai-text-marker-badge {
        background: #f04438;
        color: #fff;
        box-shadow: 0 6px 16px rgba(180, 35, 24, 0.22);
      }

      .popover {
        position: fixed;
        display: none;
        width: 310px;
        padding: 12px;
        border: 1px solid rgba(16, 24, 40, 0.12);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.24);
        pointer-events: auto;
      }

      .popover.is-visible {
        display: grid;
        gap: 6px;
      }

      .popover strong {
        color: #101828;
      }

      .popover span,
      .popover em {
        color: #667085;
        font-style: normal;
      }

      .popover p {
        margin: 0;
        color: #344054;
      }

      .popover-delete {
        width: fit-content;
        min-height: 28px;
        border: 0;
        border-radius: 6px;
        background: #fff4f3;
        color: #b42318;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        font-weight: 750;
        padding: 0 9px;
      }

      .popover-delete:hover {
        background: #fee4e2;
      }

      .popover-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .popover-confirm {
        width: fit-content;
        min-height: 28px;
        border: 0;
        border-radius: 6px;
        background: #ecfdf3;
        color: #027a48;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        font-weight: 750;
        padding: 0 9px;
      }

      .popover-confirm:hover {
        background: #d1fadf;
      }

      .hint {
        position: fixed;
        right: 18px;
        bottom: 82px;
        display: none;
        max-width: 320px;
        border-radius: 10px;
        background: rgba(16, 24, 40, 0.86);
        color: #fff;
        padding: 10px 12px;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.25);
        pointer-events: none;
      }

      .hint.is-visible {
        display: block;
      }

      .hint.is-error {
        background: rgba(180, 35, 24, 0.92);
        display: flex;
        align-items: flex-start;
        gap: 10px;
        pointer-events: auto;
      }

      .hint.is-error span {
        flex: 1;
        min-width: 0;
      }

      .hint-close,
      .hint-copy {
        min-height: 26px;
        border: 1px solid rgba(255, 255, 255, 0.28);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        font-weight: 750;
        padding: 0 9px;
        white-space: nowrap;
      }

      .hint-copy {
        background: rgba(255, 255, 255, 0.92);
        color: #9f1d12;
      }

      .hint-close:hover,
      .hint-copy:hover {
        background: rgba(255, 255, 255, 0.22);
      }

      .hint-copy:hover {
        background: #ffffff;
      }

      .hint.has-progress {
        width: 320px;
        background: rgba(17, 24, 39, 0.92);
      }

      .hint-progress-head {
        display: grid;
        align-items: center;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
      }

      .hint-progress-head strong {
        min-width: 0;
        overflow: hidden;
        font-size: 13px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .hint-progress-head span {
        justify-self: end;
        white-space: nowrap;
      }

      .hint-progress-head span,
      .hint-progress-foot {
        color: rgba(255, 255, 255, 0.76);
        font-size: 12px;
      }

      .hint-progress-bar {
        height: 6px;
        overflow: hidden;
        margin-top: 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.18);
      }

      .hint-progress-bar i {
        display: block;
        position: relative;
        overflow: hidden;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #60a5fa, #93c5fd);
        transition: width 220ms ease;
      }

      .hint-progress-bar i::after {
        position: absolute;
        inset: 0;
        content: "";
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent);
        transform: translateX(-100%);
        animation: wfm-progress-shine 1.4s linear infinite;
      }

      @keyframes wfm-progress-shine {
        to {
          transform: translateX(100%);
        }
      }

      .hint-progress-foot {
        margin-top: 6px;
      }

      .shell.is-capturing .quick-entry,
      .shell.is-capturing .composer,
      .shell.is-capturing .hint,
      .shell.is-capturing .markers,
      .shell.is-capturing .annotation-canvas,
      .shell.is-capturing .popover {
        opacity: 0;
      }

      @media (max-width: 760px) {
        .dock {
          width: min(238px, calc(100vw - 20px));
        }

        .composer {
          left: 10px !important;
          right: 10px;
          top: auto !important;
          bottom: 72px;
          width: auto;
          max-height: 44vh;
        }

        .hint {
          left: 10px;
          right: 10px;
          bottom: 72px;
          max-width: none;
        }
      }
    `;
  }
})();
