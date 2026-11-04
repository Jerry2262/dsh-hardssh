---
name: dsh-session-triage
description: 快速定位、解码并对比 DSH 会话日志（本地/SSH 工作区、主服务或测试服务），用于排查某次对话为什么失败、对比两个工作区的执行流、复盘模型行为或验收远程执行路由；包含会话目录编码规则、zstd 多帧解码脚本和按工具流摘要脚本，避免重复试错。
---

# DSH 会话日志排障

## 何时用

- 用户说「看看那两个会话」「为什么这次失败」「对比一下本地/远端的执行流」「验收某个工作区」「最新的会话」。
- 需要看某条会话里工具调用了什么、结果是什么、模型最终答了什么。
- 不要凭记忆猜会话内容：会话日志在磁盘上，直接读。

## 目录与编码规则

- 会话文件：`$DSH_HOME/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd`
- `DSH_HOME` 默认 `~/.dsh`；测试服务常用 `<repo>/.dsh-e2e/home`。
- `<encoded-cwd>` = `--` + 会话 cwd 去掉开头 `/` 后把所有 `/` 换成 `-` + `--`。
  - `/home/jerry/tmp` → `--home-jerry-tmp--`
  - `/home/jerry/dsh-hardssh/.dsh-e2e/home/ssh-workspaces/<id>` → `--home-jerry-dsh-hardssh-.dsh-e2e-home-ssh-workspaces-<id>--`
- SSH 工作区会话的 cwd 是**本地 anchor**（`$DSH_HOME/ssh-workspaces/<workspaceId>`），不是远端路径；按 anchor 编码找目录。
- 同 cwd 下可能有多个会话（含已归档的）。归档只是从列表隐藏，文件还在；用 mtime 取最新。
- 内核工作区表：`$DSH_HOME/storages/workspace.json`（workspaceId → path/title/sessionIds）；插件通用账本：`$DSH_HOME/workspaces/index.v1.json`（含 SSH workspace 的 anchor/alias/remoteRoot）。

## 第 1 步：找最新会话（不要 ls 猜）

```sh
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
cwd="/home/jerry/tmp"                                  # 或 SSH 工作区 anchor
enc=$(printf '%s' "$cwd" | sed 's#^/##; s#/#-#g')
dir="$DSH_HOME/sessions/--$enc--"

# 最新 5 个会话（mtime 降序）
find "$dir" -name 'session.v4.jsonl.zstd' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -5

# 只看某时间之后的（例如今天）
find "$dir" -name 'session.v4.jsonl.zstd' -newermt '2026-11-04 09:00' -printf '%TH:%TM %p\n' | sort

# 找 SSH 工作区的 anchor：先查账本
node -e 'const p=require(process.argv[1]);const s=require("fs").readFileSync(process.argv[1],"utf8");for(const r of JSON.parse(s).records??[]) console.log(r.id, r.anchor?.path, r.provider?.connectionRef?.alias, r.location?.root)' "$DSH_HOME/workspaces/index.v1.json"
```

多个 `DSH_HOME` 并存时（主服务 `~/.dsh` 与测试服务 `.dsh-e2e/home`），先把两个 home 的最新会话都列出来再判断，不要只查一个。

## 第 2 步：解码（必须扫多帧，不能只用 zstdDecompressSync）

会话文件是**多个独立 zstd frame 串联**，Node 的 `zstdDecompressSync` 只解第一帧。用本 skill 自带脚本：

```sh
node .dsh/skills/dsh-session-triage/scripts/decode-sessions.mjs \
  .dsh-e2e/transcripts/triage \
  /path/to/session-a/session.v4.jsonl.zstd \
  /path/to/session-b/session.v4.jsonl.zstd
```

脚本输出每帧数量、事件行数和解码后的 `<outDir>/<session-id>.jsonl`。

## 第 3 步：按执行流摘要（不要直接读整行 JSON）

```sh
node .dsh/skills/dsh-session-triage/scripts/summarize-session.mjs <decoded.jsonl>
# --full 不截断；默认截断长输出
```

关注这些事件类型：

- `tool/call`：`data.name` + `data.arguments`（JSON 字符串）
- `tool/result`：`data.message.isError` + `data.message.content[].text`（工具输出/错误原文）
- `assistant/message`：`data.message.content[]`，`type:"text"` 是最终回答，`reasoning` 是思考
- `user/message` 里 `Current runtime context` 的 `Current working directory` 是会话 cwd（判断本地/锚点）
- `session/title` 是标题；`job/registered` / `job/settled` 是 bash 后台任务
- `permission/preset`、`sandbox/mode` 是会话权限

判断执行侧是否正确的硬证据：bash 结果里的 hostname/kernel 与本地/远端对照；远端执行的 bash 结果 stderr 常带 `landlock-run:` 提示。

## 常见坑

- **bash 工具可能跑在 bwrap 私有命名空间里**：`/tmp` 每次调用都可能不可见/被清空，脚本产物写到仓库内（如 `.dsh-e2e/tmp/`、`.dsh-e2e/transcripts/`）；不要依赖跨调用的 `/tmp` 文件。
- 会话文件跨 turn 追加，文件 mtime 是最后一次写入时间；同会话正在运行时可能还在写，解码结果可能缺最后一段，可稍后重试。
- 测试服务的进程可能不在当前 bash 沙箱的 PID namespace 里（`ps` 看不到），别用 `ps`/`lsof` 判断服务是否存在；用端口探测 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/`（401 表示服务活着但需要鉴权）。
- 远端工作区会话的 cwd 是 anchor 路径；如果拿 `remoteRoot` 去编码目录会找不到。
- 模型说“本机”不等于 bash 在本机执行：以 hostname/kernel 和 stderr 的 `landlock-run` 线索为准。

## 附：驱动测试服务的 Web API（创建会话/发 prompt，用于验收）

服务启动后从 stdout 拿到 `?token=...`；先用它换浏览器 session cookie：

```sh
BASE=http://127.0.0.1:3099
TOKEN=...      # 服务输出的 token
curl -s -c jar.txt -L "$BASE/?token=$TOKEN" -o /dev/null -w '%{http_code}\n'
```

RPC 统一是同一个 RPC 通道 `POST /api/<endpoint>`，请求体：

```json
{"type":"client-request","rpcId":"any","method":"<endpoint>","payload":{"args":{"request":{...}}}}
```

- `session/create`：`{"request":{"workspaceId":"..."}}` 或 `{"request":{"cwd":"/path"}}`（二选一）
- `session/prompt`：`{"request":{"requestId":"r1","sessionId":"session-...","mode":"queue","content":[{"type":"text","text":"当前是什么系统"}]}}`
- `session/list`：`{"args":{"_request":{}}}`（注意 `_request`）
- 流式端点（`workspace/follow`、`session/follow` 等）必须走 WebSocket mux，HTTP 会报 `stream Remote methods must be opened through the stream carrier`。

workspaceId 从 `$DSH_HOME/storages/workspace.json` 取（`tables.workspaces` 的 key）；不要用插件账本 id 当内核 workspaceId。
