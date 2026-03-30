import { describe, expect, it } from "vitest";
import { agentStorage } from "../agent-storage.js";

function mockBucket(label = "default"): R2Bucket {
  return { label } as unknown as R2Bucket;
}

describe("agentStorage", () => {
  it("wraps plain values into getters", () => {
    const bucket = mockBucket();
    const storage = agentStorage({ bucket, namespace: "agent-1" });

    expect(storage.bucket()).toBe(bucket);
    expect(storage.namespace()).toBe("agent-1");
  });

  it("passes through getter functions unchanged", () => {
    const bucket = mockBucket();
    const getBucket = () => bucket;
    const getNamespace = () => "agent-2";

    const storage = agentStorage({ bucket: getBucket, namespace: getNamespace });

    expect(storage.bucket()).toBe(bucket);
    expect(storage.namespace()).toBe("agent-2");
  });

  it("lazy getters are called on each access", () => {
    let callCount = 0;
    const storage = agentStorage({
      bucket: () => mockBucket(`call-${++callCount}`),
      namespace: "ns",
    });

    const b1 = storage.bucket();
    const b2 = storage.bucket();
    expect((b1 as unknown as { label: string }).label).toBe("call-1");
    expect((b2 as unknown as { label: string }).label).toBe("call-2");
    expect(callCount).toBe(2);
  });

  it("different namespaces produce distinct identities", () => {
    const bucket = mockBucket();
    const storageA = agentStorage({ bucket, namespace: "alice" });
    const storageB = agentStorage({ bucket, namespace: "bob" });

    // Same bucket
    expect(storageA.bucket()).toBe(storageB.bucket());
    // Different namespace
    expect(storageA.namespace()).not.toBe(storageB.namespace());
  });
});
