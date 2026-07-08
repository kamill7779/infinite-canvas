export type ImageTaskStatus = "pending" | "running" | "success" | "failed";
export type ImageTaskRecord<TImage> = { status: ImageTaskStatus; images: TImage[]; errorMsg?: string };
export type ImageTaskOptions = { signal?: AbortSignal };

const IMAGE_TASK_TIMEOUT_MS = 13 * 60_000;

export async function waitForImageTaskRecord<TImage>(
    fetchRecord: (options?: ImageTaskOptions) => Promise<ImageTaskRecord<TImage>>,
    options?: ImageTaskOptions,
): Promise<TImage[]> {
    const startedAt = Date.now();
    for (;;) {
        if (options?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        const record = await fetchRecord(options);
        if (record.status === "success") return record.images;
        if (record.status === "failed") throw new Error(record.errorMsg || "生成失败");
        if (Date.now() - startedAt > IMAGE_TASK_TIMEOUT_MS) throw new Error("生成超时，请稍后在记录中查看结果");
        await new Promise((resolve) => setTimeout(resolve, 1500));
    }
}
