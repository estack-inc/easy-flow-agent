import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageStore } from "../../src/store/image-store.js";
import type { ImageData } from "../../src/store/types.js";

function createTestImageData(content = "test-layer-data"): ImageData {
  return {
    manifest: { schemaVersion: 2 },
    config: {
      name: "test-agent",
      version: "1.0.0",
      description: "A test agent",
      tools: ["tool-a"],
      channels: ["slack"],
    },
    layers: new Map([["layer0.bin", Buffer.from(content)]]),
  };
}

describe("ImageStore", () => {
  let tmpDir: string;
  let store: ImageStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-store-test-"));
    store = new ImageStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("save → load でデータが一致する", async () => {
    const ref = "estack-inc/support:1.0.0";
    const data = createTestImageData();
    await store.save(ref, data);

    const loaded = await store.load(ref);
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest).toEqual(data.manifest);
    expect(loaded!.config).toEqual(data.config);
    expect(loaded!.layers.get("layer0.bin")).toEqual(data.layers.get("layer0.bin"));
  });

  it("list で複数イメージを全件取得できる", async () => {
    await store.save("org/agent-a:1.0.0", createTestImageData("a"));
    await store.save("org/agent-b:2.0.0", createTestImageData("b"));

    const images = await store.list();
    expect(images.length).toBe(2);
    const refs = images.map((img) => img.ref).sort();
    expect(refs).toEqual(["org/agent-a:1.0.0", "org/agent-b:2.0.0"]);
  });

  it("remove 後に load で null が返る", async () => {
    const ref = "org/agent:1.0.0";
    await store.save(ref, createTestImageData());

    const removed = await store.remove(ref);
    expect(removed).toBe(true);

    const loaded = await store.load(ref);
    expect(loaded).toBeNull();
  });

  it("ref パースが正しい", () => {
    const parsed = ImageStore.parseRef("estack-inc/support:1.0.0");
    expect(parsed).toEqual({ org: "estack-inc", name: "support", tag: "1.0.0" });
  });

  it("ref パース — タグなしは latest", () => {
    const parsed = ImageStore.parseRef("estack-inc/support");
    expect(parsed).toEqual({ org: "estack-inc", name: "support", tag: "latest" });
  });

  it("prune でタグなしイメージが削除される", async () => {
    const ref = "org/agent:1.0.0";
    await store.save(ref, createTestImageData());

    // Remove the tag symlink but leave the digest directory
    await store.remove(ref);
    // remove only removes the digest dir too when no other refs exist,
    // so let's create a scenario: save, then manually break the symlink
    await store.save(ref, createTestImageData("prune-test"));
    const { org, name, tag } = ImageStore.parseRef(ref);
    const tagDir = path.join(tmpDir, org, name, tag);
    await fs.unlink(tagDir);

    const result = await store.prune();
    expect(result.removed).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
  });

  it("パストラバーサルを含む ref を拒否する", async () => {
    await expect(store.save("../../tmp/x:tag", createTestImageData())).rejects.toThrow(
      "不正な ref",
    );
    await expect(store.load("../escape:latest")).rejects.toThrow("不正な ref");
    await expect(store.remove("../escape:latest")).rejects.toThrow("不正な ref");
  });

  it("パストラバーサルを含む layer 名を拒否する", async () => {
    const data = createTestImageData();
    data.layers.set("../../etc/passwd", Buffer.from("malicious"));
    await expect(store.save("org/agent:1.0.0", data)).rejects.toThrow("不正な layer 名");
  });

  it("存在しない ref の load → null", async () => {
    const loaded = await store.load("nonexistent/agent:1.0.0");
    expect(loaded).toBeNull();
  });

  it("同一 digest に複数 ref を付けた場合、list で全 ref が返る", async () => {
    const data = createTestImageData("shared-content");
    await store.save("org/agent:1.0.0", data);
    await store.save("org/agent:latest", data);

    const images = await store.list();
    const refs = images.map((img) => img.ref).sort();
    expect(refs).toEqual(["org/agent:1.0.0", "org/agent:latest"]);
  });

  it("単一セグメント ref の save → list で ref が維持される", async () => {
    await store.save("agent:latest", createTestImageData("single-seg"));
    const images = await store.list();
    expect(images.length).toBe(1);
    expect(images[0].ref).toBe("agent:latest");
  });

  it("同一 ref を別 digest で上書きした場合、list に古い ref が残らない", async () => {
    await store.save("org/agent:1.0.0", createTestImageData("v1"));
    await store.save("org/agent:1.0.0", createTestImageData("v2"));

    const images = await store.list();
    expect(images.length).toBe(1);
    expect(images[0].ref).toBe("org/agent:1.0.0");

    // 古い digest ディレクトリが孤立 → prune で削除できる
    const pruned = await store.prune();
    expect(pruned.removed).toBe(1);
    expect(pruned.freedBytes).toBeGreaterThan(0);
  });

  it("パストラバーサルを含む ref は拒否される", () => {
    expect(() => ImageStore.parseRef("../../tmp/x:tag")).toThrow("Invalid ref segment");
    expect(() => ImageStore.parseRef("org/../etc:tag")).toThrow("Invalid ref segment");
    expect(() => ImageStore.parseRef(":tag")).toThrow("Invalid ref segment");
  });

  it("パストラバーサルを含む layer 名は save で拒否される", async () => {
    const data = createTestImageData();
    data.layers.set("../../etc/passwd", Buffer.from("bad"));
    await expect(store.save("org/agent:1.0.0", data)).rejects.toThrow("Invalid layer name");
  });
});
