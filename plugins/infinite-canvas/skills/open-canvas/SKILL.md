---
name: open-canvas
description: 打开 Infinite Canvas 网页画布。用户要求打开、启动、进入、使用 Infinite Canvas 或画布时使用。
---

# Open Infinite Canvas

当用户要求打开、启动、进入或使用 Infinite Canvas 时，不要把 URL 交给用户手动复制，不要通过浏览器点击“新建画布”。直接打开带 `mode` 参数的画布 URL，让网页自动创建或选择画布。

画布内的节点读取、创建、连线、生成等操作，请引导用户使用网页内的 **Agent** 面板（服务端编排），不要启动本机 `canvas-agent`，也不要拼接 `agentUrl` / `agentToken`。

## 默认打开方式

- 新建画布：`<画布网页地址>/canvas?mode=new`
- 最近画布：`<画布网页地址>/canvas?mode=recent`
- 自己选择：`<画布网页地址>/canvas?mode=choose`

默认打开新建画布；只有用户明确要求最近画布或自己选择时，才改用对应模式。不要在 URL 中附加 `agentUrl`、`agentToken` 或其他本机 Agent 参数。

## 工作流

1. 如果当前仓库是 Infinite Canvas 项目，优先使用当前仓库的 `web/` 前端。
2. 先检查本地端口归属：如果 `3000`、`3001` 等端口已被占用，必须用进程信息确认监听进程的工作目录属于当前仓库的 `web/`，不能只因为端口存在就当成本地画布。
3. 如果已有当前仓库的 Next dev 服务，复用它并记录真实画布地址，例如 `http://localhost:3001`。
4. 如果没有当前仓库的服务，启动本地画布开发服务，默认在 `web/` 下运行 `bun run dev`；若默认端口被其他项目占用，改用空闲端口启动。不要执行构建或测试。
5. 直接打开最终 URL：`<真实画布地址>/canvas?mode=new`（或用户指定的 `recent` / `choose`）。
6. 画布打开后，提示用户在页面右侧打开 **Agent** 面板，用自然语言操作画布；不要运行 `npx @basketikun/canvas-agent`，不要连接 `127.0.0.1:17371`。

## 用户只安装插件时

- 如果当前工作区不是 Infinite Canvas 源码仓库，优先打开用户可用的画布网页地址（线上地址或用户给出的本地地址）。
- 打开后引导用户使用页内 Agent；插件本身不再提供本机 Canvas MCP。

不要要求用户手动填写 URL、token 或复制 JSON。
