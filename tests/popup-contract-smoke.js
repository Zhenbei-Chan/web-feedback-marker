const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "popup.html"), "utf8");
const popup = fs.readFileSync(path.join(root, "src", "popup.js"), "utf8");

for (const required of [
  'option value="gemini"',
  'id="aiSettingsOpenBtn"',
  'src="./page-access.js"',
  'src="./ai-provider.js"'
]) {
  if (!html.includes(required)) {
    throw new Error(`Popup is missing required integration: ${required}`);
  }
}

if (!popup.includes('"src/snapshot-core.js"')) {
  throw new Error("Popup injection should load snapshot-core before content.js");
}
if (popup.includes("ensureHttpLikePage")) {
  throw new Error("Popup should use the shared page-access capability model");
}
if (popup.includes("AI_PROVIDER_PRESETS")) {
  throw new Error("Popup should use the shared AI provider module");
}

console.log("popup contract smoke passed");
