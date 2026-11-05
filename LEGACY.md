# 历史遗留问题（LEGACY）

> 本文档是**待解决问题队列**，不是“已接受风险”清单。问题最终都要解决，记录在这里只为两件事：
> 1. 发现问题的速度大于解决速度，不记下来会在会话中遗忘；
> 2. 执行注意力集中在主线上，不因为途中发现一个问题就立刻分心。
>
> 已解决的问题从本文件删除，处理过程记入 `CHANGELOG.md`；不存在“已接受 / 不处理”状态。
>
> 最后更新：2026-11-04

状态图例：`待处理`（已确认、排队解决）/ `待决策`（需要先确定方向）/ `等待外部条件`（依赖宿主升级、硬件或上游变化，条件满足后回到待处理）。

## 1. 权限与沙箱

- **远端 Landlock 只能部分强制**：aliyun 内核 Landlock ABI 较旧，`read-only` / `workspace-write` 虽在远端生效，但 stderr 打印 `landlock-run: partial enforcement (older Landlock ABI)`，实际约束力弱于完整 enforce，目前只在 aliyun + WSL 两台机器上观察过。影响：远端写入隔离强度低于插件声明。**待决策**。
- **远端 subprocess seam 可以绕过 `commandPolicy`**：被替换的 `ctx.subprocess` 允许任意插件在绑定会话里 spawn 远端进程；`commandPolicy` 只按命令名/正则拦截，`$(…)`、base64、脚本调用都能绕过。影响：登录节点限制不是硬边界。**待处理**。
- **`danger-full-access` 下远端 `write` / `edit` 仍被限制在远端工作区根**：`write-fence` 对 danger 放行（[src/sandbox/write-fence.ts](packages/dsh-hardssh/src/sandbox/write-fence.ts) 第 30 行），但 `RemoteFileSystem.confineRoot` 无条件拒绝根外路径（[src/remote/remote-fs.ts](packages/dsh-hardssh/src/remote/remote-fs.ts) 第 178 行，`workspace.ssh-outside-root`）；本地 danger 不限制路径。影响：同一权限模式下本地/远端语义不一致。**待处理**。
- **`RemoteFileSystem` 的读取范围也受工作区根限制**：读 `/etc/os-release` 这类根外路径会被拒，而模型没有收到这一限制的提示，可能反复尝试。影响：多轮无效操作。**待处理**。
- **远端会话仍能读取控制端的 DSH 基础设施目录**：`localRoots`（`$DSH_HOME`、`~/.agents`，见 [src/fs.ts](packages/dsh-hardssh/src/fs.ts)）对远端绑定会话仍按本地路由，模型可以用 `read` / `glob` / `grep` 读取技能、profile、会话日志、`dsh-hardssh-ssh.json` 等控制端文件；vault 目录被显式拒绝。影响：本地 DSH 配置暴露给远端会话模型，且与“控制端元数据不在执行环境”的前置说明并存，模型仍可能发现本地/远端分裂。**待决策**（是否对远端会话关闭 `localRoots` 的本地读，或把这层例外也前置说明）。
- **Windows 客户端原生工具在远端会话中仍本地执行**：`src/switch/switch-subprocess.ts` 把 `pwsh` / `powershell` / `cmd` / `*.exe` 视为 client tool，绑定远端工作区时仍在本机 spawn。影响：远端会话并非完全隔离于本地机器，模型可通过这些工具读本机信息。**待决策**。
- **arm64 `landlock-run` 资产未在真机验证**：目前只有 x86_64 的 aliyun + WSL 实测。**等待外部条件**（ARM 主机）。

## 2. 测试覆盖

- **真实 SSH 不在默认套件或 CI 中**：live SSH 用例默认跳过（需 `DSH_LIVE_SSH=1`），默认 682 通过 + 1 skipped；真实远端行为只靠手工会话验收。影响：远端回归可能逃过测试。**待处理**。

## 3. 宿主升级适配

- **依赖的公共契约仍在变**：路由 seam 基于 `fs-sandbox` / `subprocess` / `bash-sandbox` 行与 `ctx.fs` / `ctx.subprocess` 契约，客户端依赖 slot 契约；`ctx.shell.execute` 等在 0.2.x 内也有过变动。影响：DSH 升级可能破坏挂载或行为。**待处理**。
- **模型可见路径重写依赖宿主内部方法**：公开 `llm/stream` waterfall 的 options 已被 deepFreeze，当前通过包装 LLM runtime 内部的 `streamWithRegistration` 把 anchor 路径翻译成远端路径。该方法改名或签名变化时包装 fail open，运行上下文 cwd 与 `bash pwd` 的不一致会重新暴露。影响：升级后可能出现模型注意力问题回归。**待处理**。

## 4. 产品与架构决策

- **同一个 DSH 进程内无法用纯路径区分本地与远端会话**：DSH 的 fs/subprocess 调用只带 cwd、不带 session/workspace 身份；远端工作区内部仍使用本地 anchor。影响：做不到让内核工作区路径本身等于远端绝对路径。**待决策**（是否投入宿主级 workspace/provider 感知路径改造）。
