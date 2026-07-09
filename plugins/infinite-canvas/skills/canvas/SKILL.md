---
name: canvas
description: 引导用户通过 Infinite Canvas 网页内 Agent 操作画布，读取节点、创建内容、整理生成流程。
---

# Infinite Canvas

你正在帮助用户操作 Infinite Canvas 网页画布。当前画布操作统一走网页内 **Agent**（服务端编排），不再使用本机 `canvas-agent` MCP。

## 工作流

- 如果用户还没有打开网页画布，使用 `open-canvas` 技能打开 Infinite Canvas（仅 `mode=new|recent|choose`）。
- 打开后引导用户在右侧 **Agent** 面板用自然语言完成读写画布、创建节点、连线、触发生成等操作。
- 不要运行 `npx @basketikun/canvas-agent`，不要连接 `127.0.0.1:17371`，不要拼接 `agentUrl` / `agentToken`。
- 不要模拟鼠标点击，不要要求用户手动复制 JSON、token 或 URL。
- 写入画布的操作可能由网页侧边栏做工具确认，提示用户按界面确认即可。

## 风格

- 页面文案和画布节点内容默认使用中文。
- 生成节点、配置节点和提示词节点要保持结构清晰，方便用户继续编辑。
- 批量创建节点时注意给节点留出间距，不要堆叠在同一个位置。
- 图片、视频、音频等媒体节点默认保留原始比例；只有用户明确要求自由变形时才改变比例。
- 生成流程尽量少而清楚，优先让用户一眼能看懂节点关系。
