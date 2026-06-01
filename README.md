# 网页反馈标注器

网页反馈标注器是一个本地优先的 Chrome Manifest V3 扩展，用于在网页走查、内容审核、产品验收和视觉检查时直接添加反馈标记，并导出包含图文证据的 PDF 反馈报告。

项目英文名建议使用 **Web Feedback Marker**，GitHub 仓库名建议使用 `web-feedback-marker`。

## Features

- 在当前网页中边浏览边批注。
- 支持文本反馈、区域框选反馈、标记点反馈。
- 页面内保留低打扰编号标记，悬停或点击后查看反馈内容。
- 支持截图证据，区域截图会保留上下文边距。
- 支持导出本地 PDF 反馈报告。
- 所有数据只保存在 `chrome.storage.local`。
- 不接入 AI API、不做云同步、不做账号系统、不采集统计数据。

## Use Cases

- 内容团队检查页面文案、链接、结构和表达问题。
- 产品或运营对线上页面做走查反馈。
- 设计和前端沟通视觉区域调整建议。
- QA 在网页验收时记录可视化问题。
- 团队需要轻量、本地、低权限的网页反馈工具。

## Local Installation

1. 下载或克隆本项目。
2. 打开 Chrome：`chrome://extensions/`。
3. 开启右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本项目根目录。

加载后，点击浏览器工具栏中的扩展图标即可使用。

## How to Use

1. 打开需要走查的网页。
2. 点击扩展图标。
3. 点击“进入批注模式”。
4. 页面右下角会出现铅笔悬浮球。
5. 从悬浮球选择“框选区域 / 添加标记 / 文本反馈”。
6. 填写问题分类和反馈内容后保存。
7. 页面上会保留编号标记。
8. 在扩展弹窗或页面悬浮菜单中导出 PDF。

## Shortcuts

快捷键只在非输入状态下触发，避免影响正常编辑。

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+1` | 框选区域 |
| `Ctrl+Alt+2` | 添加标记 |
| `Ctrl+Alt+3` | 文本反馈 |
| `Ctrl+Alt+E` | 导出当前页 PDF |
| `Esc` | 取消当前动作或关闭菜单 |

## Feedback Categories

- 内容错误
- 表达不清
- 结构问题
- 链接问题
- 视觉建议
- 其他

## PDF Export

导出的 PDF 面向真实协作沟通场景，默认包含：

- 页面标题和 URL。
- 导出时间。
- 当前页反馈数量。
- 每条反馈的序号、分类、时间、反馈内容和位置描述。
- 对应的局部截图证据。

PDF 文件名格式：

```text
网页名称前 20 个字符 - yyyyMMdd - HHmm - 反馈标注.pdf
```

截图会按原始比例缩放展示，避免横图、竖图或长图被拉伸变形。

## Privacy

网页反馈标注器默认本地运行。

- 页面标题、URL、反馈内容、引用文字和截图保存在 `chrome.storage.local`。
- 数据不会上传到服务器。
- 不接入 AI API。
- 不使用云同步。
- 不需要登录账号。
- 不包含第三方分析 SDK。

完整说明见 [PRIVACY.md](PRIVACY.md)。

## Permissions

当前扩展只声明最小必要权限：

| Permission | Purpose |
| --- | --- |
| `activeTab` | 在用户主动使用扩展时读取当前标签页信息 |
| `scripting` | 向当前网页注入批注交互脚本 |
| `storage` | 在浏览器本地保存反馈数据 |

## Project Structure

```text
.
├── assets/icons/              # Extension icons
├── docs/                      # UI spec and open-source notes
├── src/
│   ├── background.js          # MV3 service worker
│   ├── content.js             # Page annotation overlay and interactions
│   ├── pdf.js                 # Local PDF export
│   ├── popup.css              # Popup styles
│   ├── popup.html             # Extension popup
│   └── popup.js               # Popup logic
├── manifest.json              # Chrome Manifest V3 config
├── PRIVACY.md                 # Privacy policy
├── CONTRIBUTING.md            # Contribution guide
├── SECURITY.md                # Security policy
├── CHANGELOG.md               # Release notes
└── LICENSE                    # MIT license
```

## Development Notes

This project does not currently require a build step. After editing files:

1. Open `chrome://extensions/`.
2. Click reload on the extension card.
3. Refresh the test webpage.
4. Verify annotation, storage, clearing, and PDF export behavior.

Recommended manual regression checks:

- Text feedback only shows quoted text when the user selected text.
- Point and region feedback do not show stale quote content.
- Feedback composer stays within the viewport near page edges.
- Clearing current page removes both popup list data and page markers.
- PDF screenshots preserve image ratio.

## Roadmap

- Single feedback deletion.
- More complete regression test coverage.
- Optional import/export of annotation data.
- Better demo assets for GitHub release pages.
- Evaluate lightweight collaboration only if it can remain simple and privacy-aware.

## Contributing

Issues and pull requests are welcome. Before contributing, please read [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

