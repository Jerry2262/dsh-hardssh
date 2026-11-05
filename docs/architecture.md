# 架构

本文描述 `dsh-hardssh` 的分层、组件职责与三条主要数据流。设计目标是：让绑定到远端工作区的会话在 DSH 看来与本地工作区没有区别，同时让远端执行、沙箱与连接管理各自有明确归属。

```text
┌──────────────────────────── 浏览器（GUI） ────────────────────────────┐
│ 左侧「SSH 工作区」面板：服务器行 / 工作区行 / 添加与浏览 / 操作日志   │
│ 连接闸门：主机指纹、会话密码、连接失败提示（浏览器顶层 <dialog>）      │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ loopback HTTP（/api/dsh-hardssh/*）
┌───────────────────────────────▼────────────────────────────────────────┐
│ host 进程：DSH 插件                                                    │
│                                                                        │
│  cordis.patch.yml                                                       │
│    hardssh          ← 插件主体（store / engine / workspace core / 路由）│
│    hardssh-fs       ← 替换 fs-sandbox                                  │
│    hardssh-subprocess ← 替换 subprocess                                │
│    hardssh-shell    ← 替换 bash-sandbox 的 shell 执行器                │
│                                                                        │
│  ┌──────────── 工作区核心（provider 无关） ─────────────┐               │
│  │ WorkspaceCore：ledger + registry + router + 命名空间 │               │
│  │ providers：local（本机） / ssh（远端）               │               │
│  └───────────────┬──────────────────────────────────────┘               │
│                  │ capabilities: workspace.fs / .process / .search     │
│  ┌───────────────▼──────────┐   ┌────────────────────────────────────┐ │
│  │ switch 门面               │   │ 远端实现                           │ │
│  │  switch-fs               │   │  remote-fs / remote-process        │ │
│  │  switch-subprocess       │   │  search-bridge / sftp-search       │ │
│  │  shell-executor          │   │  remote-context（模型可见一致性）  │ │
│  └───────────────┬──────────┘   └──────────────┬─────────────────────┘ │
│                  │                             │                       │
│  ┌───────────────▼─────────────────────────────▼─────────────────────┐ │
│  │ SSH 传输层：SshEngine ← ConnectionManager / SftpService /           │ │
│  │ CapabilityService；HostStore + KnownHosts + Vault（凭据）          │ │
│  └───────────────┬──────────────────────────────────────────────┬────┘ │
│                  │                                              │      │
│  ┌───────────────▼──────────────┐              ┌───────────────▼─────┐ │
│  │ RemoteSandboxProvisioner     │              │ OperationLog        │ │
│  │ 探测 + 上传 landlock-run     │              │ 管理操作日志（内存）│ │
│  └──────────────────────────────┘              └───────────┬─────────┘ │
│                                                            │ /console  │
└────────────────────────────────────────────────────────────┬───────────┘
                                                             │
                                                    ┌────────▼─────────┐
                                                    │ 侧边栏折叠区      │
                                                    └──────────────────┘
```

## 1. 分层

### 1.1 工作区核心（`src/base/*`、`src/runtime/workspace-core.ts`）

provider 无关的通用底座，不含 SSH、不含 Cordis、不含 React：

- `base/model.ts` — `WorkspaceRecord`：anchor（会话 cwd）↔ provider 位置，记录里没有密钥。
- `base/registry.ts` — provider 注册表与能力校验。
- `base/ledger.ts` / `backend.ts` — 工作区台账与对外投影存储。
- `base/router.ts` / `ledger-router.ts` — 按 anchor 或命名空间目标键解析归属工作区。
- `base/namespace.ts` — 目标键编码（只含工作区 id 与 provider 无关路径）。
- `runtime/workspace-core.ts` — DSH 侧的 `WorkspaceCore` 服务：`findByAnchor` / `openByAnchor` / `openById` / `registerProvider`，供插件与工具查询。

### 1.2 provider

- `providers/local` — 本机工作区：文件与进程能力收敛在工作区根内。
- `providers/ssh` — SSH 工作区：把 `SshEngine` / `HostStore` 包装成 provider；`provider.connectionRef.id` 是主机别名，`location.root` 是远端根。

能力契约（`base/capability.ts`）只暴露 DSH 官方类型与底座补充类型，消费方不需要按 provider 分支。

### 1.3 seam 门面

`cordis.patch.yml` 禁用部署自带的 `fs-sandbox` / `subprocess` / `bash-sandbox`，由本包提供等价门面：

- `fs.ts` + `switch/switch-fs.ts` — `ctx.fs` 按会话 cwd 路由到本地或远端 `workspace.fs`；`localRoots`（`$DSH_HOME`、`~/.agents`）与 vault 目录保持本地路由。
- `subprocess.ts` + `switch/switch-subprocess.ts` — `ctx.subprocess` 同理；客户端原生二进制留在本机。
- `shell-executor.ts` — `bash` 工具的远端执行：先确保 Landlock 启动器可用，再以 `landlock-run <grant> -- bash -c <command>` 运行；本地模式走原生本地沙箱。

### 1.4 远端实现（`src/remote/*`）

- `remote-fs.ts` — 远端文件能力：路径收敛在远端根、symlink 逃逸 fail closed、原子写用临时文件 + `chmod` + `mv`。
- `remote-process.ts` / `remote-subprocess.ts` — 远端命令句柄（`openExec`）、输出上限、超时与强制关闭。
- `search-bridge.ts` / `sftp-search.ts` — `glob` / `grep`：宿主有 ripgrep 就跑同一条 argv，否则走搜索阶梯并用 SFTP 代答。
- `environment.ts` — 远端环境探测与缓存；远端命令的 `DSH_*` 元数据剥离。
- `remote-context.ts` — 模型可见一致性：把 anchor 路径翻译成远端路径、注入一句远端执行说明。

### 1.5 SSH 传输层（`src/ssh/*`）

- `engine.ts` — 对外门面：`exec` / `openExec` / SFTP 方法 / 终端 / 能力探测；含凭据泄漏脱敏。
- `connection/manager.ts`、`pool.ts`、`lease.ts` — 连接池、生成号、失效与租约。
- `sftp/service.ts`、`capabilities/service.ts` — SFTP 与远端能力探测。
- `store.ts`、`known-hosts.ts`、`vault.ts`（`ssh/` 下）— 主机配置、TOFU、加密凭据。
- `command-policy.ts` — 可选每主机命令守卫。

### 1.6 远端沙箱（`src/sandbox/*`）

- `remote-sandbox.ts` — 探测平台 → 解析 `$HOME` → 上传 `landlock-run` → 功能探测 + 只读拒绝冒烟测试；结果按主机缓存，失败不缓存。探测失败时补一次诊断命令，把 kernel 版本、LSM 列表、启动参数 `lsm=` 与 `CONFIG_SECURITY_LANDLOCK` 编译状态写进错误与操作日志；不满足条件即拒绝，没有无沙箱降级路径。
- `landlock.ts` — 内置启动器资产（按架构与哈希区分）。
- `write-fence.ts` — 本地写入边界。

### 1.7 操作日志（`src/ssh/operation-log.ts`）

只由管理入口写入：连接测试、目录浏览、工作区创建、沙箱部署。记录原始命令、退出码、stderr 尾部，内存环形缓冲，重启清空。会话工具不经过它。详见 [operation-log.md](./operation-log.md)。

### 1.8 HTTP 与客户端

- `src/host-http.ts` — 统一的 loopback + 同源守卫、JSON 读写。
- `src/ssh/routes.ts` — 主机 CRUD、导入 ssh config、known-hosts、vault、会话密码、健康、连接测试、远端列举。
- `src/routes.ts` — 工作区 CRUD、远端目录浏览/新建、启动补偿、`/console`。
- `src/client/*` — 侧边栏面板、添加工作区流程、连接闸门、操作日志、侧边栏徽标与文件路径重映射。

## 2. 三条数据流

### 2.1 文件（`read` / `write` / `edit` / `cat` 类工具）

```text
工具 → ctx.fs → switch-fs 按 cwd 判定
                        ├─ 本地工作区 → providers/local
                        └─ 远端工作区 → providers/ssh → remote-fs → SftpService → SFTP
```

远端路径先解析并收敛到 `location.root`；越界与 symlink 逃逸直接拒绝。

### 2.2 命令（`bash`）

```text
工具 → ctx.shell → shell-executor
                        ├─ 本地世界 → 原生本地沙箱执行
                        └─ 远端世界 → RemoteSandboxProvisioner.ensure(alias)
                                        → landlock-run <grant> -- bash -c <command>
                                        → 远端 subprocess → openExec → SSH exec
```

连接池复用同一条传输；每次执行带服务端预算，超时会同时终止远端进程。

### 2.3 搜索（`glob` / `grep`）

```text
工具 → ctx.fs 搜索接口 → search-bridge
                              ├─ 宿主有 ripgrep → 同一条 rg argv 远端执行
                              └─ 无 ripgrep → 搜索阶梯（SFTP 遍历 + glob 匹配）
```

输出投影成 ripgrep 的形状，工具层无需感知后端差异。

## 3. 会话与工作区绑定

1. 面板创建远端工作区时，先在远端做 `realpath` + `stat` 校验，再确保 Landlock 启动器可用，最后写入台账并注册为原生 DSH 工作区。
2. anchor 目录（`~/.dsh/workspace-anchors/<id>`）是会话 cwd 的占位；每次工具调用只带 cwd，不带会话身份。
3. 路由按 cwd 与 anchor 做最长匹配：命中远端工作区就走远端能力，未命中即本地。
4. 模型请求发送前，`remote-context.ts` 把 anchor 路径翻译成远端路径，保证模型看到的 cwd 与 `bash pwd` 一致。

## 4. 错误边界

- 连接与认证错误（`NEEDS_PASSWORD` / `HOST_KEY_UNKNOWN` / `HOST_KEY_MISMATCH`）由闸门在浏览器顶层处理，不会被面板或目录弹窗遮挡。
- 远端沙箱不可用是**硬拒绝**：不会降级为无约束执行。
- 管理操作的完整失败信息进入操作日志；面向用户的消息保留可读摘要，详细信息可在日志中展开。
- 会话里的失败属于会话轨迹，由工具结果直接呈现。

## 5. 扩展点

- **新 provider**：实现 `WorkspaceProvider` 并 `ctx.workspaceCore.registerProvider()`；seam 与工具层无需改动。
- **其他插件适配**：所有文件/进程访问走 `ctx.fs` / `ctx.subprocess` 即可自动获得远端路由；详见 [adaptation.md](./adaptation.md)。
- **新增管理操作日志**：在管理入口调用 `OperationLog.begin/step/finish`，不要挂到共享的 `SshEngine` 上。
