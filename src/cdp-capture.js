(function exposeCdpCapture(global) {
  "use strict";

  const SnapshotCore = global.WebFeedbackSnapshotCore;
  const CDP_PROTOCOL_VERSION = "1.3";
  const MAX_CAPTURE_SLICE_HEIGHT = 12000;
  const MAX_CAPTURE_SLICE_PIXELS = 24000000;
  const MAX_SINGLE_CAPTURE_HEIGHT = 30000;
  const MAX_SINGLE_CAPTURE_PIXELS = 32000000;
  const CAPTURE_FORMAT = "jpeg";
  const CAPTURE_QUALITY = 90;

  async function captureFullPage(tabId, debuggerApi = global.chrome?.debugger) {
    if (!SnapshotCore?.planCdpCaptureSlices) {
      throw new Error("整页截图模块未正确加载，请重新加载插件后再试。");
    }
    if (!Number.isInteger(tabId)) {
      throw new Error("无法识别当前网页标签页，请刷新页面后重试。");
    }
    if (!debuggerApi?.attach || !debuggerApi?.sendCommand || !debuggerApi?.detach) {
      throw new Error("当前 Chrome 不支持整页截图所需的调试协议。");
    }

    const debuggee = { tabId };
    let attached = false;
    try {
      await debuggerApi.attach(debuggee, CDP_PROTOCOL_VERSION);
      attached = true;
      await debuggerApi.sendCommand(debuggee, "Page.enable");

      const metrics = await debuggerApi.sendCommand(debuggee, "Page.getLayoutMetrics");
      const dimensions = getCaptureDimensions(metrics);
      const slices = getPreferredCaptureSlices(dimensions);
      if (!slices.length) {
        throw new Error("网页没有可截取的内容。");
      }

      let segments;
      try {
        segments = await captureSlices(debuggerApi, debuggee, dimensions, slices);
      } catch (error) {
        const canFallbackToSlices = slices.length === 1
          && dimensions.documentHeight > MAX_CAPTURE_SLICE_HEIGHT;
        if (!canFallbackToSlices) {
          throw error;
        }
        const fallbackSlices = SnapshotCore.planCdpCaptureSlices({
          documentHeight: dimensions.documentHeight,
          maxSliceHeight: getSafeSliceHeight(dimensions.viewportWidth)
        });
        segments = await captureSlices(debuggerApi, debuggee, dimensions, fallbackSlices);
      }

      return {
        captureMode: "cdp",
        scrollX: 0,
        viewportWidth: dimensions.viewportWidth,
        viewportHeight: dimensions.viewportHeight,
        documentHeight: dimensions.documentHeight,
        segments
      };
    } catch (error) {
      throw new Error(normalizeCdpCaptureError(error));
    } finally {
      if (attached) {
        try {
          await debuggerApi.detach(debuggee);
        } catch (_error) {
          // Chrome also detaches automatically when the target closes.
        }
      }
    }
  }

  function getPreferredCaptureSlices(dimensions) {
    const pixelCount = dimensions.viewportWidth * dimensions.documentHeight;
    const canCaptureAsSingleImage = dimensions.documentHeight <= MAX_SINGLE_CAPTURE_HEIGHT
      && pixelCount <= MAX_SINGLE_CAPTURE_PIXELS;
    if (canCaptureAsSingleImage) {
      return [{ index: 0, documentTop: 0, height: dimensions.documentHeight }];
    }
    return SnapshotCore.planCdpCaptureSlices({
      documentHeight: dimensions.documentHeight,
      maxSliceHeight: getSafeSliceHeight(dimensions.viewportWidth)
    });
  }

  function getSafeSliceHeight(viewportWidth) {
    const width = Math.max(1, toPositiveInteger(viewportWidth));
    return Math.max(1, Math.min(
      MAX_CAPTURE_SLICE_HEIGHT,
      Math.floor(MAX_CAPTURE_SLICE_PIXELS / width)
    ));
  }

  async function captureSlices(debuggerApi, debuggee, dimensions, slices) {
    const segments = [];
    for (const slice of slices) {
      const capture = await debuggerApi.sendCommand(debuggee, "Page.captureScreenshot", {
        format: CAPTURE_FORMAT,
        quality: CAPTURE_QUALITY,
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: slice.documentTop,
          width: dimensions.viewportWidth,
          height: slice.height,
          scale: 1
        }
      });
      if (!capture?.data) {
        throw new Error(`网页第 ${slice.index + 1} 段截图没有返回图片数据。`);
      }
      segments.push({
        index: slice.index,
        documentTop: slice.documentTop,
        width: dimensions.viewportWidth,
        height: slice.height,
        imageDataUrl: `data:image/${CAPTURE_FORMAT};base64,${capture.data}`
      });
    }
    return segments;
  }

  function getCaptureDimensions(metrics = {}) {
    const contentSize = metrics.cssContentSize || metrics.contentSize || {};
    const layoutViewport = metrics.cssLayoutViewport || metrics.layoutViewport || {};
    const viewportWidth = toPositiveInteger(layoutViewport.clientWidth || contentSize.width);
    const viewportHeight = toPositiveInteger(layoutViewport.clientHeight || 1);
    const documentHeight = Math.max(
      viewportHeight,
      toPositiveInteger(contentSize.height)
    );
    if (!viewportWidth || !documentHeight) {
      throw new Error("Chrome 未返回有效的网页尺寸。");
    }
    return { viewportWidth, viewportHeight, documentHeight };
  }

  function normalizeCdpCaptureError(error) {
    const message = String(error?.message || error || "").trim();
    const lowerMessage = message.toLowerCase();
    if (!message) {
      return "整页截图失败，请刷新页面后重试。";
    }
    if (/正在被.*调试|already attached|another debugger|debugger is already attached|cannot attach|debugger is not attached|detached while handling|canceled_by_user/.test(lowerMessage)) {
      return "无法启动整页截图：当前网页可能正在被开发者工具调试。请关闭该页面的开发者工具后重试。";
    }
    if (/target closed|no tab with id|tab was closed|inspected target navigated or closed/.test(lowerMessage)) {
      return "整页截图已中断：网页标签页已关闭或发生跳转，请回到目标页面后重试。";
    }
    if (/not permitted|permission|cannot access|restricted url/.test(lowerMessage)) {
      return "Chrome 未允许插件读取当前页面。请确认页面不是 chrome:// 等受保护页面，并重新加载插件。";
    }
    if (/unable to capture|capture failed|invalid parameters|image is too large/.test(lowerMessage)) {
      return "Chrome 无法生成整页截图。请等待页面加载完成后重试；如果页面特别长，可先关闭展开式列表或无限滚动内容。";
    }
    if (/^[\u0000-\u007f]+$/.test(message)) {
      return `整页截图失败：${message}`;
    }
    return message;
  }

  function toPositiveInteger(value) {
    return Math.max(0, Math.ceil(Number(value) || 0));
  }

  global.WebFeedbackCdpCapture = Object.freeze({
    captureFullPage,
    getPreferredCaptureSlices,
    getCaptureDimensions,
    normalizeCdpCaptureError
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
