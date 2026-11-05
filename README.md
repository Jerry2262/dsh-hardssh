# dsh-hardssh

把一台 SSH 主机上的目录当作 DSH（DeepSeek Harness）的原生工作区使用。绑定后，该工作区里的 `read` / `write` / `edit` / `bash` / `glob` / `grep` 全部透明地运行在远端服务器上，本地工作区行为不变。

这是一个独立项目：它不注册第二套远端工具，也不提供多主机运维界面，只把「远端目录当本地目录用」这件事做完整。

## 项目定位

- **一个会话绑定一个远端工作区**，工作区对应一台主机。切换服务器靠切换会话，面板里没有服务器下拉框。
- **模型只看到标准工具**。没有 `ssh_*` / `remote_*` 工具；连接配置、别名、凭据不进入会话上下文。
- **等价物是 VS Code Remote-SSH 的编辑体验**：模型的工作目录、`pwd`、文件路径都显示同一套远端路径，操作落在远端。
- **本地会话与原生 DSH 一致**：seam 只在绑定工作区的会话里改道，其他会话继续走部署自带的本地实现。

不提供：多主机批量执行、集群、隧道、SFTP 传输页、远端终端页签、`ssh_exec` 类工具。

## 工作原理

DSH 的文件与进程访问集中在 `ctx.fs` / `ctx.subprocess` 两个服务上。插件通过 `cordis.patch.yml` 替换部署自带的三个行：

- `hardssh-fs`：替换 `fs-sandbox`，按会话 cwd 在本地后端与远端 `workspace.fs` 能力之间路由；
- `hardssh-subprocess`：替换 `subprocess`，远端模式走远端 `workspace.process` 能力，客户端原生二进制（`pwsh` 等）仍在本机；
- `hardssh-shell`：替换 `bash-sandbox` 的 shell 执行器，远端命令经 SSH 执行，并由自动部署的 Landlock 启动器按会话权限 preset 约束。

工作区的 anchor 目录位于 `~/.dsh/workspace-anchors/<id>`（旧版 `~/.dsh/ssh-workspaces/<id>` 仍可识别）；会话 cwd 落在 anchor 下时即视为远端会话。所有路径按远端根收敛，symlink 逃逸 fail closed。

模型可见路径与实际执行位置保持一致：远端会话的运行上下文 cwd、文件策略与 `bash` 的 `pwd` 都显示远端路径；系统提示附带一句执行环境说明，客户端 `DSH_*` 元数据不会注入远端命令。详细分层见 [docs/architecture.md](./docs/architecture.md)。

## 能力

- 主机认证：key / agent / password，passphrase 密钥，ProxyJump 跳板机；`~/.ssh/config` 作为只读来源参与解析。
- 远端目录选择与工作区创建在左侧「SSH 工作区」面板完成；工作区注册为原生 DSH 工作区，出现在侧边栏并可直接开会话。
- 远端搜索：`glob` / `grep` 直接查远端（宿主有 ripgrep 时执行同一条 rg，否则走搜索阶梯）。
- 远端沙箱：首次连接自动上传 `landlock-run`；`read-only` / `workspace-write` preset 在远端生效。较旧内核仅部分强制并在 stderr 提示。
- 连接闸门：主机指纹确认、会话密码输入、连接失败提示集中在最上层，避免被目录弹窗或面板遮挡。
- SSH 操作日志：面板内折叠区，只记录插件自己的管理操作（连接测试、目录浏览、工作区创建、沙箱部署）；展开后是一条按时间顺序持续输出的终端式信息流，打印原始命令、输出、退出码和 stderr，新内容追加在底部并自动跟随。会话里的命令不进入该日志。见 [docs/operation-log.md](./docs/operation-log.md)。
- 可选每主机命令守卫（`commandPolicy`）：对 `bash` 与所有 `ctx.subprocess` spawn 生效，默认不拦截；它是护栏，不是沙箱。

## 安装

本项目自用，不发布 npm。在仓库根目录构建后，把包链接进 profile：

```sh
pnpm install
pnpm build

dsh plugin --profile web add link:<repo>/packages/dsh-hardssh
```

再把 `"@jerry/dsh-hardssh"` 加入 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，重启 `dsh web`。改代码后重新 `pnpm build` 并重启即可，无需打包。

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
  name: '@jerry/dsh-hardssh'
  config:
    secretStorage: none   # 或 vault
```

## 远端沙箱前置条件

- 远端为 Linux/POSIX，`bash` 可用；Landlock 启动器由插件自动上传到远端的 `$HOME/.dsh-hardssh`。
- 内核支持 Landlock：较旧 ABI 只能部分强制，stderr 打印 `landlock-run: partial enforcement (older Landlock ABI)`。
- 插件不要求远端安装 Node/npm；项目命令使用远端自己的开发工具。
- 探测失败时错误信息会带上远端内核版本与已启用的 LSM 列表，便于判断是内核过旧、未编译 Landlock，还是启动时未启用。插件不提供无沙箱降级：不满足前置条件时直接拒绝创建/执行。

## 数据位置

- 主机配置：`~/.dsh/dsh-hardssh-ssh.json`（0600）
- 加密凭据：`~/.dsh/ssh-secrets/dsh-hardssh-ssh-vault.json`（被 fs seam 拒绝访问）
- 工作区台账：`~/.dsh/workspaces/index.v1.json`；anchor：`~/.dsh/workspaces/anchors`、`~/.dsh/workspace-anchors/`（旧版 `~/.dsh/ssh-workspaces/` 继续兼容）
- 主机密钥信任：`~/.dsh/ssh-known-hosts.json`
- 操作日志：仅内存，重启清空，不落盘

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test          # 默认套件；真实 SSH 用例需 DSH_LIVE_SSH=1
pnpm build
```

默认测试基线：698 通过 + 1 skipped（live SSH opt-in）。设计决策与已知限制见 [docs/decisions.md](./docs/decisions.md)，安全边界见 [SECURITY.md](./SECURITY.md)，插件适配手册见 [docs/adaptation.md](./docs/adaptation.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](./docs/architecture.md) | 分层架构、组件职责、三条数据流（文件 / 命令 / 搜索） |
| [docs/workspace-flow.md](./docs/workspace-flow.md) | 「添加工作区」完整状态机与不变量 |
| [docs/operation-log.md](./docs/operation-log.md) | SSH 操作日志的边界、数据模型与接入点 |
| [docs/decisions.md](./docs/decisions.md) | 设计决策、已知限制与待决项 |
| [docs/adaptation.md](./docs/adaptation.md) | 把其他 DSH 插件适配到远端工作区的执行手册 |
| [CHANGELOG.md](./CHANGELOG.md) | 变更记录 |
| [ATTRIBUTION.md](./ATTRIBUTION.md) | 第三方代码与设计来源 |

## FAQ

**为什么不需要 `ssh_exec`？** 绑定会话里的 `bash` 工具本身就在远端执行；`read` / `write` / `edit` 也直接改远端文件，没有第二套工具。

**如何切换服务器？** 切换会话：每个会话绑定一个 SSH 工作区。要换机器就在面板里添加另一个工作区并新建会话。

**密码存哪里？** 默认不落盘（`secretStorage: none`，连接时输入一次，按连接存活期复用）；`vault` 模式加密存于 `~/.dsh/ssh-secrets/`，该目录被 fs seam 显式拒绝。

**为什么远端命令比本地慢？** 每次工具调用都是一次 SSH 往返；连接池会复用传输，但延迟仍取决于网络 RTT。

**能禁止 agent 在登录节点跑计算命令吗？** 可以给该主机配置 `commandPolicy`；它是护栏而非沙箱，硬限制应在服务器侧实施。

**为什么面板里看不到会话里执行的命令？** 那部分属于会话轨迹，已经在对话里完整记录。操作日志只收插件自己的管理操作，两类信息不混在一起。

## 来源与许可

本项目以 BSD-3-Clause 发布，`LICENSE` 保留上游版权声明；SSH 传输层部分端口自 [UynajGI/dsh-ssh](https://github.com/UynajGI/dsh-ssh)（MIT）。完整归属见 [ATTRIBUTION.md](./ATTRIBUTION.md)。
