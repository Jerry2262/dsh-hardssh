# dsh-hardssh — 把远端目录当作 DSH 工作区

已适配 DSH **0.1.5 ~ 0.2.1，含官方桌面版（Electron）**。在 DSH Web GUI 里把一台 SSH 主机上的目录添加为原生工作区；在该工作区的会话中，`read` / `write` / `edit` / `bash` / `glob` / `grep` 全部透明地作用于远端目录，用法与本地工作区一致。远端 `bash` 由自动部署的 Landlock 启动器按会话权限 preset 约束。

本插件只做这一件事：**一个会话 = 一个远端工作区 = 一台主机**。它不注册任何 `ssh_*` / `remote_*` 模型工具，也不提供多主机运维控制台。主机配置只在「创建工作区」时作为连接信息使用。

## 核心优势

- **对插件和工具零改动**：`cordis.patch.yml` 禁用部署自带的 `fs-sandbox` / `subprocess` 行，由本包的 `hardssh-fs` / `hardssh-subprocess` / `hardssh-shell` 提供路由门面。任何走标准 `ctx.fs` / `ctx.subprocess` 的插件与标准工具，在 SSH 工作区会话里自动运行在远端；本地会话不受影响。
- **单一共享实例**：`HostStore` + `SshEngine`（ssh2 连接池）在 `src/index.ts` 创建一次；主机配置变更会失效相关连接。
- **会话绑定通过 cwd**：SSH 工作区的 anchor 在 `~/.dsh/workspace-anchors/<id>`（旧版 `~/.dsh/ssh-workspaces/<id>` 继续兼容），`SwitchFileSystem` / 路由门面按会话 cwd 判断是否路由到远端；`workspace.fs` / `workspace.process` capability 负责实际远端 I/O。会话系统提示不含 SSH/主机/连接信息。
- **远端搜索**：`glob` / `grep` 在绑定会话里直接查远端（宿主机有 ripgrep 时执行同一条 rg；否则走搜索阶梯），不会把本机结果冒充服务器内容。
- **会话路径一致**：远端会话的运行上下文 cwd、文件策略与 `bash` 的 `pwd` 都显示远端路径；系统提示附带一句执行环境说明，客户端 `DSH_*` 元数据不会注入远端命令。
- **远端沙箱**：首次连接时自动上传 `landlock-run` 启动器；`read-only` / `workspace-write` preset 在远端生效（较旧内核为 partial enforcement，stderr 可见）。
- **公开入口**：`@tiphareth/dsh-hardssh/base`（通用底座）、`@tiphareth/dsh-hardssh/workspace`（平台无关类型面）。

## 界面入口

- **左侧「SSH 工作区」面板**：唯一的管理面。添加/编辑/删除服务器连接，添加/删除远端工作区，显示连接徽章；不提供终端、隧道、集群等运维页签。
- **目录选择器**：新建 SSH 工作区时浏览远端目录。
- **右上角无 SSH 运维 Tab**：终端/传输/隧道/集群界面已随 ops 能力一起移除。

## 主机命令守卫（可选，默认不拦截）

面向「登录节点禁止直接计算」这类主机策略：给某台主机配置 `commandPolicy` 后，在该主机的会话里执行 `bash`（以及任何经 `ctx.subprocess` 的 spawn）会先检查禁止命令名/正则，命中时拦下并显示提示。配置写在 `~/.dsh/dsh-hardssh-ssh.json` 的单台主机条目里，也可以在「新建/编辑服务器」对话框里填。它是护栏，不是沙箱；真正的硬限制应放在服务器侧（Slurm、pam 等）。

## 原生工具在绑定会话里的行为

| 工具 | 行为 |
|---|---|
| `read` / `write` / `edit` | 走远端 SFTP；路径用远端绝对路径，相对路径以远端根为基准；保留沙箱写入围栏与版本守卫 |
| `bash` | 在远端以 `bash -c` 执行；远端 Landlock 按 preset 约束写入 |
| `glob` / `grep` | 查远端：有 rg 时同一条 argv，否则搜索阶梯代答 |
| `pwsh` / `powershell` / `cmd` | 客户端原生二进制，在本机执行 |

## 安装

```sh
pnpm --filter @tiphareth/dsh-hardssh build

dsh plugin --profile web add link:<repo>/packages/dsh-hardssh
```

再把 `"@tiphareth/dsh-hardssh"` 加入 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，重启 `dsh web`。桌面版（Electron）需要**完全退出后冷启动**，不要在应用运行中启用（原因见根目录 README）。

## 数据目录

- 主机配置：`~/.dsh/dsh-hardssh-ssh.json`（0600；旧 `dsh-ssh.json` 首次启动自动迁移）
- 加密凭据（`secretStorage: vault`）：`~/.dsh/ssh-secrets/dsh-hardssh-ssh-vault.json`
- 工作区台账与 anchor：`~/.dsh/workspaces/index.v1.json`、`~/.dsh/workspaces/anchors`、`~/.dsh/workspace-anchors/`（旧版 `ssh-workspaces/` 继续兼容）
- 主机密钥信任：`~/.dsh/ssh-known-hosts.json`

## 安全模型

- `/api/dsh-hardssh/*` 与 `/api/dsh-hardssh/ssh/*` 仅限 loopback（含同源校验）；启动器上传等路径同样走该边界。
- 远端路径必须落在工作区远端根内；symlink 逃逸 fail closed。
- vault 目录被 `SwitchFileSystem.deniedRoots` 显式拒绝。
- 远端沙箱依赖对方内核 Landlock ABI；较旧内核只能部分强制，stderr 会打印提示，不会静默降级。
- 凭据默认不落盘；`vault` 模式加密存储，`DSH_CREDENTIAL_PASSWORD` 自动解锁默认关闭。

## 开发

```sh
pnpm typecheck
pnpm test        # 默认套件；真实 SSH 用例需 DSH_LIVE_SSH=1
pnpm build
```

测试基线：679 通过 + 1 skipped（live SSH opt-in）。项目历史与遗留问题见仓库根目录 [LEGACY.md](../../LEGACY.md)。

## License

MIT。SSH 传输层部分源自 [UynajGI/dsh-ssh](https://github.com/UynajGI/dsh-ssh)（MIT）。
