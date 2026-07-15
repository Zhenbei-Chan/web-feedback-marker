(function exposeSnapshotCore(global) {
  "use strict";

  function planScrollPositions({ documentHeight, viewportHeight } = {}) {
    const pageHeight = toPositiveInteger(documentHeight);
    const viewHeight = toPositiveInteger(viewportHeight);
    if (!pageHeight || !viewHeight) {
      return [];
    }
    if (pageHeight <= viewHeight) {
      return [0];
    }

    const maxScrollY = pageHeight - viewHeight;
    const safeOverlap = Math.min(64, Math.max(1, Math.floor(viewHeight * 0.1)));
    const step = Math.max(1, viewHeight - safeOverlap);
    const positions = [];
    for (let scrollY = 0; scrollY < maxScrollY; scrollY += step) {
      positions.push(scrollY);
    }
    positions.push(maxScrollY);
    return [...new Set(positions)].sort((a, b) => a - b);
  }

  function planCdpCaptureSlices({ documentHeight, maxSliceHeight = 12000 } = {}) {
    const pageHeight = toPositiveInteger(documentHeight);
    const sliceHeight = toPositiveInteger(maxSliceHeight);
    if (!pageHeight || !sliceHeight) {
      return [];
    }

    const slices = [];
    for (let documentTop = 0; documentTop < pageHeight; documentTop += sliceHeight) {
      slices.push({
        index: slices.length,
        documentTop,
        height: Math.min(sliceHeight, pageHeight - documentTop)
      });
    }
    return slices;
  }

  function toPercentPosition(point = {}, dimensions = {}) {
    const width = Math.max(1, Number(dimensions.viewportWidth) || 1);
    const height = Math.max(1, Number(dimensions.documentHeight) || 1);
    return {
      left: roundPercent((Number(point.x) || 0) / width * 100),
      top: roundPercent((Number(point.y) || 0) / height * 100)
    };
  }

  function toPercentRect(rect = {}, dimensions = {}) {
    const position = toPercentPosition(rect, dimensions);
    const width = Math.max(1, Number(dimensions.viewportWidth) || 1);
    const height = Math.max(1, Number(dimensions.documentHeight) || 1);
    return {
      ...position,
      width: roundPercent(Math.max(0, Number(rect.width) || 0) / width * 100),
      height: roundPercent(Math.max(0, Number(rect.height) || 0) / height * 100)
    };
  }

  function toPositiveInteger(value) {
    return Math.max(0, Math.round(Number(value) || 0));
  }

  function roundPercent(value) {
    return Math.round(value * 10000) / 10000;
  }

  global.WebFeedbackSnapshotCore = Object.freeze({
    planScrollPositions,
    planCdpCaptureSlices,
    toPercentPosition,
    toPercentRect
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
