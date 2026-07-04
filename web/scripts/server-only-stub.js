// server-only 的打包期替身。
// worker / 独立进程不经过 Next 的 react-server 导出条件，真实 server-only 会在裸 node 里抛错。
// esbuild 用本空模块 alias 掉它（见 scripts/build-worker.mjs）；不改源码 guard，
// Next 构建仍用真实 server-only 拦截客户端组件误引用服务端模块。
export {};
