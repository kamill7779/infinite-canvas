# Infinite Canvas Codex Plugin

这个插件帮助 Codex App 快速打开 Infinite Canvas 网页画布。画布节点读写、创建流程与生成操作，统一使用网页内的 **Agent**（服务端编排），插件不再提供本机 Canvas MCP，也不再启动 `@basketikun/canvas-agent`。

## 安装

### AI 自动安装

把下面这段发给 Codex：

```text
请从 https://github.com/basketikun/infinite-canvas.git 安装 Infinite Canvas Codex 插件。
请 clone 仓库到 ~/plugins/infinite-canvas，确认 plugins/infinite-canvas/.codex-plugin/plugin.json 存在，
把 plugins/infinite-canvas 加入 personal marketplace，先运行 codex plugin marketplace add ~，
再运行 codex plugin add infinite-canvas@personal。
安装后请校验插件，并告诉我是否需要开启一个新对话来加载新技能。
```

### 手动安装

推荐把仓库 clone 到 Codex personal marketplace 默认会引用的位置：

```bash
mkdir -p ~/plugins
git clone https://github.com/basketikun/infinite-canvas.git ~/plugins/infinite-canvas
```

确保 `~/.agents/plugins/marketplace.json` 中有 Infinite Canvas 条目，注意 `path` 指向仓库里的插件子目录：

```json
{
  "name": "personal",
  "interface": {
    "displayName": "Personal"
  },
  "plugins": [
    {
      "name": "infinite-canvas",
      "source": {
        "source": "local",
        "path": "./plugins/infinite-canvas/plugins/infinite-canvas"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

然后注册 personal marketplace 并安装插件：

```bash
codex plugin marketplace add ~
codex plugin add infinite-canvas@personal
```

安装后建议开启一个新的 Codex 对话，让新的 skill 完整加载。

### 本仓库开发调试

如果你就在 Infinite Canvas 仓库中调试插件，可以直接添加仓库自带 marketplace。建议使用仓库绝对路径，避免 Codex 从其他工作目录解析失败：

```bash
cd /path/to/infinite-canvas
codex plugin marketplace add "$(pwd)"
codex plugin add infinite-canvas@infinite-canvas-local
```

## 使用

1. 新建 Codex 线程后说“打开 Infinite Canvas”。
2. 插件会确认当前仓库的本地画布服务是否已运行；端口被占用时会检查进程归属，不会把其他项目的 `3000` 当作 Infinite Canvas。
3. 确认或启动后，插件直接打开画布 URL（`mode=new` / `recent` / `choose`）。
4. 画布打开后，在页面右侧使用 **Agent** 面板操作画布。

常用提示：

```text
打开 Infinite Canvas
打开后用页面里的 Agent 读取当前画布并总结节点结构
根据选中节点创建一组生图提示词
```

## 打开 URL

仅使用以下 query，不要附加本机 Agent 参数：

- 新建：`<画布网页地址>/canvas?mode=new`
- 最近：`<画布网页地址>/canvas?mode=recent`
- 自选：`<画布网页地址>/canvas?mode=choose`

## 工作机制

- 插件通过 `open-canvas` / `canvas` 技能指导打开网页并引导使用页内 Agent。
- **不再提供** 本地 Canvas MCP（已移除 `.mcp.json` 与 `@basketikun/canvas-agent` 启动方式）。
- 画布 Agent 由服务端编排（`/api/agent`），工具在浏览器内执行并支持确认。

## 手动排查

优先本地启动画布：

```bash
cd web
bun install
bun run dev
```

然后直接打开：

```text
http://localhost:3000/canvas?mode=new
```

端口不是 `3000` 时，把地址换成真实本地画布地址。不要通过页面点击来新建画布；`mode=new` 会让网页自动创建具体画布。打开后使用右侧 Agent 面板即可。
