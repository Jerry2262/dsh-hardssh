# 历史遗留问题（LEGACY）

> 只记录**仍未解决的问题**和与问题直接相关的事实：现象、证据（文件/行号或会话 id）、影响、当前状态。
> 不记录解决方案、实施计划或"下一步做什么"；结论实施后从本文件移除，过程记入 `CHANGELOG.md`。
>
> 最后更新：2026-11-04

状态图例：`待决策`（需要你判断）/ `待办`（问题已确认、尚未消除）/ `已接受`（风险已知，暂不处理）/ `观察`（外部条件，暂不行动）。

## 1. 权限与沙箱

- **远端 Landlock 只能部分强制**（aliyun 内核 Landlock ABI 较旧）：`read-only` / `workspace-write` 在远端生效，但 stderr 会打印 `landlock-run: partial enforcement (older Landlock ABI)`，实际约束力弱于完整 enforce，且当前只在 aliyun + WSL 两台机器上观察过。**已接受**。
- **远端 subprocess seam 的覆盖范围取决于消费者**：被替换的 `ctx.subprocess` 可以让任意插件在绑定会话里 spawn 远端进程；Landlock 约束来自本插件部署的 `landlock-run` 执行器，`commandPolicy` 只是按命令名/正则拦截的护栏，绕过方式（`$(…)`、base64、脚本调用）都成立。**已接受**。
- **`danger-full-access` 下远端 `write` / `edit` 仍被限制在远端工作区根**：`write-fence` 对 danger 放行（[src/sandbox/write-fence.ts](packages/dsh-hardssh/src/sandbox/write-fence.ts) 第 30 行），但 `RemoteFileSystem.confineRoot` 无条件拒绝根外路径（[src/remote/remote-fs.ts](packages/dsh-hardssh/src/remote/remote-fs.ts) 第 178 行，`workspace.ssh-outside-root`）；本地 danger 不限制路径，两者语义不一致。**待办**（优先级低）。
- **`RemoteFileSystem` 的可用范围是远端工作区根**：读取也受 `confineRoot` 约束（例如读 `/etc/os-release` 会被拒）；模型容易误以为能读任意远端路径，公告已写明"超出工作区根的路径会被拒绝"。**已接受**。
- **arm64 `landlock-run` 资产未在真机验证过**：目前只有 x86_64 的 aliyun + WSL 实测。**待办**（缺少 ARM 主机）。
- **0.1.x 宿主不支持 `hardssh-shell`**：`apply()` 的前置版本检查会拒绝挂载，而不是降级。自用只跑 0.2.x。**已接受**。

## 2. 测试覆盖

- **live SSH 用例默认跳过**（需 `DSH_LIVE_SSH=1`）：默认套件不覆盖真实远端，CI 也没有真实 SSH；当前默认基线 667 通过 + 1 skipped，真实远端行为只靠手工会话验收。**已接受**。

## 3. DSH 版本跟随

- **依赖的公共 API 仍在变**：路由 seam 基于 `fs-sandbox` / `subprocess` / `bash-sandbox` 行与 `ctx.fs` / `ctx.subprocess` 契约，客户端依赖 slot 契约；`ctx.shell.execute` 等在 0.2.x 内也有过变动，peer 范围需要随宿主升级重新核对。**观察**。

## 4. 上游观察

- **官方 `@deepseek-ai/dsh-ssh` 家族与我们的形态不同**：官方 `dsh-ssh` + `dsh-fs-ssh` / `dsh-subprocess-ssh` / `dsh-sandbox-ssh` / `ssh-helper-runtime` 是单部署静态 alias、需预装 helper、无 Web workspace 集成（官方文档明说 Web workspace 视图仍假设本地文件系统），且 peer 依赖精确钉在对应 DSH 版本；它无法承担"一个 DSH 内多个 SSH 工作区、按会话绑定并切换"的形态。**观察**（上游 0.2.2-alpha 线）。
- npm 发布线存在 tag 差异：`latest` 为 0.1.6-alpha.1、`alpha` 为 0.2.2-alpha.3、`next` 为 0.2.1-rc.5；安装时必须按宿主版本选择而不是默认 `latest`。**观察**。

## 5. 自用环境约束

- **测试服务进程可能不在 bash 沙箱的 PID namespace 里**：`ps` / `lsof` 看不到，不能据此判断服务死活；端口探测（`curl` 返回 401 表示进程活着但需要鉴权）才可信。旧 3099 进程曾只能由外部终端停掉。**已接受**。
- **`/tmp` 在 bash 工具里可能是 bwrap 私有目录**：跨调用不持久，脚本产物需要写到仓库内（`.dsh-e2e/tmp/`、`.dsh-e2e/transcripts/`）。**已接受**。
