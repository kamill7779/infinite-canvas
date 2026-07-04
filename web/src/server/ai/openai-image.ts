// OpenAI 兼容 /images/generations 适配器。服务端持 Key 出网，返回原始图片字节。
import "server-only";
import { AppError } from "../errors";
import type { ImageGenInput, ImageGenResult, UpstreamChannel } from "./types";

function joinUrl(baseUrl: string, path: string): string {
    const base = baseUrl.replace(/\/+$/, "");
    return /\/v\d+$/.test(base) ? `${base}${path}` : `${base}/v1${path}`;
}

export async function generateImageOpenAI(channel: UpstreamChannel, input: ImageGenInput, signal?: AbortSignal): Promise<ImageGenResult> {
    const res = await fetch(joinUrl(channel.baseUrl, "/images/generations"), {
        method: "POST",
        headers: { Authorization: `Bearer ${channel.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: input.model,
            prompt: input.prompt,
            n: input.count,
            ...(input.size ? { size: input.size } : {}),
            ...(input.quality ? { quality: input.quality } : {}),
            response_format: "b64_json",
        }),
        signal,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new AppError(`上游图片接口返回 ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }

    const payload = (await res.json()) as { id?: string; data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
    if (payload.error?.message) throw new AppError(payload.error.message);

    const images = await Promise.all(
        (payload.data ?? []).map(async (item) => {
            if (item.b64_json) return { buffer: Buffer.from(item.b64_json, "base64"), mimeType: "image/png" };
            if (item.url) {
                const r = await fetch(item.url, { signal });
                return { buffer: Buffer.from(await r.arrayBuffer()), mimeType: r.headers.get("content-type") || "image/png" };
            }
            throw new AppError("上游未返回图片数据");
        }),
    );
    if (!images.length) throw new AppError("上游没有返回图片");
    return { images, upstreamId: payload.id };
}

function parseImagePayload(payload: { id?: string; data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } }): ImageGenResult {
    if (payload.error?.message) throw new AppError(payload.error.message);
    const images: ImageGenResult["images"] = (payload.data ?? []).flatMap((item) => (item.b64_json ? [{ buffer: Buffer.from(item.b64_json, "base64"), mimeType: "image/png" }] : []));
    if (!images.length) throw new AppError("上游没有返回图片");
    return { images, upstreamId: payload.id };
}

/** OpenAI 兼容 /images/edits（图生图 / 局部蒙版编辑）。references/mask 为原始字节。 */
export async function editImageOpenAI(
    channel: UpstreamChannel,
    input: ImageGenInput,
    references: { buffer: Buffer; mimeType: string }[],
    mask: { buffer: Buffer; mimeType: string } | undefined,
    signal?: AbortSignal,
): Promise<ImageGenResult> {
    const form = new FormData();
    form.set("model", input.model);
    form.set("prompt", input.prompt);
    form.set("n", String(input.count));
    form.set("response_format", "b64_json");
    if (input.size) form.set("size", input.size);
    if (input.quality) form.set("quality", input.quality);
    references.forEach((ref, i) => form.append("image", new Blob([new Uint8Array(ref.buffer)], { type: ref.mimeType }), `image_${i}.png`));
    if (mask) form.set("mask", new Blob([new Uint8Array(mask.buffer)], { type: mask.mimeType }), "mask.png");

    const res = await fetch(joinUrl(channel.baseUrl, "/images/edits"), {
        method: "POST",
        headers: { Authorization: `Bearer ${channel.apiKey}` },
        body: form,
        signal,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new AppError(`上游编辑接口返回 ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    return parseImagePayload(await res.json());
}
