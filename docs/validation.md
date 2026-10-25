# V0.3 验证记录

日期：2026-10-20。此记录说明交付验证范围，不代表代理供应商 SLA 或长期运行保证。

## 自动测试

9 项测试组覆盖：

- 真实 Chromium 的 UA、视口、触控、Cookie 隔离、元素交互、确认框、iframe、多标签页。
- 下载内容、上传、截图与产物所有权检查。
- HTTP、SOCKS5 用户名/密码鉴权；普通转发与 HTTPS 所需 CONNECT 隧道。
- 代理失效或鉴权错误时不回退直连。
- stdio MCP 发现、操作状态、断线重连、principal 隔离。
- 密码登录页及真实浏览器表单提交、自动生成的鉴权配置、HTTP MCP 连接。
- BASE_URL 路径前缀、未授权拒绝、来源校验、非法 URL 不导致进程退出。
- 默认并发上限 10、部署覆盖、超限拒绝。
- 密码变化后 Token 轮换；同密码和数据卷重启后 Token 与录像保留。
- 实时 JPEG 帧、WebM 录像、Range 播放、文件头和鉴权。
- 发布脚本固定命名空间、14 位时间标签、双架构参数及秘密不输出。

## Ant Design 控制台验证

- React + Ant Design 构建产物随镜像提供，静态资源支持 gzip，不依赖外部 CDN。
- 真实浏览器检查了密码登录、导航、默认 Token 遮挡、复制完整鉴权 JSON、Markdown 文档、手机导航与页面不横向溢出。
- 浏览器页面验证了 MJPEG 直播实际出图，以及录像抽屉中的 WebM 视频可解码播放。

## 人工浏览器检查

已在 Chrome 中验证：登录、一键复制 Agent 接入说明、实例直播出图、关闭实例后历史录像播放。

默认直播和录像为 2 FPS、640×480 边界、低质量 JPEG 采样、VP9 WebM。录像记录当前活动页面，不同时记录全部标签页。

## 环境与限制

- 本地开发环境：macOS arm64；Docker：Linux arm64。
- GitHub Actions 验证 Linux runner 的自动测试、Docker 构建及容器启动，具体结果以 Actions 为准。
- 未进行生产网站完整业务回归、真实 Webshare 国家库存验证、10 个重页面的长期压力测试或严格网络无旁路证明。
- 非正常终止可留下 interrupted 录像，不保证完整可播；采样受拥塞影响可能丢帧。

## UA Client Hints 兼容层

Playwright 1.64.1 的内置 UA metadata 解析没有填写品牌和版本；Chromium 会回填内核版本。`src/user-agent.js` 是唯一的 UA 解析来源，`scripts/patch-playwright.mjs` 在 npm 安装及服务端构建时将解析函数嵌入 Playwright 的原生页面/iframe/worker 初始化位置，UA / Client Hints 通过原生覆盖设置；Worker 平台属性的兼容处理见下文。

弹窗首个请求的提示可能早于目标初始化生成，因此兼容层也在 Chromium Fetch 请求继续时纠正已经存在的 UA-CH 头。仅替换 UA-CH，不修改其他头；高熵提示不主动添加；修正结果不保存为重定向头覆盖，避免把认证、Cookie 或提示授权沿用到另一来源。

兼容层严格锁定 Playwright 1.64.1，并检查原函数 SHA 和请求处理锚点。升级 Playwright 时必须审查兼容层；不匹配会使安装/构建失败。不要使用 `npm ci --ignore-scripts` 后直接运行旧构建。Docker 构建也执行兼容层，保留现有内核及网络策略。

`test/user-agent.test.ts` 使用真实 Chromium 和本地 HTTP 接收端校验：首个请求、Accept-CH 完整版本、页面早期 JS、普通新 Tab、弹窗、同源/跨站 iframe、Worker、刷新、跨站跳转不携带原站认证/Cookie、多实例隔离、原生 UA、未知 UA、环境核验及历史保存。Worker 脚本请求可以不带 UA-CH；测试不为此强行添加头。


## 完整设备档案与新无头模式（0.14）

- 实例使用 channel=chromium 的完整 Chromium 新版无头模式。配置档通过本地 Playwright 协议中的专用字段传递，不编码进 UA 或 HTTP 头。
- 页面平台、UA metadata、语言和 CPU 通过 Chromium 原生模拟接口设置；Linux Chromium 对 Worker 平台字段的遗漏通过 Worker 执行前的 getter 补齐（不隐藏该脚本模拟性质）；屏幕、视口、缩放和触摸由 context 配置。页面、弹窗、OOPIF、Worker 及首个请求均有真实浏览器回归。
- 兼容层保存原始 dependency bundle 后幂等应用补丁；从旧版开发环境升级时先 npm ci。升级 Playwright 仍需审查版本、源码校验和锚点。
- verify_device_profile 对字段和能力分开计数，记录不支持、CSP限制和超时；webdriver、内存、PDF、蓝牙、语音等期望值不通过假对象覆盖。
- 核验历史通过原有受认证详情接口显示；旧记录无配置档时显示未配置，不能标成新版运行模式。

设备档案还覆盖连续 evaluate / verify_device_profile / reload 的状态保持：辅助 CDP 调试会话在页面/独立 iframe 生命周期内复用，关闭目标时释放，避免 Chromium 在每次 detach 时重置平台覆盖。包含宿主系统不同的 Android 平台回归，防止只在 macOS 上测试 MacIntel 而漏掉回退问题。

## 后台档案目录（0.15）

- 档案 JSON 持久化、系统/名称筛选、启用停用、删除、重复 ID 与身份字段校验、并发修改冲突、磁盘写入失败保留旧值、损坏文件拒绝静默覆盖、空目录重启后不恢复示例。
- 实际 HTTP 后台保存 → MCP 查询和读取 → 按自定义 ID 创建 Chromium → 页面读取 UA / platform / screen / touch；停用或删除后新建被拒绝，已存在实例和历史保持原配置。
- 真实控制台登录、JSON 编辑、格式错误反馈、保存并刷新后恢复配置；管理员登录 / CSRF / Bearer 与只读 MCP 查询沿用原鉴权。

### UA 优先与按系统匹配（0.15.1）

- 真实 Chromium 验证明确选择档案加 UA、仅 UA 自动选择、内联档案加 UA：首个请求、早期脚本、弹窗、iframe、Worker、连续调用和刷新均使用覆盖后的 UA 与新提示，其他设备属性保持档案值，历史保存生效快照，后台模板不被改写。
- 按系统优先选启用的 is_default，未标记时按目录顺序选同系统第一份；验证重复默认项拒绝、停用项排除、旧 JSON 缺省兼容、无匹配时保留 UA 模式且说明结果。
- 不透明 UA 覆盖档案时不残留旧 Chromium 提示；未指定 UA/档案的原生环境保持原样。

## WebRTC 代理旁路回归（0.15.2）

完整 Chromium 与独立 headless shell 使用不同的 WebRTC 策略开关。0.14 切换完整 Chromium 后，旧的 `--force-webrtc-ip-handling-policy` 未设置 Chrome 的 profile preference，导致 STUN UDP 仍可从宿主机直连。改用 `--webrtc-ip-handling-policy=disable_non_proxied_udp`；保留正常 WebRTC API，不伪造候选 IP。

`test/webrtc.test.ts` 使用本地 STUN Binding 服务作为独立网络观察端：先确认旧开关确实发送 UDP 并获得测试映射地址，再验证真实 BrowserManager 经鉴权 SOCKS5 加载页面时，页面/iframe/弹窗/刷新均不产生直连 STUN 数据包或 host/srflx 候选。HTTP 请求仍经过上游代理。此测试比只检查页面返回字符串更直接；任何只隐藏 JS 候选但仍发出 UDP 的改动都会失败。

依据：[Chromium 开关区分的变更](https://chromium.googlesource.com/chromium/src/+/3d6bf17ccb45f22a9f86ce2dfc12559ea39dac74)、[Chrome 命令行到 preference 的映射](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/prefs/chrome_command_line_pref_store.cc)。
