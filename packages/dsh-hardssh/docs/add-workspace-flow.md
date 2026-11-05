# 添加工作区流程状态机

本文件描述 `DirectoryFlow`（`src/client/directory-flow.tsx`）从点击「添加工作区」到创建成功/取消的完整状态与转换。状态名对应内部的 `choice` 以及门面自己的 busy/loading 标志；连接闸门（主机指纹、会话密码、失败提示）由 `connect-host.ts` 挂载在浏览器顶层。

## 状态

- `closed`：流程未打开（组件仍挂载，但返回 `null`）。
- `menu`：选择「本地工作区 / SSH 工作区」。
- `local-native`：把内核自己的本地目录选择弹窗按引用渲染。
- `ssh-server-picker`：选择服务器；可以同时叠加 `ssh-add-server`。
- `ssh-add-server`：填写新服务器；保存中为 `saving-host`。
- `server-gate`：点击服务器（或「浏览」）后先完成连接闸门，进入 busy/loading。
- `ssh-dir`：内核远程目录弹窗（localhost 时是内联目录视图）。
- `browsing`：非内核模式下的内联目录列表。
- `creating`：正在把选中的远端目录登记为工作区。

## 状态转换

```mermaid
stateDiagram-v2
    [*] --> closed
    closed --> menu: open
    menu --> closed: cancel
    menu --> local-native: 选择本地工作区
    local-native --> closed: 内核选中 / 取消
    menu --> ssh-server-picker: 选择 SSH 工作区
    ssh-server-picker --> closed: cancel
    ssh-server-picker --> ssh-add-server: 添加服务器
    ssh-add-server --> ssh-server-picker: 取消表单
    ssh-add-server --> saving-host: 保存
    saving-host --> ssh-add-server: 校验/保存失败(error)
    saving-host --> ssh-server-picker: 保存成功 + 刷新列表 + 登记会话密码
    ssh-server-picker --> server-gate: 点击服务器 / 浏览
    server-gate --> ssh-server-picker: 指纹/密码取消 或 连接失败
    server-gate --> ssh-dir: 连接成功(点击服务器)
    server-gate --> browsing: 连接成功(浏览按钮，非内核模式)
    ssh-dir --> ssh-dir: 列目录/进入/返回
    ssh-dir --> ssh-dir: 列目录失败(error toast)
    ssh-dir --> closed: 取消
    ssh-dir --> creating: 选中路径
    browsing --> creating: 选中路径
    creating --> closed: 创建成功(onPicked)
    creating --> ssh-dir: 创建失败(error)
    creating --> server-gate: 创建返回 NEEDS_PASSWORD / HOST_KEY_*（重试）
    server-gate --> creating: 闸门通过后重试创建
```

## 必须保持的不变量

1. **连接提示必须在最上层。** 主机指纹、会话密码、连接失败对话框统一由 `connect-host.ts` 的 `mountModal` 放进原生 `<dialog>` 顶层；否则会被服务器选择弹窗（`z-index: 100000/100001`）或内核目录弹窗（原生 `<dialog>` 顶层）盖住，表现为永远「加载中」。
2. **闸门先于目录弹窗。** 点击服务器后先 `ensureConnected`，连接通过才打开 `ssh-dir`；避免在原生目录弹窗后面弹密码/指纹。
3. **密码只输入一次。** `secretStorage: none` 不落盘，但保存服务器后要立即把表单密码登记到引擎的会话内存表；首次连接直接复用。
4. **取消要能打断。** 关闭 flow、切换分支时递增请求序号，迟到的列表/创建/闸门结果不得写回新状态。
5. **失败必须可恢复。** 闸门返回 `false` 后回到 `ssh-server-picker` 且行可用；创建失败回到目录弹窗并显示错误，不能停留在 busy。
6. **错误提示与承载弹窗同一层。** 目录弹窗内部错误走 `onError` toast；选择器错误走 `error` 区域；连接错误走顶层失败对话框。
