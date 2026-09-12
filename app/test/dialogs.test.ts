import { describe, expect, test } from "bun:test";
import { DialogBroker } from "../src/dialogs.ts";
import type { UiRequestFrame } from "../src/protocol.ts";

/** Dialog broker contract: exactly-once settle, pending retention for the
 * v0.14 read face, and frame-header integrity (reserved keys never override
 * the broker's own type/requestId/threadId). */

function brokerWithFrames(): { broker: DialogBroker; frames: UiRequestFrame[] } {
  const frames: UiRequestFrame[] = [];
  return { broker: new DialogBroker((frame) => frames.push(frame)), frames };
}

describe("DialogBroker (frame integrity + read face)", () => {
  test("症状防护「payload 覆盖帧头」：type/requestId/threadId 保留键被剥除，帧头恒由 broker 持有", async () => {
    const { broker, frames } = brokerWithFrames();
    const asked = broker.ask(
      "t1",
      {
        method: "confirm",
        title: "Run?",
        type: "hub_error",
        requestId: "evil",
        threadId: "other-thread",
      },
      {},
    );
    expect(frames).toHaveLength(1);
    const frame = frames[0] as Record<string, unknown>;
    expect(frame["type"]).toBe("ui_request");
    expect(frame["requestId"]).not.toBe("evil");
    expect(frame["threadId"]).toBe("t1");
    // 保留读口形状：pendingAll 的 payload 也不携带帧头（客户端 {...payload} 重建安全）
    const [pending] = broker.pendingAll();
    expect(pending?.request).toEqual({ method: "confirm", title: "Run?" });
    broker.resolve(frames[0]?.requestId ?? "", { confirmed: true });
    await expect(asked).resolves.toEqual({ confirmed: true });
  });

  test("pendingAll keeps ask order and drops settled entries", async () => {
    const { broker, frames } = brokerWithFrames();
    const first = broker.ask("t1", { method: "confirm", title: "1?" }, {});
    const second = broker.ask("t1", { method: "input", placeholder: "x" }, {});
    expect(broker.pendingAll().map((entry) => entry.request.method)).toEqual(["confirm", "input"]);
    broker.resolve(frames[0]?.requestId ?? "", { confirmed: false });
    await first;
    expect(broker.pendingAll().map((entry) => entry.request.method)).toEqual(["input"]);
    broker.settleAll();
    await second;
    expect(broker.pendingAll()).toEqual([]);
  });
});

describe("DialogBroker (prototype hardening)", () => {
  test("症状防护「__proto__ 键走原型 setter」：payload 自有 __proto__ 键不得污染 request 原型", async () => {
    const { broker } = brokerWithFrames();
    // JSON.parse 产生的自有 __proto__ 属性（不走 setter）模拟来自不可信来源的 payload
    const payload = JSON.parse('{"method":"confirm","title":"Run?","__proto__":{"polluted":true}}');
    const asked = broker.ask("t1", payload, {});
    const [pending] = broker.pendingAll();
    const request = pending?.request as Record<string, unknown>;
    expect(request).toEqual({ method: "confirm", title: "Run?" });
    expect(request["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(request)).toBe(Object.prototype);
    broker.settleAll();
    await asked;
  });
});
