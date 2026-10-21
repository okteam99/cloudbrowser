# MCP 接口 V0.8

推荐使用 `BASE_URL/mcp` 的 Streamable HTTP，携带 `Authorization: Bearer <登录网页自动生成的 Token>`。网页登录后可复制完整配置。兼容 MCP stdio，通过 SSH 或 docker exec 接入。HTTP 调用共享 web principal，stdio 仍按 MCP_PRINCIPAL 隔离。

全部参数和默认值见 [机器可读 Schema](mcp-tools.json)，可通过标准 MCP `tools/list` 实时发现。以下展示工具 arguments，不是 HTTP 请求。

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
| `create_instance` | UA、viewport、proxy/proxy_id/proxy_ref、mobile、locale、timezone、生命周期 | instance_id、pages、实际设备属性、警告 |
| `get_instance` | instance_id | 配置和页面，隐藏凭据 |
| `list_instances` | `{}` | 同 principal 的实例 |
| `verify_environment` | instance_id；可选 check_url | 实际设备属性、IP 查询响应；不自动判断国家 |
| `close_instance` | instance_id | 关闭状态，关闭后 ID 不再可用 |
| `list_operations` | limit 默认20，最多100 | 同 principal 最近操作的 ID、工具、时间与状态 |
| `get_operation` | operation_id | 最近调用的结果，或 running；仅当前 principal 可查 |

创建示例：

```json
{
  "user_agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "viewport": {"width": 412, "height": 915},
  "mobile": {"enabled": true, "touch": true, "device_scale_factor": 2},
  "proxy_id": "proxy_从list_proxies获取的ID",
  "idle_timeout_seconds": 600,
  "max_lifetime_seconds": 3600
}
```

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

返回 `proxy_id`、`status_code`、`final_url`、`elapsed_ms`、`redirect_count`、`headers`（name/value 数组）、`bytes`、`encoding`、`body`。4xx/5xx 是有效 HTTP 结果；连接、TLS、超时和大小超限是工具错误。响应不写入诊断日志，但 `get_operation` 可在内存保留期内读取操作结果，响应内容可能包含目标站点的敏感信息。

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

## 诊断与产物

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `get_diagnostics` | instance_id，limit 默认100，最多300 | 脱敏响应状态/跳转/失败请求、console 类别、下载 |
| `screenshot` | instance_id、page_id、full_page 默认false | PNG artifact 元信息 |
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

只记录事件码、错误类型、HTTP状态、脱敏URL等元信息；不记录原始console/异常消息、输入值、正文、Cookie或认证头。浏览器原生stderr和编码器stderr仅提取固定故障类别，不返回原始输出。日志查询和状态探测不会挤占最近500个业务操作结果的缓存；这两个只读工具失败后可重新查询。

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
- DIALOG_NOT_FOUND / OPERATION_NOT_FOUND / OPERATION_FAILED
- SHARING_DISABLED / LIVE_UNAVAILABLE / SHARE_LIMIT / SHARE_NOT_FOUND
- RECORDING_NOT_READY / RECORDING_NOT_FOUND
- LOG_READ_FAILED

同实例一次只允许一个执行中的浏览器操作，其他实例可并行；get_logs、inspect_instance和get_diagnostics独立查询。close_instance 可强制结束正在运行的操作。get_operation 可查询当前管理进程最近500个调用；不能当作跨进程重启的永久幂等机制。服务不会自动重试点击或提交。

当前不支持外部 cancel 操作；可通过 close_instance 中止该实例。工具最长单步等待受配置限制，MCP 接入等待管理进程最多180秒，超时后原操作可能仍运行，需检查状态。

## 管理与媒体 HTTP 路由

所有地址均相对于 BASE_URL。`/` 为密码登录及说明/监看页；`POST /login`、`POST /logout` 管理 Cookie 会话。`GET /healthz` 仅返回无敏感信息的存活状态。

`GET /docs/agent-guide.md`（支持 HEAD）无需登录：提供与当前镜像一致的通用接入指南、完整接口参考和 Agent 工作流。内容不包含部署凭据或实例数据，允许跨来源匿名读取。网页登录后的复制内容只包含一句话、MCP 地址、认证头和这个公开文档链接。

以下路由均需要登录 Cookie 或相同 Bearer Token：

- `GET /api/connection`：MCP URL、JSON 配置、简短的 agent_instructions 和公开文档地址 agent_guide_url。
- `GET /api/instances`：管理员可查看全部活跃实例及容量。
- `GET /api/instances/{instance_id}/live`：MJPEG 低帧率直播。
- `GET /api/instances/{instance_id}/frame`：当前采样 JPEG，无画面时204；实例结束404。网页最多约2 FPS逐帧刷新。
- `GET /api/recordings`：历史录像。
- `GET /api/recordings/{recording_id}/video`：WebM 播放/下载，支持 Range；录像未完成返回 409。
- `GET /docs/README.md`、`/docs/mcp-api.md`、`/docs/mcp-tools.json`、`/docs/agent-workflow.md`：完整文档。

`POST /mcp` 只接受 Bearer 鉴权，不使用 Cookie。密码变更并重启后 Token 轮换；不把 Token 放在 URL 中。直播和录屏包含可见业务内容，请仅授权可信使用方。

## 自动 HTTPS 入口

仅设置 WEB_PASSWORD 即可默认启动匿名 Quick Tunnel；设置 CF_TUNNEL_TOKEN 后使用命名隧道并自动识别域名。设置 BASE_URL 可指定自管入口，或在命名隧道有多个域名时选择主入口。日志给出 Public HTTPS URL 与 MCP URL；网页登录后生成的连接配置和分享链接使用该地址。匿名地址会在隧道重建后变化，应重新复制 MCP 配置和生成分享链接；已有分享授权不会延长过期时间。命名隧道的域名需提前在 Cloudflare 绑定并指向 localhost:8080。

本服务 Streamable HTTP 使用 JSON 响应，不依赖 Quick Tunnel 不支持的 SSE。所有模式保留原有密码、MCP Bearer、分享密钥和所有者隔离。

实例摘要（`create_instance`、`list_instances`、`get_instance`）的 `user_agent` 为创建时从浏览器读取的实际值；`egress` 包含 `ip`、`source`（instance_check / proxy_check / unknown）、`checked_at`。实例检测由 `verify_environment` 的有效 IP 响应更新；代理检查样本只在代理 ID、地址和凭据与实例固定配置一致且仍新鲜时采用，不能保证当前连接出口相同。未知值返回 null，列表读取不额外访问外部服务。
