"use client";

import { useState } from "react";
import { Bot, PanelRightClose } from "lucide-react";
import { Button, Switch, Tooltip } from "antd";
import { motion } from "motion/react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasServerAgentPanel } from "./canvas-server-agent-panel";
import { useCanvasAgentStore } from "../stores/use-canvas-agent-store";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "../utils/canvas-agent-ops";

export const CANVAS_AGENT_PANEL_MOTION_MS = 500;
const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;

type CanvasAssistantPanelProps = {
    snapshot: CanvasAgentSnapshot;
    onApplyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot;
    canUndoOps: boolean;
    onUndoOps: () => CanvasAgentSnapshot | null;
    closing: boolean;
    onCollapse: () => void;
};

export function CanvasAssistantPanel({ snapshot, onApplyOps, canUndoOps, onUndoOps, closing, onCollapse }: CanvasAssistantPanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const confirmTools = useCanvasAgentStore((state) => state.confirmTools);
    const width = useCanvasAgentStore((state) => state.width);
    const setAgentState = useCanvasAgentStore((state) => state.setAgentState);
    const [resizing, setResizing] = useState(false);

    const startResize = () => {
        const move = (event: MouseEvent) => {
            const next = Math.min(760, Math.max(320, window.innerWidth - event.clientX));
            setAgentState({ width: next });
        };
        const stop = () => {
            setResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", stop);
            const current = useCanvasAgentStore.getState().width;
            localStorage.setItem("canvas-agent-panel-width", String(current));
        };
        setResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", stop);
    };

    return (
        <motion.div
            className="flex shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: closing ? 0 : width + 1, opacity: closing ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: closing ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex h-full shrink-0 flex-col border-l"
                initial={{ x: 48 }}
                animate={{ x: closing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label="调整右侧面板宽度" />
                <header className="flex h-14 items-center justify-between border-b px-4" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="grid size-8 place-items-center rounded-lg">
                            <Bot className="size-4" />
                        </span>
                        <div className="min-w-0">
                            <div className="text-base font-semibold leading-5">Agent</div>
                            <div className="truncate text-xs" style={{ color: theme.node.muted }}>
                                画布 Agent
                            </div>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs" style={{ color: theme.node.muted }}>
                            <Switch size="small" checked={confirmTools} onChange={(value) => setAgentState({ confirmTools: value })} />
                            工具确认
                        </label>
                        <Tooltip title="收起对话">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={{ color: theme.node.muted }} icon={<PanelRightClose className="size-4" />} onClick={onCollapse} />
                        </Tooltip>
                    </div>
                </header>
                <CanvasServerAgentPanel snapshot={snapshot} canUndoOps={canUndoOps} onApplyOps={onApplyOps} onUndoOps={onUndoOps} />
            </motion.aside>
        </motion.div>
    );
}
