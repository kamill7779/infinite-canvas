// 服务端编排的画布 Agent REST 封装。统一走 /api/agent，携带 Cookie，解析 {code,data,msg}。
// WebSocket 复用生图事件网关（同一条连接也承载 image.* / ping，agent.* 事件由此下发）。
import { apiUrl } from "@/services/api/client";
import { generateEventsWsUrl } from "@/services/api/image";
import type { CanvasAgentSnapshot } from "@/app/(user)/canvas/utils/canvas-agent-ops";

export type AgentSessionStatus = string;
export type AgentSession = { id: string; canvasId: string; title: string; model: string; status: AgentSessionStatus; createdAt: string; updatedAt: string };
export type AgentMessageRole = "user" | "assistant" | "tool";
export type AgentToolCall = { callId?: string; id?: string; name: string; input?: unknown };
export type AgentMessageContent =
    | { text?: string; toolCalls?: AgentToolCall[] }
    | { toolCallId?: string; result?: unknown; isError?: boolean };
export type AgentMessage = { id: string; role: AgentMessageRole; content: AgentMessageContent; turnId?: string; step?: number; createdAt: string };
export type AgentSessionDetail = { session: AgentSession; messages: AgentMessage[] };

export type AgentDeltaEvent = { type: "agent.delta"; turnId: string; text: string };
export type AgentToolCallEvent = { type: "agent.tool_call"; callId: string; name: string; input: unknown };
export type AgentDoneEvent = { type: "agent.done"; turnId: string; status: string; message: string };
export type AgentEvent = AgentDeltaEvent | AgentToolCallEvent | AgentDoneEvent;

async function agentRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(apiUrl(path), {
        credentials: "include",
        ...init,
        headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
    });
    const payload = (await res.json().catch(() => null)) as { code?: number; data?: T | null; msg?: string } | null;
    if (!payload) throw new Error("服务器无响应");
    if (payload.code !== 0 || payload.data == null) throw new Error(payload.msg || "请求失败");
    return payload.data;
}

export async function createAgentSession(body: { canvasId: string; model: string; title?: string }): Promise<AgentSession> {
    return agentRequest<AgentSession>("/api/agent/sessions", { method: "POST", body: JSON.stringify(body) });
}

export async function listAgentSessions(canvasId: string): Promise<AgentSession[]> {
    return agentRequest<AgentSession[]>(`/api/agent/sessions?canvasId=${encodeURIComponent(canvasId)}`);
}

export async function getAgentSession(id: string): Promise<AgentSessionDetail> {
    return agentRequest<AgentSessionDetail>(`/api/agent/sessions/${encodeURIComponent(id)}`);
}

export async function startTurn(body: { sessionId: string; prompt: string }): Promise<{ turnId: string }> {
    return agentRequest<{ turnId: string }>("/api/agent/turn", { method: "POST", body: JSON.stringify(body) });
}

export async function postCanvasState(body: { sessionId: string; snapshot: CanvasAgentSnapshot }): Promise<void> {
    await fetch(apiUrl("/api/agent/canvas-state"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }).catch(() => undefined);
}

export async function postToolResult(body: { callId: string; result?: unknown; error?: string; declined?: boolean }): Promise<void> {
    await fetch(apiUrl("/api/agent/tool-result"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }).catch(() => undefined);
}

export function agentEventsWsUrl(): string {
    return generateEventsWsUrl();
}
