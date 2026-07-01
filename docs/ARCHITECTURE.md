# 代码结构说明

本文档记录当前版本的主要模块分工和后续维护原则。

## 模块分工

- `manifest.json`：Manifest V3 配置、权限、入口和图标。
- `src/background.js`：后台任务，负责截图、AI 服务调用、重试、通知和进度广播。
- `src/content.js`：页面内批注体验，负责悬浮入口、标记渲染、反馈填写、文本抽取、AI 结果定位、快照 HTML 导出。
- `src/popup.html`：插件弹窗结构。
- `src/popup.css`：插件弹窗视觉样式。
- `src/popup.js`：弹窗控制台，负责进入批注模式、AI 设置、触发检查、导出、列表和状态提示。
- `src/pdf.js`：本地 PDF 生成。
- `src/ai-core.js`：AI 结果标准化、过滤、去重、状态和渲染模式规则。
- `tests/fixtures/`：固定测试页面，用于普通正文、跨节点文本、无正文/复杂导航页验证。

## AI 数据流

1. `content.js` 抽取页面正文文本块。
2. `popup.js` 或页面菜单触发 AI 检查。
3. `background.js` 分批请求用户配置的 AI 服务或 Mock provider。
4. `ai-core.js` 统一标准化、过滤和去重 AI 返回结果。
5. `content.js` 尝试把结果映射到页面文字位置。
6. 能定位的结果绘制为页面下划线；不能定位的结果只进入列表。
7. 用户点击 `加入反馈` 后，AI 结果转为正式人工反馈；点击 `非问题` 后删除。
8. 导出时，人工反馈优先，剩余 AI 待确认结果放在最后。

## 维护原则

- AI 规则优先放在 `src/ai-core.js`，避免 background、content、popup 各写一套过滤和去重规则。
- 页面标记渲染只消费标准化后的 finding，不再重复判断业务规则。
- `background.js` 只负责外部调用、重试、通知和进度，不负责页面 DOM 定位。
- `content.js` 可以处理 DOM、坐标和截图，但不应内置 Provider 请求逻辑。
- `popup.js` 是控制台，不应承担沉浸式批注流程。
- 新增 AI Provider 时，先保持 OpenAI-compatible 适配，避免增加复杂鉴权分支。
- 新增状态时，必须同步更新 `docs/01_REQUIREMENTS.md`、`docs/08_TEST_PLAN.md` 和 `docs/09_ACCEPTANCE.md`。

## 当前结构风险

- `src/content.js` 仍然过大，包含页面 UI、截图、HTML 导出、AI 定位和状态提示。后续应按稳定边界拆分。
- `src/background.js` 同时包含 Provider 请求、Mock provider、通知和错误归一化。后续可拆出 AI provider adapter。
- Popup 对 `ai-core.js` 已有最小兜底，避免脚本加载失败导致弹窗崩溃；长期应改成更清晰的依赖加载策略。

## 推荐下一步拆分

1. 从 `content.js` 拆出 `snapshot-export`：只负责快照 HTML 和截图分段。
2. 从 `content.js` 拆出 `text-locator`：只负责文本匹配、矩形计算和下划线定位。
3. 从 `background.js` 拆出 `ai-provider`：只负责请求、重试、错误归一化和 Mock provider。
4. 为 `ai-core.js` 增加无需浏览器环境的单元测试，覆盖过滤、去重、状态流转和 list-only 规则。
