const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "snapshot-core.js"), "utf8");
const context = { console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);

const SnapshotCore = context.WebFeedbackSnapshotCore;
if (!SnapshotCore) {
  throw new Error("WebFeedbackSnapshotCore was not exposed");
}

const positions = Array.from(SnapshotCore.planScrollPositions({
  documentHeight: 2500,
  viewportHeight: 1000
}));
if (JSON.stringify(positions) !== JSON.stringify([0, 936, 1500])) {
  throw new Error(`Unexpected scroll plan: ${JSON.stringify(positions)}`);
}

const slices = Array.from(SnapshotCore.planCdpCaptureSlices({
  documentHeight: 25000,
  maxSliceHeight: 12000
}));
if (JSON.stringify(slices) !== JSON.stringify([
  { index: 0, documentTop: 0, height: 12000 },
  { index: 1, documentTop: 12000, height: 12000 },
  { index: 2, documentTop: 24000, height: 1000 }
])) {
  throw new Error(`Unexpected CDP slice plan: ${JSON.stringify(slices)}`);
}
for (let index = 1; index < slices.length; index += 1) {
  const previousEnd = slices[index - 1].documentTop + slices[index - 1].height;
  if (slices[index].documentTop !== previousEnd) {
    throw new Error("CDP slices contain a gap or overlap");
  }
}

const marker = SnapshotCore.toPercentPosition({ x: 500, y: 1250 }, {
  viewportWidth: 1000,
  documentHeight: 2500
});
if (marker.left !== 50 || marker.top !== 50) {
  throw new Error(`Responsive marker percentage is wrong: ${JSON.stringify(marker)}`);
}

console.log("snapshot core smoke passed");
