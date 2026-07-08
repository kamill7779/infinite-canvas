"use client";

import { useEffect } from "react";
import { useConfigStore } from "@/stores/use-config-store";
import { apiUrl } from "@/services/api/client";

type PlatformModel = { channel: string; model: string; value?: string; capability: string; tiers: Record<string, number> };

/**
 * 平台托管模式：从 /api/models 拉取可用模型（按能力分组）写入配置 store 的模型列表，
 * 取代 BYOK 的本地渠道模型。用户只看到平台模型（来自“渠道1/渠道2”），不接触 Key/上游。
 */
export function usePlatformModels(enabled: boolean) {
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        fetch(apiUrl("/api/models"), { credentials: "include" })
            .then((r) => r.json())
            .then((res: { code: number; data: PlatformModel[] }) => {
                if (cancelled || res.code !== 0 || !Array.isArray(res.data)) return;
                const supported = res.data.filter((m) => m.capability === "image" || m.capability === "text");
                const modelValue = (m: PlatformModel) => m.value || (m.channel ? `${m.channel}::${m.model}` : m.model);
                const byCap = (cap: string) => supported.filter((m) => m.capability === cap).map(modelValue);
                const image = byCap("image");
                const text = byCap("text");
                const video: string[] = [];
                const audio: string[] = [];
                const all = [...new Set(supported.map(modelValue))];

                const { updateConfig } = useConfigStore.getState();
                updateConfig("models", all);
                updateConfig("imageModels", image);
                updateConfig("textModels", text);
                updateConfig("videoModels", video);
                updateConfig("audioModels", audio);

                // 选中项回落到可用模型（保留 channel::model，后端按渠道精确解析）。
                const cfg = useConfigStore.getState().config;
                if (image.length && !image.includes(cfg.imageModel)) updateConfig("imageModel", image[0]);
                if (text.length && !text.includes(cfg.textModel)) updateConfig("textModel", text[0]);
                if (video.length && !video.includes(cfg.videoModel)) updateConfig("videoModel", video[0]);
                if (audio.length && !audio.includes(cfg.audioModel)) updateConfig("audioModel", audio[0]);
                if (image.length) updateConfig("model", image[0]);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [enabled]);
}
