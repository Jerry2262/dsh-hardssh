# 来源与归属

本项目是独立项目，按自己的目标组织代码与文档。它包含来自以下项目的派生代码，相应的许可证与版权声明在此保留。

## 1. dsh-hardssh（BSD-3-Clause）

项目早期从同名上游项目 `tiphareth0/dsh-hardssh` 起步；本仓库的 `LICENSE` 保留其 BSD-3-Clause 版权声明。当前核心（工作区核心、provider 抽象、seam 路由、远端沙箱、操作日志）按本项目目标演进，上游不再作为同步对象。

```text
BSD 3-Clause License

Copyright (c) 2026, tiphareth0
All rights reserved.
```

完整条款见仓库根目录 [LICENSE](./LICENSE)。

## 2. dsh-ssh（MIT）

`src/remote/` 下的远端执行、文件、输出与环境模块端口自 [UynajGI/dsh-ssh](https://github.com/UynajGI/dsh-ssh)，包括：

- `src/remote/remote-process.ts`、`remote-subprocess.ts`、`remote-terminal.ts`
- `src/remote/remote-fs.ts`、`output.ts`、`environment.ts`

```text
MIT License

Copyright (c) 2026 dsh-ssh contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. 设计参考

`landlock-run` 启动器与远端沙箱的部署方式参考了 VS Code Remote 系列与 Landlock 官方示例的设计思路；`ssh2` 传输由上游 npm 包提供（MIT）。
