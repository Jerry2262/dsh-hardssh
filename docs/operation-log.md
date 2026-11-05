# SSH 操作日志

「SSH 操作日志」是侧边栏 SSH 工作区面板里的折叠调试区，用来回答一个问题：**插件刚才对服务器做了什么，为什么失败**。

## 1. 边界：只记插件的管理操作

日志只接收管理入口显式写入的记录：

| 操作名 | 触发点 |
| --- | --- |
| `host.test` | 面板的连接测试按钮 / 连接闸门的探测 |
| `workspace.browse` | 目录浏览（解析 `$HOME`、SFTP 列目录） |
| `workspace.create` | 创建工作区（`realpath`、`stat`、台账写入、主机工作区注册） |
| `sandbox.deploy` | Landlock 启动器部署（平台探测、`mkdir`、上传、`chmod`、探测、只读冒烟测试） |

会话里的执行信息不进入日志：模型调用的 `bash`、`read` / `write` / `edit`、`glob` / `grep` 属于会话轨迹，已经在对话里记录。这样做的原因有两条：

- 归属清楚：调试面板回答「插件做了什么」，不是「模型做了什么」。
- 隐私与体积：会话命令可能包含业务数据、密钥参数和大段输出，不应该再复制一份到调试面板。

实现上不在共享的 `SshEngine` 上挂全局钩子——`engine.exec` 同时被管理面和会话写文件（`chmod` / `mv`）使用；记录点放在管理入口，范围由调用点决定。

## 2. 数据模型

```ts
interface OperationRecord {
  id: string
  operation: 'host.test' | 'workspace.browse' | 'workspace.create' | 'sandbox.deploy'
  alias: string
  startedAt: number
  durationMs?: number
  status: 'running' | 'ok' | 'failed'
  error?: string          // 面向用户的失败摘要
  failureDetail?: string  // 保留的底层 cause
  steps: Array<{
    command: string       // 实际发给远端的原始命令（或 sftp 动作描述）
    exitCode: number | null
    durationMs: number
    stdoutTail?: string
    stderrTail?: string
  }>
}
```

## 3. 实现

```text
管理入口（host.test / workspace.browse / workspace.create / sandbox.deploy）
        │  begin / step / finish
        ▼
OperationLog（src/ssh/operation-log.ts）
  ├─ 环形缓冲 200 条，超出丢弃最旧并计数
  ├─ 命令上限 8 KB，输出只保留尾部 4 KB
  └─ 入库前调用 engine.redact 脱敏
        │
        ▼
GET / DELETE /api/dsh-hardssh/console（loopback-only）
        │
        ▼
面板折叠区「SSH 操作日志」
  展开时每 1 秒轮询；按操作展开看 steps；可清空
```

关键行为：

- 日志在内存中，进程重启清空，不落盘。
- 日志写入包在 try/catch 里：脱敏器或记录本身出错不影响 SSH 操作结果。
- 失败的步骤保留 exit code 与 stderr 尾部；`failureDetail` 保留包装错误的底层 cause。
- 沙箱部署失败时，面板能看到 `mkdir` 那一步的 `Permission denied`，而不是只剩一句汇总。

## 4. 面板

```text
▸ SSH 操作日志（最近 12 条）                        [清空]
  10:42:03 zen5-88 sandbox.deploy failed 820ms
    └ runner.mkdir  exit 1  12ms
      command: mkdir -p -- '/home/shixianjie/.dsh-hardssh/sandbox/...'
      stderr:  mkdir: cannot create directory ...: Permission denied
  10:41:50 zen5-88 workspace.browse ok 140ms
```

- 默认折叠，展开才开始轮询；关闭面板不产生额外请求。
- 记录按时间倒序；环形缓冲溢出时提示「较早的记录已被挤出」。
- 只在 loopback 浏览器会话可读，仍走统一的同源守卫。

## 5. 测试

- `tests/ssh/operation-log.test.ts`：环形缓冲、脱敏、截尾、失败步骤、日志自身异常的隔离。
- `tests/routes.test.ts`：`workspace.create` / `workspace.browse` 的记录与 `/console` 读取、清空。
- `tests/sandbox/remote-sandbox.test.ts`：部署失败时保留 `mkdir` 的 exit code 与 stderr。
- `tests/client/operation-log-section.test.tsx`：默认折叠不轮询、展开显示命令与 stderr、清空、读取失败提示。

## 6. 不做

- 不记录会话命令（那是会话轨迹）。
- 不落盘、不做导出、不做远程上传。
- 不做实时推送（轮询足够；引入 SSE 只会增加一层生命周期管理）。
- 不为「以后可能的多个消费者」提前抽象事件总线与 sink 接口；需要文件导出时再加。
