(function exposePageAccess(global) {
  "use strict";

  const PAGE_KIND = Object.freeze({
    WEB: "web",
    LOCAL_FILE: "localFile",
    RESTRICTED: "restricted"
  });

  const LOCAL_FILE_ACCESS_MESSAGE = [
    "当前是本地 HTML 文件，需要先允许插件访问文件网址。",
    "请右键插件图标，选择“管理扩展程序”，开启“允许访问文件网址”，然后刷新此页面再试。"
  ].join("");

  const RESTRICTED_PAGE_MESSAGE = "当前页面受 Chrome 保护，无法注入批注工具。请在普通网页或本地 HTML 文件中使用。";

  function classifyUrl(value) {
    const url = String(value || "").trim();
    if (/^https?:\/\//i.test(url)) {
      return PAGE_KIND.WEB;
    }
    if (/^file:\/\//i.test(url)) {
      return PAGE_KIND.LOCAL_FILE;
    }
    return PAGE_KIND.RESTRICTED;
  }

  function getAccessError({ url, fileAccessAllowed = false } = {}) {
    const kind = classifyUrl(url);
    if (kind === PAGE_KIND.WEB) {
      return "";
    }
    if (kind === PAGE_KIND.LOCAL_FILE) {
      return fileAccessAllowed ? "" : LOCAL_FILE_ACCESS_MESSAGE;
    }
    return RESTRICTED_PAGE_MESSAGE;
  }

  global.WebFeedbackPageAccess = Object.freeze({
    PAGE_KIND,
    LOCAL_FILE_ACCESS_MESSAGE,
    RESTRICTED_PAGE_MESSAGE,
    classifyUrl,
    getAccessError
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
