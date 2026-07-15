const fs = require("fs");
const path = require("path");
const vm = require("vm");

const context = { console };
context.globalThis = context;
vm.createContext(context);
for (const fileName of ["snapshot-core.js", "cdp-capture.js"]) {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", fileName), "utf8");
  vm.runInContext(source, context);
}

const CdpCapture = context.WebFeedbackCdpCapture;
if (!CdpCapture) {
  throw new Error("WebFeedbackCdpCapture was not exposed");
}

async function run() {
  const calls = [];
  const debuggerApi = {
    async attach(debuggee, protocolVersion) {
      calls.push({ method: "attach", debuggee, protocolVersion });
    },
    async sendCommand(debuggee, method, params = {}) {
      calls.push({ method, debuggee, params });
      if (method === "Page.getLayoutMetrics") {
        return {
          cssContentSize: { x: 0, y: 0, width: 2200, height: 25000 },
          cssLayoutViewport: { clientWidth: 2000, clientHeight: 800 }
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: `capture-${params.clip.y}-${params.clip.height}` };
      }
      return {};
    },
    async detach(debuggee) {
      calls.push({ method: "detach", debuggee });
    }
  };

  const result = await CdpCapture.captureFullPage(42, debuggerApi);
  const captureCalls = calls.filter((call) => call.method === "Page.captureScreenshot");
  if (captureCalls.length !== 3) {
    throw new Error(`Expected three exact CDP clips, received ${captureCalls.length}`);
  }
  if (JSON.stringify(captureCalls.map((call) => call.params.clip)) !== JSON.stringify([
    { x: 0, y: 0, width: 2000, height: 12000, scale: 1 },
    { x: 0, y: 12000, width: 2000, height: 12000, scale: 1 },
    { x: 0, y: 24000, width: 2000, height: 1000, scale: 1 }
  ])) {
    throw new Error(`Unexpected CDP clips: ${JSON.stringify(captureCalls.map((call) => call.params.clip))}`);
  }
  if (captureCalls.some((call) => call.params.captureBeyondViewport !== true)) {
    throw new Error("Every CDP clip must capture beyond the viewport");
  }
  if (!calls.some((call) => call.method === "detach")) {
    throw new Error("Successful capture must detach the debugger");
  }
  if (result.documentHeight !== 25000 || result.viewportWidth !== 2000 || result.segments.length !== 3) {
    throw new Error(`Unexpected capture result: ${JSON.stringify(result)}`);
  }

  const singleSlices = Array.from(CdpCapture.getPreferredCaptureSlices({
    viewportWidth: 1000,
    documentHeight: 25000
  }));
  if (JSON.stringify(singleSlices) !== JSON.stringify([
    { index: 0, documentTop: 0, height: 25000 }
  ])) {
    throw new Error(`Safe page should prefer one continuous image: ${JSON.stringify(singleSlices)}`);
  }

  const wideSlices = Array.from(CdpCapture.getPreferredCaptureSlices({
    viewportWidth: 5000,
    documentHeight: 10000
  }));
  if (JSON.stringify(wideSlices.map(({ documentTop, height }) => ({ documentTop, height }))) !== JSON.stringify([
    { documentTop: 0, height: 4800 },
    { documentTop: 4800, height: 4800 },
    { documentTop: 9600, height: 400 }
  ])) {
    throw new Error(`Wide page should respect the pixel budget: ${JSON.stringify(wideSlices)}`);
  }

  let detachedAfterFailure = false;
  const failingApi = {
    async attach() {},
    async sendCommand(_debuggee, method) {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssContentSize: { width: 1000, height: 2000 },
          cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 }
        };
      }
      if (method === "Page.captureScreenshot") {
        throw new Error("capture failed");
      }
      return {};
    },
    async detach() {
      detachedAfterFailure = true;
    }
  };
  await CdpCapture.captureFullPage(7, failingApi).then(
    () => { throw new Error("Failed CDP capture should reject"); },
    () => {}
  );
  if (!detachedAfterFailure) {
    throw new Error("Failed capture must still detach the debugger");
  }

  const detachedMessage = CdpCapture.normalizeCdpCaptureError(new Error("Debugger is not attached to the tab"));
  if (!detachedMessage.includes("关闭该页面的开发者工具")) {
    throw new Error(`Detached debugger error should be actionable Chinese: ${detachedMessage}`);
  }

  console.log("cdp capture smoke passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
