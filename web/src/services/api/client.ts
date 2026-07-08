// 自家后端请求封装。统一携带 Cookie、解析 {code,data,msg}，非 0 抛错（带 code 便于前端分流）。
export type ApiEnvelope<T> = { code: number; data: T | null; msg: string };

// 后端 API 基址。留空=同源（生产走反向代理 /api/* → Go）；跨域部署时设 NEXT_PUBLIC_API_BASE_URL。
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");

/** 拼接后端地址：绝对 URL 原样返回，相对 /api 路径按需加基址。供裸 fetch 调用点统一收口。 */
export function apiUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return API_BASE + path;
}

export class ApiError extends Error {
    code: number;
    status: number;
    constructor(message: string, code: number, status: number) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.status = status;
    }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(apiUrl(path), {
        method,
        credentials: "include",
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let envelope: ApiEnvelope<T>;
    try {
        envelope = await res.json();
    } catch {
        throw new ApiError("服务器无响应", 1, res.status);
    }
    if (envelope.code !== 0) throw new ApiError(envelope.msg || "请求失败", envelope.code, res.status);
    return envelope.data as T;
}

export const api = {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
};
