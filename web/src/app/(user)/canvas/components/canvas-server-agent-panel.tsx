"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App, Button } from "antd";
import { History, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { motion } from "motion/react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useAuthStore } from "@/stores/use-auth-store";
import * as agentApi from "@/services/api/agent";
import type { AgentMessage, AgentSession } from "@/services/api/agent";
import type { ImageGenEvent } from "@/services/api/image";
import { useCanvasAgentStore, type AgentAttachment, type AgentChatItem, type AgentPendingToolCall } from "../stores/use-canvas-agent-store";
import { summarizeCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops";
import type { CanvasNodeMetadata } from "../types";
import { expandCanvasTool } from "../utils/canvas-agent-tools";
import { connectAgentEvents } from "../utils/canvas-agent-runtime";
import { AgentChatComposer, AgentChatMessage, AgentPanelTabs, AgentPendingToolCard, AgentWorkingMessage, type CanvasAgentChatAttachment } from "./canvas-agent-chat-ui";

const PANEL_MOTION_SECONDS = 0.5;

export function CanvasServerAgentPanel({ snapshot, canUndoOps, collapsed, embedded, onApplyOps, onUndoOps }: { snapshot: CanvasAgentSnapshot; canUndoOps: boolean; collapsed?: boolean; embedded?: boolean; onApplyOps: (ops: CanvasAgentOp[]) => unknown; onUndoOps: () => CanvasAgentSnapshot | null }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const effectiveConfig = useEffectiveConfig();
    const { message } = App.useApp();
    const { width, prompt, sending, waiting, messages, sessions, activeSessionId, activeTab, confirmTools, pendingTool, setAgentState, addMessage: pushMessage } = useCanvasAgentStore();
    const [resizing, setResizing] = useState(false);
    const [loadingSessions, setLoadingSessions] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const snapshotRef = useRef(snapshot);
    const confirmToolsRef = useRef(confirmTools);
    const pendingToolRef = useRef<AgentPendingToolCall | null>(null);
    const onApplyOpsRef = useRef(onApplyOps);
    const activeSessionIdRef = useRef(activeSessionId);
    const modelRef = useRef(effectiveConfig.textModel || effectiveConfig.model);
    const startedRef = useRef(false);

    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);
    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);
    useEffect(() => {
        pendingToolRef.current = pendingTool;
    }, [pendingTool]);
    useEffect(() => {
        onApplyOpsRef.current = onApplyOps;
    }, [onApplyOps]);
    useEffect(() => {
        activeSessionIdRef.current = activeSessionId;
    }, [activeSessionId]);
    useEffect(() => {
        modelRef.current = effectiveConfig.textModel || effectiveConfig.model;
    }, [effectiveConfig.model, effectiveConfig.textModel]);
    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }, [messages, pendingTool, waiting]);

    const loadSession = useCallback(async (sessionId: string) => {
        if (!sessionId) return;
        try {
            const detail = await agentApi.getAgentSession(sessionId);
            setAgentState({ messages: historyToChatItems(detail.messages) });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取会话失败");
        }
    }, [message, setAgentState]);

    const loadSessions = useCallback(async () => {
        const canvasId = snapshotRef.current.projectId;
        if (!canvasId) return;
        setLoadingSessions(true);
        try {
            const list = await agentApi.listAgentSessions(canvasId);
            setAgentState({ sessions: list });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取会话列表失败");
        } finally {
            setLoadingSessions(false);
        }
    }, [message, setAgentState]);

    const applyToolCall = useCallback(async (callId: string, ops: CanvasAgentOp[]) => {
        setAgentState({ activity: "执行画布操作", waiting: true });
        const next = onApplyOpsRef.current(ops) as CanvasAgentSnapshot;
        addMessage({ role: "tool", title: "画布操作完成", text: summarizeCanvasAgentOps(ops) || "画布操作", detail: { callId, ops } });
        await agentApi.postToolResult({ callId, result: { ok: true, applied: ops.length } });
        if (activeSessionIdRef.current) await agentApi.postCanvasState({ sessionId: activeSessionIdRef.current, snapshot: next });
    }, [setAgentState]);

    const handleToolCall = useCallback(async (callId: string, name: string, input: unknown) => {
        const ops = expandCanvasTool(name, input, snapshotRef.current);
        // Server-synthesized internal ops (e.g. image node placement) bypass the confirm gate.
        if (callId.startsWith("gen-")) {
            try {
                await applyToolCall(callId, ops);
            } catch (error) {
                await agentApi.postToolResult({ callId, error: error instanceof Error ? error.message : "画布操作失败" });
            }
            return;
        }
        if (confirmToolsRef.current) {
            if (pendingToolRef.current) {
                await agentApi.postToolResult({ callId, error: "仍有待确认的画布工具调用" });
                return;
            }
            const next: AgentPendingToolCall = { requestId: callId, name, input: { ops } };
            pendingToolRef.current = next;
            setAgentState({ pendingTool: next, activity: "等待确认", waiting: false });
            return;
        }
        try {
            await applyToolCall(callId, ops);
        } catch (error) {
            await agentApi.postToolResult({ callId, error: error instanceof Error ? error.message : "画布操作失败" });
        }
    }, [applyToolCall, setAgentState]);

    const handleDelta = useCallback((turnId: string, text: string) => {
        if (!text) return;
        addMessage({ role: "assistant", title: "Agent", text, streamId: turnId });
    }, []);

    const handleDone = useCallback((_turnId: string, status: string, doneMessage: string) => {
        if (status === "error" && doneMessage) addMessage({ role: "error", title: "错误", text: doneMessage });
        setAgentState({ activity: status === "error" ? "出错" : "完成", waiting: false, sending: false });
    }, [setAgentState]);

    const handleImageResult = useCallback((event: Exclude<ImageGenEvent, { type: "ping" }>) => {
        const nodeId = event.clientRequestId;
        if (!nodeId || !activeSessionIdRef.current) return;
        let metadata: CanvasNodeMetadata;
        if (event.type === "image.success") {
            metadata = { content: event.images?.[0]?.url, status: "success", errorDetails: undefined };
            if (typeof event.balance === "number") useAuthStore.getState().setBalance(event.balance);
        } else if (event.type === "image.failed") {
            metadata = { status: "error", errorDetails: event.errorMsg };
            if (typeof event.balance === "number") useAuthStore.getState().setBalance(event.balance);
        } else {
            metadata = { status: "loading" };
        }
        const ops: CanvasAgentOp[] = [{ type: "update_node", id: nodeId, metadata }];
        const next = onApplyOpsRef.current(ops) as CanvasAgentSnapshot;
        void agentApi.postCanvasState({ sessionId: activeSessionIdRef.current, snapshot: next });
    }, []);

    // 建会话 + 起 WS + 拉历史。snapshot.projectId 变更时重来。
    useEffect(() => {
        if (startedRef.current) return;
        const canvasId = snapshot.projectId;
        if (!canvasId) return;
        startedRef.current = true;
        let disconnect: (() => void) | null = null;
        let cancelled = false;
        (async () => {
            try {
                const list = await agentApi.listAgentSessions(canvasId);
                const session = list[0] || (await agentApi.createAgentSession({ canvasId, model: modelRef.current }));
                if (cancelled) return;
                setAgentState({ sessions: list.length ? list : [session], activeSessionId: session.id, connected: true, activity: "已连接" });
                activeSessionIdRef.current = session.id;
                await loadSession(session.id);
                await agentApi.postCanvasState({ sessionId: session.id, snapshot: snapshotRef.current });
            } catch (error) {
                if (!cancelled) message.error(error instanceof Error ? error.message : "连接画布 Agent 失败");
                setAgentState({ connected: false, activity: "连接失败" });
            }
        })();
        disconnect = connectAgentEvents({ onDelta: handleDelta, onToolCall: handleToolCall, onDone: handleDone, onImageResult: handleImageResult });
        return () => {
            cancelled = true;
            startedRef.current = false;
            disconnect?.();
            setAgentState({ connected: false });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snapshot.projectId]);

    // 画布变化时防抖上报快照，供 Agent 读工具使用。
    useEffect(() => {
        const sessionId = activeSessionId;
        if (!sessionId) return;
        const timer = setTimeout(() => void agentApi.postCanvasState({ sessionId, snapshot }), 300);
        return () => clearTimeout(timer);
    }, [activeSessionId, snapshot]);

    const sendPrompt = async () => {
        const text = prompt.trim();
        const sessionId = activeSessionId;
        if (!sessionId || !text || sending || waiting) return;
        setAgentState({ activity: "发送中", sending: true, waiting: true });
        addMessage({ role: "user", text });
        try {
            await agentApi.startTurn({ sessionId, prompt: text });
            setAgentState({ prompt: "" });
        } catch (error) {
            setAgentState({ activity: "发送失败", waiting: false });
            addMessage({ role: "error", title: "发送失败", text: error instanceof Error ? error.message : "发送失败" });
        } finally {
            setAgentState({ sending: false });
        }
    };

    const approvePendingTool = async () => {
        const tool = pendingTool;
        if (!tool) return;
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
        try {
            await applyToolCall(tool.requestId, tool.input?.ops || []);
        } catch (error) {
            addMessage({ role: "tool", title: "工具失败", text: error instanceof Error ? error.message : "画布操作失败", detail: tool });
            await agentApi.postToolResult({ callId: tool.requestId, error: error instanceof Error ? error.message : "画布操作失败" });
        }
    };

    const rejectPendingTool = async () => {
        const tool = pendingTool;
        if (!tool) return;
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null, activity: "已取消", waiting: false });
        addMessage({ role: "tool", title: "拒绝执行", text: summarizeCanvasAgentOps(tool.input?.ops || []) || tool.name, detail: { callId: tool.requestId, name: tool.name } });
        await agentApi.postToolResult({ callId: tool.requestId, declined: true });
    };

    const startNewSession = async () => {
        const canvasId = snapshotRef.current.projectId;
        if (!canvasId) return;
        setLoadingSessions(true);
        try {
            const session = await agentApi.createAgentSession({ canvasId, model: modelRef.current });
            activeSessionIdRef.current = session.id;
            setAgentState({ sessions: [session, ...sessions], activeSessionId: session.id, messages: [], pendingTool: null, activeTab: "chat", activity: "新对话" });
            await agentApi.postCanvasState({ sessionId: session.id, snapshot: snapshotRef.current });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "新建会话失败");
        } finally {
            setLoadingSessions(false);
        }
    };

    const openSession = async (session: AgentSession) => {
        activeSessionIdRef.current = session.id;
        setAgentState({ activeSessionId: session.id, pendingTool: null, activeTab: "chat" });
        await loadSession(session.id);
        await agentApi.postCanvasState({ sessionId: session.id, snapshot: snapshotRef.current });
    };

    const undoLastTool = () => {
        const restored = onUndoOps();
        if (!restored) return;
        setAgentState({ activity: "已撤销" });
        addMessage({ role: "tool", title: "已撤销", text: "上一次工具操作", detail: restored });
        if (activeSessionId) void agentApi.postCanvasState({ sessionId: activeSessionId, snapshot: restored });
    };

    const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = clamp(startWidth + startX - moveEvent.clientX, 360, 760);
            setAgentState({ width: nextWidth });
        };
        const onUp = () => {
            localStorage.setItem("canvas-agent-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    // 流式消息按 streamId 合并，同一 turn 的增量文本替换为最新全量。
    function addMessage(item: Omit<AgentChatItem, "id">) {
        const text = normalizeText(item.text);
        if (!text && !item.attachments?.length) return;
        const next = { ...item, id: `${Date.now()}-${Math.random()}`, text };
        const currentMessages = useCanvasAgentStore.getState().messages;
        if (next.streamId) {
            const index = currentMessages.findIndex((existing) => existing.streamId === next.streamId);
            if (index >= 0) {
                setAgentState({ messages: currentMessages.map((existing, i) => (i === index ? { ...existing, ...next, id: existing.id, text: next.text } : existing)) });
                return;
            }
        }
        pushMessage(next);
    }

    const content = (
        <>
            <AgentPanelTabs
                value={activeTab}
                theme={theme}
                items={[
                    { value: "chat", label: "对话" },
                    { value: "history", label: "历史", icon: <History className="size-3.5" />, count: sessions.length },
                ]}
                onChange={(activeTab) => {
                    setAgentState({ activeTab });
                    if (activeTab === "history") void loadSessions();
                }}
                right={
                    <Button size="small" type="text" disabled={!canUndoOps} icon={<RotateCcw className="size-3.5" />} onClick={undoLastTool}>
                        撤销
                    </Button>
                }
            />

            {activeTab === "history" ? (
                <AgentSessionListView
                    theme={theme}
                    sessions={sessions}
                    activeSessionId={activeSessionId}
                    loading={loadingSessions}
                    onRefresh={() => void loadSessions()}
                    onNewSession={() => void startNewSession()}
                    onOpenSession={(session) => void openSession(session)}
                />
            ) : (
                <>
                    <div ref={listRef} className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                        {messages.map((item) => (
                            <AgentChatMessage key={item.id} item={agentMessageToChatMessage(item)} theme={theme} user={user} />
                        ))}
                        {pendingTool ? <AgentPendingToolCard summary={summarizeCanvasAgentOps(pendingTool.input?.ops || []) || pendingTool.name} detail={{ callId: pendingTool.requestId, name: pendingTool.name, input: pendingTool.input }} theme={theme} onReject={rejectPendingTool} onApprove={approvePendingTool} /> : null}
                        {waiting && !pendingTool ? <AgentWorkingMessage theme={theme} /> : null}
                    </div>
                    <AgentChatComposer
                        prompt={prompt}
                        disabled={!activeSessionId}
                        sending={sending || waiting}
                        placeholder="让 Agent 操作画布或回答问题"
                        theme={theme}
                        onPromptChange={(prompt) => setAgentState({ prompt })}
                        onSubmit={sendPrompt}
                    />
                </>
            )}
        </>
    );

    if (embedded) return <div className="flex min-h-0 flex-1 flex-col">{content}</div>;

    return (
        <motion.div
            className="relative z-[70] flex h-full shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: collapsed ? 0 : width + 1, opacity: collapsed ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: collapsed ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex h-full shrink-0 flex-col border-l"
                initial={{ x: 48 }}
                animate={{ x: collapsed ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <div className="absolute left-0 top-0 h-full w-1 cursor-col-resize transition hover:bg-current/20" onPointerDown={startResize} />
                {content}
            </motion.aside>
        </motion.div>
    );
}

function AgentSessionListView({ theme, sessions, activeSessionId, loading, onRefresh, onNewSession, onOpenSession }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; sessions: AgentSession[]; activeSessionId: string; loading: boolean; onRefresh: () => void; onNewSession: () => void; onOpenSession: (session: AgentSession) => void }) {
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
            <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm" style={{ color: theme.node.muted }}>
                        {sessions.length ? `${sessions.length} 个会话` : "暂无会话"}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button size="small" icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />} disabled={loading} onClick={onRefresh}>
                            刷新
                        </Button>
                        <Button size="small" type="primary" icon={<Plus className="size-3.5" />} disabled={loading} onClick={onNewSession}>
                            新会话
                        </Button>
                    </div>
                </div>
                <div className="space-y-2">
                    {sessions.map((session) => {
                        const active = session.id === activeSessionId;
                        return (
                            <div key={session.id} className="rounded-lg border px-2.5 py-1.5 transition" style={{ borderColor: active ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}>
                                <div className="flex items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {active ? <span className="shrink-0 text-[10px] font-medium" style={{ color: theme.node.text }}>当前</span> : null}
                                            <div className="truncate text-sm font-medium leading-5">{session.title || "未命名会话"}</div>
                                        </div>
                                        <div className="truncate text-[11px] leading-4 opacity-65">{session.model || session.id}</div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <span className="text-[10px] opacity-55">{formatSessionTime(session.updatedAt || session.createdAt)}</span>
                                        <Button size="small" className="!h-6 !px-2" disabled={loading || active} onClick={() => onOpenSession(session)}>
                                            进入
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    {!sessions.length ? (
                        <div className="px-3 py-8 text-center text-sm" style={{ color: theme.node.muted }}>
                            当前画布还没有会话记录
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function agentMessageToChatMessage(item: AgentChatItem) {
    return { ...item, attachments: item.attachments?.map(agentAttachmentToChatAttachment) };
}

function agentAttachmentToChatAttachment(item: AgentAttachment): CanvasAgentChatAttachment {
    return { id: item.id, name: item.name, url: item.dataUrl || item.url };
}

// 会话历史（后端存储的消息）转成聊天列表项。content 为 JSON：user{text} | assistant{text,toolCalls} | tool{result,isError}。
function historyToChatItems(messages: AgentMessage[]): AgentChatItem[] {
    return messages
        .map((item, index): AgentChatItem | null => {
            const content = item.content && typeof item.content === "object" ? (item.content as Record<string, unknown>) : {};
            if (item.role === "tool") {
                const isError = Boolean(content.isError);
                return { id: item.id || `history-${index}`, role: "tool", title: isError ? "工具失败" : "工具完成", text: normalizeText(content.result) || (isError ? "工具执行失败" : "已完成"), detail: content };
            }
            const text = normalizeText(content.text);
            if (!text) return null;
            return { id: item.id || `history-${index}`, role: item.role === "user" ? "user" : "assistant", title: item.role === "user" ? undefined : "Agent", text };
        })
        .filter((item): item is AgentChatItem => Boolean(item));
}

function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return JSON.stringify(value, null, 2);
}

function formatSessionTime(value?: string) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
