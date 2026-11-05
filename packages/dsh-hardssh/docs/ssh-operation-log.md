# SSH 操作日志：当前实现与目标设计对照

本文用组件图和时序图对比两件事：

1. **当前实现**：管理面操作和会话执行如何共用 `SshEngine`，错误如何一层层包装到 UI。
2. **目标设计**：操作级日志如何只记录插件自己的管理操作，同时不碰会话执行信息。

相关代码：`src/ssh/engine.ts`、`src/routes.ts`、`src/ssh/routes.ts`、`src/sandbox/remote-sandbox.ts`、`src/shell-executor.ts`、`src/remote/remote-process.ts`、`src/remote/remote-fs.ts`、`src/client/directory-flow.tsx`、`src/client/workspace-panel.tsx`。

## 1. 当前实现

### 1.1 组件与调用路径

```text
                         ┌─────────────────────────────────┐
                         │          DSH Web GUI             │
                         │  SSH 工作区面板                  │
                         │  （服务器/工作区管理，无操作日志）│
                         └───────────────┬─────────────────┘
                                         │ loopback HTTP
┌────────────────────────────────────────▼────────────────────────────────┐
│                        dsh-hardssh 插件（host 进程）                     │
│                                                                          │
│  管理面                                                                  │
│  ┌──────────────────────────────┐                                        │
│  │ routes.ts / ssh/routes.ts    │                                        │
│  │  host test / ls / ws create  │                                        │
│  └───────┬──────────────┬───────┘                                        │
│          │              │                                                │
│          │              └──────> RemoteSandboxProvisioner.ensure()       │
│          │                              │ execOk("mkdir ...")            │
│          │                              │ engine.upload(runner)          │
│          ▼                              ▼                                │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ SshEngine                                                          │  │
│  │  exec / upload / ls / realpaths / stat / readFile / writeFile ...  │  │
│  │  ConnectionManager（连接池、认证、主机指纹）                        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│          ▲                              ▲                                │
│          │                              │                                │
│  会话面  │                              │                                │
│  ┌───────┴──────────────┐   ┌───────────┴────────────────────────────┐  │
│  │ bash 工具             │   │ read/write/edit/glob/grep             │  │
│  │ ctx.shell             │   │ ctx.fs（SwitchFileSystem）             │  │
│  │  └─ RemoteBashExecutor│   │  └─ RemoteFileSystem                   │  │
│  │      ├─ sandbox.ensure│   │      ├─ engine.readFile/writeFile/ls   │  │
│  │      └─ remote subproc│   │      ├─ engine.lstat/stat              │  │
│  │          └─ openExec  │   │      └─ engine.exec（chmod/mv 原子写）  │  │
│  └───────────────────────┘   └───────────────────────────────────────┘  │
│                                                                          │
│  观测：console.warn（client 连接失败）+ HTTP 错误字符串 + 会话轨迹         │
└──────────────────────────────────────────────────────────────────────────┘
```

共享点：

- 管理面和会话面共用同一个 `SshEngine`、连接池、主机指纹与认证。
- `RemoteSandboxProvisioner.ensure()` 既被**创建工作区路由**调用（[routes.ts](../src/routes.ts)），也被**会话 bash 执行器**调用（[shell-executor.ts](../src/shell-executor.ts)）；它内部的命令没有来源标记。
- 会话写文件时，`RemoteFileSystem` 也会调用 `engine.exec` 做 `chmod` / `mv`；所以不能把日志全局挂在 `engine.exec` 上。

### 1.2 当前管理面时序（以目录浏览和创建工作区为例）

```text
用户        GUI                Route                Provisioner        SshEngine        远端
 │ 浏览目录   │                   │                     │                 │              │
 │──────────>│ GET /ws/dir       │                     │                 │              │
 │           │──────────────────>│ engine.exec($HOME)  │                 │              │
 │           │                   │────────────────────────────────────>│              │
 │           │                   │                     │                 │──exec───────>│
 │           │                   │ engine.ls(path)     │                 │              │
 │           │                   │────────────────────────────────────>│              │
 │           │                   │                     │                 │──SFTP───────>│
 │           │<──────────────────│ {entries} / {error} │                 │              │
 │           │                   │                     │                 │              │
 │ 创建       │ POST /ws         │                     │                 │              │
 │──────────>│──────────────────>│ realpaths/stat      │                 │              │
 │           │                   │────────────────────────────────────>│              │
 │           │                   │ sandbox.ensure()    │                 │              │
 │           │                   │────────────────────>│ uname/$HOME     │              │
 │           │                   │                     │────────────────>│──exec───────>│
 │           │                   │                     │ mkdir/upload    │              │
 │           │                   │                     │────────────────>│──exec/SFTP──>│
 │           │                   │ workspace.create    │                 │              │
 │           │<──────────────────│ 成功 / {error}      │                 │              │
```

### 1.3 当前会话面时序

```text
模型/工具      DSH seam            远端后端                SshEngine         远端
 bash ───────> ctx.shell ────────> RemoteBashExecutor ──> openExec ───────> SSH
                                   └─ sandbox.ensure() ──> exec/upload ───> SSH
 read/write ─> ctx.fs ───────────> RemoteFileSystem ────> readFile/ls/stat> SSH
 glob/grep ──> ctx.fs search ────> search bridge ───────> openExec/exec ──> SSH

这些调用只写入会话自己的轨迹；当前没有任何“操作日志”记录它们。
```

### 1.4 当前错误传播路径（用户看到的“封装一层”）

```text
远端 mkdir: Permission denied
        │
        ▼
execOk() 组装：
  "remote sandbox: runner directory creation failed on 'zen5-88':
   mkdir: cannot create directory '/home/shixianjie/.dsh-hardssh': Permission denied"
        │
        ▼
RemoteSandboxError(message, code, status)
        │
        ▼
route writeRouteError() → HTTP JSON { error: <消息> }
        │
        ▼
client readJson() 抛 Error → 目录流程 error 区域 / toast
```

问题：UI 只剩最终消息，原始命令、执行阶段、退出码和完整 stderr 没有结构化记录；排查只能靠猜或改代码加日志。会话轨迹记录的是会话工具调用，不适合承担“插件管理操作”的调试。

## 2. 目标设计

### 2.1 组件与边界

```text
                         ┌─────────────────────────────────┐
                         │          DSH Web GUI             │
                         │  SSH 工作区面板                  │
                         │  └─ 折叠区「SSH 操作日志」       │
                         └───────────────┬─────────────────┘
                                         │ GET /api/dsh-hardssh/ssh/console
┌────────────────────────────────────────▼────────────────────────────────┐
│                        dsh-hardssh 插件（host 进程）                     │
│                                                                          │
│  管理面                                     会话面（保持原样）             │
│  ┌──────────────────────────┐              ┌─────────────────────────┐  │
│  │ host.test                │              │ bash → ctx.shell        │  │
│  │ workspace.browse         │              │ read/write/edit         │  │
│  │ workspace.create         │              │ glob/grep               │  │
│  │ sandbox.deploy           │              └────────────┬────────────┘  │
│  └──────────┬───────────────┘                           │               │
│             │ OperationRunner.run({operation, alias,    │ DSH seams     │
│             │   trigger})                              │               │
│             ├───────────────┐                           │               │
│             ▼               ▼                           ▼               │
│  ┌────────────────┐  ┌───────────────────────┐  ┌────────────────────┐  │
│  │ OperationEvent │  │ SshGateway             │  │ SshEngine          │  │
│  │ Bus            │  │  exec/ls/upload        │  │ openExec/SFTP/exec │  │
│  └───────┬────────┘  └──────────┬────────────┘  └────────────────────┘  │
│          │                      │                                       │
│          ▼                      └──────────────> SshEngine              │
│  ┌────────────────┐                                                     │
│  │ MemoryRing     │  （内存环形缓冲、脱敏、截断）                        │
│  └───────┬────────┘                                                     │
│          │                                                              │
│          ▼                                                              │
│  /api/dsh-hardssh/ssh/console（loopback-only）                          │
└──────────────────────────────────────────────────────────────────────────┘
```

关键变化：

- 管理面通过 `OperationRunner` 进入网关；网关负责记录操作内的 `exec/ls/upload` 步骤。
- `SshEngine` 依旧不依赖日志；会话面直接使用引擎，**不经过 OperationRunner**。
- `sandbox.ensure()` 有两个触发源：创建工作区和会话首次执行。它属于插件基础设施操作，仍然记录，但带 `trigger` 字段区分来源；会话执行的 bash 命令本身不记录。

### 2.2 目标管理面时序

```text
用户        GUI                Route             OperationRunner      SshGateway       SshEngine
 │ 创建       │                   │                    │                  │                │
 │──────────>│ POST /ws          │                    │                  │                │
 │           │──────────────────>│ run(sandbox.deploy)│                  │                │
 │           │                   │───────────────────>│ begin(event)     │                │
 │           │                   │                    │ exec(uname/$HOME)│                │
 │           │                   │                    │─────────────────>│───────────────>│
 │           │                   │                    │ exec(mkdir...)   │                │
 │           │                   │                    │─────────────────>│───────────────>│
 │           │                   │                    │<── stderr/exit ──│<───────────────│
 │           │                   │                    │ end(failed,      │                │
 │           │                   │                    │   failure+steps) │                │
 │           │                   │<───────────────────│                  │                │
 │           │<──────────────────│ {error, opId}      │                  │                │
 │ 打开日志   │                   │                    │                  │                │
 │──────────>│ GET /console      │                    │                  │                │
 │           │<──────────────────│ 事件列表 + 原始命令 + stderr           │                │
```

### 2.3 目标会话面时序

```text
模型/工具      DSH seam            远端后端               SshEngine         远端
 bash ───────> ctx.shell ────────> shell executor ─────> openExec ───────> SSH
 read/write ─> ctx.fs ───────────> RemoteFileSystem ───> SFTP/exec ──────> SSH
 glob/grep ──> ctx.fs search ────> search bridge ──────> openExec/exec ──> SSH

（不经过 OperationRunner；会话轨迹继续由 session 记录）
```

### 2.4 事件模型

```ts
interface OperationEvent {
  id: string
  operation:
    | 'host.test'
    | 'workspace.browse'
    | 'workspace.create'
    | 'workspace.delete'
    | 'sandbox.deploy'
  alias: string
  trigger?: 'gui' | 'workspace.create' | 'session.exec'
  phase: 'start' | 'end'
  status?: 'ok' | 'failed' | 'cancelled'
  startedAt: number
  durationMs?: number
  failure?: {
    code: string
    message: string
    detail?: string
    stderrTail?: string
  }
  steps: Array<{
    command: string
    exitCode: number | null
    durationMs: number
    stdoutTail?: string
    stderrTail?: string
  }>
}
```

### 2.5 面板形态

```text
┌─ SSH 工作区 ──────────────────────────────────────────────┐
│  aliyun  ● connected                                      │
│    tmp  /home/jerry/tmp                                   │
│                                                          │
│  zen5-88 ○ disconnected                                  │
│                                                          │
│  [ + 添加服务器 ]                                        │
│                                                          │
│  ▸ SSH 操作日志（最近 12 条）                  [清空]     │
│    ┌──────────────────────────────────────────────────┐  │
│    │ 10:42:03 zen5-88 sandbox.deploy  failed  820ms   │  │
│    │   └ runner.mkdir  exit 1                         │  │
│    │     command: mkdir -p -- /home/...               │  │
│    │     stderr:  Permission denied                   │  │
│    └──────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## 3. 对比

| 维度 | 当前实现 | 目标设计 |
|---|---|---|
| 管理操作记录 | 无 | 操作级事件，含步骤、命令、退出码、stderr |
| 会话执行信息 | 只进会话轨迹 | 保持只进会话轨迹，不混入 |
| 日志挂载点 | 无 | OperationRunner / SshGateway（管理面） |
| `SshEngine` | 同时服务两种调用方 | 仍是纯传输层，不依赖日志 |
| 错误详情 | 逐层包装成字符串 | 结构化 failure + 原始命令/stderr |
| 定位故障 | 改代码加日志 | 面板按服务器/操作展开查看 |
| 存储 | 无 | 内存环形缓冲，脱敏、截断、不落盘 |
| UI | 无 | SSH 工作区面板内折叠区 |

## 4. 最小实现顺序

1. `OperationEvent` 类型 + `MemoryRingBuffer` + 脱敏/截断工具。
2. `OperationRunner` + `SshGateway`，先接入 `sandbox.deploy`、`workspace.browse`、`host.test`。
3. loopback-only `/console` 读取/清空路由。
4. 工作区面板折叠区：轮询、按服务器过滤、展开原始命令、清空。
5. 回归测试：只记录管理面操作、会话路径不产生事件、失败保留 stderr、缓冲有界。
