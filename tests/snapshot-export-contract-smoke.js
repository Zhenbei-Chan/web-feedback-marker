const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
const background = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");
const cdpCapture = fs.readFileSync(path.join(root, "src", "cdp-capture.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

for (const required of [
  "CAPTURE_FULL_PAGE_CDP",
  "wfm-snapshot-marker-layer"
]) {
  if (!content.includes(required)) {
    throw new Error(`Snapshot export is missing: ${required}`);
  }
}

const captureStart = content.indexOf("async function captureHtmlSnapshot");
const captureEnd = content.indexOf("function installSnapshotCaptureStyle", captureStart);
const captureImplementation = content.slice(captureStart, captureEnd);
if (captureImplementation.includes("CAPTURE_VISIBLE_TAB")) {
  throw new Error("HTML snapshot export must not use scroll-and-stitch captureVisibleTab");
}
if (captureImplementation.includes("createCaptureSlice")) {
  throw new Error("HTML snapshot export must not crop scroll-dependent viewport slices");
}

for (const required of [
  "debuggerApi.attach",
  "Page.getLayoutMetrics",
  "Page.captureScreenshot",
  "captureBeyondViewport",
  "debuggerApi.detach"
]) {
  if (!cdpCapture.includes(required)) {
    throw new Error(`CDP capture implementation is missing: ${required}`);
  }
}
if (!background.includes("CdpCapture.captureFullPage(tabId, chrome.debugger)")) {
  throw new Error("Background must execute CDP capture through chrome.debugger");
}
if (!manifest.permissions.includes("debugger")) {
  throw new Error("Manifest must declare the debugger permission for CDP capture");
}

if (/\.wfm-snapshot-stage\s*\{[^}]*gap\s*:/s.test(content)) {
  throw new Error("Snapshot segments must not be separated by layout gaps");
}
if (!/style="left:\$\{point\.left\}%;top:\$\{point\.top\}%"/.test(content)) {
  throw new Error("Snapshot markers should use responsive percentage coordinates");
}

const interval = Number(background.match(/CAPTURE_MIN_INTERVAL_MS\s*=\s*(\d+)/)?.[1] || 0);
if (interval < 500) {
  throw new Error("captureVisibleTab calls should stay below Chrome's two-calls-per-second limit");
}

console.log("snapshot export contract smoke passed");
