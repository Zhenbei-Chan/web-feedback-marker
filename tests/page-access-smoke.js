const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "page-access.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
const context = { console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);

const PageAccess = context.WebFeedbackPageAccess;
if (!PageAccess) {
  throw new Error("WebFeedbackPageAccess was not exposed");
}

if (PageAccess.classifyUrl("https://example.com/page") !== PageAccess.PAGE_KIND.WEB) {
  throw new Error("HTTPS pages should be supported web pages");
}

if (PageAccess.classifyUrl("file:///C:/Users/test/report.html") !== PageAccess.PAGE_KIND.LOCAL_FILE) {
  throw new Error("file:// HTML should be classified as a local file");
}

if (PageAccess.classifyUrl("chrome://extensions") !== PageAccess.PAGE_KIND.RESTRICTED) {
  throw new Error("Chrome protected pages should stay restricted");
}

const deniedMessage = PageAccess.getAccessError({
  url: "file:///C:/Users/test/report.html",
  fileAccessAllowed: false
});
if (!/允许访问文件网址/.test(deniedMessage) || !/管理扩展程序/.test(deniedMessage)) {
  throw new Error("Local file denial should include actionable Chrome instructions");
}

if (PageAccess.getAccessError({
  url: "file:///C:/Users/test/report.html",
  fileAccessAllowed: true
})) {
  throw new Error("Allowed local files should not produce an access error");
}

if (!manifest.host_permissions?.includes("file:///*")) {
  throw new Error("Manifest should request local file access explicitly");
}

console.log("page access smoke passed");
