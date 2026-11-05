# dsh-hardssh

把一台 SSH 主机上的目录当作 DSH（DeepSeek Harness）的原生工作区使用。绑定后，该工作区里的 `read` / `write` / `edit` / `bash` / `glob` / `grep` 全部透明地运行在远端服务器上，本地工作区行为不变。

插件只做「远端目录当本地目录用」这一件事：**一个会话绑定一个远端工作区，工作区对应一台主机**。不注册 `ssh_*` / `remote_*` 模型工具，没有多主机运维控制台、终端、隧道或集群页签；主机配置只作为工作区的连接信息存在。

## 工作原理

DSH 的文件与进程访问集中在 `ctx.fs` / `ctx.subprocess` 两个服务上。本插件通过 `cordis.patch.yml` 替换部署自带的三个行：

- `hardssh-fs`：替换 `fs-sandbox`，按会话 cwd 在本地后端与远端 `workspace.fs` capability 之间路由；
- `hardssh-subprocess`：替换 `subprocess`，远端模式走远端 `workspace.process` capability，客户端原生二进制（`pwsh` 等）仍在本机；
- `hardssh-shell`：替换 `bash-sandbox` 的 shell 执行器，远端命令经 SSH 执行，并由自动部署的 Landlock 启动器按会话权限 preset 约束。

SSH 工作区的 anchor 目录位于 `~/.dsh/workspace-anchors/<id>`（旧版为 `~/.dsh/ssh-workspaces/<id>`，现有工作区继续兼容）；会话 cwd 落在 anchor 下时即视为远端会话。所有路径按远端根收敛，symlink 逃逸 fail closed。会话的系统提示里不含任何 SSH、主机或连接配置信息：模型只看到标准工具和本会话的 cwd。

## 能力

- 主机认证：key / agent / password，passphrase 密钥，ProxyJump 跳板机；`~/.ssh/config` 作为只读来源参与解析。
- 远端目录选择与工作区创建在左侧「SSH 工作区」面板完成；工作区注册为原生 DSH 工作区。
- 远端搜索：`glob` / `grep` 直接查远端（宿主有 ripgrep 时执行同一条 rg，否则走搜索阶梯）。
- 会话可见路径一致：远端会话的运行上下文 cwd、文件策略与 `bash` 的 `pwd` 都显示远端路径；系统提示附带一句执行环境说明，客户端 `DSH_*` 元数据不会注入远端命令。
- 远端沙箱：首次连接自动上传 `landlock-run`；`read-only` / `workspace-write` preset 在远端生效。较旧内核仅部分强制并在 stderr 提示。
- 可选每主机命令守卫（`commandPolicy`）：对 `bash` 与所有 `ctx.subprocess` spawn 生效，默认不拦截。

## 安装

本项目自用，不发布 npm。在仓库根目录构建后，把包链接进 profile：

```sh
pnpm install
pnpm build

dsh plugin --profile web add link:<repo>/packages/dsh-hardssh
```

再把 `"@tiphareth/dsh-hardssh"` 加入 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，重启 `dsh web`。改代码后重新 `pnpm build` 并重启即可，无需打包。

### 桌面版（Electron）dsh

官方桌面版可以加载本插件（0.2.1-rc.5 实测：插件激活、`/api/dsh-hardssh/*` 路由、工作区注册进官方 `ctx.workspace`）。两条特殊规则：

1. **普通 CLI 不能管理 `desktop` profile**：`dsh plugin --profile desktop …` 会被拒绝。使用桌面版自带的 CLI（菜单栏「Manage dsh command」或应用内的 `resources/runtime/cli/bin/dsh.cmd`），并让应用内置的 Node/pnpm 执行。
2. **不要应用运行中启用插件**：桌面版在进程内热重载插件，DSH 当前存在热重载残留注册的已知缺陷（`Agent resolver is already registered`，之后会话报 `sessionController unavailable`）。正确做法是完全退出桌面版 → 修改 profile 与 `dsh.profile.bundles`（或用桌面版 CLI 安装）→ 冷启动。

## 兼容性

支持 DSH **0.1.5 ~ 0.2.1 及桌面版 0.2.1-rc.5**。插件静态依赖 DSH 的公共契约（`fs-sandbox` / `subprocess` / `bash-sandbox` 行、`ctx.fs` / `ctx.subprocess` 接口、客户端 slot 契约），peer 范围见 `packages/dsh-hardssh/package.json`。可选集成（`settings` / `systemPrompt` / `webServer` / 客户端 slot）缺失时降级而不是失败。

## 配置

| Key | Type | Default | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | SSH 工作区界面开关：控制工作区 CRUD 路由与工作区面板；连接配置路由、fs/subprocess seam 与连接池不受影响 |
| `secretStorage` | enum | `none` | 凭据策略：`none` = 密码不落盘、连接时输入；`vault` = AES-256-GCM + scrypt 加密存储 |
| `vaultAutoUnlock` | enum | `off` | 是否允许用 `DSH_CREDENTIAL_PASSWORD` 在加载时自动解锁 vault；默认关闭 |

示例（`cordis.patch.yml` 的 `hardssh` 行）：

```yaml
- id: hardssh
  name: dsh-hardssh
  config:
    secretStorage: none   # 或 vault
```

## 远端沙箱前置条件

- 远端为 Linux/POSIX，`bash` 可用；Landlock 启动器由插件自动上传到远端（需要可写的临时/缓存目录）。
- 内核支持 Landlock：较旧 ABI 只能部分强制，stderr 打印 `landlock-run: partial enforcement (older Landlock ABI)`。
- 插件不要求远端安装 Node/npm；项目命令使用远端自己的开发工具。

## 数据位置

- 主机配置：`~/.dsh/dsh-hardssh-ssh.json`（0600；旧 `dsh-ssh.json` 首次启动自动迁移）
- 加密凭据：`~/.dsh/ssh-secrets/dsh-hardssh-ssh-vault.json`（被 fs seam 拒绝访问）
- 工作区台账：`~/.dsh/workspaces/index.v1.json`；anchor：`~/.dsh/workspaces/anchors`、`~/.dsh/workspace-anchors/`（旧版 `~/.dsh/ssh-workspaces/` 继续兼容）
- 主机密钥信任：`~/.dsh/ssh-known-hosts.json`

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test          # 默认套件；真实 SSH 用例需 DSH_LIVE_SSH=1
pnpm build
```

默认测试基线：675 通过 + 1 skipped（live SSH opt-in）。历史遗留与待决策项见 [LEGACY.md](./LEGACY.md)，安全边界见 [SECURITY.md](./SECURITY.md)，适配手册见 [SKILLS.md](./SKILLS.md)。

## FAQ

**为什么不需要 `ssh_exec`？** 绑定会话里的 `bash` 工具本身就在远端执行；`read` / `write` / `edit` 也直接改远端文件，没有第二套工具。

**如何切换服务器？** 切换会话：每个会话绑定一个 SSH 工作区。要换机器就在面板里添加另一个工作区并新建会话。

**密码存哪里？** 默认不落盘（`secretStorage: none`，连接时输入一次，按连接存活期复用）；`vault` 模式加密存于 `~/.dsh/ssh-secrets/`，该目录被 fs seam 显式拒绝。

**为什么远端命令比本地慢？** 每次工具调用都是一次 SSH 往返；连接池会复用传输，但延迟仍取决于网络 RTT。

**能禁止 agent 在登录节点跑计算命令吗？** 可以给该主机配置 `commandPolicy`；它是护栏而非沙箱，硬限制应在服务器侧实施。

## License

MIT。SSH 传输层部分源自 [UynajGI/dsh-ssh](https://github.com/UynajGI/dsh-ssh)（MIT）。
