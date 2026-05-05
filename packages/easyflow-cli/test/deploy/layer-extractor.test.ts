import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { extractLayer } from "../../src/deploy/layer-extractor.js";

async function createTarGz(files: Record<string, string>): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-tar-test-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(tmpDir, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
    }

    const chunks: Buffer[] = [];
    const stream = tar.create(
      {
        gzip: true,
        cwd: tmpDir,
        portable: true,
      },
      Object.keys(files),
    );

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function createTarGzWithRawPath(filePath: string, content: string): Buffer {
  const body = Buffer.from(content, "utf-8");
  const header = Buffer.alloc(512, 0);

  header.write(filePath, 0, 100, "utf-8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(" ", 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return zlib.gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024, 0)]));
}

describe("extractLayer", () => {
  it("基本的なファイルを展開できる", async () => {
    const tarGz = await createTarGz({
      "hello.txt": "Hello, World!",
      "config.json": '{"key": "value"}',
    });

    const result = await extractLayer(tarGz);

    expect(result.files.has("hello.txt")).toBe(true);
    expect(result.files.get("hello.txt")?.content.toString("utf-8")).toBe("Hello, World!");
    expect(result.files.has("config.json")).toBe(true);
    expect(result.files.get("config.json")?.content.toString("utf-8")).toBe('{"key": "value"}');
  });

  it("バイナリファイルを展開できる", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-tar-test-"));
    try {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await fs.writeFile(path.join(tmpDir, "binary.bin"), binaryContent);

      const chunks: Buffer[] = [];
      const stream = tar.create({ gzip: true, cwd: tmpDir, portable: true }, ["binary.bin"]);
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const tarGz = Buffer.concat(chunks);

      const result = await extractLayer(tarGz);
      expect(result.files.has("binary.bin")).toBe(true);
      expect(result.files.get("binary.bin")?.content).toEqual(binaryContent);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("パストラバーサルを含むパスで EasyflowError をスローする", async () => {
    const tarGz = createTarGzWithRawPath("../escape.txt", "content");

    await expect(extractLayer(tarGz)).rejects.toMatchObject({
      reason: "パストラバーサル (..) はレイヤー内で許可されていません",
    });
  });

  it("絶対パスで EasyflowError をスローする", async () => {
    const tarGz = createTarGzWithRawPath("/escape.txt", "content");

    await expect(extractLayer(tarGz)).rejects.toMatchObject({
      reason: "絶対パスはレイヤー内で許可されていません",
    });
  });

  it("1 ファイルだけの tar.gz でも正常に動作する", async () => {
    const tarGz = await createTarGz({ "single.txt": "only one file" });
    const result = await extractLayer(tarGz);
    expect(result.files.size).toBe(1);
    expect(result.files.get("single.txt")?.content.toString("utf-8")).toBe("only one file");
  });

  it("ファイルの mode を保持する", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "easyflow-tar-test-"));
    try {
      const scriptContent = "#!/bin/bash\necho hello";
      const scriptPath = path.join(tmpDir, "script.sh");
      await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });

      const chunks: Buffer[] = [];
      const stream = tar.create({ gzip: true, cwd: tmpDir, portable: true }, ["script.sh"]);
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const tarGz = Buffer.concat(chunks);

      const result = await extractLayer(tarGz);
      expect(result.files.has("script.sh")).toBe(true);
      const entry = result.files.get("script.sh");
      expect(entry?.content.toString("utf-8")).toBe(scriptContent);
      // tar の portable mode では mode が 0o755 として保持される
      expect(entry?.mode).toBe(0o755);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
