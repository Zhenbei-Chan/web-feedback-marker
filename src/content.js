(() => {
  if (window.__WEB_FEEDBACK_ASSISTANT_INSTALLED__) {
    return;
  }

  window.__WEB_FEEDBACK_ASSISTANT_INSTALLED__ = true;

  const STORAGE_KEY = "webFeedbackAssistant.items";
  const CATEGORIES = ["内容错误", "表达不清", "结构问题", "链接问题", "视觉建议", "其他"];
  const MARK_COLOR = "#f04438";
  const DRAFT_COLOR = "#1769e0";
  const POINT_CAPTURE_WIDTH = 640;
  const POINT_CAPTURE_HEIGHT = 360;
  const REGION_PADDING = 72;

  let overlay = null;
  let session = null;
  let pinnedPopoverId = "";
  let highlightedItemId = "";
  let hintTimer = 0;
  let lastSelectionContext = { text: "", rect: null };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_PAGE_CONTEXT") {
      sendResponse(getPageContext());
      return true;
    }

    if (message?.type === "START_ANNOTATION_MODE") {
      startAnnotationMode()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ error: error.message || "无法进入批注模式。" }));
      return true;
    }

    if (message?.type === "FEEDBACK_ITEMS_CHANGED") {
      syncPageItemsFromStorage()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ error: error.message || "无法同步反馈列表。" }));
      return true;
    }

    return false;
  });

  chrome.storage.onChanged.addListener(onStorageChanged);

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
    const items = await loadItems();
    session = {
      id: crypto.randomUUID(),
      page,
      tool: "browse",
      dragStart: null,
      dragPreview: null,
      draft: null,
      pageItems: getCurrentPageItems(items, page.url).reverse(),
      newItems: []
    };

    createOverlay();
    renderAll();
    showHint("批注助手已在右下角待命。");
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
            <button class="dock-action" data-action="export" type="button">
              <strong>导出本次 PDF</strong>
              <span>生成清单，Ctrl+Alt+E</span>
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
    overlay.launcherBtn.addEventListener("click", () => toggleMenu());
    overlay.dockActions.forEach((button) => {
      button.addEventListener("click", () => handleDockAction(button.dataset.action));
    });

    overlay.captureLayer.addEventListener("pointerdown", onPointerDown);
    overlay.captureLayer.addEventListener("pointermove", onPointerMove);
    overlay.captureLayer.addEventListener("pointerup", onPointerUp);
    overlay.saveBtn.addEventListener("click", saveCurrentFeedback);
    overlay.cancelBtn.addEventListener("click", cancelDraft);

    overlay.popover.addEventListener("mouseenter", () => {
      overlay.popover.classList.add("is-hovered");
    });
    overlay.popover.addEventListener("mouseleave", () => {
      overlay.popover.classList.remove("is-hovered");
      if (!pinnedPopoverId) {
        hidePopover();
      }
    });
    overlay.popover.addEventListener("click", onPopoverClick);

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
      showHint("请先在网页中选中文字，再从悬浮球选择文本反馈。", true, 5200);
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
  }

  async function finishAndExport() {
    if (!session.newItems.length) {
      showHint("本次还没有新保存的反馈。", true, 4200);
      return;
    }

    if (!window.WebFeedbackPdf?.exportFeedbackPdf) {
      showHint("PDF 模块未加载，请重新打开插件进入批注模式。", true, 4200);
      return;
    }

    toggleMenu(false);
    await window.WebFeedbackPdf.exportFeedbackPdf({
      title: session.page.title || "网页反馈",
      url: session.page.url,
      items: session.newItems
    });
    showHint("PDF 已生成。");
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
    await chrome.storage.local.set({ [STORAGE_KEY]: [item, ...items] });
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
    await chrome.storage.local.set({ [STORAGE_KEY]: remaining });
    await syncPageItemsFromStorage();
    showHint("已删除 1 条反馈。");
  }

  async function loadItems() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  }

  async function syncPageItemsFromStorage() {
    if (!session) {
      return;
    }

    const items = await loadItems();
    session.pageItems = getCurrentPageItems(items, session.page.url).reverse();
    const currentIds = new Set(session.pageItems.map((item) => item.id));
    session.newItems = session.newItems.filter((item) => currentIds.has(item.id));

    if (pinnedPopoverId && !currentIds.has(pinnedPopoverId)) {
      pinnedPopoverId = "";
      hidePopover();
    }

    if (highlightedItemId && !currentIds.has(highlightedItemId)) {
      highlightedItemId = "";
    }

    renderAll();
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== "local" || !changes[STORAGE_KEY] || !session) {
      return;
    }

    syncPageItemsFromStorage().catch(() => {
      showHint("反馈列表同步失败，请重新进入批注模式。", true, 4200);
    });
  }

  function getCurrentPageItems(items, pageUrl) {
    return items.filter((item) => item.pageUrl === pageUrl);
  }

  function renderAll() {
    if (!overlay || !session) {
      return;
    }

    resizeCanvas();
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
    }
    overlay.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function renderCanvas() {
    const ctx = overlay.ctx;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    const highlightedItem = session.pageItems.find((item) => item.id === highlightedItemId || item.id === pinnedPopoverId);
    if (highlightedItem?.shape) {
      drawShape(ctx, pageShapeToViewport(highlightedItem.shape), {
        color: MARK_COLOR,
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
      if (!item.shape) {
        return;
      }

      const point = getMarkerViewportPoint(item.shape);
      if (!isNearViewport(point)) {
        return;
      }

      const marker = document.createElement("button");
      marker.className = "marker";
      marker.type = "button";
      marker.textContent = String(index + 1);
      marker.style.left = `${point.x}px`;
      marker.style.top = `${point.y}px`;
      marker.addEventListener("mouseenter", () => {
        highlightedItemId = item.id;
        renderCanvas();
        showPopover(item, index + 1, point);
      });
      marker.addEventListener("mouseleave", () => {
        if (!pinnedPopoverId) {
          highlightedItemId = "";
          renderCanvas();
        }
        if (!pinnedPopoverId && !overlay.popover.matches(":hover")) {
          hidePopover();
        }
      });
      marker.addEventListener("click", (event) => {
        event.stopPropagation();
        pinnedPopoverId = pinnedPopoverId === item.id ? "" : item.id;
        if (pinnedPopoverId) {
          highlightedItemId = item.id;
          renderCanvas();
          showPopover(item, index + 1, point);
        } else {
          highlightedItemId = "";
          renderCanvas();
          hidePopover();
        }
      });
      overlay.markers.appendChild(marker);
    });
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
    ctx.fillStyle = color === DRAFT_COLOR ? "rgba(23, 105, 224, 0.08)" : "rgba(240, 68, 56, 0.06)";
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
    const halo = color === DRAFT_COLOR ? "rgba(23, 105, 224, 0.14)" : "rgba(240, 68, 56, 0.14)";
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

  function onPopoverClick(event) {
    const deleteButton = event.target.closest("[data-delete-id]");
    if (!deleteButton) {
      return;
    }

    deleteItem(deleteButton.dataset.deleteId);
  }

  function hidePopover() {
    overlay.popover.classList.remove("is-visible");
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
    overlay.countBadge.textContent = String(session.pageItems.length);
    overlay.countBadge.classList.toggle("is-empty", session.pageItems.length === 0);
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
    window.removeEventListener("scroll", renderAll, true);
    window.removeEventListener("resize", renderAll);
    window.removeEventListener("keydown", onShortcutKeyDown, true);
    document.removeEventListener("selectionchange", updateSelectionBox);
    overlay.host.remove();
    overlay = null;
    session = null;
    pinnedPopoverId = "";
    highlightedItemId = "";
    window.clearTimeout(hintTimer);
  }

  function selectionToPointDraft(selection) {
    if (!selection.text || !selection.rect) {
      return null;
    }

    return {
      type: "point",
      x: selection.rect.x + selection.rect.width / 2 + window.scrollX,
      y: selection.rect.y + selection.rect.height / 2 + window.scrollY
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

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return { text, rect: null };
    }

    return { text, rect };
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

  function showHint(message, isError = false, duration = 3200) {
    overlay.hint.textContent = message;
    overlay.hint.classList.toggle("is-error", isError);
    overlay.hint.classList.add("is-visible");
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => {
      overlay?.hint.classList.remove("is-visible");
    }, duration);
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
        right: 18px;
        bottom: 18px;
        display: grid;
        justify-items: end;
        gap: 10px;
        pointer-events: none;
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
        .quick-entry {
          right: 10px;
          bottom: 10px;
        }

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
