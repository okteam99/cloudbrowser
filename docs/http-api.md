# HTTP API 调用说明

本节与 MCP 工具参考组成同一份公开 MD：`BASE_URL/docs/agent-guide.md`。如果 BASE_URL 含路径前缀，所有地址保留该前缀，例如 `https://example.com/browser/api/tools/health`。

## 端点和鉴权

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/tools` | 所有工具的名称、说明、inputSchema 和调用 URL |
| GET | `/api/openapi.json` | 工具 API 的 OpenAPI 3.1 描述 |
| POST | `/api/tools/{工具名}` | 执行工具；请求体为该工具的参数对象 |

所有工具调用必须携带 `Authorization: Bearer <Token>` 和 `Content-Type: application/json`。网页登录 Cookie 或 query 的 `access_token` 不能替代工具调用的 Bearer 请求头。目录与 OpenAPI 可通过 Cookie 或 Bearer 读取。接口不会允许任意跨站浏览器请求；服务器程序可直接请求。

正文最大 1 MiB。无参数的工具也传 `{}`。不要在参数外包装 `arguments`、`name` 或 `jsonrpc`；那些属于 MCP 协议。

## 可复制示例

将 BASE_URL 和 TOKEN 替换为用户提供的值（Token 与网页登录密码不同）：

```bash
BASE_URL='https://browser.example.com'
TOKEN='<用户提供的Token>'

curl --fail-with-body "$BASE_URL/api/tools/health" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{}'

curl --fail-with-body "$BASE_URL/api/tools/create_instance" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"task_description":"检查网页功能","viewport":{"width":1440,"height":900}}'
```

取创建结果的 `data.instance_id` 和 `data.pages[0].page_id`，再导航：

```bash
curl --fail-with-body "$BASE_URL/api/tools/navigate" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"instance_id":"ins_...","page_id":"page_...","url":"https://example.com/"}'
```

截图和关闭同样使用 POST：

```text
POST /api/tools/screenshot
{"instance_id":"ins_...","page_id":"page_...","full_page":false}

POST /api/tools/close_instance
{"instance_id":"ins_..."}
```

API 截图的 `data.id` 为原始 PNG，`data.preview.id` 为预览。调用 `get_artifact`，传 `artifact_id`、`offset`、`length` 获取 `data.data_base64`；每块最多 524288 字节，用 `next_offset` 继续，直到 `complete=true`。MCP 在截图结果上额外包装 image 内容，浏览器动作本身相同。

## 返回值和错误

```json
{
  "operation_id": "73495cc6-efca-4355-8ae0-041b1ad5d85b",
  "status": "succeeded",
  "data": {},
  "error": null
}
```

工具调用响应还带 `X-Operation-ID` 请求头。不同工具的 `data` 结构见后续共用工具参考。

| HTTP 状态 | 含义 |
| --- | --- |
| 200 | 工具执行成功；网页业务是否成功仍需检查内容 |
| 400 | JSON、参数或 Idempotency-Key 不合法 |
| 401 / 403 | 缺少或错误的 Bearer Token / 浏览器跨站 Origin 被拒绝 |
| 404 | 工具、实例、页面等资源不存在或已过期 |
| 405 / 415 | 方法不正确 / 缺少 application/json |
| 409 | 当前状态不允许、容量或配额限制、操作 ID 参数冲突等 |
| 413 | 请求或产物大小超限 |
| 500 / 502 | 执行错误 / 代理连接失败 |
| 503 / 504 | 执行结果不确定 / 超时；先查询状态 |

工具失败返回 `status: failed`、`error.code`、`error.message`；参数错误可能有 `error.issues`。传输中断可能返回 `status: unknown`，也可能根本拿不到响应。Origin 校验失败发生在工具入口前，返回 `{"error":"Origin not allowed"}`。反向代理的网络错误可能不是 JSON。

## 超时、重复请求与日志

操作调用可自行生成 UUID 放入 `Idempotency-Key`。同一 key、相同工具及参数，在操作缓存仍保留时复用结果，避免重复创建或点击；用同一 key 提交不同操作会返回 `OPERATION_ID_CONFLICT`。规范化后的参数顺序不影响比较。key 同时就是返回的 `operation_id`。

缓存仅在当前进程内保留最近 500 个被缓存的调用，重启或淘汰后失效；诊断读取类工具可能重新执行，不保证持久幂等。连接超时后，不要盲目更换 key 重试写操作。用 `POST /api/tools/get_operation`，正文 `{"operation_id":"此前的UUID"}` 查询；无 ID 时用 `list_operations` 并检查实例状态。结果缓存已过期时结合 `get_logs`、`inspect_instance` 判断，不能假定操作未执行。

`get_logs` 传 `instance_id` 与 `component: "operation"` 可查看功能调用记录，MCP/API 使用同一日志；记录保留完整参数、URL 和原始错误。日志需鉴权。`details_url` 可查看同一实例的直播、历史录屏、状态、属性和日志。

## 详情与媒体的只读 HTTP 接口

下列已有资源接口用于读取控制台数据，响应结构与工具调用的结果包装不同：

| 方法 | 路径 | 内容 |
| --- | --- | --- |
| GET | `/api/instances` | 当前实例列表 |
| GET | `/api/instances/{instance_id}` | 当前及历史详情、页面、录屏 |
| GET | `/api/instances/{instance_id}/logs` | 该实例功能日志 |
| GET | `/api/instances/{instance_id}/frame` | 当前 JPEG 帧 |
| GET | `/api/recordings` | 录像列表 |
| GET / HEAD | `/api/recordings/{recording_id}/video` | WebM 录像，支持 Range |

这些接口支持 Bearer 或登录 Cookie。实例详情及其关联日志、画面、录像另支持受限 query Token；列表不支持。本文档后的工具参考同时适用于 MCP 与 API：把工具名称放入 `/api/tools/{工具名}`，把表格中的参数作为 JSON 正文即可。
