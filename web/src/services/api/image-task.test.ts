import { afterEach, expect, test } from "bun:test";

import { waitForImageTaskRecord, type ImageTaskRecord } from "./image-task";

const realDateNow = Date.now;
const realSetTimeout = globalThis.setTimeout;

afterEach(() => {
    Date.now = realDateNow;
    globalThis.setTimeout = realSetTimeout;
});

test("等待后端兜底窗口内稍晚完成的图片任务", async () => {
    let now = 0;
    let calls = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: TimerHandler) => {
        now += 1_500;
        if (typeof handler === "function") handler();
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const result = await waitForImageTaskRecord(async (): Promise<ImageTaskRecord<{ id: string; url: string }>> => {
        calls += 1;
        return now > 306_000 ? { status: "success", images: [{ id: "late", url: "/api/files/late.png" }] } : { status: "running", images: [] };
    });

    expect(result).toEqual([{ id: "late", url: "/api/files/late.png" }]);
    expect(calls).toBeGreaterThan(200);
});
