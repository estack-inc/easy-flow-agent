import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageData, ImageMetadata, StoredImage } from "./types.js";

/** ref ツリーのルートディレクトリ名。digest ディレクトリ (sha256-*) との衝突を回避する。 */
const REFS_DIR = "refs";
/** org なし ref を保存する際の sentinel ディレクトリ名。validateRef が許可しない文字を含み、ユーザー ref と衝突しない。 */
const NO_ORG_SENTINEL = "~noorg";

export class ImageStore {
  private storeDir: string;

  constructor(storeDir?: string) {
    this.storeDir = path.resolve(
      storeDir ?? process.env.EASYFLOW_STORE_DIR ?? path.join(os.homedir(), ".easyflow", "images"),
    );
  }

  /** ref ツリーのベースパスを返す */
  private get refsDir(): string {
    return path.join(this.storeDir, REFS_DIR);
  }

  async save(ref: string, data: ImageData): Promise<StoredImage> {
    ImageStore.validateRef(ref);
    for (const layerName of data.layers.keys()) {
      ImageStore.validateLayerName(layerName);
    }

    await fs.mkdir(this.storeDir, { recursive: true });

    const digest = ImageStore.computeDigest(this.serializeImageData(data));
    const digestDir = path.join(this.storeDir, digest.replace(":", "-"));

    await fs.mkdir(digestDir, { recursive: true });
    await fs.writeFile(
      path.join(digestDir, "manifest.json"),
      JSON.stringify(data.manifest, null, 2),
    );
    await fs.writeFile(path.join(digestDir, "config.json"), JSON.stringify(data.config, null, 2));

    const layersDir = path.join(digestDir, "layers");
    await fs.mkdir(layersDir, { recursive: true });
    for (const [name, buffer] of data.layers) {
      ImageStore.validateLayerName(name);
      await fs.writeFile(path.join(layersDir, name), buffer);
    }

    const { org, name, tag } = ImageStore.parseRef(ref);
    const tagDir = path.join(this.refsDir, org, name, "tags", tag);
    await fs.mkdir(path.dirname(tagDir), { recursive: true });

    // Remove existing symlink if present
    try {
      await fs.unlink(tagDir);
    } catch {
      // ignore if not exists
    }
    await fs.symlink(digestDir, tagDir);

    const size = await this.computeDirSize(digestDir);
    const metadata = this.extractMetadata(data.config);

    const storedImage: StoredImage = {
      ref,
      digest,
      size,
      createdAt: new Date().toISOString(),
      metadata,
    };

    await fs.writeFile(path.join(digestDir, "image.json"), JSON.stringify(storedImage, null, 2));

    return storedImage;
  }

  async load(ref: string): Promise<ImageData | null> {
    ImageStore.validateRef(ref);
    const { org, name, tag } = ImageStore.parseRef(ref);
    const tagDir = path.join(this.refsDir, org, name, "tags", tag);

    try {
      const realDir = await fs.realpath(tagDir);
      if (!(await this.assertInsideStore(realDir))) {
        return null;
      }
      const manifest = JSON.parse(await fs.readFile(path.join(realDir, "manifest.json"), "utf-8"));
      const config = JSON.parse(await fs.readFile(path.join(realDir, "config.json"), "utf-8"));

      const layers = new Map<string, Buffer>();
      const layersDir = path.join(realDir, "layers");
      try {
        const entries = await fs.readdir(layersDir);
        for (const entry of entries) {
          const buf = await fs.readFile(path.join(layersDir, entry));
          layers.set(entry, buf);
        }
      } catch {
        // no layers directory
      }

      return { manifest, config, layers };
    } catch {
      return null;
    }
  }

  async remove(ref: string): Promise<boolean> {
    ImageStore.validateRef(ref);
    const { org, name, tag } = ImageStore.parseRef(ref);
    const tagDir = path.join(this.refsDir, org, name, "tags", tag);

    try {
      const realDir = await fs.realpath(tagDir);
      if (!(await this.assertInsideStore(realDir))) {
        // symlink points outside store — remove the dangling symlink but don't touch the target
        await fs.unlink(tagDir);
        return true;
      }
      await fs.unlink(tagDir);

      // Check if any other symlinks point to this digest dir
      const hasOtherRefs = await this.hasSymlinksTo(realDir);
      if (!hasOtherRefs) {
        await fs.rm(realDir, { recursive: true, force: true });
      }

      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<StoredImage[]> {
    const result: StoredImage[] = [];

    try {
      await this.collectRefsRecursive(this.refsDir, [], result);
    } catch {
      // store directory doesn't exist yet
    }

    return result;
  }

  /**
   * refs/ ディレクトリを再帰走査し、タグ symlink を起点に StoredImage を構築する。
   */
  private async collectRefsRecursive(
    dir: string,
    pathSegments: string[],
    result: StoredImage[],
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // This is a tag symlink → resolve to digest dir and build StoredImage
        try {
          const realDir = await fs.realpath(fullPath);
          if (!(await this.assertInsideStore(realDir))) continue;
          const tag = entry.name;
          const ref = this.buildRef(pathSegments, tag);
          const imageJsonPath = path.join(realDir, "image.json");
          try {
            const raw = await fs.readFile(imageJsonPath, "utf-8");
            const stored = JSON.parse(raw) as StoredImage;
            // Override ref with current symlink's ref (may differ from image.json)
            result.push({ ...stored, ref });
          } catch {
            // image.json missing — build minimal StoredImage from digest dir
            const digest = path.basename(realDir).replace("-", ":");
            const size = await this.computeDirSize(realDir);
            const configPath = path.join(realDir, "config.json");
            let metadata = this.extractMetadata({});
            try {
              const configRaw = JSON.parse(await fs.readFile(configPath, "utf-8"));
              metadata = this.extractMetadata(configRaw);
            } catch {
              // no config.json
            }
            result.push({ ref, digest, size, createdAt: new Date().toISOString(), metadata });
          }
        } catch {
          // broken symlink — skip
        }
      } else if (entry.isDirectory()) {
        await this.collectRefsRecursive(fullPath, [...pathSegments, entry.name], result);
      }
    }
  }

  private buildRef(pathSegments: string[], tag: string): string {
    // symlink の直上は必ず "tags" ディレクトリなので末尾 1 つだけ除去
    const withoutTrailingTags =
      pathSegments.length > 0 && pathSegments[pathSegments.length - 1] === "tags"
        ? pathSegments.slice(0, -1)
        : pathSegments;
    const filtered = withoutTrailingTags.filter((s) => s !== NO_ORG_SENTINEL);
    const nameWithOrg = filtered.join("/");
    return `${nameWithOrg}:${tag}`;
  }

  async prune(): Promise<{ removed: number; freedBytes: number }> {
    let removed = 0;
    let freedBytes = 0;

    try {
      const entries = await fs.readdir(this.storeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith("sha256-")) continue;

        const digestDir = path.join(this.storeDir, entry.name);
        const hasRefs = await this.hasSymlinksTo(digestDir);
        if (!hasRefs) {
          const size = await this.computeDirSize(digestDir);
          await fs.rm(digestDir, { recursive: true, force: true });
          removed++;
          freedBytes += size;
        }
      }
    } catch {
      // store directory doesn't exist yet
    }

    return { removed, freedBytes };
  }

  static parseRef(ref: string): { org: string; name: string; tag: string } {
    const [nameWithOrg, tag = "latest"] = ref.split(":");
    const parts = nameWithOrg.split("/");
    if (parts.length < 2) {
      return { org: NO_ORG_SENTINEL, name: parts[0], tag };
    }
    return { org: parts[0], name: parts.slice(1).join("/"), tag };
  }

  /**
   * symlink の解決先が storeDir 配下の sha256-* ディレクトリであることを検証する。
   * ストア外を指す symlink は拒否し false を返す。
   */
  private async assertInsideStore(realDir: string): Promise<boolean> {
    let resolvedStore: string;
    try {
      resolvedStore = await fs.realpath(this.storeDir);
    } catch {
      return false;
    }
    const normalized = path.resolve(realDir);
    const storePrefix = resolvedStore + path.sep;
    if (!normalized.startsWith(storePrefix)) {
      return false;
    }
    const relative = normalized.slice(storePrefix.length);
    return relative.startsWith("sha256-");
  }

  /** ref の各セグメントがストアパス外にトラバーサルしないことを検証する */
  static validateRef(ref: string): void {
    // コロンは 0 個または 1 個のみ許可
    const colonCount = (ref.match(/:/g) || []).length;
    if (colonCount > 1) {
      throw new Error(`Invalid ref: "${ref}" — at most one ":" is allowed`);
    }
    const { org, name, tag } = ImageStore.parseRef(ref);
    for (const segment of [name, tag]) {
      if (segment === "" || segment === "." || segment === ".." || segment.includes("..")) {
        throw new Error(`Invalid ref: "${ref}" — path traversal segments are not allowed`);
      }
    }
    // org は NO_ORG_SENTINEL（内部値）以外の空チェック
    if (org !== NO_ORG_SENTINEL) {
      if (org === "" || org === "." || org === ".." || org.includes("..")) {
        throw new Error(`Invalid ref: "${ref}" — path traversal segments are not allowed`);
      }
    }
    // nameWithOrg の各パスセグメントが空でないことを検証（org//name 等を拒否）
    const nameWithOrg = ref.split(":")[0];
    const allSegments = nameWithOrg.split("/");
    for (const seg of allSegments) {
      if (seg === "" || seg === "." || seg === "..") {
        throw new Error(`Invalid ref: "${ref}" — empty or traversal path segment`);
      }
    }
    // org/name は英数字、ハイフン、アンダースコア、ドット、スラッシュのみ許可
    const namePattern = /^[a-zA-Z0-9./_-]+$/;
    if (!namePattern.test(nameWithOrg)) {
      throw new Error(`Invalid ref: "${ref}" — contains disallowed characters`);
    }
    // tag はスラッシュ不可（ディレクトリ階層と混同されるため）
    const tagPattern = /^[a-zA-Z0-9._-]+$/;
    if (tag && !tagPattern.test(tag)) {
      throw new Error(`Invalid ref: "${ref}" — tag must not contain "/"`);
    }
  }

  /** layer 名がレイヤーディレクトリ外にトラバーサルしないことを検証する */
  static validateLayerName(name: string): void {
    if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error(`Invalid layer name: "${name}"`);
    }
  }

  static computeDigest(data: Buffer): string {
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    return `sha256:${hash}`;
  }

  private serializeImageData(data: ImageData): Buffer {
    const parts: Buffer[] = [];
    const pushWithLength = (buf: Buffer): void => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(buf.length, 0);
      parts.push(len);
      parts.push(buf);
    };
    pushWithLength(Buffer.from(JSON.stringify(data.manifest)));
    pushWithLength(Buffer.from(JSON.stringify(data.config)));
    for (const [key, value] of data.layers) {
      pushWithLength(Buffer.from(key));
      pushWithLength(value);
    }
    return Buffer.concat(parts);
  }

  private extractMetadata(config: Record<string, unknown>): ImageMetadata {
    return {
      name: (config.name as string) ?? "",
      version: (config.version as string) ?? "",
      description: (config.description as string) ?? "",
      base: config.base as string | undefined,
      tools: (config.tools as string[]) ?? [],
      channels: (config.channels as string[]) ?? [],
      knowledgeChunks: config.knowledgeChunks as number | undefined,
    };
  }

  private async computeDirSize(dirPath: string): Promise<number> {
    let total = 0;
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isFile() || entry.isSymbolicLink()) {
          const stat = await fs.lstat(fullPath);
          total += stat.size;
        } else if (entry.isDirectory()) {
          total += await this.computeDirSize(fullPath);
        }
      }
    } catch {
      // ignore
    }
    return total;
  }

  private async hasSymlinksTo(targetDir: string): Promise<boolean> {
    try {
      const normalizedTarget = await fs.realpath(targetDir);
      return await this.findSymlinksRecursive(this.refsDir, normalizedTarget);
    } catch {
      return false;
    }
  }

  private async findSymlinksRecursive(dir: string, targetDir: string): Promise<boolean> {
    let entries: Awaited<ReturnType<typeof fs.readdir<{ withFileTypes: true }>>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const resolved = await fs.realpath(fullPath);
          if (resolved === targetDir) return true;
        } catch {
          // broken symlink
        }
      } else if (entry.isDirectory()) {
        const found = await this.findSymlinksRecursive(fullPath, targetDir);
        if (found) return true;
      }
    }
    return false;
  }
}
