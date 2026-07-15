# 需求反查记录

本文档按当前需求基线反查现有实现，用于确认修改过程中是否丢失功能。

## 反查结论

- 未发现核心人工批注能力被删除。
- 未发现快照 HTML / PDF 导出入口被删除。
- 未发现 AI 检查主流程入口被删除。
- 已补齐本地 HTML、Gemini 原生 Provider、AI 重新设置入口和 CDP 连续整页快照。
- 当前仍需要浏览器内手动验证：本地文件权限开关、真实系统通知、真实 Gemini Key、Chrome 可选域名权限弹窗、复杂网页文本定位与真实长页面快照。

## 功能追踪表

| 需求 | 当前实现位置 | 状态 |
| --- | --- | --- |
| 进入批注模式 | `popup.js` 发送 `START_ANNOTATION_MODE`，`content.js` 接收 | 已实现，需浏览器回归 |
| 本地 HTML 批注 | `manifest.json` `file:///*`、`page-access.js`、`popup.js` | 已实现，页面访问冒烟测试通过，需 Chrome 权限开关回归 |
| 标记点反馈 | `content.js` 悬浮菜单、草稿、保存流程 | 已实现，需浏览器回归 |
| 区域反馈 | `content.js` 框选、截图证据、区域 hover | 已实现，需浏览器回归 |
| 文本反馈下划线 | `content.js` `shouldRenderManualTextMarker`、`renderTextRangeMarker` | 已实现，需浏览器回归 |
| 非文本反馈不显示引用 | `content.js` 保存草稿条件，`popup.js` 列表渲染 | 已实现，需浏览器回归 |
| 单条人工反馈删除 | `popup.js` `deleteFeedbackItem`，`content.js` `deleteItem` | 已实现，需浏览器回归 |
| 清空当前页 | `popup.js` `clearCurrentPageItems`，`content.js` `CLEAR_CURRENT_PAGE_FEEDBACK` | 已实现，需浏览器回归 |
| 悬浮入口拖动/吸附/避让 | `content.js` dock state、position、avoidance | 已实现，需浏览器回归 |
| 快捷键 | `content.js` `onShortcutKeyDown` | 已实现，需浏览器回归 |
| 快照 HTML 导出 | `popup.js` `EXPORT_HTML_REPORT`，`content.js` 快照生成 | 已实现，需浏览器回归 |
| 连续整页快照 | `cdp-capture.js` CDP 文档坐标截图，`snapshot-core.js` 连续分片 | 已实现，模块、契约和调试会话测试通过，需真实长页面回归 |
| 截图限流保护 | `background.js` `captureVisibleTabSafely` | 已实现，契约测试通过 |
| PDF 导出 | `popup.js` 调用 `WebFeedbackPdf.exportFeedbackPdf`，`pdf.js` | 已实现，需浏览器回归 |
| AI 设置 | `popup.js` 常驻设置入口和可选域名授权，`ai-provider.js` Provider 设置规则 | 已实现，Provider 测试通过，需浏览器回归 |
| Gemini 原生 Provider | `ai-provider.js` `generateContent`、`x-goog-api-key`、响应提取与旧设置迁移 | 已实现，Provider 测试通过，需真 Key 回归 |
| OpenAI-compatible 自定义服务 | `ai-provider.js` Chat Completions、Bearer 鉴权 | 已实现，Provider 测试通过 |
| Provider Key 隔离 | `ai-provider.js` `resolveApiKey` | 已实现，不跨 Provider 复用 Key，测试通过 |
| Mock AI Provider | `background.js` `requestMockBatchScan` | 已实现，可本地逻辑验证 |
| AI 长文本拆分 | `background.js` `splitOversizedBlocks`、`splitTextIntoChunks` | 已实现，已加冒烟测试 |
| AI 标准化/过滤/去重 | `src/ai-core.js` | 已实现，已加冒烟测试 |
| AI 语义改写过滤 | `src/ai-core.js` `isLikelySemanticRewrite` | 已实现，已加冒烟测试 |
| AI 常见确定性错词修正 | `src/ai-core.js` `applyKnownCorrection` | 已实现，已加冒烟测试 |
| AI 检查任务 | `content.js` `AI_SCAN_PAGE`，`background.js` `AI_SCAN_TEXT` | 已实现，需浏览器回归 |
| Popup 关闭后继续检查 | `content.js` 页面内任务与本地状态 | 已实现，需浏览器回归 |
| AI 文本下划线 | `content.js` `renderTextRangeMarker` | 已实现，需浏览器回归 |
| 无法定位 AI 结果 list-only | `content.js` `toAiFinding`，`ai-core.js` `RENDER_MODE` | 已实现，需浏览器回归 |
| AI 加入反馈 | `content.js` `confirmAiFinding`、`createFeedbackItemFromAiFinding` | 已实现，需浏览器回归 |
| AI 非问题删除 | `content.js` / `popup.js` `deleteAiFinding` | 已实现，需浏览器回归 |
| AI 完成/失败通知 | `background.js` `showExtensionNotification`、权限检测 | 已实现，需系统通知手动验证 |
| 通知失败日志 | `content.js` `lastAiScanDebug`，`popup.js` warning log | 已实现，需浏览器回归 |

## 未覆盖或非目标

- 图片中文字低错识别：当前非目标，因为未接入 OCR。
- 多人实时协作：当前非目标。
- 自动修改网页：当前非目标。
- AI 服务稳定性：依赖用户选择的第三方或内部服务，插件只做重试和错误提示。

## 回归建议

1. 每次改动 AI 逻辑，先运行 `tests/ai-core-smoke.js`、`tests/ai-provider-smoke.js` 和 `tests/background-ai-batching-smoke.js`。
2. 每次改动页面交互，至少执行 `docs/08_TEST_PLAN.md` 中人工批注、AI Mock、删除、清空、导出用例。
3. 每次改动权限或通知，必须在 Chrome 中手动验证系统通知开/关两种场景。
4. 每次改动快照逻辑，运行 `tests/snapshot-core-smoke.js`、`tests/cdp-capture-smoke.js`、`tests/snapshot-export-contract-smoke.js`，并用 `tests/fixtures/snapshot-long.html` 手动导出一次。
