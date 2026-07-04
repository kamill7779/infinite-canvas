// 生成事件的 Redis Pub/Sub 载荷与发布逻辑。
// worker 只 publish 到 gen-events:user:{userId}，不感知浏览器连接；
// WS 网关订阅该频道并把事件转发给在线 socket（订阅生命周期由网关自己管理）。
import "server-only";
import { publisherConnection } from "./redis-conn";

export type ImageEventImage = {
    id: string;
    url: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
};

export type ImageEvent =
    | { type: "image.running"; recordId: string; clientRequestId?: string; status: "running" }
    | {
          type: "image.success";
          recordId: string;
          clientRequestId?: string;
          status: "success";
          images: ImageEventImage[];
          balance: number;
      }
    | {
          type: "image.failed";
          recordId: string;
          clientRequestId?: string;
          status: "failed";
          errorMsg: string;
          balance: number;
      };

/** 用户级事件频道：worker publish、网关 subscribe。 */
export function userEventChannel(userId: string): string {
    return `gen-events:user:${userId}`;
}

/** worker 侧发布一条生成事件到该用户频道。Pub/Sub 只做实时通知，不保证离线送达（DB 为真值）。 */
export async function publishImageEvent(userId: string, event: ImageEvent): Promise<void> {
    await publisherConnection().publish(userEventChannel(userId), JSON.stringify(event));
}
