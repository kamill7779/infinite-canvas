"use client";

import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration, readImageMeta } from "@/lib/image-utils";
import { enqueueEdit, enqueueGeneration, fetchImageRecord, generateEventsWsUrl, type ImageGenEvent, type ImageRecordImage, type ImageRecordStatus } from "@/services/api/image";
import { deleteStoredImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useAuthStore } from "@/stores/use-auth-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { ReferenceImage } from "@/types/image";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string; // = clientRequestId：WebSocket 事件按它精准匹配 slot
    clientRequestId?: string;
    recordId?: string;
    status: "pending" | "queued" | "running" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
};

// 一个批次的上下文：异步化后批次不再在 POST 返回时完成，改为「最后一个 slot 经 WebSocket 落定」时存日志、停计时。
type BatchContext = {
    total: number;
    startedAt: number;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    slotIds: string[];
    settled: Map<string, { status: "success" | "failed"; image?: GeneratedImage; error?: string }>;
    finalized?: boolean;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "成功" | "失败";
    images: GeneratedImage[];
    thumbnails: string[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const RESULT_ACTION_BUTTON_CLASS = "min-w-0 flex-1 px-1.5";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

export default function ImagePage() {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));

    const wsRef = useRef<WebSocket | null>(null);
    const batchRef = useRef<BatchContext | null>(null);
    const resultsRef = useRef<GenerationResult[]>([]);

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    // resultsRef 镜像最新 results，供 WebSocket / 补偿回调（稳定闭包）读取。
    useEffect(() => {
        resultsRef.current = results;
    }, [results]);

    // 用户级 WebSocket 长连接：接收 running/success/failed 事件驱动 slot；断线自动重连并对未完成 slot 补偿查询。
    useEffect(() => {
        let closed = false;
        let reconnectTimer = 0;
        const scheduleReconnect = () => {
            if (closed) return;
            window.clearTimeout(reconnectTimer);
            reconnectTimer = window.setTimeout(connect, 3000);
        };
        function connect() {
            const url = generateEventsWsUrl();
            if (!url) return;
            let ws: WebSocket;
            try {
                ws = new WebSocket(url);
            } catch {
                scheduleReconnect();
                return;
            }
            wsRef.current = ws;
            ws.onopen = () => void compensateUnfinished();
            ws.onmessage = (event) => handleEvent(typeof event.data === "string" ? event.data : "");
            ws.onclose = () => {
                if (!closed) scheduleReconnect();
            };
            ws.onerror = () => {
                try {
                    ws.close();
                } catch {
                    /* ignore */
                }
            };
        }
        connect();
        return () => {
            closed = true;
            window.clearTimeout(reconnectTimer);
            try {
                wsRef.current?.close();
            } catch {
                /* ignore */
            }
            wsRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // WebSocket 是主路径；轮询只做兜底，避免反代未透传 Upgrade 或 Pub/Sub 事件丢失时结果卡在 pending。
    // 自适应调度：立即探一次，随后 0.8s → 2s → 5s 上限指数退避 —— 丢消息场景把可见延迟从固定 5s 压到 ~1s。
    // 仅调整调度间隔，补偿逻辑与事件处理完全不变。
    useEffect(() => {
        if (!running) return;
        let cancelled = false;
        let timer = 0;
        const schedule = (delay: number) => {
            timer = window.setTimeout(async () => {
                await compensateUnfinished();
                if (!cancelled) schedule(Math.min(delay * 2.5, 5000));
            }, delay);
        };
        void compensateUnfinished();
        schedule(800);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [running]);

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                toast.error("剪切板里没有可读取的图片");
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            toast.success(`已读取 ${nextReferences.length} 张参考图`);
        } catch {
            toast.error("剪切板里没有可读取的图片");
        }
    };

    const generate = async () => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        const text = snapshot.text;

        const slotIds = Array.from({ length: generationCount }, () => nanoid());
        const batchStartedAt = performance.now();
        setElapsedMs(0);
        setRunning(true);
        setPreviewLog(null);
        setResults(slotIds.map((id) => ({ id, clientRequestId: id, status: "pending" as const })));
        setStartedAt(batchStartedAt);
        batchRef.current = {
            total: generationCount,
            startedAt: batchStartedAt,
            prompt: text,
            model,
            config: { model: snapshot.config.model, imageModel: snapshot.config.imageModel, quality: snapshot.config.quality, size: snapshot.config.size, count: String(generationCount) },
            references: snapshot.references,
            slotIds,
            settled: new Map(),
        };

        // 一图一请求：每个 slot 各发一个 POST 入队。POST 只等到「入队成功」，不等生图；结果经 WebSocket 回填。
        await Promise.allSettled(
            slotIds.map(async (clientRequestId) => {
                try {
                    const task = snapshot.references.length
                        ? await enqueueEdit(snapshot.config, text, snapshot.references, clientRequestId)
                        : await enqueueGeneration(snapshot.config, text, clientRequestId);
                    // 若事件已抢先把 slot 推进到 running/success，则不回退到 queued。
                    setResults((value) => value.map((r) => (r.clientRequestId === clientRequestId ? { ...r, recordId: task.recordId, status: r.status === "pending" ? "queued" : r.status } : r)));
                } catch (error) {
                    const msg = error instanceof Error ? error.message : "生成失败";
                    setResults((value) => value.map((r) => (r.clientRequestId === clientRequestId ? { ...r, status: "failed", error: msg } : r)));
                    settleSlot(clientRequestId, { status: "failed", error: msg });
                }
            }),
        );
    };

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        toast.success("已加入参考图");
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        addAsset({
            kind: "image",
            title: `生成结果 ${index + 1}`,
            coverUrl: stored.url,
            tags: [],
            source: "生图工作台",
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt },
        });
        toast.success("已加入我的素材");
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else {
            toast.warning("生图工作台只能使用文本或图片素材");
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        batchRef.current = null;
        setPrompt("");
        setReferences([]);
        setResults([]);
        setRunning(false);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const imageKeys = logs.filter((log) => selectedLogIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(refreshLogs);
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = (log: GenerationLog) => {
        void logStore.setItem(log.id, serializeLog(log)).then(refreshLogs);
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    const previewGenerationLog = async (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        setResults(log.images.map((image) => ({ id: image.id, status: "success", image })));
    };

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            toast.error("请输入生图提示词");
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            toast.warning("请先完成配置");
            openConfigDialog(true);
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: [...references] };
    };

    // ── 事件驱动：把 WebSocket / 补偿查询的结果落到对应 slot，并在批次全部落定时存日志、停计时 ──

    const finalizeBatch = async () => {
        const batch = batchRef.current;
        if (!batch || batch.finalized || batch.settled.size < batch.total) return;
        batch.finalized = true;
        const outcomes = [...batch.settled.values()];
        const images = outcomes.filter((o) => o.status === "success" && o.image).map((o) => o.image as GeneratedImage);
        const successCount = images.length;
        const logImages = await Promise.all(
            images.map(async (image) => {
                const stored = await uploadImage(image.dataUrl);
                return { ...image, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
            }),
        );
        saveLog(
            buildLog({
                prompt: batch.prompt,
                model: batch.model,
                config: batch.config,
                references: batch.references,
                durationMs: performance.now() - batch.startedAt,
                successCount,
                failCount: batch.total - successCount,
                status: successCount ? "成功" : "失败",
                images: logImages,
            }),
        );
        successCount ? toast.success("图片已生成") : toast.error(outcomes.find((o) => o.status === "failed")?.error || "生成失败");
        batchRef.current = null;
        setRunning(false);
    };

    // 记录某 slot 的终态；批次内最后一个落定时触发存日志（异步化后批次不再在 POST 返回时完成）。
    const settleSlot = (clientRequestId: string, outcome: { status: "success" | "failed"; image?: GeneratedImage; error?: string }) => {
        const batch = batchRef.current;
        if (!batch || !batch.slotIds.includes(clientRequestId) || batch.settled.has(clientRequestId)) return;
        batch.settled.set(clientRequestId, outcome);
        void finalizeBatch();
    };

    const imageFromRecord = async (img: ImageRecordImage): Promise<GeneratedImage> => {
        const meta = await readImageMeta(img.url).catch(() => ({ width: img.width ?? 0, height: img.height ?? 0 }));
        const started = batchRef.current?.startedAt ?? performance.now();
        return {
            id: img.id,
            dataUrl: img.url,
            durationMs: Math.max(0, performance.now() - started),
            width: img.width ?? meta.width,
            height: img.height ?? meta.height,
            bytes: img.bytes ?? 0,
            mimeType: img.mimeType,
        };
    };

    // WebSocket 事件与补偿查询共用：按 clientRequestId / recordId 命中 slot 并更新状态。
    const applyOutcome = async (match: { clientRequestId?: string; recordId?: string }, status: ImageRecordStatus, images: ImageRecordImage[], errorMsg?: string) => {
        const hit = (r: GenerationResult) => Boolean((match.clientRequestId && r.clientRequestId === match.clientRequestId) || (match.recordId && r.recordId === match.recordId));
        if (status === "running") {
            setResults((value) => value.map((r) => (hit(r) && r.status !== "success" && r.status !== "failed" ? { ...r, status: "running" } : r)));
            return;
        }
        if (status === "success") {
            const image = images[0] ? await imageFromRecord(images[0]) : undefined;
            setResults((value) => value.map((r) => (hit(r) ? { ...r, status: "success", image, error: undefined } : r)));
            if (match.clientRequestId) settleSlot(match.clientRequestId, { status: "success", image });
            return;
        }
        if (status === "failed") {
            setResults((value) => value.map((r) => (hit(r) ? { ...r, status: "failed", error: errorMsg || "生成失败" } : r)));
            if (match.clientRequestId) settleSlot(match.clientRequestId, { status: "failed", error: errorMsg });
        }
    };

    const handleEvent = (raw: string) => {
        if (!raw) return;
        let event: ImageGenEvent;
        try {
            event = JSON.parse(raw) as ImageGenEvent;
        } catch {
            return;
        }
        if (event.type === "ping") {
            try {
                wsRef.current?.send(JSON.stringify({ type: "pong", ts: event.ts }));
            } catch {
                /* ignore */
            }
            return;
        }
        const match = { clientRequestId: event.clientRequestId, recordId: event.recordId };
        if (event.type === "image.running") void applyOutcome(match, "running", []);
        else if (event.type === "image.success") {
            useAuthStore.getState().setBalance(event.balance);
            void applyOutcome(match, "success", event.images);
        } else if (event.type === "image.failed") {
            useAuthStore.getState().setBalance(event.balance);
            void applyOutcome(match, "failed", [], event.errorMsg);
        }
    };

    // 断线重连 / 初始化 / 轮询兜底：对未完成 slot 做状态补偿查询。
    const compensateUnfinished = async () => {
        const targets = resultsRef.current.filter((r) => r.recordId && r.status !== "success" && r.status !== "failed");
        for (const target of targets) {
            try {
                const rec = await fetchImageRecord(target.recordId as string);
                await applyOutcome({ clientRequestId: target.clientRequestId, recordId: target.recordId }, rec.status, rec.images, rec.errorMsg);
            } catch {
                /* 忽略：后续事件或下次补偿再兜 */
            }
        }
    };

    const retryResult = (index: number) => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        const target = results[index];
        if (!target) return;
        const clientRequestId = target.clientRequestId || target.id;
        setPreviewLog(null);
        setResults((value) => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined, clientRequestId, recordId: undefined }));
        // 重试 = 重新入队一个 job；结果同样经 WebSocket 回填。
        void (async () => {
            try {
                const task = snapshot.references.length
                    ? await enqueueEdit(snapshot.config, snapshot.text, snapshot.references, clientRequestId)
                    : await enqueueGeneration(snapshot.config, snapshot.text, clientRequestId);
                setResults((value) => updateResultAt(value, index, { recordId: task.recordId, status: "queued" }));
            } catch (error) {
                setResults((value) => updateResultAt(value, index, { status: "failed", error: error instanceof Error ? error.message : "生成失败" }));
            }
        })();
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">生图工作台</h1>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Button variant="outline" size="sm" onClick={() => setLogsOpen(true)}>
                                        <History className="size-4" />
                                        记录
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                                        <SlidersHorizontal className="size-4" />
                                        参数
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">提示词</span>
                                    <div className="flex gap-2">
                                        <Button variant="outline" size="sm" onClick={() => setPromptDialogOpen(true)}>
                                            <BookOpen className="size-3.5" />
                                            查看提示词库
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={() => setAssetPickerOpen(true)}>
                                            <FolderPlus className="size-3.5" />
                                            查看我的素材
                                        </Button>
                                    </div>
                                </div>
                                <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder="描述画面主体、风格、构图、光线和用途" />
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考图</span>
                                    <div className="flex gap-2">
                                        <Button variant="outline" size="sm" onClick={() => void addReferencesFromClipboard()}>
                                            <ClipboardPaste className="size-3.5" />
                                            剪切板
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                                            <Upload className="size-3.5" />
                                            上传
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className="hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 p-2 pb-3 overscroll-x-contain dark:border-stone-700"
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label="移除参考图"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">暂无参考图</div> : null}
                                </div>
                            </div>

                            <div className="bg-muted/50 flex items-center justify-between rounded-lg border px-3 py-2 text-sm sm:hidden">
                                <span className="text-muted-foreground truncate">
                                    {modelOptionLabel(effectiveConfig, model)} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
                                    <SlidersHorizontal className="size-4" />
                                    调整
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            <Button size="lg" className="w-full" disabled={!canGenerate || running} onClick={() => void generate()}>
                                {running ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                                开始生成
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-xl font-semibold">生成结果</h2>
                            </div>
                            {running ? <Badge variant="secondary">等待 {formatDuration(elapsedMs)}</Badge> : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "failed" ? (
                                        <FailedImageCard key={result.id} error={result.error || "生成失败"} onRetry={() => retryResult(index)} />
                                    ) : (
                                        <PendingImageCard key={result.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="text-muted-foreground flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed text-center lg:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 opacity-40" />
                                <p className="text-sm">还没有生成图片</p>
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Sheet open={logsOpen} onOpenChange={setLogsOpen}>
                <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
                    <SheetHeader><SheetTitle>生成记录</SheetTitle></SheetHeader>
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </SheetContent>
            </Sheet>
            <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
                <SheetContent side="bottom" className="max-h-[82vh] overflow-y-auto">
                    <SheetHeader><SheetTitle>参数</SheetTitle></SheetHeader>
                    <div className="grid grid-cols-2 gap-3 pb-4">
                        <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                    </div>
                </SheetContent>
            </Sheet>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
                <DialogContent className="max-w-sm">
                    <DialogHeader><DialogTitle>删除生成记录</DialogTitle></DialogHeader>
                    <p className="text-sm">确定删除选中的 {selectedLogIds.length} 条生成记录吗？</p>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>取消</Button>
                        <Button variant="destructive" onClick={deleteSelectedLogs}>删除</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">模型</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    return (
        <div className="bg-background overflow-hidden rounded-lg border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.dataUrl} alt={`生成结果 ${index + 1}`} className="aspect-square w-full object-cover" />
            <div className="space-y-2 border-t px-3 py-2.5">
                <div className="text-muted-foreground flex min-w-0 gap-x-2 gap-y-1 text-xs">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-3 gap-2">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="outline" className={RESULT_ACTION_BUTTON_CLASS} size="sm" onClick={() => void onSaveAsset(image, index)}>
                                <FolderPlus className="size-3.5" />
                                <span className="truncate">素材</span>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>添加到素材</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="outline" className={RESULT_ACTION_BUTTON_CLASS} size="sm" onClick={() => void onEdit(image, index)}>
                                <PenLine className="size-3.5" />
                                <span className="truncate">参考</span>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>加入参考图</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="outline" className={RESULT_ACTION_BUTTON_CLASS} size="sm" onClick={() => onDownload(image, index)}>
                                <Download className="size-3.5" />
                                <span className="truncate">下载</span>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>下载</TooltipContent>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard() {
    return (
        <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>生成中</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">生成失败</div>
                <p className="line-clamp-4 text-xs text-red-500 dark:text-red-300">{error}</p>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="sm" variant="destructive" onClick={onRetry}>
                    重试
                </Button>
            </div>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">生成记录</h2>
                </div>
                <Badge variant="secondary">{logs.length}</Badge>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={onCreateSession}>
                    <Plus className="size-3.5" />
                    新建
                </Button>
                <Button variant="outline" size="sm" disabled={!logs.length} onClick={toggleAll}>
                    <CheckSquare className="size-3.5" />
                    {allSelected ? "取消" : "全选"}
                </Button>
                <Button variant="destructive" size="sm" disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    <Trash2 className="size-3.5" />
                    删除
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="text-muted-foreground flex min-h-48 items-center justify-center rounded-lg border border-dashed text-center text-sm">暂无生成记录</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const thumbnails = (log.thumbnails || []).filter(Boolean).slice(0, 4);

    return (
        <div
            role="button"
            tabIndex={0}
            className={`block w-full cursor-pointer rounded-lg border p-2 text-left transition ${active ? "border-primary bg-accent" : "hover:bg-accent/50"}`}
            onClick={onClick}
            onKeyDown={(e) => e.key === "Enter" && onClick()}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <span onClick={(e) => e.stopPropagation()} className="mt-0.5">
                        <Checkbox checked={selected} onCheckedChange={(v) => onSelectedChange(Boolean(v))} />
                    </span>
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image, index) => (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img key={`${log.id}-${index}`} src={image} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        <Badge className="h-6 bg-blue-500/15 text-blue-600 dark:text-blue-400">成功 {log.successCount ?? log.imageCount}</Badge>
                        {log.failCount ? <Badge variant="destructive" className="h-6">失败 {log.failCount}</Badge> : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Badge variant="outline" className="h-6">{log.imageCount} 张</Badge>
                        <Badge className="h-6 bg-green-500/15 text-green-600 dark:text-green-400">{formatDuration(log.durationMs)}</Badge>
                    </div>
                    <div className="flex justify-end">
                        <Badge variant="outline" className="h-6">{log.time}</Badge>
                    </div>
                </div>
            </div>
        </div>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "成功",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
        thumbnails: [],
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="icon" variant="secondary" className="size-6 rounded-full bg-white/85 p-0 text-stone-900 shadow-sm hover:bg-white" disabled={index <= 0} onClick={() => onMove(-1)}>
                <ArrowLeft className="size-3" />
            </Button>
            <Button size="icon" variant="secondary" className="size-6 rounded-full bg-white/85 p-0 text-stone-900 shadow-sm hover:bg-white" disabled={index >= total - 1} onClick={() => onMove(1)}>
                <ArrowRight className="size-3" />
            </Button>
        </div>
    );
}

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}
