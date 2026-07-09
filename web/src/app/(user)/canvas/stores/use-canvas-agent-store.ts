import { create } from "zustand";

import type { AgentSession } from "@/services/api/agent";
import type { CanvasAgentOp } from "../utils/canvas-agent-ops";

export type AgentChatRole = "user" | "assistant" | "system" | "tool" | "error";
export type AgentAttachment = { id: string; name: string; type: string; size: number; url: string; dataUrl: string };
export type AgentChatItem = { id: string; role: AgentChatRole; title?: string; text: string; meta?: string; detail?: unknown; attachments?: AgentAttachment[]; streamId?: string };
export type AgentPendingToolCall = { requestId: string; name: string; input?: { ops?: CanvasAgentOp[] } };
export type AgentPanelTab = "chat" | "history";

type CanvasAgentStore = {
    width: number;
    enabled: boolean;
    connected: boolean;
    prompt: string;
    sending: boolean;
    waiting: boolean;
    messages: AgentChatItem[];
    sessions: AgentSession[];
    activeSessionId: string;
    model: string;
    activeTab: AgentPanelTab;
    confirmTools: boolean;
    activity: string;
    pendingTool: AgentPendingToolCall | null;
    setAgentState: (patch: Partial<Omit<CanvasAgentStore, "setAgentState" | "addMessage">>) => void;
    addMessage: (item: AgentChatItem) => void;
};

export const useCanvasAgentStore = create<CanvasAgentStore>((set) => ({
    width: typeof window === "undefined" ? 440 : Number(localStorage.getItem("canvas-agent-panel-width")) || 440,
    enabled: false,
    connected: false,
    prompt: "",
    sending: false,
    waiting: false,
    messages: [],
    sessions: [],
    activeSessionId: "",
    model: "",
    activeTab: "chat",
    confirmTools: true,
    activity: "就绪",
    pendingTool: null,
    setAgentState: (patch) => set(patch),
    addMessage: (item) => set((state) => ({ messages: [...state.messages.slice(-120), item] })),
}));
