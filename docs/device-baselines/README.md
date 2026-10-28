# 系统预定义设备档案与对照基准

这些是用户指定的版本化样本，不代表所有同系统设备。资料来自 2026-10-27 的采集，保留原声明；更换样本时应审查差异并更新来源信息。

| ID | 系统 | 覆盖范围 | 配置 | 对照数据 |
| --- | --- | --- | --- | --- |
| `macos-standard` | macOS | 已导出的报告字段；语音目录仅前 100 项 | [profile](../../config/device-profiles/macos-standard.json) | [reference](macos-standard/reference.json)、[manifest](macos-standard/manifest.json) |
| `iphone-standard` | iOS | 部分采集；原消息在 plugins 处截断 | [profile](../../config/device-profiles/iphone-standard.json) | [reference](iphone-standard/reference.json)、[manifest](iphone-standard/manifest.json) |

## 默认行为

- 新数据目录首次启动时，将这两份系统预定义写入档案目录，并分别设为 macOS 和 iOS 默认项。
- 现有 `android-pixel8-chrome155` 示例仍为新部署的 Android 默认项；旧 `macos-arm-chrome155` 示例保留供兼容调用，不再是新部署的 macOS 默认项。
- 已存在的 `/data/device-profiles.json` 优先，升级不会覆盖自定义内容、重新添加已删除项或填充有意清空的目录。
- `list_device_profiles` / `get_device_profile` 返回 `predefined` 和 `modified_from_predefined`。与内置标准内容相同的条目为 `kind: system`；自定义内容或被修改的系统档案为 `kind: configured`。
- 配置保存在 `config/device-profiles/`，随 Docker 镜像打包。只有用户选择对应 ID 时才用于实例；历史实例的配置快照不随文件修改。

创建时使用实际可用的档案 ID，并省略额外 UA 以保留标准中的完整身份声明：

```json
{"device_profile_id":"macos-standard"}
```

```json
{"device_profile_id":"iphone-standard"}
```

## 对照步骤

1. 使用目标档案创建云浏览器实例，打开 `/fingerprint`。
2. 下载 JSON，或通过 `evaluate` 读取 `JSON.parse(document.querySelector('#fingerprint-report').textContent)` 并保存结果。
3. 对指定基准执行比较：

```bash
node scripts/compare-fingerprint.mjs docs/device-baselines/iphone-standard/reference.json /path/to/actual.json
node scripts/compare-fingerprint.mjs docs/device-baselines/macos-standard/reference.json /path/to/actual.json
```

只比较 reference 中的字段，数组按完整有序值比较。退出码 0 表示已引用字段一致，1 表示存在差异或缺失，2 表示输入错误。actual 中额外的字段未被验证；缺失字段与明确返回 null 不等价。iPhone 的请求头要求另见 manifest 中的 `http_expectations`。

## 范围与限制

- iPhone 基准目前只有 52 个完整检查项，插件、硬件、Worker 原始报告、GPU、Canvas、音频、语音等后半部分缺失。不能用这个子集的通过结果宣称完整指纹一致。
- macOS 基准有 248 个检查项。v0.19.0 线上对照为 246 项一致，Canvas 和离线音频散列仍存在差异；这里只记录历史验证结果，后续需重新实测。
- 请求 IP、认证信息、采集时刻、随时间变化的当地时间及说明文字不纳入 reference。原始网络地址和凭据不随这些文件分发。
- 电量、网络延迟等仍是采集时的快照值；真实设备之后再次采集出现变化，需要结合条件判断，不能直接认定设备身份不同。
- manifest 同时区分原来源摘要与排序后紧凑 JSON 的 reference 摘要；iPhone 的来源摘要对应已完整提供的规范化子集，不是完整原始文件。
- 档案模拟网页可见声明和部分读取接口，实际内核仍为 Chromium。iPhone 档案不等于 iOS WebKit。未采集的 API 路径、反射行为和真实渲染输出不能据此推定一致。

补齐 iPhone 完整文件或更新设备版本时，应同时更新 profile、reference 和 manifest，并重新运行对照。普通接入示例继续以实时查询档案为准，不把这里的版本常量当作所有任务的默认 UA。
