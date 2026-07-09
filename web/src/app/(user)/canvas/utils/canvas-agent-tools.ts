import { nanoid } from "nanoid";

import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../types";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "./canvas-agent-ops";

type GenerationMode = "text" | "image" | "video" | "audio";

/**
 * 将后端 Agent 请求的便捷工具（canvas_create_text_node 等）展开成画布 ops。
 * 移植自 canvas-agent/src/canvas-session.ts 的 callTool 展开逻辑，读工具由服务端处理，这里只覆盖写工具。
 * 未知工具名返回空数组。
 */
export function expandCanvasTool(name: string, input: unknown, snapshot: CanvasAgentSnapshot): CanvasAgentOp[] {
    const data = isRecord(input) ? input : {};
    switch (name) {
        case "canvas_apply_ops":
            return Array.isArray(data.ops) ? (data.ops as CanvasAgentOp[]) : [];
        case "canvas_create_node": {
            const nodeType = data.nodeType as CanvasNodeType | undefined;
            return [{ type: "add_node", nodeType, title: stringOptional(data.title) || undefined, position: { x: numberOr(data.x, nextCanvasX(snapshot)), y: numberOr(data.y, 0) }, width: numberOptional(data.width), height: numberOptional(data.height), metadata: recordOptional(data.metadata) as CanvasNodeMetadata | undefined }];
        }
        case "canvas_create_text_node":
            return [textNodeOp(data, numberOr(data.x, nextCanvasX(snapshot)), numberOr(data.y, 0))];
        case "canvas_create_text_nodes": {
            const items = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
            const x = numberOr(data.x, nextCanvasX(snapshot));
            const y = numberOr(data.y, 0);
            const gap = numberOr(data.gap, 40);
            const row = data.direction === "row";
            return items.map((item, index) => textNodeOp(item, numberOr(item.x, row ? x + index * (340 + gap) : x), numberOr(item.y, row ? y : y + index * (240 + gap))));
        }
        case "canvas_create_image_prompt_flow":
            return generationFlowOps({ ...data, mode: "image" }, snapshot);
        case "canvas_create_config_node": {
            const configId = `config-${nanoid()}`;
            const mode = generationMode(data.mode);
            return [configNodeOp(configId, data, numberOr(data.x, nextCanvasX(snapshot)), numberOr(data.y, 0)), ...(data.autoRun ? [runGenerationOp(configId, mode, stringOptional(data.prompt))] : [])];
        }
        case "canvas_create_generation_flow":
            return generationFlowOps(data, snapshot);
        case "canvas_generate_text":
            return generationFlowOps({ ...data, mode: "text", autoRun: true }, snapshot);
        case "canvas_generate_image":
            return generationFlowOps({ ...data, mode: "image", autoRun: true }, snapshot);
        case "canvas_generate_video":
            return generationFlowOps({ ...data, mode: "video", autoRun: true }, snapshot);
        case "canvas_generate_audio":
            return generationFlowOps({ ...data, mode: "audio", autoRun: true }, snapshot);
        case "canvas_update_node":
            return [{ type: "update_node", id: String(data.id || ""), patch: recordOptional(data.patch) as Partial<CanvasNodeData> | undefined, metadata: recordOptional(data.metadata) as CanvasNodeMetadata | undefined }];
        case "canvas_update_node_text":
            return [{ type: "update_node", id: String(data.id || ""), patch: stringOptional(data.title) ? { title: stringOptional(data.title) } : undefined, metadata: { content: stringOptional(data.text), status: "success" } }];
        case "canvas_move_nodes": {
            const items = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
            return items.map((item) => {
                const current = snapshot.nodes.find((node) => node.id === item.id);
                return { type: "update_node", id: String(item.id || ""), patch: { position: { x: numberOr(item.x, (current?.position.x || 0) + numberOr(item.dx, 0)), y: numberOr(item.y, (current?.position.y || 0) + numberOr(item.dy, 0)) } } };
            });
        }
        case "canvas_resize_node":
            return [{ type: "update_node", id: String(data.id || ""), patch: { width: numberOptional(data.width), height: numberOptional(data.height) }, metadata: typeof data.freeResize === "boolean" ? { freeResize: data.freeResize } : undefined }];
        case "canvas_delete_nodes":
            return [{ type: "delete_node", ids: stringArray(data.ids) }];
        case "canvas_connect_nodes": {
            const connections = Array.isArray(data.connections) ? data.connections.filter(isRecord) : [];
            return connections.map((connection) => ({ type: "connect_nodes", fromNodeId: String(connection.fromNodeId || ""), toNodeId: String(connection.toNodeId || "") }));
        }
        case "canvas_select_nodes":
            return [{ type: "select_nodes", ids: stringArray(data.ids) }];
        case "canvas_set_viewport":
            return [{ type: "set_viewport", viewport: (data.viewport || snapshot.viewport) as CanvasAgentSnapshot["viewport"] }];
        case "canvas_run_generation":
            return [runGenerationOp(String(data.nodeId || ""), generationMode(data.mode), stringOptional(data.prompt))];
        default:
            return [];
    }
}

function textNodeOp(input: Record<string, unknown>, x: number, y: number): CanvasAgentOp {
    return { type: "add_node", id: stringOptional(input.id) || undefined, nodeType: CanvasNodeType.Text, title: stringOptional(input.title) || undefined, position: { x, y }, width: numberOptional(input.width), height: numberOptional(input.height), metadata: { content: stringOptional(input.text), status: "success", fontSize: 14 } };
}

function configNodeOp(id: string, input: Record<string, unknown>, x: number, y: number): CanvasAgentOp {
    const mode = generationMode(input.mode);
    const prompt = stringOptional(input.prompt);
    return {
        type: "add_node",
        id,
        nodeType: CanvasNodeType.Config,
        title: stringOptional(input.title) || generationTitle(mode),
        position: { x, y },
        width: numberOptional(input.width),
        height: numberOptional(input.height),
        metadata: cleanRecord({
            generationMode: mode,
            composerContent: prompt,
            prompt,
            status: "idle",
            model: input.model,
            size: input.size,
            quality: input.quality,
            count: input.count,
            seconds: input.seconds,
            vquality: input.vquality,
            generateAudio: input.generateAudio,
            watermark: input.watermark,
            audioVoice: input.audioVoice,
            audioFormat: input.audioFormat,
            audioSpeed: input.audioSpeed,
            audioInstructions: input.audioInstructions,
        }) as CanvasNodeMetadata,
    };
}

function generationFlowOps(input: Record<string, unknown>, snapshot: CanvasAgentSnapshot): CanvasAgentOp[] {
    const mode = generationMode(input.mode);
    const prompt = stringOptional(input.prompt);
    const x = numberOr(input.x, nextCanvasX(snapshot));
    const y = numberOr(input.y, 0);
    const textId = `text-${nanoid()}`;
    const configId = `config-${nanoid()}`;
    const referenceNodeIds = Array.isArray(input.referenceNodeIds) ? input.referenceNodeIds.filter((id): id is string => typeof id === "string") : [];
    const tokens = [`@[node:${textId}]`, ...referenceNodeIds.map((id) => `@[node:${id}]`)];
    return [
        textNodeOp({ id: textId, text: prompt, title: stringOptional(input.title) || "提示词" }, x, y),
        configNodeOp(configId, { ...input, prompt: tokens.join("\n") }, x + 420, y),
        { type: "connect_nodes", fromNodeId: textId, toNodeId: configId },
        ...referenceNodeIds.map((fromNodeId) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: configId })),
        { type: "select_nodes", ids: [configId] },
        ...(input.autoRun ? [runGenerationOp(configId, mode, tokens.join("\n"))] : []),
    ];
}

function runGenerationOp(nodeId: string, mode: GenerationMode, prompt?: string): CanvasAgentOp {
    return { type: "run_generation", nodeId, mode, prompt };
}

function nextCanvasX(snapshot: CanvasAgentSnapshot) {
    return snapshot.nodes.length ? Math.max(...snapshot.nodes.map((node) => node.position.x + node.width)) + 80 : 0;
}

function generationMode(value: unknown): GenerationMode {
    return value === "text" || value === "video" || value === "audio" ? value : "image";
}

function generationTitle(mode: GenerationMode) {
    if (mode === "text") return "文本生成";
    if (mode === "video") return "视频生成";
    if (mode === "audio") return "音频生成";
    return "图片生成";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordOptional(value: unknown) {
    return isRecord(value) ? value : undefined;
}

function stringOptional(value: unknown) {
    return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberOptional(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOr(value: unknown, fallback: number) {
    return numberOptional(value) ?? fallback;
}

function cleanRecord(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}
