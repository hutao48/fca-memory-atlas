# FCA 配置样例

本目录是 **Runtime 配置样例**，不是运行时实际读取的文件。

## 用法

把 `runtime.example.json` 复制到**数据目录**下并改名为 `runtime.json`：

```
%LOCALAPPDATA%\FCA-Memory-Atlas\config\runtime.json
```

或自定义数据目录：

```
<FCA_HOME>\config\runtime.json
```

Runtime 启动时按以下优先级解析配置（后者覆盖前者）：

```
CLI 参数  >  环境变量  >  <FCA_HOME>\config\runtime.json  >  默认值
```

- 桌面软件「设置」页与安装向导也会写这份配置文件。
- 修改端口后，桌面软件/DSH 插件的 `runtimeUrl` 需同步修改（插件在 `cordis.patch.yml` 的 `runtimeUrl`）。
- 默认只允许监听回环地址（`127.0.0.1` / `localhost` / `::1`）。`allowRemote` 仅供明确知情的本机高级场景使用，默认关闭。
- `config/runtime-token` 是 Runtime 首次启动自动生成的认证 token，**不要**放进版本库或配置样例。

## 字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `port` | integer | `17860` | 监听端口 |
| `host` | string | `127.0.0.1` | 监听地址（默认仅回环） |
| `allowRemote` | boolean | `false` | 是否允许非回环监听（安全风险） |
| `logLevel` | string | `info` | `silent`/`error`/`warn`/`info`/`debug` |
| `logMaxTail` | integer | `500` | `/api/v1/logs` 返回的日志尾部条数上限 |
| `maxBodyBytes` | integer | `8388608` | 请求体上限 |
| `sseHeartbeatMs` | integer | `15000` | SSE 心跳间隔 |
| `sseReplayLimit` | integer | `5000` | SSE `Last-Event-ID` 补发上限 |
| `requestTimeoutMs` | integer | `30000` | 单请求超时 |

## 环境变量（等价覆盖）

`FCA_HOME`、`FCA_PORT`、`FCA_HOST`、`FCA_LOG_LEVEL`、`FCA_SSE_HEARTBEAT_MS`、`FCA_ALLOW_REMOTE`、`FCA_MAX_BODY_BYTES`、`FCA_REQUEST_TIMEOUT_MS`。

完整说明见 `docs/USER_MANUAL.md` 与 `docs/PUBLIC_INTERFACE_FREEZE.md` §0。
