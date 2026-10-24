# 共用工具参考 V0.13.1（MCP & API）

推荐使用 `BASE_URL/mcp` 的 Streamable HTTP，携带 `Authorization: Bearer <登录网页自动生成的 Token>`。网页登录后可复制完整配置。兼容 MCP stdio，通过 SSH 或 docker exec 接入。HTTP 调用共享 web principal，stdio 仍按 MCP_PRINCIPAL 隔离。

全部参数和默认值见 [机器可读 Schema](mcp-tools.json)，可通过标准 MCP `tools/list` 实时发现。以下展示工具 arguments，也就是 `POST /api/tools/{工具名}` 的 JSON 请求体。

## 返回值

```json
{
  "operation_id": "uuid",
  "status": "succeeded",
  "data": {},
  "error": null
}
```

失败为 `status: failed`，包含 `error.code/message`，MCP `isError: true`。传输错误可能返回 `status: unknown` 和 operation_id；此时先 `get_operation`，断连未拿到 ID 时用 `list_operations` 查询。MCP Schema 参数不合法也可能直接返回协议级校验错误。

## 实例、环境与代理

| 工具 | 输入 | 输出要点 |
| --- | --- | --- |
| `list_recordings` | 可选 instance_id | 当前 principal 的录像、状态、playback_url；播放仍需网页登录或相同 Bearer |
| `health` | `{}` | 服务状态与容量 |
| `list_proxies` | 可选 country（两位大写国家码）、protocol（socks5/http/https）、enabled_only（默认true）、status（healthy/unhealthy/unknown/checking/disabled） | proxy_id、兼容 proxy_ref、名称、地址、国家、启用状态、status、health（checked_at / next_check_at / latency_ms / observed_ip / http_status / error_code / checking）、鉴权标记；不返回用户名或密码 |
| `check_proxy` | proxy、proxy_id、proxy_ref 三选一；可选 check_url | 临时浏览器查询出口，始终清理；不验证国家 |
| `create_instance` | 可选 task_description（1–1000字符）、storage_state_id、UA、viewport、proxy/proxy_id/proxy_ref、mobile、locale、timezone、生命周期 | instance_id、details_url、task_description、pages、实际设备属性、警告 |
| `get_instance` | instance_id | 配置和页面，隐藏凭据 |
| `list_instances` | `{}` | 同 principal 的实例 |
| `verify_environment` | instance_id；可选 check_url | 实际设备属性、IP 查询响应；不自动判断国家 |
| `close_instance` | instance_id | 关闭状态，关闭后 ID 不能执行浏览器操作，保留期内可查日志与历史状态 |
| `list_operations` | limit 默认20，最多100 | 同 principal 最近操作的 ID、工具、时间与状态 |
| `get_operation` | operation_id | 最近调用的结果，或 running；仅当前 principal 可查 |

创建示例：

```json
{
  "task_description": "验证移动端商品页、购物车和下载流程",
  "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "viewport": {"width": 412, "height": 915},
  "mobile": {"enabled": true, "touch": true, "device_scale_factor": 2},
  "proxy_id": "proxy_从list_proxies获取的ID",
  "idle_timeout_seconds": 600,
  "max_lifetime_seconds": 3600
}
```

## UA 与 Client Hints

`create_instance.user_agent` 自动生成 Chromium UA Client Hints，不需要另传参数。HTTP API 和 MCP 行为一致；新建标签页、弹窗及 iframe 使用同一实例的声明，Worker 的 JS 提示也随 UA 设置。

例如上述 Android UA 会生成 `Chromium` / `Google Chrome` 主版本 `130`、完整版本 `130.0.0.0`、`platform=Android`、`platformVersion=14`、`model=Pixel 8` 和 `mobile=true`。UA 中没有包含的 CPU 架构、位数等信息保持空值，不从宿主机补入。Windows NT 10.0 无法区分 Windows 10/11，对应平台版本也留空；简化 Android UA 的 `K` 不作为真实机型。

- `create_instance`、`get_instance`、`list_instances` 返回 `browser_version`（实际内核版本）和 `user_agent_metadata`（从自定义 UA 生成的声明，未生成时为 null）。这些字段也保存到历史 `environment`。
- `verify_environment.actual.client_hints` 返回验证页可读取的低熵及高熵提示，包括 `brands`、`fullVersionList`、`platform`、`platformVersion`、`mobile`、`model`、`architecture`、`bitness` 和 `wow64`。浏览器策略可能限制返回字段；非安全页面可能没有 Client Hints。
- 请求头仍遵守 Client Hints 的发送条件。基础提示在受支持的安全上下文提供；完整版本等高熵请求头由目标站点通过 `Accept-CH` 请求，不会为了模拟而向所有请求强行添加。
- 省略 UA 时保留浏览器原生行为。Safari、Firefox、iOS 或不能识别为 Chromium 的自定义 UA 不生成 Chromium 提示。
- UA 和 Client Hints 都是浏览器对外声明；真实内核保持容器自带版本，不等于对应版本的兼容性测试，也不等于真机。页面布局和触摸配置仍通过 `viewport` / `mobile` 指定。

## 公开观看链接

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `create_share_link` | kind=live + instance_id，或 kind=recording + recording_id；可选 expires_in_seconds（默认86400，1–2592000） | share_id、kind、resource_id、status、created_at、expires_at、url、media_url、frame_url（直播）、access=public_read_only |
| `list_share_links` | `{}` | 当前 principal 的分享元信息；不返回链接密钥或 URL |
| `revoke_share_link` | share_id | 撤销后的元信息，重复撤销仍成功 |

```json
{"kind":"live","instance_id":"ins_...","expires_in_seconds":3600}
```

```json
{"kind":"recording","recording_id":"rec_...","expires_in_seconds":86400}
```

同一实例可生成多个独立链接。公开链接无需登录，持有者可以观看对应内容；Agent 应在用户要求公开分享时调用。链接只读，不授权 MCP、控制台或其他实例。`url` 为手机/桌面观看页，`media_url` 可用于 MJPEG/WebM 媒体访问，直播额外返回 `frame_url`（单帧 JPEG）。观看页逐帧刷新以兼容隧道缓冲；通过匿名 Cloudflare 隧道时请使用观看页或轮询 frame_url，不依赖 MJPEG。录像支持 HEAD/Range。

直播必须属于当前 principal 且正在运行；直播结束不自动开放录像。录像必须属于当前 principal、已完成写入且文件非空，可先关闭实例，再调用 `list_recordings` 获取 ID。录像提前被清理时链接不可用。

有效期默认24小时、最多30天，同时最多1000个有效链接。密钥256位随机，仅保存 SHA-256 摘要；完整 URL 仅在创建结果中返回（该次操作结果在内存保留期间可通过 `get_operation` 找回）。授权和撤销状态保存于数据卷，重启后有效；管理密码变化不影响已发出的分享，需显式撤销。新建分享时会清除过期/已撤销元信息。

撤销或到期后，后续访问返回404，已有直播连接在1秒内断开；已下载/已缓冲内容无法收回。观看页状态约3秒刷新一次。直播正常结束的媒体请求返回410，观看页显示已结束。

无需登录的路由仅有：`GET /share/{随机密钥}`、`GET /share/{随机密钥}/status`、`GET /share/{随机密钥}/media`（录像另支持 HEAD）、`GET /share/{随机密钥}/frame`（仅直播）。密钥不能替换为 MCP Token，也不能作为 MCP Bearer 使用。公开页不返回代理信息、原网页 URL、控制台凭证或其他资源列表。静态资源和健康检查仍保持原有访问策略。

## 通过代理发送 HTTP 请求

`proxy_curl` 不创建浏览器，通过平台保存的启用代理 ID 调用 curl。参数：

| 参数 | 默认值 / 限制 |
| --- | --- |
| `proxy_id` | 必填，来自 `list_proxies` |
| `url` | 必填，HTTP(S)，不接受 URL 内嵌认证 |
| `method` | GET；支持 HEAD/POST/PUT/PATCH/DELETE/OPTIONS |
| `headers` | 字符串对象，最多50项，禁止换行及代理认证/请求分帧头 |
| `body` | 可选 UTF-8 字符串，最多64 KiB，HEAD 不能带请求体 |
| `follow_redirects` | false；启用后最多5次跳转 |
| `timeout_ms` | 15000；1000–60000 |
| `max_bytes` | 65536；1–1048576，超限停止请求并报错 |
| `response_encoding` | text；可选 base64，用于二进制响应 |

```json
{"proxy_id":"proxy_...","url":"https://api.ipify.org?format=json","method":"GET"}
```

返回 `proxy_id`、`status_code`、`final_url`、`elapsed_ms`、`redirect_count`、`headers`（name/value 数组）、`bytes`、`encoding`、`body`。4xx/5xx 是有效 HTTP 结果；连接、TLS、超时和大小超限是工具错误。响应体不写入日志；调用参数按原文写入功能调用日志，但 `get_operation` 可在内存保留期内读取操作结果，响应内容可能包含目标站点的敏感信息。

每次请求必须指定启用的保存代理，不自动直连、重试或执行 Shell。内网和域名限制与浏览器网关一致，对跳转也生效。并发请求上限等于 `MAX_INSTANCES`，不占浏览器名额。超时或断线不代表写请求未执行，先确认再重试。`list_proxies` 中的国家是管理员填写的标记，启用不代表健康。平台默认每5分钟、启动和配置变化时自动检测；用 `list_proxies({"protocol":"socks5","status":"healthy"})` 选择最近检测正常的线路。结果只能说明到检测目标的本次连通性；可用 `proxy_curl` 验证实际目标或可信 IP 服务。超过两个检测周期的旧结果视为 unknown；检测中为 checking，停用为 disabled。历史 health 信息会保留，默认查询仍只过滤停用项以保持兼容。

## 页面与定位

| 工具 | 输入 |
| --- | --- |
| `create_page` | instance_id，可选 url |
| `list_pages` | instance_id |
| `close_page` | instance_id、page_id |
| `navigate` | instance_id、page_id、action（goto/reload/back/forward）；goto 必须 url |
| `snapshot` | instance_id、page_id；可选 frame CSS、limit（默认80，最多200） |
| `interact` | instance_id、page_id、action、target；按 action 传 value/checked/delta_x/delta_y |
| `wait_for` | instance_id、page_id；target/url/download_id 三选一；可选 timeout_ms（最多60000） |
| `handle_dialog` | instance_id、page_id、accept；可选 text |

`target` 必须且只能指定 ref、role、text、css 中一个；role 可搭配 name，frame CSS 可定位 iframe：

```json
{"role": "button", "name": "Search"}
```

```json
{"css": "input[name=q]", "frame": "iframe#search"}
```

```json
{"ref": "g1e3"}
```

role/name 和 text 为精确匹配。多元素匹配会报错，不默认点击第一个。快照 ref 绑定原始 DOM 节点，不会因列表重排而指向另一节点。导航或交互后主动失效；DOM 变化后应重新取快照，节点移除会导致操作失败。

交互示例：

```json
{"instance_id":"ins_...","page_id":"page_...","action":"fill","target":{"css":"input[name=q]"},"value":"example"}
```

```json
{"instance_id":"ins_...","page_id":"page_...","action":"click","target":{"role":"button","name":"Search"}}
```

支持 click、fill、press（如 Enter）、select（原生 select option value）、check、hover、scroll。scroll 无 target 时滚动页面；有 target 时先滚动元素到视口，再滚动页面。interact 返回当时的页面列表，延迟弹窗需另查 list_pages。操作触发 JavaScript 对话框时返回 pending_dialog，先用 handle_dialog 处理，再检查最终结果；此时点击已发出，但流程尚未完成。

`wait_for` 的 state 为 visible/hidden/attached/detached。url 支持 Playwright URL glob。download_id 必须是 list_downloads 已返回的 ID。

## Tab 详情、页面脚本与鼠标键盘

所有页面操作显式传 `instance_id`、`page_id`。`list_instances` 返回当前 principal 的实例；`get_instance` 增加 busy、active_operation、storage_state_id。`get_instance`、`list_pages`、`get_page`、网络和 Console 查询使用缓存元信息，独立于浏览器动作锁，页面忙碌或渲染线程卡住时也可查询，不延长空闲超时。标题按页面事件更新，可能暂时为空或滞后。

| 工具 | 参数与结果 |
| --- | --- |
| `get_page` | instance_id、page_id；返回 URL、标题、active、state、frames（frame_id / parent_frame_id / name / url）、pending dialog、requires_reload |
| `select_page` | instance_id、page_id；选中浏览器焦点及直播/录屏页面 |
| `read_element` | instance_id、page_id、target；max_text 默认10000、最多60000；返回文本、值、属性、勾选/选中/禁用状态、主视口CSS坐标box |
| `evaluate` | instance_id、page_id、script；可选 arg、frame_id、timeout_ms（默认5000，100–30000）、max_result_bytes（默认65536，256–262144）；返回 value、value_type、bytes |
| `pointer` | instance_id、page_id、action；支持 click / double_click / right_click / move / down / up / drag / wheel |
| `keyboard` | instance_id、page_id、action=press/down/up/type、value；作用于当前焦点，支持 ControlOrMeta+A 等组合键 |

`evaluate.script` 是 JavaScript 表达式或函数文本；函数接收 arg，可返回 Promise。在指定 Tab 或 frame_id 的网页上下文执行，继承实例网络与代理环境。返回 JSON 值，undefined 转为 null 并保留 value_type，BigInt/循环结构等不能序列化的值报错。

```json
{"instance_id":"ins_...","page_id":"page_...","script":"arg => Array.from(document.links).slice(0,arg.limit).map(a=>({text:a.textContent,url:a.href}))","arg":{"limit":5}}
```

脚本可改变网页并触发请求。SCRIPT_TIMEOUT 后会中断当前执行，并将页面标为 requires_reload；已发出的请求或异步副作用可能已经发生。先读取状态、Console、网络和日志，再通过 `navigate` 的 reload 丢弃旧执行上下文；继续写操作前必须 reload 或关闭该页。超时不自动重试。操作历史会原样记录脚本和参数。

`pointer` 的 x/y、to_x/to_y 为 **主视口 CSS 像素**，必须位于视口内。click、double_click、right_click、move、down、drag 必须有 x/y；drag 另需 to_x/to_y。steps 默认12、1–100；button 为 left/right/middle；modifiers 可传 Alt/Control/ControlOrMeta/Meta/Shift，调用结束自动释放。分步拖拽可使用 down → move → up；需要跨调用保持修饰键时用 keyboard down/up。wheel 可传 x/y 定位滚动区域，再传 delta_x/delta_y。

```json
{"instance_id":"ins_...","page_id":"page_...","action":"drag","x":100,"y":200,"to_x":400,"to_y":200,"steps":20}
```

截图支持 `full_page`、`target` 或 `clip` 三选一（也可都不传取视口）。返回原始 PNG artifact 和 JPEG preview 元信息，MCP 同次响应附带可直接查看的 image 内容；预览最长边1280，必要时降到800，完整原图仍通过原始 artifact 获取。预览像素与 pointer 的 CSS 坐标可能不同，使用返回的 viewport 和 preview 尺寸换算。

## Tab 网络请求与 Console

| 工具 | 参数 |
| --- | --- |
| `list_network_requests` | instance_id、page_id；可选 after_seq、limit（默认100/最多200）、url（子串）、method、resource_type、status_code、failed_only |
| `get_network_request` | instance_id、page_id、request_id；include_body 默认true |
| `get_console_logs` | instance_id、page_id；可选 after_seq、limit（默认100/最多200）、level（精确匹配 log/info/warning/error/pageerror 等） |

网络捕获从页面创建开始，覆盖导航、fetch/XHR、重定向和失败；每个请求独立 request_id，归属于一个实例和 Tab，包含 URL、方法、资源类型、frame_id、HTTP状态、耗时和 timing。详情包含原始请求/响应头和可用的正文。网络状态 pending/finished/failed 与 HTTP status_code 分开，HTTP 4xx/5xx 仍可正常完成网络传输。

```json
{"instance_id":"ins_...","page_id":"page_...","resource_type":"fetch","url":"/api/","limit":50}
```

```json
{"instance_id":"ins_...","page_id":"page_...","request_id":"req_...","include_body":true}
```

正文异步采集，检查 response_body_status（pending/available/too_large/unavailable）和 body_error；pending 可稍后重查。每个正文最多256 KiB，大资源不重复读取，较大的压缩资源会跳过；UTF-8或base64由 encoding 标明，truncated 表示前缀截断。请求头最多100项、合计约32 KiB；URL最多16384字符。Console 保留原始文本、位置和页面异常堆栈，文本最多16384字符、堆栈32768字符，超限通过 truncated 标明。原始数据不脱敏。

每个 Tab 网络缓存最多200条/4 MiB，Console最多300条/1 MiB。省略 after_seq 读取最近事件；传返回的 next_after_seq 增量读取，has_more=true 时继续。网络记录更新也推进seq，客户端按 request_id 合并更新，避免漏掉后到的响应。history_truncated、dropped_entries 报告轮转；主体采集全平台最多2个并发、16个排队任务，拥塞会标记 CAPTURE_QUEUE_FULL。

这些缓存保存在实例内存中，实例关闭或服务重启后不保留。关闭 Tab 的缓存可继续查询，直到实例结束或被新的 Tab 历史挤出；同一实例最多保留 MAX_PAGES 份页面缓存，优先移除已关闭页面。get_logs 中的持久化功能调用和故障事件仍按既有保留期保存。

## 登录态保存与恢复

| 工具 / 参数 | 用法 |
| --- | --- |
| `save_storage_state` | instance_id；indexed_db 默认false；返回 storage_state_id、私有 artifact、Cookie和origin数量 |
| `create_instance.storage_state_id` | 创建新实例时加载同一 principal 拥有的登录态 |
| `restore_storage_state` | instance_id、storage_state_id；替换现有上下文的 Cookie和origin存储，随后显式 reload 页面 |

登录态包括 Cookie、localStorage，以及启用 indexed_db 时的 IndexedDB；不包含 sessionStorage、页面内存或扩展。状态以最大2 MiB的JSON artifact存储，遵循既有数据卷、所有者校验、配额和保留期；可在实例关闭、服务重启后恢复。恢复的 origin 仍通过网络策略检查；不接受任意服务器文件路径。

```json
{"instance_id":"ins_...","indexed_db":true}
```

```json
{"storage_state_id":"art_从save_storage_state获取","task_description":"继续上次登录后的流程"}
```

## 诊断与产物

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `get_diagnostics` | instance_id，limit 默认100，最多300 | 脱敏响应状态/跳转/失败请求、console 类别、下载 |
| `screenshot` | instance_id、page_id、full_page 默认false | 原始PNG artifact、JPEG preview元信息及同次MCP image内容 |
| `list_downloads` | instance_id | 下载状态、失败、完成后的 artifact |
| `put_artifact` | name、data_base64，可选 mime | 保存授权文件，解码后最多512 KiB |
| `upload_file` | instance_id、page_id、target、artifact_id | 将已有文件上传到 file input |
| `get_artifact` | artifact_id，offset 默认0，length 默认262144/最多524288 | base64、sha256、size、next_offset、complete |

artifact_id 不接受任意文件路径。get_artifact 按 next_offset 继续读取，客户端拼接解码后的字节并与 sha256 比较。完整返回 PNG 时会附带 MCP image 内容。上传和下载在 close_instance 后仍可读取，直到过期或配额清理。

诊断移除 URL 查询参数，不记录 console 原始字符串或响应正文，降低凭据泄漏风险；页面快照、最终 URL、截图和下载文件仍可能含敏感业务数据。

## 持久化日志与实例诊断

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `get_logs` | 可选 instance_id、operation_id(UUID)、component、level、since(ISO8601)、after_seq；limit 默认100，最多200 | entries、next_after_seq、has_more、oldest_available_seq、history_truncated、write_errors、last_write_error、dropped_events |
| `inspect_instance` | instance_id；probe 默认true，timeout_ms 默认1500，100–5000 | instance 历史状态、live 实时状态、responsiveness、findings、resources、recent_logs |

`component` 为 service/browser/page/operation/recorder/tunnel；`level` 为最低级别 info/warn/error。省略 after_seq 返回最近limit条；传入游标则按序读取后续事件，has_more=true表示仍有后续页。轮转导致的游标缺口通过 history_truncated 提示。

```json
{"instance_id":"ins_...","level":"warn","limit":100}
```

```json
{"instance_id":"ins_...","probe":true,"timeout_ms":1500}
```

日志按 instance_id、operation_id 和时间关联，保存于 `/data/diagnostics`，默认7天、约16 MiB事件，结束实例快照最多1000份；先达到轮转/数量/保留期限制的记录先清理。get_logs在实例快照已清理但事件仍保留时仍可查询对应事件。日志只返回当前principal和通用服务事件，不支持任意文件读取。日志突发丢弃或写入故障会返回明确计数。

inspect_instance和get_logs不占用浏览器执行锁；get_diagnostics也可在忙碌或已断开的活跃实例上读取。inspect_instance的探测仅执行固定只读检查，有独立截止时间，同一页面不会无限叠加探测。历史实例的live为null。探测超时只表示该检查没有按时返回，不等于已确定卡死根因。

关闭原因包括 requested、idle_timeout、max_lifetime、browser_disconnected、service_shutdown、manager_interrupted、creation_failed；保留浏览器主进程PID、退出码/信号、最近操作、结束时的录屏状态。最大存活期在忙碌时也会执行；空闲超时仅在空闲时执行。

资源指标包括管理进程RSS、宿主空闲内存/负载、可读时的cgroup内存及OOM计数、数据卷空间。非Linux、未设置内存限额或无权限时部分字段为null。SIGKILL、断开或超时不能单独证明OOM，容器内的OOM计数也不能单独归因于某个实例。

功能调用使用 component=operation，按 instance_id 和 operation_id 关联开始、成功或失败事件。operation_started.arguments 保存完整校验后参数；fields 包括 tool、action、完整url；结束事件包含 elapsed_ms，失败还包含 error_code 与原始 error_message。不对调用参数、URL和错误信息脱敏，输入值和显式传入的认证信息也会原样保存。工具结果的正文、图片和文件不重复写入日志。

控制台实时实例、历史录屏均可按实例查看调用日志，支持结果筛选与5秒自动更新。创建时的可选 task_description（首尾空格会去除，1–1000字符）同时保存在实例状态与录屏元信息，可由 get_instance/list_instances、inspect_instance、list_recordings 读取。旧记录无该字段；公开分享页不会附带任务描述和日志。

其他诊断事件记录事件码、错误类型、HTTP状态、脱敏URL等元信息，不记录原始console文本和响应正文。浏览器原生stderr和编码器stderr仅提取固定故障类别，不返回原始输出。日志查询和状态探测不会挤占最近500个业务操作结果的缓存；这两个只读工具失败后可重新查询。

进程重启后，先前仍活跃且没有关闭记录的实例标记manager_interrupted；这表示管理进程中断，不能据此确认浏览器或宿主机的具体故障。此前未采集的事件无法追溯。整个服务不可用时需由部署方检查docker logs和docker inspect的状态摘要。

## 错误与并发

- INVALID_ARGUMENT / INVALID_TARGET / INVALID_URL
- INSTANCE_LIMIT / INSTANCE_NOT_FOUND / INSTANCE_BUSY
- PAGE_LIMIT / PAGE_NOT_FOUND
- NETWORK_BLOCKED / PROXY_NOT_FOUND / PROXY_CONNECTION_FAILED
- ENVIRONMENT_CHECK_FAILED / TIMEOUT / BROWSER_CLOSED
- STALE_ELEMENT_REFERENCE / AMBIGUOUS_ELEMENT / ELEMENT_ERROR
- DOWNLOAD_FAILED / DOWNLOAD_TOO_LARGE / DOWNLOAD_NOT_FOUND
- ARTIFACT_NOT_FOUND / ARTIFACT_TOO_LARGE / STORAGE_LIMIT
- FRAME_NOT_FOUND / REQUEST_NOT_FOUND / INVALID_COORDINATES
- SCRIPT_ERROR / SCRIPT_TIMEOUT / SCRIPT_RESULT_TOO_LARGE / SCRIPT_RESULT_NOT_SERIALIZABLE / PAGE_RELOAD_REQUIRED
- INVALID_STORAGE_STATE / STORAGE_STATE_TOO_LARGE
- DIALOG_NOT_FOUND / OPERATION_NOT_FOUND / OPERATION_FAILED
- SHARING_DISABLED / LIVE_UNAVAILABLE / SHARE_LIMIT / SHARE_NOT_FOUND
- RECORDING_NOT_READY / RECORDING_NOT_FOUND
- LOG_READ_FAILED

同实例一次只允许一个执行中的浏览器操作，其他实例可并行；get_logs、inspect_instance、get_diagnostics、实例和Tab元信息、网络与Console查询独立执行。close_instance 可强制结束正在运行的操作。get_operation 可查询当前管理进程最近500个调用；不能当作跨进程重启的永久幂等机制。服务不会自动重试点击或提交。

当前不支持外部 cancel 操作；可通过 close_instance 中止该实例。工具最长单步等待受配置限制，MCP 接入等待管理进程最多180秒，超时后原操作可能仍运行，需检查状态。

## 管理与媒体 HTTP 路由

所有地址均相对于 BASE_URL。`/` 为密码登录及说明/监看页；`POST /login`、`POST /logout` 管理 Cookie 会话。`GET /healthz` 仅返回无敏感信息的存活状态。

`GET /docs/agent-guide.md`（支持 HEAD）无需登录：提供与当前镜像一致的通用接入指南、完整接口参考和 Agent 工作流。内容不包含部署凭据或实例数据，允许跨来源匿名读取。控制台的 MCP 和 API 接入信息共用这个公开文档链接；复制内容只包含一句话、对应地址、认证头和文档链接。

以下路由均需要登录 Cookie 或相同 Bearer Token：

- `GET /api/connection`：MCP URL、JSON 配置、简短的 agent_instructions 和公开文档地址 agent_guide_url。
- `GET /api/instances`：管理员可查看全部活跃实例及容量。
- `GET /api/instances/{instance_id}/live`：MJPEG 低帧率直播。
- `GET /api/instances/{instance_id}/frame`：当前采样 JPEG，无画面时204；实例结束404。网页最多约2 FPS逐帧刷新。
- `GET /api/recordings`：历史录像。
- `GET /api/settings`：已登录管理员读取当前 storage 和 usage（产物用量、分类和磁盘可用空间）。
- `PUT /api/settings`：保存 `{ "max_data_bytes": 214748364800, "screenshot_retention_days": 7 }`；需要网页登录及 CSRF 请求头或现有 Bearer。配额最少1 MiB，截图保留1–365天，配置持久化且即时生效。MCP `health.storage` 返回当前设置。
- `GET /api/recordings/{recording_id}/video`：WebM 播放/下载，支持 Range；录像未完成返回 409。
- `GET /docs/README.md`、`/docs/mcp-api.md`、`/docs/mcp-tools.json`、`/docs/agent-workflow.md`：完整文档。

`POST /mcp` 只接受 Bearer 鉴权，不使用 Cookie。密码变更并重启后 Token 轮换；不把 Token 放在 URL 中。直播和录屏包含可见业务内容，请仅授权可信使用方。

## 私有实例详情链接

Web 模式下 `create_instance`、`get_instance`、`list_instances`、`inspect_instance` 以及 `list_recordings` 返回 `details_url`，优先采用 `BASE_URL`，格式为：

```text
{BASE_URL}/instances/{instance_id}?access_token=
```

空的 `access_token=` 是有意保留的鉴权提示，服务不会自动填入部署 Token。普通浏览器使用现有登录态；未登录时先输入访问密码，成功后回到当前实例。实例结束后链接不变，详情展示保留期内的状态、属性、录屏、标签页快照与原文调用日志。日志已过期但仍有录屏时仍可打开详情；全部记录过期返回 404。

AI 可填写 MCP Bearer Token：`?access_token=<TOKEN>&format=json` 或 `&format=markdown`。也支持 `Authorization: Bearer <TOKEN>` 请求头；登录态有效时优先使用登录态。无登录态且 Token 错误/失效时返回 401，JSON/Markdown 未鉴权同样返回 401。

详情文档的 `instance` 为历史状态，`current` 为当前实例摘要或 null，另有 `pages`、`recordings`、`logs_available`、最近200条 `logs` 和媒体/日志 `links`。默认 HTML 也提供服务端可读内容；`format=json` / `Accept: application/json` 返回 JSON，`format=markdown` / `Accept: text/markdown` 返回 Markdown。返回链接的 `access_token` 均保持空值；调用方按需填入，不自动传播真实 Token。

`GET /api/instances/{id}` 提供状态、属性、标签页与录屏的只读摘要；详情页轮询此接口，不执行浏览器脚本、探测或延长实例空闲期限。以下只读接口也接受查询参数 `access_token`：

- `GET /api/instances/{id}`、`GET /api/instances/{id}/logs`
- `GET /api/instances/{id}/frame`、`GET /api/instances/{id}/live`
- `GET/HEAD /api/recordings/{id}/video`

此查询参数不用于 `/mcp`、代理或系统设置等管理接口。Token 访问不创建长期登录 Cookie；详情响应为 `no-store` / `no-referrer`。公开分享链接的授权机制保持独立。

## 自动 HTTPS 入口

仅设置 WEB_PASSWORD 即可默认启动匿名 Quick Tunnel；设置 CF_TUNNEL_TOKEN 后使用命名隧道并自动识别域名。设置 BASE_URL 可指定自管入口，或在命名隧道有多个域名时选择主入口。日志给出 Public HTTPS URL 与 MCP URL；网页登录后生成的连接配置和分享链接使用该地址。匿名地址会在隧道重建后变化，应重新复制 MCP 配置和生成分享链接；已有分享授权不会延长过期时间。命名隧道的域名需提前在 Cloudflare 绑定并指向 localhost:8080。

本服务 Streamable HTTP 使用 JSON 响应，不依赖 Quick Tunnel 不支持的 SSE。所有模式保留原有密码、MCP Bearer、分享密钥和所有者隔离。

实例摘要（`create_instance`、`list_instances`、`get_instance`）的 `user_agent` 为创建时从浏览器读取的实际值；`egress` 包含 `ip`、`source`（instance_check / proxy_check / unknown）、`checked_at`。实例检测由 `verify_environment` 的有效 IP 响应更新；代理检查样本只在代理 ID、地址和凭据与实例固定配置一致且仍新鲜时采用，不能保证当前连接出口相同。未知值返回 null，列表读取不额外访问外部服务。

实例摘要的 `country` / `country_source` 为创建时固定的代理配置国家（proxy_config），未配置时为 null / unknown。`list_recordings` 和 `inspect_instance.instance` 的可选 `environment` 保存实例运行期间的环境快照：`captured_at`、`user_agent`、按 UA 识别的 `os`、`country`、`country_source` 和 `egress`。创建成功、有效实例出口检测及关闭时更新；历史读取不查询当前代理配置或发起地理检测。旧记录可能没有 `environment`。OS 不是服务器 OS，国家配置不代表 IP 地理验证。

多个入口域名均可访问控制台与 MCP，浏览器请求按当前 Host 进行同源校验，无需域名白名单。BASE_URL 只决定文档、MCP接入和分享链接的主地址；未设置时使用隧道路由中第一个指向本容器的有效域名。密码、Token与CSRF校验保持有效，反向代理需保留外部Host。
