# 历史遗留问题（LEGACY）

> 记录自用过程中留下的命名包袱、待决策项、已接受的风险，以及踩过一次、容易再踩的坑。
> 这里只写**可核对的事实**（带文件/行号或会话证据），不写"应该没问题"这类猜测。
> 每次讨论出结论就更新对应条目状态；行为变化同步记入 `CHANGELOG.md`。
>
> 最后更新：2026-11-04

状态图例：`待决策`（等你拍板）/ `待办`（已确认要做）/ `已接受`（知道风险，暂不处理）/ `防回归`（已修复，保留原因防止重犯）/ `观察`（上游方向，暂不行动）。

## 1. `dsh-ssh` 旧命名空间（已解决，防回归）

**状态：防回归（2026-11-04 完成改名；旧的 `dsh-ssh` 标识已从代码/文档/数据路径移除）**

- **曾经的问题**：设置命名空间、路由前缀、数据文件名都叫 `dsh-ssh`，来自合并前的旧 SSH 运维插件（[src/ssh/plugin.ts](packages/dsh-hardssh/src/ssh/plugin.ts) 历史注释「Kept as 'dsh-ssh' so existing user settings survive the package merge unchanged」）；而 DSH 官方仓库确实有 [packages/ssh/ssh](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/ssh/ssh)，包名就是 `@deepseek-ai/dsh-ssh`（0.2.2-alpha.3，部署级 OpenSSH provider family，配套 fs-ssh / subprocess-ssh / sandbox-ssh / ssh-helper-runtime，没有模型工具、没有 UI、单连接静态配置）。两者无关却同名，容易误认。
- **现在的名字**：
  - 设置命名空间：`dsh-hardssh`。
  - 路由：`/api/dsh-hardssh/ssh/*`（host/client 共用 `SSH_API_BASE` 常量）。
  - 主机配置：`~/.dsh/dsh-hardssh-ssh.json`；vault：`~/.dsh/ssh-secrets/dsh-hardssh-ssh-vault.json`。
  - 客户端 locale 命名空间 `dsh-hardssh-ssh`；system-prompt section `plugin:dsh-hardssh-ssh`；DOM id/name 与临时暂存目录同步改名。
- **迁移**：`HostStore` / `Vault` 在默认路径构造时各调一次 `migrateLegacyStoreFile` / `migrateLegacyVaultFile`：新文件已存在或旧文件不存在则不动；否则 tmp + rename 写入新路径（0600，目录 0700），成功后才删除旧文件（中断时源文件保留）。旧的 `~/.dsh/dsh-ssh.json`、`dsh-ssh-vault.json` 首次加载后自动消失，主机配置（aliyun）不丢。测试：`tests/ssh/legacy-migration.test.ts`。
- **注意**：只有迁移辅助函数和对应测试里还允许出现旧文件名（作为源路径）；其他新代码不得再引入 `dsh-ssh`。官方包名 `@deepseek-ai/dsh-ssh` 只允许出现在文档的对比说明里。

## 2. 权限与沙箱遗留

**状态：待决策 / 已接受混合**

- SSH 绑定会话里的 `bash` 走远端 Landlock（`read-only` / `workspace-write` 生效）；但远端 subprocess seam 本身可被其它插件消费，Landlock 是否覆盖取决于远端执行器本身（本插件自动部署的 `landlock-run` 覆盖 routed bash/子进程路径）。`commandPolicy` 只是护栏，不是沙箱。**已接受**。
- `danger-full-access` 下远端 `write` / `edit` 仍被限制在远端工作区根：`write-fence` 对 danger 放行（[src/sandbox/write-fence.ts](packages/dsh-hardssh/src/sandbox/write-fence.ts) 第 30 行），但 `RemoteFileSystem` 的 `confineRoot` 无条件拒绝根外路径（[src/remote/remote-fs.ts](packages/dsh-hardssh/src/remote/remote-fs.ts) 第 178 行，`workspace.ssh-outside-root`）。本地 danger 不限制路径，语义不一致。**待办**（优先级低）：需要独立的 unrooted 远端 fs 后端，不是改一行 fence 能解决。
- 远端 Landlock 是**部分强制**：aliyun 内核 Landlock ABI 较旧，stderr 会打印 `landlock-run: partial enforcement (older Landlock ABI)`；已接受（可见、非静默降级），但安全语义弱于完整 enforce。换主机/内核后需复测。
- arm64 `landlock-run` 资产未在真机验证过（只有 x86_64 的 aliyun + WSL 实测）。**待办**（有 ARM 主机时）。
- live SSH 用例默认跳过（需 `DSH_LIVE_SSH=1`），默认套件不覆盖真实远端；CI 也没有真实 SSH。**已接受**（默认 667 通过 + 1 skipped）。
- 0.1.x 宿主明确不支持 `hardssh-shell`：`apply()` 有前置版本检查会拒绝挂载（而不是静默降级）。自用只跑 0.2.x，**已接受**；README 兼容性说明里已写。
- `RemoteFileSystem` 的可用范围是远端工作区根（读取也受 `confineRoot` 约束，例如读 `/etc/os-release` 会被拒）；这是设计选择，不是 bug，但模型容易误以为能读任意远端路径（公告已提醒"超出工作区根的路径会被拒绝"）。**已接受**。

## 3. 工具层遗留（已随 ops 能力移除）

**状态：已解决（2026-11-04 删除多主机 SSH 运维面）**

- 6 个 `ssh_*` 工具（list/exec/upload/download/tunnel/cluster）与 3 个 `remote_*` 工具（status/ls/search）全部删除，不再全局注册、不再注入 SSH 运维公告，ops 路由/UI（终端、传输、隧道、集群、运维 Tab）同步删除。核心只保留「一个工作区 = 一台主机」的透明路由，模型看到的仍是原生 read/write/edit/bash/glob/grep。
- 因此原先的工具层问题（失败不标 `isError`、9 个工具占上下文、标题 vs alias、跨主机感知）不再存在；相关测试删除，新增 `tests/ssh/plugin.test.ts` 断言只挂载连接配置路由、不注册 terminal upgrade，`tests/workspace-guidance.test.ts` 断言公告不含 `ssh_*`/`remote_*` 工具名。
- 新的边界：连接配置仍需要最小主机 CRUD + 凭据/TOFU/目录浏览路由，这是工作区创建的必要面，不对 agent 暴露工具。

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
