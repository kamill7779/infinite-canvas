import { expect, test } from "bun:test";

import { imageFetchCredentials } from "./image-storage";

test("跨域图片读取不携带 cookie，避免 R2 CORS credentials 拦截", () => {
    expect(imageFetchCredentials("https://example.com/image.png")).toBe("omit");
    expect(imageFetchCredentials("/api/files/image.png")).toBe("include");
    expect(imageFetchCredentials("blob:http://localhost/image")).toBe("same-origin");
});
