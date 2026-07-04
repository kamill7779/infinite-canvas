// 把独立进程（worker、WS 事件网关）打成自包含 CJS bundle，输出到 .next/standalone/ 与 server.js 并列。
// 现有 Dockerfile 的 COPY .next/standalone /app/web 会自动带上它们，无需改 Dockerfile。
//  - server-only  → 空 stub（不改源码 guard；Next 侧照常拦客户端误引用）
//  - @/*          → src/*（tsconfig paths + alias 兜底）
//  - 用 CJS 输出：Prisma / aws-sdk / ws 的可选 native 依赖用 require + try/catch，CJS 下天然可用。
//  - 只 external Prisma 生成客户端；BullMQ/ioredis/AWS SDK/ws 全部打进 bundle，避免 Next standalone
//    只追踪到 package.json 而漏拷运行文件，导致独立进程启动时 MODULE_NOT_FOUND。
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const common = {
    platform: "node",
    format: "cjs",
    target: "node20",
    bundle: true,
    sourcemap: true,
    tsconfig: resolve(root, "tsconfig.json"),
    alias: {
        "server-only": resolve(root, "scripts/server-only-stub.js"),
        "@": resolve(root, "src"),
    },
    logLevel: "info",
};

// worker：仅 Prisma 走 standalone/node_modules；队列/Redis/AWS SDK 打进 bundle，保证独立进程可启动。
await build({
    ...common,
    entryPoints: [resolve(root, "src/server/workers/image-worker.ts")],
    outfile: resolve(root, ".next/standalone/worker.cjs"),
    external: ["@prisma/client", ".prisma/client"],
});
console.log("[build-worker] wrote .next/standalone/worker.cjs");

// WS 网关：仅 Prisma 走 standalone/node_modules；ioredis/ws 打进 bundle；
// bufferutil/utf-8-validate 是 ws 的可选 native 依赖，external 后由 ws 内部 try/catch 兜底缺失。
await build({
    ...common,
    entryPoints: [resolve(root, "src/server/ws/generate-events-server.ts")],
    outfile: resolve(root, ".next/standalone/ws-server.cjs"),
    external: ["@prisma/client", ".prisma/client", "bufferutil", "utf-8-validate"],
});
console.log("[build-worker] wrote .next/standalone/ws-server.cjs");
