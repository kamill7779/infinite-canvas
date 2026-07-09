import { agentEventsWsUrl } from "@/services/api/agent";
import type { ImageGenEvent } from "@/services/api/image";

export type AgentEventScope = {
    /** 当前活跃会话；有值时过滤其它 session 的 agent.* */
    sessionId?: string;
    /** 当前画布；有值时过滤其它 canvas 的 agent.* */
    canvasId?: string;
};

type AgentEventHandlers = {
    onDelta: (turnId: string, text: string, meta: { sessionId: string; canvasId: string }) => void;
    onToolCall: (callId: string, name: string, input: unknown, meta: { sessionId: string; canvasId: string; turnId: string }) => void;
    onDone: (turnId: string, status: string, message: string, meta: { sessionId: string; canvasId: string }) => void;
    onImageResult?: (event: Exclude<ImageGenEvent, { type: "ping" }>) => void;
    /** 动态 scope：每次事件用最新值过滤，避免闭包过期 */
    getScope?: () => AgentEventScope;
};

/** 有 scope 时缺 sessionId/canvasId 的旧事件直接丢弃，避免滚动部署期间串扰。 */
export function matchesScope(data: Record<string, unknown>, scope: AgentEventScope): boolean {
    const sessionId = String(data.sessionId || "");
    const canvasId = String(data.canvasId || "");
    if (scope.sessionId) {
        if (!sessionId || sessionId !== scope.sessionId) return false;
    }
    if (scope.canvasId) {
        if (!canvasId || canvasId !== scope.canvasId) return false;
    }
    return true;
}

// 连接平台事件网关（与生图共用同一条 WS）。处理 agent.* 和 image.* 事件，ping 忽略。
// Cookie 同源自动鉴权；断线后短退避自动重连，返回断开函数。
export function connectAgentEvents(handlers: AgentEventHandlers): () => void {
    let socket: WebSocket | null = null;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retry = 0;

    const connect = () => {
        if (closed) return;
        const url = agentEventsWsUrl();
        if (!url) return;
        socket = new WebSocket(url);
        socket.onopen = () => {
            retry = 0;
        };
        socket.onmessage = (event) => {
            const data = parse(event.data);
            if (!data) return;
            const scope = handlers.getScope?.() || {};
            if (data.type === "agent.delta" || data.type === "agent.tool_call" || data.type === "agent.done") {
                if (!matchesScope(data, scope)) return;
            }
            const meta = { sessionId: String(data.sessionId || ""), canvasId: String(data.canvasId || ""), turnId: String(data.turnId || "") };
            if (data.type === "agent.delta") handlers.onDelta(String(data.turnId || ""), String(data.text || ""), meta);
            else if (data.type === "agent.tool_call") handlers.onToolCall(String(data.callId || ""), String(data.name || ""), data.input, meta);
            else if (data.type === "agent.done") handlers.onDone(String(data.turnId || ""), String(data.status || ""), String(data.message || ""), meta);
            else if ((data.type === "image.running" || data.type === "image.success" || data.type === "image.failed") && handlers.onImageResult) handlers.onImageResult(data as Exclude<ImageGenEvent, { type: "ping" }>);
        };
        socket.onclose = () => {
            socket = null;
            if (closed) return;
            retry = Math.min(retry + 1, 6);
            retryTimer = setTimeout(connect, Math.min(1000 * retry, 5000));
        };
        socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
        closed = true;
        if (retryTimer) clearTimeout(retryTimer);
        socket?.close();
        socket = null;
    };
}

function parse(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== "string") return null;
    try {
        const value = JSON.parse(raw);
        return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}
