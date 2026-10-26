# Directory Studio 浏览器扩展迁移方案

日期：2026-10-26。基线：`df60cd3`，油猴版 1.6.0，84 项测试通过。

## 目标和选择

保留「外部程序把 file:// 路径交给 Chrome → 自动在 Studio 打开」的习惯。
增加 Manifest V3 插件、独立工作台和文件访问适配层，继续保留油猴版。
本次只实现本地文件工作台；不增加网络抓取、AI 服务、系统命令或 Native Messaging 安装程序。

比较三种形式：继续注入原页面，无法去掉原生页面依赖；独立工作台可保持界面和内部导航；本地程序权限更大但需额外安装。
选择独立工作台，以 file:// 自动转入为兼容入口，以用户选择的文件句柄为可选写入能力。本版无需授权整个目录；整目录写入授权留给后续需求。

## 行为

- 安装后工具栏打开工作台。首次提供文件网址权限说明，权限由用户在浏览器扩展详情开启。
- 默认接管主框架中的本地目录、已知文本/代码和图片。HTML、PDF、未知二进制保持浏览器行为。
- 使用导航通知尽早切换当前标签页，另设 document_start 回退；不宣称网络层阻断或零帧闪烁。
- 地址栏转为 chrome-extension://…/studio.html；界面显示真实 file:// 路径。
- Studio 内部切目录、文本和 Markdown 链接只更新内容及历史，不重新加载整页。
- 支持自然排序、范围过滤、名称搜索、分页、列表/网格、路径面包屑、收藏、浅/深主题、图片查看器。
- 复用 CodeMirror、Markdown 安全渲染、Mermaid、Markmap；所有依赖随扩展离线打包。
- 文件网址读取与写入分开：外部路径只读打开无需每次选目录；直接写入必须另外取得文件句柄。
- 保存原文件前检查磁盘是否改变；保存失败保留脏状态，下载副本不冒充原文件保存。
- 明确 UTF-8 写入；非 UTF-8、带 NUL 的文本和超限文件不进行不可靠的原位写入。
- 新文件切换、返回/前进和正常关闭页面保护未保存编辑；读取失败保留原编辑器。停用/重载插件、更改文件权限会由浏览器销毁扩展页面，必须先保存，不能承诺此时保留草稿。
- 提供暂停自动接管和原生打开；同一标签页、同一路径暂时绕过接管 10 分钟，刷新仍保留原生，关闭标签页清理绕过记录。
- 不自动修改、删除、重命名文件，不上传正文，不持久化正文；偏好、收藏路径和显式授权句柄仅本地保存。

## 架构和文件

- `extension/manifest.json`：MV3，最少权限 storage/webNavigation、file 主机权限，声明静态脚本和隔离图表页。
- `extension/background.js`：导航、接管开关、原生绕过、工具栏。校验 frame、协议和当前导航，防止旧事件劫持新页面。
- `extension/bridge.js`：在 document_start 转交支持的主页面导航；不无条件隐藏页面，暂停、原生绕过或失败时原生页面可用。
- `extension/model.js`：路径规范化、文件分类、目录数据解析、边界限制与保存冲突。
- `extension/studio.*`：独立界面、历史/脏状态保护、只读文件访问、可选授权保存。
- `extension/build.mjs`：复用 vendor 原件和共享源代码，生成普通静态脚本，不使用 eval/new Function 加载扩展模块。
- 共享编辑器增加显式宿主适配接口，油猴默认路径保留；独立图表页沿用消息校验、SVG 清理、源码限制。
- `test/extension*.test.mjs` 和真实 Chromium 集成检查：导航、文件权限、目录/图片/编辑、图表 CSP、写入失败和竞态。

## 顺序与验证

| 阶段 | 验证要求 | 状态 |
| --- | --- | --- |
| 1. 技术验证、方案审查 | 真实 Chromium 检查 file 读取、目录列举和导航；审查闪烁/权限假设 | 已完成 |
| 2. 路径/接管/文件适配 | 先写路由、解析、安全和保存测试，再实现 | 已完成 |
| 3. 工作台和渲染 | 离线静态打包、原生退路、编辑保护、图表隔离 | 已完成 |
| 4. 审查修复和交付 | 原版回归 + 扩展测试 + 浏览器实测 + 可安装 ZIP、源码和说明 | 已完成：98 项测试、24 个浏览器场景通过 |

## 风险与审查门槛

1. file 导航通知不是可取消的请求拦截，尤其冷启动不保证无闪。内部导航必须保持同一 Document。
2. URL 不等于 FileSystemHandle。目录读取方式先实测，不能假设任意 file URL 都可写。
3. 普通扩展 CSP 禁止动态执行和 srcdoc 内联脚本；图表需使用 manifest sandbox 静态页面，不放宽主工作台权限。
4. 本地 HTML/SVG/文件名均不能作为活动文档执行；文件内容、路径不拼入脚本或未经校验的 HTML。
5. 原版发布资源使用版本目录和 SRI；共享代码变动需新版本目录，保留 1.6.0，不原地覆盖已发布资源。
6. 权限关闭、缺失文件、磁盘修改、保存中继续编辑、服务工作线程重启不得显示虚假成功；扩展页面被浏览器销毁的限制需明确告知。

## 方案审查（实现前）

初审修正：不能把 file 主机权限等同于任意文件写入；不能承诺外部导航无闪；不能把现有 new Function 和图表 srcdoc 原样移进 MV3。
这些问题已由只读入口/授权写入分离、独立内部导航和静态沙箱设计覆盖。

技术验证后定稿：Chromium 的目录响应为 status=0、ok=false，但可读取列举正文。仅解析 addRow 的 JSON 参数，并逐项校验子路径，不执行脚本；保留对目录响应格式变更的原生退路。名字包含 .md 等后缀的目录也根据实际响应识别，不作为文件误打开。

本次本地候选版本统一为 1.6.1；共享代码适配带来的油猴资源生成到新目录，1.6.0 及更早资源不修改。本地验证不代表 GitHub 发布或应用商店上架。

参考：[导航](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)、[标签页](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[文件匹配](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)、[隔离页](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)、[CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)、[文件访问](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)。
