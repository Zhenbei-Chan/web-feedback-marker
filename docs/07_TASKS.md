# 任务拆分

## Task 1：AI 设置与权限

### Goal

让用户可以配置 AI 检查服务，并在需要时请求对应 API 域名权限。

### Relevant files

- `manifest.json`
- `src/popup.html`
- `src/popup.css`
- `src/popup.js`
- `src/ai-settings.js`
- `src/ai-providers.js`

### Non-goals

- 不实现页面扫描。
- 不实现 PDF 导出。
- 不内置任何 API Key。

### Acceptance criteria

- Popup 中出现“AI 检查页面”入口。
- 未配置服务时，点击入口进入本地设置流程。
- 支持保存 Provider、Base URL、Model、API Key。
- API Key 只保存到 `chrome.storage.local`。
- 需要访问外部 API 时，使用可选域名权限，不默认放大权限。

### Verification

- 重新加载插件后设置仍存在。
- 删除设置后 AI 检查不可触发。
- 未授权 API 域名时显示明确提示。

### Context Budget

Required docs:

- `docs/00_PROJECT_STATUS.md`
- `docs/06_TECH_PLAN.md`
- `docs/07_TASKS.md`

Required code files:

- `manifest.json`
- `src/popup.html`
- `src/popup.css`
- `src/popup.js`

Do not read unless needed:

- `src/content.js`
- `src/pdf.js`

## Task 2：页面文本抽取与 AI 调用

### Goal

从当前页面提取可检查文本，分块调用 AI，并得到结构化结果。

### Relevant files

- `src/content.js`
- `src/background.js`
- `src/ai-scanner.js`
- `src/ai-providers.js`

### Non-goals

- 不做自动修复。
- 不上传截图。
- 不扫描隐藏内容、表单输入内容和插件 UI。

### Acceptance criteria

- 能从普通文章页提取可见正文文本。
- 文本分块不会把整页一次性发送给模型。
- AI 响应被解析为统一结构。
- JSON 异常、网络失败、模型返回空结果时都有用户可理解的提示。

### Verification

- 使用 mock provider 返回固定 JSON，验证解析结果。
- 在无网络或 Key 错误时，页面不会残留半成品标记。

### Context Budget

Required docs:

- `docs/00_PROJECT_STATUS.md`
- `docs/06_TECH_PLAN.md`
- `docs/07_TASKS.md`

Required code files:

- `src/content.js`
- `src/background.js`

Do not read unless needed:

- `src/pdf.js`
- `src/popup.css`

## Task 3：AI 待确认标记与状态流转

### Goal

把 AI 检查结果显示为页面内待确认标记，并支持确认问题、非问题删除。

### Relevant files

- `src/content.js`
- `src/popup.js`
- `src/popup.css`
- `src/ai-pending.js`

### Non-goals

- 不改变人工反馈的数据结构。
- 不把 AI 结果默认混入人工反馈列表；只有用户点击加入反馈后才转为人工反馈。

### Acceptance criteria

- AI 结果默认状态为 `pending`。
- 页面内 AI 标记与人工标记视觉可区分。
- 点击“加入反馈/确认问题”后，AI 结果转为正式人工反馈，并从 AI 待确认列表移除。
- 点击“非问题”后删除该 AI 标记和本地记录。
- 刷新页面后仍能恢复未删除的 AI 标记。

### Verification

- 添加多条 AI 结果后刷新页面，未处理的待确认结果保持。
- 删除单条 AI 结果后，页面标记、Popup 数量、导出数据同步更新。

### Context Budget

Required docs:

- `docs/00_PROJECT_STATUS.md`
- `docs/06_TECH_PLAN.md`
- `docs/07_TASKS.md`

Required code files:

- `src/content.js`
- `src/popup.js`
- `src/popup.css`

Do not read unless needed:

- `src/pdf.js`

## Task 4：PDF 导出合并人工反馈与 AI 结果

### Goal

让 PDF 同时展示人工反馈和 AI 检查结果，并保持人工反馈优先。

### Relevant files

- `src/pdf.js`
- `src/popup.js`
- `src/content.js`

### Non-goals

- 不重做 PDF 整体视觉风格。
- 不导出被用户删除的非问题结果。

### Acceptance criteria

- PDF 前半部分展示人工反馈。
- PDF 最后展示 AI 检查结果。
- AI 结果展示状态，至少包含 `待确认`。
- 已加入反馈的 AI 结果按人工反馈展示，不再留在 AI 待确认区。
- 人工反馈和 AI 结果的日期默认不展示具体时分秒。

### Verification

- 仅人工反馈时，PDF 与现有行为一致。
- 仅 AI 结果时，PDF 可导出 AI 区域。
- 人工反馈和 AI 结果同时存在时，排序正确。
- 删除非问题后，PDF 不包含该条。

### Context Budget

Required docs:

- `docs/00_PROJECT_STATUS.md`
- `docs/06_TECH_PLAN.md`
- `docs/07_TASKS.md`

Required code files:

- `src/pdf.js`
- `src/popup.js`
- `src/content.js`

Do not read unless needed:

- `src/popup.css`

## Task 5：回归测试与文档更新

### Goal

验证 AI 检查不会破坏人工批注、HTML 导出、PDF 导出和本地隐私边界。

### Relevant files

- `docs/08_TEST_PLAN.md`
- `docs/09_ACCEPTANCE.md`
- `README.md`
- `CHANGELOG.md`

### Non-goals

- 不发布 GitHub Release。
- 不提交或推送代码，除非用户明确要求。

### Acceptance criteria

- 完成 AI 功能手动回归。
- 文档说明 AI 功能默认关闭、需要用户 API Key、会发送文本到用户选择的服务。
- 记录未自动化验证的风险。

### Verification

- 执行 `docs/08_TEST_PLAN.md` 中的核心用例。
- 插件可在 Chrome 开发者模式重新加载。
