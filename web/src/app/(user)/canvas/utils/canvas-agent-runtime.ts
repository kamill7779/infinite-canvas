import { agentEventsWsUrl } from "@/services/api/agent";

type AgentEventHandlers = {
    onDelta: (turnId: string, text: string) => void;
    onToolCall: (callId: string, name: string, input: unknown) => void;
    onDone: (turnId: string, status: string, message: string) => void;
};

// 连接平台事件网关（与生图共用同一条 WS）。只处理 agent.* 事件，ping / image.* 忽略。
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
            if (data.type === "agent.delta") handlers.onDelta(String(data.turnId || ""), String(data.text || ""));
            else if (data.type === "agent.tool_call") handlers.onToolCall(String(data.callId || ""), String(data.name || ""), data.input);
            else if (data.type === "agent.done") handlers.onDone(String(data.turnId || ""), String(data.status || ""), String(data.message || ""));
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
