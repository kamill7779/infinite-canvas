# Canvas Agent SaaS 化实施计划（v1 + v2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `canvas-agent`（本机 Codex/Claude CLI 桥接）替换为后端编排的 SaaS Agent——后端用配置好的渠道+模型跑工具调用循环，画布工具回浏览器执行，按次计费，流式且可续跑。

**Architecture:** Agent turn 复用现有图片生成异步管线（Asynq 队列 + Redis 信号量 + `gen-events:user:{id}` WS 网关 + 信用预扣/结算）。worker 内跑一个显式状态机循环；写工具经 WS 下发、`BLPOP` 回传关联（跨实例、无 sticky）；读工具查 Redis 快照缓存零往返。上下文用「四层 + 快照单槽替换 + token 预算」管理。

**Tech Stack:** Go 1.x / Gin / GORM / Asynq / go-redis / gorilla-websocket；Next.js / React / Zustand / TypeScript。

---

## 动机

现状 `canvas-agent` 依赖用户本机安装 Codex/Claude CLI 与其额度，无法作为 SaaS 交付。但后端 LLM 底座已具备 90%：

- `service.PricingService.ResolveModel` 已能「按模型名解析渠道 + 解密 Key」（`pricing.go:106`）。
- `service.TextService` + `handler/text.go` 已实现「带 `tools`/`tool_choice` 的 chat/completions 流式代理」，且 `streamChatToResponses` 已把 `tool_calls` 按 index 累积成 function_call（`text.go:137-155`）。
- 信用预扣/结算/退点闭环齐全（`TextService.Prepare/MarkSuccess/RefundFailed`）。
- 异步管线成熟：Asynq 队列 + 用户/渠道 Redis 信号量（`consumer.go`）+ `gen-events:user:{id}` Redis→WS 网关（`realtime/hub.go`、`gen.go:383-390`）+ reconcile 兜底。

缺口只有两点：**(1) 多轮工具循环**（现有 `/text` 是单轮）；**(2) 工具执行回到浏览器的双向桥**（现有 WS 是单向）。本计划只补这两点，其余全部复用。

**为什么后端编排而非前端编排：** 画布工具全部改客户端状态、必须浏览器执行，但循环放后端可获得——可恢复（worker 崩溃 DB 重放续跑）、服务端统一控制提示词/工具/计费、v2 可把平台生成能力做成服务端工具。前端只保留「执行 + 确认」。

---

## 架构总览

### 一个 turn 的生命周期

```
浏览器 POST /api/agent/turn ──(建 user 消息 + 预扣占位 + EnqueueAgentTurn TaskID=turnId)──► Asynq「agent」队列
                                                                                              │
worker 消费（抢 sem:agent:user + sem:agent:channel 信号量）──► AgentService.RunTurn 状态机循环：
   loop step<maxSteps:
     ├ ContextBuilder.Build(system+tools+history+最新快照)  ← 四层 + token 预算
     ├ 按次预扣（GenerationRecord JobId=turnId:step，幂等）
     ├ ChatClient.Stream → 文本 delta 实时 Publish("gen-events:user:{id}") 复用 WS；末尾累积 tool_calls
     ├ 结算该步 + 落 AgentMessage（可恢复）
     ├ 无 tool_calls → publish agent.done → 收尾返回
     └ 有 tool_calls → ToolBridge 顺序执行：
           读工具 → 查 Redis agent:canvas:{sessionId} 快照，零往返
           写工具 → Publish tool_call 事件 + BLPOP agent:toolreply:{callId}（复用 WS 下发）
                     浏览器：确认(confirmTools) → 展开 ops + applyCanvasAgentOps → 重报快照
                            → POST /api/agent/tool-result → 任意 API 实例 RPUSH agent:toolreply:{callId}
           结果拼回 messages，继续下一步
```

### 复用映射（新增面极小）

| 环节 | 复用的现有实现 | 新增 |
|---|---|---|
| 队列/幂等入队 | `queue`（Asynq、TaskID 幂等）| `AgentJobData` + `agent` 队列 |
| 并发/公平 | `consumer.go` 用户/渠道信号量 | `sem:agent:*` 键 |
| 下行事件→浏览器 | `gen-events:user:{id}` + `realtime.Gateway` | 无（复用）|
| 上游调用/工具解析 | `text.go` chat 通路 | 抽成 `ChatClient` |
| 计费 | `CreditService` 预扣/结算/退点 | 按 step 幂等键 |
| 崩溃兜底 | worker reconcile 定时 | 覆盖 agent 孤儿 |
| 前端执行/确认 | `applyCanvasAgentOps` + `confirmTools/pendingTool` | 数据源切后端 WS |

### 唯一新原语：工具结果回传关联

worker 下发工具调用后 `BLPOP agent:toolreply:{callId}`（带超时）阻塞等；浏览器回传的 HTTP 落到任意 API 实例，实例 `RPUSH` 同键唤醒 worker。点对点、跨实例、无订阅竞态、超时可控。

---

## 高并发 · 性能 · 系统健康（本方案重点）

| 关注点 | 机制 | 具体取值/说明 |
|---|---|---|
| 队列隔离 | agent 独立 Asynq 队列，不与 `images` 抢占 | `Queues{images:1, agent:1}`；长 turn 不饿死生图 |
| 并发公平 | 复用用户/渠道 Redis 信号量 | `sem:agent:user:{id}` `sem:agent:channel:{id}`，上限走 config |
| worker 占用（v1 阻塞） | 写工具 `BLPOP` 含用户确认时间会占 goroutine | 有界 `AgentConfirmTimeoutSec`（默认 120s）；worker 并发按「预期并发确认数」设定；**v2 演进为挂起恢复**（见 T10 备注）不占思考时间 |
| 上下文成本/延迟 | 四层上下文 + 快照单槽替换 + token 预算 | 见「上下文管理」；把长会话 token 压掉一个数量级 |
| 上游成本 | 静态 system+tools 前缀在最前，命中 prompt cache | 多步 turn 每步复发前缀，缓存命中大幅降输入 token |
| 背压 | WS 慢消费者丢帧（`hub.go:98`），DB 为真值 | 丢的是增量 delta；终态永远在 `AgentMessage`，刷新可补偿 |
| 超时兜底 | 全链路超时 | 上游流随 ctx 取消；`BLPOP` 超时；Asynq `Timeout=30min`（非生图的 24h）；`maxSteps`（默认 24）防打转烧点 |
| 幂等/精确计费 | 三级幂等 | 入队 `TaskID=turnId`；按步 `GenerationRecord.JobId=turnId:step`；工具结果按 `callId` |
| 优雅降级 | 分类终止都如实结算 | 中途余额不足→停在当前步；上游错误→退该步、非末次 Asynq 退避；浏览器断开→`BLPOP` 超时→用已完成结果收尾 |
| DB 写放大 | 按 step 落库（非按 delta） | 每步 1~2 次写，delta 只走内存+WS |
| 可观测 | 复用 `genEventPublishFailedTotal` 风格计数 | 增 turn step 数、tokens、工具往返耗时 |

---

## 设计模式与分层

核心：把状态机做成**纯编排器**（依赖倒置），三个依赖抽成接口，循环本身不碰 HTTP/Redis 细节，可用 fake 单测。

```go
// internal/service/agent/ports.go —— 依赖倒置的三个端口
package agent

// ToolRegistry：注册表 + 策略。canvas 工具只声明 schema/kind；server 工具带 Exec。
type ToolKind int
const ( ReadCanvas ToolKind = iota; WriteCanvas; ServerExec )
type ToolSpec struct {
    Name, Description string
    Params           json.RawMessage // JSON Schema，直接喂 LLM tools
    Kind             ToolKind
    Exec             func(ctx context.Context, sess Session, args json.RawMessage) (string, error) // 仅 ServerExec
}
type ToolRegistry interface {
    Definitions() []ToolSpec           // 给 LLM 的 tools 目录
    Lookup(name string) (ToolSpec, bool)
}

// ChatClient：上游 chat/completions 适配器（包裹 text.go 通路），流式产出。
type Delta struct{ Text string; ToolCalls []ToolCall; Usage *Usage; Done bool }
type ChatClient interface {
    Stream(ctx context.Context, ch ResolvedChannel, req ChatRequest) (<-chan Delta, error)
}

// ToolBridge：写工具执行通道（WS 下发 + BLPOP 回传）。接口化以便 v2 换挂起恢复实现。
type ToolBridge interface {
    Call(ctx context.Context, userID string, call ToolCall) ToolResult
}
```

| 模式 | 落点 | 作用 |
|---|---|---|
| State Machine | `agent/loop.go` `RunTurn` | 显式步进、可恢复 |
| Registry + Strategy | `agent/tools.go` `ToolSpec` | 工具目录 + 读/写/服务端执行三态分派 |
| Adapter | `agent/llm.go` `ChatClient` | 包裹 `text.go` 上游通路，隔离 HTTP |
| Producer/Consumer | `queue`（复用）| 入队/消费解耦，天然横向扩展 |
| Repository | `repository/agent_repo.go` | `AgentSession/Message` 只走 GORM，隔离 SQL |
| Dependency Injection | `app.go` / `worker/main.go` | 与现有 `RunImageJob` 注入方式一致 |

分层遵循 `AGENTS.md`：`handler` 只解析入参/调 service/返回 `OK/Fail`；`service/agent` 放循环与业务；`repository` 只做 GORM；`model` 只定义结构。

---

## 文件结构

**新建：**
- `backend/internal/model/agent.go` — `AgentSession` / `AgentMessage`（GORM）
- `backend/internal/repository/agent_repo.go` — 会话/消息读写
- `backend/internal/service/agent/ports.go` — 三个端口接口 + 值类型
- `backend/internal/service/agent/tools.go` — 23 工具的 `ToolSpec` 注册表（含 JSON Schema）
- `backend/internal/service/agent/context.go` — `ContextBuilder` 四层上下文 + token 预算
- `backend/internal/service/agent/llm.go` — `ChatClient` 适配器（复用 text 上游）
- `backend/internal/service/agent/bridge.go` — `ToolBridge`（WS 发 + BLPOP 收）
- `backend/internal/service/agent/loop.go` — `AgentService.RunTurn` 状态机
- `backend/internal/service/agent/context_test.go`、`loop_test.go`、`tools_test.go`
- `backend/internal/queue/agent_queue.go` — `AgentJobData` + `EnqueueAgentTurn`
- `backend/internal/handler/agent.go` — `/api/agent/*` handler
- `web/src/app/(user)/canvas/utils/canvas-agent-tools.ts` — 便捷工具→ops 展开（从 `canvas-session.ts` 迁来）
- `web/src/app/(user)/canvas/utils/canvas-agent-runtime.ts` — 后端 WS 事件 → 执行/确认/回传

**修改：**
- `backend/internal/model/models.go:143` — `AllModels()` 追加两表
- `backend/internal/queue/consumer.go` — 注册 agent handler + `agent` 队列
- `backend/cmd/worker/main.go:45` — 注入 `AgentService.RunTurn`
- `backend/internal/app/app.go` — 装配 `agent` service/handler/路由
- `backend/internal/config/config.go` — 新增 agent 相关配置项
- `web/.../canvas-local-agent-panel.tsx` — 数据源从本机 `EventSource` 切平台 WS + `/api/agent/*`
- `web/.../stores/use-canvas-agent-store.ts` — 精简本机字段（url/token/workspace 等）

---

## 数据模型与迁移

### Task 1: Agent 会话/消息表

**Files:**
- Create: `backend/internal/model/agent.go`
- Modify: `backend/internal/model/models.go:143`（`AllModels` 追加）

- [ ] **Step 1: 建 model**

```go
// Package model —— Agent 会话与消息。沿用 Base 主键风格。
package model

import (
	"time"
	"gorm.io/datatypes"
)

// AgentSession 一条画布上的一个 Agent 会话（取代 Codex thread）。
type AgentSession struct {
	Base
	UserId    string `gorm:"type:text;not null;index:idx_agent_sess_user,priority:1"`
	CanvasId  string `gorm:"type:text;not null;index"`
	Title     string `gorm:"type:text;not null;default:''"`
	Model     string `gorm:"type:text;not null"` // channel::model
	Status    string `gorm:"type:text;not null;default:active;index"`
	CreatedAt time.Time `gorm:"index:idx_agent_sess_user,priority:2"`
	UpdatedAt time.Time

	User User `gorm:"foreignKey:UserId;references:Id;constraint:OnUpdate:CASCADE,OnDelete:CASCADE"`
}

// AgentMessage 会话内消息/工具事件，是对话上下文的唯一真值。
// Content 结构：{"text":...} | {"toolCalls":[...]} | {"toolCallId":...,"result":...}
type AgentMessage struct {
	Base
	SessionId string         `gorm:"type:text;not null;index:idx_agent_msg_sess,priority:1"`
	TurnId    string         `gorm:"type:text;not null;index"`
	Step      int            `gorm:"not null;default:0"`
	Role      string         `gorm:"type:text;not null"` // user/assistant/tool
	Content   datatypes.JSON `gorm:"type:jsonb;not null"`
	CreatedAt time.Time      `gorm:"index:idx_agent_msg_sess,priority:2"`

	AgentSession AgentSession `gorm:"foreignKey:SessionId;references:Id;constraint:OnUpdate:CASCADE,OnDelete:CASCADE"`
}
```

- [ ] **Step 2: 挂进 AutoMigrate**（`models.go` `AllModels()` 末尾，User 之后）

```go
	&AgentSession{},
	&AgentMessage{},
```

- [ ] **Step 3: 验证迁移**

Run: `cd backend && go run ./cmd/migrate`
Expected: 无错误，新表 `agentSession` / `agentMessage` 建成。

- [ ] **Step 4: Commit** — `git commit -m "feat(agent): add AgentSession/AgentMessage models"`

---

### Task 2: Agent 队列（复刻图片队列幂等入队）

**Files:**
- Create: `backend/internal/queue/agent_queue.go`
- Modify: `backend/internal/queue/consumer.go`

- [ ] **Step 1: 队列定义与入队**

```go
package queue

import (
	"encoding/json"
	"errors"
	"time"
	"github.com/hibiken/asynq"
)

const AgentTaskType = "agent:turn"
const AgentQueueName = "agent"

// AgentJobData 一个 turn 的执行输入（不含 Key；worker 侧解析渠道）。
type AgentJobData struct {
	TurnID     string `json:"turnId"`
	SessionID  string `json:"sessionId"`
	UserID     string `json:"userId"`
	CanvasID   string `json:"canvasId"`
	Model      string `json:"model"`
	ResumeStep int    `json:"resumeStep"`
}

const agentTaskTimeout = 30 * time.Minute // 有界，防长挂

func (p *Producer) EnqueueAgentTurn(data AgentJobData) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	task := asynq.NewTask(AgentTaskType, payload)
	_, err = p.client.Enqueue(task,
		asynq.TaskID(data.TurnID), // 入队幂等
		asynq.Queue(AgentQueueName),
		asynq.MaxRetry(3),
		asynq.Timeout(agentTaskTimeout),
	)
	if errors.Is(err, asynq.ErrTaskIDConflict) || errors.Is(err, asynq.ErrDuplicateTask) {
		return nil
	}
	return err
}
```

- [ ] **Step 2: consumer 注册 agent 队列 + handler**（`consumer.go`）

`NewConsumer` 的 `asynq.Config.Queues` 改为：

```go
	Queues: map[string]int{ImageQueueName: 1, AgentQueueName: 1},
```

新增可选 agent 执行器字段与注册方法（Open/Closed，不破坏现有签名）：

```go
// AgentRunFunc 由 cmd/worker 注入，桥接 AgentService.RunTurn。
type AgentRunFunc func(ctx context.Context, data AgentJobData, isLast bool) error

// RegisterAgent 注入 agent 执行器；未注册则不消费 agent 队列。
func (c *Consumer) RegisterAgent(run AgentRunFunc) { c.agentRun = run }
```

`Consumer` struct 加 `agentRun AgentRunFunc`；`Run()` 的 mux 增加：

```go
	if c.agentRun != nil {
		mux.HandleFunc(AgentTaskType, c.handleAgent)
	}
```

`handleAgent`（复用信号量 + isLast 语义，键换 `sem:agent:*`）：

```go
func (c *Consumer) handleAgent(ctx context.Context, t *asynq.Task) error {
	var data AgentJobData
	if err := json.Unmarshal(t.Payload(), &data); err != nil {
		return fmt.Errorf("%w: 解析 agent 任务失败 %v", asynq.SkipRetry, err)
	}
	userKey := "sem:agent:user:" + data.UserID
	taskID, _ := asynq.GetTaskID(ctx)
	if taskID == "" {
		taskID = data.TurnID
	}
	token := taskID + ":user"
	if err := waitForSlot(ctx, userKey, c.acquire, c.userLimit, token); err != nil {
		return err
	}
	defer c.release(context.Background(), userKey, token)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go c.keepalive(runCtx, map[string]string{userKey: token})

	retry, _ := asynq.GetRetryCount(ctx)
	maxRetry, _ := asynq.GetMaxRetry(ctx)
	return c.agentRun(ctx, data, retry >= maxRetry)
}
```

- [ ] **Step 3: Commit** — `git commit -m "feat(agent): add agent asynq queue + consumer handler"`

---

### Task 3: 工具注册表（Registry + Strategy，含 23 工具 Schema）

**Files:**
- Create: `backend/internal/service/agent/ports.go`, `agent/tools.go`, `agent/tools_test.go`

- [ ] **Step 1: 端口与值类型**（`ports.go`）—— 见「设计模式与分层」代码块，落盘为文件。追加值类型：

```go
type ToolCall struct{ ID, Name string; Args json.RawMessage }
type ToolResult struct{ CallID string; Content string; IsError bool }
type Usage struct{ Input, Output, Cached int }
type Session struct{ ID, UserID, CanvasID, Model string }
type ChatRequest struct{ Model string; Messages []ChatMessage; Tools []ToolSpec }
type ChatMessage struct {
	Role      string          `json:"role"`
	Content   any             `json:"content,omitempty"`
	ToolCalls []ToolCall      `json:"tool_calls,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
}
```

- [ ] **Step 2: 工具注册表**（`tools.go`）—— 从 `canvas-agent/src/schemas.ts` 逐一翻成 JSON Schema。读工具标 `ReadCanvas`，其余 `WriteCanvas`（v1 无 `ServerExec`）：

```go
package agent

import "encoding/json"

type canvasRegistry struct{ specs []ToolSpec; byName map[string]ToolSpec }

func NewCanvasRegistry() ToolRegistry {
	specs := []ToolSpec{
		{Name: "canvas_get_state", Kind: ReadCanvas, Description: "读取当前画布节点/连线/选区/视口。",
			Params: json.RawMessage(`{"type":"object","properties":{}}`)},
		{Name: "canvas_get_selection", Kind: ReadCanvas, Description: "读取选中节点。",
			Params: json.RawMessage(`{"type":"object","properties":{}}`)},
		{Name: "canvas_create_text_node", Kind: WriteCanvas, Description: "创建单个文本节点。",
			Params: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"},"title":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"}}}`)},
		{Name: "canvas_generate_image", Kind: WriteCanvas, Description: "创建图片生成流程并触发。",
			Params: json.RawMessage(`{"type":"object","properties":{"prompt":{"type":"string"},"model":{"type":"string"},"size":{"type":"string"}},"required":["prompt"]}`)},
		// … 其余 19 个按 schemas.ts 逐一补齐（apply_ops/create_node/create_config_node/
		//    create_generation_flow/generate_text|video|audio/update_node|_text/move_nodes/
		//    resize_node/delete_nodes/connect_nodes/select_nodes/set_viewport/run_generation/
		//    create_text_nodes/export_snapshot/create_image_prompt_flow）
	}
	byName := make(map[string]ToolSpec, len(specs))
	for _, s := range specs {
		byName[s.Name] = s
	}
	return &canvasRegistry{specs: specs, byName: byName}
}

func (r *canvasRegistry) Definitions() []ToolSpec { return r.specs }
func (r *canvasRegistry) Lookup(n string) (ToolSpec, bool) { s, ok := r.byName[n]; return s, ok }
```

- [ ] **Step 3: 测试注册表完整性**（`tools_test.go`）

```go
func TestCanvasRegistry_CoversAll23Tools(t *testing.T) {
	r := NewCanvasRegistry()
	if got := len(r.Definitions()); got != 23 {
		t.Fatalf("工具数 = %d, 期望 23", got)
	}
	for _, name := range []string{"canvas_get_state", "canvas_apply_ops", "canvas_generate_image"} {
		if _, ok := r.Lookup(name); !ok {
			t.Fatalf("缺工具 %s", name)
		}
	}
}
func TestCanvasRegistry_ReadToolsClassified(t *testing.T) {
	r := NewCanvasRegistry()
	s, _ := r.Lookup("canvas_get_state")
	if s.Kind != ReadCanvas {
		t.Fatalf("get_state 应为 ReadCanvas")
	}
}
```

Run: `cd backend && go test ./internal/service/agent/ -run TestCanvasRegistry -v` → PASS

- [ ] **Step 4: Commit** — `git commit -m "feat(agent): canvas tool registry (23 tools, read/write kinds)"`

---

### Task 4: 上下文管理（四层 + 快照单槽 + token 预算）

**Files:**
- Create: `backend/internal/service/agent/context.go`, `agent/context_test.go`

- [ ] **Step 1: ContextBuilder**

```go
package agent

import (
	"encoding/json"
	"strings"
)

const SystemPrompt = `你正在帮助用户操作 Infinite Canvas 网页画布。需要改动画布时优先使用工具：先 canvas_get_state 读取当前画布，再用 canvas_create_text_node / canvas_generate_image 等；复杂批量改动用 canvas_apply_ops。不要模拟鼠标点击，不要要求用户手动复制 JSON。`

type HistoryMsg struct{ Role string; Content json.RawMessage }

// ContextBuilder 组装每步 messages：四层 + 快照单槽 + token 预算。
type ContextBuilder struct{ budgetTokens int }

func NewContextBuilder(budget int) *ContextBuilder { return &ContextBuilder{budgetTokens: budget} }

// Build：system(静态,前置命中cache) → 压缩快照(单槽) → 窗口化历史。
func (b *ContextBuilder) Build(tools []ToolSpec, snapshot string, history []HistoryMsg) []ChatMessage {
	msgs := []ChatMessage{{Role: "system", Content: SystemPrompt}}
	if snapshot != "" {
		msgs = append(msgs, ChatMessage{Role: "system", Content: "当前画布(最新)：\n" + snapshot})
	}
	kept := b.window(history, b.budgetTokens-estimate(SystemPrompt)-estimate(snapshot))
	for _, h := range kept {
		msgs = append(msgs, decodeHistory(h))
	}
	return msgs
}

// window：从最新往回保留，超预算即停（旧轮次被丢弃/后续可换摘要）。
func (b *ContextBuilder) window(history []HistoryMsg, budget int) []HistoryMsg {
	total, start := 0, 0
	for i := len(history) - 1; i >= 0; i-- {
		total += estimate(string(history[i].Content))
		if total > budget {
			start = i + 1
			break
		}
	}
	return history[start:]
}

// DropStaleSnapshots：把历史里旧的 canvas_get_state 工具结果降级为占位（快照可替换不可累积）。
func DropStaleSnapshots(history []HistoryMsg) []HistoryMsg {
	lastSnap := -1
	for i, h := range history {
		if isSnapshotResult(h) {
			lastSnap = i
		}
	}
	for i := range history {
		if i != lastSnap && isSnapshotResult(history[i]) {
			history[i].Content = json.RawMessage(`{"toolCallId":"","result":"[旧画布状态已省略]"}`)
		}
	}
	return history
}

func estimate(s string) int { return len(s) / 4 } // 粗估 token，兜底
func isSnapshotResult(h HistoryMsg) bool {
	return h.Role == "tool" && strings.Contains(string(h.Content), `"nodes"`)
}
func decodeHistory(h HistoryMsg) ChatMessage { /* 反序列化 Content → ChatMessage */ return ChatMessage{} }
```

- [ ] **Step 2: 测试——快照单槽替换是核心，必须测**

```go
func TestDropStaleSnapshots_KeepsOnlyLatest(t *testing.T) {
	h := []HistoryMsg{
		{Role: "tool", Content: json.RawMessage(`{"result":"{\"nodes\":[1]}"}`)},
		{Role: "assistant", Content: json.RawMessage(`{"text":"ok"}`)},
		{Role: "tool", Content: json.RawMessage(`{"result":"{\"nodes\":[1,2]}"}`)},
	}
	got := DropStaleSnapshots(h)
	if !strings.Contains(string(got[0].Content), "已省略") {
		t.Fatalf("旧快照应被降级")
	}
	if strings.Contains(string(got[2].Content), "已省略") {
		t.Fatalf("最新快照应保留")
	}
}
func TestBuild_WindowsToBudget(t *testing.T) {
	b := NewContextBuilder(50) // 极小预算
	big := json.RawMessage(`{"text":"` + strings.Repeat("x", 400) + `"}`)
	msgs := b.Build(nil, "", []HistoryMsg{{Role: "user", Content: big}, {Role: "user", Content: json.RawMessage(`{"text":"hi"}`)}})
	if len(msgs) > 2 { // system + 至多最近一条
		t.Fatalf("超预算历史应被裁剪, got %d", len(msgs))
	}
}
```

Run: `cd backend && go test ./internal/service/agent/ -run 'TestDropStale|TestBuild' -v` → PASS

- [ ] **Step 3: Commit** — `git commit -m "feat(agent): context builder (4-layer, single-slot snapshot, token budget)"`

---

### Task 5: LLM 适配器 + 工具桥

**Files:**
- Create: `backend/internal/service/agent/llm.go`, `agent/bridge.go`

- [ ] **Step 1: ChatClient 适配器**（复用 `text.go` 的 chat body 构造 + SSE 解析，抽出复用；此处调 `{baseUrl}/v1/chat/completions`，`stream_options.include_usage=true`）

```go
package agent

// httpChatClient 复用 service.textJoinURL / responseToolsToChat 等，把 chat SSE 解析成 Delta 流。
type httpChatClient struct{ /* *http.Client */ }

func NewChatClient() ChatClient { return &httpChatClient{} }

func (c *httpChatClient) Stream(ctx context.Context, ch ResolvedChannel, req ChatRequest) (<-chan Delta, error) {
	// 1) 组 chat body：model + messages + tools(由 ToolSpec.Params 转 {type:function,function:{name,description,parameters}})
	//    + stream:true + stream_options:{include_usage:true}
	// 2) POST，Authorization: Bearer ch.ApiKey
	// 3) 扫描 SSE：content → Delta{Text}；tool_calls 按 index 累积（复刻 text.go:137-155）；
	//    usage → Delta{Usage}；[DONE] → Delta{Done:true}
	out := make(chan Delta)
	// … 实现略（与 text.go streamChatToResponses 同构，改为向 out 推 Delta）
	return out, nil
}
```

- [ ] **Step 2: ToolBridge（WS 发 + BLPOP 收）**

```go
package agent

import (
	"context"
	"encoding/json"
	"time"
	"github.com/kamill7779/infinite-canvas/backend/internal/redis"
)

type redisBridge struct {
	rc      *redis.Client
	timeout time.Duration // AgentConfirmTimeout
}

func NewToolBridge(rc *redis.Client, timeout time.Duration) ToolBridge {
	return &redisBridge{rc: rc, timeout: timeout}
}

func (b *redisBridge) Call(ctx context.Context, userID string, call ToolCall) ToolResult {
	ev, _ := json.Marshal(map[string]any{"type": "agent.tool_call", "callId": call.ID, "name": call.Name, "input": json.RawMessage(call.Args)})
	if err := b.rc.Publish(ctx, "gen-events:user:"+userID, string(ev)); err != nil {
		return ToolResult{CallID: call.ID, Content: "下发失败:" + err.Error(), IsError: true}
	}
	res, err := b.rc.Raw().BLPop(ctx, b.timeout, "agent:toolreply:"+call.ID).Result()
	if err != nil { // 超时/断线 → 转成工具错误喂回，绝不永久阻塞
		return ToolResult{CallID: call.ID, Content: "工具执行超时或客户端断开", IsError: true}
	}
	// res[1] = 浏览器回传 JSON：{result} | {error} | {declined:true}
	return parseToolReply(call.ID, res[1])
}
```

- [ ] **Step 3: Commit** — `git commit -m "feat(agent): chat client adapter + redis tool bridge (BLPOP)"`

---

### Task 6: 状态机循环 + 计费幂等（核心）

**Files:**
- Create: `backend/internal/service/agent/loop.go`, `agent/loop_test.go`
- Create: `backend/internal/repository/agent_repo.go`

- [ ] **Step 1: Repository**（只做 GORM）

```go
package repository

// AgentRepo：会话/消息读写 + 按 (turnId,step) 幂等判定。
type AgentRepo struct{}
func (AgentRepo) CreateSession(tx *gorm.DB, s *model.AgentSession) error { return tx.Create(s).Error }
func (AgentRepo) History(db *gorm.DB, sessionID string, limit int) ([]model.AgentMessage, error) { /* 按 CreatedAt 取最近 limit */ }
func (AgentRepo) AppendMessage(tx *gorm.DB, m *model.AgentMessage) error { return tx.Create(m).Error }
func (AgentRepo) StepDone(db *gorm.DB, turnID string, step int) (bool, error) { /* 存在 assistant 行即已完成 */ }
```

- [ ] **Step 2: RunTurn 状态机**（依赖三端口 + CreditService/PricingService/AgentRepo，全部注入）

```go
package agent

type AgentService struct {
	db       *gorm.DB
	credits  *service.CreditService
	pricing  *service.PricingService
	repo     repository.AgentRepo
	reg      ToolRegistry
	llm      ChatClient
	bridge   ToolBridge
	ctxb     *ContextBuilder
	snap     SnapshotStore // 读 Redis agent:canvas:{sessionId}
	maxSteps int
}

func (s *AgentService) RunTurn(ctx context.Context, in TurnInput, isLast bool) error {
	hist, err := s.repo.History(s.db, in.SessionID, 200)
	if err != nil { return err }
	msgs := toHistoryMsgs(DropStaleSnapshots(hist))

	for step := in.ResumeStep; step < s.maxSteps; step++ {
		if done, _ := s.repo.StepDone(s.db, in.TurnID, step); done {
			continue // 崩溃重放：跳过已完成步，不重复扣点
		}
		resolved, err := s.pricing.ResolveModel(in.Model, "agent", model.SizeTierStandard)
		if err != nil { return s.finalize(ctx, in, "模型未配置", true) }
		rec, err := s.preCharge(in, step, resolved) // GenerationRecord JobId=turnId:step
		if err != nil { return s.finalize(ctx, in, "点数不足，已停止", false) } // 优雅停

		snapshot := s.snap.Get(ctx, in.SessionID)
		req := ChatRequest{Model: resolved.Model, Messages: s.ctxb.Build(s.reg.Definitions(), snapshot, currentHistory(msgs)), Tools: s.reg.Definitions()}

		asst, calls, usage, err := s.consume(ctx, resolved.Channel, req, in.UserID) // 流式，delta→WS
		if err != nil {
			s.credits.RefundFailed(rec.Id, in.UserID, rec.CreditsHeld, err.Error())
			return err // 非末次 → Asynq 退避重试
		}
		s.settle(rec, usage)
		s.repo.AppendMessage(s.db, assistantRow(in, step, asst, calls))

		if len(calls) == 0 {
			return s.finalize(ctx, in, asst, false) // 收尾，publish agent.done
		}
		for _, call := range calls { // 顺序执行
			var r ToolResult
			if spec, _ := s.reg.Lookup(call.Name); spec.Kind == ReadCanvas {
				r = s.snap.Answer(ctx, in.SessionID, call) // 零往返
			} else if spec.Kind == ServerExec { // v2
				r = s.execServer(ctx, in, spec, call)
			} else {
				r = s.bridge.Call(ctx, in.UserID, call) // WS + BLPOP
			}
			s.repo.AppendMessage(s.db, toolRow(in, step, r))
			msgs = appendToolResult(msgs, call, r)
		}
	}
	return s.finalize(ctx, in, "已达最大步数", true)
}
```

- [ ] **Step 3: 循环单测（fake 三端口，验证「工具→再调→收尾」与幂等）**

```go
func TestRunTurn_ToolThenFinish(t *testing.T) {
	llm := &fakeLLM{scripted: []Delta{
		{ToolCalls: []ToolCall{{ID: "c1", Name: "canvas_create_text_node", Args: json.RawMessage(`{"text":"hi"}`)}}, Done: true},
		{Text: "已创建", Done: true},
	}}
	bridge := &fakeBridge{reply: ToolResult{CallID: "c1", Content: `{"ok":true}`}}
	svc := newTestAgentService(llm, bridge) // credits/pricing/repo 用内存 fake
	err := svc.RunTurn(context.Background(), TurnInput{TurnID: "t1", SessionID: "s1", UserID: "u1", Model: "ch::m"}, false)
	if err != nil { t.Fatal(err) }
	if bridge.calls != 1 { t.Fatalf("应下发 1 次写工具, got %d", bridge.calls) }
	if llm.calls != 2 { t.Fatalf("应调 2 次 LLM, got %d", llm.calls) }
}
func TestRunTurn_SkipsCompletedStepOnReplay(t *testing.T) { /* repo 预置 step0 已完成 → 不重复扣点 */ }
func TestRunTurn_StopsOnInsufficientCredits(t *testing.T) { /* preCharge 返错 → 停在当前步且不 panic */ }
```

Run: `cd backend && go test ./internal/service/agent/ -run TestRunTurn -v` → PASS

- [ ] **Step 4: Commit** — `git commit -m "feat(agent): RunTurn state machine + per-step credit idempotency"`

---

### Task 7: API + 装配 + worker 注入

**Files:**
- Create: `backend/internal/handler/agent.go`
- Modify: `backend/internal/app/app.go`, `backend/cmd/worker/main.go`, `backend/internal/config/config.go`

- [ ] **Step 1: config 新增项**（`config.go`）

```go
AgentMaxSteps       int // 默认 24
AgentConfirmTimeoutSec int // 默认 120
AgentContextBudgetTokens int // 默认 24000
AgentUserConcurrency int // sem:agent:user 上限，默认 2
```

- [ ] **Step 2: handler**（只解析/调 service/返回 `OK/Fail`）

```go
package handler

// POST /api/agent/turn：建 user 消息 + 预扣占位 + 入队，立即返回 turnId。
func (h *AgentHandler) Turn(c *gin.Context) {
	u := middleware.CurrentUser(c)
	var body struct{ SessionId, Prompt string; Attachments []service.AgentAttachment }
	if err := c.ShouldBindJSON(&body); err != nil || body.Prompt == "" {
		httpx.Fail(c, 400, 1, "缺少参数"); return
	}
	turnID, err := h.agent.StartTurn(u.Id, body.SessionId, body.Prompt, body.Attachments)
	if err != nil { httpx.WriteError(c, err, h.cfg.IsProd); return }
	httpx.OK(c, gin.H{"turnId": turnID})
}

// POST /api/agent/canvas-state：浏览器上报最新快照 → Redis agent:canvas:{sessionId}。
func (h *AgentHandler) CanvasState(c *gin.Context) { /* SET 键，TTL 1h */ }

// POST /api/agent/tool-result：浏览器回传工具结果 → RPUSH agent:toolreply:{callId}（唤醒 worker）。
func (h *AgentHandler) ToolResult(c *gin.Context) {
	var body struct{ CallId string; Result json.RawMessage; Error string; Declined bool }
	_ = c.ShouldBindJSON(&body)
	_ = h.rc.Raw().RPush(c, "agent:toolreply:"+body.CallId, mustJSON(body)).Err()
	_ = h.rc.Raw().Expire(c, "agent:toolreply:"+body.CallId, 2*time.Minute).Err()
	httpx.OK(c, gin.H{"ok": true})
}
```

路由（`app.go`，均挂 `authMW.RequireUser()`）：

```go
agent := api.Group("/agent", authMW.RequireUser())
agent.POST("/sessions", agentH.CreateSession)
agent.GET("/sessions", agentH.ListSessions)
agent.GET("/sessions/:id", agentH.GetSession)
agent.POST("/turn", agentH.Turn)
agent.POST("/canvas-state", agentH.CanvasState)
agent.POST("/tool-result", agentH.ToolResult)
```

- [ ] **Step 3: worker 注入**（`worker/main.go`，与 `RunImageJob` 同款 DI）

```go
agentSvc := service.NewAgentService(cfg, gdb, creditSvc, pricingSvc, rc)
consumer.RegisterAgent(func(ctx context.Context, data queue.AgentJobData, isLast bool) error {
	return agentSvc.RunTurn(ctx, service.TurnInput{
		TurnID: data.TurnID, SessionID: data.SessionID, UserID: data.UserID,
		CanvasID: data.CanvasID, Model: data.Model, ResumeStep: data.ResumeStep,
	}, isLast)
})
```

- [ ] **Step 4: 编译验证** — Run: `cd backend && go build ./...` → 无错误。
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): api handlers, routes, worker wiring"`

---

### Task 8: reconcile 覆盖 agent 孤儿

**Files:** Modify: `backend/internal/service/gen.go`（`ReconcilePending`）

- [ ] **Step 1:** 让兜底对账把「超时仍 pending/running 的 agent GenerationRecord」也退点失败化（复用现有逻辑，`Capability="agent"` 一并扫）。
- [ ] **Step 2: Commit** — `git commit -m "feat(agent): reconcile covers stuck agent turns"`

---

### Task 9: 前端——数据源切后端 WS + 工具执行/回传

**Files:**
- Create: `web/.../utils/canvas-agent-tools.ts`（便捷工具→ops 展开，迁自 `canvas-session.ts`）
- Create: `web/.../utils/canvas-agent-runtime.ts`
- Modify: `web/.../components/canvas-local-agent-panel.tsx`, `web/.../stores/use-canvas-agent-store.ts`

- [ ] **Step 1: 迁移工具展开**——把 `canvas-session.ts` 的 `callTool` 分支（便捷工具→`apply_ops`）搬成纯函数：

```ts
// canvas-agent-tools.ts
export function expandCanvasTool(name: string, input: unknown, snapshot: CanvasAgentSnapshot): CanvasAgentOp[] {
	// 复刻 canvas-session.ts：create_text_node / generate_image / move_nodes … → ops
	// 复用 nextCanvasX(snapshot) 排版
}
```

- [ ] **Step 2: runtime——收 WS 事件、执行、回传**

```ts
// canvas-agent-runtime.ts
export async function handleAgentToolCall(callId: string, name: string, input: unknown) {
	const snapshot = getCanvasSnapshot();
	if (name === "canvas_get_state" || name === "canvas_get_selection") { /* 读工具后端已答，通常不下发 */ }
	const ops = expandCanvasTool(name, input, snapshot);
	const run = () => { applyOpsToStore(ops); postCanvasState(snapshot.projectId, getCanvasSnapshot()); };
	if (useCanvasAgentStore.getState().confirmTools && isWrite(name)) {
		useCanvasAgentStore.setState({ pendingTool: { requestId: callId, name, input: { ops } } }); // 复用现有确认 UI
		return; // 确认/拒绝时再 postToolResult
	}
	run();
	await postToolResult(callId, { result: { ok: true } });
}
```

- [ ] **Step 3: 面板改造**——`canvas-local-agent-panel.tsx`：
  - 删除本机 `EventSource(${endpoint}/events)`；agent 事件改从画布页已建的平台 WS（`/api/generate/events`）分派：`agent.delta`→流式追加消息，`agent.tool_call`→`handleAgentToolCall`，`agent.done`→结束。
  - 发送改 `POST /api/agent/turn`（body `{sessionId, prompt, attachments}`）。
  - 确认/拒绝改调 `POST /api/agent/tool-result`（`{callId, result}` / `{callId, declined:true}`）。
  - store 删 `url/token/workspacePath/threads(codex)` 等本机字段。

- [ ] **Step 4: 手测闭环**——起 backend+worker+web，画布输入「创建一个写着 hello 的文本节点」，验证：WS 出现流式文本 → 确认框 → 批准后节点出现 → 消息完成。
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): frontend drives backend agent over platform WS"`

---

### Task 10: v2——生成能力作为服务端工具

**Files:** Modify: `backend/internal/service/agent/tools.go`, `agent/loop.go`（`execServer`）

- [ ] **Step 1:** 把 `canvas_generate_image|text|video|audio` 升级为 `ServerExec`：`Exec` 内**创建画布节点（经 bridge 写工具拿到 nodeId）→ 复用 `GenService` 入队平台生成（计费）→ 立即返回「已触发，nodeId=…」**，不阻塞等生成完成；结果由现有图片/文本事件流回该节点。

```go
{Name: "canvas_generate_image", Kind: ServerExec, Params: /* prompt/model/size */,
 Exec: func(ctx, sess, args) (string, error) {
	nodeID := createConfigNodeViaBridge(ctx, sess, args) // 写工具，浏览器建节点
	rec := genSvc.EnqueueForNode(sess.UserID, nodeID, args) // 复用图片队列 + 计费
	return `{"nodeId":"`+nodeID+`","status":"generating"}`, nil
 }},
```

- [ ] **Step 2:** 循环 `execServer` 分支：直接调 `spec.Exec`，结果入 messages。**不新增阻塞**（生成仍异步，健康度不受影响）。
- [ ] **Step 3: 测试**——`fakeLLM` 触发 `canvas_generate_image` → 断言 `genSvc.Enqueue` 被调且循环不阻塞等完成。
- [ ] **Step 4: Commit** — `git commit -m "feat(agent): v2 generation-as-server-tool (async, billed, non-blocking)"`

---

## 自审（Self-Review）

**规格覆盖：**
- 后端编排循环 → T6 ✅；按次计费 → T6 `preCharge` JobId=turnId:step ✅；23 画布工具 → T3 ✅；生成作为服务端工具(v2) → T10 ✅。
- 高并发/健康：队列隔离 T2 ✅、信号量 T2 ✅、有界超时 T2/T5 ✅、幂等三级 T2/T6 ✅、优雅降级 T6 ✅、reconcile T8 ✅、快照单槽 T4 ✅、prompt cache（system 前置）T4 ✅。
- 上下文管理 → T4（四层 + 单槽 + 预算 + 窗口）✅。

**占位符扫描：** `llm.go` Stream 与 `tools.go` 其余 19 工具标注为「按 text.go / schemas.ts 逐一补齐」——这是**明确的移植来源**（非模糊 TODO），执行时逐条对照翻译。

**类型一致：** `ToolCall{ID,Name,Args}` / `ToolResult{CallID,Content,IsError}` / `ToolSpec{Name,Kind,Params,Exec}` / `TurnInput{TurnID,SessionID,UserID,CanvasID,Model,ResumeStep}` 全计划统一。

**并发健康关键取舍（须知）：** v1 写工具 `BLPOP` 会占 worker goroutine 至用户确认（有界 `AgentConfirmTimeout`）。并发确认量大时，按「预期并发确认数」调 `AgentUserConcurrency` 与 worker 并发；再不够则演进为「挂起恢复」（下发工具后持久化 `ResumeStep` 释放 worker，`tool-result` 到达时重新入队续跑）——不改 schema，仅换调度，故不阻塞本计划落地。
