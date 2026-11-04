# 历史遗留问题（LEGACY）

> 记录自用过程中留下的命名包袱、待决策项、已接受的风险，以及踩过一次、容易再踩的坑。
> 这里只写**可核对的事实**（带文件/行号或会话证据），不写"应该没问题"这类猜测。
> 每次讨论出结论就更新对应条目状态；行为变化同步记入 `CHANGELOG.md`。
>
> 最后更新：2026-11-04

状态图例：`待决策`（等你拍板）/ `待办`（已确认要做）/ `已接受`（知道风险，暂不处理）/ `防回归`（已修复，保留原因防止重犯）/ `观察`（上游方向，暂不行动）。

## 1. `dsh-ssh` 旧命名空间（历史包袱，待决策）

**状态：待决策（改名方案已给出，等你确认）**

- **现状**：代码里有 73 处 `dsh-ssh` 字样、20 个文件，集中在三处：
  - 设置命名空间 `SSH_SETTINGS_NAMESPACE = 'dsh-ssh'`（[src/ssh/plugin.ts](packages/dsh-hardssh/src/ssh/plugin.ts) 第 25 行），设置界面用 `settings.installSection(ctx, 'dsh-ssh', …)`（同文件第 183 行）。
  - 路由前缀 `/api/dsh-ssh/*`（[src/ssh/routes.ts](packages/dsh-hardssh/src/ssh/routes.ts) 第 2、280、293 行；client 侧 [src/client/ssh/api.ts](packages/dsh-hardssh/src/client/ssh/api.ts)）。
  - 数据文件：主机配置 `~/.dsh/dsh-ssh.json`（[src/ssh/store.ts](packages/dsh-hardssh/src/ssh/store.ts) 第 20-22 行）、vault `~/.dsh/ssh-secrets/dsh-ssh-vault.json`（[src/ssh/vault.ts](packages/dsh-hardssh/src/ssh/vault.ts) 第 108-110 行）。主服务与测试服务 home 下各有一份 402 字节的 `dsh-ssh.json`（含 aliyun 主机配置，改名前必须迁移）。
- **来源**：合并前的旧 SSH 运维插件；[src/ssh/plugin.ts](packages/dsh-hardssh/src/ssh/plugin.ts) 第 23-25 行注释写明「Kept as 'dsh-ssh' so existing user settings survive the package merge unchanged」。本仓库历史里从未有过 `packages/dsh-ssh`，profile bundles 里也只有 `@tiphareth/dsh-hardssh`，`cordis.patch.yml` 没有 dsh-ssh 行。
- **与官方包重名但无关**：DSH 官方仓库确实有 [packages/ssh/ssh](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/ssh/ssh)，包名 `@deepseek-ai/dsh-ssh`（0.2.2-alpha.3，描述「Shared OpenSSH connection and versioned POSIX remote helper」），配套 `dsh-fs-ssh` / `dsh-subprocess-ssh` / `dsh-sandbox-ssh` / `ssh-helper-runtime`。它是**部署级 provider**：一个部署时固定的 OpenSSH alias，需要远端预装 helper 并校验 digest，提供 fs/subprocess/sandbox 接口，**没有模型可见的 SSH 工具、没有主机管理/工作区 UI、单连接非重连**；官方文档还说明 Web workspace 视图仍假设本地文件系统。当前安装的 DSH `0.2.1-rc.5` 依赖里没有任何 ssh 包，官方 ssh 家族属于 0.2.2-alpha 线，未进入本部署。
- **影响**：用户（和你）会把它误认成官方插件；文档/设置/报错里出现 `dsh-ssh` 时无法一眼区分是本地旧命名空间还是官方 provider 家族。
- **建议方案**（待确认）：保留 SSH 能力，只改名——
  1. 设置命名空间 `dsh-ssh` → `dsh-hardssh`（当前没有已保存的该命名空间设置，可干净切换）。
  2. 路由 `/api/dsh-ssh/*` → `/api/dsh-hardssh/ssh/*`（host/client 两侧 + 测试 + README 同步）。
  3. 主机文件 `~/.dsh/dsh-ssh.json` → `~/.dsh/dsh-hardssh-ssh.json`，vault 同理；读取时新文件不存在则从旧文件迁移，**不能丢 aliyun 配置**。
  4. 文档与 UI 文案把「dsh-ssh」替换掉，并注明与官方 `@deepseek-ai/dsh-ssh` 无关。
- **备选**：不改名，只在 README 注明两者无关；成本低，但每次看到这个名字仍要解释一遍。

## 2. 权限与沙箱遗留

**状态：待决策 / 已接受混合**

- `ssh_exec` / `ssh_cluster` 不经过 session 的权限 preset（SandboxExecutionPolicy）。它们走独立 SSH 连接，只受每主机 `commandPolicy`（护栏，不是沙箱）约束；而绑定会话里的 `bash` 走远端 Landlock（`read-only` / `workspace-write` 生效）。两套远程命令通道的权限语义不一致。**待决策**：是否把这两个工具也纳入 preset，或明确只把它们当运维通道。
- `danger-full-access` 下远端 `write` / `edit` 仍被限制在远端工作区根：`write-fence` 对 danger 放行（[src/sandbox/write-fence.ts](packages/dsh-hardssh/src/sandbox/write-fence.ts) 第 30 行），但 `RemoteFileSystem` 的 `confineRoot` 无条件拒绝根外路径（[src/remote/remote-fs.ts](packages/dsh-hardssh/src/remote/remote-fs.ts) 第 178 行，`workspace.ssh-outside-root`）。本地 danger 不限制路径，语义不一致。**待办**（优先级低）：需要独立的 unrooted 远端 fs 后端，不是改一行 fence 能解决。
- 远端 Landlock 是**部分强制**：aliyun 内核 Landlock ABI 较旧，stderr 会打印 `landlock-run: partial enforcement (older Landlock ABI)`；已接受（可见、非静默降级），但安全语义弱于完整 enforce。换主机/内核后需复测。
- arm64 `landlock-run` 资产未在真机验证过（只有 x86_64 的 aliyun + WSL 实测）。**待办**（有 ARM 主机时）。
- live SSH 用例默认跳过（需 `DSH_LIVE_SSH=1`），默认套件不覆盖真实远端；CI 也没有真实 SSH。**已接受**（默认 771 通过 + 1 skipped）。
- 0.1.x 宿主明确不支持 `hardssh-shell`：`apply()` 有前置版本检查会拒绝挂载（而不是静默降级）。自用只跑 0.2.x，**已接受**；README 兼容性说明里已写。
- `RemoteFileSystem` 的可用范围是远端工作区根（读取也受 `confineRoot` 约束，例如读 `/etc/os-release` 会被拒）；这是设计选择，不是 bug，但模型容易误以为能读任意远端路径（公告已提醒"超出工作区根的路径会被拒绝"）。**已接受**。

## 3. 工具层遗留

**状态：待决策 / 待办**

- `ssh_*` 工具失败时不是 `isError`：`failure()` 只返回文本块（[src/ssh/tools.ts](packages/dsh-hardssh/src/ssh/tools.ts) 第 53 行起），框架把工具结果标成 `isError=false`。实测：`ssh_exec` 用了工作区标题当 alias，结果 `ssh_exec failed: alias 'tmp' not found` 仍是 `isError=false`，模型可能不把它当失败处理。**待决策**：改成抛错让框架标 `isError=true`，或统一在失败文本前加显式标记。
- `remote_status` / `remote_ls` 在 SSH 绑定会话里与注入公告、bash/glob 的能力重叠（9 个工具定义共 6089 字符 ≈ 1.5k tokens；`remote_ls` 435、`remote_status` 326）。**讨论中**，当前倾向保留（诊断价值 + 非绑定会话可用），不为了 <200 tokens 改工具集/公告/测试。
- `remote_*` 与 `ssh_*` 共 9 个工具是**全局注册**：本地会话也会收到全部工具定义并占用上下文，调用了才报 `not bound`。DSH 当前没有按会话绑定状态动态注册工具的通路；如果以后上下文吃紧，这是第一个该考虑的点。**已接受**。
- 模型曾把工作区标题（如 `tmp`）当 alias 传给 `ssh_exec` → 失败。已把公告与 `remote_status` 输出改成别名优先，并在公告里写明「ssh_* 的 alias 参数用 `aliyun` 而不是标题」，终端 alias 不存在时会列出可用 alias（[src/ssh/engine.ts](packages/dsh-hardssh/src/ssh/engine.ts) 第 202-210 行）。**防回归**，测试在 `tests/workspace-guidance.test.ts`。

## 4. 已解决但容易复发的坑（防回归）

- **本地 bash 不能用隔离子 context 手动构造执行器**：第一版在 `ctx.isolate('shell')` 子 context 里 `new SandboxBashExecutor(...)`，Cordis 不解析 `inject`，本地 bash 全部报 `cannot get property "sandbox" without inject`。修复方式是用本行注入的 `ctx.sandbox.confine(...)` 后交给继承的本地执行机制。守护测试：`tests/sandbox/shell-executor.test.ts`（用真实 Cordis Context + stub provider；旧实现会失败）。
- **远端 bash 不能保留 base 的 `bash-sandbox`**：本地 bwrap 包装会被原样送到远端（远端无 bwrap → exit 127）。`cordis.patch.yml` 已 disable `bash-sandbox`，插入 `hardssh-shell`；远端改走自部署 `landlock-run`。
- **远端公告必须写明 bash 也在远端**：漏写会让模型把远端 bash 结果称作"本机"，得出「远程工作区和本地执行环境是同一台」的错误结论（2026-11-04 09:11 会话实测）。公告文案在 [src/index.ts](packages/dsh-hardssh/src/index.ts) `remoteGuidance`，测试断言在 `tests/workspace-guidance.test.ts`。
- **`ssh_list` 输出 schema 必须与 store summary 同步**：`commandPolicy` 曾只存在于 store 输出、不在工具 schema，真实会话报 `value.hosts[0].commandPolicy is not a declared property`。已补 schema（`tests/ssh/tools.test.ts` 有断言）。
- **会话日志排障别手写解码**：多帧 zstd（Node 自带只解第一帧）、cwd 编码、SSH 工作区用 anchor 而非 remoteRoot。已沉淀项目 skill `.dsh/skills/dsh-session-triage/`（新会话自动发现，含解码/摘要脚本）。
- **测试服务进程可能不在 bash 沙箱的 PID namespace 里**：`ps`/`lsof` 看不到，别据此判断服务死没死；用端口探测（`curl` 返回 401 表示活着但要鉴权）。旧 3099 进程只能由外部终端停（2026-11-04 就是用户手动停的）。
- **`/tmp` 在 bash 工具里可能是 bwrap 私有目录**：跨调用不持久，脚本产物写到仓库内（`.dsh-e2e/tmp/`、`.dsh-e2e/transcripts/`）。

## 5. 上游跟进（观察）

**状态：观察**

- 官方 `@deepseek-ai/dsh-ssh` + `dsh-fs-ssh` / `dsh-subprocess-ssh` / `dsh-sandbox-ssh` / `ssh-helper-runtime`（0.2.2-alpha 线）与我们的 seam 思路一致（都替换 fs/subprocess/sandbox 接口、都不新增模型工具），差别在：
  - 官方：单部署静态 alias、需预装 helper、无 Web workspace 集成（官方文档明说 Web workspace 视图仍假设本地文件系统）、无多主机/工作区切换、无自动部署。
  - 我们：多主机 + 动态 SSH 工作区 + Web UI + 自动部署 Landlock + `ssh_*` 运维工具 + 隧道 + commandPolicy。
- **长期可评估**：工作区路由器在选定远端后，底层是否复用官方 provider 实现（替换自研 SSH engine / launcher 部署），而不是继续维护两套。短期不动作；等上游 Web workspace 支持或官方包进入稳定版再评估。
- DSH 0.2.x 的 `ctx.shell.execute` 等 API 仍在变，跟随升级；0.1.x 已放弃，不再维护兼容。

## 6. 维护约定

- 新增条目必须写清：现象、证据（文件行号或会话 id）、影响、当前状态。
- 状态只用图例里的五个词；"已接受"的条目如果外部条件变化（换主机、升 DSH、官方发布），要重新评估。
- 讨论出结论但还没实现时，状态标 `待决策`/`待办` 并写下一步，不要提前标 `防回归`。
- 与本文件相关的验证命令：`pnpm --filter @tiphareth/dsh-hardssh typecheck`、`pnpm --filter @tiphareth/dsh-hardssh test`；真实远端用例加 `DSH_LIVE_SSH=1`。
